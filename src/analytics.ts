import { createRequire } from 'module';
import { config } from './config.js';
import {
  getAllProposals,
  getGscAnalyticsRecords,
  getGscQueryRecords,
  getLatestGscDate,
  getLatestGscQueryDate,
  getMonitoringRecords,
  getSeoChangeLogEntries,
  getSeoChangeLogEntryById,
  saveSeoAnalysisInsight,
  upsertGscAnalyticsRecords,
  upsertGscQueryRecords,
} from './db.js';
import { GscAnalyticsRecord, GscQueryRecord, PageSeoHealth, RecommendationStatus, SeoChangeImpactStatus } from './types.js';

const require = createRequire(import.meta.url);

type PeriodKind = 'daily' | 'weekly' | 'monthly';
type SiteTrend = 'growing' | 'stable' | 'declining' | 'visibility_growth_ctr_problem' | 'not_enough_data';
type PageProblemType = 'winner' | 'loser' | 'ctr_problem' | 'opportunity' | 'low_data' | 'neutral';

interface MetricSummary {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PageDelta {
  pageUrl: string;
  current: MetricSummary;
  previous: MetricSummary;
  clicksDiff: number;
  impressionsDiff: number;
  ctrDiff: number;
  positionDiff: number;
  lowData?: boolean;
  problemType?: PageProblemType;
  score?: number;
  note?: string;
}

export interface AnalyticsSyncResult {
  startDate: string;
  endDate: string;
  rowsReceived: number;
  pagesFound: number;
  inserted: number;
  updated: number;
}

export interface QueryAnalyticsSyncResult extends AnalyticsSyncResult {
  queriesFound: number;
}

export interface SeoHealthScore {
  score: number;
  status: 'Healthy' | 'Needs attention' | 'Critical';
  emoji: '🟢' | '🟡' | '🔴';
  factors: Record<string, number>;
}

export interface QueryDelta {
  query: string;
  pageUrl?: string;
  current: MetricSummary;
  previous?: MetricSummary;
  clicksDiff?: number;
  impressionsDiff?: number;
  ctrDiff?: number;
  positionDiff?: number;
  lowData?: boolean;
  problemType?: 'top' | 'growing' | 'declining' | 'opportunity' | 'ctr_problem' | 'neutral';
}

interface GscClientContext {
  google: any;
  auth: any;
  siteUrl: string;
  serviceAccountEmail: string;
  credentialSource: string;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnly(d);
}

function diffDays(start: string, end: string): number {
  return Math.floor((new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86400000);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function signed(value: number, suffix = ''): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

function ratioDrop(current: number, previous: number): number {
  if (previous <= 0) return 0;
  return Math.max(0, (previous - current) / previous);
}

function aggregate(records: GscAnalyticsRecord[]): MetricSummary {
  const clicks = records.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = records.reduce((sum, row) => sum + row.impressions, 0);
  const positionWeight = records.reduce((sum, row) => sum + row.position * Math.max(row.impressions, 1), 0);
  const weight = records.reduce((sum, row) => sum + Math.max(row.impressions, 1), 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: weight > 0 ? positionWeight / weight : 0,
  };
}

function byPage(records: GscAnalyticsRecord[]): Map<string, GscAnalyticsRecord[]> {
  const map = new Map<string, GscAnalyticsRecord[]>();
  for (const row of records) {
    const list = map.get(row.pageUrl) ?? [];
    list.push(row);
    map.set(row.pageUrl, list);
  }
  return map;
}

function byQuery(records: GscQueryRecord[]): Map<string, GscQueryRecord[]> {
  const map = new Map<string, GscQueryRecord[]>();
  for (const row of records) {
    const list = map.get(row.query) ?? [];
    list.push(row);
    map.set(row.query, list);
  }
  return map;
}

function aggregateQuery(records: GscQueryRecord[]): MetricSummary {
  const clicks = records.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = records.reduce((sum, row) => sum + row.impressions, 0);
  const positionWeight = records.reduce((sum, row) => sum + row.position * Math.max(row.impressions, 1), 0);
  const weight = records.reduce((sum, row) => sum + Math.max(row.impressions, 1), 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: weight > 0 ? positionWeight / weight : 0,
  };
}

function topPageForQuery(records: GscQueryRecord[]): string | undefined {
  const byUrl = new Map<string, GscQueryRecord[]>();
  for (const row of records) {
    const list = byUrl.get(row.pageUrl) ?? [];
    list.push(row);
    byUrl.set(row.pageUrl, list);
  }
  const sorted = [...byUrl.entries()]
    .map(([pageUrl, rows]) => ({ pageUrl, summary: aggregateQuery(rows) }))
    .sort((a, b) => b.summary.impressions - a.summary.impressions);
  return sorted[0]?.pageUrl;
}

function summarizeQueries(records: GscQueryRecord[]): QueryDelta[] {
  return [...byQuery(records).entries()]
    .map(([query, rows]) => {
      const current = aggregateQuery(rows);
      return classifyQueryDelta({
        query,
        pageUrl: topPageForQuery(rows),
        current,
        lowData: current.impressions < 10 || current.clicks < 2,
      });
    });
}

function compareByQuery(current: GscQueryRecord[], previous: GscQueryRecord[]): QueryDelta[] {
  const currentByQuery = byQuery(current);
  const previousByQuery = byQuery(previous);
  const queries = new Set([...currentByQuery.keys(), ...previousByQuery.keys()]);
  return [...queries].map((query) => {
    const currentRows = currentByQuery.get(query) ?? [];
    const previousRows = previousByQuery.get(query) ?? [];
    const currentSummary = aggregateQuery(currentRows);
    const previousSummary = aggregateQuery(previousRows);
    return classifyQueryDelta({
      query,
      pageUrl: topPageForQuery(currentRows.length ? currentRows : previousRows),
      current: currentSummary,
      previous: previousSummary,
      clicksDiff: currentSummary.clicks - previousSummary.clicks,
      impressionsDiff: currentSummary.impressions - previousSummary.impressions,
      ctrDiff: currentSummary.ctr - previousSummary.ctr,
      positionDiff: previousSummary.position - currentSummary.position,
      lowData: currentSummary.impressions < 10 || currentSummary.clicks < 2,
    });
  });
}

function classifyQueryDelta(delta: QueryDelta): QueryDelta {
  const ctrProblem = delta.current.impressions >= 20
    && delta.current.ctr < 0.02
    && delta.current.position > 0
    && delta.current.position <= 12;
  const opportunity = delta.current.position >= 8
    && delta.current.position <= 20
    && delta.current.impressions > 10
    && delta.current.clicks <= 2;
  const growing = !delta.lowData
    && ((delta.clicksDiff ?? 0) > 0 || (delta.impressionsDiff ?? 0) > 10)
    && (delta.ctrDiff ?? 0) >= -0.02;
  const declining = !delta.lowData
    && ((delta.clicksDiff ?? 0) < 0 || (delta.ctrDiff ?? 0) < -0.05 || (delta.positionDiff ?? 0) < -3);

  let problemType: QueryDelta['problemType'] = 'neutral';
  if (ctrProblem) problemType = 'ctr_problem';
  else if (opportunity) problemType = 'opportunity';
  else if (growing) problemType = 'growing';
  else if (declining) problemType = 'declining';
  else if (delta.current.clicks > 0) problemType = 'top';

  return { ...delta, problemType };
}

function compareByPage(current: GscAnalyticsRecord[], previous: GscAnalyticsRecord[]): PageDelta[] {
  const currentByPage = byPage(current);
  const previousByPage = byPage(previous);
  const urls = new Set([...currentByPage.keys(), ...previousByPage.keys()]);
  return [...urls].map((pageUrl) => {
    const currentSummary = aggregate(currentByPage.get(pageUrl) ?? []);
    const previousSummary = aggregate(previousByPage.get(pageUrl) ?? []);
    return classifyPageDelta({
      pageUrl,
      current: currentSummary,
      previous: previousSummary,
      clicksDiff: currentSummary.clicks - previousSummary.clicks,
      impressionsDiff: currentSummary.impressions - previousSummary.impressions,
      ctrDiff: currentSummary.ctr - previousSummary.ctr,
      positionDiff: previousSummary.position - currentSummary.position,
    });
  });
}

function classifyPageDelta(delta: PageDelta): PageDelta {
  const lowData = delta.current.impressions < 20 || delta.current.clicks < 3;
  const ctrDrop = ratioDrop(delta.current.ctr, delta.previous.ctr);
  const impressionsDrop = ratioDrop(delta.current.impressions, delta.previous.impressions);
  const impressionsGrowth = percentChange(delta.current.impressions, delta.previous.impressions);
  const positionStronglyWorse = delta.previous.position > 0 && delta.current.position > delta.previous.position + 3;
  const positionNotCriticallyWorse = !positionStronglyWorse;
  const majorCtrDrop = ctrDrop > 0.2;
  const meaningfulImpressionsGrowth = delta.impressionsDiff >= 10 && impressionsGrowth >= 0.2;
  const meaningfulImpressionsDrop = delta.impressionsDiff <= -10 && impressionsDrop >= 0.2;
  const zeroClickVisibilityGrowth = delta.impressionsDiff > 0 && delta.current.clicks === 0 && delta.current.ctr === 0;
  const ctrProblem = delta.current.impressions >= 20
    && delta.impressionsDiff >= 0
    && delta.clicksDiff <= 0
    && delta.ctrDiff < 0
    && positionNotCriticallyWorse;
  const winner = !lowData
    && (delta.clicksDiff > 0 || meaningfulImpressionsGrowth)
    && !(delta.clicksDiff < 0 && delta.ctrDiff < 0)
    && !majorCtrDrop
    && !positionStronglyWorse
    && !zeroClickVisibilityGrowth;
  const loser = !lowData
    && !winner
    && (delta.clicksDiff < 0 || majorCtrDrop || positionStronglyWorse || meaningfulImpressionsDrop);
  const opportunity = delta.current.position >= 8
    && delta.current.position <= 20
    && delta.current.impressions > 10
    && delta.current.ctr < 0.05
    && delta.current.clicks < 3;

  let problemType: PageProblemType = 'neutral';
  let note = '';
  if (lowData) {
    problemType = 'low_data';
    note = 'low data, watch only';
  } else if (ctrProblem) {
    problemType = 'ctr_problem';
    note = 'Google shows page more often, but fewer users click.';
  } else if (winner) {
    problemType = 'winner';
    note = 'traffic or visibility improved without material CTR/position damage.';
  } else if (loser) {
    problemType = 'loser';
    note = 'clicks, CTR, position, or visibility declined materially.';
  } else if (opportunity) {
    problemType = 'opportunity';
    note = 'page is close to top 10, needs title/snippet/internal links improvement.';
  }

  const score = delta.clicksDiff * 5
    + delta.impressionsDiff * 0.25
    + delta.ctrDiff * 100
    + delta.positionDiff * 3
    - (majorCtrDrop ? 20 : 0)
    - (positionStronglyWorse ? 15 : 0);

  return { ...delta, lowData, problemType, score, note };
}

function trendLabel(current: MetricSummary, previous: MetricSummary): SiteTrend {
  if (current.impressions + previous.impressions < 50) return 'not_enough_data';
  const clicksDiff = current.clicks - previous.clicks;
  const impressionsDiff = current.impressions - previous.impressions;
  const positionImproved = previous.position > 0 && current.position > 0 && current.position < previous.position;
  const ctrDropped = current.ctr < previous.ctr && ratioDrop(current.ctr, previous.ctr) > 0.2;
  if (impressionsDiff > 0 && positionImproved && clicksDiff < 0 && ctrDropped) return 'visibility_growth_ctr_problem';
  if (clicksDiff > 0 && impressionsDiff >= 0) return 'growing';
  if ((clicksDiff < 0 && impressionsDiff < 0 && !positionImproved) || (clicksDiff < 0 && ctrDropped)) return 'declining';
  return 'stable';
}

function humanTrend(label: string): string {
  if (label === 'growing' || label === 'growth') return 'сайт росте';
  if (label === 'declining' || label === 'decline') return 'сайт просів';
  if (label === 'visibility_growth_ctr_problem') return 'сайт отримує більше видимості в Google, але має проблему з CTR';
  if (label === 'not_enough_data') return 'даних ще мало';
  return 'сайт стабільний';
}

function englishTrend(label: string): string {
  if (label === 'growing' || label === 'growth') return 'Growing';
  if (label === 'declining' || label === 'decline') return 'Declining';
  if (label === 'visibility_growth_ctr_problem') return 'Visibility growth with CTR problem';
  if (label === 'not_enough_data') return 'Not enough data';
  return 'Stable';
}

function formatUrlList(items: PageDelta[], empty = 'Немає достатніх даних.'): string {
  if (!items.length) return empty;
  return items.map((item, index) => `${index + 1}. ${item.pageUrl}`).join('\n');
}

function uniquePageDeltas(items: PageDelta[]): PageDelta[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.pageUrl)) return false;
    seen.add(item.pageUrl);
    return true;
  });
}

function getGscSiteUrl(): string {
  return config.gscSiteUrl || config.wpBaseUrl;
}

function parseServiceAccountJson(): any | null {
  if (!config.googleServiceAccountJson) return null;
  try {
    return JSON.parse(config.googleServiceAccountJson);
  } catch {
    throw new Error('invalid credentials: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
}

function classifyGscError(error: any): string {
  const message = String(error?.message ?? error ?? '');
  const status = Number(error?.code ?? error?.status ?? error?.response?.status ?? 0);
  if (message.includes('invalid_grant') || message.includes('private_key') || message.includes('PEM')) return 'invalid credentials';
  if (status === 403 || message.includes('User does not have sufficient permission') || message.includes('permission')) return 'service account has no access';
  if (status === 404 || message.includes('not found') || message.includes('site not found')) return 'property not found';
  if (status === 401) return 'invalid credentials';
  return message || 'unknown GSC error';
}

function buildGscClient(): GscClientContext {
  const siteUrl = getGscSiteUrl();
  if (!siteUrl) throw new Error('missing GSC_SITE_URL');
  const { google } = require('googleapis') as any;

  if (config.googleClientEmail && config.googlePrivateKey) {
    return {
      google,
      auth: new google.auth.GoogleAuth({
        credentials: {
          client_email: config.googleClientEmail,
          private_key: config.googlePrivateKey,
        },
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      }),
      siteUrl,
      serviceAccountEmail: config.googleClientEmail,
      credentialSource: 'GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY',
    };
  }

  const serviceAccount = parseServiceAccountJson();
  if (serviceAccount) {
    return {
      google,
      auth: new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      }),
      siteUrl,
      serviceAccountEmail: String(serviceAccount.client_email ?? 'unknown'),
      credentialSource: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    };
  }

  if (config.googleApplicationCredentials) {
    return {
      google,
      auth: new google.auth.GoogleAuth({
        keyFile: config.googleApplicationCredentials,
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      }),
      siteUrl,
      serviceAccountEmail: 'from GOOGLE_APPLICATION_CREDENTIALS',
      credentialSource: 'GOOGLE_APPLICATION_CREDENTIALS',
    };
  }

  if (!config.googleClientEmail) throw new Error('missing GOOGLE_CLIENT_EMAIL');
  if (!config.googlePrivateKey) throw new Error('missing GOOGLE_PRIVATE_KEY');
  throw new Error('invalid credentials');
}

export async function checkGscConnection(): Promise<{ ok: boolean; siteUrl: string; serviceAccountEmail: string; credentialSource: string; rows: number; error?: string }> {
  const siteUrl = config.gscSiteUrl;
  try {
    if (!config.gscSiteUrl) throw new Error('missing GSC_SITE_URL');
    if (!config.googleClientEmail && !config.googleServiceAccountJson && !config.googleApplicationCredentials) throw new Error('missing GOOGLE_CLIENT_EMAIL');
    if (config.googleClientEmail && !config.googlePrivateKey && !config.googleServiceAccountJson && !config.googleApplicationCredentials) throw new Error('missing GOOGLE_PRIVATE_KEY');
    const context = buildGscClient();
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 2);
    const endDate = dateOnly(end);
    const startDate = addDays(endDate, -6);
    const searchconsole = context.google.searchconsole({ version: 'v1', auth: context.auth });
    const response: any = await searchconsole.searchanalytics.query({
      siteUrl: context.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: 1,
      },
    });
    return {
      ok: true,
      siteUrl: context.siteUrl,
      serviceAccountEmail: context.serviceAccountEmail,
      credentialSource: context.credentialSource,
      rows: Number(response.data.rows?.length ?? 0),
    };
  } catch (error) {
    return {
      ok: false,
      siteUrl,
      serviceAccountEmail: config.googleClientEmail || 'unknown',
      credentialSource: 'none',
      rows: 0,
      error: classifyGscError(error),
    };
  }
}

export async function syncGscAnalytics(days = 90): Promise<AnalyticsSyncResult> {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const endDate = dateOnly(end);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - Math.max(days, 1) + 1);
  const startDate = dateOnly(start);

  const context = buildGscClient();
  const searchconsole = context.google.searchconsole({ version: 'v1', auth: context.auth });
  const response: any = await searchconsole.searchanalytics.query({
    siteUrl: context.siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page', 'date'],
      rowLimit: 25000,
    },
  });

  const records: GscAnalyticsRecord[] = (response.data.rows ?? [])
    .map((row: any) => ({
      pageUrl: String(row.keys?.[0] ?? ''),
      date: String(row.keys?.[1] ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    }))
    .filter((row: GscAnalyticsRecord) => row.pageUrl && row.date);

  const saved = await upsertGscAnalyticsRecords(records);
  return {
    startDate,
    endDate,
    rowsReceived: records.length,
    pagesFound: new Set(records.map((row) => row.pageUrl)).size,
    inserted: saved.inserted,
    updated: saved.updated,
  };
}

export async function syncGscQueryAnalytics(days = 90): Promise<QueryAnalyticsSyncResult> {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const endDate = dateOnly(end);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - Math.max(days, 1) + 1);
  const startDate = dateOnly(start);

  const context = buildGscClient();
  const searchconsole = context.google.searchconsole({ version: 'v1', auth: context.auth });
  const response: any = await searchconsole.searchanalytics.query({
    siteUrl: context.siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page', 'query', 'date'],
      rowLimit: 25000,
    },
  });

  const records: GscQueryRecord[] = (response.data.rows ?? [])
    .map((row: any) => ({
      pageUrl: String(row.keys?.[0] ?? ''),
      query: String(row.keys?.[1] ?? ''),
      date: String(row.keys?.[2] ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    }))
    .filter((row: GscQueryRecord) => row.pageUrl && row.query && row.date);

  const saved = await upsertGscQueryRecords(records);
  return {
    startDate,
    endDate,
    rowsReceived: records.length,
    pagesFound: new Set(records.map((row) => row.pageUrl)).size,
    queriesFound: new Set(records.map((row) => row.query)).size,
    inserted: saved.inserted,
    updated: saved.updated,
  };
}

async function getPeriodRecords(endDate: string, days: number, pageUrl?: string) {
  const startDate = addDays(endDate, -days + 1);
  const records = await getGscAnalyticsRecords({ pageUrl, startDate, endDate });
  return { startDate, endDate, records, summary: aggregate(records) };
}

async function getQueryPeriodRecords(endDate: string, days: number, pageUrl?: string) {
  const startDate = addDays(endDate, -days + 1);
  const records = await getGscQueryRecords({ pageUrl, startDate, endDate });
  return { startDate, endDate, records, summary: aggregateQuery(records) };
}

export async function buildAnalyticsReport(kind: PeriodKind): Promise<string> {
  const latest = await getLatestGscDate();
  if (!latest) return 'Даних GSC ще немає. Запустіть analytics-sync або додайте тестові записи.';

  if (kind === 'daily') return buildDailyReport(latest);
  if (kind === 'weekly') return buildWeeklyReport(latest);
  return buildMonthlyReport(latest);
}

export async function calculateSeoHealthScore(days = 30): Promise<SeoHealthScore> {
  const latest = await getLatestGscDate();
  if (!latest) {
    return { score: 0, status: 'Critical', emoji: '🔴', factors: {} };
  }
  const current = await getPeriodRecords(latest, days);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), days);
  const pages = compareByPage(current.records, previous.records);
  const growingPages = pages.filter((page) => page.problemType === 'winner').length;
  const decliningPages = pages.filter((page) => page.problemType === 'loser' || page.problemType === 'ctr_problem').length;
  const pageCount = Math.max(pages.length, 1);

  const clicksGrowth = percentChange(current.summary.clicks, previous.summary.clicks);
  const impressionsGrowth = percentChange(current.summary.impressions, previous.summary.impressions);
  const ctr = current.summary.ctr;
  const position = current.summary.position;

  const factors = {
    clicksGrowth: Math.max(0, Math.min(20, 10 + clicksGrowth * 40)),
    impressionsGrowth: Math.max(0, Math.min(20, 10 + impressionsGrowth * 35)),
    ctr: Math.max(0, Math.min(20, ctr / 0.05 * 20)),
    position: Math.max(0, Math.min(20, position > 0 ? (30 - Math.min(position, 30)) / 30 * 20 : 0)),
    growingVsDecliningPages: Math.max(0, Math.min(20, 10 + ((growingPages - decliningPages) / pageCount) * 20)),
  };
  const score = Math.round(Object.values(factors).reduce((sum, value) => sum + value, 0));
  if (score >= 75) return { score, status: 'Healthy', emoji: '🟢', factors };
  if (score >= 45) return { score, status: 'Needs attention', emoji: '🟡', factors };
  return { score, status: 'Critical', emoji: '🔴', factors };
}

async function buildDailyReport(latest: string): Promise<string> {
  const current = await getPeriodRecords(latest, 1);
  const previous = await getPeriodRecords(addDays(latest, -1), 1);
  const last7 = await getPeriodRecords(latest, 7);
  const avg7 = {
    clicks: last7.summary.clicks / 7,
    impressions: last7.summary.impressions / 7,
    ctr: last7.summary.ctr,
    position: last7.summary.position,
  };
  const trend = trendLabel(current.summary, previous.summary);
  const pages = compareByPage(current.records, previous.records);
  const attention = pages.filter((p) => p.impressionsDiff < 0 || p.clicksDiff < 0).sort((a, b) => a.clicksDiff - b.clicksDiff).slice(0, 3);
  const growing = pages.filter((p) => p.clicksDiff > 0 || p.impressionsDiff > 0).sort((a, b) => b.clicksDiff - a.clicksDiff).slice(0, 3);
  const recentChanges = await getSeoChangeLogEntries({ startDate: addDays(latest, -14), endDate: latest });
  const appliedChanges = recentChanges.slice(0, 5);
  const waitingPages = recentChanges.filter((change) => diffDays(change.appliedAt.slice(0, 10), latest) < 14).slice(0, 5);
  const ctrProblems = pages.filter((p) => p.problemType === 'ctr_problem').slice(0, 5);
  const opportunities = getOpportunityPages(pages).slice(0, 5);
  const winners = pages.filter((p) => p.problemType === 'winner').slice(0, 5);
  const losers = pages.filter((p) => p.problemType === 'loser').slice(0, 5);
  const proposals = await getAllProposals();
  const pendingBlocked = proposals
    .filter((proposal) => proposal.status === 'pending' && waitingPages.some((change) => change.pageUrl === proposal.pageUrl))
    .slice(0, 5);

  return [
    '📊 SEO Daily Report',
    '',
    `Сайт: ${getGscSiteUrl().replace(/^https?:\/\//, '').replace(/\/$/, '')}`,
    `Останній день з даними GSC: ${latest}`,
    '',
    `Кліки: ${current.summary.clicks}`,
    `Покази: ${current.summary.impressions}`,
    `CTR: ${pct(current.summary.ctr)}`,
    `Позиція: ${current.summary.position.toFixed(2)}`,
    '',
    'Зміна за день:',
    `* кліки: ${signed(current.summary.clicks - previous.summary.clicks)}`,
    `* покази: ${signed(current.summary.impressions - previous.summary.impressions)}`,
    `* CTR: ${signed((current.summary.ctr - previous.summary.ctr) * 100, '%')}`,
    `* позиція: ${signed(previous.summary.position - current.summary.position)}`,
    '',
    'Порівняння із середнім за 7 днів:',
    `* кліки: ${current.summary.clicks} vs ${avg7.clicks.toFixed(1)}`,
    `* покази: ${current.summary.impressions} vs ${avg7.impressions.toFixed(1)}`,
    `* CTR: ${pct(current.summary.ctr)} vs ${pct(avg7.ctr)}`,
    `* позиція: ${current.summary.position.toFixed(2)} vs ${avg7.position.toFixed(2)}`,
    '',
    '🧠 Висновок AI:',
    humanTrend(trend) + '.',
    '',
    'Примітка:',
    'На старті періоду могли бути власні тестові переходи, тому CTR/кліки треба оцінювати обережно й не реагувати на один день як на остаточний тренд.',
    '',
    '✅ Що добре:',
    growing.length ? growing.map((p) => `* ${p.pageUrl}`).join('\n') : '* Немає явного росту за останній день.',
    '',
    '🏆 Переможці:',
    formatUrlList(winners, 'Немає явних переможців за день.'),
    '',
    '📉 Просідання:',
    formatUrlList(losers, 'Критичних просідань не видно.'),
    '',
    '⚠️ Що потребує уваги:',
    attention.length ? attention.map((p) => `* ${p.pageUrl}`).join('\n') : '* Критичних просідань за день не видно.',
    '',
    '🎯 CTR-проблеми:',
    formatUrlList(ctrProblems, 'Немає виражених CTR-проблем за день.'),
    '',
    '🚀 Топ можливості:',
    formatUrlList(opportunities, 'Немає нових топ-можливостей за день.'),
    '',
    '📝 Останні застосовані зміни:',
    appliedChanges.length ? appliedChanges.map((change) => `* ${change.appliedAt.slice(0, 10)} — ${change.pageUrl} — ${change.changeType}`).join('\n') : '* Немає застосованих змін за останні 14 днів.',
    '',
    '⏳ Сторінки в очікуванні індексації:',
    waitingPages.length ? waitingPages.map((change) => `* ${change.pageUrl} — зміна ${change.id}, ${change.appliedAt.slice(0, 10)}`).join('\n') : '* Немає сторінок у 14-денному cooldown.',
    '',
    '⏳ Що поки не чіпати:',
    recentChanges.length ? recentChanges.slice(0, 3).map((change) => `* ${change.pageUrl} — була зміна ${change.appliedAt.slice(0, 10)}`).join('\n') : '* Сторінки без достатньої статистики або зі свіжими змінами.',
    pendingBlocked.length ? '\nPending-пропозиції, які краще не чіпати зараз:\n' + pendingBlocked.map((proposal) => `* #${proposal.id} ${proposal.pageUrl} — ${proposal.type}`).join('\n') : '',
    '',
    '🎯 Наступна рекомендована дія:',
    trend === 'declining' || trend === 'visibility_growth_ctr_problem' ? '* Перевірити сторінки з падінням кліків і CTR.' : '* Накопичувати дані та точково дивитись сторінки з високими показами і низьким CTR.',
  ].join('\n');
}

async function buildWeeklyReport(latest: string): Promise<string> {
  const current = await getPeriodRecords(latest, 7);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), 7);
  const pages = compareByPage(current.records, previous.records);
  const winners = pages.filter((p) => p.problemType === 'winner').sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3);
  const losers = pages.filter((p) => p.problemType === 'loser').sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 3);
  const ctrProblems = pages.filter((p) => p.problemType === 'ctr_problem').sort((a, b) => ratioDrop(b.current.ctr, b.previous.ctr) - ratioDrop(a.current.ctr, a.previous.ctr)).slice(0, 5);
  const positionOpportunities = getOpportunityPages(pages).slice(0, 5);
  const waiting = await getSeoChangeLogEntries({ startDate: addDays(latest, -14), endDate: latest });
  const trend = humanTrend(trendLabel(current.summary, previous.summary));

  return [
    '📈 SEO Weekly Report',
    '',
    'Період:',
    `${current.startDate} — ${current.endDate}`,
    '',
    'Кліки:',
    `${previous.summary.clicks} → ${current.summary.clicks}`,
    '',
    'Покази:',
    `${previous.summary.impressions} → ${current.summary.impressions}`,
    '',
    'CTR:',
    `${pct(previous.summary.ctr)} → ${pct(current.summary.ctr)}`,
    '',
    'Позиція:',
    `${previous.summary.position.toFixed(2)} → ${current.summary.position.toFixed(2)}`,
    '',
    '🏆 Найкращий ріст:',
    formatUrlList(winners),
    '',
    '📉 Найбільше падіння:',
    formatUrlList(losers),
    '',
    '🎯 Можливості',
    '* високі покази + низький CTR:',
    formatUrlList(ctrProblems),
    '* позиції 8–20:',
    formatUrlList(positionOpportunities),
    '* нові сторінки: перевірити після накопичення GSC-даних.',
    '',
    '⏳ SEO-зміни, де ще треба чекати результат:',
    waiting.length ? waiting.slice(0, 5).map((change) => `* ${change.pageUrl} — ${change.title}`).join('\n') : '* Немає свіжих змін у change log.',
    '',
    '🧠 Висновок AI:',
    `За тиждень ${trend}. Дивіться не лише кліки, а й CTR: якщо покази ростуть швидше за кліки, сніпети треба аналізувати окремо.`,
    '',
    '🎯 Що робити далі:',
    ctrProblems.length ? 'Почати з CTR-проблемних сторінок, але не чіпати сторінки зі змінами молодше 14 днів.' : 'Продовжити накопичення статистики й працювати зі сторінками у позиціях 8–20.',
  ].join('\n');
}

async function buildMonthlyReport(latest: string): Promise<string> {
  const current = await getPeriodRecords(latest, 30);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), 30);
  const pages = compareByPage(current.records, previous.records);
  const winners = pages.filter((p) => p.problemType === 'winner').sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5);
  const losers = pages.filter((p) => p.problemType === 'loser' || p.problemType === 'ctr_problem').sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 5);
  const changes = await getSeoChangeLogEntries({ startDate: current.startDate, endDate: current.endDate });
  const impacts = await Promise.all(changes.map((change) => evaluateSeoChangeImpact(change.pageUrl, change.id ?? 0)));
  const improved = impacts.filter((item) => item === 'improved').length;
  const declined = impacts.filter((item) => item === 'declined').length;
  const waiting = impacts.filter((item) => item === 'waiting_for_result').length;
  const unchanged = impacts.filter((item) => item === 'unchanged').length;
  const trend = humanTrend(trendLabel(current.summary, previous.summary));
  const trendRaw = trendLabel(current.summary, previous.summary);
  const health = await calculateSeoHealthScore(30);

  return [
    '📊 SEO Monthly Report',
    '',
    'Період:',
    `${current.startDate} — ${current.endDate}`,
    '',
    `Загальний тренд: ${englishTrend(trendRaw)}`,
    '',
    `SEO Health Score: ${health.score}/100`,
    `Статус: ${health.emoji} ${health.status}`,
    '',
    'Основні показники:',
    `* кліки: ${current.summary.clicks}`,
    `* покази: ${current.summary.impressions}`,
    `* CTR: ${pct(current.summary.ctr)}`,
    `* середня позиція: ${current.summary.position.toFixed(2)}`,
    '',
    'SEO-зміни за місяць:',
    `* скільки змін внесено: ${changes.length}`,
    `* скільки вже можна оцінити: ${improved + declined + unchanged}`,
    `* скільки ще чекають результату: ${waiting}`,
    `* скільки дали ріст: ${improved}`,
    `* скільки не дали результат: ${unchanged + declined}`,
    '',
    'Що спрацювало:',
    improved ? '* Є зміни з позитивним впливом у change log.' : '* Поки немає підтверджених змін із ростом.',
    '',
    'Що не спрацювало:',
    declined ? '* Є зміни з негативною динамікою, варто переглянути.' : '* Явно негативних змін поки не видно.',
    '',
    'Що поки не чіпати:',
    waiting ? '* Сторінки зі змінами молодше 14 днів.' : '* Сторінки, які стабільно ростуть або мають мало даних.',
    '',
    'Найкращі сторінки:',
    formatUrlList(winners),
    '',
    'Найслабші сторінки:',
    formatUrlList(losers),
    '',
    'План на наступний місяць:',
    '* Не робити хаотичних текстових змін. Працювати зі сторінками, де є достатньо показів, низький CTR або позиції 8–20.',
  ].join('\n');
}

export type SeoChangeImpactResult = {
  changeId: number;
  pageUrl: string;
  changeType: string;
  appliedAt: string;
  status: SeoChangeImpactStatus;
  conclusion: 'too_early' | 'positive' | 'neutral' | 'negative' | 'not_enough_data';
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  afterDaysAvailable: number;
  before: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
  after: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
  delta: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
  deltaPercent: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
  note?: string;
};

export async function getSeoChangeImpactDetails(changeId: number): Promise<SeoChangeImpactResult | null> {
  const change = await getSeoChangeLogEntryById(changeId);
  if (!change) return null;

  const pageUrl = change.pageUrl;
  const changeDate = change.appliedAt.slice(0, 10);
  const latest = await getLatestGscDate();

  const beforeStart = addDays(changeDate, -14);
  const beforeEnd = addDays(changeDate, -1);
  const afterStart = changeDate;
  const plannedAfterEnd = addDays(changeDate, 13);
  const afterEnd = latest && latest < plannedAfterEnd ? latest : plannedAfterEnd;
  const afterDaysAvailable = latest && latest >= afterStart ? diffDays(afterStart, afterEnd) + 1 : 0;

  const emptySummary = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const emptyPercent = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  if (!latest) {
    return {
      changeId,
      pageUrl,
      changeType: change.changeType,
      appliedAt: change.appliedAt,
      status: 'not_enough_data',
      conclusion: 'not_enough_data',
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
      afterDaysAvailable,
      before: emptySummary,
      after: emptySummary,
      delta: emptySummary,
      deltaPercent: emptyPercent,
      note: 'Немає GSC-даних.',
    };
  }

  const beforeRecords = await getGscAnalyticsRecords({
    pageUrl,
    startDate: beforeStart,
    endDate: beforeEnd,
  });

  const afterRecords = await getGscAnalyticsRecords({
    pageUrl,
    startDate: afterStart,
    endDate: afterEnd,
  });

  const before = aggregate(beforeRecords);
  const after = aggregate(afterRecords);

  const delta = {
    clicks: after.clicks - before.clicks,
    impressions: after.impressions - before.impressions,
    ctr: after.ctr - before.ctr,
    position: before.position - after.position,
  };

  const deltaPercent = {
    clicks: percentChange(after.clicks, before.clicks),
    impressions: percentChange(after.impressions, before.impressions),
    ctr: percentChange(after.ctr, before.ctr),
    position: before.position > 0 ? (before.position - after.position) / before.position : 0,
  };

  if (afterDaysAvailable < 7) {
    return {
      changeId,
      pageUrl,
      changeType: change.changeType,
      appliedAt: change.appliedAt,
      status: 'too_early',
      conclusion: 'too_early',
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
      afterDaysAvailable,
      before,
      after,
      delta,
      deltaPercent,
      note: 'Після SEO-зміни минуло менше 7 днів, робити висновок ще рано.',
    };
  }

  if (before.impressions < 30 || after.impressions < 30) {
    return {
      changeId,
      pageUrl,
      changeType: change.changeType,
      appliedAt: change.appliedAt,
      status: 'not_enough_data',
      conclusion: 'not_enough_data',
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
      afterDaysAvailable,
      before,
      after,
      delta,
      deltaPercent,
      note: 'Недостатньо показів для чесної оцінки.',
    };
  }

  const clicksImproved = delta.clicks > 0;
  const impressionsImproved = delta.impressions > 0;
  const ctrImproved = delta.ctr > 0;
  const positionImproved = delta.position > 0;

  const clicksDeclined = delta.clicks < 0;
  const ctrDeclined = delta.ctr < -0.005;
  const positionDeclined = delta.position < -2;

  let status: SeoChangeImpactStatus = 'unchanged';
  let conclusion: SeoChangeImpactResult['conclusion'] = 'neutral';

  if ((clicksImproved || impressionsImproved || ctrImproved) && !positionDeclined) {
    status = 'improved';
    conclusion = 'positive';
  } else if (clicksDeclined || ctrDeclined || positionDeclined) {
    status = 'declined';
    conclusion = 'negative';
  }

  return {
    changeId,
    pageUrl,
    changeType: change.changeType,
    appliedAt: change.appliedAt,
    status,
    conclusion,
    beforeStart,
    beforeEnd,
    afterStart,
    afterEnd,
    afterDaysAvailable,
    before,
    after,
    delta,
    deltaPercent,
  };
}

export async function evaluateSeoChangeImpact(pageUrl: string, changeId: number): Promise<SeoChangeImpactStatus> {
  const impact = await getSeoChangeImpactDetails(changeId);
  if (!impact || impact.pageUrl !== pageUrl) return 'not_enough_data';
  return impact.status;
}

export async function getPageSeoHealth(pageUrl: string): Promise<PageSeoHealth> {
  const latest = await getLatestGscDate();
  const empty: PageSeoHealth = {
    pageUrl,
    clicksTrend: 0,
    impressionsTrend: 0,
    ctrTrend: 0,
    positionTrend: 0,
    lastSeoChangeStatus: 'not_enough_data',
    recommendationStatus: 'wait',
  };
  if (!latest) return empty;
  const current = await getPeriodRecords(latest, 30, pageUrl);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), 30, pageUrl);
  const changes = await getSeoChangeLogEntries({ pageUrl });
  const lastSeoChange = changes[0];
  const lastSeoChangeStatus = lastSeoChange?.id ? await evaluateSeoChangeImpact(pageUrl, lastSeoChange.id) : 'not_enough_data';
  const clicksTrend = current.summary.clicks - previous.summary.clicks;
  const impressionsTrend = current.summary.impressions - previous.summary.impressions;
  const ctrTrend = current.summary.ctr - previous.summary.ctr;
  const positionTrend = previous.summary.position - current.summary.position;
  let recommendationStatus: RecommendationStatus = 'analyze';
  const hasEnoughHistory = current.records.length >= 14 && previous.records.length >= 14;
  const isGrowing = clicksTrend > 0 && impressionsTrend >= 0;

  if (lastSeoChange && diffDays(lastSeoChange.appliedAt.slice(0, 10), latest) < 14) recommendationStatus = 'wait';
  else if (!hasEnoughHistory) recommendationStatus = 'wait';
  else if (current.summary.impressions < 50) recommendationStatus = 'wait';
  else if (current.summary.clicks < 3) recommendationStatus = 'wait';
  else if (isGrowing || (clicksTrend >= 0 && impressionsTrend >= 0 && positionTrend >= 0)) recommendationStatus = 'do_not_touch';
  else if (current.summary.impressions >= 100 && current.summary.ctr < 0.015) recommendationStatus = 'improve_ctr';
  else if (current.summary.position >= 8 && current.summary.position <= 20) recommendationStatus = 'improve_content';
  else if (impressionsTrend < 0 || clicksTrend < 0) recommendationStatus = 'improve_internal_links';

  return {
    pageUrl,
    clicksTrend,
    impressionsTrend,
    ctrTrend,
    positionTrend,
    lastSeoChange,
    lastSeoChangeStatus,
    recommendationStatus,
  };
}

export async function getSeoWinners(days = 30): Promise<PageDelta[]> {
  const latest = await getLatestGscDate();
  if (!latest) return [];
  const current = await getPeriodRecords(latest, days);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), days);
  return compareByPage(current.records, previous.records)
    .filter((page) => page.problemType === 'winner')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);
}

export async function getSeoLosers(days = 30): Promise<PageDelta[]> {
  const latest = await getLatestGscDate();
  if (!latest) return [];
  const current = await getPeriodRecords(latest, days);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), days);
  return compareByPage(current.records, previous.records)
    .filter((page) => page.problemType === 'loser' || page.problemType === 'ctr_problem')
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 10);
}

export async function getSeoCtrProblems(days = 30): Promise<PageDelta[]> {
  const latest = await getLatestGscDate();
  if (!latest) return [];
  const current = await getPeriodRecords(latest, days);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), days);
  return compareByPage(current.records, previous.records)
    .filter((page) => page.problemType === 'ctr_problem')
    .sort((a, b) => ratioDrop(b.current.ctr, b.previous.ctr) - ratioDrop(a.current.ctr, a.previous.ctr))
    .slice(0, 10);
}

function getOpportunityPages(pages: PageDelta[]): PageDelta[] {
  return pages
    .filter((page) => page.current.position >= 8
      && page.current.position <= 20
      && page.current.impressions > 10
      && page.current.ctr < 0.05
      && page.current.clicks < 3)
    .map((page) => ({
      ...page,
      problemType: 'opportunity' as PageProblemType,
      note: page.lowData
        ? 'low data, watch only; page is close to top 10, needs title/snippet/internal links improvement.'
        : 'page is close to top 10, needs title/snippet/internal links improvement.',
    }))
    .sort((a, b) => a.current.position - b.current.position)
    .slice(0, 10);
}

export async function getSeoOpportunities(days = 30): Promise<PageDelta[]> {
  const latest = await getLatestGscDate();
  if (!latest) return [];
  const current = await getPeriodRecords(latest, days);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), days);
  return getOpportunityPages(compareByPage(current.records, previous.records));
}

export async function getTopQueries(days = 90, pageUrl?: string): Promise<QueryDelta[]> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return [];
  const current = await getQueryPeriodRecords(latest, days, pageUrl);
  return summarizeQueries(current.records)
    .sort((a, b) => b.current.clicks - a.current.clicks || b.current.impressions - a.current.impressions)
    .slice(0, 20);
}

export async function getQueryOpportunities(days = 90): Promise<QueryDelta[]> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return [];
  const current = await getQueryPeriodRecords(latest, days);
  return summarizeQueries(current.records)
    .filter((item) => item.current.position >= 8 && item.current.position <= 20 && item.current.impressions > 10 && item.current.clicks <= 2)
    .sort((a, b) => a.current.position - b.current.position || b.current.impressions - a.current.impressions)
    .slice(0, 20);
}

export async function getQueryCtrProblems(days = 90): Promise<QueryDelta[]> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return [];
  const current = await getQueryPeriodRecords(latest, days);
  return summarizeQueries(current.records)
    .filter((item) => item.current.impressions >= 20 && item.current.ctr < 0.02 && item.current.position <= 12)
    .sort((a, b) => b.current.impressions - a.current.impressions)
    .slice(0, 20);
}

export async function getPageQueries(pageUrl: string, days = 90): Promise<QueryDelta[]> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return [];
  const current = await getQueryPeriodRecords(latest, days, pageUrl);
  return summarizeQueries(current.records)
    .sort((a, b) => b.current.impressions - a.current.impressions || b.current.clicks - a.current.clicks)
    .slice(0, 50);
}

export async function getKeywordGrowth(days = 30): Promise<{ growing: QueryDelta[]; declining: QueryDelta[] }> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return { growing: [], declining: [] };
  const current = await getQueryPeriodRecords(latest, days);
  const previous = await getQueryPeriodRecords(addDays(current.startDate, -1), days);
  const compared = compareByQuery(current.records, previous.records);
  return {
    growing: compared
      .filter((item) => item.problemType === 'growing')
      .sort((a, b) => (b.clicksDiff ?? 0) - (a.clicksDiff ?? 0) || (b.impressionsDiff ?? 0) - (a.impressionsDiff ?? 0))
      .slice(0, 10),
    declining: compared
      .filter((item) => item.problemType === 'declining' || item.problemType === 'ctr_problem')
      .sort((a, b) => (a.clicksDiff ?? 0) - (b.clicksDiff ?? 0) || (a.ctrDiff ?? 0) - (b.ctrDiff ?? 0))
      .slice(0, 10),
  };
}

function formatQueryList(items: QueryDelta[], empty = 'Немає достатніх query-даних.'): string {
  if (!items.length) return empty;
  return items.map((item, index) => {
    const page = item.pageUrl ? `\n   page: ${item.pageUrl}` : '';
    return `${index + 1}. ${item.query}\n   clicks: ${item.current.clicks}\n   impressions: ${item.current.impressions}\n   CTR: ${pct(item.current.ctr)}\n   position: ${item.current.position.toFixed(2)}${page}`;
  }).join('\n');
}

export async function buildSeoKeywordReport(): Promise<string> {
  const latest = await getLatestGscQueryDate();
  if (!latest) return 'SEO keyword report: query-даних GSC ще немає. Запустіть analytics-sync-queries.';
  const top = await getTopQueries(90);
  const opportunities = await getQueryOpportunities(90);
  const ctrProblems = await getQueryCtrProblems(90);
  const { growing, declining } = await getKeywordGrowth(30);

  const aiConclusion = ctrProblems.length
    ? `Найперше треба дивитись CTR по запитах, де вже є покази і нормальна позиція. Наприклад: "${ctrProblems[0].query}". Тут користувачі бачать сайт, але клікають слабко.`
    : opportunities.length
      ? `Є запити близькі до ТОП-10, наприклад "${opportunities[0].query}". Їх варто підсилювати title/meta, внутрішніми посиланнями або окремим контентом.`
      : 'Поки немає явних keyword-проблем із достатніми даними. Варто накопичувати статистику.';

  return [
    '🧠 SEO Keyword Report',
    '',
    `Останній день query-даних GSC: ${latest}`,
    '',
    '🏆 Найкращі запити',
    formatQueryList(top.slice(0, 5)),
    '',
    '📈 Запити що ростуть',
    formatQueryList(growing.slice(0, 5)),
    '',
    '📉 Запити що падають',
    formatQueryList(declining.slice(0, 5)),
    '',
    '🎯 Запити близькі до ТОП-10',
    formatQueryList(opportunities.slice(0, 5)),
    '',
    '⚠️ Запити з CTR-проблемою',
    formatQueryList(ctrProblems.slice(0, 5)),
    '',
    '🧠 Висновок AI',
    aiConclusion,
  ].join('\n');
}

export async function buildSeoAnalystReport(): Promise<string> {
  const latest = await getLatestGscDate();
  if (!latest) return 'AI SEO analyst: даних GSC ще немає. Спочатку запустіть analytics-sync або додайте тестові записи.';
  const allRecords = await getGscAnalyticsRecords();
  const firstDate = allRecords[0]?.date ?? latest;
  const siteAgeDays = diffDays(firstDate, latest) + 1;
  const current = await getPeriodRecords(latest, 30);
  const previous = await getPeriodRecords(addDays(current.startDate, -1), 30);
  const allPages = compareByPage(current.records, previous.records);
  const winners = await getSeoWinners(30);
  const losers = await getSeoLosers(30);
  const ctrProblemPages = await getSeoCtrProblems(30);
  const opportunityPages = await getSeoOpportunities(30);
  const topQueries = await getTopQueries(90);
  const queryCtrProblems = await getQueryCtrProblems(90);
  const queryOpportunities = await getQueryOpportunities(90);
  const { growing: growingQueries, declining: decliningQueries } = await getKeywordGrowth(30);
  const changes = await getSeoChangeLogEntries();
    const changeImpactResults = [];
  for (const change of changes) {
    if (!change.id) continue;
    const impact = await getSeoChangeImpactDetails(change.id);
    if (!impact) continue;
    changeImpactResults.push({ change, impact });
  }

  const workedChanges = changeImpactResults.filter((item) => item.impact.conclusion === 'positive' || item.impact.status === 'improved').slice(0, 5);
  const failedChanges = changeImpactResults.filter((item) => item.impact.conclusion === 'negative' || item.impact.status === 'declined').slice(0, 5);
  const waitingChanges = changeImpactResults.filter((item) => item.impact.conclusion === 'too_early' || item.impact.status === 'waiting_for_result' || item.impact.status === 'too_early').slice(0, 5);
  const proposals = await getAllProposals();
  const monitoring = await getMonitoringRecords();
  const health = await calculateSeoHealthScore(30);
  const candidates = uniquePageDeltas(winners.concat(losers).concat(ctrProblemPages).concat(opportunityPages));
  const ctrProblems = candidates
    .filter((p) => p.problemType === 'ctr_problem')
    .slice(0, 5);
  const positionProblems = opportunityPages.slice(0, 5);
  const freshChanges = changes.filter((change) => diffDays(change.appliedAt.slice(0, 10), latest) < 14).slice(0, 5);
  const trend = trendLabel(current.summary, previous.summary);
  const clicksGrowth = percentChange(current.summary.clicks, previous.summary.clicks);
  const impressionsGrowth = percentChange(current.summary.impressions, previous.summary.impressions);
  const ctrGrowth = current.summary.ctr - previous.summary.ctr;
  const growingPages = winners.filter((page) => page.current.impressions >= 50).slice(0, 5);
  const lowDataPages = allPages.filter((page) => page.lowData).slice(0, 5);
  const attentionPages = losers
    .filter((page) => page.current.impressions >= 50 && (page.clicksDiff < 0 || page.impressionsDiff < 0))
    .slice(0, 5);
  const doNotTouchPages = uniquePageDeltas(growingPages.concat(lowDataPages).concat(freshChanges.map((change) => ({
    pageUrl: change.pageUrl,
    current: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    previous: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    clicksDiff: 0,
    impressionsDiff: 0,
    ctrDiff: 0,
    positionDiff: 0,
  })))).slice(0, 8);

  await saveSeoAnalysisInsight({
    pageUrl: undefined,
    period: `${current.startDate}:${current.endDate}`,
    insightType: trend === 'growing' ? 'growth' : trend === 'declining' || trend === 'visibility_growth_ctr_problem' ? 'decline' : trend === 'not_enough_data' ? 'not_enough_data' : 'stable',
    severity: trend === 'declining' || trend === 'visibility_growth_ctr_problem' ? 'high' : 'medium',
    title: 'AI SEO analyst summary',
    summary: humanTrend(trend),
    evidenceJson: JSON.stringify({ current: current.summary, previous: previous.summary, proposals: proposals.length, changes: changes.length, monitoring: monitoring.length }),
    recommendation: 'Не робити хаотичних змін: чекати 14 днів після SEO-змін і працювати лише зі сторінками з достатньою статистикою.',
    status: 'new',
  });

  return [
    '🧠 AI SEO analyst report',
    '',
    `Сайт працює в GSC-історії приблизно ${siteAgeDays} днів.`,
    `За останні 30 днів покази: ${previous.summary.impressions} → ${current.summary.impressions}, кліки: ${previous.summary.clicks} → ${current.summary.clicks}, CTR: ${pct(previous.summary.ctr)} → ${pct(current.summary.ctr)}, позиція: ${previous.summary.position.toFixed(2)} → ${current.summary.position.toFixed(2)}.`,
    '',
    `SEO Health Score: ${health.score}/100`,
    `Статус: ${health.emoji} ${health.status}`,
    '',
    'Динаміка за 30 днів:',
    `* покази: ${signed(impressionsGrowth * 100, '%')}`,
    `* кліки: ${signed(clicksGrowth * 100, '%')}`,
    `* CTR: ${signed(ctrGrowth * 100, '%')}`,
    '',
    `Висновок: ${humanTrend(trend)}.`,
    trend === 'visibility_growth_ctr_problem'
      ? 'Google почав частіше показувати сайт і середня позиція покращилась, але кліки та CTR впали. Це означає, що проблема зараз не в індексації, а в тому, як сторінки виглядають у пошуку або за якими запитами вони показуються.'
      : current.summary.impressions > previous.summary.impressions && current.summary.ctr < previous.summary.ctr
        ? 'Google частіше показує сайт, але сніпети поки недостатньо добре забирають кліки.'
      : 'Динаміка не вказує на потребу масово переписувати сторінки.',
    '',
    '🔎 CTR-проблеми',
    formatUrlList(ctrProblems, 'Немає явних CTR-проблем із достатніми даними.'),
    queryCtrProblems.length ? '\nЗапити з CTR-проблемою:\n' + queryCtrProblems.slice(0, 5).map((item) => `* ${item.query} — CTR ${pct(item.current.ctr)}, position ${item.current.position.toFixed(2)}`).join('\n') : '',
    '',
    '🎯 SEO-можливості',
    formatUrlList(positionProblems, 'Немає сторінок у зоні 8–20 з низьким CTR і достатніми показами.'),
    queryOpportunities.length ? '\nЗапити близькі до ТОП-10:\n' + queryOpportunities.slice(0, 5).map((item) => `* ${item.query} — position ${item.current.position.toFixed(2)}, impressions ${item.current.impressions}, clicks ${item.current.clicks}`).join('\n') : '',
    '',
    '⏳ Що не чіпати',
    doNotTouchPages.length ? doNotTouchPages.map((item) => `* ${item.pageUrl}${item.lowData ? ' — low data, watch only' : ''}`).join('\n') : '* Сторінки, які ростуть, мають свіжі зміни або мають недостатньо даних.',
    '',
    '⚠️ Що потребує уваги',
    formatUrlList(attentionPages, 'Немає сторінок із достатніми даними та явним падінням.'),
    '',
    '📈 Що спрацювало',
    workedChanges.length
      ? workedChanges.map((item) => `* ${item.change.title} — ${item.change.pageUrl}; кліки ${item.impact.before.clicks} → ${item.impact.after.clicks}, покази ${item.impact.before.impressions} → ${item.impact.after.impressions}, CTR ${pct(item.impact.before.ctr)} → ${pct(item.impact.after.ctr)}`).join('\n')
      : '* Поки немає підтверджених SEO-змін з позитивним результатом.',
    '',

    '📉 Що не спрацювало',
    failedChanges.length
      ? failedChanges.map((item) => `* ${item.change.title} — ${item.change.pageUrl}; кліки ${item.impact.before.clicks} → ${item.impact.after.clicks}, покази ${item.impact.before.impressions} → ${item.impact.after.impressions}, CTR ${pct(item.impact.before.ctr)} → ${pct(item.impact.after.ctr)}`).join('\n')
      : '* Поки немає SEO-змін, які явно погіршили результат.',
    '',

    '⏳ Що ще рано оцінювати',
    waitingChanges.length
      ? waitingChanges.map((item) => `* ${item.change.title} — ${item.change.pageUrl}; ${item.impact.note || 'ще немає повних 14 днів після зміни.'}`).join('\n')
      : '* Немає свіжих SEO-змін у режимі очікування.',
    '',
    'SEO-зміни в історії:',
    `* change log: ${changes.length}`,
    `* proposals history: ${proposals.length}`,
    `* monitoring records: ${monitoring.length}`,
    `* query records: ${topQueries.length ? 'available' : 'empty'}`,
    '',
    'Query-висновок:',
    queryCtrProblems.length
      ? `CTR може падати не лише через title. Найслабший query-сигнал: "${queryCtrProblems[0].query}" — користувачі бачать сайт, але майже не клікають.`
      : growingQueries.length
        ? `Сайт почав активніше показуватись за запитами: ${growingQueries.slice(0, 3).map((item) => `"${item.query}"`).join(', ')}. Якщо покази ростуть швидше за кліки, CTR природно просідає.`
        : decliningQueries.length
          ? `Є запити з падінням: ${decliningQueries.slice(0, 3).map((item) => `"${item.query}"`).join(', ')}. Їх треба перевірити окремо від сторінкової статистики.`
          : 'Query-даних поки недостатньо для окремого висновку по ключових словах.',
    '',
    'Правило проти хаотичних змін:',
    '* recommendationStatus = wait, якщо зміна була менше ніж 14 днів тому, недостатньо історії, показів або кліків.',
    '* recommendationStatus = do_not_touch, якщо сторінка росте або має стабільну позитивну динаміку.',
  ].join('\n');
}
