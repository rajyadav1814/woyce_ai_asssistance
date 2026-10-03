import * as vscode from 'vscode';
import { AiClient } from './aiClient';
import { buildCompletionPrompt, COMPLETION_SYSTEM } from './prompts';
import { cleanCompletion } from './util/code';

const PREFIX_LINES = 150;
const SUFFIX_LINES = 60;
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;
const SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('woyce.inline');
}

export function inlineEnabled(): boolean {
  return cfg().get<boolean>('enabled', false);
}

/** Ghost-text completions from the active provider. Off by default because every pause sends a request. */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly ai: AiClient,
    private readonly log: (message: string) => void,
  ) {}

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!inlineEnabled() || !SCHEMES.has(doc.uri.scheme) || ctx.selectedCompletionInfo) {
      return undefined;
    }
    if (!(await this.ai.getApiKey(this.ai.activeProvider))) {
      return undefined; // never nag from a background feature
    }

    await sleep(cfg().get<number>('delay', 500), token);
    if (token.isCancellationRequested) {
      return undefined;
    }

    const prefix = doc
      .getText(new vscode.Range(Math.max(0, pos.line - PREFIX_LINES), 0, pos.line, pos.character))
      .slice(-PREFIX_CHARS);
    const endLine = Math.min(doc.lineCount - 1, pos.line + SUFFIX_LINES);
    const suffix = doc.getText(new vscode.Range(pos, doc.lineAt(endLine).range.end)).slice(0, SUFFIX_CHARS);
    if (!prefix.trim()) {
      return undefined;
    }

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const reply = await this.ai.generate({
        messages: [
          {
            role: 'user',
            content: buildCompletionPrompt(vscode.workspace.asRelativePath(doc.uri), doc.languageId, prefix, suffix),
          },
        ],
        system: COMPLETION_SYSTEM,
        maxTokens: cfg().get<number>('maxTokens', 256),
        signal: abort.signal,
      });
      const text = cleanCompletion(reply);
      if (!text.trim() || token.isCancellationRequested) {
        return undefined;
      }
      return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))];
    } catch (err) {
      if (!abort.signal.aborted) {
        this.log(`Inline completion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    } finally {
      sub.dispose();
    }
  }
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const sub = token.onCancellationRequested(done);
    function done() {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    }
  });
}
