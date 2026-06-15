import { google } from 'googleapis';
import { config } from './config.js';

export async function getSearchConsoleData(siteUrl: string) {
  if (!config.googleClientEmail || !config.googlePrivateKey) {
    throw new Error('Google Search Console credentials not configured.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: config.googleClientEmail,
      private_key: config.googlePrivateKey,
    },
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      dimensions: ['page'],
      rowLimit: 10,
    },
  });

  return res.data.rows ?? [];
}
