import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseSitemap } from './sitemap.js';
import { analyzeHtml } from './seo.js';
import { fetchText } from './http.js';
import { savePage, saveProposal, getPendingProposals, getProposalById, getProposalBySignature, getProposalsByPage, getStats, getPages, saveScanRun, getDbStats, cleanupFailedProposals, getProposalsForExport, getSeoChangeLogEntryById } from './db.js';
import { createSeoProposals } from './openai.js';
import { getWpPageByUrl, updateWpContent, isWpArchiveUrl, isEditableWpContentUrl } from './wordpress.js';
import { sendScanReport, sendProposalsReport, sendApplySuccessReport, sendApplyFailureReport, sendTelegramTest, sendTelegramReport } from './telegram.js';
import { appendAgentBlock, hasAgentBlockForProposal, hasAgentBlockForType } from './content.js';
import { config, printStartupDiagnostics, validateForCommand } from './config.js';
import {
  buildAnalyticsReport,
  buildSeoKeywordReport,
  buildSeoAnalystReport,
  checkGscConnection,
  evaluateSeoChangeImpact,
  getPageSeoHealth,
  getPageQueries,
  getQueryCtrProblems,
  getQueryOpportunities,
  getTopQueries,
  getSeoCtrProblems,
  getSeoLosers,
  getSeoOpportunities,
  getSeoWinners,
  syncGscAnalytics,
  syncGscQueryAnalytics,
} from './analytics.js';
import type { PageDelta, QueryDelta } from './analytics.js';

async function scan() {
  const sitemapUrl = `${config.wpBaseUrl.replace(/\/$/, '')}/sitemap.xml`;
  console.log('Fetching sitemap:', sitemapUrl);
  const urls = await parseSitemap(sitemapUrl, config.scanLimit);
  console.log(`Found ${urls.length} URLs in sitemap (limit ${config.scanLimit})`);
  let issuesFound = 0;
  const scannedPages: { url: string; issues: number }[] = [];

  let i = 0;
  for (const url of urls) {
    i += 1;
    console.log(`Scanning ${i}/${urls.length}: ${url}`);
    try {
      const html = await fetchText(url);
      const pageData = analyzeHtml(url, html);
      await savePage(pageData);
      issuesFound += pageData.issues.length;
      scannedPages.push({ url, issues: pageData.issues.length });
      console.log(` -> issues: ${pageData.issues.length}, words: ${pageData.wordCount}`);
    } catch (error) {
      console.error(`Failed scanning ${url}:`, error instanceof Error ? error.message : error);
    }
  }

  await saveScanRun(urls.length, scannedPages.length, issuesFound);
  console.log('Generating proposals for scanned pages...');
  const proposalResult = await proposals();

  const pagesWithProblems = scannedPages.filter((entry) => entry.issues > 0).length;
  const topPages = scannedPages
    .filter((entry) => entry.issues > 0)
    .sort((a, b) => b.issues - a.issues)
    .slice(0, 3)
    .map((entry) => `• ${new URL(entry.url).pathname} — ${entry.issues}`);
  try {
    await sendScanReport(urls.length, scannedPages.length, pagesWithProblems, proposalResult.jsonParsed, proposalResult.proposalsCount, topPages);
    console.log('Telegram report: sent');
  } catch (error) {
    console.error('Telegram report: failed -', error instanceof Error ? error.message : error);
  }

  console.log(`Proposals generated: ${proposalResult.proposalsCount}`);
  return { scanned: scannedPages.length, proposals: proposalResult.proposalsCount };
}

async function proposals() {
  const pendingList: string[] = [];
  let openAiResponses = 0;
  let jsonParsed = 0;
  let proposalsCreated = 0;

  const rows = await getPages(config.scanLimit);
  const rowsToProcess = rows.filter((row) => {
    if (!isEditableWpContentUrl(row.url)) {
      console.warn(`Skipping archive/taxonomy URL for proposals: ${row.url}`);
      return false;
    }
    return true;
  });

  for (const row of rowsToProcess) {
    const pageData = {
      title: row.title,
      description: row.description,
      h1: row.h1,
      h2: row.h2,
      wordCount: row.wordCount,
      issues: row.issues,
    };

    try {
      const result = await createSeoProposals(row.url, pageData);
      openAiResponses += 1;
      if (!result || !result.proposals) {
        console.warn(`No parsable proposals for ${row.url}. Raw saved to logs/openai_raw.log`);
        continue;
      }
      jsonParsed += 1;
      for (const proposal of result.proposals) {
        const pageProposals = await getProposalsByPage(proposal.pageUrl);
        const activeSameType = pageProposals.find((item) => item.type === proposal.type && ['pending', 'applied'].includes(item.status));
        if (activeSameType) {
          console.warn(`Skipping proposal: pageUrl=${row.url} type=${proposal.type} title=${proposal.title || '<no title>'} reason=duplicate-active-type id=${activeSameType.id}`);
          continue;
        }
        const existing = await getProposalBySignature(proposal.pageUrl, proposal.type, proposal.title);
        if (existing && ['pending', 'applied'].includes(existing.status)) {
          console.warn(`Skipping proposal: pageUrl=${row.url} type=${proposal.type} title=${proposal.title || '<no title>'} reason=duplicate-${existing.status}`);
          continue;
        }
        const skipReason = getProposalSkipReason(proposal, row.url);
        if (skipReason) {
          console.warn(`Skipping proposal: pageUrl=${row.url} type=${proposal.type} title=${proposal.title || '<no title>'} reason=${skipReason}`);
          continue;
        }
        await saveProposal(proposal);
        proposalsCreated += 1;
        pendingList.push(`${proposal.type} - ${proposal.title}`);
      }
    } catch (error) {
      console.error(`Failed proposals for ${row.url}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`OpenAI responses received: ${openAiResponses}`);
  console.log(`JSON successfully parsed: ${jsonParsed}`);
  console.log(`SEO proposals created: ${proposalsCreated}`);

  const topProposals = pendingList.slice(0, 5).map((item, index) => `${index + 1}. ${item}`);
  await sendProposalsReport(topProposals);
  return { proposalsCount: pendingList.length, openAiResponses, jsonParsed };
}

async function apply() {
  const idArg = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  const pending = await getPendingProposals();

  if (!idArg) {
    console.log('Вкажіть proposal ID:');
    console.log('npx tsx src/index.ts apply <id> [--dry-run]');
    console.log('TOP 10 pending proposals:');
    pending.slice(0, 10).forEach((proposal) => {
      console.log(`- id: ${proposal.id} | priority: ${proposal.priority} | type: ${proposal.type} | pageUrl: ${proposal.pageUrl} | title: ${proposal.title}`);
    });
    return { applied: 0, failed: 0 };
  }

  const id = Number(idArg);
  if (Number.isNaN(id)) {
    console.error('Invalid proposal ID:', idArg);
    process.exit(1);
  }

  const proposal = await getProposalById(id);
  if (!proposal) {
    console.error(`Proposal ${id} not found.`);
    process.exit(1);
  }

  if (proposal.status !== 'pending') {
    console.error(`Proposal ${id} status is not pending (${proposal.status}).`);
    process.exit(1);
  }

  if (!proposal.proposedHtml || !isValidProposalHtmlContent(proposal.proposedHtml, proposal.type)) {
    console.error('Proposal has empty/invalid HTML. Not applied.');
    process.exit(1);
  }

  if (!proposal.pageUrl) {
    console.error(`Proposal ${id} missing pageUrl.`);
    process.exit(1);
  }

  if (!isEditableWpContentUrl(proposal.pageUrl)) {
    console.error('Archive/category/tag URL cannot be edited by WordPress page/post API');
    process.exit(1);
  }

  if (['waiting_for_indexing', 'indexed_collecting_data', 'applied_monitoring'].includes(proposal.monitoringStatus ?? '')) {
    console.error(`Proposal ${id} cannot be applied because page is in monitoring status: ${proposal.monitoringStatus}.`);
    process.exit(1);
  }

  const page = await getWpPageByUrl(proposal.pageUrl);
  if (!page) {
    console.error(`WordPress page not found for ${proposal.pageUrl}`);
    process.exit(1);
  }

  const content = page.content?.rendered ?? page.content ?? '';

  if (proposal.id && hasAgentBlockForProposal(content, proposal.id)) {
    console.error(`Proposal ${proposal.id} is already applied to this page.`);
    process.exit(1);
  }

  if (['faq', 'seo_block'].includes(proposal.type) && hasAgentBlockForType(content, proposal.type)) {
    console.error(`A ${proposal.type} block already exists on this page. Review before applying a second ${proposal.type}.`);
    process.exit(1);
  }

  const preview = appendAgentBlock(content, proposal.proposedHtml, { proposalId: proposal.id ?? 0, type: proposal.type });
  console.log('Applying proposal:');
  console.log(`ID: ${proposal.id}`);
  console.log(`URL: ${proposal.pageUrl}`);
  console.log(`Type: ${proposal.type}`);
  console.log(`Title: ${proposal.title}`);
  console.log('HTML preview:');
  console.log(preview);
  console.log(`Old content length: ${content.length}`);
  console.log(`New content length: ${preview.length}`);

  if (dryRun) {
    console.log('Dry-run only: no changes were made.');
    return { applied: 0, failed: 0 };
  }

  try {
    const oldHash = hashString(content);
    const newHash = hashString(preview);
    await updateWpContent(page.id, preview, page.restBase === 'posts' ? 'posts' : 'pages');
    await saveProposal({
      ...proposal,
      status: 'applied',
      appliedAt: new Date().toISOString(),
      oldContentHash: oldHash,
      newContentHash: newHash,
      monitoringUntil: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
      monitoringStatus: 'waiting_for_indexing',
    });
    await sendApplySuccessReport(proposal.id ?? 0, proposal.pageUrl, proposal.type);
    console.log('Apply completed. Proposal applied.');
    return { applied: 1, failed: 0 };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await saveProposal({ ...proposal, status: 'failed', reason });
    await sendApplyFailureReport(proposal.id ?? 0, proposal.pageUrl, reason);
    console.error(`Failed apply for ${proposal.pageUrl}:`, reason);
    return { applied: 0, failed: 1 };
  }
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function getProposalSkipReason(proposal: any, pageUrl: string): string | null {
  if (!proposal.htmlBlocks || !proposal.htmlBlocks.length) return 'missing htmlBlocks';
  if (!proposal.proposedHtml || !isValidProposalHtmlContent(proposal.proposedHtml, proposal.type)) return 'invalid proposedHtml';
  if (proposal.type === 'faq' && proposal.htmlBlocks.every((block: any) => !hasFaqItems(block))) return 'faq items missing';
  if (proposal.pageUrl && isWpArchiveUrl(proposal.pageUrl)) return 'archive URL';
  if (proposal.status && proposal.status !== 'pending') return 'invalid status';
  return null;
}

function hasFaqItems(block: any): boolean {
  if (!block) return false;
  if (Array.isArray(block.items) && block.items.some((item: any) => item?.question && item?.answer)) return true;
  if (block.question && block.answer) return true;
  return false;
}

function isValidProposalHtmlContent(html: string, type: string): boolean {
  const textOnly = html.replace(/<[^>]+>/g, '').trim();
  if (textOnly.length < 50) return false;
  if (/<section[^>]*>\s*<\/section>/i.test(html)) return false;
  if (type === 'faq') {
    return (html.match(/<h3\b[^>]*>/gi)?.length ?? 0) >= 3 && (html.match(/<p\b[^>]*>/gi)?.length ?? 0) >= 3;
  }
  if (type === 'seo_block') {
    return (html.match(/<h2\b[^>]*>/gi)?.length ?? 0) >= 1 && (html.match(/<p\b[^>]*>/gi)?.length ?? 0) >= 2;
  }
  return /<h2\b[^>]*>.*<\/h2>/i.test(html) || /<p\b[^>]*>.*<\/p>/i.test(html) || /<li\b[^>]*>.*<\/li>/i.test(html);
}

async function status() {
  const stats = await getStats();
  console.log('Pages stored:', stats.pages);
  console.log('Scan runs:', stats.scanRuns);
  console.table(stats.proposals);

  const totalProposals = stats.proposals.reduce((sum, item) => sum + Number(item.count), 0);
  const pendingCount = stats.proposals.find((p) => p.status === 'pending')?.count ?? 0;
  const appliedCount = stats.proposals.find((p) => p.status === 'applied')?.count ?? 0;
  const failedCount = stats.proposals.find((p) => p.status === 'failed')?.count ?? 0;

  const summary = `SEO Status:\n* Pages: ${stats.pages}\n* Scan runs: ${stats.scanRuns}\n* Proposals: ${totalProposals}\n* pending: ${pendingCount}\n* applied: ${appliedCount}\n* failed: ${failedCount}`;
  try {
    await sendTelegramReport(summary);
  } catch (error) {
    console.error('Telegram status report failed:', error instanceof Error ? error.message : error);
  }
}

const command = process.argv[2];

if (!command || command === 'help') {
  console.log('Usage: node dist/index.js [scan|proposals|apply|status|db-stats|cleanup-failed|export-proposals|analytics-check|analytics-sync|analytics-sync-queries|analytics-report|send-daily-seo-report|send-weekly-seo-report|send-monthly-seo-report|daily-seo-job|weekly-seo-job|monthly-seo-job|daily-seo-report|weekly-seo-report|monthly-seo-report|seo-analyst-report|seo-keyword-report|seo-winners|seo-losers|seo-ctr-problems|seo-opportunities|query-analysis|query-opportunities|query-ctr-problems|page-query-analysis|page-health|change-impact|proposal-detail|cleanup-invalid|cleanup-archives|telegram-test]');
  console.log('       npx tsx src/index.ts proposal-detail <id>');
  console.log('       npx tsx src/index.ts db-stats');
  console.log('       npx tsx src/index.ts cleanup-failed');
  console.log('       npx tsx src/index.ts export-proposals');
  console.log('       npx tsx src/index.ts analytics-check');
  console.log('       npx tsx src/index.ts analytics-sync [days]');
  console.log('       npx tsx src/index.ts analytics-sync-queries [days]');
  console.log('       npx tsx src/index.ts analytics-report [daily|weekly|monthly]');
  console.log('       npx tsx src/index.ts send-daily-seo-report');
  console.log('       npx tsx src/index.ts send-weekly-seo-report');
  console.log('       npx tsx src/index.ts send-monthly-seo-report');
  console.log('       npx tsx src/index.ts daily-seo-job');
  console.log('       npx tsx src/index.ts weekly-seo-job');
  console.log('       npx tsx src/index.ts monthly-seo-job');
  console.log('       npx tsx src/index.ts seo-analyst-report');
  console.log('       npx tsx src/index.ts seo-keyword-report');
  console.log('       npx tsx src/index.ts seo-winners');
  console.log('       npx tsx src/index.ts seo-losers');
  console.log('       npx tsx src/index.ts seo-ctr-problems');
  console.log('       npx tsx src/index.ts seo-opportunities');
  console.log('       npx tsx src/index.ts query-analysis');
  console.log('       npx tsx src/index.ts query-opportunities');
  console.log('       npx tsx src/index.ts query-ctr-problems');
  console.log('       npx tsx src/index.ts page-query-analysis <url>');
  console.log('       npx tsx src/index.ts page-health <url>');
  console.log('       npx tsx src/index.ts change-impact <changeId>');
  console.log('       npx tsx src/index.ts cleanup-invalid');
  console.log('       npx tsx src/index.ts cleanup-archives');
  process.exit(0);
}

async function runCommand() {
  printStartupDiagnostics();
  const check = validateForCommand(command ?? '');
  if (!check.ok) {
    console.error('Missing required environment variables for command', command);
    for (const m of check.missing) console.error('- ' + m);
    process.exit(1);
  }
  if (command === 'scan') {
    await scan();
  } else if (command === 'proposals') {
    await proposals();
  } else if (command === 'apply') {
    await apply();
  } else if (command === 'status') {
    await status();
  } else if (command === 'db-stats') {
    await dbStats();
  } else if (command === 'cleanup-failed') {
    await cleanupFailed();
  } else if (command === 'export-proposals') {
    await exportProposals();
  } else if (command === 'analytics-check') {
    await analyticsCheck();
  } else if (command === 'analytics-sync') {
    await analyticsSync();
  } else if (command === 'analytics-sync-queries') {
    await analyticsSyncQueries();
  } else if (command === 'analytics-report') {
    await analyticsReport((process.argv[3] ?? 'daily') as 'daily' | 'weekly' | 'monthly');
  } else if (command === 'send-daily-seo-report') {
    await syncThenReport('daily', 30);
  } else if (command === 'send-weekly-seo-report') {
    await syncThenReport('weekly', 90);
  } else if (command === 'send-monthly-seo-report') {
    await syncThenReport('monthly', 180);
  } else if (command === 'daily-seo-job') {
    await syncThenReport('daily', 30);
  } else if (command === 'weekly-seo-job') {
    await syncThenReport('weekly', 90);
  } else if (command === 'monthly-seo-job') {
    await syncThenReport('monthly', 180);
  } else if (command === 'daily-seo-report') {
    await analyticsReport('daily');
  } else if (command === 'weekly-seo-report') {
    await analyticsReport('weekly');
  } else if (command === 'monthly-seo-report') {
    await analyticsReport('monthly');
  } else if (command === 'seo-analyst-report') {
    await seoAnalystReport();
  } else if (command === 'seo-keyword-report') {
    await seoKeywordReport();
  } else if (command === 'seo-winners') {
    await seoWinners();
  } else if (command === 'seo-losers') {
    await seoLosers();
  } else if (command === 'seo-ctr-problems') {
    await seoCtrProblems();
  } else if (command === 'seo-opportunities') {
    await seoOpportunities();
  } else if (command === 'query-analysis') {
    await queryAnalysis();
  } else if (command === 'query-opportunities') {
    await queryOpportunities();
  } else if (command === 'query-ctr-problems') {
    await queryCtrProblems();
  } else if (command === 'page-query-analysis') {
    const pageUrl = process.argv[3];
    if (!pageUrl) {
      console.error('Usage: npx tsx src/index.ts page-query-analysis <url>');
      process.exit(1);
    }
    await pageQueryAnalysis(pageUrl);
  } else if (command === 'page-health') {
    const pageUrl = process.argv[3];
    if (!pageUrl) {
      console.error('Usage: npx tsx src/index.ts page-health <url>');
      process.exit(1);
    }
    await pageHealth(pageUrl);
  } else if (command === 'change-impact') {
    const id = Number(process.argv[3]);
    if (Number.isNaN(id)) {
      console.error('Usage: npx tsx src/index.ts change-impact <changeId>');
      process.exit(1);
    }
    await changeImpact(id);
  } else if (command === 'proposal-detail') {
    const id = process.argv[3];
    if (!id) {
      console.error('Usage: npx tsx src/index.ts proposal-detail <id>');
      process.exit(1);
    }
    await proposalDetail(Number(id));
  } else if (command === 'cleanup-invalid') {
    const count = await cleanupInvalid();
    console.log(`Cleanup invalid proposals: ${count} items marked invalid.`);
  } else if (command === 'cleanup-archives') {
    const count = await cleanupArchives();
    console.log(`Cleanup archive proposals: ${count} items marked invalid.`);
  } else if (command === 'telegram-test') {
    try {
      const response = await sendTelegramTest();
      console.log('telegram-test sent');
      console.log('Telegram API response status:', response.status);
      console.log(await response.text());
    } catch (error) {
      console.error('telegram-test failed -', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.error('Unknown command:', command);
    process.exit(1);
  }
}

async function proposalDetail(id: number) {
  const proposal = await getProposalById(id);
  if (!proposal) {
    console.error(`Proposal ${id} not found.`);
    process.exit(1);
  }
  console.log('Proposal detail:');
  console.log(`ID: ${proposal.id}`);
  console.log(`pageUrl: ${proposal.pageUrl}`);
  console.log(`type: ${proposal.type}`);
  console.log(`title: ${proposal.title}`);
  console.log(`priority: ${proposal.priority}`);
  console.log(`reason: ${proposal.reason}`);
  console.log(`exactAction: ${proposal.exactAction}`);
  console.log(`status: ${proposal.status}`);
  console.log('proposedHtml:');
  console.log(proposal.proposedHtml);
}

async function dbStats() {
  const stats = await getDbStats();
  console.log('DB Stats');
  console.log(`Pages count: ${stats.pages}`);
  console.log(`Scan runs count: ${stats.scanRuns}`);
  console.log(`Proposals total: ${stats.proposalsTotal}`);
  console.log(`pending: ${stats.pending}`);
  console.log(`applied: ${stats.applied}`);
  console.log(`failed: ${stats.failed}`);
  console.log(`invalid: ${stats.invalid}`);
  console.log('');
  console.log('TOP 10 pages by proposals:');
  if (!stats.topPages.length) {
    console.log('No proposals found.');
    return;
  }
  stats.topPages.forEach((item, index) => {
    console.log(`${index + 1}. ${item.pageUrl} — ${item.count}`);
  });
}

async function cleanupFailed() {
  const result = await cleanupFailedProposals(30);
  console.log('cleanup-failed completed');
  console.log(`Removed: ${result.removed}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Invalid: ${result.invalid}`);
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportProposals() {
  const rows = await getProposalsForExport();
  const exportDir = path.resolve(process.cwd(), 'exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const file = path.join(exportDir, 'proposals.csv');
  const header = ['id', 'pageUrl', 'type', 'title', 'priority', 'status', 'createdAt'];
  const lines = [
    header.join(','),
    ...rows.map((row) => [
      row.id,
      row.pageUrl,
      row.type,
      row.title,
      row.priority,
      row.status,
      row.createdAt ?? '',
    ].map(csvCell).join(',')),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Exported proposals: ${rows.length}`);
  console.log(`File: ${file}`);
}

async function analyticsCheck() {
  const result = await checkGscConnection();
  console.log('GSC analytics check');
  console.log(`Site URL: ${result.siteUrl || '(missing)'}`);
  console.log(`Service account email: ${result.serviceAccountEmail || '(missing)'}`);
  if (!result.ok) {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
  console.log(`Credential source: ${result.credentialSource}`);
  console.log(`Test rows returned: ${result.rows}`);
  console.log('✅ GSC connection successful');
}

async function analyticsSync() {
  const days = Number(process.argv[3] ?? '90');
  const result = await syncGscAnalytics(Number.isFinite(days) && days > 0 ? days : 90);
  printAnalyticsSyncResult(result);
}

async function analyticsSyncQueries() {
  const days = Number(process.argv[3] ?? '90');
  const result = await syncGscQueryAnalytics(Number.isFinite(days) && days > 0 ? days : 90);
  console.log('Query analytics sync completed');
  console.log('');
  console.log(`Rows received: ${result.rowsReceived}`);
  console.log(`Pages found: ${result.pagesFound}`);
  console.log(`Queries found: ${result.queriesFound}`);
  console.log(`Date range: ${result.startDate} → ${result.endDate}`);
  console.log('');
  console.log(`Inserted: ${result.inserted}`);
  console.log(`Updated: ${result.updated}`);
}

async function analyticsReport(kind: 'daily' | 'weekly' | 'monthly') {
  if (!['daily', 'weekly', 'monthly'].includes(kind)) {
    console.error('Usage: npx tsx src/index.ts analytics-report [daily|weekly|monthly]');
    process.exit(1);
  }
  const report = await buildAnalyticsReport(kind);
  console.log(report);
  try {
    await sendTelegramReport(report);
    console.log('Telegram analytics report: sent');
  } catch (error) {
    console.error('Telegram analytics report failed:', error instanceof Error ? error.message : error);
  }
}

function printAnalyticsSyncResult(result: Awaited<ReturnType<typeof syncGscAnalytics>>) {
  console.log('Analytics sync completed');
  console.log('');
  console.log(`Rows received: ${result.rowsReceived}`);
  console.log(`Pages found: ${result.pagesFound}`);
  console.log(`Date range: ${result.startDate} → ${result.endDate}`);
  console.log('');
  console.log(`Inserted: ${result.inserted}`);
  console.log(`Updated: ${result.updated}`);
}

async function syncThenReport(kind: 'daily' | 'weekly' | 'monthly', days: number) {
  const result = await syncGscAnalytics(days);
  printAnalyticsSyncResult(result);
  console.log('');
  await analyticsReport(kind);
}

async function seoAnalystReport() {
  const report = await buildSeoAnalystReport();
  console.log(report);
  try {
    await sendTelegramReport(report);
    console.log('Telegram SEO analyst report: sent');
  } catch (error) {
    console.error('Telegram SEO analyst report failed:', error instanceof Error ? error.message : error);
  }
}

async function seoKeywordReport() {
  const report = await buildSeoKeywordReport();
  console.log(report);
}

function printPageDeltaRows(rows: PageDelta[], emptyMessage = 'No GSC data found.') {
  if (!rows.length) {
    console.log(emptyMessage);
    return;
  }
  rows.forEach((row, index) => {
    console.log(`${index + 1}. ${row.pageUrl}`);
    console.log(`   clicks: ${row.previous.clicks} -> ${row.current.clicks} (${row.clicksDiff >= 0 ? '+' : ''}${row.clicksDiff})`);
    console.log(`   impressions: ${row.previous.impressions} -> ${row.current.impressions} (${row.impressionsDiff >= 0 ? '+' : ''}${row.impressionsDiff})`);
    console.log(`   CTR: ${(row.previous.ctr * 100).toFixed(2)}% -> ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log(`   position: ${row.previous.position.toFixed(2)} -> ${row.current.position.toFixed(2)}`);
    if (row.problemType) console.log(`   type: ${row.problemType}`);
    if (row.lowData) console.log('   note: low data, watch only');
    else if (row.note) console.log(`   note: ${row.note}`);
  });
}

function printQueryRows(rows: QueryDelta[], emptyMessage = 'No query data found.') {
  if (!rows.length) {
    console.log(emptyMessage);
    return;
  }
  rows.forEach((row, index) => {
    console.log('');
    console.log(`${index + 1}. ${row.query}`);
    if (row.pageUrl) console.log(`   page: ${row.pageUrl}`);
    console.log(`   clicks: ${row.current.clicks}`);
    console.log(`   impressions: ${row.current.impressions}`);
    console.log(`   CTR: ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log(`   position: ${row.current.position.toFixed(2)}`);
    if (row.problemType) console.log(`   type: ${row.problemType}`);
    if (row.lowData) console.log('   note: low data, watch only');
  });
}

async function seoWinners() {
  console.log('SEO winners (last 30 days vs previous 30 days)');
  printPageDeltaRows(await getSeoWinners(30), 'No SEO winners found.');
}

async function seoLosers() {
  console.log('SEO losers (last 30 days vs previous 30 days)');
  printPageDeltaRows(await getSeoLosers(30), 'No SEO losers found.');
}

async function seoCtrProblems() {
  console.log('SEO CTR problems');
  const rows = await getSeoCtrProblems(30);
  if (!rows.length) {
    console.log('No CTR problems found.');
    return;
  }
  rows.forEach((row, index) => {
    console.log('');
    console.log(`${index + 1}. ${row.pageUrl}`);
    console.log(`   impressions: ${row.previous.impressions} -> ${row.current.impressions} (${row.impressionsDiff >= 0 ? '+' : ''}${row.impressionsDiff})`);
    console.log(`   clicks: ${row.previous.clicks} -> ${row.current.clicks} (${row.clicksDiff >= 0 ? '+' : ''}${row.clicksDiff})`);
    console.log(`   CTR: ${(row.previous.ctr * 100).toFixed(2)}% -> ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log(`   position: ${row.previous.position.toFixed(2)} -> ${row.current.position.toFixed(2)}`);
    console.log('   problem: Google shows page more often, but fewer users click.');
    console.log('   suggested action: review title/meta/snippet, but do not rewrite full content yet.');
    if (row.lowData) console.log('   note: low data, watch only');
  });
}

async function seoOpportunities() {
  console.log('SEO opportunities');
  const rows = await getSeoOpportunities(30);
  if (!rows.length) {
    console.log('No SEO opportunities found.');
    return;
  }
  rows.forEach((row, index) => {
    console.log('');
    console.log(`${index + 1}. ${row.pageUrl}`);
    console.log(`   position: ${row.current.position.toFixed(2)}`);
    console.log(`   impressions: ${row.current.impressions}`);
    console.log(`   clicks: ${row.current.clicks}`);
    console.log(`   CTR: ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log('   opportunity: page is close to top 10, needs title/snippet/internal links improvement.');
    if (row.lowData) console.log('   note: low data, watch only');
  });
}

async function queryAnalysis() {
  console.log('Query analysis');
  printQueryRows(await getTopQueries(90), 'No query data found. Run analytics-sync-queries first.');
}

async function queryOpportunities() {
  console.log('Query opportunities');
  const rows = await getQueryOpportunities(90);
  if (!rows.length) {
    console.log('No query opportunities found.');
    return;
  }
  rows.forEach((row, index) => {
    console.log('');
    console.log(`${index + 1}. ${row.query}`);
    if (row.pageUrl) console.log(`   page: ${row.pageUrl}`);
    console.log(`   position: ${row.current.position.toFixed(2)}`);
    console.log(`   impressions: ${row.current.impressions}`);
    console.log(`   clicks: ${row.current.clicks}`);
    console.log(`   CTR: ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log('   opportunity: можна підсилити сторінку або створити окремий контент.');
    if (row.lowData) console.log('   note: low data, watch only');
  });
}

async function queryCtrProblems() {
  console.log('Query CTR problems');
  const rows = await getQueryCtrProblems(90);
  if (!rows.length) {
    console.log('No query CTR problems found.');
    return;
  }
  rows.forEach((row, index) => {
    console.log('');
    console.log(`${index + 1}. ${row.query}`);
    if (row.pageUrl) console.log(`   page: ${row.pageUrl}`);
    console.log(`   position: ${row.current.position.toFixed(2)}`);
    console.log(`   impressions: ${row.current.impressions}`);
    console.log(`   clicks: ${row.current.clicks}`);
    console.log(`   CTR: ${(row.current.ctr * 100).toFixed(2)}%`);
    console.log('   problem: користувачі бачать сторінку, але майже не клікають.');
  });
}

async function pageQueryAnalysis(pageUrl: string) {
  console.log(`Page query analysis: ${pageUrl}`);
  printQueryRows(await getPageQueries(pageUrl, 90), 'No queries found for this page. Run analytics-sync-queries first.');
}

async function pageHealth(pageUrl: string) {
  const health = await getPageSeoHealth(pageUrl);
  console.log(`Page: ${health.pageUrl}`);
  console.log(`clicksTrend: ${health.clicksTrend}`);
  console.log(`impressionsTrend: ${health.impressionsTrend}`);
  console.log(`ctrTrend: ${(health.ctrTrend * 100).toFixed(2)}%`);
  console.log(`positionTrend: ${health.positionTrend.toFixed(2)}`);
  console.log(`lastSeoChange: ${health.lastSeoChange ? `${health.lastSeoChange.id} ${health.lastSeoChange.appliedAt}` : 'none'}`);
  console.log(`lastSeoChangeStatus: ${health.lastSeoChangeStatus}`);
  console.log(`recommendationStatus: ${health.recommendationStatus}`);
}

async function changeImpact(changeId: number) {
  const changes = await getSeoChangeLogEntryById(changeId);
  if (!changes) {
    console.error(`SEO change ${changeId} not found.`);
    process.exit(1);
  }
  const status = await evaluateSeoChangeImpact(changes.pageUrl, changeId);
  console.log(`changeId: ${changeId}`);
  console.log(`pageUrl: ${changes.pageUrl}`);
  console.log(`result: ${status}`);
}

async function cleanupInvalid() {
  const pending = await getPendingProposals();
  let marked = 0;
  for (const proposal of pending) {
    if (!proposal.proposedHtml || !isValidProposalHtmlContent(proposal.proposedHtml, proposal.type)) {
      proposal.status = 'invalid';
      await saveProposal(proposal);
      marked += 1;
    }
  }
  return marked;
}

async function cleanupArchives() {
  const pending = await getPendingProposals();
  let marked = 0;
  for (const proposal of pending) {
    if (proposal.pageUrl && isWpArchiveUrl(proposal.pageUrl)) {
      proposal.status = 'invalid';
      proposal.reason = 'Archive or taxonomy URL cannot be edited via WordPress pages API';
      await saveProposal(proposal);
      marked += 1;
      console.log(`Marked archive proposal invalid: id=${proposal.id} url=${proposal.pageUrl}`);
    }
  }
  return marked;
}

runCommand().catch((error) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
