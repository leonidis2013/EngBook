// EngBook — first-time "Getting started" checklist on the Home screen.
// Steps tick themselves off when EngBook can tell they're done.
// Copyright (c) 2026 Jerod Ulicki
import { h, modal, askText, toast } from './util.js';
import { icon } from './icons.js';
import { api, passkeysSupported } from './api.js';
import { addPasskey } from './auth-ui.js';
import { openLearn } from './learn.js';
import { openSettings } from './settings-ui.js';
import { printTestRuler } from './export.js';
import { styleEditor } from './page-settings.js';

const flag = (app, k) => !!(app.prefs.get('onb') || {})[k];
export function markDone(app, k) {
  const o = app.prefs.get('onb') || {};
  if (!o[k]) app.prefs.set('onb', { ...o, [k]: true });
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function steps(app, facts) {
  return [
    { k: 'install', title: 'Put EngBook on your Home Screen', sub: 'Opens full screen, works offline, keeps your notes safe from Safari clean-ups.',
      done: isStandalone() || flag(app, 'install'), action: 'How', run: () => installHelp(app) },
    { k: 'passkey', title: 'Sign in with Face ID', sub: 'Add a passkey on this device so you never type the password here.',
      done: facts.passkeys > 0, action: 'Add passkey', hide: !passkeysSupported(),
      run: async () => { try { await addPasskey(); toast('Passkey added', 'ok'); app.renderHome(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled' : e.message, 'error'); } } },
    { k: 'name', title: 'Your name for title blocks', sub: 'Fills "Drawn by" on new pages.',
      done: !!app.prefs.get('drawnBy'), action: 'Set name',
      run: async () => { const v = await askText('Your name for title blocks', app.prefs.get('drawnBy') || '', { placeholder: 'e.g. J. Smith' }); if (v) { app.prefs.set('drawnBy', v); app.renderHome(); } } },
    { k: 'style', title: 'Pick your lettering and paper', sub: 'Uppercase engineering lettering and engineering graph paper are set up by default.',
      done: flag(app, 'style'), action: 'Choose', run: () => styleChooser(app) },
    { k: 'train', title: 'Teach EngBook your handwriting', sub: 'About 8 minutes. Makes cleanup and practice fit your hand.',
      done: facts.samples >= 30, action: 'Start', run: () => openLearn(app) },
    { k: 'pencil', title: 'Learn the Pencil and finger moves', sub: 'Two-finger tap undo, tool wheel, quick eraser, lasso and snap.',
      done: flag(app, 'pencil'), action: 'Show me', run: () => pencilSheet(app) },
    { k: 'snap', title: 'Draw something to scale', sub: 'Hold the pencil at the end of a line to snap it, then tap it with the ↔ tool to dimension it.',
      done: flag(app, 'snap'), action: 'Try it', run: () => app.quickNote() },
    { k: 'ruler', title: 'Check your printer scale', sub: 'Prints a 4 in and 100 mm ruler so printed drawings measure true.',
      done: flag(app, 'ruler'), action: 'Print', run: () => { markDone(app, 'ruler'); printTestRuler(); app.renderHome(); } },
    { k: 'backup', title: 'Make sure backups are on', sub: 'Snapshot the engbook-data volume on TrueNAS, and keep a JSON export now and then.',
      done: flag(app, 'backup'), action: 'Done', run: () => { markDone(app, 'backup'); app.renderHome(); } },
  ].filter((s) => !s.hide);
}

let factsCache = null;
async function facts() {
  if (factsCache && Date.now() - factsCache.at < 15000) return factsCache;
  const out = { passkeys: 0, samples: 0, at: Date.now() };
  try { out.passkeys = (await api('GET', '/api/auth/account')).passkeys.length; } catch {}
  try { out.samples = (await api('GET', '/api/learn/samples')).length; } catch {}
  factsCache = out;
  return out;
}
export function refreshFacts() { factsCache = null; }

/** The checklist card for the Home screen (or null when hidden / complete and dismissed). */
export function checklistCard(app) {
  if (flag(app, 'hidden')) return null;
  const card = h('section', { class: 'onb-card' }, h('p', { class: 'muted' }, 'Loading…'));
  facts().then((f) => {
    const list = steps(app, f);
    const done = list.filter((s) => s.done).length;
    card.replaceChildren(
      h('div', { class: 'onb-head' },
        h('div', {}, h('h2', {}, 'Getting started'), h('p', { class: 'muted small' }, `${done} of ${list.length} done`)),
        h('button', { class: 'btn ghost sm', onclick: () => { markDone(app, 'hidden'); app.renderHome(); } }, done === list.length ? 'Close' : 'Hide')),
      h('span', { class: 'set-bar' }, h('i', { style: { width: `${(done / list.length) * 100}%` } })),
      h('ol', { class: 'onb-list' }, list.map((s) => h('li', { class: s.done ? 'done' : '' },
        h('span', { class: 'onb-check' }, s.done ? icon('check') : null),
        h('div', { class: 'grow' }, h('b', {}, s.title), h('small', { class: 'muted' }, s.sub)),
        s.done ? null : h('button', { class: 'btn ghost sm', onclick: () => s.run() }, s.action)))));
  });
  return card;
}

function installHelp(app) {
  const m = modal('Add EngBook to your Home Screen', h('div', { class: 'stack' },
    h('ol', { class: 'steps' },
      h('li', {}, 'Open EngBook in Safari (not inside another app).'),
      h('li', {}, 'Tap the Share button (square with an up arrow).'),
      h('li', {}, 'Choose Add to Home Screen, then Add.'),
      h('li', {}, 'Open EngBook from the new icon from now on.')),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { markDone(app, 'install'); m.close(); app.renderHome(); } }, 'I did it'))));
}

function styleChooser(app) {
  const p = app.prefs;
  const seg = (value, options, onChange) => {
    const wrap = h('div', { class: 'seg' });
    const draw = (v) => wrap.replaceChildren(...Object.entries(options).map(([k, l]) => h('button', { type: 'button', class: k === v ? 'on' : '', onclick: () => { onChange(k); draw(k); } }, l)));
    draw(value); return wrap;
  };
  const m = modal('Lettering and paper', h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Lettering style'), seg(p.get('lettering'), { upper: 'Uppercase engineering', mixed: 'Everyday handwriting' }, (v) => p.set('lettering', v))),
    h('p', { class: 'muted small' }, 'Uppercase engineering lettering gets crisp strokes, upright letters and even heights.'),
    h('h3', {}, 'Default paper for new pages'),
    styleEditor(p.get('defaultStyle'), (s) => p.set('defaultStyle', s), { showTitleBlock: false }),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { markDone(app, 'style'); m.close(); app.renderHome(); } }, 'Done'))), { wide: true });
}

export function pencilSheet(app) {
  const row = (a, b) => h('tr', {}, h('td', {}, a), h('td', { class: 'muted' }, b));
  const m = modal('Pencil and finger moves', h('div', { class: 'stack' },
    h('table', { class: 'cheat' }, h('tbody', {},
      row('Apple Pencil', 'Writes and draws (pressure and tilt shape the line)'),
      row('One finger', 'Moves the page'),
      row('Pinch', 'Zooms'),
      row('Double-tap (finger)', 'Zoom in / fit page'),
      row('Two-finger tap', 'Undo'),
      row('Three-finger tap', 'Redo'),
      row('Long-press (finger)', 'Tool wheel: pens, eraser, colors'),
      row('Hold eraser button', 'Erase while held, let go to keep writing'),
      row('Hold Pencil at end of a stroke', 'Snap it into a clean shape'),
      row('Lasso tool', 'Circle things, then drag, recolor, duplicate or delete'),
      row('↔ tool', 'Tap a shape to dimension it; tap a dimension to type a real size'),
      row('Grip on the tool strip', 'Drag the strip anywhere; double-tap to put it back'))),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { markDone(app, 'pencil'); m.close(); app.renderHome(); } }, 'Got it'))));
  void openSettings;
}
