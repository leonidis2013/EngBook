// EngBook — HTTP client.
// Copyright (c) 2026 Jerod Ulicki

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-EngBook': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Offline');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ---- WebAuthn helpers (base64url <-> ArrayBuffer) ----
export const b64urlToBuf = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
export const bufToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: b64urlToBuf(options.challenge),
    user: { ...options.user, id: b64urlToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id, type: cred.type,
    response: {
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      attestationObject: bufToB64url(cred.response.attestationObject),
    },
  };
}

export async function getPasskey(options) {
  const publicKey = { ...options, challenge: b64urlToBuf(options.challenge), allowCredentials: [] };
  const cred = await navigator.credentials.get({ publicKey });
  return {
    id: cred.id, type: cred.type,
    response: {
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      authenticatorData: bufToB64url(cred.response.authenticatorData),
      signature: bufToB64url(cred.response.signature),
    },
  };
}

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
