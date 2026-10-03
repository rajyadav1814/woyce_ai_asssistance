/** Yields the `data:` payload of each server-sent event in a response body. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) !== -1) {
        const data = eventData(buf.slice(0, end));
        buf = buf.slice(end + 2);
        if (data !== undefined) {
          yield data;
        }
      }
    }
    const rest = eventData(buf.replace(/\r\n/g, '\n'));
    if (rest !== undefined) {
      yield rest;
    }
  } finally {
    reader.releaseLock();
  }
}

function eventData(block: string): string | undefined {
  const lines = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''));
  return lines.length ? lines.join('\n') : undefined;
}

/** Builds a readable Error from a non-2xx response. */
export async function httpError(res: Response, label: string): Promise<Error> {
  const text = await res.text();
  let message = text;
  try {
    const json = JSON.parse(text);
    message = (Array.isArray(json) ? json[0] : json)?.error?.message ?? text;
  } catch {
    // body was not JSON; use it as-is
  }
  return new Error(`${label} API error ${res.status}: ${message.slice(0, 500)}`);
}
