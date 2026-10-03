import * as vscode from 'vscode';
import { GoogleAuth } from './googleAuth';
import {
  ChatMessage,
  isProviderId,
  NotConnectedError,
  Provider,
  PROVIDER_IDS,
  PROVIDERS,
  ProviderId,
  StreamRequest,
} from './providers';

export { ChatMessage, NotConnectedError } from './providers';

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  copilot: '', // empty = first model Copilot offers
};

// The Anthropic secret name predates multi-provider support; keep it so saved keys still work.
const SECRET_NAMES: Record<ProviderId, string> = {
  anthropic: 'woyce.anthropicApiKey',
  openai: 'woyce.openaiApiKey',
  gemini: 'woyce.geminiApiKey',
  copilot: '',
};

const KEY_PROVIDERS = PROVIDER_IDS.filter((id) => PROVIDERS[id].auth === 'key');

export class AiClient {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a key is saved/cleared or an account is signed in/out. */
  readonly onDidChangeCredentials = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly google: GoogleAuth,
  ) {
    google.onDidChange(() => this.changed.fire());
  }

  get activeProvider(): Provider {
    const id = vscode.workspace.getConfiguration('woyce').get<string>('provider');
    return PROVIDERS[isProviderId(id) ? id : 'anthropic'];
  }

  setProvider(id: ProviderId): Thenable<void> {
    return vscode.workspace.getConfiguration('woyce').update('provider', id, vscode.ConfigurationTarget.Global);
  }

  modelFor(provider: Provider): string {
    return (
      vscode.workspace.getConfiguration('woyce').get<string>(`${provider.id}.model`)?.trim() ||
      DEFAULT_MODELS[provider.id]
    );
  }

  /** Short text for the UI, e.g. "ChatGPT (OpenAI) · gpt-4o". */
  describe(): string {
    const p = this.activeProvider;
    return `${p.label} · ${this.modelFor(p) || 'auto'}`;
  }

  getApiKey(provider: Provider): Thenable<string | undefined> {
    return SECRET_NAMES[provider.id] ? this.secrets.get(SECRET_NAMES[provider.id]) : Promise.resolve(undefined);
  }

  /** True if requests to this provider can be attempted (account providers are checked at request time). */
  async isConnected(provider: Provider): Promise<boolean> {
    if (provider.auth === 'account') {
      return true;
    }
    if (await this.getApiKey(provider)) {
      return true;
    }
    return provider.id === 'gemini' && (await this.google.isSignedIn());
  }

  async googleEmail(): Promise<string | undefined> {
    return this.google.email();
  }

  /** Lets the user pick the active provider; returns true if it changed. */
  async selectProvider(): Promise<boolean> {
    const current = this.activeProvider;
    const items = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const p = PROVIDERS[id];
        const model = this.modelFor(p) || 'auto';
        return {
          label: p.label,
          description: (await this.isConnected(p)) ? model : `${model} · not connected`,
          id,
        };
      }),
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'Woyce AI: Select Provider' });
    if (!pick || pick.id === current.id) {
      return false;
    }
    await this.setProvider(pick.id);
    return true;
  }

  /** Prompts for a provider (when not given) and its API key. */
  async setApiKey(provider?: Provider): Promise<Provider | undefined> {
    provider ??= await this.pickKeyProvider('Set API Key for which provider?');
    if (!provider || provider.auth !== 'key') {
      return undefined;
    }
    const key = await vscode.window.showInputBox({
      title: `Woyce AI: ${provider.label} API Key`,
      prompt: 'Stored securely in VS Code SecretStorage.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: provider.keyPlaceholder,
    });
    if (!key?.trim()) {
      return undefined;
    }
    await this.secrets.store(SECRET_NAMES[provider.id], key.trim());
    this.changed.fire();
    return provider;
  }

  async clearApiKey(): Promise<Provider | undefined> {
    const provider = await this.pickKeyProvider('Clear API Key for which provider?');
    if (provider) {
      await this.secrets.delete(SECRET_NAMES[provider.id]);
      this.changed.fire();
    }
    return provider;
  }

  /** Streams a reply from the active provider using the chat system prompt. */
  stream(messages: ChatMessage[], onText: (delta: string) => void, signal: AbortSignal): Promise<string> {
    return this.generate({ messages, onText, signal });
  }

  /**
   * One request to the active provider. `system` defaults to the user's chat system prompt;
   * pass your own (or '') for task-specific calls like code edits and completions.
   */
  async generate(opts: {
    messages: ChatMessage[];
    signal: AbortSignal;
    system?: string;
    maxTokens?: number;
    onText?: (delta: string) => void;
  }): Promise<string> {
    const provider = this.activeProvider;
    const creds = await this.credentialsFor(provider);
    const cfg = vscode.workspace.getConfiguration('woyce');
    return provider.stream({
      ...creds,
      model: this.modelFor(provider),
      maxTokens: opts.maxTokens ?? cfg.get<number>('maxTokens', 4096),
      system: (opts.system ?? cfg.get<string>('systemPrompt')) || undefined,
      baseUrl: cfg.get<string>(`${provider.id}.baseUrl`)?.trim() || undefined,
      messages: opts.messages,
      signal: opts.signal,
      onText: opts.onText ?? (() => {}),
    } satisfies StreamRequest);
  }

  private async credentialsFor(provider: Provider): Promise<Pick<StreamRequest, 'apiKey' | 'bearer'>> {
    if (provider.auth === 'account') {
      return { apiKey: '' };
    }
    const apiKey = await this.getApiKey(provider);
    if (apiKey) {
      return { apiKey };
    }
    if (provider.id === 'gemini') {
      const bearer = await this.google.getAccessToken();
      if (bearer) {
        return { apiKey: '', bearer };
      }
    }
    throw new NotConnectedError(provider.id, `Not connected to ${provider.label}. Run "Woyce: Connect AI Provider…".`);
  }

  private async pickKeyProvider(title: string): Promise<Provider | undefined> {
    const active = this.activeProvider;
    const pick = await vscode.window.showQuickPick(
      KEY_PROVIDERS.map((id) => ({
        label: PROVIDERS[id].label,
        description: id === active.id ? 'active' : undefined,
        id,
      })),
      { title },
    );
    return pick && PROVIDERS[pick.id];
  }
}
