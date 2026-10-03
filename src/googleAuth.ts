import * as vscode from 'vscode';
import {
  buildAuthUrl,
  createPkce,
  emailFromIdToken,
  exchangeCode,
  OAuthError,
  projectFromClientId,
  randomToken,
  refreshAccessToken,
  startLoopback,
} from './util/oauth';

const SESSION_SECRET = 'woyce.googleSession';
const CLIENT_SECRET = 'woyce.googleClientSecret';
const GUIDE_URL = 'https://ai.google.dev/gemini-api/docs/oauth';

interface Session {
  refreshToken: string;
  email?: string;
}

/** "Sign in with Google" for Gemini: OAuth 2.0 with PKCE through a loopback redirect. */
export class GoogleAuth {
  private cache?: { token: string; expiresAt: number };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private get clientId(): string {
    return vscode.workspace.getConfiguration('woyce').get<string>('gemini.oauthClientId', '').trim();
  }

  private async session(): Promise<Session | undefined> {
    const raw = await this.secrets.get(SESSION_SECRET);
    try {
      return raw ? (JSON.parse(raw) as Session) : undefined;
    } catch {
      return undefined;
    }
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.session()) !== undefined;
  }

  async email(): Promise<string | undefined> {
    return (await this.session())?.email;
  }

  /** Runs the browser sign-in. Returns the account email (or '' if Google omitted it), undefined if cancelled. */
  async signIn(): Promise<string | undefined> {
    const client = await this.ensureClient();
    if (!client) {
      return undefined;
    }
    const { verifier, challenge } = createPkce();
    const state = randomToken();
    const loopback = await startLoopback(state);

    try {
      const url = buildAuthUrl({ clientId: client.id, redirectUri: loopback.redirectUri, state, challenge });
      if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
        throw new Error('Could not open the browser for Google sign-in.');
      }
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Woyce: finish signing in with Google in your browser…', cancellable: true },
        (_p, token) =>
          new Promise<string | undefined>((resolve, reject) => {
            token.onCancellationRequested(() => resolve(undefined));
            loopback.code.then(resolve, reject);
          }),
      );
      if (!code) {
        return undefined;
      }
      const tokens = await exchangeCode({
        clientId: client.id,
        clientSecret: client.secret,
        code,
        redirectUri: loopback.redirectUri,
        verifier,
      });
      if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token. Remove Woyce from https://myaccount.google.com/permissions and try again.');
      }
      const email = emailFromIdToken(tokens.id_token);
      await this.secrets.store(SESSION_SECRET, JSON.stringify({ refreshToken: tokens.refresh_token, email } satisfies Session));
      this.cache = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
      this.changed.fire();
      return email ?? '';
    } finally {
      loopback.close();
    }
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SESSION_SECRET);
    this.cache = undefined;
    this.changed.fire();
  }

  /** A valid access token (refreshing if needed) plus the quota project to bill, or undefined when signed out. */
  async getAccessToken(): Promise<{ token: string; project?: string } | undefined> {
    const session = await this.session();
    if (!session) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('woyce');
    const project = cfg.get<string>('gemini.googleProject', '').trim() || projectFromClientId(this.clientId);

    if (this.cache && this.cache.expiresAt - Date.now() > 60_000) {
      return { token: this.cache.token, project };
    }
    const clientSecret = await this.secrets.get(CLIENT_SECRET);
    if (!this.clientId || !clientSecret) {
      return undefined;
    }
    try {
      const t = await refreshAccessToken({ clientId: this.clientId, clientSecret, refreshToken: session.refreshToken });
      this.cache = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
      return { token: t.access_token, project };
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'invalid_grant') {
        await this.signOut();
        throw new Error('Your Google sign-in expired. Run "Woyce: Connect AI Provider…" to sign in again.');
      }
      throw err;
    }
  }

  /** Makes sure an OAuth client ID and secret are configured, prompting for them the first time. */
  private async ensureClient(): Promise<{ id: string; secret: string } | undefined> {
    let id = this.clientId;
    let secret = await this.secrets.get(CLIENT_SECRET);

    if (!id || !secret) {
      const pick = await vscode.window.showInformationMessage(
        'Google sign-in needs a one-time OAuth client of type "Desktop app" from your Google Cloud project (with the Generative Language API enabled and yourself as a test user).',
        { modal: true },
        'Enter Client ID',
        'Open Guide',
      );
      if (pick === 'Open Guide') {
        await vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
        return undefined;
      }
      if (pick !== 'Enter Client ID') {
        return undefined;
      }
      id = (await this.ask('OAuth client ID', 'xxxx-xxxx.apps.googleusercontent.com', false)) ?? '';
      if (!id) {
        return undefined;
      }
      secret = (await this.ask('OAuth client secret', 'GOCSPX-...', true)) ?? '';
      if (!secret) {
        return undefined;
      }
      await vscode.workspace.getConfiguration('woyce').update('gemini.oauthClientId', id, vscode.ConfigurationTarget.Global);
      await this.secrets.store(CLIENT_SECRET, secret);
    }
    return { id, secret };
  }

  private async ask(what: string, placeHolder: string, password: boolean): Promise<string | undefined> {
    const v = await vscode.window.showInputBox({
      title: `Woyce AI: Google ${what}`,
      prompt: password ? 'Stored securely in VS Code SecretStorage.' : undefined,
      placeHolder,
      password,
      ignoreFocusOut: true,
    });
    return v?.trim() || undefined;
  }
}
