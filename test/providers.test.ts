import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseSse } from '../src/providers/http';
import { geminiProvider } from '../src/providers/gemini';
import { openaiProvider } from '../src/providers/openai';
import { StreamRequest } from '../src/providers/types';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      chunks.forEach((x) => c.enqueue(enc.encode(x)));
      c.close();
    },
  });
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseSse', () => {
  it('handles events split across chunks and CRLF', async () => {
    const got = await collect(parseSse(streamOf('data: a\r\n\r\nda', 'ta: b\n\ndata: c\n\n')));
    assert.deepEqual(got, ['a', 'b', 'c']);
  });
  it('joins multi-line data and ignores other fields', async () => {
    const got = await collect(parseSse(streamOf('event: x\ndata: 1\ndata: 2\n\n')));
    assert.deepEqual(got, ['1\n2']);
  });
  it('flushes a final event with no trailing blank line', async () => {
    assert.deepEqual(await collect(parseSse(streamOf('data: last'))), ['last']);
  });
});

describe('providers against a local mock server', () => {
  let server: Server;
  let baseUrl: string;
  let last: { url?: string; headers: IncomingMessage['headers']; body: any };

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        last = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
        if (req.headers.authorization === 'Bearer bad') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Incorrect API key' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (req.url?.includes('chat/completions')) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi ' }] } }] })}\n\n`);
          res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'there' }] } }] })}\n\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
    apiKey: 'k',
    model: 'm',
    maxTokens: 100,
    system: 'be brief',
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
    baseUrl,
    signal: new AbortController().signal,
    onText: () => {},
    ...over,
  });

  it('openai streams text and sends system + history', async () => {
    const deltas: string[] = [];
    const full = await openaiProvider.stream(req({ onText: (d) => deltas.push(d) }));
    assert.equal(full, 'Hello');
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(last.headers.authorization, 'Bearer k');
    assert.equal(last.body.stream, true);
    assert.equal(last.body.max_tokens, 100);
    assert.deepEqual(last.body.messages[0], { role: 'system', content: 'be brief' });
    assert.equal(last.body.messages.length, 4);
  });

  it('openai surfaces API errors', async () => {
    await assert.rejects(openaiProvider.stream(req({ apiKey: 'bad' })), /OpenAI API error 401: Incorrect API key/);
  });

  it('gemini streams text, maps roles and sends the key header', async () => {
    const full = await geminiProvider.stream(req({ model: 'gemini-x' }));
    assert.equal(full, 'Hi there');
    assert.ok(last.url?.startsWith('/models/gemini-x:streamGenerateContent?alt=sse'));
    assert.equal(last.headers['x-goog-api-key'], 'k');
    assert.deepEqual(last.body.contents.map((c: any) => c.role), ['user', 'model', 'user']);
    assert.equal(last.body.systemInstruction.parts[0].text, 'be brief');
    assert.equal(last.body.generationConfig.maxOutputTokens, 100);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(openaiProvider.stream(req({ signal: ac.signal })));
  });
});
