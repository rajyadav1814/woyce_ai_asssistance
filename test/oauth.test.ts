import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { geminiHeaders } from '../src/providers/gemini';
import {
  buildAuthUrl,
  createPkce,
  emailFromIdToken,
  exchangeCode,
  OAuthError,
  projectFromClientId,
  refreshAccessToken,
  startLoopback,
} from '../src/util/oauth';

describe('oauth helpers', () => {
  it('PKCE challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = createPkce();
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
  });

  it('builds an auth URL with offline access, PKCE and the Gemini scopes', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1', state: 's', challenge: 'c' }));
    assert.equal(u.searchParams.get('client_id'), 'cid');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('scope')!.includes('generative-language'));
  });

  it('derives the project number from the client ID', () => {
    assert.equal(projectFromClientId('123456-abc.apps.googleusercontent.com'), '123456');
    assert.equal(projectFromClientId('nonsense'), undefined);
  });

  it('reads the email from an ID token and tolerates garbage', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@b.com' })).toString('base64url');
    assert.equal(emailFromIdToken(`h.${payload}.s`), 'a@b.com');
    assert.equal(emailFromIdToken('nope'), undefined);
    assert.equal(emailFromIdToken(undefined), undefined);
  });

  it('gemini uses a bearer + quota project when signed in, else the key header', () => {
    assert.deepEqual(geminiHeaders({ apiKey: 'k' })['x-goog-api-key'], 'k');
    const h = geminiHeaders({ apiKey: '', bearer: { token: 't', project: '42' } });
    assert.equal(h.Authorization, 'Bearer t');
    assert.equal(h['x-goog-user-project'], '42');
    assert.equal(h['x-goog-api-key'], undefined);
  });
});

describe('loopback redirect', () => {
  it('resolves with the code when state matches', async () => {
    const lb = await startLoopback('st');
    await fetch(`${lb.redirectUri}/favicon.ico`); // ignored
    const res = await fetch(`${lb.redirectUri}/?code=abc&state=st`);
    assert.equal(res.status, 200);
    assert.equal(await lb.code, 'abc');
  });

  it('rejects on state mismatch and on user denial', async () => {
    const a = await startLoopback('st');
    await fetch(`${a.redirectUri}/?code=abc&state=evil`);
    await assert.rejects(a.code, /state mismatch/);
    const b = await startLoopback('st');
    await fetch(`${b.redirectUri}/?error=access_denied`);
    await assert.rejects(b.code, /access_denied/);
  });

  it('times out', async () => {
    const lb = await startLoopback('st', 20);
    await assert.rejects(lb.code, /timed out/);
  });
});

describe('token endpoint', () => {
  let server: Server;
  let url: string;
  let lastBody = new URLSearchParams();

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastBody = new URLSearchParams(raw);
        res.writeHead(lastBody.get('refresh_token') === 'revoked' ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(
          lastBody.get('refresh_token') === 'revoked'
            ? JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked' })
            : JSON.stringify({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT' }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('exchanges a code with the PKCE verifier', async () => {
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r', verifier: 'v', tokenUrl: url });
    assert.equal(t.access_token, 'AT');
    assert.equal(lastBody.get('grant_type'), 'authorization_code');
    assert.equal(lastBody.get('code_verifier'), 'v');
  });

  it('refreshes, and surfaces invalid_grant with its code', async () => {
    assert.equal((await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'ok', tokenUrl: url })).access_token, 'AT');
    await assert.rejects(
      refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'revoked', tokenUrl: url }),
      (e: unknown) => e instanceof OAuthError && e.code === 'invalid_grant' && /revoked/.test(e.message),
    );
  });
});
