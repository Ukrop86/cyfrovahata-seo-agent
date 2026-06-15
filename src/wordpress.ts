import { config } from './config.js';
import { fetchJson, fetchText } from './http.js';

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

function safeFetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  return fetchJson<T>(url, { ...options, headers: { ...options.headers, Authorization: auth, 'Content-Type': 'application/json' } });
}

export async function getWpContentByUrl(pageUrl: string) {
  const pathSegments = new URL(pageUrl).pathname.split('/').filter(Boolean);
  const slug = pathSegments[pathSegments.length - 1] ?? '';
  const apiUrl = `${config.wpBaseUrl.replace(/\/$/, '')}/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}`;
  return safeFetchJson<any[]>(apiUrl).catch((err) => {
    const message = err.message || 'WordPress request failed';
    if (message.includes('401') || message.includes('rest_cannot_edit')) {
      throw new Error('WP_AUTH_FAILED');
    }
    throw err;
  });
}

export async function getWpPageByUrl(pageUrl: string) {
  const items = await getWpContentByUrl(pageUrl);
  return items[0] ?? null;
}

export async function updateWpContent(postId: number, content: string) {
  const apiUrl = `${config.wpBaseUrl.replace(/\/$/, '')}/wp-json/wp/v2/pages/${postId}`;
  return safeFetchJson<any>(apiUrl, { method: 'POST', body: JSON.stringify({ content }) }).catch((err) => {
    const message = err.message || 'WordPress update failed';
    if (message.includes('401') || message.includes('rest_cannot_edit')) {
      throw new Error('WP_AUTH_FAILED');
    }
    throw err;
  });
}
