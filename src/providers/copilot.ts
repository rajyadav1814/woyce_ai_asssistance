import * as vscode from 'vscode';
import { NotConnectedError, Provider, StreamRequest } from './types';

/** Image support as reported by the model: true/false when known, undefined when VS Code doesn't say. */
function imageSupport(model: vscode.LanguageModelChat): boolean | undefined {
  const caps = (model as { capabilities?: { imageInput?: boolean; supportsImageToText?: boolean } }).capabilities;
  return caps ? Boolean(caps.imageInput ?? caps.supportsImageToText) : undefined;
}

/**
 * Uses the language models VS Code exposes through the user's GitHub Copilot sign-in.
 * No API key: VS Code asks the user for consent the first time, and the plan decides which models exist.
 */
export const copilotProvider: Provider = {
  id: 'copilot',
  label: 'GitHub Copilot (GPT / Claude / Gemini)',
  auth: 'account',
  keyPlaceholder: '',

  async stream(req: StreamRequest): Promise<string> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
      throw new NotConnectedError(
        'copilot',
        'No GitHub Copilot models are available. Sign in to GitHub Copilot (Copilot Free works) via "Woyce: Connect AI Provider…".',
      );
    }

    const hasImages = req.messages.some((m) => m.images?.length);
    const wanted = req.model.trim().toLowerCase();
    // With no model chosen, prefer one that can see images when the conversation has any.
    const model = wanted
      ? models.find((m) => [m.id, m.family, m.name].some((x) => x.toLowerCase() === wanted))
      : ((hasImages && models.find((m) => imageSupport(m) === true)) || models[0]);
    if (!model) {
      throw new Error(`Copilot model "${req.model}" is not available. Run "Woyce: Select Copilot Model".`);
    }
    if (hasImages && imageSupport(model) === false) {
      throw new Error(`${model.name} can't read images. Run "Woyce: Select Copilot Model" and pick one with image support (e.g. a GPT-4o or Claude model).`);
    }

    // The language model API has no system role, so the system prompt rides on the first user message.
    const messages = req.messages.map((m, i) => {
      const text = i === 0 && req.system ? `${req.system}\n\n${m.content}` : m.content;
      if (m.role === 'assistant') {
        return vscode.LanguageModelChatMessage.Assistant(text);
      }
      const images = (m.images ?? []).map((img) => vscode.LanguageModelDataPart.image(Buffer.from(img.data, 'base64'), img.mimeType));
      return vscode.LanguageModelChatMessage.User(images.length ? [new vscode.LanguageModelTextPart(text), ...images] : text);
    });

    const cts = new vscode.CancellationTokenSource();
    if (req.signal.aborted) {
      cts.cancel();
    }
    req.signal.addEventListener('abort', () => cts.cancel(), { once: true });

    let full = '';
    try {
      const response = await model.sendRequest(messages, { justification: 'Woyce AI chat and code assistance' }, cts.token);
      for await (const chunk of response.text) {
        full += chunk;
        req.onText(chunk);
      }
      return full;
    } catch (err) {
      if (err instanceof vscode.LanguageModelError && err.code === vscode.LanguageModelError.NoPermissions.name) {
        throw new NotConnectedError('copilot', 'Woyce was not allowed to use GitHub Copilot models. Run "Woyce: Connect AI Provider…" and allow access.');
      }
      throw err;
    } finally {
      cts.dispose();
    }
  },
};
