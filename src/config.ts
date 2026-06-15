import dotenv from 'dotenv';
import path from 'path';

// List of known environment keys
const ENV_KEYS = [
  'DB_PATH',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'OPENAI_API_KEY',
  'SCAN_LIMIT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'WP_APP_PASSWORD',
  'WP_BASE_URL',
  'WP_USERNAME',
];

// If at least one known key is already provided via process.env (e.g., Codespaces secrets),
// prefer those and do not require a local .env. Otherwise try to load .env for local dev.
const anyProvided = ENV_KEYS.some((k) => !!process.env[k]);
if (!anyProvided) {
  dotenv.config();
} else {
  // still allow loading .env to augment, but do not fail if absent
  try {
    dotenv.config();
  } catch (e) {
    // ignore
  }
}

export const config = {
  dbPath: process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'seo-agent.db'),
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL ?? '',
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  scanLimit: Number(process.env.SCAN_LIMIT ?? '25'),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  wpBaseUrl: process.env.WP_BASE_URL ?? '',
  wpUsername: process.env.WP_USERNAME ?? '',
  wpAppPassword: process.env.WP_APP_PASSWORD ?? '',
};

export function envStatus(): Record<string, 'OK' | 'MISSING'> {
  const keys = [
    'OPENAI_API_KEY',
    'WP_BASE_URL',
    'WP_USERNAME',
    'WP_APP_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'DB_PATH',
  ];
  const out: Record<string, 'OK' | 'MISSING'> = {};
  for (const k of keys) {
    out[k] = !!process.env[k] ? 'OK' : 'MISSING';
  }
  return out;
}

// Validate required variables based on command context
export function validateForCommand(command: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const check = (k: string) => {
    if (!process.env[k]) missing.push(k);
  };

  // Minimal for scan: need DB_PATH and WP_BASE_URL to fetch sitemap and store results
  if (command === 'scan') {
    check('DB_PATH');
    check('WP_BASE_URL');
  }

  // Generating proposals requires OpenAI and DB
  if (command === 'proposals') {
    check('OPENAI_API_KEY');
    check('DB_PATH');
  }

  // Apply requires WP credentials and DB
  if (command === 'apply') {
    check('WP_BASE_URL');
    check('WP_USERNAME');
    check('WP_APP_PASSWORD');
    check('DB_PATH');
  }

  // Telegram reports are optional but warn if missing (not fatal)
  if (command === 'scan' || command === 'proposals' || command === 'apply') {
    // no-op; warnings handled elsewhere
  }

  return { ok: missing.length === 0, missing };
}

export function printStartupDiagnostics(): void {
  console.log('SEO Agent startup');
  const statuses = envStatus();
  for (const k of Object.keys(statuses)) {
    console.log(`${k}: ${statuses[k]}`);
  }
}
