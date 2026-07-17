/* ═══════════════════════════════════════════════════════
   ZipBeam — Frontend Application
   Uses: fetch + EventSource (SSE) — no dependencies needed
════════════════════════════════════════════════════════ */
'use strict';

// ─── Utilities ────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b === 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fileIcon(mime, name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (!mime) mime = '';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf' || ext === 'pdf') return '📄';
  if (mime.includes('zip') || ['zip','rar','7z','tar','gz'].includes(ext)) return '🗜️';
  if (['doc','docx'].includes(ext)) return '📝';
  if (['xls','xlsx'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📑';
  if (['js','ts','py','java','html','css','json'].includes(ext)) return '💻';
  if (['txt','md','csv'].includes(ext)) return '📃';
  return '📎';
}
function fileTypeName(mime, name) {
  const ext = (name || '').split('.').pop().toUpperCase();
  if (!mime) return ext || 'FILE';
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime === 'application/pdf') return 'PDF';
  return ext || 'FILE';
}
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const Toast = {
  show(msg, type = '', icon = '') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.innerHTML = (icon ? `<span>${icon}</span>` : '') + `<span>${msg}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    }, 3500);
  },
  success: (m) => Toast.show(m, 'success', '✅'),
  error:   (m) => Toast.show(m, 'error',   '❌'),
  info:    (m) => Toast.show(m, 'info',     '💡'),
};

// ─── Language Panel — left-side slide-in ribbon for Google Translate ─────────
const LangPanel = (() => {
  function open() {
    const overlay = document.getElementById('lang-panel-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('open'));
  }
  function close() {
    const overlay = document.getElementById('lang-panel-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => { overlay.style.display = 'none'; }, 250);
  }
  return { open, close };
})();

// ─── Desktop Module ───────────────────────────────────────────────────────────
const Desktop = (() => {
  let sessionId = null;
  let eventSource = null;
  let timerInterval = null;
  let timerSec = 30 * 60;
  let files = {};

  async function init() {
    await createSession();
    connectSSE();
    // Ping every 10 min to keep Render free-tier from spinning down
    setInterval(() => fetch('/api/health').catch(() => {}), 10 * 60 * 1000);
  }

  async function createSession() {
    try {
      const r = await fetch('/api/sessions', { method: 'POST' });
      const data = await r.json();
      sessionId = data.sessionId;
      timerSec = Math.floor(Math.max(0, data.expiresAt - Date.now()) / 1000);
      updateSessionUI();
      renderQR();
      startTimer();
      setStatus('waiting');
    } catch (e) {
      Toast.error('Failed to create session. Please refresh.');
    }
  }

  function renderQR() {
    const wrap = document.getElementById('qr-canvas-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const url = `${location.origin}/s/${sessionId.replace('ZIP-','').toLowerCase()}`;
    if (typeof QRCode !== 'undefined') {
      new QRCode(wrap, {
        text: url, width: 200, height: 200,
        colorDark: '#0F172A', colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      wrap.innerHTML = `<div style="width:200px;height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#F1F5F9;border-radius:8px;font-size:12px;color:#64748B;text-align:center;padding:16px;gap:8px"><span style="font-size:28px">📱</span><strong>${sessionId}</strong><span style="font-size:10px;opacity:.7">Scan or use code</span></div>`;
    }
  }

  function updateSessionUI() {
    const el = document.getElementById('desktop-session-code');
    if (el) el.textContent = sessionId;
  }

  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timerSec = Math.max(0, timerSec - 1);
      const m = String(Math.floor(timerSec / 60)).padStart(2, '0');
      const s = String(timerSec % 60).padStart(2, '0');
      const el = document.getElementById('timer-display');
      if (el) el.textContent = `${m}:${s}`;
      if (timerSec === 0) { clearInterval(timerInterval); newSession(); }
    }, 1000);
  }

  function connectSSE() {
    if (eventSource) { eventSource.close(); }
    eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

    eventSource.addEventListener('files:received', (e) => {
      const { files: newFiles } = JSON.parse(e.data);
      setStatus('connected');
      newFiles.forEach(f => addFile({ ...f, isNew: true }));
      Toast.success(`${newFiles.length} file${newFiles.length > 1 ? 's' : ''} received!`);
    });

    eventSource.addEventListener('file:deleted', (e) => {
      const { fileId } = JSON.parse(e.data);
      removeFileFromUI(fileId);
    });

    let sseRecreating = false;
    eventSource.onerror = async () => {
      if (sseRecreating) return;
      sseRecreating = true;
      // Wait briefly for SSE to attempt its own reconnect, then validate session.
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r = await fetch(`/api/sessions/${sessionId}`);
        if (!r.ok) {
          eventSource.close();
          Toast.info('Reconnected — generating new session...');
          await newSession();
        }
      } catch {}
      sseRecreating = false;
    };
  }

  function setStatus(s) {
    const dot  = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const pill  = document.getElementById('connection-pill');
    if (s === 'connected') {
      dot.className = 'status-dot connected';
      label.textContent = 'Device connected';
      pill.className = 'connection-pill connected';
    } else if (s === 'waiting') {
      dot.className = 'status-dot waiting';
      label.textContent = 'Waiting for device…';
      pill.className = 'connection-pill';
    } else {
      dot.className = 'status-dot';
      label.textContent = 'Offline';
      pill.className = 'connection-pill';
    }
  }

  function addFile(file) {
    files[file.id] = { ...file };
    renderFiles();
  }

  function removeFileFromUI(fileId) {
    delete files[fileId];
    renderFiles();
  }

  function renderFiles() {
    const list  = document.getElementById('files-list');
    const empty = document.getElementById('files-empty');
    const badge = document.getElementById('file-badge');
    if (!list || !empty || !badge) return;

    const fileArr = Object.values(files);
    badge.textContent = `${fileArr.length} file${fileArr.length !== 1 ? 's' : ''}`;
    badge.className = fileArr.length > 0 ? 'badge has-files' : 'badge';

    if (fileArr.length === 0) {
      empty.style.display = 'flex'; list.style.display = 'none'; list.innerHTML = ''; return;
    }
    empty.style.display = 'none'; list.style.display = 'flex';

    list.innerHTML = fileArr.map(f => {
      const safeName = escHtml(f.name).replace(/'/g, "\\'");
      let actionBtn;
      if (f.purpose === 'print') {
        actionBtn = f.downloaded
          ? `<button class="btn-dl saved" disabled>✓ Printed</button>`
          : `<button class="btn-dl btn-print" onclick="Desktop.printFile('${f.id}','${safeName}')">🖨️ Print</button>`;
      } else {
        actionBtn = f.downloaded
          ? `<button class="btn-dl saved" disabled>✓ Saved</button>`
          : `<button class="btn-dl" onclick="Desktop.downloadFile('${f.id}','${safeName}')">↓ Download</button>`;
      }
      return `
      <div class="file-item" id="fi-${f.id}">
        <div class="file-icon">${fileIcon(f.mimetype, f.name)}</div>
        <div class="file-info">
          <div class="file-name">${escHtml(f.name)} ${f.isNew ? '<span class="new-tag">New</span>' : ''} ${f.purpose === 'print' ? '<span class="print-tag">Print only</span>' : ''}</div>
          <div class="file-meta">
            <span>${fmtBytes(f.size)}</span>
            <span>${fmtTime(f.uploadedAt)}</span>
            <span class="type-tag">${fileTypeName(f.mimetype, f.name)}</span>
          </div>
        </div>
        ${actionBtn}
      </div>
    `;
    }).join('');
  }

  async function downloadFile(fileId, filename) {
    try {
      const a = document.createElement('a');
      a.href = `/api/files/${fileId}/download`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      if (files[fileId]) files[fileId].downloaded = true;
      renderFiles();
      Toast.success(`Downloading ${filename}`);
    } catch (err) {
      Toast.error('Download failed. Please try again.');
    }
  }

  async function printFile(fileId, filename) {
    try {
      const res = await fetch(`/api/files/${fileId}/download`);
      if (!res.ok) throw new Error('File not available');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      const modal = document.getElementById('print-modal');
      const frame = document.getElementById('print-frame');
      const nameEl = document.getElementById('print-modal-filename');

      // For images, wrap in a minimal HTML page so we control the print layout
      if (blob.type.startsWith('image/')) {
        const html = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box;}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${blobUrl}"></body></html>`;
        const htmlBlob = new Blob([html], { type: 'text/html' });
        frame.src = URL.createObjectURL(htmlBlob);
      } else {
        frame.src = blobUrl;
      }

      frame._blobUrl = blobUrl;
      frame._fileId  = fileId;
      if (nameEl) nameEl.textContent = filename;
      modal.style.display = 'flex';
    } catch {
      Toast.error('Could not load file for printing.');
    }
  }

  function triggerFramePrint() {
    const frame = document.getElementById('print-frame');
    try {
      frame.contentWindow.focus();
      // Wait for the print dialog to close before marking done and cleaning up
      frame.contentWindow.addEventListener('afterprint', function onAfterPrint() {
        frame.contentWindow.removeEventListener('afterprint', onAfterPrint);
        const fileId = frame._fileId;
        if (fileId && files[fileId]) files[fileId].downloaded = true;
        renderFiles();
        closePrintModal();
      }, { once: true });
      frame.contentWindow.print();
    } catch {
      Toast.error('Print failed — browser blocked it.');
    }
  }

  function closePrintModal() {
    const modal = document.getElementById('print-modal');
    const frame = document.getElementById('print-frame');
    modal.style.display = 'none';
    if (frame._blobUrl) { URL.revokeObjectURL(frame._blobUrl); frame._blobUrl = null; }
    frame.src = '';
    frame._fileId = null;
  }

  async function newSession() {
    clearInterval(timerInterval);
    if (eventSource) { eventSource.close(); eventSource = null; }
    files = {};
    renderFiles();
    setStatus('waiting');
    await createSession();
    connectSSE();
    Toast.info('New session created');
  }

  function copyCode() {
    if (!sessionId) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(sessionId).then(() => Toast.success('Code copied!')).catch(() => Toast.show('Code: ' + sessionId));
    } else {
      Toast.show('Code: ' + sessionId);
    }
  }

  return { init, newSession, copyCode, downloadFile, printFile, triggerFramePrint, closePrintModal, addExternalFile: addFile };
})();

// ─── Mobile Module ────────────────────────────────────────────────────────────
const Mobile = (() => {
  let sessionId = null;
  let pendingFiles = [];
  let purpose = 'save'; // 'save' or 'print'

  async function init(sid) {
    const upper = sid.toUpperCase();
    // Session IDs always carry a prefix (ZIP- for QR sessions, DLV- for direct/shop deliveries)
    // that's stripped from the URL, so try each candidate until one resolves.
    const candidates = upper.startsWith('ZIP-') || upper.startsWith('DLV-')
      ? [upper]
      : ['ZIP-' + upper, 'DLV-' + upper];
    showState('mobile-connecting');
    // Retry for up to 20 seconds — gives desktop time to detect reconnect and recreate session
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      for (const candidate of candidates) {
        try {
          const r = await fetch(`/api/sessions/${candidate}`);
          const data = await r.json();
          if (r.ok && data.valid) {
            sessionId = candidate;
            document.getElementById('mobile-session-code').textContent = sessionId;
            document.getElementById('mobile-session-code-choice').textContent = sessionId;
            showState('mobile-choice');
            return;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    showState('mobile-invalid');
  }

  function showState(id) {
    ['mobile-connecting','mobile-invalid','mobile-choice','mobile-upload','mobile-success'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.style.display = (s === id) ? 'flex' : 'none';
    });
  }

  function chooseSave()  { purpose = 'save';  applyPurposeUI(); showState('mobile-upload'); }
  function choosePrint() { purpose = 'print'; applyPurposeUI(); showState('mobile-upload'); }
  function backToChoice() { showState('mobile-choice'); }

  function applyPurposeUI() {
    const title = document.getElementById('upload-title');
    const sub   = document.getElementById('upload-sub');
    if (purpose === 'print') {
      title.textContent = 'Send for Print';
      sub.textContent = 'Select files — they will only be printed, not saved';
    } else {
      title.textContent = 'Save to Computer';
      sub.textContent = 'Select files to transfer to the computer';
    }
  }

  function dragOver(e)  { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); }
  function dragLeave()  { document.getElementById('drop-zone').classList.remove('drag-over'); }
  function drop(e) {
    e.preventDefault();
    document.getElementById('drop-zone').classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
  }
  function onFileSelect(e) { addFiles(Array.from(e.target.files)); e.target.value = ''; }

  function addFiles(newFiles) {
    newFiles.forEach(f => {
      if (!pendingFiles.find(p => p.name === f.name && p.size === f.size)) pendingFiles.push(f);
    });
    renderPreviews();
    const btn = document.getElementById('send-btn');
    if (btn) btn.disabled = pendingFiles.length === 0;
  }

  function removeFile(idx) {
    pendingFiles.splice(idx, 1);
    renderPreviews();
    const btn = document.getElementById('send-btn');
    if (btn) btn.disabled = pendingFiles.length === 0;
  }

  function renderPreviews() {
    const list = document.getElementById('preview-list');
    if (!list) return;
    list.innerHTML = pendingFiles.map((f, i) => `
      <div class="preview-item">
        <div class="preview-thumb">${fileIcon(f.type, f.name)}</div>
        <div class="preview-info">
          <div class="preview-name">${escHtml(f.name)}</div>
          <div class="preview-size">${fmtBytes(f.size)}</div>
          ${(f._progress > 0) ? `<div class="preview-prog"><div class="preview-prog-fill" style="width:${f._progress}%"></div></div>` : ''}
        </div>
        ${(f._progress > 0) ? '' : `<button class="remove-btn" onclick="Mobile.removeFile(${i})">✕</button>`}
      </div>
    `).join('');
  }

  async function send() {
    if (!pendingFiles.length) return;
    const btn = document.getElementById('send-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Sending…'; }

    pendingFiles.forEach(f => { f._progress = 1; });
    renderPreviews();

    const formData = new FormData();
    formData.append('purpose', purpose);
    pendingFiles.forEach(f => formData.append('files', f));

    try {
      const result = await uploadWithProgress(formData, (pct) => {
        pendingFiles.forEach(f => { f._progress = pct; });
        renderPreviews();
      });

      const summary = pendingFiles.map(f =>
        `<div class="sent-file"><span>${fileIcon(f.type, f.name)}</span><span>${escHtml(f.name)} · ${fmtBytes(f.size)}</span></div>`
      ).join('');
      document.getElementById('sent-summary').innerHTML = summary;
      const count = pendingFiles.length;
      pendingFiles = [];
      showState('mobile-success');
      Toast.success(`${count} file${count > 1 ? 's' : ''} sent!`);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Files'; }
      pendingFiles.forEach(f => { f._progress = 0; });
      renderPreviews();
      Toast.error(err.message || 'Upload failed. Please try again.');
    }
  }

  function uploadWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/sessions/${sessionId}/upload`);
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
        } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          reject(new Error(msg));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.send(formData);
    });
  }

  function reset() {
    pendingFiles = [];
    const list = document.getElementById('preview-list');
    if (list) list.innerHTML = '';
    const btn = document.getElementById('send-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Files'; }
    showState('mobile-choice');
  }

  return { init, dragOver, dragLeave, drop, onFileSelect, removeFile, send, reset, chooseSave, choosePrint, backToChoice };
})();

// ─── Auth Module ──────────────────────────────────────────────────────────────
const Auth = (() => {
  let currentUser = null;

  function showTab(tab) {
    document.getElementById('auth-login').style.display  = tab === 'login'  ? 'block' : 'none';
    document.getElementById('auth-signup').style.display = tab === 'signup' ? 'block' : 'none';
    document.getElementById('tab-login').classList.toggle('active',  tab === 'login');
    document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
    document.getElementById('login-error').textContent  = '';
    document.getElementById('signup-error').textContent = '';
  }

  function showOverlay(tab) {
    document.getElementById('auth-overlay').style.display = 'flex';
    showTab(tab || 'login');
  }

  function hideOverlay() {
    document.getElementById('auth-overlay').style.display = 'none';
  }

  function updateNavbar() {
    const el = document.getElementById('nav-user');
    if (!el || !currentUser) return;
    el.innerHTML =
      `<span class="nav-user-name">${escHtml(currentUser.name)}</span>` +
      `<span class="nav-credits" title="Your credits">💎 ${currentUser.credits}</span>` +
      (currentUser.role === 'admin' ? `<a href="/admin" class="btn-ghost" style="font-size:13px">⚙️ Admin</a>` : '') +
      `<button class="btn-ghost" style="font-size:13px" onclick="Auth.logout()">Sign Out</button>`;
    el.style.display = 'flex';
  }

  async function check() {
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) { const d = await r.json(); currentUser = d.user; return true; }
    } catch {}
    return false;
  }

  async function login() {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Please fill in all fields'; return; }
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const d = await r.json();
      if (!r.ok) { errEl.textContent = d.error || 'Login failed'; return; }
      currentUser = d.user;
      hideOverlay();
      updateNavbar();
      document.getElementById('app-desktop').style.display = 'flex';
      Desktop.init();
      Account.init(currentUser);
    } catch { errEl.textContent = 'Network error — please try again'; }
  }

  async function signup() {
    const name     = document.getElementById('signup-name').value.trim();
    const email    = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const errEl    = document.getElementById('signup-error');
    errEl.textContent = '';
    if (!name || !email || !password) { errEl.textContent = 'Please fill in all fields'; return; }
    if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters'; return; }
    try {
      const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) });
      const d = await r.json();
      if (!r.ok) { errEl.textContent = d.error || 'Signup failed'; return; }
      currentUser = d.user;
      hideOverlay();
      updateNavbar();
      document.getElementById('app-desktop').style.display = 'flex';
      Desktop.init();
      Account.init(currentUser);
    } catch { errEl.textContent = 'Network error — please try again'; }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  }

  function initGoogleButton() {
    const clientId = document.querySelector('meta[name="google-client-id"]')?.content;
    if (!clientId || clientId === 'REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID') return; // not configured yet
    const btn = document.getElementById('google-signin-btn');
    const divider = document.getElementById('google-signin-divider');
    if (btn) btn.style.display = 'flex';
    if (divider) divider.style.display = 'flex';
    const tryInit = () => {
      if (typeof google === 'undefined' || !google.accounts) { setTimeout(tryInit, 300); return; }
      google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
    };
    tryInit();
  }

  async function handleGoogleCredential(resp) {
    try {
      const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) });
      const d = await r.json();
      if (!r.ok) { Toast.error(d.error || 'Google sign-in failed'); return; }
      currentUser = d.user;
      hideOverlay();
      updateNavbar();
      document.getElementById('app-desktop').style.display = 'flex';
      Desktop.init();
      Account.init(currentUser);
    } catch { Toast.error('Network error — please try again'); }
  }

  function googleSignIn() {
    if (typeof google === 'undefined' || !google.accounts) { Toast.error('Google Sign-In is still loading — try again in a moment'); return; }
    google.accounts.id.prompt();
  }

  return { check, showTab, showOverlay, hideOverlay, login, signup, logout, initGoogleButton, googleSignIn };
})();

// ─── Account Module — direct user-to-user transfers by ZipBeam ID ─────────────
const Account = (() => {
  let user = null;
  let userEventSource = null;

  function init(u) {
    user = u;
    const panel = document.getElementById('account-panel');
    if (!panel) return;
    panel.style.display = 'block';
    document.getElementById('my-uid').textContent = user.id;
    const waLink = document.getElementById('my-uid-whatsapp');
    if (waLink) {
      const text = encodeURIComponent(`Send me files on ZipBeam — open this link and scan or upload directly: ${location.origin}/u/${user.id}\n\nOr enter my ZipBeam ID on zipbeam.in: ${user.id}`);
      waLink.href = `https://wa.me/?text=${text}`;
    }
    loadRecentContacts();
    hydrateInbox();
    connectUserSSE();
  }

  function copyMyUid() {
    if (!user) return;
    navigator.clipboard?.writeText(user.id).then(() => Toast.success('ZipBeam ID copied!')).catch(() => Toast.show('ID: ' + user.id));
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function downloadMyQr() {
    if (!user) return;
    const wrap = document.getElementById('my-uid-qr-offscreen');
    if (!wrap || typeof QRCode === 'undefined') { Toast.error('QR generator not available'); return; }
    wrap.innerHTML = '';
    const url = `${location.origin}/u/${user.id}`;
    new QRCode(wrap, {
      text: url, width: 500, height: 500,
      colorDark: '#0F172A', colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.H
    });

    function drawPoster(qrSource) {
      const W = 700, H = 1020;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');

      // Full gradient background
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#22D3EE');
      bg.addColorStop(1, '#A855F7');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Logo box
      const logoSize = 72, logoX = W / 2 - 36, logoY = 28;
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, logoX, logoY, logoSize, logoSize, 20);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      const ox = logoX, oy = logoY, sz = logoSize;
      ctx.moveTo(ox+sz*0.56, oy+sz*0.18); ctx.lineTo(ox+sz*0.29, oy+sz*0.53);
      ctx.lineTo(ox+sz*0.50, oy+sz*0.53); ctx.lineTo(ox+sz*0.44, oy+sz*0.82);
      ctx.lineTo(ox+sz*0.79, oy+sz*0.41); ctx.lineTo(ox+sz*0.56, oy+sz*0.41);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      // Wordmark
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ZipBeam', W / 2, logoY + logoSize + 34);

      // White card
      const cardX = 36, cardY = 190, cardW = W - 72, cardH = H - 230;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.18)';
      ctx.shadowBlur = 32;
      ctx.shadowOffsetY = 8;
      ctx.beginPath();
      roundRect(ctx, cardX, cardY, cardW, cardH, 28);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.restore();

      // Heading
      ctx.fillStyle = '#4F46E5';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SCAN & SEND FILES', W / 2, cardY + 52);

      // Subtitle
      ctx.fillStyle = '#64748B';
      ctx.font = '15px sans-serif';
      ctx.fillText('No app  ·  No signup  ·  Instant transfer', W / 2, cardY + 80);

      // QR code
      const qrSize = 400, qrX = (W - qrSize) / 2, qrY = cardY + 104;
      ctx.drawImage(qrSource, qrX, qrY, qrSize, qrSize);

      // Divider
      const divY = qrY + qrSize + 20;
      ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX + 40, divY); ctx.lineTo(cardX + cardW - 40, divY);
      ctx.stroke();

      // "Send files to" label
      ctx.fillStyle = '#94A3B8';
      ctx.font = '14px sans-serif';
      ctx.fillText('Send files to', W / 2, divY + 30);

      // User name
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(user.name || 'ZipBeam User', W / 2, divY + 62);

      // ZipBeam ID
      ctx.fillStyle = '#4F46E5';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('ID: ' + user.id, W / 2, divY + 90);

      // Safety message
      ctx.fillStyle = '#64748B';
      ctx.font = '13px sans-serif';
      ctx.fillText('We use ZipBeam to ensure your files are safe & secure.', W / 2, divY + 118);

      // Footer on gradient
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '13px sans-serif';
      ctx.fillText('zipbeam.in', W / 2, H - 18);

      const dataUrl = c.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `zipbeam-qr-${user.id}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      Toast.success('QR poster downloaded — print it and display it anywhere');
    }

    setTimeout(() => {
      const qrCanvas = wrap.querySelector('canvas');
      const qrImg   = wrap.querySelector('img');
      if (qrCanvas) {
        drawPoster(qrCanvas);
      } else if (qrImg) {
        if (qrImg.complete) {
          drawPoster(qrImg);
        } else {
          qrImg.onload = () => drawPoster(qrImg);
        }
      } else {
        Toast.error('Could not generate QR code');
      }
    }, 300);
  }

  async function loadRecentContacts() {
    try {
      const r = await fetch('/api/contacts/recent');
      if (!r.ok) return;
      const { contacts } = await r.json();
      const wrap = document.getElementById('recent-contacts-wrap');
      const list = document.getElementById('recent-contacts-list');
      if (!wrap || !list) return;
      if (!contacts.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      list.innerHTML = contacts.map(c => `
        <div class="recent-contact-chip">
          <span>${escHtml(c.name)}</span>
          <button onclick="Account.sendToUid('${c.id}')">Send again</button>
        </div>
      `).join('');
    } catch {}
  }

  async function sendToUid(presetUid) {
    const input = document.getElementById('send-to-uid-input');
    const errEl = document.getElementById('send-to-uid-error');
    const toUserId = (presetUid || input?.value || '').trim();
    if (errEl) errEl.textContent = '';
    if (!toUserId) { if (errEl) errEl.textContent = 'Enter a ZipBeam ID first'; return; }
    try {
      const r = await fetch('/api/deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toUserId }) });
      const d = await r.json();
      if (!r.ok) { if (errEl) errEl.textContent = d.error || 'Could not find that ZipBeam ID'; return; }
      window.location.href = `/s/${d.deliveryId.replace('DLV-', '').toLowerCase()}`;
    } catch { if (errEl) errEl.textContent = 'Network error — please try again'; }
  }

  async function hydrateInbox() {
    try {
      const r = await fetch('/api/inbox');
      if (!r.ok) return;
      const { files } = await r.json();
      files.forEach(f => Desktop.addExternalFile(f));
    } catch {}
  }

  function connectUserSSE() {
    if (userEventSource) userEventSource.close();
    userEventSource = new EventSource('/api/users/me/events');
    userEventSource.addEventListener('files:received', (e) => {
      const { files: newFiles, fromName } = JSON.parse(e.data);
      newFiles.forEach(f => Desktop.addExternalFile({ ...f, isNew: true }));
      const who = fromName ? ` from ${fromName}` : '';
      Toast.success(`${newFiles.length} file${newFiles.length > 1 ? 's' : ''} received${who}!`);
      loadRecentContacts();
    });
  }

  return { init, copyMyUid, downloadMyQr, sendToUid };
})();

// ─── Router (runs last, after modules defined) ────────────────────────────────
(async function() {
  const p = window.location.pathname;
  const m = p.match(/^\/s\/([A-Z0-9]+)$/i);
  if (m) {
    // Mobile — no auth needed
    document.getElementById('app-mobile').style.display = 'flex';
    Mobile.init(m[1]);
  } else {
    // Desktop — open access, no login required. Show user info only if logged in.
    const el = document.getElementById('nav-user');
    const loggedIn = await Auth.check();
    if (loggedIn) {
      const u = await fetch('/api/auth/me').then(r => r.json());
      if (el && u.user) {
        el.innerHTML =
          `<span class="nav-user-name">${escHtml(u.user.name)}</span>` +
          `<span class="nav-credits" title="Your credits">💎 ${u.user.credits}</span>` +
          (u.user.role === 'admin' ? `<a href="/admin" class="btn-ghost" style="font-size:13px">⚙️ Admin</a>` : '') +
          `<button class="btn-ghost" style="font-size:13px" onclick="Auth.logout()">Sign Out</button>`;
        el.style.display = 'flex';
      }
      if (u.user) Account.init(u.user);
    } else if (el) {
      el.innerHTML = `<button class="btn-ghost" style="font-size:13px" onclick="Auth.showOverlay('login')">Sign In</button>`;
      el.style.display = 'flex';
    }
    Auth.initGoogleButton();
    document.getElementById('app-desktop').style.display = 'flex';
    Desktop.init();
  }
})();
