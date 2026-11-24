// EngBook server — engineering notebook for iPad Pro + Apple Pencil.
// Zero external dependencies: Node http + node:sqlite + crypto.
// Copyright (c) 2026 Jerod Ulicki
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from './db.js';
import * as auth from './auth.js';
import { dataRoutes } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = process.env.ENGBOOK_TRUST_PROXY !== '0';

const db = openDb();

if (process.env.ENGBOOK_RESET_AUTH === '1') {
  auth.resetAuth(db);
  console.log('[engbook] ENGBOOK_RESET_AUTH=1: sign-in was reset. Remove the variable and restart, then set up again.');
}

// One-time setup code so nobody else can claim a fresh, internet-facing install.
let setupCode = null;
if (!auth.isSetUp(db)) {
  setupCode = process.env.ENGBOOK_SETUP_CODE || crypto.randomBytes(4).toString('hex').toUpperCase();
  console.log(`[engbook] First run. Setup code: ${setupCode}`);
}

// ---------- request helpers ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function reqProto(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-proto']) return String(req.headers['x-forwarded-proto']).split(',')[0].trim();
  return req.socket.encrypted ? 'https' : 'http';
}

function reqHost(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-host']) return String(req.headers['x-forwarded-host']).split(',')[0].trim();
  return String(req.headers.host || 'localhost');
}

function relyingParty(req) {
  const host = reqHost(req);
  const origin = process.env.ENGBOOK_ORIGIN || `${reqProto(req)}://${host}`;
  const id = process.env.ENGBOOK_RP_ID || new URL(origin).hostname;
  return { id, origin };
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sessionCookie(req, token, maxAge) {
  const secure = reqProto(req) === 'https' ? '; Secure' : '';
  return `${auth.COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- live events (Server-Sent Events) ----------
const listeners = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) res.write(line);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mjs': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // app shell for client routes
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${VERSION}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    if (rel === '/index.html') { // fill in the version shown on the loading screen
      const html = fs.readFileSync(file, 'utf8').replaceAll('{{VERSION}}', VERSION);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', ETag: etag });
      return res.end(html);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- auth routes ----------
async function authRoutes(req, res, url, ctx) {
  const p = url.pathname, m = req.method;
  const ip = clientIp(req);

  if (p === '/api/auth/state' && m === 'GET') {
    return send(res, 200, {
      version: VERSION,
      setup: !auth.isSetUp(db),
      authenticated: !!ctx.session,
      hasPasskeys: db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n > 0,
    });
  }

  if (p === '/api/auth/setup/start' && m === 'POST') {
    if (auth.isSetUp(db)) throw new HttpError(409, 'Already set up');
    const b = await readBody(req);
    if (String(b.setupCode || '').trim().toUpperCase() !== setupCode) {
      auth.logSignin(db, ip, 'setup', false, 'bad setup code');
      throw new HttpError(403, 'Setup code is wrong. Find it in the container log.');
    }
    const secret = auth.newTotpSecret();
    return send(res, 200, { secret, otpauth: auth.otpauthUri(secret, relyingParty(req).id) });
  }

  if (p === '/api/auth/setup/finish' && m === 'POST') {
    if (auth.isSetUp(db)) throw new HttpError(409, 'Already set up');
    const b = await readBody(req);
    if (String(b.setupCode || '').trim().toUpperCase() !== setupCode) throw new HttpError(403, 'Setup code is wrong.');
    const weak = auth.validatePasswordStrength(b.password);
    if (weak) throw new HttpError(400, weak);
    if (!/^[A-Z2-7]{32}$/.test(String(b.secret || ''))) throw new HttpError(400, 'Bad authenticator secret');
    const step = auth.checkTotp(b.secret, b.code);
    if (step < 0) throw new HttpError(400, 'That authenticator code did not match. Check the time on your device and try again.');
    const recoveryCodes = auth.finishSetup(db, b.password, b.secret);
    setSetting(db, 'totp_last_step', step);
    setupCode = null;
    auth.logSignin(db, ip, 'setup', true);
    const s = auth.createSession(db, 'setup', req.headers['user-agent']);
    return send(res, 200, { recoveryCodes }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const lock = auth.lockState(db, ip);
    if (lock.locked) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.max(1, Math.ceil((lock.until - Date.now()) / 60000))} min.`);
    const b = await readBody(req);
    const r = auth.checkPasswordLogin(db, String(b.password || ''), String(b.code || ''));
    auth.logSignin(db, ip, 'password', r.ok, r.ok ? r.method : r.detail);
    if (!r.ok) throw new HttpError(401, 'Password or code is wrong.');
    const s = auth.createSession(db, r.method, req.headers['user-agent']);
    return send(res, 200, { ok: true, recoveryLeft: auth.recoveryCodesLeft(db) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }

  if (p === '/api/auth/passkey/login/options' && m === 'POST') {
    const lock = auth.lockState(db, ip);
    if (lock.locked) throw new HttpError(429, 'Too many failed attempts. Try again later.');
    return send(res, 200, auth.authenticationOptions(relyingParty(req)));
  }

  if (p === '/api/auth/passkey/login/verify' && m === 'POST') {
    const lock = auth.lockState(db, ip);
    if (lock.locked) throw new HttpError(429, 'Too many failed attempts. Try again later.');
    const b = await readBody(req);
    try {
      const row = auth.verifyAuthentication(db, relyingParty(req), b.credential);
      auth.logSignin(db, ip, 'passkey', true, row.name);
    } catch (e) {
      auth.logSignin(db, ip, 'passkey', false, e.message);
      throw new HttpError(401, e.message);
    }
    const s = auth.createSession(db, 'passkey', req.headers['user-agent']);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    auth.destroySession(db, ctx.token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // ----- everything below needs a session -----
  if (!ctx.session) throw new HttpError(401, 'Sign in required');

  if (p === '/api/auth/account' && m === 'GET') {
    return send(res, 200, {
      passkeys: db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at').all(),
      recoveryLeft: auth.recoveryCodesLeft(db),
      log: db.prepare('SELECT at, ip, method, ok, detail FROM signin_log ORDER BY id DESC LIMIT 50').all(),
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    });
  }

  if (p === '/api/auth/passkey/register/options' && m === 'POST') {
    return send(res, 200, auth.registrationOptions(db, relyingParty(req)));
  }

  if (p === '/api/auth/passkey/register/verify' && m === 'POST') {
    const b = await readBody(req);
    try {
      const id = auth.verifyRegistration(db, relyingParty(req), b.credential, b.name);
      return send(res, 200, { ok: true, id });
    } catch (e) { throw new HttpError(400, e.message); }
  }

  const pk = p.match(/^\/api\/auth\/passkeys\/([A-Za-z0-9_-]+)$/);
  if (pk && m === 'DELETE') {
    db.prepare('DELETE FROM passkeys WHERE id = ?').run(pk[1]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/password' && m === 'POST') {
    const b = await readBody(req);
    const r = auth.checkPasswordLogin(db, String(b.current || ''), String(b.code || ''));
    if (!r.ok) { auth.logSignin(db, ip, 'password-change', false, r.detail); throw new HttpError(401, 'Current password or code is wrong.'); }
    const weak = auth.validatePasswordStrength(b.next);
    if (weak) throw new HttpError(400, weak);
    setSetting(db, 'password_hash', auth.hashPassword(b.next));
    auth.logSignin(db, ip, 'password-change', true);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/recovery-codes' && m === 'POST') {
    const b = await readBody(req);
    const step = auth.checkTotp(getSetting(db, 'totp_secret'), b.code, getSetting(db, 'totp_last_step', -1));
    if (step < 0) throw new HttpError(401, 'Authenticator code is wrong.');
    setSetting(db, 'totp_last_step', step);
    return send(res, 200, { recoveryCodes: auth.newRecoveryCodes(db) });
  }

  if (p === '/api/auth/logout-all' && m === 'POST') {
    auth.destroyAllSessions(db);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- main handler ----------
const data = dataRoutes(db, { readBody, send, HttpError, broadcast });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const token = parseCookies(req)[auth.COOKIE];
    const ctx = { token, session: auth.sessionFromToken(db, token) };

    // CSRF guard: every state-changing API call must carry our custom header.
    if (req.method !== 'GET' && req.headers['x-engbook'] !== '1') throw new HttpError(403, 'Missing X-EngBook header');

    if (url.pathname.startsWith('/api/auth/')) return await authRoutes(req, res, url, ctx);
    if (!ctx.session) throw new HttpError(401, 'Sign in required');

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (url.pathname === '/api/version') return send(res, 200, { version: VERSION });

    return await data(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[engbook]', e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Server error' : e.message });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`[engbook] v${VERSION} listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
