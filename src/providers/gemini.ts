import { httpError, parseSse } from './http';
import { ChatMessage, Provider, StreamRequest } from './types';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Extracts the text delta from one streamGenerateContent payload. */
export function geminiDelta(data: string): string {
  const json = JSON.parse(data);
  const parts: { text?: string }[] = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

export function geminiHeaders(req: Pick<StreamRequest, 'apiKey' | 'bearer'>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.bearer) {
    headers.Authorization = `Bearer ${req.bearer.token}`;
    if (req.bearer.project) {
      headers['x-goog-user-project'] = req.bearer.project;
    }
  } else {
    headers['x-goog-api-key'] = req.apiKey;
  }
  return headers;
}

export function geminiContents(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(m.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: m.content },
    ],
  }));
}

export const geminiProvider: Provider = {
  id: 'gemini',
  label: 'Gemini (Google)',
  auth: 'key',
  keyPlaceholder: 'AIza...',

  async stream(req: StreamRequest): Promise<string> {
    const baseUrl = (req.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: geminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxTokens },
    };

    const res = await fetch(`${baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: geminiHeaders(req),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw await httpError(res, 'Gemini');
    }

    let full = '';
    for await (const data of parseSse(res.body)) {
      const delta = geminiDelta(data);
      if (delta) {
        full += delta;
        req.onText(delta);
      }
    }
    return full;
  },
};
