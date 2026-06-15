import { load } from 'cheerio';
import { SeoIssueType, SeoPageData } from './types.js';

export function analyzeHtml(url: string, html: string): SeoPageData {
  const $ = load(html);
  const title = $('head title').first().text().trim() || null;
  const description = $('head meta[name="description"]').attr('content')?.trim() || null;
  const h1 = $('h1').map((_, el: any) => $(el).text().trim()).get().filter(Boolean) as string[];
  const h2 = $('h2').map((_, el: any) => $(el).text().trim()).get().filter(Boolean) as string[];
  const canonical = $('head link[rel="canonical"]').attr('href')?.trim() || null;
  const robots = $('head meta[name="robots"]').attr('content')?.trim() || null;
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  const issues: SeoIssueType[] = [];

  if (!title) {
    issues.push('missing_title');
  } else if (title.length < 30) {
    issues.push('short_title');
  } else if (title.length > 70) {
    issues.push('long_title');
  }

  if (!description) {
    issues.push('missing_description');
  } else if (description.length < 70) {
    issues.push('short_description');
  } else if (description.length > 160) {
    issues.push('long_description');
  }

  if (h1.length === 0) {
    issues.push('missing_h1');
  } else if (new Set(h1.map((text: string) => text.toLowerCase())).size !== h1.length) {
    issues.push('duplicate_h1');
  }

  if (wordCount > 0 && wordCount < 150) {
    issues.push('low_text');
  }

  if (robots?.toLowerCase().includes('noindex')) {
    issues.push('noindex');
  }

  const detectedCanonical = canonical || url;
  if (detectedCanonical !== url) {
    issues.push('canonical_mismatch');
  }

  return {
    url,
    title,
    description,
    h1,
    h2,
    canonical,
    robots,
    wordCount,
    issues,
    scannedAt: new Date().toISOString(),
  };
}
