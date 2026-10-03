import { httpError, parseSse } from './http';
import { ChatMessage, Provider, StreamRequest } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Extracts the text delta from one chat.completion.chunk payload. */
export function openaiDelta(data: string): string {
  const json = JSON.parse(data);
  return json.choices?.[0]?.delta?.content ?? '';
}

export function openaiMessages(messages: ChatMessage[], system?: string): unknown[] {
  const mapped = messages.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [
            { type: 'text', text: m.content },
            ...m.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ],
        }
      : { role: m.role, content: m.content },
  );
  return system ? [{ role: 'system', content: system }, ...mapped] : mapped;
}

export const openaiProvider: Provider = {
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  auth: 'key',
  keyPlaceholder: 'sk-...',

  async stream(req: StreamRequest): Promise<string> {
    const baseUrl = (req.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // OpenAI's own models require max_completion_tokens; OpenAI-compatible servers expect max_tokens.
    const limitKey = baseUrl === DEFAULT_BASE_URL ? 'max_completion_tokens' : 'max_tokens';
    const messages = openaiMessages(req.messages, req.system);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({ model: req.model, messages, stream: true, [limitKey]: req.maxTokens }),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw await httpError(res, 'OpenAI');
    }

    let full = '';
    for await (const data of parseSse(res.body)) {
      if (data === '[DONE]') {
        break;
      }
      const delta = openaiDelta(data);
      if (delta) {
        full += delta;
        req.onText(delta);
      }
    }
    return full;
  },
};
