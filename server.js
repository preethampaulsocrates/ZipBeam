/**
 * ZipBeam — Zero-dependency Node.js server
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
const users      = new Map(); // userId    → { id, name, email, passwordHash, salt, role, credits, createdAt }
const authTokens = new Map(); // token     → { userId, expiresAt }

// ─── User / Auth persistence ──────────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AUTH_FILE  = path.join(DATA_DIR, 'auth.json');
const AUTH_TTL   = 7 * 24 * 60 * 60 * 1000; // 7 days

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()])); } catch {}
}
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    for (const u of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) users.set(u.id, u);
  } catch {}
}
function saveAuthTokens() {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify([...authTokens.entries()])); } catch {}
}
function loadAuthTokens() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return;
    const now = Date.now();
    for (const [t, d] of JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))) {
      if (now < d.expiresAt) authTokens.set(t, d);
    }
  } catch {}
}

loadUsers();
loadAuthTokens();

function hashPw(pw, salt) {
  return new Promise((res, rej) => {
    const s = salt || crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, s, 64, (err, key) => err ? rej(err) : res({ hash: key.toString('hex'), salt: s }));
  });
}
function verifyPw(pw, hash, salt) {
  return new Promise((res, rej) => {
    crypto.scrypt(pw, salt, 64, (err, key) => {
      if (err) return rej(err);
      try { res(crypto.timingSafeEqual(Buffer.from(key.toString('hex')), Buffer.from(hash))); } catch { res(false); }
    });
  });
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}
function getAuthUser(req) {
  const token = parseCookies(req).st;
  if (!token) return null;
  const d = authTokens.get(token);
  if (!d || Date.now() > d.expiresAt) return null;
  return users.get(d.userId) || null;
}
function safeUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, credits: u.credits, createdAt: u.createdAt };
}
function authCookie(token) {
  return `st=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH_TTL / 1000)}`;
}

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const pw    = process.env.ADMIN_PASSWORD;
  if (!email || !pw) return;
  for (const u of users.values()) if (u.email.toLowerCase() === email.toLowerCase()) return;
  const { hash, salt } = await hashPw(pw);
  const admin = { id: crypto.randomBytes(8).toString('hex'), name: 'Admin', email: email.toLowerCase(), passwordHash: hash, salt, role: 'admin', credits: 999999, createdAt: Date.now() };
  users.set(admin.id, admin);
  saveUsers();
  console.log(`  👤 Admin account ready: ${email}`);
}
ensureAdmin();

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
  let id = 'ZIP-';
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
  const fields = {};
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

    // Find end of this part
    const endBoundary = buffer.indexOf('\r\n' + '--' + boundary, pos);
    if (endBoundary === -1) break;

    const content = buffer.slice(pos, endBoundary);
    pos = endBoundary;

    if (!cdMatch) {
      // Plain text field — capture its name and value
      const nameMatch = headerStr.match(/name="([^"]+)"/i);
      if (nameMatch) fields[nameMatch[1]] = content.toString('utf8');
      continue;
    }

    const filename = cdMatch[1];
    const mime     = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
    files.push({ filename, mime, content });
  }
  return { files, fields };
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
  '.xml':  'application/xml',
  '.txt':  'text/plain',
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

  // ── API: Auth — signup ──
  if (method === 'POST' && pathname === '/api/auth/signup') {
    if (!checkRateLimit(ip, 10, 60000)) return json(res, 429, { error: 'Too many requests' });
    let body; try { body = JSON.parse((await readBody(req)).toString()); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const { name, email, password } = body;
    if (!name || !email || !password) return json(res, 400, { error: 'Name, email and password are required' });
    if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Invalid email address' });
    for (const u of users.values()) {
      if (u.email === email.toLowerCase().trim()) return json(res, 409, { error: 'Email already registered' });
    }
    const { hash, salt } = await hashPw(password);
    const user = { id: crypto.randomBytes(8).toString('hex'), name: name.trim(), email: email.toLowerCase().trim(), passwordHash: hash, salt, role: 'user', credits: 200, createdAt: Date.now() };
    users.set(user.id, user);
    saveUsers();
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.set(token, { userId: user.id, expiresAt: Date.now() + AUTH_TTL });
    saveAuthTokens();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(token), 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ user: safeUser(user) }));
  }

  // ── API: Auth — login ──
  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!checkRateLimit(ip, 10, 60000)) return json(res, 429, { error: 'Too many requests' });
    let body; try { body = JSON.parse((await readBody(req)).toString()); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const { email, password } = body;
    if (!email || !password) return json(res, 400, { error: 'Email and password are required' });
    let found = null;
    for (const u of users.values()) if (u.email === email.toLowerCase().trim()) { found = u; break; }
    if (!found || !(await verifyPw(password, found.passwordHash, found.salt))) return json(res, 401, { error: 'Invalid email or password' });
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.set(token, { userId: found.id, expiresAt: Date.now() + AUTH_TTL });
    saveAuthTokens();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(token), 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ user: safeUser(found) }));
  }

  // ── API: Auth — logout ──
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(req).st;
    if (token) { authTokens.delete(token); saveAuthTokens(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'st=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── API: Auth — me ──
  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    return json(res, 200, { user: safeUser(user) });
  }

  // ── API: Admin — list users ──
  if (method === 'GET' && pathname === '/api/admin/users') {
    const user = getAuthUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    return json(res, 200, { users: [...users.values()].map(safeUser) });
  }

  // ── Admin page ──
  if (method === 'GET' && pathname === '/admin') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  // ── API: Create session (open — no login required) ──
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
    const { files: parts, fields } = parseMultipart(body, boundaryMatch[1]);
    const purpose = fields.purpose === 'print' ? 'print' : 'save';

    if (parts.length === 0) return json(res, 400, { error: 'No files found' });

    const BLOCKED_EXTS = new Set([
      '.exe','.msi','.msp','.msix','.appx',        // Windows installers
      '.apk','.xapk','.ipa',                        // Mobile apps
      '.bat','.cmd','.ps1','.vbs','.vbe','.wsf','.hta', // Scripts
      '.dll','.sys','.drv','.cpl','.ocx',           // System files
      '.jar','.jnlp',                               // Java
      '.deb','.rpm','.appimage',                    // Linux packages
      '.dmg','.pkg',                                // macOS installers
      '.iso','.img','.bin',                         // Disk images
      '.lnk','.pif','.scr','.com','.reg','.inf',   // Shortcuts / registry
    ]);
    const uploadedFiles = [];
    const sessDir = path.join(UPLOAD_DIR, sid);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

    for (const part of parts) {
      const ext = path.extname(part.filename).toLowerCase();
      if (BLOCKED_EXTS.has(ext)) continue; // skip dangerous

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
        purpose,
      };
      fileStore.set(fileId, info);
      sess.files.push(fileId);
      uploadedFiles.push({ id: fileId, name: part.filename, size: part.content.length, mimetype: part.mime, uploadedAt: info.uploadedAt, purpose });
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
    let filePath = safePath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('\n');
  console.log('  ⚡ ZipBeam is running!');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log(`  📱 Mobile test: http://localhost:${PORT}/s/zip-test`);
  console.log('\n  Press Ctrl+C to stop\n');
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
