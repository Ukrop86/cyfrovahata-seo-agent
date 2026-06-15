import crypto from 'crypto';
import { parseSitemap } from './sitemap.js';
import { analyzeHtml } from './seo.js';
import { fetchText } from './http.js';
import { savePage, saveProposal, getPendingProposals, getProposalById, getProposalBySignature, getPageByUrl, getStats, getPages, saveScanRun } from './db.js';
import { createSeoProposals } from './openai.js';
import { getWpPageByUrl, updateWpContent, isWpArchiveUrl } from './wordpress.js';
import { sendScanReport, sendProposalsReport, sendApplySuccessReport, sendApplyFailureReport, sendTelegramTest, sendTelegramReport } from './telegram.js';
import { appendAgentBlock, hasAgentBlockForProposal, hasAgentBlockForType } from './content.js';
import { getSearchConsoleData } from './gsc.js';
import { config, printStartupDiagnostics, validateForCommand } from './config.js';

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

  const searchData = await getSearchConsoleData(config.wpBaseUrl).catch((error) => {
    console.warn('GSC access failed:', error instanceof Error ? error.message : error);
    return [];
  });
  const searchSummary = searchData.length ? JSON.stringify(searchData.slice(0, 5)) : undefined;
  const rows = await getPages(config.scanLimit);
  const rowsToProcess = rows.filter((row) => {
    if (isWpArchiveUrl(row.url)) {
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
      const result = await createSeoProposals(row.url, pageData, searchSummary);
      openAiResponses += 1;
      if (!result || !result.proposals) {
        console.warn(`No parsable proposals for ${row.url}. Raw saved to logs/openai_raw.log`);
        continue;
      }
      jsonParsed += 1;
      for (const proposal of result.proposals) {
        const existing = await getProposalBySignature(proposal.pageUrl, proposal.type, proposal.title);
        if (existing) {
          console.warn(`Skipping proposal: pageUrl=${row.url} type=${proposal.type} title=${proposal.title || '<no title>'} reason=duplicate`);
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

  if (isWpArchiveUrl(proposal.pageUrl)) {
    console.error('Archive/category URL cannot be edited by WordPress page API');
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
    await updateWpContent(page.id, preview);
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
  if (proposal.type === 'faq' && proposal.htmlBlocks.every((block: any) => !hasFaqItems(block))) return 'faq items missing';
  if ((proposal.type === 'faq' || proposal.type === 'seo_block') && !proposal.proposedHtml) return 'no text after buildProposedHtml';
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
  if (type === 'faq') {
    return /<h3>.*<\/h3>/i.test(html) && /<p>.*<\/p>/i.test(html);
  }
  return /<h2>.*<\/h2>/i.test(html) || /<p>.*<\/p>/i.test(html);
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
  console.log('Usage: node dist/index.js [scan|proposals|apply|status|proposal-detail|cleanup-invalid|cleanup-archives|telegram-test]');
  console.log('       npx tsx src/index.ts proposal-detail <id>');
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
  console.log(`monitoringStatus: ${proposal.monitoringStatus}`);
  console.log(`monitoringUntil: ${proposal.monitoringUntil}`);
  console.log('proposedHtml:');
  console.log(proposal.proposedHtml);
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
