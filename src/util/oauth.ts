import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GEMINI_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/generative-language.retriever',
  'https://www.googleapis.com/auth/cloud-platform',
];

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE verifier/challenge pair (RFC 7636, S256). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: string[];
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: (p.scopes ?? GEMINI_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent', // makes Google return a refresh token every time
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

/** Google OAuth client IDs start with the Cloud project number, e.g. "123456-abc.apps.googleusercontent.com". */
export function projectFromClientId(clientId: string): string | undefined {
  return clientId.match(/^(\d+)-/)?.[1];
}

/** Reads the email claim from an ID token (display only; the token came straight from Google over TLS). */
export function emailFromIdToken(idToken?: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new OAuthError(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`, json.error);
  }
  return json;
}

export function exchangeCode(o: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
  tokenUrl?: string;
}): Promise<TokenResponse> {
  return postForm(o.tokenUrl ?? GOOGLE_TOKEN_URL, {
    grant_type: 'authorization_code',
    code: o.code,
    client_id: o.clientId,
    client_secret: o.clientSecret,
    redirect_uri: o.redirectUri,
    code_verifier: o.verifier,
  });
}

export function refreshAccessToken(o: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}): Promise<TokenResponse> {
  return postForm(o.tokenUrl ?? GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  });
}

export interface Loopback {
  redirectUri: string;
  /** Resolves with the authorization code once the browser is redirected back. */
  code: Promise<string>;
  close(): void;
}

/** Starts a one-shot HTTP listener on 127.0.0.1 to receive the OAuth redirect. */
export async function startLoopback(expectedState: string, timeoutMs = 5 * 60_000): Promise<Loopback> {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  code.catch(() => {}); // avoid unhandled rejection if nobody is awaiting any more

  const page = (msg: string) =>
    `<!doctype html><meta charset="utf-8"><title>Woyce AI</title><body style="font-family:system-ui;text-align:center;margin-top:20vh"><h2>${msg}</h2><p>You can close this tab and return to VS Code.</p>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    if (!error && !got) {
      res.writeHead(404).end(); // favicon etc.
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (error) {
      res.end(page('Sign-in was cancelled'));
      reject(new OAuthError(`Google sign-in failed: ${error}`, error));
    } else if (url.searchParams.get('state') !== expectedState) {
      res.end(page('Sign-in failed (state mismatch)'));
      reject(new OAuthError('Google sign-in failed: state mismatch'));
    } else {
      res.end(page('Signed in to Woyce AI'));
      resolve(got!);
    }
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => reject(new OAuthError('Google sign-in timed out')), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  void code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${port}`, code, close };
}
