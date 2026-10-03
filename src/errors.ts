import * as vscode from 'vscode';
import { NotConnectedError } from './providers';

/** Offers to connect when a request failed because no credentials are set up. */
export async function offerConnect(err: NotConnectedError): Promise<void> {
  const pick = await vscode.window.showWarningMessage(err.message, 'Connect…');
  if (pick) {
    await vscode.commands.executeCommand('woyce.signIn');
  }
}

export async function reportAiError(err: unknown): Promise<void> {
  if (err instanceof NotConnectedError) {
    await offerConnect(err);
    return;
  }
  vscode.window.showErrorMessage(`Woyce: ${err instanceof Error ? err.message : String(err)}`);
}
