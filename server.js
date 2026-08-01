/**
 * ZipBeam — Zero-dependency Node.js server
 * Uses: http, fs, path, crypto, events (all built-in)
 * Run: node server.js
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Verifies a Google Identity Services ID token via Google's tokeninfo endpoint (no SDK needed)
function verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    https.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (r.statusCode !== 200 || !payload.sub) return reject(new Error('Invalid Google token'));
          resolve(payload);
        } catch { reject(new Error('Invalid Google token response')); }
      });
    }).on('error', reject);
  });
}

const { Pool } = require('pg');

const PORT        = process.env.PORT || 3000;
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DATA_DIR    = path.join(__dirname, 'data');
const SESSION_TTL = 30 * 60 * 1000; // 30 min
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });

// ─── PostgreSQL pool ──────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);
  const { rows } = await db.query('SELECT data FROM users');
  for (const row of rows) users.set(row.data.id, row.data);
  const { rows: tokens } = await db.query(
    'SELECT token, user_id, expires_at FROM auth_tokens WHERE expires_at > $1', [Date.now()]
  );
  for (const t of tokens) authTokens.set(t.token, { userId: t.user_id, expiresAt: Number(t.expires_at) });
  console.log(`  🗄️  DB ready — ${rows.length} users loaded`);
}

// ─── In-memory stores ─────────────────────────────────────────────────────────
const sessions   = new Map();
const fileStore  = new Map();
const sseClients = new Map();
const sseUserClients = new Map();
const users      = new Map();
const authTokens = new Map();
const DELIVERY_TTL = 24 * 60 * 60 * 1000;

// ─── User / Auth persistence ──────────────────────────────────────────────────
const AUTH_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function saveUser(u) {
  try {
    await db.query(
      'INSERT INTO users (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
      [u.id, JSON.stringify(u)]
    );
  } catch (e) { console.error('saveUser error:', e.message); }
}
function saveUsers() {
  for (const u of users.values()) saveUser(u);
}
async function saveAuthToken(token, record) {
  try {
    await db.query(
      'INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET expires_at = $3',
      [token, record.userId, record.expiresAt]
    );
  } catch (e) { console.error('saveAuthToken error:', e.message); }
}
async function deleteAuthToken(token) {
  try { await db.query('DELETE FROM auth_tokens WHERE token = $1', [token]); } catch {}
}

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
function addRecentContact(user, contactId, contactName) {
  if (!Array.isArray(user.recentContacts)) user.recentContacts = [];
  user.recentContacts = user.recentContacts.filter(c => c.id !== contactId);
  user.recentContacts.unshift({ id: contactId, name: contactName, lastSentAt: Date.now() });
  user.recentContacts = user.recentContacts.slice(0, 10);
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
  await saveUser(admin);
  console.log(`  👤 Admin account ready: ${email}`);
}

// Boot: init DB then ensure admin
initDb().then(() => ensureAdmin()).catch(e => { console.error('DB init failed:', e.message); });

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
function genSessionId(prefix = 'ZIP-') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = prefix;
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
function sseEmitUser(userId, event, data) {
  const clients = sseUserClients.get(userId);
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
    await saveUser(user);
    const token = crypto.randomBytes(32).toString('hex');
    const tokenRecord = { userId: user.id, expiresAt: Date.now() + AUTH_TTL };
    authTokens.set(token, tokenRecord);
    await saveAuthToken(token, tokenRecord);
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
    const tokenRecord = { userId: found.id, expiresAt: Date.now() + AUTH_TTL };
    authTokens.set(token, tokenRecord);
    await saveAuthToken(token, tokenRecord);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(token), 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ user: safeUser(found) }));
  }

  // ── API: Auth — Google Sign-In ──
  if (method === 'POST' && pathname === '/api/auth/google') {
    if (!checkRateLimit(ip, 10, 60000)) return json(res, 429, { error: 'Too many requests' });
    if (!process.env.GOOGLE_CLIENT_ID) return json(res, 501, { error: 'Google Sign-In is not configured yet' });
    let body; try { body = JSON.parse((await readBody(req)).toString()); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const { credential } = body;
    if (!credential) return json(res, 400, { error: 'Missing Google credential' });
    let payload;
    try { payload = await verifyGoogleIdToken(credential); } catch { return json(res, 401, { error: 'Invalid Google token' }); }
    if (payload.aud !== process.env.GOOGLE_CLIENT_ID) return json(res, 401, { error: 'Token audience mismatch' });

    let user = null;
    for (const u of users.values()) if (u.googleId === payload.sub || u.email === (payload.email || '').toLowerCase()) { user = u; break; }
    if (!user) {
      user = {
        id: crypto.randomBytes(8).toString('hex'),
        name: payload.name || payload.email.split('@')[0],
        email: (payload.email || '').toLowerCase(),
        passwordHash: null, salt: null,
        googleId: payload.sub,
        role: 'user', credits: 200, createdAt: Date.now(), recentContacts: [],
      };
      users.set(user.id, user);
    } else if (!user.googleId) {
      user.googleId = payload.sub;
    }
    await saveUser(user);
    const token = crypto.randomBytes(32).toString('hex');
    const tokenRecord = { userId: user.id, expiresAt: Date.now() + AUTH_TTL };
    authTokens.set(token, tokenRecord);
    await saveAuthToken(token, tokenRecord);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(token), 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ user: safeUser(user) }));
  }

  // ── API: Auth — logout ──
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(req).st;
    if (token) { authTokens.delete(token); deleteAuthToken(token); }
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
    const totalDeliveries = [...sessions.values()].filter(s => s.kind === 'delivery').length;
    return json(res, 200, { users: [...users.values()].map(safeUser), totalDeliveries });
  }

  // ── Admin page ──
  if (method === 'GET' && pathname === '/admin') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'));
  }

  // ── API: Look up a user by their ZipBeam ID (for "send to UID" + shop QR landing) ──
  const lookupMatch = pathname.match(/^\/api\/users\/lookup\/([a-f0-9]+)$/i);
  if (method === 'GET' && lookupMatch) {
    const target = users.get(lookupMatch[1]);
    if (!target) return json(res, 404, { error: 'No ZipBeam user with that ID' });
    return json(res, 200, { id: target.id, name: target.name });
  }

  // ── API: Create a direct delivery to another user's ZipBeam ID ──
  if (method === 'POST' && pathname === '/api/deliveries') {
    if (!checkRateLimit(ip, 30, 60000)) return json(res, 429, { error: 'Too many requests' });
    let body; try { body = JSON.parse((await readBody(req)).toString()); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const toUserId = (body.toUserId || '').trim();
    const toUser = users.get(toUserId);
    if (!toUser) return json(res, 404, { error: 'No ZipBeam user with that ID' });

    const fromUser = getAuthUser(req);
    const deliveryId = genSessionId('DLV-');
    const expiresAt = Date.now() + DELIVERY_TTL;
    sessions.set(deliveryId, {
      id: deliveryId, expiresAt, files: [],
      kind: 'delivery', toUserId: toUser.id,
      fromUserId: fromUser ? fromUser.id : null,
      fromName: fromUser ? fromUser.name : null,
    });
    saveSessions();

    if (fromUser) {
      addRecentContact(fromUser, toUser.id, toUser.name);
      saveUser(fromUser);
    }
    return json(res, 200, { deliveryId, toUser: { id: toUser.id, name: toUser.name } });
  }

  // ── API: Recent contacts for the logged-in user ──
  if (method === 'GET' && pathname === '/api/contacts/recent') {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    const contacts = (user.recentContacts || []).map(c => ({ ...c, name: users.get(c.id)?.name || c.name }));
    return json(res, 200, { contacts });
  }

  // ── API: Pending inbox files for the logged-in user (delivery sessions addressed to them) ──
  if (method === 'GET' && pathname === '/api/inbox') {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    const files = [];
    for (const sess of sessions.values()) {
      if (sess.kind !== 'delivery' || sess.toUserId !== user.id) continue;
      for (const fid of sess.files) {
        const info = fileStore.get(fid);
        if (info) files.push({ id: info.id, name: info.originalName, size: info.size, mimetype: info.mimetype, uploadedAt: info.uploadedAt, purpose: info.purpose, fromName: sess.fromName || null });
      }
    }
    return json(res, 200, { files });
  }

  // ── API: SSE — per-user inbox stream (logged-in desktop listens here too) ──
  if (method === 'GET' && pathname === '/api/users/me/events') {
    const user = getAuthUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    if (!sseUserClients.has(user.id)) sseUserClients.set(user.id, new Set());
    sseUserClients.get(user.id).add(res);
    const keepalive = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { clearInterval(keepalive); }
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      const clients = sseUserClients.get(user.id);
      if (clients) { clients.delete(res); if (clients.size === 0) sseUserClients.delete(user.id); }
    });
    return;
  }

  // ── Static shop QR landing — scanning always sends to this user's permanent ID ──
  const shopMatch = pathname.match(/^\/u\/([a-f0-9]+)$/i);
  if (method === 'GET' && shopMatch) {
    const toUser = users.get(shopMatch[1]);
    if (!toUser) return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    const deliveryId = genSessionId('DLV-');
    sessions.set(deliveryId, {
      id: deliveryId, expiresAt: Date.now() + DELIVERY_TTL, files: [],
      kind: 'delivery', toUserId: toUser.id, fromUserId: null, fromName: null,
    });
    saveSessions();
    res.writeHead(302, { Location: `/s/${deliveryId.replace('DLV-', '').toLowerCase()}` });
    return res.end();
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

      const senderId    = fields.senderId    || null;
      const senderLabel = fields.senderLabel || null;

      const info = {
        id: fileId,
        sessionId: sid,
        originalName: part.filename,
        size: part.content.length,
        mimetype: part.mime,
        diskPath,
        uploadedAt: Date.now(),
        purpose,
        senderId,
        senderLabel,
      };
      fileStore.set(fileId, info);
      sess.files.push(fileId);
      uploadedFiles.push({ id: fileId, name: part.filename, size: part.content.length, mimetype: part.mime, uploadedAt: info.uploadedAt, purpose, senderId, senderLabel });
    }

    saveSessions();
    // Notify desktop via SSE
    sseEmit(sid, 'files:received', { files: uploadedFiles });
    if (sess.kind === 'delivery' && sess.toUserId) {
      sseEmitUser(sess.toUserId, 'files:received', { files: uploadedFiles, fromName: sess.fromName || null });
    }
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

  // ── API: Delete a file (used after printing — print-only files are not kept) ──
  const delMatch = pathname.match(/^\/api\/files\/([a-f0-9]+)$/i);
  if (method === 'DELETE' && delMatch) {
    const fileId = delMatch[1];
    const info   = fileStore.get(fileId);
    if (!info) return json(res, 404, { error: 'File not found' });
    const sid = info.sessionId;
    deleteFile(fileId);
    sseEmit(sid, 'file:deleted', { fileId });
    const sess = sessions.get(sid);
    if (sess && sess.kind === 'delivery' && sess.toUserId) {
      sseEmitUser(sess.toUserId, 'file:deleted', { fileId });
    }
    return json(res, 200, { ok: true });
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
