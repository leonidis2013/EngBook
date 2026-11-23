// EngBook — page style editor (used for pages, sections and notebook defaults).
// Copyright (c) 2026 Jerod Ulicki
import { h } from './util.js';
import { PAGE_STYLES, PAGE_SIZES, TONES, styleOf } from './backgrounds.js';
import { SCALES } from './dims.js';

function select(value, options, onChange) {
  return h('select', { class: 'input', onchange: (e) => onChange(e.target.value) },
    Object.entries(options).map(([k, label]) => h('option', { value: k, selected: k === value }, label)));
}

function seg(value, options, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [k, label] of Object.entries(options)) {
    wrap.append(h('button', { type: 'button', class: k === value ? 'on' : '', onclick: () => onChange(k) }, label));
  }
  return wrap;
}

const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);

/** Render a style editor. onChange receives the full new style object. */
export function styleEditor(style, onChange, { showTitleBlock = true } = {}) {
  let s = styleOf(style);
  const root = h('div', { class: 'stack style-editor' });
  const set = (patch) => { s = { ...s, ...patch }; onChange(s); draw(); };
  const setTb = (k, v) => { s = { ...s, tb: { ...s.tb, [k]: v } }; onChange(s); };

  function draw() {
    root.replaceChildren(...[
      field('Page style', select(s.type, PAGE_STYLES, (v) => set({ type: v }))),
      s.type === 'lined' ? field('Ruling', seg(s.ruling, { narrow: 'Narrow', college: 'College', wide: 'Wide' }, (v) => set({ ruling: v }))) : null,
      s.type === 'lined' ? h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: s.margin, onchange: (e) => set({ margin: e.target.checked }) }), 'Margin line') : null,
      s.type === 'graph' ? field('Grid', seg(String(s.graph), { 4: '4 / in', 5: '5 / in', 10: '10 / in', '5mm': '5 mm' }, (v) => set({ graph: v }))) : null,
      s.type === 'semilog' ? field('Decades', seg(String(s.decades), { 1: '1', 2: '2', 3: '3', 4: '4' }, (v) => set({ decades: Number(v) }))) : null,
      field('Size', select(s.size, Object.fromEntries(Object.entries(PAGE_SIZES).map(([k, v]) => [k, v.label])), (v) => set({ size: v }))),
      s.size !== 'endless' ? field('Orientation', seg(s.orient, { portrait: 'Portrait', landscape: 'Landscape' }, (v) => set({ orient: v }))) : null,
      field('Page tone', seg(s.tone, TONES, (v) => set({ tone: v }))),
      field('Drawing scale', select(s.scale || '1:1', Object.fromEntries(Object.entries(SCALES).map(([k, v]) => [k, v.label])), (v) => set({ scale: v }))),
      s.size !== 'endless' && !s.titleBlock && s.type !== 'calc' ? h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: s.pageNumbers !== false, onchange: (e) => set({ pageNumbers: e.target.checked }) }), 'Page number at the bottom') : null,
      field('Grid strength', h('input', { type: 'range', min: 0.3, max: 1.5, step: 0.1, value: s.grid ?? 1, class: 'range', oninput: (e) => { s = { ...s, grid: Number(e.target.value) }; onChange(s); } })),
      showTitleBlock && s.size !== 'endless' && s.type !== 'calc'
        ? h('label', { class: 'row gap toggle-row' }, h('input', { type: 'checkbox', checked: s.titleBlock, onchange: (e) => set({ titleBlock: e.target.checked }) }), 'Border and title block') : null,
      showTitleBlock && (s.titleBlock || s.type === 'calc') && s.size !== 'endless' ? h('div', { class: 'tb-fields' },
        ...[['project', 'Project'], ['title', s.type === 'calc' ? 'Subject' : 'Title'], ['drawnBy', s.type === 'calc' ? 'By' : 'Drawn by'], ['date', 'Date'],
          ...(s.type === 'calc' ? [] : [['rev', 'Rev'], ['sheet', 'Sheet']])]
          .map(([k, label]) => field(label, h('input', { class: 'input', value: s.tb[k] || '', oninput: (e) => setTb(k, e.target.value) })))) : null,
    ].filter(Boolean));
  }
  draw();
  return root;
}
