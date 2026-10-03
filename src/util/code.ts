/**
 * Pulls code out of a model reply. Takes everything between the first opening fence and the
 * last closing fence (so code that itself contains fences survives); with no fence, the reply is the code.
 */
export function extractCode(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const open = lines.findIndex((l) => /^\s*```/.test(l));
  if (open === -1) {
    return text.replace(/^\n+|\n+$/g, '');
  }
  let close = -1;
  for (let i = lines.length - 1; i > open; i--) {
    if (/^\s*```\s*$/.test(lines[i])) {
      close = i;
      break;
    }
  }
  return lines.slice(open + 1, close === -1 ? undefined : close).join('\n');
}

/** Makes `code` end with a newline only if `original` did, so replacing a selection doesn't add or drop one. */
export function matchTrailingNewline(code: string, original: string): string {
  const trimmed = code.replace(/\n+$/, '');
  return /\n$/.test(original) ? trimmed + '\n' : trimmed;
}

/** Cleans an inline-completion reply: no fences, no echoed cursor marker. */
export function cleanCompletion(reply: string): string {
  let text = reply.includes('```') ? extractCode(reply) : reply;
  text = text.replace(/<CURSOR>/g, '');
  return text.replace(/\s+$/, '');
}
