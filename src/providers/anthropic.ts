import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, Provider, StreamRequest } from './types';

export function anthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [
            ...m.images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: img.data,
              },
            })),
            { type: 'text' as const, text: m.content },
          ],
        }
      : { role: m.role, content: m.content },
  );
}

export const anthropicProvider: Provider = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  auth: 'key',
  keyPlaceholder: 'sk-ant-...',

  async stream(req: StreamRequest): Promise<string> {
    const client = new Anthropic({ apiKey: req.apiKey, baseURL: req.baseUrl });
    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system || undefined,
        messages: anthropicMessages(req.messages),
      },
      { signal: req.signal },
    );
    let full = '';
    stream.on('text', (delta) => {
      full += delta;
      req.onText(delta);
    });
    await stream.finalMessage();
    return full;
  },
};
