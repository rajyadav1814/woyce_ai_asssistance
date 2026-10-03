import * as vscode from 'vscode';
import { formatFileList } from './util/project';

export interface EditorContext {
  fileName: string;
  languageId: string;
  selection: string;
}

export type ContextMode = 'auto' | 'file' | 'project' | 'none';

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

const SKIP_GLOB = '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,.next,target,coverage,.idea}/**';
const SKIP_FILES = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|vsix|woff2?|ttf|eot|mp[34]|mov|lock|map|exe|dll|so|bin)$|package-lock\.json$/i;
const FILE_LIMIT = 500;
const KEY_FILES = ['package.json', 'README.md', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile'];

const PROJECT_GUIDE =
  'You can see the project\'s file list, its key config files and the files open in the editor. ' +
  'If you need a file that is not shown, name it and ask for it instead of guessing its contents.\n' +
  'When you propose a change to a file, start the code block with the path, like ```ts src/app.ts, and give the COMPLETE new contents of that file. ' +
  'The Apply button replaces that file (or creates it if it is new) after a diff preview.';

function fenced(name: string, lang: string, body: string, cap: number): string {
  const truncated = body.length > cap;
  return `File: ${name}${truncated ? ' (truncated)' : ''}\n\`\`\`${lang}\n${truncated ? body.slice(0, cap) : body}\n\`\`\``;
}

/** Workspace overview for project-wide questions: file list, key config files, then the open files, within `maxChars`. */
export async function buildProjectContext(maxChars: number): Promise<{ text: string; label: string } | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return buildChatContext('file', maxChars);
  }
  const root = folders[0];
  const found = await vscode.workspace.findFiles('**/*', SKIP_GLOB, FILE_LIMIT);
  const paths = found.map((u) => vscode.workspace.asRelativePath(u, false)).filter((p) => !SKIP_FILES.test(p));

  const list = formatFileList(paths, Math.floor(maxChars * 0.25));
  const more = found.length >= FILE_LIMIT ? '+' : '';
  const parts = [
    PROJECT_GUIDE,
    `Project: ${root.name} (${paths.length}${more} files${list.shown < paths.length ? `, first ${list.shown} listed` : ''})\n\`\`\`\n${list.text}\n\`\`\``,
  ];
  let remaining = maxChars - parts.join('\n\n').length;
  const included = new Set<string>();
  const include = (name: string, lang: string, body: string, cap: number) => {
    if (included.has(name) || remaining < 500) {
      return;
    }
    const block = fenced(name, lang, body, Math.min(cap, remaining));
    included.add(name);
    parts.push(block);
    remaining -= block.length;
  };

  const editor = getEditor();
  if (editor && editor.document.uri.scheme === 'file') {
    const doc = editor.document;
    include(vscode.workspace.asRelativePath(doc.uri), doc.languageId, doc.getText(), Math.floor(maxChars / 2));
  }
  for (const name of KEY_FILES) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, name));
      include(name, name.split('.').pop() ?? '', Buffer.from(bytes).toString('utf8'), 3000);
    } catch {
      // not in this project
    }
  }
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
      const doc = await vscode.workspace.openTextDocument(tab.input.uri);
      include(vscode.workspace.asRelativePath(doc.uri), doc.languageId, doc.getText(), 6000);
    }
  }
  return { text: parts.join('\n\n'), label: `Project: ${root.name} (${paths.length}${more} files)` };
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
