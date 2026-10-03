import * as vscode from 'vscode';
import { AiClient } from './aiClient';
import { getEditor } from './context';
import { reportAiError } from './errors';
import { buildEditPrompt, EDIT_SYSTEM } from './prompts';
import { extractCode, matchTrailingNewline } from './util/code';

const PROPOSED_SCHEME = 'woyce-proposed';
const CONTEXT_LINES = 30;

/** Serves the "after" side of the diff preview. */
class ProposedContent implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private counter = 0;

  add(source: vscode.Uri, text: string): vscode.Uri {
    // Keep the real path so the diff gets the right syntax highlighting.
    const uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: source.path, query: String(++this.counter) });
    this.docs.set(uri.toString(), text);
    return uri;
  }

  remove(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

export interface EditRequest {
  doc: vscode.TextDocument;
  range: vscode.Range;
  instruction: string;
  /** Short name for progress and diff titles, e.g. "Fix". */
  title: string;
}

export class EditService implements vscode.Disposable {
  private readonly proposed = new ProposedContent();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.proposed);

  constructor(private readonly ai: AiClient) {}

  dispose(): void {
    this.registration.dispose();
  }

  /** Asks the model to rewrite `range`, then previews and applies the result. */
  async edit(req: EditRequest): Promise<void> {
    const { doc, range } = req;
    const prompt = buildEditPrompt({
      fileName: vscode.workspace.asRelativePath(doc.uri),
      languageId: doc.languageId,
      instruction: req.instruction,
      code: doc.getText(range),
      before: doc.getText(new vscode.Range(Math.max(0, range.start.line - CONTEXT_LINES), 0, range.start.line, range.start.character)),
      after: doc.getText(
        new vscode.Range(range.end, doc.lineAt(Math.min(doc.lineCount - 1, range.end.line + CONTEXT_LINES)).range.end),
      ),
    });

    const reply = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Woyce: ${req.title}…`, cancellable: true },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        try {
          return await this.ai.generate({
            messages: [{ role: 'user', content: prompt }],
            system: EDIT_SYSTEM,
            signal: abort.signal,
          });
        } catch (err) {
          if (!abort.signal.aborted) {
            await reportAiError(err);
          }
          return undefined;
        }
      },
    );
    if (reply === undefined) {
      return;
    }
    const code = extractCode(reply);
    if (!code.trim()) {
      vscode.window.showWarningMessage('Woyce: the model returned no code.');
      return;
    }
    await this.propose(doc, range, code, req.title);
  }

  /** Applies code from a chat block: previews a replacement of the selection, or inserts at the cursor. */
  async applyFromChat(code: string): Promise<void> {
    const editor = getEditor();
    if (!editor) {
      vscode.window.showWarningMessage('Woyce: open a file to apply code to.');
      return;
    }
    if (editor.selection.isEmpty) {
      await editor.edit((b) => b.insert(editor.selection.active, code));
      return;
    }
    await this.propose(editor.document, editor.selection, code, 'Apply');
  }

  private async propose(doc: vscode.TextDocument, range: vscode.Range, newCode: string, title: string): Promise<void> {
    const original = doc.getText(range);
    const code = matchTrailingNewline(newCode, original);
    if (code === original) {
      vscode.window.showInformationMessage('Woyce: no changes suggested.');
      return;
    }

    const version = doc.version;
    const preview = vscode.workspace.getConfiguration('woyce').get<boolean>('edit.preview', true);
    if (preview) {
      const full = doc.getText();
      const proposedText = full.slice(0, doc.offsetAt(range.start)) + code + full.slice(doc.offsetAt(range.end));
      const uri = this.proposed.add(doc.uri, proposedText);
      const name = vscode.workspace.asRelativePath(doc.uri);
      await vscode.commands.executeCommand('vscode.diff', doc.uri, uri, `Woyce ${title}: ${name}`, { preview: true });
      const choice = await vscode.window.showInformationMessage('Apply Woyce’s proposed change?', 'Apply', 'Discard');
      await this.closeDiff(uri);
      this.proposed.remove(uri);
      if (choice !== 'Apply') {
        return;
      }
    }

    if (doc.version !== version) {
      vscode.window.showWarningMessage('Woyce: the file changed while the proposal was open, so it was not applied.');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, code);
    if (!(await vscode.workspace.applyEdit(edit))) {
      vscode.window.showErrorMessage('Woyce: could not apply the change.');
    }
  }

  private async closeDiff(modified: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === modified.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}
