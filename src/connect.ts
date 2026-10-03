import * as vscode from 'vscode';
import { AiClient } from './aiClient';
import { GoogleAuth } from './googleAuth';

type Choice = 'copilot' | 'google' | 'key';

/** One entry point for getting connected: account sign-in or API key. */
export async function connectProvider(ai: AiClient, google: GoogleAuth): Promise<void> {
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { id: Choice }>(
    [
      {
        id: 'copilot',
        label: '$(github) Sign in with GitHub Copilot',
        description: 'No API key · GPT, Claude and Gemini models on your Copilot plan (Free works)',
      },
      {
        id: 'google',
        label: '$(account) Sign in with Google',
        description: 'Gemini with your Google account · needs a one-time OAuth client',
      },
      { id: 'key', label: '$(key) Use an API key', description: 'Claude, ChatGPT or Gemini' },
    ],
    { title: 'Woyce AI: Connect a provider', placeHolder: 'How do you want to connect?' },
  );
  if (!pick) {
    return;
  }
  try {
    switch (pick.id) {
      case 'copilot':
        return await signInCopilot(ai);
      case 'google': {
        const email = await google.signIn();
        if (email !== undefined) {
          await ai.setProvider('gemini');
          vscode.window.showInformationMessage(`Woyce: signed in to Google${email ? ` as ${email}` : ''}. Using Gemini.`);
        }
        return;
      }
      case 'key': {
        const provider = await ai.setApiKey();
        if (provider) {
          await ai.setProvider(provider.id);
          vscode.window.showInformationMessage(`Woyce: ${provider.label} API key saved. Using ${provider.label}.`);
        }
        return;
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Woyce: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function signInCopilot(ai: AiClient): Promise<void> {
  try {
    await vscode.authentication.getSession('github', ['user:email'], { createIfNone: true });
  } catch {
    return; // user dismissed the GitHub sign-in
  }

  let models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    // Copilot may not be set up for this account yet; let VS Code run its setup, then look again.
    await Promise.resolve(vscode.commands.executeCommand('workbench.action.chat.triggerSetup')).then(undefined, () => {});
    await new Promise((r) => setTimeout(r, 2000));
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  }
  if (!models.length) {
    const pick = await vscode.window.showWarningMessage(
      'Signed in to GitHub, but no Copilot models are available yet. Enable Copilot Free for your account (or install the "GitHub Copilot Chat" extension), then try again.',
      'Open Copilot Page',
    );
    if (pick) {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/features/copilot'));
    }
    return;
  }
  await ai.setProvider('copilot');
  vscode.window.showInformationMessage(`Woyce: using GitHub Copilot (${models.length} models available). Run "Woyce: Select Copilot Model" to choose one.`);
}

export async function selectCopilotModel(): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    vscode.window.showWarningMessage('Woyce: no Copilot models available. Run "Woyce: Connect AI Provider…" first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [{ label: 'Automatic', description: 'First model Copilot offers', id: '' }, ...models.map((m) => ({ label: m.name, description: `${m.family} · ${m.id}`, id: m.id }))],
    { title: 'Woyce AI: Select Copilot Model' },
  );
  if (pick) {
    await vscode.workspace.getConfiguration('woyce').update('copilot.model', pick.id, vscode.ConfigurationTarget.Global);
  }
}
