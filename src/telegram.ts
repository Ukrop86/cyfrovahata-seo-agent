import { config } from './config.js';

const baseUrl = `https://api.telegram.org/bot${config.telegramBotToken}`;

function normalizeText(text: string): string {
  return String(text);
}

export async function sendTelegramMessage(message: string): Promise<Response> {
  const response = await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, text: normalizeText(message) }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response;
}

export async function sendScanReport(urlCount: number, pagesScanned: number, pagesWithProblems: number, openAiParsed: number, proposalsCount: number, topPages: string[]): Promise<Response> {
  const message = `📊 SEO Scan завершено\n\n🌐 ${config.wpBaseUrl}\n📄 URL: ${urlCount}\n✅ Проскановано: ${pagesScanned}\n⚠️ Сторінок з проблемами: ${pagesWithProblems}\n🧠 OpenAI parsed: ${openAiParsed}/${urlCount}\n📋 SEO-пропозицій: ${proposalsCount}\n\nTOP проблеми:\n${topPages.join('\n')}`;
  return sendTelegramMessage(message);
}

export async function sendTelegramReport(message: string): Promise<Response> {
  return sendTelegramMessage(message);
}

export async function sendProposalsReport(topProposals: string[]): Promise<Response> {
  const message = topProposals.length === 0
    ? '📋 SEO-пропозицій немає.'
    : `📋 SEO-пропозиції:\n${topProposals.join('\n')}`;
  return sendTelegramMessage(message);
}

export async function sendApplyReport(applied: number, failed: number): Promise<Response> {
  return sendTelegramMessage(`Apply completed. Applied: ${applied}. Failed: ${failed}.`);
}

export async function sendApplySuccessReport(id: number, pageUrl: string, type: string): Promise<Response> {
  const message = `✅ SEO-зміну застосовано\n\nProposal ID: ${id}\nСторінка: ${pageUrl}\nТип: ${type}\nСтатус: очікуємо переіндексацію Google\nМоніторинг: 21 день`;
  return sendTelegramMessage(message);
}

export async function sendApplyFailureReport(id: number, pageUrl: string, reason: string): Promise<Response> {
  const message = `❌ SEO-зміну не застосовано\n\nProposal ID: ${id}\nСторінка: ${pageUrl}\nПричина: ${reason}`;
  return sendTelegramMessage(message);
}

export async function sendTelegramTest(): Promise<Response> {
  const message = `🚀 SEO Agent test\n\nOPENAI: OK\nWordPress: OK\nTelegram: OK`;
  return sendTelegramMessage(message);
}
