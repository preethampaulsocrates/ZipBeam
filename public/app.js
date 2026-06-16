/* ═══════════════════════════════════════════════════════
   SendThem — Frontend Application
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
    const url = `${location.origin}/s/${sessionId.replace('SWIFT-','').toLowerCase()}`;
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
      empty.style.display = 'flex'; list.style.display = 'none'; return;
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
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (!win) { Toast.error('Please allow pop-ups to print'); return; }

      const triggerPrint = () => { try { win.focus(); win.print(); } catch {} };
      win.addEventListener('load', triggerPrint);
      setTimeout(triggerPrint, 800); // fallback for PDFs that don't fire load reliably

      if (files[fileId]) files[fileId].downloaded = true;
      renderFiles();
      Toast.success(`Opening ${filename} for printing`);
    } catch (err) {
      Toast.error('Could not open file for printing.');
    }
  }

  async function newSession() {
    clearInterval(timerInterval);
    if (eventSource) { eventSource.close(); eventSource = null; }
    files = {};
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

  return { init, newSession, copyCode, downloadFile, printFile };
})();

// ─── Mobile Module ────────────────────────────────────────────────────────────
const Mobile = (() => {
  let sessionId = null;
  let pendingFiles = [];
  let purpose = 'save'; // 'save' or 'print'

  async function init(sid) {
    const upper = sid.toUpperCase();
    sessionId = upper.startsWith('SWIFT-') ? upper : 'SWIFT-' + upper;
    showState('mobile-connecting');
    // Retry for up to 20 seconds — gives desktop time to detect reconnect and recreate session
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`/api/sessions/${sessionId}`);
        const data = await r.json();
        if (r.ok && data.valid) {
          document.getElementById('mobile-session-code').textContent = sessionId;
          document.getElementById('mobile-session-code-choice').textContent = sessionId;
          showState('mobile-choice');
          return;
        }
      } catch {}
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

// ─── Router (runs last, after modules defined) ────────────────────────────────
(function() {
  const p = window.location.pathname;
  const m = p.match(/^\/s\/([A-Z0-9]+)$/i);
  if (m) {
    document.getElementById('app-mobile').style.display = 'flex';
    Mobile.init(m[1]);
  } else {
    document.getElementById('app-desktop').style.display = 'flex';
    Desktop.init();
  }
})();
