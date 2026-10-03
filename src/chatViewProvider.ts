import * as vscode from 'vscode';
import { AiClient, ChatMessage, NotConnectedError } from './aiClient';
import { ImageAttachment } from './providers';
import { buildChatContext, buildProjectContext, ContextMode } from './context';
import { EditService } from './editService';
import { offerConnect } from './errors';
import { sanitizeImages } from './util/images';
import { limitImages, trimHistory } from './util/history';
import { getWebviewHtml } from './webviewHtml';

const STATE_KEY = 'woyce.chat';
const MAX_STORED = 200;

/** A message as sent to the model, plus what the UI shows for it. */
interface StoredMessage extends ChatMessage {
  display?: string;
  attachment?: string;
  /** Number of images that were attached; the pixels themselves are not saved across reloads. */
  imageCount?: number;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'selectProvider' }
  | { type: 'connect' }
  | { type: 'send'; text: string; context: ContextMode; images?: unknown }
  | { type: 'stop' }
  | { type: 'regenerate' }
  | { type: 'apply'; code: string; path?: string }
  | { type: 'copy'; code: string };

export interface AskRequest {
  prompt: string;
  /** Short text shown in the chat in place of the full prompt. */
  display: string;
  attachment?: string;
  images?: ImageAttachment[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'woyce.chatView';

  private view?: vscode.WebviewView;
  private history: StoredMessage[];
  private abort?: AbortController;
  private ready: Promise<void> = Promise.resolve();
  private markReady: () => void = () => {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ai: AiClient,
    private readonly edits: EditService,
    private readonly state: vscode.Memento,
  ) {
    this.history = state.get<StoredMessage[]>(STATE_KEY, []);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = getWebviewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.onDidDispose(() => {
      this.abort?.abort();
      this.view = undefined;
    });
  }

  /** Reveals the chat (waiting for it to load) and sends a prompt built by a code action. */
  async ask(req: AskRequest): Promise<void> {
    await vscode.commands.executeCommand('woyce.chatView.focus');
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 3000))]);
    await this.run(
      {
        role: 'user',
        content: req.prompt,
        display: req.display,
        attachment: req.attachment,
        images: req.images,
        imageCount: req.images?.length,
      },
      this.history,
    );
  }

  /** Tells the webview which provider/model is active and whether it still needs connecting. */
  async refreshProvider(): Promise<void> {
    const provider = this.ai.activeProvider;
    this.post({ type: 'provider', label: this.ai.describe() });
    this.post({ type: 'setup', needed: !(await this.ai.isConnected(provider)) });
  }

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.persist();
    this.post({ type: 'cleared' });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.markReady();
        this.post({
          type: 'config',
          defaultContext: vscode.workspace.getConfiguration('woyce').get('defaultContext', 'auto'),
        });
        this.post({ type: 'restore', messages: this.uiMessages() });
        void this.refreshProvider();
        return;
      case 'selectProvider':
        await vscode.commands.executeCommand('woyce.selectProvider');
        return;
      case 'connect':
        await vscode.commands.executeCommand('woyce.signIn');
        return;
      case 'send':
        await this.handleSend(msg.text, msg.context, sanitizeImages(msg.images));
        return;
      case 'stop':
        this.abort?.abort();
        return;
      case 'regenerate':
        await this.regenerate();
        return;
      case 'apply':
        await this.edits.applyFromChat(msg.code, typeof msg.path === 'string' ? msg.path : undefined);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.code);
        vscode.window.setStatusBarMessage('Woyce: copied to clipboard', 2000);
        return;
    }
  }

  private async handleSend(text: string, mode: ContextMode, images: ImageAttachment[]): Promise<void> {
    text = text.trim();
    if (!text && !images.length) {
      return;
    }
    text ||= 'Describe this image in detail. If it shows code, a UI, a diagram or an error, explain what matters for the developer.';
    const maxChars = vscode.workspace.getConfiguration('woyce').get<number>('maxContextChars', 40000);
    const ctx = mode === 'project' ? await buildProjectContext(maxChars) : buildChatContext(mode, maxChars);
    await this.run(
      {
        role: 'user',
        content: ctx ? `${text}\n\n${ctx.text}` : text,
        display: text,
        attachment: ctx?.label,
        images: images.length ? images : undefined,
        imageCount: images.length || undefined,
      },
      this.history,
    );
  }

  /** Drops the last reply and asks again with the same user message. */
  private async regenerate(): Promise<void> {
    const n = this.history.length;
    if (this.abort || n < 2 || this.history[n - 1].role !== 'assistant') {
      return;
    }
    const user = this.history[n - 2];
    this.history = this.history.slice(0, n - 2);
    this.persist();
    this.post({ type: 'restore', messages: this.uiMessages() });
    await this.run(user, this.history);
  }

  private async run(user: StoredMessage, base: StoredMessage[]): Promise<void> {
    if (this.abort) {
      return; // a response is already streaming
    }
    this.post({ type: 'user', text: user.display ?? user.content, attachment: user.attachment, images: user.images });
    this.post({ type: 'start' });

    const turn = limitImages(trimHistory([...base, user])).map(({ role, content, images }) => ({ role, content, images }));
    const abort = new AbortController();
    this.abort = abort;
    let partial = '';
    try {
      const reply = await this.ai.stream(
        turn,
        (delta) => {
          partial += delta;
          this.post({ type: 'chunk', text: delta });
        },
        abort.signal,
      );
      this.commit(base, user, reply);
      this.post({ type: 'done' });
    } catch (err) {
      if (abort.signal.aborted) {
        if (partial) {
          this.commit(base, user, partial); // keep what was streamed before Stop
        }
        this.post({ type: 'done', stopped: true });
      } else {
        const notConnected = err instanceof NotConnectedError;
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err), connect: notConnected });
        if (notConnected) {
          void offerConnect(err);
        }
      }
    } finally {
      this.abort = undefined;
    }
  }

  private commit(base: StoredMessage[], user: StoredMessage, reply: string): void {
    this.history = [...base, user, { role: 'assistant', content: reply }];
    this.persist();
  }

  private persist(): void {
    // Image data is too big for workspace state; keep only how many there were.
    const saved = this.history.slice(-MAX_STORED).map(({ images, ...rest }) => ({ ...rest, imageCount: images?.length ?? rest.imageCount }));
    void this.state.update(STATE_KEY, saved);
  }

  private uiMessages() {
    return this.history.map((m) => ({
      role: m.role,
      text: m.display ?? m.content,
      attachment: m.attachment,
      images: m.images,
      imageCount: m.imageCount,
    }));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}
