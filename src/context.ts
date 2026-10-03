import * as vscode from 'vscode';

export interface EditorContext {
  fileName: string;
  languageId: string;
  selection: string;
}

export type ContextMode = 'auto' | 'file' | 'none';

/** The editor to act on. The chat view has focus when buttons are clicked, so fall back to any visible editor. */
export function getEditor(): vscode.TextEditor | undefined {
  return vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
}

export function describeRange(doc: vscode.TextDocument, range: vscode.Range): EditorContext {
  return {
    fileName: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    selection: doc.getText(range),
  };
}

/** Returns the active editor's selection, or undefined if there is no selection. */
export function getSelectionContext(): EditorContext | undefined {
  const editor = getEditor();
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  return describeRange(editor.document, editor.selection);
}

export function formatContext(ctx: EditorContext): string {
  return `File: ${ctx.fileName}\n\`\`\`${ctx.languageId}\n${ctx.selection}\n\`\`\``;
}

/** Context text to append to a chat message, plus a short label for the UI. */
export function buildChatContext(mode: ContextMode, maxChars: number): { text: string; label: string } | undefined {
  const editor = getEditor();
  if (mode === 'none' || !editor) {
    return undefined;
  }
  const doc = editor.document;
  const name = vscode.workspace.asRelativePath(doc.uri);
  const sel = editor.selection;

  if (mode === 'file') {
    let body = doc.getText();
    let truncated = false;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      truncated = true;
    }
    let text = `File: ${name}${truncated ? ' (truncated)' : ''}\n\`\`\`${doc.languageId}\n${body}\n\`\`\``;
    if (!sel.isEmpty) {
      text += `\n\nSelected lines ${sel.start.line + 1}-${sel.end.line + 1}:\n\`\`\`${doc.languageId}\n${doc.getText(sel)}\n\`\`\``;
    }
    return { text, label: `${name} (${truncated ? 'truncated file' : 'full file'})` };
  }

  if (sel.isEmpty) {
    return undefined;
  }
  return {
    text: formatContext(describeRange(doc, sel)),
    label: `${name} · lines ${sel.start.line + 1}-${sel.end.line + 1}`,
  };
}

export type ChatAction = 'explain' | 'tests';

const ACTION_PROMPTS: Record<ChatAction, string> = {
  explain: 'Explain what this code does, step by step. Mention anything surprising or risky.',
  tests:
    'Write thorough unit tests for this code. Use the testing framework that fits the project if it is apparent, otherwise the idiomatic one for the language. Cover edge cases and error paths. Reply with the tests in one code block.',
};

export const ACTION_DISPLAY: Record<ChatAction, string> = {
  explain: 'Explain this code',
  tests: 'Write unit tests for this code',
};

export function buildActionPrompt(action: ChatAction, ctx: EditorContext): string {
  return `${ACTION_PROMPTS[action]}\n\n${formatContext(ctx)}`;
}
