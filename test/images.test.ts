import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { anthropicMessages } from '../src/providers/anthropic';
import { geminiProvider, geminiContents } from '../src/providers/gemini';
import { openaiMessages, openaiProvider } from '../src/providers/openai';
import { ChatMessage, StreamRequest } from '../src/providers/types';
import { limitImages } from '../src/util/history';
import { MAX_IMAGES, mimeFromPath, sanitizeImages } from '../src/util/images';

const PNG = 'iVBORw0KGgo=';
const withImage: ChatMessage[] = [
  { role: 'user', content: 'what is this?', images: [{ mimeType: 'image/png', data: PNG }] },
  { role: 'assistant', content: 'a pixel' },
  { role: 'user', content: 'thanks' },
];

describe('sanitizeImages', () => {
  it('keeps valid images and drops bad ones', () => {
    const out = sanitizeImages([
      { mimeType: 'image/png', data: PNG },
      { mimeType: 'image/svg+xml', data: PNG },
      { mimeType: 'image/png', data: 'not base64!!' },
      { mimeType: 'image/png', data: '' },
      null,
      'x',
    ]);
    assert.deepEqual(out, [{ mimeType: 'image/png', data: PNG }]);
  });
  it('rejects oversized images and caps the count', () => {
    assert.equal(sanitizeImages([{ mimeType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) }]).length, 0);
    const many = Array.from({ length: 10 }, () => ({ mimeType: 'image/jpeg', data: PNG }));
    assert.equal(sanitizeImages(many).length, MAX_IMAGES);
    assert.deepEqual(sanitizeImages('nope'), []);
  });
  it('maps file extensions to mime types', () => {
    assert.equal(mimeFromPath('/a/B.JPG'), 'image/jpeg');
    assert.equal(mimeFromPath('x.webp'), 'image/webp');
    assert.equal(mimeFromPath('x.svg'), undefined);
  });
});

describe('limitImages', () => {
  it('keeps images on the newest messages only and notes the rest', () => {
    const m = (n: number): ChatMessage => ({ role: 'user', content: `q${n}`, images: [{ mimeType: 'image/png', data: PNG }] });
    const out = limitImages([m(1), m(2), m(3), m(4)], 2);
    assert.deepEqual(out.map((x) => !!x.images), [false, false, true, true]);
    assert.match(out[0].content, /1 earlier image omitted/);
    assert.equal(out[2].content, 'q3');
  });
});

describe('provider image mapping', () => {
  it('anthropic: image blocks before text, plain strings otherwise', () => {
    const [first, second] = anthropicMessages(withImage) as any[];
    assert.equal(first.content[0].type, 'image');
    assert.deepEqual(first.content[0].source, { type: 'base64', media_type: 'image/png', data: PNG });
    assert.deepEqual(first.content[1], { type: 'text', text: 'what is this?' });
    assert.equal(second.content, 'a pixel');
  });
  it('openai: image_url data URLs and a leading system message', () => {
    const out = openaiMessages(withImage, 'sys') as any[];
    assert.deepEqual(out[0], { role: 'system', content: 'sys' });
    assert.equal(out[1].content[1].image_url.url, `data:image/png;base64,${PNG}`);
    assert.equal(out[2].content, 'a pixel');
  });
  it('gemini: inlineData parts', () => {
    const out = geminiContents(withImage) as any[];
    assert.deepEqual(out[0].parts[0], { inlineData: { mimeType: 'image/png', data: PNG } });
    assert.deepEqual(out[0].parts[1], { text: 'what is this?' });
    assert.equal(out[1].role, 'model');
  });
});

describe('images reach the wire', () => {
  let server: Server;
  let baseUrl: string;
  let body: any;
  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          req.url?.includes('chat/completions')
            ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`
            : `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}\n\n`,
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const req = (): StreamRequest => ({
    apiKey: 'k', model: 'm', maxTokens: 10, messages: withImage, baseUrl,
    signal: new AbortController().signal, onText: () => {},
  });

  it('openai request carries the image', async () => {
    assert.equal(await openaiProvider.stream(req()), 'ok');
    assert.equal(body.messages[0].content[1].type, 'image_url');
  });
  it('gemini request carries the image', async () => {
    assert.equal(await geminiProvider.stream(req()), 'ok');
    assert.equal(body.contents[0].parts[0].inlineData.data, PNG);
  });
});
