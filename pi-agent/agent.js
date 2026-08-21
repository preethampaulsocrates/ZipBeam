#!/usr/bin/env node
/**
 * ATP Print Agent — runs on a Raspberry Pi at the shop counter.
 *
 * Listens for paid print jobs from the ZipBeam server, downloads the files,
 * and prints them via CUPS. The copy count comes from the paid job and is
 * passed straight to `lp -n`, so there is no OS print dialog the customer
 * could use to print more copies than they paid for.
 *
 * Zero npm dependencies — Node built-ins only.
 * Config lives in config.json next to this file (see config.example.json).
 */

'use strict';

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { execFile } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`\n  ✖ No config.json found at ${CONFIG_PATH}`);
    console.error('    Copy config.example.json to config.json and fill it in.\n');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`\n  ✖ config.json is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  const missing = ['serverUrl', 'deviceToken', 'printer'].filter(k => !cfg[k]);
  if (missing.length) {
    console.error(`\n  ✖ config.json is missing: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  if (!/^[a-f0-9]{64}$/i.test(cfg.deviceToken)) {
    console.error('\n  ✖ deviceToken looks wrong — it should be 64 hex characters.\n');
    process.exit(1);
  }
  cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, '');
  return cfg;
}

const cfg = loadConfig();
const api  = cfg.serverUrl.startsWith('https') ? https : http;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-'));

function log(...a)  { console.log(`[${new Date().toISOString()}]`, ...a); }
function warn(...a) { console.warn(`[${new Date().toISOString()}]`, ...a); }

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(cfg.serverUrl + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req  = api.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${cfg.deviceToken}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        reject(new Error((parsed && parsed.error) || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function downloadFile(fileId, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.serverUrl}/api/files/${fileId}/download`);
    api.get({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      headers:  { 'Authorization': `Bearer ${cfg.deviceToken}` },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Printing ────────────────────────────────────────────────────────────────
function lp(args) {
  return new Promise((resolve, reject) => {
    execFile('lp', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

// Confirms the configured printer actually exists before we take any jobs —
// better to fail loudly at startup than to silently swallow a customer's money.
function checkPrinter() {
  return new Promise((resolve) => {
    execFile('lpstat', ['-p', cfg.printer], (err, stdout) => {
      if (err) {
        warn(`  ⚠ Printer "${cfg.printer}" not found by CUPS.`);
        warn('    List available printers with:  lpstat -p');
        return resolve(false);
      }
      log(`  🖨  Printer ready: ${stdout.trim().split('\n')[0]}`);
      resolve(true);
    });
  });
}

const printing = new Set(); // job ids currently being handled, to avoid double-printing

async function handleJob(job) {
  if (printing.has(job.id)) return;
  printing.add(job.id);

  const copies = Math.max(1, parseInt(job.copies, 10) || 1);
  log(`▶ Job ${job.id}: ${job.files.length} file(s), ${job.totalPages} page(s) × ${copies} cop${copies !== 1 ? 'ies' : 'y'} — ₹${(job.amountPaise / 100)}`);

  const temps = [];
  try {
    for (const f of job.files) {
      const safe = String(f.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      const dest = path.join(WORK_DIR, `${job.id}-${f.fileId}-${safe}`);
      await downloadFile(f.fileId, dest);
      temps.push(dest);

      const args = ['-d', cfg.printer, '-n', String(copies)];
      if (job.colorMode === 'bw') {
        // Ask for greyscale; harmless on a mono printer that ignores it.
        args.push('-o', 'ColorModel=Gray');
      }
      if (cfg.duplex) args.push('-o', 'sides=two-sided-long-edge');
      if (Array.isArray(cfg.extraLpOptions)) {
        for (const opt of cfg.extraLpOptions) args.push('-o', String(opt));
      }
      args.push(dest);

      const out = await lp(args);
      log(`  ✓ Sent to printer: ${f.name} — ${out}`);
    }

    await request('POST', `/api/agent/jobs/${job.id}/printed`, {});
    log(`✔ Job ${job.id} complete`);
  } catch (e) {
    warn(`✖ Job ${job.id} failed: ${e.message}`);
    try { await request('POST', `/api/agent/jobs/${job.id}/failed`, { error: e.message }); } catch {}
  } finally {
    for (const t of temps) { try { fs.unlinkSync(t); } catch {} }
    printing.delete(job.id);
  }
}

// ─── Catch up on jobs paid while the agent was offline ───────────────────────
async function drainPending() {
  try {
    const { jobs, shopName } = await request('GET', '/api/agent/jobs');
    if (shopName) log(`  🏪 Paired with: ${shopName}`);
    if (jobs.length) {
      log(`  ↻ ${jobs.length} job(s) waiting from earlier`);
      for (const j of jobs) await handleJob(j);
    }
  } catch (e) {
    warn(`  ⚠ Could not fetch pending jobs: ${e.message}`);
  }
}

// ─── Live job stream ─────────────────────────────────────────────────────────
let reconnectDelay = 2000;

function connect() {
  const url = new URL(cfg.serverUrl + '/api/agent/events');
  const req = api.get({
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
    path:     url.pathname,
    headers: { 'Authorization': `Bearer ${cfg.deviceToken}`, 'Accept': 'text/event-stream' },
  }, (res) => {
    if (res.statusCode === 401) {
      console.error('\n  ✖ Server rejected the device token. Re-pair this agent in ZipBeam.\n');
      process.exit(1);
    }
    if (res.statusCode !== 200) {
      warn(`  ⚠ Stream returned HTTP ${res.statusCode}, retrying…`);
      res.resume();
      return scheduleReconnect();
    }

    log('  📡 Connected — waiting for paid jobs');
    reconnectDelay = 2000;
    drainPending();

    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine   = raw.split('\n').find(l => l.startsWith('event:'));
        const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
        if (!evLine || !dataLine) continue;               // keepalive ping
        if (evLine.slice(6).trim() !== 'print:paid') continue;
        try {
          const { job } = JSON.parse(dataLine.slice(5).trim());
          if (job) handleJob(job);
        } catch (e) { warn(`  ⚠ Bad event payload: ${e.message}`); }
      }
    });
    res.on('end',   () => { warn('  ⚠ Stream ended');  scheduleReconnect(); });
    res.on('error', (e) => { warn(`  ⚠ Stream error: ${e.message}`); scheduleReconnect(); });
  });

  req.on('error', (e) => { warn(`  ⚠ Cannot reach server: ${e.message}`); scheduleReconnect(); });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  warn(`  ↻ Reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000); // back off, cap at 1 min
}

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n  ⚡ ATP Print Agent');
  console.log(`  🌐 Server : ${cfg.serverUrl}`);
  console.log(`  🖨  Printer: ${cfg.printer}`);
  console.log(`  📁 Temp   : ${WORK_DIR}\n`);
  await checkPrinter();
  connect();
})();

function shutdown() {
  log('Shutting down');
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
