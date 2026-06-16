import { config } from './config.js';
import { fetchJson } from './http.js';

const auth = `Basic ${Buffer.from(`${config.wpUsername}:${config.wpAppPassword}`).toString('base64')}`;

export function isWpArchiveUrl(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    const path = url.pathname.toLowerCase();
    const archiveSegments = ['/category/', '/tag/', '/author/', '/archive/', '/archives/'];
    if (archiveSegments.some((segment) => path.includes(segment))) return true;
    if (/\/page\/\d+\/?$/.test(path)) return true;
    if (url.searchParams.has('s') || url.searchParams.has('paged')) return true;
    return false;
  } catch {
    return false;
  }
}

export function isEditableWpContentUrl(pageUrl: string): boolean {
  return !isWpArchiveUrl(pageUrl);
}

function safeFetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  return fetchJson<T>(url, { ...options, headers: { ...options.headers, Authorization: auth, 'Content-Type': 'application/json' } });
}

function getSlugFromUrl(pageUrl: string): string {
  const pathSegments = new URL(pageUrl).pathname.split('/').filter(Boolean);
  return pathSegments[pathSegments.length - 1] ?? '';
}

async function getWpItemsBySlug(kind: 'pages' | 'posts', slug: string) {
  const apiUrl = `${config.wpBaseUrl.replace(/\/$/, '')}/wp-json/wp/v2/${kind}?slug=${encodeURIComponent(slug)}`;
  return safeFetchJson<any[]>(apiUrl).catch((err) => {
    const message = err.message || 'WordPress request failed';
    if (message.includes('401') || message.includes('rest_cannot_edit')) {
      throw new Error('WP_AUTH_FAILED');
    }
    throw err;
  });
}

export async function getWpContentByUrl(pageUrl: string) {
  const slug = getSlugFromUrl(pageUrl);
  const pages = await getWpItemsBySlug('pages', slug);
  if (pages[0]) return pages.map((item) => ({ ...item, restBase: 'pages' }));
  const posts = await getWpItemsBySlug('posts', slug);
  return posts.map((item) => ({ ...item, restBase: 'posts' }));
}

export async function getWpPageByUrl(pageUrl: string) {
  const items = await getWpContentByUrl(pageUrl);
  return items[0] ?? null;
}

export async function updateWpContent(postId: number, content: string, restBase: 'pages' | 'posts' = 'pages') {
  const apiUrl = `${config.wpBaseUrl.replace(/\/$/, '')}/wp-json/wp/v2/${restBase}/${postId}`;
  return safeFetchJson<any>(apiUrl, { method: 'POST', body: JSON.stringify({ content }) }).catch((err) => {
    const message = err.message || 'WordPress update failed';
    if (message.includes('401') || message.includes('rest_cannot_edit')) {
      throw new Error('WP_AUTH_FAILED');
    }
    throw err;
  });
}
