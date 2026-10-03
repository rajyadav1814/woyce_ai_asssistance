import * as vscode from 'vscode';

export interface CodeTarget {
  uri: vscode.Uri;
  range: vscode.Range;
  diagnostics?: vscode.Diagnostic[];
}

/** Lightbulb entries: "Fix with Woyce" on problems, "Edit/Explain with Woyce" on a selection. */
export class WoyceCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
  };

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    if (ctx.diagnostics.length) {
      const fix = new vscode.CodeAction('Fix with Woyce AI', vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [...ctx.diagnostics];
      fix.command = {
        command: 'woyce.fixSelection',
        title: 'Fix with Woyce AI',
        arguments: [{ uri: doc.uri, range, diagnostics: [...ctx.diagnostics] } satisfies CodeTarget],
      };
      actions.push(fix);
    }

    if (!range.isEmpty) {
      const target = [{ uri: doc.uri, range } satisfies CodeTarget];
      const edit = new vscode.CodeAction('Edit with Woyce AI…', vscode.CodeActionKind.RefactorRewrite);
      edit.command = { command: 'woyce.editSelection', title: 'Edit with Woyce AI', arguments: target };
      const explain = new vscode.CodeAction('Explain with Woyce AI', vscode.CodeActionKind.RefactorRewrite);
      explain.command = { command: 'woyce.explainSelection', title: 'Explain with Woyce AI', arguments: target };
      actions.push(edit, explain);
    }
    return actions;
  }
}
