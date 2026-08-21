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

    // Group files by sender — use fromUserId (registered), senderId (anonymous), or session fallback
    const groups = new Map();
    for (const f of fileArr) {
      const key  = f.fromUserId || f.senderId || '__session__';
      const name = f.fromName   || f.senderLabel || 'This Session';
      if (!groups.has(key)) groups.set(key, { name, files: [] });
      groups.get(key).files.push(f);
    }

    function fileCard(f) {
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
        </div>`;
    }

    if (groups.size === 1) {
      // Single sender — flat list as before
      list.className = 'files-list';
      list.innerHTML = [...groups.values()][0].files.map(fileCard).join('');
    } else {
      // Multiple senders — horizontal sliding group cards
      list.className = 'sender-groups';
      list.innerHTML = [...groups.entries()].map(([, g]) => {
        const initial = g.name.charAt(0).toUpperCase();
        return `
          <div class="sender-group">
            <div class="sender-group-header">
              <div class="sender-group-avatar">${initial}</div>
              <span class="sender-group-name">${escHtml(g.name)}</span>
              <span class="sender-group-count">${g.files.length} file${g.files.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="sender-group-files">${g.files.map(fileCard).join('')}</div>
          </div>`;
      }).join('');
    }
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

  function setPrintReady(ready) {
    const btn     = document.getElementById('print-now-btn');
    const label   = document.getElementById('print-now-label');
    const loading = document.getElementById('print-loading');
    const frame   = document.getElementById('print-frame');
    if (btn)     btn.disabled = !ready;
    if (label)   label.textContent = ready ? 'Print' : 'Preparing…';
    if (loading) loading.style.display = ready ? 'none' : 'flex';
    if (frame)   frame.style.visibility = ready ? 'visible' : 'hidden';
  }

  async function printFile(fileId, filename) {
    const modal  = document.getElementById('print-modal');
    const frame  = document.getElementById('print-frame');
    const nameEl = document.getElementById('print-modal-filename');

    // Show the modal in its loading state straight away
    if (nameEl) nameEl.textContent = filename;
    frame._loaded = false;
    setPrintReady(false);
    modal.style.display = 'flex';

    try {
      const res = await fetch(`/api/files/${fileId}/download`);
      if (!res.ok) throw new Error('File not available');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      // Only enable Print once the preview has actually rendered — printing an
      // unloaded frame is what produced blank previews on slower machines.
      frame.onload = () => {
        frame._loaded = true;
        setPrintReady(true);
      };
      // PDFs render in the browser's built-in viewer, which does not always fire
      // load reliably — fall back to enabling Print after a short grace period.
      clearTimeout(frame._readyTimer);
      frame._readyTimer = setTimeout(() => {
        if (!frame._loaded) { frame._loaded = true; setPrintReady(true); }
      }, 2500);

      // For images, wrap in a minimal HTML page so we control the print layout
      if (blob.type.startsWith('image/')) {
        const html = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box;}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${blobUrl}"></body></html>`;
        const htmlBlob = new Blob([html], { type: 'text/html' });
        frame._htmlUrl = URL.createObjectURL(htmlBlob);
        frame.src = frame._htmlUrl;
      } else {
        frame.src = blobUrl;
      }

      frame._blobUrl = blobUrl;
      frame._fileId  = fileId;
    } catch {
      closePrintModal();
      Toast.error('Could not load file for printing.');
    }
  }

  function triggerFramePrint() {
    const frame  = document.getElementById('print-frame');
    const fileId = frame._fileId;
    if (!frame._loaded) { Toast.info('Preview is still loading — one moment.'); return; }

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      window.removeEventListener('afterprint', finish);
      window.removeEventListener('focus', onWindowFocus);
      try { frame.contentWindow.removeEventListener('afterprint', finish); } catch {}
      // Print-only files are never kept — drop it from the list and the server
      if (fileId) discardFile(fileId);
      closePrintModal();
    }
    function onWindowFocus() { setTimeout(finish, 250); }

    // afterprint is the ideal signal but does not fire in every browser for
    // PDF iframes, so also settle when focus returns from the print dialog.
    window.addEventListener('afterprint', finish);
    try { frame.contentWindow.addEventListener('afterprint', finish); } catch {}

    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      settled = true;
      window.removeEventListener('afterprint', finish);
      Toast.error('Print failed — browser blocked it.');
      return;
    }
    setTimeout(() => window.addEventListener('focus', onWindowFocus), 400);
  }

  async function discardFile(fileId) {
    delete files[fileId];
    renderFiles();
    try { await fetch(`/api/files/${fileId}`, { method: 'DELETE' }); } catch {}
  }

  function closePrintModal() {
    const modal = document.getElementById('print-modal');
    const frame = document.getElementById('print-frame');
    modal.style.display = 'none';
    clearTimeout(frame._readyTimer);
    frame.onload = null;
    if (frame._blobUrl) { URL.revokeObjectURL(frame._blobUrl); frame._blobUrl = null; }
    if (frame._htmlUrl) { URL.revokeObjectURL(frame._htmlUrl); frame._htmlUrl = null; }
    frame.src = '';
    frame._fileId = null;
    frame._loaded = false;
    setPrintReady(false);
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

  // Kiosk (paid print) state — only set when the session came from a /k/<uid> QR
  let kioskInfo        = null; // { shopName, pricing, paymentReady }
  let uploadedForPrint = [];   // uploaded files with their detected page counts
  let copies           = 1;
  let colorMode        = 'bw';
  let currentJob       = null;

  // Generate a stable anonymous sender ID for this browser tab
  function getSenderId() {
    let id = sessionStorage.getItem('zb_sender_id');
    if (!id) {
      id = 'anon-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('zb_sender_id', id);
    }
    return id;
  }
  function getSenderLabel() {
    return sessionStorage.getItem('zb_sender_label') || ('Sender ' + getSenderId().slice(5, 9).toUpperCase());
  }

  async function init(sid) {
    const upper = sid.toUpperCase();
    // Session IDs always carry a prefix (ZIP- for QR sessions, DLV- for direct/shop deliveries)
    // that's stripped from the URL, so try each candidate until one resolves.
    const candidates = /^(ZIP|DLV|KSK)-/.test(upper)
      ? [upper]
      : ['ZIP-' + upper, 'DLV-' + upper, 'KSK-' + upper];
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
            // A kiosk QR always means paid printing — skip the Save/Print choice.
            if (data.kind === 'kiosk' && data.kiosk) {
              kioskInfo = data.kiosk;
              purpose = 'print';
              const shopEl = document.getElementById('kiosk-shop-name');
              if (shopEl) shopEl.textContent = kioskInfo.shopName;
              // The kiosk is its own brand at the counter; ZipBeam sits underneath.
              const brandEl = document.getElementById('mobile-brand-name');
              const subEl   = document.getElementById('mobile-brand-sub');
              if (brandEl) brandEl.textContent = 'ATP';
              if (subEl)   subEl.style.display = 'block';
              applyPurposeUI();
              showState('mobile-upload');
              return;
            }
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
    ['mobile-connecting','mobile-invalid','mobile-choice','mobile-upload','mobile-pay','mobile-success'].forEach(s => {
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
    if (kioskInfo) {
      title.textContent = 'Choose Files to Print';
      sub.textContent = `Printing at ${kioskInfo.shopName} — PDFs and images work best`;
    } else if (purpose === 'print') {
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
    formData.append('senderId', getSenderId());
    formData.append('senderLabel', getSenderLabel());
    pendingFiles.forEach(f => formData.append('files', f));

    try {
      const result = await uploadWithProgress(formData, (pct) => {
        pendingFiles.forEach(f => { f._progress = pct; });
        renderPreviews();
      });

      // Kiosk sessions are paid — go to the quote instead of finishing here.
      if (kioskInfo) {
        // The server quotes every file in the session, so accumulate rather than replace.
        uploadedForPrint = uploadedForPrint.concat((result && result.files) || []);
        pendingFiles = [];
        renderPreviews();
        resetSendButton();
        enterPayScreen();
        return;
      }

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

  function resetSendButton() {
    const btn = document.getElementById('send-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Files'; }
  }

  function reset() {
    pendingFiles = [];
    const list = document.getElementById('preview-list');
    if (list) list.innerHTML = '';
    resetSendButton();
    if (kioskInfo) {
      // Start a fresh order at the same shop
      uploadedForPrint = [];
      copies = 1;
      colorMode = 'bw';
      currentJob = null;
      showState('mobile-upload');
      return;
    }
    showState('mobile-choice');
  }

  // ─── Kiosk: quote, adjust, pay ──────────────────────────────────────────────
  function rupees(paise) {
    const hasPaise = paise % 100 !== 0;
    return '₹' + (paise / 100).toLocaleString('en-IN', {
      minimumFractionDigits: hasPaise ? 2 : 0,
      maximumFractionDigits: 2,
    });
  }

  function kioskTotalPages() {
    // Files whose page count could not be read are billed as one page until confirmed.
    return uploadedForPrint.reduce((n, f) => n + (f.pages > 0 ? f.pages : 1), 0);
  }

  function enterPayScreen() {
    copies = 1;
    colorMode = 'bw';
    renderQuote();
    showState('mobile-pay');
  }

  function backToUpload() {
    resetSendButton();
    showState('mobile-upload');
  }

  function setColorMode(mode) {
    colorMode = mode === 'color' ? 'color' : 'bw';
    renderQuote();
  }

  function changeCopies(delta) {
    copies = Math.min(Math.max(copies + delta, 1), 50);
    renderQuote();
  }

  function renderQuote() {
    if (!kioskInfo) return;
    const listEl = document.getElementById('kiosk-file-list');
    if (listEl) {
      listEl.innerHTML = uploadedForPrint.map(f => `
        <div class="kiosk-file">
          <span class="kiosk-file-name">${escHtml(f.name)}</span>
          <span class="kiosk-file-pages">${f.pages > 0 ? f.pages + (f.pages > 1 ? ' pages' : ' page') : 'pages unknown'}</span>
        </div>`).join('');
    }

    const pages  = kioskTotalPages();
    const unit   = colorMode === 'color' ? kioskInfo.pricing.colorPerPage : kioskInfo.pricing.bwPerPage;
    const amount = unit * pages * copies;

    const copiesEl = document.getElementById('kiosk-copies');
    if (copiesEl) copiesEl.textContent = copies;
    const breakdownEl = document.getElementById('kiosk-breakdown');
    if (breakdownEl) {
      breakdownEl.textContent =
        `${pages} page${pages !== 1 ? 's' : ''} × ${copies} cop${copies !== 1 ? 'ies' : 'y'} × ${rupees(unit)}`;
    }
    const amountEl = document.getElementById('kiosk-amount');
    if (amountEl) amountEl.textContent = rupees(amount);

    const bwBtn = document.getElementById('kiosk-bw');
    const clBtn = document.getElementById('kiosk-color');
    if (bwBtn) bwBtn.classList.toggle('active', colorMode === 'bw');
    if (clBtn) clBtn.classList.toggle('active', colorMode === 'color');

    const mockBanner = document.getElementById('kiosk-mock-banner');
    if (mockBanner) mockBanner.style.display = kioskInfo.paymentMode === 'mock' ? 'block' : 'none';

    const warn = document.getElementById('kiosk-warning');
    if (warn) {
      const msgs = [];
      if (uploadedForPrint.some(f => !(f.pages > 0))) {
        msgs.push('We could not read the page count for some files, so they are counted as one page. The shop will confirm before printing.');
      }
      if (!kioskInfo.paymentReady) {
        msgs.push('Online payment is not set up for this shop yet — please pay at the counter.');
      }
      warn.textContent = msgs.join(' ');
      warn.style.display = msgs.length ? 'block' : 'none';
    }

    const payBtn = document.getElementById('kiosk-pay-btn');
    if (payBtn) payBtn.disabled = !kioskInfo.paymentReady;
  }

  function resetPayButton() {
    const btn   = document.getElementById('kiosk-pay-btn');
    const label = document.getElementById('kiosk-pay-label');
    if (btn)   btn.disabled = !(kioskInfo && kioskInfo.paymentReady);
    if (label) label.textContent = 'Pay & Print';
  }

  async function payAndPrint() {
    const btn   = document.getElementById('kiosk-pay-btn');
    const label = document.getElementById('kiosk-pay-label');
    if (btn)   btn.disabled = true;
    if (label) label.textContent = 'Starting payment…';

    try {
      // The server re-prices the job itself — the on-screen figure is display only.
      const jr = await fetch('/api/print-jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, copies, colorMode }),
      });
      const jd = await jr.json();
      if (!jr.ok) throw new Error(jd.error || 'Could not create the print job');
      currentJob = jd.job;

      const or = await fetch(`/api/print-jobs/${currentJob.id}/order`, { method: 'POST' });
      const od = await or.json();
      if (!or.ok) throw new Error(od.error || 'Could not start payment');

      // Mock mode — settle directly, no gateway involved. The server only
      // honours this when it is itself running with PAYMENTS_MODE=mock.
      if (od.mock) {
        if (!confirm(`TEST MODE — no real payment.\n\nSimulate paying ${rupees(od.amount)} and send this job to print?`)) {
          resetPayButton();
          return;
        }
        if (label) label.textContent = 'Confirming…';
        const vr = await fetch(`/api/print-jobs/${currentJob.id}/verify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const vd = await vr.json();
        if (!vr.ok) throw new Error(vd.error || 'Could not complete the test payment');
        onPaid(vd.job);
        return;
      }

      if (typeof Razorpay === 'undefined') throw new Error('Payment library did not load — check your connection');

      const rzp = new Razorpay({
        key: od.keyId,
        amount: od.amount,
        currency: od.currency,
        order_id: od.orderId,
        name: kioskInfo.shopName || 'ZipBeam Print',
        description: `${currentJob.totalPages} page(s) × ${currentJob.copies} copy/copies`,
        theme: { color: '#4F46E5' },
        modal: { ondismiss: resetPayButton },
        handler: async (resp) => {
          try {
            const vr = await fetch(`/api/print-jobs/${currentJob.id}/verify`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(resp),
            });
            const vd = await vr.json();
            if (!vr.ok) throw new Error(vd.error || 'Payment verification failed');
            onPaid(vd.job);
          } catch (e) {
            Toast.error(e.message || 'Payment verification failed');
            resetPayButton();
          }
        },
      });
      rzp.on('payment.failed', (r) => {
        Toast.error((r && r.error && r.error.description) || 'Payment failed');
        resetPayButton();
      });
      rzp.open();
    } catch (e) {
      Toast.error(e.message || 'Could not start payment');
      resetPayButton();
    }
  }

  function onPaid(job) {
    const titleEl = document.getElementById('success-title');
    const textEl  = document.getElementById('success-text');
    if (titleEl) titleEl.textContent = 'Payment Successful! 🎉';
    if (textEl) {
      textEl.textContent =
        `${job.totalPages} page${job.totalPages !== 1 ? 's' : ''} × ${job.copies} cop${job.copies !== 1 ? 'ies' : 'y'} sent to ${kioskInfo.shopName}. Collect your printout at the counter.`;
    }
    const summaryEl = document.getElementById('sent-summary');
    if (summaryEl) {
      summaryEl.innerHTML = job.files
        .map(f => `<div class="sent-file"><span>📄</span><span>${escHtml(f.name)}</span></div>`)
        .join('');
    }
    showState('mobile-success');
    Toast.success('Paid — your job is queued for printing');
  }

  return {
    init, dragOver, dragLeave, drop, onFileSelect, removeFile, send, reset,
    chooseSave, choosePrint, backToChoice,
    backToUpload, setColorMode, changeCopies, payAndPrint,
  };
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

  function toggleBar() {
    const wrap  = document.getElementById('account-bar-wrap');
    const panel = document.getElementById('account-panel');
    const isOpen = !panel.classList.contains('account-panel-collapsed');
    if (isOpen) {
      panel.classList.add('account-panel-collapsed');
      wrap.classList.remove('account-bar-open');
    } else {
      panel.classList.remove('account-panel-collapsed');
      wrap.classList.add('account-bar-open');
    }
  }

  function init(u) {
    user = u;
    const wrap = document.getElementById('account-bar-wrap');
    if (!wrap) return;
    wrap.style.display = 'block';
    const nameEl = document.getElementById('account-bar-name');
    if (nameEl) nameEl.textContent = user.name;
    document.getElementById('my-uid').textContent = user.id;
    const waLink = document.getElementById('my-uid-whatsapp');
    if (waLink) {
      const text = encodeURIComponent(`Send me files on ZipBeam — open this link and scan or upload directly: ${location.origin}/u/${user.id}\n\nOr enter my ZipBeam ID on zipbeam.in: ${user.id}`);
      waLink.href = `https://wa.me/?text=${text}`;
    }
    loadRecentContacts();
    loadPricing();
    loadDevices();
    hydrateInbox();
    connectUserSSE();
  }

  // ─── ATP print rates ────────────────────────────────────────────────────────
  async function loadPricing() {
    try {
      const r = await fetch('/api/shop/pricing');
      if (!r.ok) return;
      const { pricing } = await r.json();
      const bw = document.getElementById('price-bw');
      const cl = document.getElementById('price-color');
      if (bw) bw.value = (pricing.bwPerPage / 100);
      if (cl) cl.value = (pricing.colorPerPage / 100);
    } catch {}
  }

  async function savePricing() {
    const bwEl = document.getElementById('price-bw');
    const clEl = document.getElementById('price-color');
    const status = document.getElementById('price-status');
    const bwRupees = parseFloat(bwEl && bwEl.value);
    const clRupees = parseFloat(clEl && clEl.value);

    if (!Number.isFinite(bwRupees) || bwRupees < 0 || !Number.isFinite(clRupees) || clRupees < 0) {
      if (status) { status.textContent = 'Enter a valid amount for both rates.'; status.className = 'price-status error'; }
      return;
    }
    try {
      // Rupees in the UI, paise on the wire — money stays integer server-side.
      const r = await fetch('/api/shop/pricing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bwPerPage:    Math.round(bwRupees * 100),
          colorPerPage: Math.round(clRupees * 100),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save');
      if (status) { status.textContent = 'Rates saved — new customers see these prices.'; status.className = 'price-status ok'; }
      Toast.success('Print rates updated');
    } catch (e) {
      if (status) { status.textContent = e.message || 'Could not save rates'; status.className = 'price-status error'; }
    }
  }

  // ─── Print agents (paired Raspberry Pis) ────────────────────────────────────
  async function loadDevices() {
    try {
      const r = await fetch('/api/devices');
      if (!r.ok) return;
      const { devices } = await r.json();
      const el = document.getElementById('device-list');
      if (!el) return;
      el.innerHTML = devices.length
        ? devices.map(d => `
            <div class="device-row">
              <span class="device-dot ${d.online ? 'online' : ''}"></span>
              <span class="device-name">${escHtml(d.name)}</span>
              <button class="device-remove" onclick="Account.unpairDevice('${d.id}')" title="Unpair">✕</button>
            </div>`).join('')
        : '<p class="device-empty">No printer paired yet</p>';
    } catch {}
  }

  async function pairDevice() {
    const name = prompt('Name this printer (e.g. "Counter printer")', 'Counter printer');
    if (name === null) return;
    try {
      const r = await fetch('/api/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Print agent' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not pair');
      const box = document.getElementById('device-token-box');
      const tok = document.getElementById('device-token');
      if (tok) tok.textContent = d.device.token;
      if (box) box.style.display = 'block';
      loadDevices();
      Toast.success('Printer paired — copy the token into the Pi');
    } catch (e) { Toast.error(e.message || 'Could not pair printer'); }
  }

  function copyDeviceToken() {
    const tok = document.getElementById('device-token');
    if (!tok) return;
    navigator.clipboard?.writeText(tok.textContent)
      .then(() => Toast.success('Token copied'))
      .catch(() => Toast.show(tok.textContent));
  }

  async function unpairDevice(id) {
    if (!confirm('Unpair this printer? Its agent will stop receiving jobs.')) return;
    try {
      const r = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not unpair');
      loadDevices();
      Toast.success('Printer unpaired');
    } catch (e) { Toast.error(e.message); }
  }

  // Turn a paid job into file rows grouped under one ATP heading.
  function showPaidJob(job) {
    const label = `ATP · ${job.copies} cop${job.copies !== 1 ? 'ies' : 'y'} · ₹${(job.amountPaise / 100).toLocaleString('en-IN')} paid`;
    (job.files || []).forEach(f => Desktop.addExternalFile({
      id: f.fileId,
      name: f.name,
      size: f.size || 0,
      mimetype: f.mimetype || '',
      uploadedAt: job.paidAt || Date.now(),
      purpose: 'print',
      isNew: true,
      senderId: 'atp-' + job.id,
      senderLabel: label,
      copies: job.copies,
    }));
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

  // Renders a QR offscreen, then hands the ready image/canvas to draw().
  function withQrImage(url, size, draw) {
    const wrap = document.getElementById('my-uid-qr-offscreen');
    if (!wrap || typeof QRCode === 'undefined') { Toast.error('QR generator not available'); return; }
    wrap.innerHTML = '';
    new QRCode(wrap, {
      text: url, width: size, height: size,
      colorDark: '#0F172A', colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.H
    });
    // QRCode.js renders asynchronously into a canvas (or an img fallback).
    setTimeout(() => {
      const qrCanvas = wrap.querySelector('canvas');
      const qrImg    = wrap.querySelector('img');
      if (qrCanvas) draw(qrCanvas);
      else if (qrImg) { if (qrImg.complete) draw(qrImg); else qrImg.onload = () => draw(qrImg); }
      else Toast.error('Could not generate QR code');
    }, 300);
  }

  function savePosterPng(canvas, filename, message) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Toast.success(message);
  }

  function downloadMyQr() {
    if (!user) return;
    withQrImage(`${location.origin}/u/${user.id}`, 500, drawPoster);

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
      ctx.fillText(user.name || 'ZipBeam User', W / 2, divY + 60);

      // ZipBeam ID
      ctx.fillStyle = '#4F46E5';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('ID: ' + user.id, W / 2, divY + 86);

      // Safety message — 3 lines, large italic serif
      const safeY = divY + 130;
      ctx.fillStyle = '#1E293B';
      ctx.font = 'italic bold 26px Georgia, serif';
      ctx.fillText('We use ZipBeam to', W / 2, safeY);
      ctx.fillText('ensure your files are', W / 2, safeY + 40);
      ctx.fillText('safe & secure.', W / 2, safeY + 80);

      // Footer on gradient
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '13px sans-serif';
      ctx.fillText('zipbeam.in', W / 2, H - 18);

      savePosterPng(c, `zipbeam-qr-${user.id}.png`, 'QR poster downloaded — print it and display it anywhere');
    }
  }

  // ATP (Any Time Print) counter poster — points at the *paid* kiosk flow.
  function downloadKioskQr() {
    if (!user) return;
    withQrImage(`${location.origin}/k/${user.id}`, 460, drawAtpPoster);

    function drawAtpPoster(qrSource) {
      const W = 700, H = 1080;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');

      // Deep gradient background
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#4F46E5');
      bg.addColorStop(0.55, '#7C3AED');
      bg.addColorStop(1, '#A855F7');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.textAlign = 'center';

      // ATP wordmark
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 78px sans-serif';
      ctx.fillText('ATP', W / 2, 92);

      // Expansion — always visible so the name explains itself
      ctx.font = 'bold 21px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText('A N Y   T I M E   P R I N T', W / 2, 128);

      ctx.font = '16px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText('Print from your phone — no app, no USB, no waiting', W / 2, 162);

      // White card
      const cardX = 36, cardY = 190, cardW = W - 72, cardH = 830;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 34;
      ctx.shadowOffsetY = 8;
      ctx.beginPath();
      roundRect(ctx, cardX, cardY, cardW, cardH, 28);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.restore();

      // Heading
      ctx.fillStyle = '#4F46E5';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('SCAN TO PRINT', W / 2, cardY + 54);

      // QR
      const qrSize = 380, qrX = (W - qrSize) / 2, qrY = cardY + 78;
      ctx.drawImage(qrSource, qrX, qrY, qrSize, qrSize);

      // Steps
      const stepY = qrY + qrSize + 52;
      const steps = ['Scan', 'Choose', 'Pay', 'Collect'];
      const stepW = cardW / steps.length;
      steps.forEach((s, i) => {
        const cx = cardX + stepW * i + stepW / 2;
        ctx.beginPath();
        ctx.arc(cx, stepY, 18, 0, Math.PI * 2);
        ctx.fillStyle = '#4F46E5';
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText(String(i + 1), cx, stepY + 6);
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(s, cx, stepY + 44);
      });

      // Divider
      const divY = stepY + 74;
      ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX + 40, divY); ctx.lineTo(cardX + cardW - 40, divY);
      ctx.stroke();

      // Shop name
      ctx.fillStyle = '#94A3B8';
      ctx.font = '14px sans-serif';
      ctx.fillText('Printing at', W / 2, divY + 32);
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(user.name || 'Print Shop', W / 2, divY + 64);

      // Deliberately no prices printed — rates are shown in the app before
      // paying, so the shop never has to reprint this poster to change them.
      ctx.fillStyle = '#64748B';
      ctx.font = 'italic 14px sans-serif';
      ctx.fillText('Price is shown on your phone before you pay.', W / 2, divY + 94);

      // Footer
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '14px sans-serif';
      ctx.fillText('powered by ZipBeam  ·  zipbeam.in', W / 2, H - 26);

      savePosterPng(c, `atp-kiosk-qr-${user.id}.png`, 'ATP poster downloaded — print it and display it at your counter');
    }
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
      const { files, paidJobs } = await r.json();
      files.forEach(f => Desktop.addExternalFile(f));
      (paidJobs || []).forEach(showPaidJob);
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

    // A customer paid at the ATP kiosk — only now do their files reach the shop.
    userEventSource.addEventListener('print:paid', (e) => {
      const { job } = JSON.parse(e.data);
      showPaidJob(job);
      const amount = '₹' + (job.amountPaise / 100).toLocaleString('en-IN');
      Toast.success(
        `💰 Paid print job — ${job.totalPages} page${job.totalPages !== 1 ? 's' : ''} × ${job.copies} cop${job.copies !== 1 ? 'ies' : 'y'} (${amount})`
      );
    });
  }

  return {
    init, toggleBar, copyMyUid, downloadMyQr, downloadKioskQr, sendToUid, savePricing,
    pairDevice, copyDeviceToken, unpairDevice,
  };
})();

// ─── Router (runs last, after modules defined) ────────────────────────────────
(async function() {
  const p = window.location.pathname;
  const m = p.match(/^\/s\/([A-Z0-9]+)$/i);
  if (m) {
    // Mobile — no auth needed, but signup is available (optional)
    document.getElementById('app-mobile').style.display = 'flex';
    Mobile.init(m[1]);
    Auth.initGoogleButton();
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
