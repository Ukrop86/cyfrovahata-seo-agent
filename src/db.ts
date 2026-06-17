import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { GscAnalyticsRecord, GscQueryRecord, MonitoringRecord, SeoAnalysisInsight, SeoChangeLogEntry, SeoPageData, SeoProposal } from './types.js';
import { config } from './config.js';

const dbPath = path.resolve(process.cwd(), config.dbPath);
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

let SQL: any;
let db: any;
const ready = initSqlJs().then((m: any) => {
  SQL = m;
  db = new SQL.Database();
  const schema = `
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        h1 TEXT,
        h2 TEXT,
        canonical TEXT,
        robots TEXT,
        wordCount INTEGER,
        issues TEXT,
        scannedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageUrl TEXT,
        type TEXT,
        title TEXT,
        priority INTEGER,
        reason TEXT,
        exactAction TEXT,
        proposedHtml TEXT,
        status TEXT,
        appliedAt TEXT,
        oldContentHash TEXT,
        newContentHash TEXT,
        monitoringUntil TEXT,
        monitoringStatus TEXT,
        baselineClicks INTEGER,
        baselineImpressions INTEGER,
        baselineCtr REAL,
        baselinePosition REAL,
        monitoringSource TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        UNIQUE(pageUrl, type, title)
      );

      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runAt TEXT,
        urlCount INTEGER,
        pagesScanned INTEGER,
        issuesFound INTEGER
      );

      CREATE TABLE IF NOT EXISTS monitoring_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposalId INTEGER,
        pageUrl TEXT,
        status TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS gsc_analytics_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageUrl TEXT,
        date TEXT,
        clicks INTEGER,
        impressions INTEGER,
        ctr REAL,
        position REAL,
        createdAt TEXT,
        updatedAt TEXT,
        UNIQUE(pageUrl, date)
      );

      CREATE TABLE IF NOT EXISTS gsc_query_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageUrl TEXT,
        query TEXT,
        date TEXT,
        clicks INTEGER,
        impressions INTEGER,
        ctr REAL,
        position REAL,
        createdAt TEXT,
        updatedAt TEXT,
        UNIQUE(pageUrl, query, date)
      );

      CREATE TABLE IF NOT EXISTS seo_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageUrl TEXT,
        changeType TEXT,
        title TEXT,
        description TEXT,
        relatedProposalId INTEGER,
        beforeSnapshot TEXT,
        afterSnapshot TEXT,
        appliedAt TEXT,
        createdAt TEXT
      );

      CREATE TABLE IF NOT EXISTS seo_analysis_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageUrl TEXT,
        period TEXT,
        insightType TEXT,
        severity TEXT,
        title TEXT,
        summary TEXT,
        evidenceJson TEXT,
        recommendation TEXT,
        status TEXT,
        createdAt TEXT
      );
    `;
  db.run(schema);
  ensureIndexes();
  if (fs.existsSync(dbPath)) {
    const bin = fs.readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(bin));
    db.run(schema);
    ensureSchema();
    ensureIndexes();
  }
  persist();
});

function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function ensureSchema() {
  const stmt = db.prepare('PRAGMA table_info(proposals);');
  const columns: Set<string> = new Set();
  while (stmt.step()) {
    const row = stmt.getAsObject();
    columns.add(row.name);
  }
  stmt.free();

  const additionalColumns = [
    { name: 'appliedAt', type: 'TEXT' },
    { name: 'oldContentHash', type: 'TEXT' },
    { name: 'newContentHash', type: 'TEXT' },
    { name: 'monitoringUntil', type: 'TEXT' },
    { name: 'monitoringStatus', type: 'TEXT' },
    { name: 'baselineClicks', type: 'INTEGER' },
    { name: 'baselineImpressions', type: 'INTEGER' },
    { name: 'baselineCtr', type: 'REAL' },
    { name: 'baselinePosition', type: 'REAL' },
    { name: 'monitoringSource', type: 'TEXT' },
  ];

  for (const col of additionalColumns) {
    if (!columns.has(col.name)) {
      db.run(`ALTER TABLE proposals ADD COLUMN ${col.name} ${col.type};`);
    }
  }

  const changeStmt = db.prepare('PRAGMA table_info(seo_change_log);');
  const changeColumns: Set<string> = new Set();
  while (changeStmt.step()) {
    const row = changeStmt.getAsObject();
    changeColumns.add(row.name);
  }
  changeStmt.free();

  const changeAdditionalColumns = [
    { name: 'relatedProposalId', type: 'INTEGER' },
    { name: 'beforeSnapshot', type: 'TEXT' },
    { name: 'afterSnapshot', type: 'TEXT' },
  ];

  for (const col of changeAdditionalColumns) {
    if (!changeColumns.has(col.name)) {
      db.run(`ALTER TABLE seo_change_log ADD COLUMN ${col.name} ${col.type};`);
    }
  }
}

function ensureIndexes() {
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gsc_records_date ON gsc_analytics_records(date);
    CREATE INDEX IF NOT EXISTS idx_gsc_records_page ON gsc_analytics_records(pageUrl);
    CREATE INDEX IF NOT EXISTS idx_gsc_query_records_date ON gsc_query_records(date);
    CREATE INDEX IF NOT EXISTS idx_gsc_query_records_page ON gsc_query_records(pageUrl);
    CREATE INDEX IF NOT EXISTS idx_gsc_query_records_query ON gsc_query_records(query);
    CREATE INDEX IF NOT EXISTS idx_seo_change_log_page ON seo_change_log(pageUrl);
    CREATE INDEX IF NOT EXISTS idx_seo_change_log_applied ON seo_change_log(appliedAt);
    CREATE INDEX IF NOT EXISTS idx_seo_change_log_related_proposal ON seo_change_log(relatedProposalId);
    CREATE INDEX IF NOT EXISTS idx_proposals_page_type_status ON proposals(pageUrl, type, status);
    CREATE INDEX IF NOT EXISTS idx_seo_insights_period ON seo_analysis_insights(period);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_page ON monitoring_records(pageUrl);
  `);
}

async function ensureReady() {
  await ready;
}

function normalizeDbValue(value: any, fieldName: string, pageUrl?: string) {
  if (value === undefined) {
    console.warn(`DB normalize: undefined value for ${fieldName}${pageUrl ? ` (pageUrl=${pageUrl})` : ''}. Storing null.`);
    return null;
  }

  if (value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function normalizeDbRow(values: any[], fieldNames: string[], pageUrl?: string) {
  return values.map((value, idx) => normalizeDbValue(value, fieldNames[idx] ?? `param[${idx}]`, pageUrl));
}

export async function savePage(data: SeoPageData): Promise<void> {
  await ensureReady();
  const stmt = db.prepare(`INSERT OR REPLACE INTO pages (url,title,description,h1,h2,canonical,robots,wordCount,issues,scannedAt) VALUES (?,?,?,?,?,?,?,?,?,?);`);
  const values = normalizeDbRow([
    data.url,
    data.title,
    data.description,
    data.h1,
    data.h2,
    data.canonical,
    data.robots,
    data.wordCount,
    data.issues,
    data.scannedAt,
  ], ['url', 'title', 'description', 'h1', 'h2', 'canonical', 'robots', 'wordCount', 'issues', 'scannedAt'], data.url);
  stmt.bind(values);
  while (stmt.step()) {}
  stmt.free();
  persist();
}

export async function getPageByUrl(url: string): Promise<SeoPageData | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM pages WHERE url = ?;`);
  stmt.bind([url]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return null;
  return {
    url: row.url,
    title: row.title,
    description: row.description,
    h1: JSON.parse(row.h1 || '[]'),
    h2: JSON.parse(row.h2 || '[]'),
    canonical: row.canonical,
    robots: row.robots,
    wordCount: Number(row.wordCount || 0),
    issues: JSON.parse(row.issues || '[]'),
    scannedAt: row.scannedAt,
  };
}

export async function getPages(limit = 100): Promise<SeoPageData[]> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM pages ORDER BY scannedAt DESC LIMIT ?;`);
  stmt.bind([limit]);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.map((row) => ({
    url: row.url,
    title: row.title,
    description: row.description,
    h1: JSON.parse(row.h1 || '[]'),
    h2: JSON.parse(row.h2 || '[]'),
    canonical: row.canonical,
    robots: row.robots,
    wordCount: Number(row.wordCount || 0),
    issues: JSON.parse(row.issues || '[]'),
    scannedAt: row.scannedAt,
  }));
}

export async function saveProposal(proposal: SeoProposal): Promise<SeoProposal> {
  await ensureReady();
  const safeProposal = { 
    pageUrl: proposal.pageUrl ?? '', 
    type: proposal.type ?? 'content',
    title: proposal.title ?? '',
    priority: proposal.priority ?? 2,
    reason: proposal.reason ?? '',
    exactAction: proposal.exactAction ?? '',
    proposedHtml: proposal.proposedHtml ?? '',
    status: proposal.status ?? 'pending',
    appliedAt: proposal.appliedAt ?? null,
    oldContentHash: proposal.oldContentHash ?? null,
    newContentHash: proposal.newContentHash ?? null,
    monitoringUntil: proposal.monitoringUntil ?? null,
    monitoringStatus: proposal.monitoringStatus ?? null,
    baselineClicks: proposal.baselineClicks ?? null,
    baselineImpressions: proposal.baselineImpressions ?? null,
    baselineCtr: proposal.baselineCtr ?? null,
    baselinePosition: proposal.baselinePosition ?? null,
    monitoringSource: proposal.monitoringSource ?? null,
  };

  let priorityValue: number;
  if (typeof safeProposal.priority === 'number') priorityValue = safeProposal.priority;
  else if (typeof safeProposal.priority === 'string') {
    const map: Record<string, number> = { high: 3, medium: 2, low: 1 };
    priorityValue = map[safeProposal.priority.toLowerCase()] ?? 2;
  } else {
    priorityValue = 2;
  }

  const existsStmt = db.prepare(`SELECT * FROM proposals WHERE pageUrl = ? AND type = ? AND title = ? LIMIT 1;`);
  existsStmt.bind(normalizeDbRow([safeProposal.pageUrl, safeProposal.type, safeProposal.title], ['pageUrl', 'type', 'title'], safeProposal.pageUrl));
  const exists = existsStmt.step() ? existsStmt.getAsObject() : null;
  existsStmt.free();
  if (exists) {
    const update = db.prepare(`UPDATE proposals SET priority = ?, reason = ?, exactAction = ?, proposedHtml = ?, status = ?, appliedAt = ?, oldContentHash = ?, newContentHash = ?, monitoringUntil = ?, monitoringStatus = ?, baselineClicks = ?, baselineImpressions = ?, baselineCtr = ?, baselinePosition = ?, monitoringSource = ?, updatedAt = ? WHERE id = ?;`);
    update.bind(normalizeDbRow([priorityValue, safeProposal.reason, safeProposal.exactAction, safeProposal.proposedHtml, safeProposal.status, safeProposal.appliedAt, safeProposal.oldContentHash, safeProposal.newContentHash, safeProposal.monitoringUntil, safeProposal.monitoringStatus, safeProposal.baselineClicks, safeProposal.baselineImpressions, safeProposal.baselineCtr, safeProposal.baselinePosition, safeProposal.monitoringSource, new Date().toISOString(), exists.id], ['priority', 'reason', 'exactAction', 'proposedHtml', 'status', 'appliedAt', 'oldContentHash', 'newContentHash', 'monitoringUntil', 'monitoringStatus', 'baselineClicks', 'baselineImpressions', 'baselineCtr', 'baselinePosition', 'monitoringSource', 'updatedAt', 'id'], safeProposal.pageUrl));
    while (update.step()) {}
    update.free();
    persist();
    return toSeoProposal({ ...proposal, ...safeProposal, id: Number(exists.id), priority: priorityValue });
  }
  const stmt = db.prepare(`INSERT INTO proposals (pageUrl,type,title,priority,reason,exactAction,proposedHtml,status,appliedAt,oldContentHash,newContentHash,monitoringUntil,monitoringStatus,baselineClicks,baselineImpressions,baselineCtr,baselinePosition,monitoringSource,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`);
  const now = new Date().toISOString();
  stmt.bind(normalizeDbRow([safeProposal.pageUrl, safeProposal.type, safeProposal.title, priorityValue, safeProposal.reason, safeProposal.exactAction, safeProposal.proposedHtml, safeProposal.status, safeProposal.appliedAt, safeProposal.oldContentHash, safeProposal.newContentHash, safeProposal.monitoringUntil, safeProposal.monitoringStatus, safeProposal.baselineClicks, safeProposal.baselineImpressions, safeProposal.baselineCtr, safeProposal.baselinePosition, safeProposal.monitoringSource, now, now], ['pageUrl', 'type', 'title', 'priority', 'reason', 'exactAction', 'proposedHtml', 'status', 'appliedAt', 'oldContentHash', 'newContentHash', 'monitoringUntil', 'monitoringStatus', 'baselineClicks', 'baselineImpressions', 'baselineCtr', 'baselinePosition', 'monitoringSource', 'createdAt', 'updatedAt'], safeProposal.pageUrl));
  while (stmt.step()) {}
  stmt.free();
  const idStmt = db.prepare(`SELECT last_insert_rowid() as id;`);
  const id = idStmt.step() ? Number(idStmt.getAsObject().id) : undefined;
  idStmt.free();
  persist();
  return toSeoProposal({ ...proposal, ...safeProposal, id, priority: priorityValue });
}

function toSeoProposal(value: any): SeoProposal {
  return {
    ...value,
    appliedAt: value.appliedAt ?? undefined,
    oldContentHash: value.oldContentHash ?? undefined,
    newContentHash: value.newContentHash ?? undefined,
    monitoringUntil: value.monitoringUntil ?? undefined,
    monitoringStatus: value.monitoringStatus ?? undefined,
    baselineClicks: value.baselineClicks ?? undefined,
    baselineImpressions: value.baselineImpressions ?? undefined,
    baselineCtr: value.baselineCtr ?? undefined,
    baselinePosition: value.baselinePosition ?? undefined,
    monitoringSource: value.monitoringSource ?? undefined,
  };
}

export async function getPendingProposals(): Promise<SeoProposal[]> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM proposals WHERE status='pending' ORDER BY priority DESC;`);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.map((r) => ({ ...r }));
}

export async function getProposalById(id: number): Promise<SeoProposal | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM proposals WHERE id = ? LIMIT 1;`);
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? ({ ...row }) : null;
}

export async function getProposalBySignature(pageUrl: string, type: string, title: string): Promise<SeoProposal | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM proposals WHERE pageUrl = ? AND type = ? AND title = ? LIMIT 1;`);
  stmt.bind([pageUrl, type, title]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? ({ ...row }) : null;
}

export async function getProposalsByPage(pageUrl: string): Promise<SeoProposal[]> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM proposals WHERE pageUrl = ? ORDER BY priority DESC;`);
  stmt.bind([pageUrl]);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.map((r) => ({ ...r }));
}

export async function updateProposalStatus(id: number, status: string, reason?: string): Promise<void> {
  await ensureReady();
  if (reason) {
    const stmt = db.prepare(`UPDATE proposals SET status = ?, reason = ?, updatedAt = ? WHERE id = ?;`);
    stmt.bind(normalizeDbRow([status, reason, new Date().toISOString(), id], ['status', 'reason', 'updatedAt', 'id']));
    while (stmt.step()) {}
    stmt.free();
  } else {
    const stmt = db.prepare(`UPDATE proposals SET status = ?, updatedAt = ? WHERE id = ?;`);
    stmt.bind(normalizeDbRow([status, new Date().toISOString(), id], ['status', 'updatedAt', 'id']));
    while (stmt.step()) {}
    stmt.free();
  }
  persist();
}

export async function saveScanRun(urlCount: number, pagesScanned: number, issuesFound: number): Promise<void> {
  await ensureReady();
  const stmt = db.prepare(`INSERT INTO scan_runs (runAt,urlCount,pagesScanned,issuesFound) VALUES (?,?,?,?);`);
  stmt.bind(normalizeDbRow([new Date().toISOString(), urlCount, pagesScanned, issuesFound], ['runAt', 'urlCount', 'pagesScanned', 'issuesFound']));
  while (stmt.step()) {}
  stmt.free();
  persist();
}

export async function getStats() {
  await ensureReady();
  const pagesStmt = db.prepare(`SELECT COUNT(*) as count FROM pages;`);
  const pages = pagesStmt.step() ? pagesStmt.getAsObject().count : 0;
  pagesStmt.free();
  const propStmt = db.prepare(`SELECT status, COUNT(*) as count FROM proposals GROUP BY status;`);
  const proposals: any[] = [];
  while (propStmt.step()) proposals.push(propStmt.getAsObject());
  propStmt.free();
  const runsStmt = db.prepare(`SELECT COUNT(*) as count FROM scan_runs;`);
  const scanRuns = runsStmt.step() ? runsStmt.getAsObject().count : 0;
  runsStmt.free();
  return { pages, proposals, scanRuns };
}

export async function getDbStats() {
  await ensureReady();
  const stats = await getStats();
  const totalProposals = stats.proposals.reduce((sum, item) => sum + Number(item.count), 0);
  const countByStatus = (status: string) => Number(stats.proposals.find((item) => item.status === status)?.count ?? 0);

  const topStmt = db.prepare(`SELECT pageUrl, COUNT(*) as count FROM proposals GROUP BY pageUrl ORDER BY count DESC, pageUrl ASC LIMIT 10;`);
  const topPages: Array<{ pageUrl: string; count: number }> = [];
  while (topStmt.step()) {
    const row = topStmt.getAsObject();
    topPages.push({ pageUrl: String(row.pageUrl), count: Number(row.count) });
  }
  topStmt.free();

  return {
    pages: Number(stats.pages),
    scanRuns: Number(stats.scanRuns),
    proposalsTotal: totalProposals,
    pending: countByStatus('pending'),
    applied: countByStatus('applied'),
    failed: countByStatus('failed'),
    invalid: countByStatus('invalid'),
    topPages,
  };
}

export async function cleanupFailedProposals(days = 30): Promise<{ removed: number; failed: number; invalid: number }> {
  await ensureReady();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const oldFailedStmt = db.prepare(`SELECT COUNT(*) as count FROM proposals WHERE status = 'failed' AND createdAt IS NOT NULL AND createdAt < ?;`);
  oldFailedStmt.bind([cutoff]);
  const failed = oldFailedStmt.step() ? Number(oldFailedStmt.getAsObject().count ?? 0) : 0;
  oldFailedStmt.free();

  const deleteStmt = db.prepare(`DELETE FROM proposals WHERE status = 'failed' AND createdAt IS NOT NULL AND createdAt < ?;`);
  deleteStmt.bind([cutoff]);
  while (deleteStmt.step()) {}
  deleteStmt.free();

  const invalidStmt = db.prepare(`
    UPDATE proposals
    SET status = 'invalid', updatedAt = ?
    WHERE status != 'invalid'
      AND (
        proposedHtml IS NULL OR trim(proposedHtml) = ''
        OR title IS NULL OR trim(title) = ''
        OR reason IS NULL OR trim(reason) = ''
      );
  `);
  invalidStmt.bind([new Date().toISOString()]);
  while (invalidStmt.step()) {}
  invalidStmt.free();

  const changesStmt = db.prepare(`SELECT changes() as count;`);
  const invalid = changesStmt.step() ? Number(changesStmt.getAsObject().count ?? 0) : 0;
  changesStmt.free();

  persist();
  return { removed: failed, failed, invalid };
}

export async function getProposalsForExport(): Promise<Array<Pick<SeoProposal, 'id' | 'pageUrl' | 'type' | 'title' | 'priority' | 'status' | 'createdAt'>>> {
  await ensureReady();
  const stmt = db.prepare(`SELECT id, pageUrl, type, title, priority, status, createdAt FROM proposals ORDER BY id ASC;`);
  const rows: Array<Pick<SeoProposal, 'id' | 'pageUrl' | 'type' | 'title' | 'priority' | 'status' | 'createdAt'>> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      id: Number(row.id),
      pageUrl: String(row.pageUrl ?? ''),
      type: String(row.type ?? ''),
      title: String(row.title ?? ''),
      priority: Number(row.priority ?? 0),
      status: row.status as SeoProposal['status'],
      createdAt: row.createdAt ? String(row.createdAt) : undefined,
    });
  }
  stmt.free();
  return rows;
}

export async function createMonitoringRecord(record: Omit<MonitoringRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MonitoringRecord> {
  await ensureReady();
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO monitoring_records (proposalId,pageUrl,status,createdAt,updatedAt) VALUES (?,?,?,?,?);`);
  stmt.bind(normalizeDbRow([record.proposalId, record.pageUrl, record.status, now, now], ['proposalId', 'pageUrl', 'status', 'createdAt', 'updatedAt'], record.pageUrl));
  while (stmt.step()) {}
  stmt.free();

  const idStmt = db.prepare(`SELECT last_insert_rowid() as id;`);
  const id = idStmt.step() ? Number(idStmt.getAsObject().id) : undefined;
  idStmt.free();
  persist();

  return { ...record, id, createdAt: now, updatedAt: now };
}

export async function upsertGscAnalyticsRecords(records: GscAnalyticsRecord[]): Promise<{ inserted: number; updated: number }> {
  await ensureReady();
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  const existsStmt = db.prepare(`SELECT id FROM gsc_analytics_records WHERE pageUrl = ? AND date = ? LIMIT 1;`);
  const stmt = db.prepare(`
    INSERT INTO gsc_analytics_records (pageUrl,date,clicks,impressions,ctr,position,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(pageUrl,date) DO UPDATE SET
      clicks = excluded.clicks,
      impressions = excluded.impressions,
      ctr = excluded.ctr,
      position = excluded.position,
      updatedAt = excluded.updatedAt;
  `);

  for (const record of records) {
    existsStmt.bind([record.pageUrl, record.date]);
    const exists = existsStmt.step();
    existsStmt.reset();
    if (exists) updated += 1;
    else inserted += 1;

    stmt.bind(normalizeDbRow([
      record.pageUrl,
      record.date,
      record.clicks,
      record.impressions,
      record.ctr,
      record.position,
      record.createdAt ?? now,
      now,
    ], ['pageUrl', 'date', 'clicks', 'impressions', 'ctr', 'position', 'createdAt', 'updatedAt'], record.pageUrl));
    while (stmt.step()) {}
    stmt.reset();
  }
  existsStmt.free();
  stmt.free();
  persist();
  return { inserted, updated };
}

export async function getGscAnalyticsRecords(options: { pageUrl?: string; startDate?: string; endDate?: string } = {}): Promise<GscAnalyticsRecord[]> {
  await ensureReady();
  const clauses: string[] = [];
  const values: any[] = [];
  if (options.pageUrl) {
    clauses.push('pageUrl = ?');
    values.push(options.pageUrl);
  }
  if (options.startDate) {
    clauses.push('date >= ?');
    values.push(options.startDate);
  }
  if (options.endDate) {
    clauses.push('date <= ?');
    values.push(options.endDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM gsc_analytics_records ${where} ORDER BY date ASC, pageUrl ASC;`);
  stmt.bind(values);
  const rows: GscAnalyticsRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      id: Number(row.id),
      pageUrl: String(row.pageUrl ?? ''),
      date: String(row.date ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
      createdAt: row.createdAt ? String(row.createdAt) : undefined,
      updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
    });
  }
  stmt.free();
  return rows;
}

export async function getLatestGscDate(): Promise<string | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT MAX(date) as date FROM gsc_analytics_records;`);
  const date = stmt.step() ? stmt.getAsObject().date : null;
  stmt.free();
  return date ? String(date) : null;
}

export async function upsertGscQueryRecords(records: GscQueryRecord[]): Promise<{ inserted: number; updated: number }> {
  await ensureReady();
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  const existsStmt = db.prepare(`SELECT id FROM gsc_query_records WHERE pageUrl = ? AND query = ? AND date = ? LIMIT 1;`);
  const stmt = db.prepare(`
    INSERT INTO gsc_query_records (pageUrl,query,date,clicks,impressions,ctr,position,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pageUrl,query,date) DO UPDATE SET
      clicks = excluded.clicks,
      impressions = excluded.impressions,
      ctr = excluded.ctr,
      position = excluded.position,
      updatedAt = excluded.updatedAt;
  `);

  for (const record of records) {
    existsStmt.bind([record.pageUrl, record.query, record.date]);
    const exists = existsStmt.step();
    existsStmt.reset();
    if (exists) updated += 1;
    else inserted += 1;

    stmt.bind(normalizeDbRow([
      record.pageUrl,
      record.query,
      record.date,
      record.clicks,
      record.impressions,
      record.ctr,
      record.position,
      record.createdAt ?? now,
      now,
    ], ['pageUrl', 'query', 'date', 'clicks', 'impressions', 'ctr', 'position', 'createdAt', 'updatedAt'], record.pageUrl));
    while (stmt.step()) {}
    stmt.reset();
  }
  existsStmt.free();
  stmt.free();
  persist();
  return { inserted, updated };
}

export async function getGscQueryRecords(options: { pageUrl?: string; query?: string; startDate?: string; endDate?: string } = {}): Promise<GscQueryRecord[]> {
  await ensureReady();
  const clauses: string[] = [];
  const values: any[] = [];
  if (options.pageUrl) {
    clauses.push('pageUrl = ?');
    values.push(options.pageUrl);
  }
  if (options.query) {
    clauses.push('query = ?');
    values.push(options.query);
  }
  if (options.startDate) {
    clauses.push('date >= ?');
    values.push(options.startDate);
  }
  if (options.endDate) {
    clauses.push('date <= ?');
    values.push(options.endDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM gsc_query_records ${where} ORDER BY date ASC, impressions DESC, query ASC;`);
  stmt.bind(values);
  const rows: GscQueryRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      id: Number(row.id),
      pageUrl: String(row.pageUrl ?? ''),
      query: String(row.query ?? ''),
      date: String(row.date ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
      createdAt: row.createdAt ? String(row.createdAt) : undefined,
      updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
    });
  }
  stmt.free();
  return rows;
}

export async function getLatestGscQueryDate(): Promise<string | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT MAX(date) as date FROM gsc_query_records;`);
  const date = stmt.step() ? stmt.getAsObject().date : null;
  stmt.free();
  return date ? String(date) : null;
}

export async function createSeoChangeLogEntry(entry: Omit<SeoChangeLogEntry, 'id' | 'createdAt'>): Promise<SeoChangeLogEntry> {
  await ensureReady();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO seo_change_log (pageUrl,changeType,title,description,relatedProposalId,beforeSnapshot,afterSnapshot,appliedAt,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?);
  `);
  stmt.bind(normalizeDbRow([
    entry.pageUrl,
    entry.changeType,
    entry.title,
    entry.description,
    entry.relatedProposalId ?? null,
    entry.beforeSnapshot ?? null,
    entry.afterSnapshot ?? null,
    entry.appliedAt,
    now,
  ], ['pageUrl', 'changeType', 'title', 'description', 'relatedProposalId', 'beforeSnapshot', 'afterSnapshot', 'appliedAt', 'createdAt'], entry.pageUrl));
  while (stmt.step()) {}
  stmt.free();

  const idStmt = db.prepare(`SELECT last_insert_rowid() as id;`);
  const id = idStmt.step() ? Number(idStmt.getAsObject().id) : undefined;
  idStmt.free();
  persist();

  return { ...entry, id, createdAt: now };
}

export async function getSeoChangeLogEntries(options: { pageUrl?: string; startDate?: string; endDate?: string } = {}): Promise<SeoChangeLogEntry[]> {
  await ensureReady();
  const clauses: string[] = [];
  const values: any[] = [];
  if (options.pageUrl) {
    clauses.push('pageUrl = ?');
    values.push(options.pageUrl);
  }
  if (options.startDate) {
    clauses.push('appliedAt >= ?');
    values.push(options.startDate);
  }
  if (options.endDate) {
    clauses.push('appliedAt <= ?');
    values.push(options.endDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM seo_change_log ${where} ORDER BY appliedAt DESC, id DESC;`);
  stmt.bind(values);
  const rows: SeoChangeLogEntry[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push(rowToSeoChange(row));
  }
  stmt.free();
  return rows;
}

export async function saveSeoChangeLogEntry(entry: {
  pageUrl: string;
  changeType: string;
  title: string;
  description?: string;
  appliedAt?: string;
}): Promise<void> {
  await ensureReady();

  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO seo_change_log
    (pageUrl, changeType, title, description, appliedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?);
  `);

  stmt.bind(normalizeDbRow(
    [
      entry.pageUrl,
      entry.changeType,
      entry.title,
      entry.description ?? '',
      entry.appliedAt ?? now,
      now,
    ],
    ['pageUrl', 'changeType', 'title', 'description', 'appliedAt', 'createdAt'],
    entry.pageUrl
  ));

  while (stmt.step()) {}
  stmt.free();
  persist();
}

export async function getSeoChangeLogEntryById(id: number): Promise<SeoChangeLogEntry | null> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM seo_change_log WHERE id = ? LIMIT 1;`);
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? rowToSeoChange(row) : null;
}

function rowToSeoChange(row: any): SeoChangeLogEntry {
  return {
    id: Number(row.id),
    pageUrl: String(row.pageUrl ?? ''),
    changeType: String(row.changeType ?? ''),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    relatedProposalId: row.relatedProposalId === null || row.relatedProposalId === undefined ? undefined : Number(row.relatedProposalId),
    beforeSnapshot: row.beforeSnapshot ? String(row.beforeSnapshot) : undefined,
    afterSnapshot: row.afterSnapshot ? String(row.afterSnapshot) : undefined,
    appliedAt: String(row.appliedAt ?? ''),
    createdAt: row.createdAt ? String(row.createdAt) : undefined,
  };
}

export async function saveSeoAnalysisInsight(insight: Omit<SeoAnalysisInsight, 'id' | 'createdAt'>): Promise<SeoAnalysisInsight> {
  await ensureReady();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO seo_analysis_insights (pageUrl,period,insightType,severity,title,summary,evidenceJson,recommendation,status,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?);
  `);
  stmt.bind(normalizeDbRow([
    insight.pageUrl ?? null,
    insight.period,
    insight.insightType,
    insight.severity,
    insight.title,
    insight.summary,
    insight.evidenceJson,
    insight.recommendation,
    insight.status,
    now,
  ], ['pageUrl', 'period', 'insightType', 'severity', 'title', 'summary', 'evidenceJson', 'recommendation', 'status', 'createdAt'], insight.pageUrl));
  while (stmt.step()) {}
  stmt.free();
  const idStmt = db.prepare(`SELECT last_insert_rowid() as id;`);
  const id = idStmt.step() ? Number(idStmt.getAsObject().id) : undefined;
  idStmt.free();
  persist();
  return { ...insight, id, createdAt: now };
}

export async function getMonitoringRecords(pageUrl?: string): Promise<MonitoringRecord[]> {
  await ensureReady();
  const stmt = pageUrl
    ? db.prepare(`SELECT * FROM monitoring_records WHERE pageUrl = ? ORDER BY createdAt DESC;`)
    : db.prepare(`SELECT * FROM monitoring_records ORDER BY createdAt DESC;`);
  if (pageUrl) stmt.bind([pageUrl]);
  const rows: MonitoringRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      id: Number(row.id),
      proposalId: Number(row.proposalId ?? 0),
      pageUrl: String(row.pageUrl ?? ''),
      status: row.status as MonitoringRecord['status'],
      createdAt: row.createdAt ? String(row.createdAt) : undefined,
      updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
    });
  }
  stmt.free();
  return rows;
}

export async function getAllProposals(): Promise<SeoProposal[]> {
  await ensureReady();
  const stmt = db.prepare(`SELECT * FROM proposals ORDER BY createdAt DESC, id DESC;`);
  const rows: SeoProposal[] = [];
  while (stmt.step()) rows.push(toSeoProposal(stmt.getAsObject()));
  stmt.free();
  return rows;
}
