// EngBook — device preferences and the Settings window (preferences, account, data).
// Copyright (c) 2026 Jerod Ulicki
import { h, modal, toast, confirmBox, fmtDateTime, download } from './util.js';
import { api, passkeysSupported } from './api.js';
import { addPasskey } from './auth-ui.js';
import { styleEditor } from './page-settings.js';
import { printTestRuler } from './export.js';

const DEFAULTS = {
  presets: [
    { tool: 'fineliner', color: '#111111', width: 0.5 },
    { tool: 'tech', color: '#1d4ed8', width: 0.35 },
    { tool: 'pencil', color: '#4b5563', width: 0.7 },
    { tool: 'redline', color: '#dc2626', width: 0.5 },
    { tool: 'highlighter', color: '#f59e0b', width: 5 },
  ],
  activePreset: 0,
  recentColors: [],
  fingerDraw: null, // null = automatic (on for phones)
  touchMode: 'nav',  // phones: 'nav' = one finger moves the page, 'draw' = one finger draws
  stripSide: 'right',
  units: 'in',
  theme: 'auto',
  drawnBy: '',
  cleanup: { on: true, smooth: 0.5, straighten: true },
  snap: { on: true, grid: true, angle: true, ends: true },
  defaultStyle: { type: 'graph', size: 'letter', tone: 'paper', graph: '5' },
};

export class Prefs extends EventTarget {
  constructor() {
    super();
    try { this.v = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('eb.prefs') || '{}') }; } catch { this.v = { ...DEFAULTS }; }
  }
  get(k) {
    if (k === 'fingerDraw' && this.v.fingerDraw == null) return matchMedia('(max-width: 700px)').matches;
    return this.v[k];
  }
  set(k, val) {
    this.v[k] = val;
    localStorage.setItem('eb.prefs', JSON.stringify(this.v));
    this.dispatchEvent(new CustomEvent('change', { detail: { key: k } }));
  }
}

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
const seg = (value, options, onChange) => {
  const wrap = h('div', { class: 'seg' });
  const draw = (v) => wrap.replaceChildren(...Object.entries(options).map(([k, l]) => h('button', { type: 'button', class: String(k) === String(v) ? 'on' : '', onclick: () => { onChange(k); draw(k); } }, l)));
  draw(value);
  return wrap;
};

export function openSettings(app, tab = 'prefs') {
  const body = h('div', { class: 'settings' });
  const tabs = h('div', { class: 'tabs' });
  const show = (t) => {
    tab = t;
    tabs.replaceChildren(...[['prefs', 'Preferences'], ['account', 'Sign-in & security'], ['data', 'Data']].map(([k, l]) => h('button', { class: k === t ? 'on' : '', onclick: () => show(k) }, l)));
    panel.replaceChildren(t === 'prefs' ? prefsPanel(app) : t === 'account' ? accountPanel(app) : dataPanel(app));
  };
  const panel = h('div', { class: 'tab-panel' });
  body.append(tabs, panel);
  modal('Settings', body, { wide: true });
  show(tab);
}

function prefsPanel(app) {
  const p = app.prefs;
  const c = p.get('cleanup');
  const setClean = (patch) => p.set('cleanup', { ...p.get('cleanup'), ...patch });
  let newStyle = p.get('defaultStyle');
  return h('div', { class: 'stack' },
    h('h3', {}, 'Pencil and touch'),
    field('Finger drawing', seg(p.v.fingerDraw == null ? 'auto' : p.v.fingerDraw ? 'on' : 'off', { auto: 'Auto (phones)', on: 'On', off: 'Off' },
      (v) => { p.set('fingerDraw', v === 'auto' ? null : v === 'on'); app.editor.buildStrip(); }), 'Adds a move / draw switch to the tool strip. With Apple Pencil, fingers always move and zoom.'),
    field('Tool strip side', seg(p.get('stripSide'), { left: 'Left', right: 'Right' }, (v) => { p.set('stripSide', v); app.editor.updateStrip(); }), 'Put it under your free hand.'),
    h('h3', {}, 'Handwriting cleanup'),
    h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: c.on, onchange: (e) => setClean({ on: e.target.checked }) }), 'Clean up handwriting as I write'),
    field('Smoothing', h('input', { type: 'range', class: 'range', min: 0, max: 1, step: 0.1, value: c.smooth, oninput: (e) => setClean({ smooth: Number(e.target.value) }) }), 'Light → Neat'),
    h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: c.straighten, onchange: (e) => setClean({ straighten: e.target.checked }) }), 'Straighten slanted words'),
    h('p', { class: 'muted small' }, 'Your original strokes are always kept. Use "Compare original" in the page menu to see them.'),
    h('h3', {}, 'Snap (engineering drawings)'),
    h('p', { class: 'muted small' }, 'Draw a shape and hold the pencil still for half a second to snap it clean. Handwriting is never snapped.'),
    ...[['on', 'Snap shapes when I hold the pencil'], ['grid', 'Snap to grid points'], ['angle', 'Snap lines to 15° steps'], ['ends', 'Snap to ends, corners and centers of other shapes']].map(([k, label]) =>
      h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: p.get('snap')[k], onchange: (e) => { p.set('snap', { ...p.get('snap'), [k]: e.target.checked }); app.editor.updateStrip(); } }), label)),
    h('h3', {}, 'Display'),
    field('Theme', seg(p.get('theme'), { auto: 'Match iPad', dark: 'Dark', light: 'Light' }, (v) => { p.set('theme', v); app.applyTheme(); })),
    field('Units', seg(p.get('units'), { in: 'Inches', mm: 'Millimeters' }, (v) => { p.set('units', v); app.editor.updateReadout(); app.editor.render(); }), 'Also used for dimensions.'),
    field('Your name for title blocks', h('input', { class: 'input', value: p.get('drawnBy'), placeholder: 'Drawn by', oninput: (e) => p.set('drawnBy', e.target.value) })),
    h('h3', {}, 'Default style for new pages'),
    h('p', { class: 'muted small' }, 'Notebooks and sections can override this.'),
    styleEditor(newStyle, (s) => { newStyle = s; p.set('defaultStyle', s); }, { showTitleBlock: false }),
  );
}

function accountPanel(app) {
  const wrap = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const load = async () => {
    let a;
    try { a = await api('GET', '/api/auth/account'); } catch (e) { wrap.replaceChildren(h('p', { class: 'form-error' }, e.message)); return; }
    const pkList = h('div', { class: 'stack tight' }, a.passkeys.length ? a.passkeys.map((k) => h('div', { class: 'row gap item-row' },
      h('span', { class: 'grow' }, k.name, h('small', { class: 'muted mono' }, ` added ${fmtDateTime(k.created_at)}${k.last_used_at ? `, last used ${fmtDateTime(k.last_used_at)}` : ''}`)),
      h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        if (await confirmBox('Remove passkey?', `"${k.name}" will no longer sign in.`, { okLabel: 'Remove' })) { await api('DELETE', `/api/auth/passkeys/${k.id}`); load(); }
      } }, 'Remove'))) : h('p', { class: 'muted' }, 'No passkeys yet.'));
    const cur = h('input', { class: 'input', type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const code = h('input', { class: 'input mono', placeholder: 'Authenticator code', autocomplete: 'one-time-code' });
    const next = h('input', { class: 'input', type: 'password', placeholder: 'New password (10+ characters)', autocomplete: 'new-password' });
    const rcCode = h('input', { class: 'input mono', placeholder: 'Authenticator code', autocomplete: 'one-time-code' });
    wrap.replaceChildren(
      h('h3', {}, 'Passkeys (Face ID)'),
      pkList,
      passkeysSupported() ? h('button', { class: 'btn primary', onclick: async () => {
        try { await addPasskey(); toast('Passkey added', 'ok'); load(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled' : e.message, 'error'); }
      } }, 'Add a passkey on this device') : h('p', { class: 'muted small' }, 'Passkeys need HTTPS (or localhost) and a supported browser.'),
      h('h3', {}, 'Change password'),
      h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/auth/password', { current: cur.value, code: code.value.trim(), next: next.value }); toast('Password changed', 'ok'); cur.value = code.value = next.value = ''; }
        catch (x) { toast(x.message, 'error'); }
      } }, cur, code, next, h('button', { class: 'btn ghost' }, 'Change password')),
      h('h3', {}, 'Recovery codes'),
      h('p', { class: `small ${a.recoveryLeft <= 2 ? 'warn-text' : 'muted'}` }, `${a.recoveryLeft} of 8 unused.`),
      h('form', { class: 'row gap', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/api/auth/recovery-codes', { code: rcCode.value.trim() });
          download('engbook-recovery-codes.txt', new Blob([`EngBook recovery codes\n\n${r.recoveryCodes.join('\n')}\n`], { type: 'text/plain' }));
          toast('New recovery codes downloaded. Old ones no longer work.', 'ok', 5000); load();
        } catch (x) { toast(x.message, 'error'); }
      } }, rcCode, h('button', { class: 'btn ghost' }, 'New codes')),
      h('h3', {}, 'Sessions'),
      h('div', { class: 'row gap' }, h('span', { class: 'muted grow' }, `${a.sessions} signed-in device${a.sessions === 1 ? '' : 's'}`),
        h('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmBox('Sign out everywhere?', 'Every device, including this one, will need to sign in again.', { okLabel: 'Sign out all' })) { await api('POST', '/api/auth/logout-all'); location.reload(); } } }, 'Sign out everywhere')),
      h('h3', {}, 'Sign-in log'),
      h('div', { class: 'log mono' }, a.log.map((l) => h('div', { class: `log-row ${l.ok ? '' : 'bad'}` },
        h('span', {}, fmtDateTime(l.at)), h('span', {}, l.method), h('span', {}, l.ok ? 'ok' : 'failed'), h('span', { class: 'muted' }, l.ip), h('span', { class: 'muted' }, l.detail || '')))),
    );
  };
  load();
  return wrap;
}

function dataPanel(app) {
  return h('div', { class: 'stack' },
    h('h3', {}, 'Export'),
    h('p', { class: 'muted' }, 'Everything (notebooks, sections, pages and ink) as one JSON file.'),
    h('a', { class: 'btn ghost', href: '/api/export', download: true }, 'Download full export'),
    h('h3', {}, 'Printing'),
    h('p', { class: 'muted' }, 'Print this once to check your printer is set to 100% so grids measure true.'),
    h('button', { class: 'btn ghost', onclick: () => printTestRuler() }, 'Print test ruler'),
    h('h3', {}, 'This device'),
    h('p', { class: 'muted small' }, `Changes waiting to sync: ${app.store.pending}`),
    h('button', { class: 'btn ghost', onclick: async () => {
      if (app.store.pending) { toast('Wait until everything has synced first.', 'warn'); return; }
      if (await confirmBox('Clear cached notes on this device?', 'Your notes stay on the server and download again.', { okLabel: 'Clear cache', danger: false })) { await app.store.clearLocal(); location.reload(); }
    } }, 'Clear offline cache'),
    h('h3', {}, 'About'),
    h('p', { class: 'muted mono small' }, `EngBook v${app.version} · © 2026 Jerod Ulicki`),
  );
}
