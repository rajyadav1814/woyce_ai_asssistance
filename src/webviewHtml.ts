import * as vscode from 'vscode';

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src data: blob:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Woyce AI</title>
</head>
<body>
  <header>
    <span id="provider" title="Active AI provider and model"></span>
    <button type="button" id="switch" class="secondary">Switch</button>
  </header>
  <div id="messages" role="log" aria-live="polite"></div>
  <form id="composer">
    <div id="attachments" class="attachments" hidden></div>
    <textarea id="input" rows="3" placeholder="Ask Woyce anything… (Enter to send, Shift+Enter for newline)" aria-label="Message"></textarea>
    <div class="actions">
      <label class="ctx">Context
        <select id="context" aria-label="Context to attach">
          <option value="auto">Selection</option>
          <option value="file">Current file</option>
          <option value="project">Whole project</option>
          <option value="none">None</option>
        </select>
      </label>
      <button type="button" id="attach" class="secondary" title="Attach an image (or paste / drag one in)">📎 Image</button>
      <input type="file" id="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <span class="spacer"></span>
      <button type="button" id="stop" hidden>Stop</button>
      <button type="submit" id="send">Send</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
