import { config } from './config.js';
import { updateProposalStatus } from './db.js';
import { SeoProposal } from './types.js';

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

export async function sendTelegramMessageWithKeyboard(message: string, inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<Response> {
  const response = await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: normalizeText(message),
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
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

export async function sendProposalActionMessage(proposal: SeoProposal): Promise<Response> {
  const id = proposal.id ?? 0;
  const message = [
    '📋 Нова SEO-пропозиція',
    '',
    `ID: ${id}`,
    `Сторінка: ${proposal.pageUrl}`,
    `Тип: ${proposal.type}`,
    `Назва: ${proposal.title}`,
    `Причина: ${proposal.reason}`,
  ].join('\n');

  return sendTelegramMessageWithKeyboard(message, [
    [
      { text: '✅ Застосувати', callback_data: `proposal:apply:${id}` },
      { text: '❌ Відхилити', callback_data: `proposal:reject:${id}` },
    ],
    [
      { text: '🔄 Перегенерувати', callback_data: `proposal:regenerate:${id}` },
      { text: '👁 Деталі', callback_data: `proposal:detail:${id}` },
    ],
  ]);
}

export async function handleProposalCallback(callbackData: string): Promise<string> {
  const [, action, idValue] = callbackData.split(':');
  const id = Number(idValue);
  if (!callbackData.startsWith('proposal:') || Number.isNaN(id)) {
    return 'Unsupported callback payload.';
  }

  if (action === 'reject') {
    await updateProposalStatus(id, 'invalid', 'Rejected from Telegram callback');
    return `Proposal ${id} rejected.`;
  }

  if (action === 'apply') {
    return `Run: npm run dev -- apply ${id}`;
  }

  if (action === 'detail') {
    return `Run: npm run dev -- proposal-detail ${id}`;
  }

  if (action === 'regenerate') {
    await updateProposalStatus(id, 'invalid', 'Regeneration requested from Telegram callback');
    return `Proposal ${id} marked invalid. Run: npm run dev -- proposals`;
  }

  return 'Unsupported proposal action.';
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
