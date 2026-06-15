import { fetchText } from './http.js';
import { XMLParser } from 'fast-xml-parser';

export async function parseSitemap(url: string, limit: number): Promise<string[]> {
  const xml = await fetchText(url);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const urls: string[] = [];
  if (parsed.urlset && parsed.urlset.url) {
    const pageEntries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    for (const entry of pageEntries.slice(0, limit)) {
      if (entry.loc) urls.push(entry.loc.toString());
    }
  }
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemapEntries = Array.isArray(parsed.sitemapindex.sitemap) ? parsed.sitemapindex.sitemap : [parsed.sitemapindex.sitemap];
    for (const sitemap of sitemapEntries) {
      if (urls.length >= limit) break;
      if (sitemap.loc) {
        const nested = await parseSitemap(sitemap.loc.toString(), limit - urls.length);
        urls.push(...nested);
      }
    }
  }
  return urls.slice(0, limit);
}
