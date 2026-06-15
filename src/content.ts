export const AGENT_START_PREFIX = '<!-- cyfrovahata-seo-agent:start';
export const AGENT_END = '<!-- cyfrovahata-seo-agent:end -->';

function buildMetadata(attributes: Record<string, string | number | boolean>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

export function buildAgentBlock(html: string, metadata: Record<string, string | number | boolean> = {}): string {
  const metaString = buildMetadata(metadata);
  const start = metaString ? `${AGENT_START_PREFIX} ${metaString} -->` : `${AGENT_START_PREFIX} -->`;
  return `${start}\n${html.trim()}\n${AGENT_END}`;
}

export function hasAgentBlock(content: string): boolean {
  return content.includes(AGENT_START_PREFIX) && content.includes(AGENT_END);
}

export function hasAgentBlockForProposal(content: string, proposalId: number | string): boolean {
  const regex = new RegExp(`proposalId="${proposalId}"`, 'g');
  return regex.test(content);
}

export function hasAgentBlockForType(content: string, type: string): boolean {
  const regex = new RegExp(`type="${type}"`, 'g');
  return regex.test(content);
}

export function appendAgentBlock(content: string, html: string, metadata: Record<string, string | number | boolean> = {}): string {
  const block = buildAgentBlock(html, metadata);
  return content.trim() ? `${content.trim()}\n\n${block}` : block;
}

export function updateOrAppendAgentBlock(content: string, html: string): string {
  const block = buildAgentBlock(html);
  const startIndex = content.indexOf(AGENT_START_PREFIX);
  const endIndex = content.indexOf(AGENT_END, startIndex);
  if (startIndex >= 0 && endIndex >= 0) {
    return content.slice(0, startIndex) + block + content.slice(endIndex + AGENT_END.length);
  }
  return appendAgentBlock(content, html);
}

export function mergeHtmlBlocks(existing: string, proposalsHtml: string[]): string {
  const inner = proposalsHtml.filter(Boolean).join('\n\n');
  return updateOrAppendAgentBlock(existing, inner);
}
