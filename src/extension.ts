import * as vscode from 'vscode';
import { AiClient } from './aiClient';
import { connectProvider, selectCopilotModel } from './connect';
import { GoogleAuth } from './googleAuth';
import { ChatViewProvider } from './chatViewProvider';
import { CodeTarget, WoyceCodeActionProvider } from './codeActionProvider';
import { ACTION_DISPLAY, buildActionPrompt, ChatAction, describeRange, getEditor } from './context';
import { EditService } from './editService';
import { InlineCompletionProvider, inlineEnabled } from './inlineCompletion';
import { MAX_IMAGE_BYTES, mimeFromPath } from './util/images';
import { EDIT_INSTRUCTIONS, EditKind } from './prompts';

interface Target {
  doc: vscode.TextDocument;
  range: vscode.Range;
  diagnostics: vscode.Diagnostic[];
}

/** Resolves what to act on: the explicit target from a lightbulb, else the editor selection. */
async function resolveTarget(arg: Partial<CodeTarget> | undefined, opts: { expandToLines: boolean }): Promise<Target | undefined> {
  let doc: vscode.TextDocument;
  let range: vscode.Range;
  if (arg?.uri && arg.range) {
    doc = await vscode.workspace.openTextDocument(arg.uri);
    range = arg.range;
  } else {
    const editor = getEditor();
    if (!editor) {
      vscode.window.showInformationMessage('Woyce: open a file first.');
      return undefined;
    }
    doc = editor.document;
    range = editor.selection;
  }

  const diagnostics = (arg?.diagnostics ?? vscode.languages.getDiagnostics(doc.uri)).filter(
    (d) => d.range.intersection(range) !== undefined,
  );

  if (range.isEmpty) {
    if (!opts.expandToLines || !diagnostics.length) {
      vscode.window.showInformationMessage('Woyce: select some code first.');
      return undefined;
    }
    // A lightbulb on a problem with no selection: work on the whole lines the problem covers.
    const start = Math.min(...diagnostics.map((d) => d.range.start.line));
    const end = Math.max(...diagnostics.map((d) => d.range.end.line));
    range = new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character);
  }
  return { doc, range, diagnostics };
}

function describeProblems(diagnostics: vscode.Diagnostic[]): string {
  return diagnostics.map((d) => `- line ${d.range.start.line + 1}: ${d.message}`).join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
  const google = new GoogleAuth(context.secrets);
  const ai = new AiClient(context.secrets, google);
  const edits = new EditService(ai);
  const chat = new ChatViewProvider(context.extensionUri, ai, edits, context.workspaceState);
  const output = vscode.window.createOutputChannel('Woyce AI');

  const explainOrTests = (action: ChatAction) => async (arg?: Partial<CodeTarget>) => {
    const t = await resolveTarget(arg, { expandToLines: false });
    if (!t) return;
    const ctx = describeRange(t.doc, t.range);
    await chat.ask({
      prompt: buildActionPrompt(action, ctx),
      display: ACTION_DISPLAY[action],
      attachment: `${ctx.fileName} · lines ${t.range.start.line + 1}-${t.range.end.line + 1}`,
    });
  };

  const editWith = (kind: EditKind, title: string) => async (arg?: Partial<CodeTarget>) => {
    const t = await resolveTarget(arg, { expandToLines: kind === 'fix' });
    if (!t) return;
    let instruction = EDIT_INSTRUCTIONS[kind];
    if (kind === 'fix' && t.diagnostics.length) {
      instruction += `\nThese problems were reported:\n${describeProblems(t.diagnostics)}`;
    }
    await edits.edit({ doc: t.doc, range: t.range, instruction, title });
  };

  // Inline completion toggle, shown in the status bar.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'woyce.toggleInlineCompletions';
  const refreshStatus = () => {
    status.text = inlineEnabled() ? '$(sparkle) Woyce' : '$(circle-slash) Woyce';
    status.tooltip = `Woyce inline completions: ${inlineEnabled() ? 'on' : 'off'} (click to toggle)`;
    status.show();
  };
  refreshStatus();

  context.subscriptions.push(
    edits,
    output,
    status,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new WoyceCodeActionProvider(), WoyceCodeActionProvider.metadata),
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new InlineCompletionProvider(ai, (m) => output.appendLine(m)),
    ),
    vscode.commands.registerCommand('woyce.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('woyce.focusChat', () => vscode.commands.executeCommand('woyce.chatView.focus')),
    vscode.commands.registerCommand('woyce.explainSelection', explainOrTests('explain')),
    vscode.commands.registerCommand('woyce.generateTests', explainOrTests('tests')),
    vscode.commands.registerCommand('woyce.fixSelection', editWith('fix', 'Fix')),
    vscode.commands.registerCommand('woyce.refactorSelection', editWith('refactor', 'Refactor')),
    vscode.commands.registerCommand('woyce.addDocs', editWith('docs', 'Add docs')),
    vscode.commands.registerCommand('woyce.editSelection', async (arg?: Partial<CodeTarget>) => {
      const t = await resolveTarget(arg, { expandToLines: false });
      if (!t) return;
      const instruction = await vscode.window.showInputBox({
        title: 'Woyce AI: Edit Selection',
        prompt: 'Describe the change (e.g. "convert to async/await", "add input validation")',
        ignoreFocusOut: true,
      });
      if (instruction?.trim()) {
        await edits.edit({ doc: t.doc, range: t.range, instruction: instruction.trim(), title: 'Edit' });
      }
    }),
    vscode.commands.registerCommand('woyce.askAboutImage', async (uri?: vscode.Uri) => {
      uri ??= (
        await vscode.window.showOpenDialog({
          canSelectMany: false,
          title: 'Choose an image for Woyce to analyze',
          filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        })
      )?.[0];
      if (!uri) return;
      const mimeType = mimeFromPath(uri.path);
      if (!mimeType) {
        vscode.window.showWarningMessage('Woyce: supported image types are PNG, JPEG, GIF and WebP.');
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        vscode.window.showWarningMessage(`Woyce: images must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Resize it, or paste it into the chat (which shrinks it automatically).`);
        return;
      }
      const question = await vscode.window.showInputBox({
        title: 'Woyce AI: Ask about this image',
        prompt: 'What do you want to know? Leave empty for a general description.',
        ignoreFocusOut: true,
      });
      if (question === undefined) return;
      const name = vscode.workspace.asRelativePath(uri);
      const prompt = question.trim() || 'Describe this image in detail. If it shows code, a UI, a diagram or an error, explain what matters for the developer.';
      await chat.ask({
        prompt,
        display: question.trim() || 'Describe this image',
        attachment: name,
        images: [{ mimeType, data: Buffer.from(bytes).toString('base64') }],
      });
    }),
    vscode.commands.registerCommand('woyce.toggleInlineCompletions', async () => {
      const cfg = vscode.workspace.getConfiguration('woyce.inline');
      await cfg.update('enabled', !inlineEnabled(), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('woyce.selectProvider', async () => {
      if (await ai.selectProvider()) {
        vscode.window.showInformationMessage(`Woyce: now using ${ai.describe()}.`);
      }
    }),
    vscode.commands.registerCommand('woyce.signIn', () => connectProvider(ai, google)),
    vscode.commands.registerCommand('woyce.signOutGoogle', async () => {
      const email = await ai.googleEmail();
      await google.signOut();
      vscode.window.showInformationMessage(`Woyce: signed out of Google${email ? ` (${email})` : ''}.`);
    }),
    vscode.commands.registerCommand('woyce.selectCopilotModel', selectCopilotModel),
    ai.onDidChangeCredentials(() => void chat.refreshProvider()),
    vscode.commands.registerCommand('woyce.setApiKey', async () => {
      const provider = await ai.setApiKey();
      if (provider) {
        vscode.window.showInformationMessage(`Woyce: ${provider.label} API key saved.`);
      }
    }),
    vscode.commands.registerCommand('woyce.clearApiKey', async () => {
      const provider = await ai.clearApiKey();
      if (provider) {
        vscode.window.showInformationMessage(`Woyce: ${provider.label} API key cleared.`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('woyce')) {
        void chat.refreshProvider();
        refreshStatus();
      }
    }),
  );
}

export function deactivate(): void {}
