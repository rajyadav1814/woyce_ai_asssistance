import { ChatMessage } from '../providers/types';

/**
 * Keeps the most recent messages that fit within both limits. The newest message is always kept,
 * and the result always starts with a user message (providers reject conversations that don't).
 */
export function trimHistory<T extends ChatMessage>(messages: T[], maxMessages = 30, maxChars = 80_000): T[] {
  const kept: T[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (kept.length > 0 && (kept.length >= maxMessages || chars + m.content.length > maxChars)) {
      break;
    }
    kept.unshift(m);
    chars += m.content.length;
  }
  while (kept.length > 1 && kept[0].role !== 'user') {
    kept.shift();
  }
  return kept;
}

/**
 * Keeps images only on the newest `keep` messages that have them; older ones are dropped with a note,
 * so a long conversation doesn't resend (and pay for) every screenshot on every turn.
 */
export function limitImages<T extends ChatMessage>(messages: T[], keep = 3): T[] {
  let seen = 0;
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    const m = result[i];
    if (!m.images?.length) {
      continue;
    }
    if (++seen > keep) {
      const n = m.images.length;
      result[i] = { ...m, images: undefined, content: `${m.content}\n\n[${n} earlier image${n > 1 ? 's' : ''} omitted]` };
    }
  }
  return result;
}
