// EngBook — authentication: password + authenticator code (TOTP), passkeys (WebAuthn),
// recovery codes, sessions, lockout and sign-in log. No external packages.
// Copyright (c) 2026 Jerod Ulicki
import crypto from 'node:crypto';
import { getSetting, setSetting, deleteSetting } from './db.js';
import { decodeCbor } from './cbor.js';

const SESSION_DAYS = 30;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20;
export const COOKIE = 'eb_session';

// ---------- helpers ----------
export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(s, 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const now = () => Date.now();

function timingEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- password ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashB64, 'base64'));
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32, step) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  msg.writeUInt32BE(step % 2 ** 32, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

// Returns the matched time step, or -1.
export function checkTotp(secretB32, code, lastStep = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return -1;
  const step = Math.floor(now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue; // never accept the same code twice
    if (timingEqual(totpAt(secretB32, s), String(code))) return s;
  }
  return -1;
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function otpauthUri(secret, host) {
  const label = encodeURIComponent(`EngBook (${host})`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=EngBook&algorithm=SHA1&digits=6&period=30`;
}

// ---------- recovery codes ----------
export function newRecoveryCodes(db) {
  db.prepare('DELETE FROM recovery_codes').run();
  const codes = [];
  const ins = db.prepare('INSERT INTO recovery_codes(code_hash) VALUES(?)');
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    ins.run(sha256hex(code));
    codes.push(code);
  }
  return codes;
}

function useRecoveryCode(db, code) {
  const norm = String(code || '').trim().toUpperCase();
  if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(norm)) return false;
  const r = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
    .run(now(), sha256hex(norm));
  return r.changes === 1;
}

export function recoveryCodesLeft(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL').get().n;
}

// ---------- lockout + sign-in log ----------
export function logSignin(db, ip, method, ok, detail = '') {
  db.prepare('INSERT INTO signin_log(at, ip, method, ok, detail) VALUES(?,?,?,?,?)')
    .run(now(), ip || '', method, ok ? 1 : 0, detail);
  // keep the log bounded
  db.prepare('DELETE FROM signin_log WHERE id NOT IN (SELECT id FROM signin_log ORDER BY id DESC LIMIT 1000)').run();
}

export function lockState(db, ip) {
  const since = now() - LOCK_WINDOW_MS;
  const perIp = db.prepare(`SELECT COUNT(*) AS n, MAX(at) AS last FROM signin_log
      WHERE ok = 0 AND ip = ? AND at > ? AND at > COALESCE((SELECT MAX(at) FROM signin_log WHERE ok = 1 AND ip = ?), 0)`)
    .get(ip || '', since, ip || '');
  const global = db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last FROM signin_log WHERE ok = 0 AND at > ?').get(since);
  if (perIp.n >= MAX_FAILS_PER_IP) return { locked: true, until: perIp.last + LOCK_WINDOW_MS };
  if (global.n >= MAX_FAILS_GLOBAL) return { locked: true, until: global.last + LOCK_WINDOW_MS };
  return { locked: false };
}

// ---------- sessions ----------
export function createSession(db, method, userAgent) {
  const token = b64url(crypto.randomBytes(32));
  const t = now();
  db.prepare('INSERT INTO sessions(token_hash, created_at, expires_at, method, user_agent) VALUES(?,?,?,?,?)')
    .run(sha256hex(token), t, t + SESSION_DAYS * 864e5, method, (userAgent || '').slice(0, 200));
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function sessionFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256hex(token));
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
}

export function destroyAllSessions(db) {
  db.prepare('DELETE FROM sessions').run();
}

// ---------- account state ----------
export function isSetUp(db) {
  return !!getSetting(db, 'password_hash');
}

export function resetAuth(db) {
  deleteSetting(db, 'password_hash');
  deleteSetting(db, 'totp_secret');
  deleteSetting(db, 'totp_last_step');
  db.prepare('DELETE FROM passkeys').run();
  db.prepare('DELETE FROM recovery_codes').run();
  destroyAllSessions(db);
}

export function finishSetup(db, password, totpSecret) {
  setSetting(db, 'password_hash', hashPassword(password));
  setSetting(db, 'totp_secret', totpSecret);
  setSetting(db, 'totp_last_step', -1);
  if (!getSetting(db, 'user_handle')) setSetting(db, 'user_handle', b64url(crypto.randomBytes(16)));
  return newRecoveryCodes(db);
}

// password + (TOTP code | recovery code)
export function checkPasswordLogin(db, password, code) {
  if (!verifyPassword(password, getSetting(db, 'password_hash'))) return { ok: false, detail: 'bad password' };
  const secret = getSetting(db, 'totp_secret');
  const step = checkTotp(secret, code, getSetting(db, 'totp_last_step', -1));
  if (step >= 0) { setSetting(db, 'totp_last_step', step); return { ok: true, method: 'password+totp' }; }
  if (useRecoveryCode(db, code)) return { ok: true, method: 'password+recovery' };
  return { ok: false, detail: 'bad code' };
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

// ---------- WebAuthn (passkeys) ----------
const challenges = new Map(); // challenge -> { kind, expires }

function newChallenge(kind) {
  const c = b64url(crypto.randomBytes(32));
  challenges.set(c, { kind, expires: now() + 5 * 60 * 1000 });
  for (const [k, v] of challenges) if (v.expires < now()) challenges.delete(k);
  return c;
}

function takeChallenge(c, kind) {
  const v = challenges.get(c);
  challenges.delete(c);
  return !!v && v.kind === kind && v.expires > now();
}

export function registrationOptions(db, rp) {
  const existing = db.prepare('SELECT id FROM passkeys').all();
  return {
    challenge: newChallenge('create'),
    rp: { name: 'EngBook', id: rp.id },
    user: { id: getSetting(db, 'user_handle'), name: 'engbook', displayName: 'EngBook' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: 120000,
    excludeCredentials: existing.map((r) => ({ type: 'public-key', id: r.id })),
  };
}

export function authenticationOptions(rp) {
  return { challenge: newChallenge('get'), rpId: rp.id, userVerification: 'required', timeout: 120000, allowCredentials: [] };
}

function parseAuthData(buf) {
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, up: !!(flags & 1), uv: !!(flags & 4) };
  if (flags & 0x40) {
    let p = 37;
    p += 16; // aaguid
    const idLen = buf.readUInt16BE(p); p += 2;
    out.credId = buf.subarray(p, p + idLen); p += idLen;
    const { value } = decodeCbor(buf.subarray(p));
    out.coseKey = value;
  }
  return out;
}

function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && cose.get(-1) === 1) {
    return { alg: alg ?? -7, jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (kty === 3) {
    return { alg: alg ?? -257, jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) } };
  }
  throw new Error('Unsupported passkey key type');
}

function checkClientData(clientDataB64, type, rp) {
  const raw = fromB64url(clientDataB64);
  const cd = JSON.parse(raw.toString('utf8'));
  if (cd.type !== type) throw new Error('Wrong ceremony type');
  if (!takeChallenge(cd.challenge, type === 'webauthn.create' ? 'create' : 'get')) throw new Error('Challenge expired, try again');
  if (cd.origin !== rp.origin) throw new Error(`Origin mismatch (${cd.origin})`);
  return raw;
}

export function verifyRegistration(db, rp, cred, name) {
  const resp = cred?.response || {};
  checkClientData(resp.clientDataJSON, 'webauthn.create', rp);
  const att = decodeCbor(fromB64url(resp.attestationObject)).value;
  const ad = parseAuthData(att.get('authData'));
  if (!timingEqual(ad.rpIdHash, sha256(rp.id))) throw new Error('Passkey is for a different site');
  if (!ad.up || !ad.uv) throw new Error('Face ID / user verification is required');
  if (!ad.credId) throw new Error('No credential in response');
  const { alg, jwk } = coseToJwk(ad.coseKey);
  const id = b64url(ad.credId);
  db.prepare('INSERT INTO passkeys(id, name, public_key_jwk, alg, sign_count, created_at) VALUES(?,?,?,?,?,?)')
    .run(id, String(name || 'Passkey').slice(0, 60), JSON.stringify(jwk), alg, ad.signCount, now());
  return id;
}

export function verifyAuthentication(db, rp, cred) {
  const resp = cred?.response || {};
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(cred?.id || ''));
  if (!row) throw new Error('Unknown passkey');
  const clientRaw = checkClientData(resp.clientDataJSON, 'webauthn.get', rp);
  const authData = fromB64url(resp.authenticatorData);
  const ad = parseAuthData(authData);
  if (!timingEqual(ad.rpIdHash, sha256(rp.id))) throw new Error('Passkey is for a different site');
  if (!ad.up || !ad.uv) throw new Error('Face ID / user verification is required');
  const signed = Buffer.concat([authData, sha256(clientRaw)]);
  const key = crypto.createPublicKey({ key: JSON.parse(row.public_key_jwk), format: 'jwk' });
  const ok = crypto.verify('sha256', signed, key, fromB64url(resp.signature));
  if (!ok) throw new Error('Signature check failed');
  if (ad.signCount !== 0 || row.sign_count !== 0) {
    if (ad.signCount <= row.sign_count) throw new Error('Passkey counter error (possible clone)');
  }
  db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(ad.signCount, now(), row.id);
  return row;
}
