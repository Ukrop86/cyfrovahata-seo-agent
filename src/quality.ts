import { load } from 'cheerio';
import { SeoPageData, SeoProposal, SeoProposalBlockItem } from './types.js';

export interface ProposalQualityIssue {
  reason: string;
  fragment: string;
}

export interface ProposalQualityResult {
  ok: boolean;
  reasons: string[];
  issues: ProposalQualityIssue[];
}

const STOP_WORDS = new Set([
  'але',
  'або',
  'без',
  'бізнес',
  'буде',
  'бути',
  'ваш',
  'ваша',
  'ваше',
  'вони',
  'для',
  'його',
  'коли',
  'може',
  'можна',
  'над',
  'наш',
  'наша',
  'наше',
  'про',
  'при',
  'сайт',
  'сайту',
  'сайтів',
  'такий',
  'також',
  'тому',
  'цей',
  'цієї',
  'щоб',
  'якщо',
  'with',
  'that',
  'this',
  'your',
  'from',
  'have',
]);

const BANNED_GENERIC_PHRASES = [
  'у цій статті ми розглянемо',
  'в цій статті ми розглянемо',
  'у цій статті ви дізнаєтесь',
  'в сучасному світі',
  'у сучасному світі',
  'сьогодні кожен бізнес',
  'важко переоцінити',
  'є дуже важливим',
  'має велике значення',
  'це оптимальне рішення',
  'дозволяє отримати повністю готовий',
];

const CTA_PATTERNS = [
  'замовити сайт',
  'звʼяжіться з нами',
  "зв'яжіться з нами",
  'залиште заявку',
  'отримайте консультацію',
  'замовте консультацію',
];

export function normalizeText(text: string): string {
  return String(text ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractParagraphs(html: string): string[] {
  const $ = load(html ?? '');
  return $('p')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);
}

export function extractHeadings(html: string): string[] {
  const $ = load(html ?? '');
  return $('h2,h3')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);
}

export function similarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return Math.max(tokenJaccard(left, right), diceCoefficient(left, right));
}

export function validateProposalQuality(proposal: SeoProposal, page: Pick<SeoPageData, 'url' | 'title' | 'description' | 'h1' | 'h2'>): ProposalQualityResult {
  const html = proposal.proposedHtml ?? '';
  const paragraphs = extractParagraphs(html);
  const headings = extractHeadings(html);
  const text = normalizeText(html);
  const issues: ProposalQualityIssue[] = [];

  addRepeatedParagraphIssues(paragraphs, issues);
  addRepeatedHeadingIssues(headings, page, issues);
  addSeoWasteIssues(text, paragraphs, issues);
  addTypeSpecificIssues(proposal, page, paragraphs, headings, text, issues);

  const reasons = [...new Set(issues.map((issue) => issue.reason))];
  return { ok: issues.length === 0, reasons, issues };
}

function tokenJaccard(a: string, b: string): number {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function diceCoefficient(a: string, b: string): number {
  const left = charBigrams(a);
  const right = charBigrams(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const [bigram, leftCount] of left.entries()) {
    intersection += Math.min(leftCount, right.get(bigram) ?? 0);
  }
  const leftTotal = [...left.values()].reduce((sum, count) => sum + count, 0);
  const rightTotal = [...right.values()].reduce((sum, count) => sum + count, 0);
  return (2 * intersection) / (leftTotal + rightTotal);
}

function charBigrams(text: string): Map<string, number> {
  const compact = text.replace(/\s+/g, ' ');
  const map = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i += 1) {
    const bigram = compact.slice(i, i + 2);
    map.set(bigram, (map.get(bigram) ?? 0) + 1);
  }
  return map;
}

function contentWords(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function addRepeatedParagraphIssues(paragraphs: string[], issues: ProposalQualityIssue[]) {
  for (let i = 0; i < paragraphs.length; i += 1) {
    for (let j = i + 1; j < paragraphs.length; j += 1) {
      const score = similarity(paragraphs[i], paragraphs[j]);
      if (score > 0.85) {
        issues.push({
          reason: `repeated_or_similar_paragraphs similarity=${score.toFixed(2)}`,
          fragment: paragraphs[j],
        });
      }
    }
  }
}

function addRepeatedHeadingIssues(headings: string[], page: Pick<SeoPageData, 'title' | 'h1' | 'h2'>, issues: ProposalQualityIssue[]) {
  for (let i = 0; i < headings.length; i += 1) {
    for (let j = i + 1; j < headings.length; j += 1) {
      const score = similarity(headings[i], headings[j]);
      if (score > 0.85) {
        issues.push({
          reason: `repeated_or_similar_headings similarity=${score.toFixed(2)}`,
          fragment: headings[j],
        });
      }
    }
  }

  const pageHeadings = [page.title, ...(page.h1 ?? []), ...(page.h2 ?? [])].filter(Boolean) as string[];
  for (const heading of headings) {
    for (const pageHeading of pageHeadings) {
      const score = similarity(heading, pageHeading);
      if (score > 0.9) {
        issues.push({
          reason: `heading_duplicates_page_heading similarity=${score.toFixed(2)}`,
          fragment: heading,
        });
      }
    }
  }
}

function addSeoWasteIssues(text: string, paragraphs: string[], issues: ProposalQualityIssue[]) {
  for (const phrase of BANNED_GENERIC_PHRASES) {
    if (text.includes(normalizeText(phrase))) {
      issues.push({ reason: 'generic_or_water_phrase', fragment: phrase });
    }
  }

  const repeatedKeyword = findOverRepeatedKeyword(text);
  if (repeatedKeyword) {
    issues.push({
      reason: `keyword_overuse ${repeatedKeyword.word}=${repeatedKeyword.count}`,
      fragment: repeatedKeyword.word,
    });
  }

  for (const cta of CTA_PATTERNS) {
    const normalizedCta = normalizeText(cta);
    const matches = text.split(normalizedCta).length - 1;
    if (matches > 1) {
      issues.push({ reason: `repeated_cta_phrase count=${matches}`, fragment: cta });
    }
  }

  if (paragraphs.some((paragraph) => isKeywordList(paragraph))) {
    issues.push({
      reason: 'keyword_list_instead_of_content',
      fragment: paragraphs.find((paragraph) => isKeywordList(paragraph)) ?? '',
    });
  }
}

function addTypeSpecificIssues(
  proposal: SeoProposal,
  page: Pick<SeoPageData, 'url' | 'title' | 'description' | 'h1' | 'h2'>,
  paragraphs: string[],
  headings: string[],
  text: string,
  issues: ProposalQualityIssue[]
) {
  if (proposal.type === 'seo_block') {
    const goodParagraphs = paragraphs.filter((paragraph) => contentWords(paragraph).length >= 12 && normalizeText(paragraph).length >= 90);
    const hasHeadingAndParagraph = headings.length > 0 && goodParagraphs.length >= 1;
    if (goodParagraphs.length < 2 && !hasHeadingAndParagraph) {
      issues.push({
        reason: 'seo_block_too_thin',
        fragment: paragraphs[0] ?? headings[0] ?? proposal.title,
      });
    }
    if (!hasPageRelevance(text, page)) {
      issues.push({
        reason: 'seo_block_not_relevant_to_page',
        fragment: paragraphs[0] ?? proposal.title,
      });
    }
  }

  if (proposal.type === 'faq') {
    const qaItems = extractFaqItems(proposal, paragraphs);
    if (qaItems.length < 2) {
      issues.push({
        reason: 'faq_too_few_items',
        fragment: proposal.title,
      });
    }
    addRepeatedFaqIssues(qaItems, issues);
  }
}

function findOverRepeatedKeyword(text: string): { word: string; count: number } | null {
  const words = contentWords(text);
  const total = words.length;
  if (total < 30) return null;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const [word, count] of counts.entries()) {
    if (count >= 6 && count / total > 0.08) return { word, count };
  }
  return null;
}

function isKeywordList(text: string): boolean {
  const raw = String(text ?? '').trim();
  const commaParts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const normalized = normalizeText(raw);
  const words = contentWords(normalized);
  if (commaParts.length >= 5 && words.length < 35) return true;
  if (commaParts.length >= 6 && !/[.!?]/.test(raw)) return true;
  return false;
}

function hasPageRelevance(text: string, page: Pick<SeoPageData, 'url' | 'title' | 'description' | 'h1' | 'h2'>): boolean {
  const pageSignal = normalizeText([
    page.title,
    page.description,
    ...(page.h1 ?? []),
    ...(page.h2 ?? []),
    page.url.replace(/^https?:\/\//, '').replace(/[/-]/g, ' '),
  ].filter(Boolean).join(' '));
  const pageWords = new Set(contentWords(pageSignal));
  if (!pageWords.size) return true;
  const proposalWords = new Set(contentWords(text));
  const overlap = [...pageWords].filter((word) => proposalWords.has(word)).length;
  return overlap >= Math.min(2, pageWords.size);
}

function extractFaqItems(proposal: SeoProposal, paragraphs: string[]): SeoProposalBlockItem[] {
  const blockItems = (proposal.htmlBlocks ?? [])
    .flatMap((block) => block.items ?? [])
    .filter((item) => item.question && item.answer);
  if (blockItems.length) return blockItems;

  const $ = load(proposal.proposedHtml ?? '');
  const items: SeoProposalBlockItem[] = [];
  $('h3').each((_, heading) => {
    const question = $(heading).text().replace(/\s+/g, ' ').trim();
    const answer = $(heading).next('p').text().replace(/\s+/g, ' ').trim();
    if (question && answer) items.push({ question, answer });
  });

  if (!items.length && paragraphs.length >= 2) {
    for (let i = 0; i < paragraphs.length - 1; i += 2) {
      items.push({ question: paragraphs[i], answer: paragraphs[i + 1] });
    }
  }

  return items;
}

function addRepeatedFaqIssues(items: SeoProposalBlockItem[], issues: ProposalQualityIssue[]) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const questionScore = similarity(items[i].question, items[j].question);
      if (questionScore > 0.85) {
        issues.push({
          reason: `faq_duplicate_questions similarity=${questionScore.toFixed(2)}`,
          fragment: items[j].question,
        });
      }
      const answerScore = similarity(items[i].answer, items[j].answer);
      if (answerScore > 0.85) {
        issues.push({
          reason: `faq_duplicate_answers similarity=${answerScore.toFixed(2)}`,
          fragment: items[j].answer,
        });
      }
    }
  }
}
