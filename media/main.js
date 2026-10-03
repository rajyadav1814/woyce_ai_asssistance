// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const messagesEl = $('messages');
  const form = $('composer');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const switchBtn = $('switch');
  const providerEl = $('provider');
  const contextSel = $('context');
  const attachBtn = $('attach');
  const fileInput = $('file');
  const attachmentsEl = $('attachments');

  const MAX_IMAGES = 4;
  const MAX_EDGE = 1568; // larger images are downscaled; models resize them anyway
  const MAX_BYTES = 3 * 1024 * 1024; // re-encode anything bigger than this
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  /** @type {{ mimeType: string, data: string, url: string }[]} */
  let pending = [];

  const QUICK_ACTIONS = [
    ['Explain this file', 'Explain what this file does and how it is structured.', 'file'],
    ['Find bugs', 'Review this code for bugs and risky patterns. List concrete problems with fixes.', 'auto'],
    ['Write tests', 'Write unit tests for this code.', 'auto'],
    ['Suggest improvements', 'Suggest improvements to readability and performance.', 'auto'],
  ];

  /** @type {{ el: HTMLElement, text: string, msg: HTMLElement } | null} */
  let streaming = null;
  let renderQueued = false;
  let setupNeeded = false;
  let hasMessages = false;

  // ---------- DOM helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }
  function scrollToEnd() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Markdown (DOM-built, so model output can never inject HTML) ----------
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

  function renderInline(parent, text) {
    let last = 0;
    let m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (m[1]) parent.appendChild(el('code', 'inline', tok.slice(1, -1)));
      else if (m[2]) parent.appendChild(el('strong', '', tok.slice(2, -2)));
      else if (m[3]) parent.appendChild(el('em', '', tok.slice(1, -1)));
      else {
        const close = tok.indexOf('](');
        const a = el('a', '', tok.slice(1, close));
        a.href = tok.slice(close + 2, -1);
        a.title = a.href;
        parent.appendChild(a);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderCode(lang, code, closed) {
    const wrap = el('div', 'code');
    const head = el('div', 'code-head');
    head.appendChild(el('span', '', lang || 'code'));
    if (closed) {
      const btns = el('span');
      for (const [label, type] of [['Copy', 'copy'], ['Apply', 'apply']]) {
        const b = el('button', '', label);
        b.type = 'button';
        b.title = type === 'apply' ? 'Replace the selection (with diff preview) or insert at the cursor' : 'Copy to clipboard';
        b.addEventListener('click', () => vscode.postMessage({ type, code }));
        btns.appendChild(b);
      }
      head.appendChild(btns);
    }
    wrap.append(head, el('pre', '', code));
    return wrap;
  }

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function renderMarkdown(container, text) {
    container.textContent = '';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      renderInline(p, para.join('\n'));
      container.appendChild(p);
      para = [];
    };

    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      let m;

      if ((m = line.match(/^\s*```\s*([\w+#.-]*)\s*$/))) {
        flush();
        const code = [];
        let closed = false;
        for (i++; i < lines.length; i++) {
          if (/^\s*```\s*$/.test(lines[i])) { closed = true; i++; break; }
          code.push(lines[i]);
        }
        container.appendChild(renderCode(m[1], code.join('\n'), closed));
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flush();
        const h = el('h' + Math.min(m[1].length + 2, 6));
        renderInline(h, m[2]);
        container.appendChild(h);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        container.appendChild(el('hr'));
        i++;
        continue;
      }
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flush();
        const table = el('table');
        const thead = el('thead');
        const hr = el('tr');
        for (const c of cells(line)) { const th = el('th'); renderInline(th, c); hr.appendChild(th); }
        thead.appendChild(hr);
        const tbody = el('tbody');
        for (i += 2; i < lines.length && isRow(lines[i]); i++) {
          const tr = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); renderInline(td, c); tr.appendChild(td); }
          tbody.appendChild(tr);
        }
        table.append(thead, tbody);
        const scroller = el('div', 'table-wrap');
        scroller.appendChild(table);
        container.appendChild(scroller);
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
        const bq = el('blockquote');
        renderInline(bq, quote.join('\n'));
        container.appendChild(bq);
        continue;
      }
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d/.test(line);
        const list = el(ordered ? 'ol' : 'ul');
        for (; i < lines.length; i++) {
          const li = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!li) break;
          const item = el('li');
          item.style.marginLeft = Math.min(Math.floor(li[1].length / 2), 4) * 16 + 'px';
          renderInline(item, li[3]);
          list.appendChild(item);
        }
        container.appendChild(list);
        continue;
      }
      if (!line.trim()) flush();
      else para.push(line);
      i++;
    }
    flush();
  }

  // ---------- Messages ----------
  function clearEmpty() {
    messagesEl.querySelector('.empty')?.remove();
  }

  function showEmpty() {
    messagesEl.textContent = '';
    const box = el('div', 'empty');
    box.appendChild(el('p', '', 'Ask a question, or pick a starting point:'));
    const row = el('div', 'chips');
    for (const [label, text, context] of QUICK_ACTIONS) {
      const b = el('button', 'chip', label);
      b.type = 'button';
      b.addEventListener('click', () => vscode.postMessage({ type: 'send', text, context }));
      row.appendChild(b);
    }
    box.append(row, el('p', 'hint', 'Tip: select code and right-click → Woyce AI to edit it in place.'));
    if (setupNeeded) box.prepend(setupCard());
    messagesEl.appendChild(box);
  }

  function setupCard() {
    const card = el('div', 'setup');
    card.appendChild(el('strong', '', 'Connect an AI provider'));
    card.appendChild(el('p', '', 'Sign in with GitHub Copilot or Google, or use an API key for Claude, ChatGPT or Gemini.'));
    const b = el('button', '', 'Connect…');
    b.type = 'button';
    b.addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
    card.appendChild(b);
    return card;
  }

  function removeRegenerate() {
    messagesEl.querySelectorAll('.regen').forEach((b) => b.remove());
  }

  function addTools(msg, raw) {
    const tools = el('div', 'tools');
    const copy = el('button', 'link', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', code: raw() }));
    tools.appendChild(copy);
    msg.appendChild(tools);
    return tools;
  }

  function addRegenerate(msg) {
    removeRegenerate();
    const tools = msg.querySelector('.tools');
    if (!tools) return;
    const b = el('button', 'link regen', 'Regenerate');
    b.type = 'button';
    b.addEventListener('click', () => vscode.postMessage({ type: 'regenerate' }));
    tools.appendChild(b);
  }

  /** @returns {{ msg: HTMLElement, body: HTMLElement }} */
  function addMessage(role, text, attachment, images, imageCount) {
    clearEmpty();
    const stick = nearBottom();
    const msg = el('div', 'msg ' + role);
    msg.appendChild(el('div', 'role', role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Woyce'));
    const body = el('div', 'body');
    if (role === 'assistant') renderMarkdown(body, text);
    else body.textContent = text;
    msg.appendChild(body);
    if (images && images.length) {
      const row = el('div', 'thumbs');
      for (const img of images) {
        const t = el('img', 'thumb');
        t.src = 'data:' + img.mimeType + ';base64,' + img.data;
        t.alt = 'Attached image';
        row.appendChild(t);
      }
      msg.appendChild(row);
    } else if (imageCount) {
      msg.appendChild(el('div', 'attachment', '🖼 ' + imageCount + ' image' + (imageCount > 1 ? 's' : '') + ' (not kept after reload)'));
    }
    if (attachment) msg.appendChild(el('div', 'attachment', '📎 ' + attachment));
    messagesEl.appendChild(msg);
    hasMessages = true;
    if (role === 'assistant' && text) addTools(msg, () => text);
    if (stick) scrollToEnd();
    return { msg, body };
  }

  function setBusy(busy) {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    input.disabled = busy;
    if (!busy) input.focus();
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!streaming) return;
      const stick = nearBottom();
      renderMarkdown(streaming.el, streaming.text);
      if (stick) scrollToEnd();
    });
  }

  function finishStream(failed) {
    if (!streaming) return;
    const { el: body, text, msg } = streaming;
    streaming = null;
    if (!text) {
      msg.remove();
    } else if (!failed) {
      renderMarkdown(body, text);
      addTools(msg, () => text);
      addRegenerate(msg);
    }
  }

  // ---------- Image attachments ----------
  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('not an image'));
      img.src = url;
    });
  }

  /** Reads a File into {mimeType, data(base64), url}, downscaling/re-encoding big images. */
  async function prepareImage(file) {
    if (!IMAGE_TYPES.includes(file.type)) throw new Error(file.name + ': unsupported type (use PNG, JPEG, GIF or WebP)');
    let url = await readAsDataUrl(file);
    let mimeType = file.type;
    const img = await loadImage(url);
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if ((long > MAX_EDGE || file.size > MAX_BYTES) && mimeType !== 'image/gif') {
      const scale = Math.min(1, MAX_EDGE / long);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      if (mimeType === 'image/jpeg') { /* no transparency to preserve */ } else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      mimeType = 'image/jpeg';
      url = canvas.toDataURL(mimeType, 0.9);
    }
    return { mimeType, data: url.slice(url.indexOf(',') + 1), url };
  }

  function renderPending() {
    attachmentsEl.textContent = '';
    attachmentsEl.hidden = pending.length === 0;
    pending.forEach((p, i) => {
      const wrap = el('div', 'thumb-wrap');
      const img = el('img', 'thumb');
      img.src = p.url;
      img.alt = 'Attached image ' + (i + 1);
      const x = el('button', 'remove', '×');
      x.type = 'button';
      x.title = 'Remove';
      x.addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
      wrap.append(img, x);
      attachmentsEl.appendChild(wrap);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      if (pending.length >= MAX_IMAGES) { notice('You can attach up to ' + MAX_IMAGES + ' images.'); break; }
      try {
        pending.push(await prepareImage(file));
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e));
      }
    }
    renderPending();
  }

  function notice(text) {
    addMessage('error', text);
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  for (const t of ['dragenter', 'dragover']) form.addEventListener(t, (e) => { e.preventDefault(); form.classList.add('dragging'); });
  for (const t of ['dragleave', 'drop']) form.addEventListener(t, () => form.classList.remove('dragging'));
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  });

  // ---------- Events ----------
  function submit() {
    const text = input.value.trim();
    if (!text && !pending.length) return;
    const images = pending.map(({ mimeType, data }) => ({ mimeType, data }));
    input.value = '';
    pending = [];
    renderPending();
    vscode.postMessage({ type: 'send', text, context: contextSel.value, images });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  switchBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectProvider' }));

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'config':
        contextSel.value = data.defaultContext;
        break;
      case 'provider':
        providerEl.textContent = data.label;
        break;
      case 'setup':
        setupNeeded = data.needed;
        if (!hasMessages) showEmpty();
        break;
      case 'restore': {
        streaming = null;
        messagesEl.textContent = '';
        hasMessages = false;
        if (!data.messages.length) showEmpty();
        let last = null;
        for (const m of data.messages) last = addMessage(m.role, m.text, m.attachment, m.images, m.imageCount).msg;
        if (last && last.classList.contains('assistant')) addRegenerate(last);
        scrollToEnd();
        break;
      }
      case 'cleared':
        streaming = null;
        hasMessages = false;
        setBusy(false);
        showEmpty();
        break;
      case 'user':
        removeRegenerate();
        addMessage('user', data.text, data.attachment, data.images);
        break;
      case 'start': {
        setBusy(true);
        const { msg, body } = addMessage('assistant', '');
        streaming = { el: body, text: '', msg };
        break;
      }
      case 'chunk':
        if (streaming) {
          streaming.text += data.text;
          queueRender();
        }
        break;
      case 'done':
        finishStream(false);
        setBusy(false);
        break;
      case 'error':
        finishStream(true);
        {
          const { msg } = addMessage('error', data.message);
          if (data.connect) {
            const b = el('button', '', 'Connect…');
            b.type = 'button';
            b.addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
            msg.appendChild(b);
          }
        }
        setBusy(false);
        break;
    }
  });

  showEmpty();
  vscode.postMessage({ type: 'ready' });
})();
