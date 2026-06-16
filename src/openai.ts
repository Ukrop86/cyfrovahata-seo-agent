import OpenAI from 'openai';
import { config } from './config.js';
import { SeoProposal, SeoProposalHtmlBlock } from './types.js';
import fs from 'fs';
import path from 'path';

const client = new OpenAI({ apiKey: config.openAiApiKey });

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildGenericSectionHtml(block: SeoProposalHtmlBlock, titleFallback: string): string {
  const headingText = block.heading || block.title || titleFallback;
  const heading = headingText ? `<h2>${escapeHtml(headingText)}</h2>` : '';
  const paragraphValues = [
    ...(block.description ? [block.description] : []),
    ...(block.paragraphs ?? []),
  ].filter((text) => String(text).trim().length > 0);
  const paragraphs = paragraphValues.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const textValue = typeof block.text === 'string' ? block.text.trim() : '';
  const paragraphFromText = textValue ? `<p>${escapeHtml(textValue)}</p>` : '';
  const listItems = Array.isArray(block.internalLinks)
    ? `<ul>${block.internalLinks
        .filter((link: any) => link && link.text && link.url)
        .map((link: any) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.text)}</a></li>`)
        .join('')}</ul>`
    : '';

  if (!heading && !paragraphs && !paragraphFromText && !listItems) return '';
  const classAttr = block.className ? ` class="${escapeHtml(block.className)}"` : '';
  return `<section${classAttr}>${heading}${paragraphs}${paragraphFromText}${listItems}</section>`;
}

function buildSeoBlockHtml(block: SeoProposalHtmlBlock, titleFallback: string): string {
  const headingText = block.heading || block.title || titleFallback;
  const heading = headingText ? `<h2>${escapeHtml(headingText)}</h2>` : '';
  const paragraphValues = [
    ...(block.text ? [block.text] : []),
    ...(block.description ? [block.description] : []),
    ...(block.paragraphs ?? []),
  ]
    .map((text) => String(text).trim())
    .filter(Boolean);
  if (!heading || paragraphValues.length === 0) return '';
  const paragraphs = paragraphValues.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  return `<section class="cyfrovahata-seo-block">${heading}${paragraphs}</section>`;
}

function buildFaqHtml(block: SeoProposalHtmlBlock, titleFallback: string): string {
  const items = (block.items ?? [])
    .filter((item) => item && item.question && item.answer)
    .map((item) => ({ question: String(item.question), answer: String(item.answer) }));
  if (!items.length && block.question && block.answer) {
    items.push({ question: String(block.question), answer: String(block.answer) });
  }
  if (!items.length) return '';
  const heading = block.heading ? `<h2>${escapeHtml(block.heading)}</h2>` : `<h2>${escapeHtml(titleFallback)}</h2>`;
  const itemsHtml = items
    .map((item) => `
      <div class="faq-item">
        <h3>${escapeHtml(item.question)}</h3>
        <p>${escapeHtml(item.answer)}</p>
      </div>`)
    .join('');
  return `<section class="cyfrovahata-faq">${heading}${itemsHtml}
</section>`;
}

function buildProposedHtml(proposal: SeoProposal): string {
  if (proposal.proposedHtml) return proposal.proposedHtml;
  if (!proposal.htmlBlocks || !proposal.htmlBlocks.length) return '';

  const titleFallback = proposal.title || (proposal.type === 'faq' ? 'Часті питання' : proposal.type === 'seo_block' ? 'SEO-блок' : 'Контентне покращення');
  const html = proposal.htmlBlocks
    .map((block) => {
      if (proposal.type === 'faq') return buildFaqHtml(block, titleFallback);
      if (proposal.type === 'seo_block') return buildSeoBlockHtml(block, titleFallback);
      return buildGenericSectionHtml(block, titleFallback);
    })
    .filter(Boolean)
    .join('');

  return html.trim();
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
}

export function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch (e) {
    const cleaned = stripCodeFences(text).trim();
    const firstCandidates = ['[', '{'].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0);
    const lastCandidates = [']', '}'].map((c) => cleaned.lastIndexOf(c)).filter((i) => i >= 0);
    if (firstCandidates.length === 0 || lastCandidates.length === 0) return null;
    const firstIdx = Math.min(...firstCandidates);
    const lastIdx = Math.max(...lastCandidates);
    if (lastIdx <= firstIdx) return null;
    const sub = cleaned.slice(firstIdx, lastIdx + 1);
    try {
      return JSON.parse(sub);
    } catch (e2) {
      return null;
    }
  }
}

function ensureLogsDir() {
  const dir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveRawResponse(pageUrl: string, text: string) {
  try {
    const dir = ensureLogsDir();
    const file = path.join(dir, 'openai_raw.log');
    const entry = `\n--- ${new Date().toISOString()} ${pageUrl} ---\n${text}\n`;
    fs.appendFileSync(file, entry, { encoding: 'utf8' });
  } catch (e) {
    // ignore
  }
}

function normalizeType(value: unknown): string {
  if (!value || typeof value !== 'string') return 'content';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('faq')) return 'faq';
  if (normalized.includes('seo_block') || normalized === 'seoblock' || normalized === 'seo') return 'seo_block';
  if (normalized.includes('internal_link') || normalized.includes('internal links') || normalized.includes('internal_links')) return 'internal_links';
  if (normalized.includes('title') || normalized.includes('description') || normalized.includes('content')) return 'content';
  if (['faq', 'seo_block', 'title', 'description', 'internal_links', 'content'].includes(normalized)) return normalized;
  return 'content';
}

function normalizeLinks(value: any): Array<{ text: string; url: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value
    .filter((link) => link && link.text && link.url)
    .map((link) => ({ text: String(link.text), url: String(link.url) }));
  return links.length ? links : undefined;
}

function normalizeItems(value: any): Array<{ question: string; answer: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item) => item && item.question && item.answer)
    .map((item) => ({ question: String(item.question), answer: String(item.answer) }));
  return items.length ? items : undefined;
}

function normalizeParagraphs(rawBlock: any): string[] | undefined {
  const values: string[] = [];
  if (typeof rawBlock.text === 'string') values.push(rawBlock.text);
  if (typeof rawBlock.description === 'string') values.push(rawBlock.description);
  if (Array.isArray(rawBlock.paragraphs)) values.push(...rawBlock.paragraphs.map(String));
  const normalized = values.map((text) => text.trim()).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function normalizeObjectBlock(rawBlock: any): SeoProposalHtmlBlock {
  const block: SeoProposalHtmlBlock = {
    tag: String(rawBlock.tag ?? 'section'),
    className: rawBlock.className ? String(rawBlock.className) : undefined,
    heading: rawBlock.heading ? String(rawBlock.heading) : undefined,
    paragraphs: normalizeParagraphs(rawBlock),
    items: normalizeItems(rawBlock.items),
    text: rawBlock.text ? String(rawBlock.text) : undefined,
    question: rawBlock.question ? String(rawBlock.question) : undefined,
    answer: rawBlock.answer ? String(rawBlock.answer) : undefined,
    internalLinks: normalizeLinks(rawBlock.internalLinks ?? rawBlock.internal_links),
    title: rawBlock.title ? String(rawBlock.title) : undefined,
    description: rawBlock.description ? String(rawBlock.description) : undefined,
  };

  if (!block.items && block.question && block.answer) {
    block.items = [{ question: block.question, answer: block.answer }];
  }

  return block;
}

function normalizeHtmlBlocks(value: any, proposalType: string): SeoProposalHtmlBlock[] | undefined {
  if (Array.isArray(value)) {
    const blocks: SeoProposalHtmlBlock[] = [];
    for (const rawBlock of value) {
      if (typeof rawBlock === 'string') {
        blocks.push({ tag: 'section', paragraphs: [rawBlock] });
        continue;
      }
      if (Array.isArray(rawBlock) && rawBlock.every((item) => typeof item === 'string')) {
        if (proposalType === 'faq') {
          const items = [] as { question: string; answer: string }[];
          for (let i = 0; i < rawBlock.length; i += 2) {
            const question = rawBlock[i] ?? '';
            const answer = rawBlock[i + 1] ?? '';
            if (question || answer) items.push({ question, answer });
          }
          blocks.push({ tag: 'section', items });
        } else {
          blocks.push({ tag: 'section', paragraphs: rawBlock });
        }
        continue;
      }
      if (rawBlock && typeof rawBlock === 'object') {
        blocks.push(normalizeObjectBlock(rawBlock));
        continue;
      }
    }
    return blocks.length ? blocks : undefined;
  }
  if (value && typeof value === 'object') {
    return [normalizeObjectBlock(value)];
  }
  return undefined;
}

function normalizeProposalObject(p: any, pageUrl: string): SeoProposal {
  const type = normalizeType(p.type ?? p.proposalType ?? p.category ?? 'content');
  const rawTitle = p.title ?? p.proposalTitle ?? p.proposal ?? '';
  const rawReason = p.reason ?? p.proposalDescription ?? p.exactAction ?? '';
  const rawExactAction = p.exactAction ?? p.action ?? '';
  const priority = typeof p.priority === 'string' ? p.priority.toLowerCase() : 'medium';
  const pageUrlValue = p.pageUrl ?? pageUrl;
  const title = String(rawTitle ?? '').trim() || (type === 'faq' ? 'FAQ для сторінки' : type === 'seo_block' ? 'SEO-блок для сторінки' : 'Контентне покращення');
  return {
    pageUrl: pageUrlValue,
    type,
    title,
    priority: ['high', 'medium', 'low'].includes(String(priority)) ? String(priority) : 'medium',
    reason: String(rawReason ?? '') || 'SEO-пропозиція для сторінки',
    exactAction: String(rawExactAction ?? '') || 'Оновити вміст сторінки для SEO',
    htmlBlocks: normalizeHtmlBlocks(p.htmlBlocks ?? p.html_blocks ?? p.blocks ?? [], type),
    proposedHtml: '',
    status: 'pending',
  };
}

function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export async function createSeoProposals(pageUrl: string, pageData: { title: string | null; description: string | null; h1: string[]; h2: string[]; wordCount: number; issues: string[]; }, searchConsoleSummary?: string): Promise<{ proposals: SeoProposal[] | null; raw: string | null }> {
  const promptParts = [
    'You are a helpful SEO assistant. Return ONLY valid JSON — a JSON array of proposal objects. No markdown, no explanation, no backticks, no HTML.',
    'Use only plain strings and arrays. Do not use newline characters inside string values.',
    'Return up to 3 proposals: exactly 1 faq, 1 seo_block, and optionally 1 content/title/description/internal_links proposal.',
    'Each proposal must include pageUrl, type, title, priority, reason, exactAction, htmlBlocks.',
    'For faq: htmlBlocks must include one block with items array containing at least 3 objects with question and answer.',
    'For seo_block: htmlBlocks must include a heading and 2 to 4 substantial paragraphs.',
    'Do not include proposedHtml in the response. htmlBlocks must contain plain text fields only.',
    `Page URL: ${pageUrl}`,
    `Title: ${pageData.title ?? 'N/A'}`,
    `Description: ${pageData.description ?? 'N/A'}`,
    `H1 tags: ${pageData.h1.join(', ')}`,
    `H2 tags: ${pageData.h2.join(', ')}`,
    `Word count: ${pageData.wordCount}`,
    `Issues: ${pageData.issues.join(', ')}`,
    'Include local phrases: розробка сайтів Україна, розробка сайтів Ужгород, SEO просування сайтів, сайт під ключ.',
  ];
  if (searchConsoleSummary) promptParts.push(`Search Console summary: ${searchConsoleSummary}`);
  const input = promptParts.join('\n');

  const schema = {
    name: 'seo_proposals',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pageUrl: { type: 'string' },
          type: { type: 'string', enum: ['faq', 'seo_block', 'title', 'description', 'internal_links', 'content'] },
          title: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
          exactAction: { type: 'string' },
          htmlBlocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                className: { type: 'string' },
                heading: { type: 'string' },
                text: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
                internalLinks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      url: { type: 'string' },
                    },
                  },
                },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string' },
                      answer: { type: 'string' },
                    },
                    required: ['question', 'answer'],
                  },
                },
              },
              required: ['tag'],
            },
          },
        },
        required: ['pageUrl', 'type', 'title', 'priority', 'reason', 'exactAction', 'htmlBlocks'],
      },
    },
  };

  const request: any = {
    model: 'gpt-4.1-mini',
    input,
    max_output_tokens: 2000,
    text: {
      format: {
        type: 'json_schema',
        name: schema.name,
        schema: schema.schema,
      },
    },
  };

  let raw: string | null = null;
  let response: any;

  try {
    response = await client.responses.create(request);
  } catch (firstError: any) {
    const fallbackRequest: any = {
      model: 'gpt-4.1-mini',
      input,
      max_output_tokens: 2000,
    };
    response = await client.responses.create(fallbackRequest);
  }

  raw = String((response as any).output_text ?? (response as any).output?.[0]?.content?.[0]?.text ?? JSON.stringify(response));
  const extracted = extractJsonArray(raw) ?? raw;
  const parsed = safeJsonParse(extracted);
  if (!parsed) {
    await saveRawResponse(pageUrl, raw);
    return { proposals: null, raw };
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];

  const normalizedProposals = arr.map((p: any) => {
    const normalized = normalizeProposalObject(p, pageUrl);
    normalized.htmlBlocks = normalizeHtmlBlocks(p.htmlBlocks ?? p.html_blocks ?? p.blocks ?? [], normalized.type);
    normalized.proposedHtml = buildProposedHtml(normalized);
    if (!normalized.proposedHtml && typeof p.proposedHtml === 'string') {
      normalized.proposedHtml = p.proposedHtml.trim();
    }
    return normalized;
  });

  const selected: SeoProposal[] = [];
  const seenTypes: Set<string> = new Set();
  for (const proposal of normalizedProposals) {
    if (!isValidProposalHtml(proposal)) continue;
    if (selected.length >= 3) break;
    if (proposal.type === 'faq' && !seenTypes.has('faq')) {
      selected.push(proposal);
      seenTypes.add('faq');
      continue;
    }
    if (proposal.type === 'seo_block' && !seenTypes.has('seo_block')) {
      selected.push(proposal);
      seenTypes.add('seo_block');
      continue;
    }
    if (!['faq', 'seo_block'].includes(proposal.type) && !seenTypes.has('other')) {
      selected.push(proposal);
      seenTypes.add('other');
      continue;
    }
  }

  return { proposals: selected, raw };
}

function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function countMatches(html: string, regex: RegExp): number {
  return html.match(regex)?.length ?? 0;
}

function isValidProposalHtml(proposal: SeoProposal): boolean {
  const html = proposal.proposedHtml?.trim() ?? '';
  if (!html || textLength(html) < 50) return false;
  if (/<section[^>]*>\s*<\/section>/i.test(html)) return false;

  if (proposal.type === 'faq') {
    return countMatches(html, /<h3\b[^>]*>/gi) >= 3 && countMatches(html, /<p\b[^>]*>/gi) >= 3;
  }

  if (proposal.type === 'seo_block') {
    return countMatches(html, /<h2\b[^>]*>/gi) >= 1 && countMatches(html, /<p\b[^>]*>/gi) >= 2;
  }

  return countMatches(html, /<h2\b[^>]*>/gi) >= 1 || countMatches(html, /<p\b[^>]*>/gi) >= 1 || countMatches(html, /<li\b[^>]*>/gi) >= 1;
}

export default null;
