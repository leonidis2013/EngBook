// EngBook — small DOM and UI helpers.
// Copyright (c) 2026 Jerod Ulicki

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class: 'x', onclick: fn}, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function uid() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, kind = 'info', ms = 3200) {
  let host = $('#toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Show a modal. Returns { el, close }. */
export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => { back.remove(); onClose?.(); };
  const back = h('div', { class: 'modal-back', onpointerdown: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, html: ICON_X })),
      h('div', { class: 'modal-body' }, body)));
  document.body.append(back);
  return { el: back, close };
}

const ICON_X = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function askText(title, value = '', { placeholder = '', okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder, maxlength: 120 });
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); finish(input.value.trim()); } },
      input,
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, okLabel)));
    const m = modal(title, form, { onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function confirmBox(title, message, { okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okLabel)));
    const m = modal(title, body, { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

/** Small popover menu anchored to an element. items: [{label, onClick, danger}] or '-' */
export function menu(anchor, items) {
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'menu' }, items.map((it) => it === '-' ? h('div', { class: 'menu-sep' })
    : h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, onclick: () => { closeMenus(); it.onClick(); } }, it.label)));
  document.body.append(el);
  const mw = el.offsetWidth, mh = el.offsetHeight;
  el.style.left = `${Math.min(window.innerWidth - mw - 8, Math.max(8, r.left))}px`;
  el.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('pointerdown', onDoc, { once: false }), 0);
  function onDoc(e) { if (!el.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', onDoc); } }
  return el;
}

export function closeMenus() { $$('.menu').forEach((m) => m.remove()); }

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${fmtDate(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function download(filename, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
