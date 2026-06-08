/**
 * SwiftDrop — Zero-dependency Node.js server
 * Uses: http, fs, path, crypto, events (all built-in)
 * Run: node server.js
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT        = process.env.PORT || 3000;
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DATA_DIR    = path.join(__dirname, 'data');
const SESSION_TTL = 30 * 60 * 1000; // 30 min
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });

// ─── In-memory stores ─────────────────────────────────────────────────────────
const sessions   = new Map(); // sessionId → { id, expiresAt, files:[] }
const fileStore  = new Map(); // fileId    → { id, sessionId, name, size, mime, diskPath, uploadedAt }
const sseClients = new Map(); // sessionId → Set of res objects (desktop listeners)

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSessions() {
  try {
    const data = { sessions: [], fileStore: [] };
    for (const sess of sessions.values()) data.sessions.push(sess);
    for (const info of fileStore.values()) data.fileStore.push(info);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data));
  } catch {}
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const sess of (data.sessions || [])) {
      if (now < sess.expiresAt) sessions.set(sess.id, sess);
    }
    for (const info of (data.fileStore || [])) {
      if (sessions.has(info.sessionId) && fs.existsSync(info.diskPath)) {
        fileStore.set(info.id, info);
      }
    }
  } catch {}
}

loadSessions();

// ─── Cleanup expired sessions every 5 min ────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, sess] of sessions) {
    if (now > sess.expiresAt) {
      for (const fid of sess.files) deleteFile(fid);
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) saveSessions();
}, 5 * 60 * 1000);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function genSessionId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'SWIFT-';
  for (let i = 0; i < 6; i++) id += chars[crypto.randomInt(chars.length)];
  return id;
}

function deleteFile(fileId) {
  const info = fileStore.get(fileId);
  if (!info) return;
  try { fs.unlinkSync(info.diskPath); } catch {}
  fileStore.delete(fileId);
  const sess = sessions.get(info.sessionId);
  if (sess) sess.files = sess.files.filter(id => id !== fileId);
  saveSessions();
}

function sseEmit(sessionId, event, data) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Multipart parser (handles file uploads without multer) ─────────────────
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const files = [];
  let pos = 0;

  while (pos < buffer.length) {
    const boundaryIdx = buffer.indexOf(boundaryBuf, pos);
    if (boundaryIdx === -1) break;
    pos = boundaryIdx + boundaryBuf.length;

    // Check for final boundary
    if (buffer[pos] === 0x2D && buffer[pos + 1] === 0x2D) break;

    // Skip CRLF after boundary
    if (buffer[pos] === 0x0D && buffer[pos + 1] === 0x0A) pos += 2;

    // Read headers
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;

    // Find content-disposition
    const cdMatch = headerStr.match(/content-disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);
    if (!cdMatch) continue; // skip non-file fields

    const filename = cdMatch[1];
    const mime     = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

    // Find end of this part
    const endBoundary = buffer.indexOf('\r\n' + '--' + boundary, pos);
    if (endBoundary === -1) break;

    const content = buffer.slice(pos, endBoundary);
    pos = endBoundary;

    files.push({ filename, mime, content });
  }
  return files;
}

// ─── Static file server ───────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json',
};

function serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  // Prevent browsers from caching JS/HTML so deploys take effect immediately
  const noCache = ext === '.js' || ext === '.html';
  try {
    const data = fs.readFileSync(filePath);
    const headers = { 'Content-Type': mime };
    if (noCache) headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
}

// ─── Rate limiting (simple in-memory) ────────────────────────────────────────
const rateMap = new Map();
function checkRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    rateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method   = req.method.toUpperCase();
  const ip       = req.socket.remoteAddress || 'unknown';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── API: Health ──
  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { status: 'ok', sessions: sessions.size, uptime: process.uptime() });
  }

  // ── API: Create session ──
  if (method === 'POST' && pathname === '/api/sessions') {
    if (!checkRateLimit(ip, 30, 60000)) return json(res, 429, { error: 'Too many requests' });
    const sessionId = genSessionId();
    const expiresAt = Date.now() + SESSION_TTL;
    sessions.set(sessionId, { id: sessionId, expiresAt, files: [] });
    saveSessions();
    return json(res, 200, { sessionId, expiresAt });
  }

  // ── API: Validate session ──
  const sessMatch = pathname.match(/^\/api\/sessions\/([A-Z0-9-]+)$/i);
  if (method === 'GET' && sessMatch) {
    const sid = sessMatch[1].toUpperCase();
    const sess = sessions.get(sid);
    if (!sess) return json(res, 404, { error: 'Session not found' });
    if (Date.now() > sess.expiresAt) { sessions.delete(sid); return json(res, 410, { error: 'Session expired' }); }
    return json(res, 200, { valid: true, expiresAt: sess.expiresAt, fileCount: sess.files.length });
  }

  // ── API: Upload files ──
  const uploadMatch = pathname.match(/^\/api\/sessions\/([A-Z0-9-]+)\/upload$/i);
  if (method === 'POST' && uploadMatch) {
    if (!checkRateLimit(ip, 20, 60000)) return json(res, 429, { error: 'Too many requests' });

    const sid  = uploadMatch[1].toUpperCase();
    const sess = sessions.get(sid);
    if (!sess) return json(res, 404, { error: 'Session not found' });
    if (Date.now() > sess.expiresAt) return json(res, 410, { error: 'Session expired' });

    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return json(res, 400, { error: 'No boundary in content-type' });

    const body = await readBody(req);
    const parts = parseMultipart(body, boundaryMatch[1]);

    if (parts.length === 0) return json(res, 400, { error: 'No files found' });

    const BLOCKED_EXTS = ['.exe','.bat','.cmd','.sh','.ps1','.msi','.dll','.vbs','.js','.jar'];
    const uploadedFiles = [];
    const sessDir = path.join(UPLOAD_DIR, sid);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

    for (const part of parts) {
      const ext = path.extname(part.filename).toLowerCase();
      if (BLOCKED_EXTS.includes(ext)) continue; // skip dangerous

      const fileId   = crypto.randomBytes(16).toString('hex');
      const diskName = `${fileId}${ext}`;
      const diskPath = path.join(sessDir, diskName);
      fs.writeFileSync(diskPath, part.content);

      const info = {
        id: fileId,
        sessionId: sid,
        originalName: part.filename,
        size: part.content.length,
        mimetype: part.mime,
        diskPath,
        uploadedAt: Date.now(),
      };
      fileStore.set(fileId, info);
      sess.files.push(fileId);
      uploadedFiles.push({ id: fileId, name: part.filename, size: part.content.length, mimetype: part.mime, uploadedAt: info.uploadedAt });
    }

    saveSessions();
    // Notify desktop via SSE
    sseEmit(sid, 'files:received', { files: uploadedFiles });
    return json(res, 200, { success: true, files: uploadedFiles });
  }

  // ── API: Download file ──
  const dlMatch = pathname.match(/^\/api\/files\/([a-f0-9]+)\/download$/i);
  if (method === 'GET' && dlMatch) {
    const fileId = dlMatch[1];
    const info   = fileStore.get(fileId);
    if (!info)                          return json(res, 404, { error: 'File not found' });
    if (!fs.existsSync(info.diskPath))  return json(res, 404, { error: 'File no longer available' });

    const sess = sessions.get(info.sessionId);
    if (!sess || Date.now() > sess.expiresAt) return json(res, 410, { error: 'Session expired' });

    const stat = fs.statSync(info.diskPath);
    const encodedName = encodeURIComponent(info.originalName).replace(/'/g, '%27');

    res.writeHead(200, {
      'Content-Type':        info.mimetype || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Content-Length':      stat.size,
    });

    const stream = fs.createReadStream(info.diskPath);
    stream.pipe(res);
    stream.on('error', () => res.end());
    return;
  }

  // ── API: SSE — desktop event stream ──
  const sseMatch = pathname.match(/^\/api\/sessions\/([A-Z0-9-]+)\/events$/i);
  if (method === 'GET' && sseMatch) {
    const sid = sseMatch[1].toUpperCase();
    const sess = sessions.get(sid);
    if (!sess) return json(res, 404, { error: 'Session not found' });

    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');

    if (!sseClients.has(sid)) sseClients.set(sid, new Set());
    sseClients.get(sid).add(res);

    // Notify mobile that desktop is listening
    sseEmit(sid, 'desktop:ready', {});

    const keepalive = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(keepalive); }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepalive);
      const clients = sseClients.get(sid);
      if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(sid); }
    });
    return;
  }

  // ── Mobile session page ──
  if (method === 'GET' && pathname.match(/^\/s\/[A-Z0-9]+$/i)) {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  // ── Static files ──
  if (method === 'GET') {
    const safePath = pathname.replace(/\.\./g, '').replace(/\/+/g, '/');
    const filePath = safePath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('\n');
  console.log('  ⚡ SwiftDrop is running!');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log(`  📱 Mobile test: http://localhost:${PORT}/s/swift-test`);
  console.log('\n  Press Ctrl+C to stop\n');
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
