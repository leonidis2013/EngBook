// EngBook — first-run setup and sign-in screens.
// Copyright (c) 2026 Jerod Ulicki
import { h, $, download } from './util.js';
import { api, createPasskey, getPasskey, passkeysSupported } from './api.js';
import { ICONS } from './icons.js';

function shell(title, sub, ...body) {
  return h('div', { class: 'auth-screen' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: logoSvg() }), h('span', { class: 'brand-name' }, 'EngBook')),
      h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null,
      ...body,
      h('div', { class: 'auth-foot mono' }, 'Self-hosted engineering notebook')));
}

export function logoSvg() {
  return '<svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3" width="22" height="26" rx="2"/><path d="M10 3v26" /><path d="M14 10h9M14 14h9M14 18h6" stroke-opacity=".6"/><path d="M14 23l3-3 3 3 3-3" stroke="var(--accent)"/></svg>';
}

function errorLine() { return h('div', { class: 'form-error', role: 'alert' }); }

export function renderSetup(root, onDone) {
  const err = errorLine();
  const code = h('input', { class: 'input mono', placeholder: 'Setup code from the container log', autocomplete: 'off', autocapitalize: 'characters' });
  const pw1 = h('input', { class: 'input', type: 'password', placeholder: 'Password (10+ characters)', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password' });
  const step1 = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (pw1.value.length < 10) { err.textContent = 'Use at least 10 characters.'; return; }
    if (pw1.value !== pw2.value) { err.textContent = 'Passwords do not match.'; return; }
    try {
      const r = await api('POST', '/api/auth/setup/start', { setupCode: code.value.trim() });
      root.replaceChildren(step2(r));
    } catch (x) { err.textContent = x.message; }
  } },
  h('label', { class: 'field' }, h('span', {}, 'Setup code'), code),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw1),
  h('label', { class: 'field' }, h('span', {}, 'Confirm'), pw2),
  err, h('button', { class: 'btn primary wide' }, 'Next'));

  function step2({ secret, otpauth }) {
    const err2 = errorLine();
    const totp = h('input', { class: 'input mono code-input', inputmode: 'numeric', maxlength: 6, placeholder: '000000', autocomplete: 'one-time-code' });
    const pretty = secret.match(/.{1,4}/g).join(' ');
    return shell('Add an authenticator', 'Password sign-in also asks for a 6-digit code.',
      h('ol', { class: 'steps' },
        h('li', {}, 'On iPad or iPhone, tap ', h('a', { href: otpauth, class: 'link' }, 'Add to Passwords / authenticator'), '. Or type this key into any authenticator app:'),
        h('li', { class: 'secret mono' }, pretty),
        h('li', {}, 'Enter the 6-digit code it shows.')),
      h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault(); err2.textContent = '';
        try {
          const r = await api('POST', '/api/auth/setup/finish', { setupCode: code.value.trim(), password: pw1.value, secret, code: totp.value.trim() });
          root.replaceChildren(step3(r.recoveryCodes));
        } catch (x) { err2.textContent = x.message; }
      } }, totp, err2, h('button', { class: 'btn primary wide' }, 'Finish setup')));
  }

  function step3(codes) {
    const save = () => download('engbook-recovery-codes.txt', new Blob([`EngBook recovery codes\nEach code works once in place of an authenticator code.\n\n${codes.join('\n')}\n`], { type: 'text/plain' }));
    const err3 = errorLine();
    return shell('Save your recovery codes', 'Each one works once if you lose your authenticator. Keep them somewhere safe.',
      h('div', { class: 'codes mono' }, codes.map((c) => h('span', {}, c))),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost', onclick: save }, 'Download'),
        h('button', { class: 'btn ghost', onclick: () => navigator.clipboard?.writeText(codes.join('\n')) }, 'Copy')),
      h('div', { class: 'divider' }),
      passkeysSupported() ? h('p', { class: 'muted' }, 'Add a passkey to sign in with Face ID on this device.') : null,
      passkeysSupported() ? h('button', { class: 'btn primary wide', onclick: async () => {
        err3.textContent = '';
        try { await addPasskey(); onDone(); } catch (x) { err3.textContent = x.message || 'Passkey was not added.'; }
      } }, 'Add a passkey (Face ID)') : null,
      err3,
      h('button', { class: `btn ${passkeysSupported() ? 'ghost' : 'primary'} wide`, onclick: onDone }, passkeysSupported() ? 'Skip for now' : 'Open EngBook'));
  }

  root.replaceChildren(shell('Set up EngBook', 'First run. Find the setup code in the container log (docker logs engbook).', step1));
}

export async function addPasskey(name) {
  const opts = await api('POST', '/api/auth/passkey/register/options');
  const credential = await createPasskey(opts);
  const label = name || deviceName();
  await api('POST', '/api/auth/passkey/register/verify', { credential, name: label });
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh.*Mobile|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

export function renderLogin(root, state, onDone) {
  const err = errorLine();
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const code = h('input', { class: 'input mono', placeholder: '6-digit code or recovery code', autocomplete: 'one-time-code', autocapitalize: 'characters' });
  const usePasskey = async () => {
    err.textContent = '';
    try {
      const opts = await api('POST', '/api/auth/passkey/login/options');
      const credential = await getPasskey(opts);
      await api('POST', '/api/auth/passkey/login/verify', { credential });
      onDone();
    } catch (x) { err.textContent = x.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : x.message; }
  };
  const canPk = passkeysSupported() && state.hasPasskeys;
  root.replaceChildren(shell('Sign in', null,
    canPk ? h('button', { class: 'btn primary wide passkey-btn', onclick: usePasskey }, h('span', { class: 'ic', html: ICONS.key }), 'Sign in with passkey') : null,
    canPk ? h('div', { class: 'divider label' }, h('span', {}, 'or use your password')) : null,
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('POST', '/api/auth/login', { password: pw.value, code: code.value.trim() });
        if (r.recoveryLeft <= 2) sessionStorage.setItem('eb.lowRecovery', String(r.recoveryLeft));
        onDone();
      } catch (x) { err.textContent = x.message; }
    } },
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    h('label', { class: 'field' }, h('span', {}, 'Authenticator code'), code),
    err,
    h('button', { class: `btn ${canPk ? 'ghost' : 'primary'} wide` }, 'Sign in'))));
  setTimeout(() => (canPk ? null : pw.focus()), 50);
  void $;
}
