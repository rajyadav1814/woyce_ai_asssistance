# Woyce AI Assistance

A VS Code extension that puts an AI coding assistant in your sidebar. Works with **Claude (Anthropic)**, **ChatGPT (OpenAI)**, **Gemini (Google)** and **GitHub Copilot** models. Connect with an account sign-in or an API key.

## Features

### Chat
- Sidebar chat with streaming replies, **Stop** (keeps what was already written) and **Regenerate**.
- Full markdown: headings, lists, tables, quotes, links and code blocks with **Copy** and **Apply** buttons.
- **Context picker**: attach the current selection, the whole file, the **whole project** (file list, key config files, open files), or nothing.
- Conversation is saved per workspace and survives reloads; **New Chat** clears it.
- Switch provider any time (header button, title bar, or **Woyce: Select AI Provider**).

### Image analysis
Attach up to 4 images (PNG, JPEG, GIF, WebP) to a chat message and ask about them: screenshots of errors or UIs, diagrams, mockups, photos of whiteboards.
- Click **📎 Image** in the chat, **paste** a screenshot into the message box, or **drag and drop** files onto it.
- Or right-click an image in the Explorer → **Ask About Image…** (also in the Command Palette).
- Large images are shrunk automatically before sending. Only the 3 most recent images are resent each turn to keep requests small.
- Image pixels aren't saved across reloads (the chat notes how many there were).
- Works with Claude, ChatGPT (vision models such as `gpt-4o`), Gemini and Copilot models that support images. If you pick a Copilot model without image support, Woyce tells you; **Woyce: Select Copilot Model** lets you choose another.

### Code assistance
Select code and right-click → **Woyce AI**, use the lightbulb, or the Command Palette:

| Action | What happens |
| --- | --- |
| Edit Selection with Instruction… (`Ctrl+Alt+E`) | You describe a change; Woyce rewrites the selection |
| Fix Selection / lightbulb **Fix with Woyce AI** on a problem | Fixes the selection or the lines a diagnostic covers, using the reported error messages |
| Refactor Selection | Cleans up the code, same behavior |
| Add Documentation to Selection | Adds doc comments without touching the code |
| Explain Selection / Generate Tests | Answers in the chat |

Edits open a **diff preview** and only change your file when you click **Apply** (turn this off with `woyce.edit.preview`; undo always works).

### Inline completions (opt-in)
Ghost-text suggestions as you type. Off by default because each pause sends the code around your cursor to your provider. Turn on via the status bar item (`Woyce`, bottom right) or `woyce.inline.enabled`.

API keys, the Google client secret and the Google refresh token live in VS Code SecretStorage, never in settings.

## Connect a provider

Run **Woyce: Connect AI Provider…** (or click **Connect…** in the chat). Choose how:

| Option | What you need | Models |
| --- | --- | --- |
| **Sign in with GitHub Copilot** | A GitHub account. Copilot Free is enough. No API key. | Whatever your Copilot plan offers (GPT, Claude, Gemini…). Pick one with **Woyce: Select Copilot Model**. |
| **Sign in with Google** | A one-time OAuth client (below). Then just your Google account. | Gemini |
| **Use an API key** | A key from [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com/api-keys) or [Google AI Studio](https://aistudio.google.com/apikey) | Claude, ChatGPT or Gemini |

**ChatGPT note:** OpenAI doesn't let other apps sign in with a ChatGPT account, and a ChatGPT Plus plan doesn't include API access. To use OpenAI models, either use an API key (billed separately at platform.openai.com) or pick GPT models through Copilot.

### One-time setup for "Sign in with Google"
1. In [Google Cloud Console](https://console.cloud.google.com), create or pick a project and enable the **Generative Language API**.
2. Configure the **OAuth consent screen** and add your Google account as a **test user**.
3. Create credentials → **OAuth client ID** → application type **Desktop app**.
4. Run **Connect AI Provider… → Sign in with Google** and paste the client ID and secret when asked. A browser window opens for you to approve access. Next time it's just one click.

Requests are billed to that Google project (override with `woyce.gemini.googleProject`). Sign out with **Woyce: Sign Out of Google**. If you have both an API key and a Google sign-in for Gemini, the key is used.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `woyce.provider` | `anthropic` | `anthropic`, `openai`, `gemini` or `copilot` |
| `woyce.copilot.model` | _(auto)_ | Copilot model ID/family/name |
| `woyce.gemini.oauthClientId` | _(empty)_ | OAuth client for Google sign-in (set by the connect flow) |
| `woyce.gemini.googleProject` | _(from client ID)_ | Project billed for Google-sign-in requests |
| `woyce.anthropic.model` | `claude-sonnet-5-5` | Claude model ID |
| `woyce.openai.model` | `gpt-4o` | OpenAI model ID |
| `woyce.openai.baseUrl` | _(empty)_ | OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1` for Ollama |
| `woyce.gemini.model` | `gemini-2.5-flash` | Gemini model ID |
| `woyce.maxTokens` | `4096` | Max tokens per response |
| `woyce.systemPrompt` | coding-assistant prompt | System prompt |
| `woyce.defaultContext` | `auto` | Context attached to chat: `auto` (selection), `file`, `project`, `none` |
| `woyce.maxContextChars` | `40000` | Truncate attached context (a file or the project overview) beyond this size |
| `woyce.edit.preview` | `true` | Show a diff before applying AI edits |
| `woyce.inline.enabled` | `false` | Inline ghost-text completions |
| `woyce.inline.delay` | `500` | Ms to wait after typing before requesting |
| `woyce.inline.maxTokens` | `256` | Max tokens per completion |

Model IDs change over time; if a request fails with "model not found", set the model setting to a current ID.

## Privacy and security

- Woyce has no server of its own and collects no telemetry. Requests go straight from VS Code to the provider you choose (Anthropic, OpenAI, Google, or GitHub Copilot through VS Code).
- What is sent: your chat messages, any selection, file or image you attach, and for code actions the selected code with up to 30 lines around it. Inline completions (off by default) send the code around your cursor after each pause.
- API keys, the Google client secret and the Google refresh token are stored in VS Code SecretStorage, never in settings or files.
- Review each provider's data policy before sending proprietary code.

## Development

```bash
npm install
npm run compile      # type-check + bundle to dist/
npm test             # provider/SSE tests against a local mock server
```

Press **F5** in VS Code to launch an Extension Development Host (runs `npm run watch`).

```bash
npm run vsce:package # produces woyce-ai-assistance-<version>.vsix
code --install-extension woyce-ai-assistance-0.1.0.vsix
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Activation, command wiring |
| `src/chatViewProvider.ts` | Chat webview, saved history, regenerate/stop |
| `src/editService.ts` | AI edits: prompt, progress, diff preview, apply |
| `src/codeActionProvider.ts` | Lightbulb entries |
| `src/inlineCompletion.ts` | Ghost-text completions |
| `src/aiClient.ts` | Active provider, credentials (key / Google / Copilot), `generate()` |
| `src/connect.ts`, `src/googleAuth.ts` | Connect flow, Copilot sign-in, Google OAuth (PKCE, loopback) |
| `src/providers/` | Claude, OpenAI, Gemini and Copilot adapters |
| `src/prompts.ts`, `src/context.ts` | Prompt builders and editor context |
| `src/util/` | Pure helpers (code extraction, history trimming, image validation, OAuth) |
| `media/` | Webview script and styles, logos |
