// EngBook — handwriting learn mode.
// 1. Guided session: write each prompted character a few times; samples are saved to your server.
// 2. My letters: your best version of every character, with a consistency score.
// 3. Practice: trace over your own best version of your least consistent characters, and get a score.
// Copyright (c) 2026 Jerod Ulicki
import { h, toast, uid, confirmBox } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { traceStroke } from './ink.js';

export const SETS = {
  lower: { label: 'Lowercase a–z', chars: 'abcdefghijklmnopqrstuvwxyz'.split('') },
  upper: { label: 'Uppercase A–Z', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  digits: { label: 'Digits 0–9', chars: '0123456789'.split('') },
  symbols: { label: 'Engineering symbols', chars: ['Ω', 'µ', '°', '±', 'Δ', '√', 'Ø', '≈', '≤', '≥', '∞', 'π', '+', '−', '×', '÷', '=', '%', '/', '"', "'"] },
};
const REPS = 3;
const N = 48; // resample size

// ---------------------------------------------------------------- maths
function resample(strokes) {
  const pts = strokes.flat().map((p) => [p[0], p[1]]);
  if (pts.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const size = Math.max(maxX - minX, maxY - minY) || 1, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const norm = pts.map(([x, y]) => [(x - cx) / size, (y - cy) / size]);
  const seg = [0];
  for (let i = 1; i < norm.length; i++) seg.push(seg[i - 1] + Math.hypot(norm[i][0] - norm[i - 1][0], norm[i][1] - norm[i - 1][1]));
  const L = seg[seg.length - 1] || 1, out = [];
  let j = 0;
  for (let k = 0; k < N; k++) {
    const t = (k / (N - 1)) * L;
    while (j < seg.length - 2 && seg[j + 1] < t) j++;
    const f = (t - seg[j]) / ((seg[j + 1] - seg[j]) || 1);
    out.push([norm[j][0] + (norm[j + 1][0] - norm[j][0]) * f, norm[j][1] + (norm[j + 1][1] - norm[j][1]) * f]);
  }
  return out;
}
const pathDist = (a, b) => a.reduce((s, p, i) => s + Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), 0) / a.length;
const score = (d) => Math.max(0, Math.min(100, Math.round(100 - d * 260)));

/** Stats for one character: best sample (closest to the average) and a 0–100 consistency score. */
export function charStats(samples) {
  const rs = samples.map((s) => ({ s, r: resample(s.strokes) })).filter((x) => x.r);
  if (!rs.length) return null;
  const mean = rs[0].r.map((_, i) => [rs.reduce((a, x) => a + x.r[i][0], 0) / rs.length, rs.reduce((a, x) => a + x.r[i][1], 0) / rs.length]);
  let best = rs[0], bd = Infinity, total = 0;
  for (const x of rs) { const d = pathDist(x.r, mean); total += d; if (d < bd) { bd = d; best = x; } }
  return { count: rs.length, best: best.s, bestR: best.r, consistency: rs.length > 1 ? score(total / rs.length) : null };
}

// ---------------------------------------------------------------- writing box
/** A square box you write one character in. Returns { el, strokes(), clear(), setGuide(strokes) }. */
function writingBox(size = 200, { onStroke } = {}) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = h('canvas', { class: 'learn-canvas', width: size * dpr, height: size * dpr, style: { width: `${size}px`, height: `${size}px` } });
  const ctx = c.getContext('2d');
  let strokes = [], cur = null, guide = null, pid = null;
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#fdfdfb'; ctx.fillRect(0, 0, size, size);
    // guide lines: baseline, x-height, cap height
    ctx.strokeStyle = 'rgba(56,132,186,0.35)'; ctx.lineWidth = 1;
    for (const [y, dash] of [[size * 0.75, []], [size * 0.45, [4, 4]], [size * 0.2, [2, 6]]]) { ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(size - 8, y); ctx.stroke(); }
    ctx.setLineDash([]);
    if (guide) {
      ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = '#1d4ed8';
      for (const st of guide) { const p = new Path2D(); traceStroke(p, { tool: 'tech', width: 0.9, pts: st }); ctx.fill(p); }
      ctx.restore();
    }
    ctx.fillStyle = '#111';
    for (const st of strokes.concat(cur ? [cur] : [])) { const p = new Path2D(); traceStroke(p, { tool: 'fineliner', width: 0.7, pts: st }); ctx.fill(p); }
  };
  const pos = (e) => { const r = c.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * 100) / 100, Math.round((e.clientY - r.top) * 100) / 100, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5]; };
  c.addEventListener('pointerdown', (e) => { if (pid != null) return; pid = e.pointerId; c.setPointerCapture(e.pointerId); cur = [pos(e)]; draw(); e.preventDefault(); });
  c.addEventListener('pointermove', (e) => { if (e.pointerId !== pid || !cur) return; for (const ev of (e.getCoalescedEvents?.() || [e])) cur.push(pos(ev)); draw(); });
  const up = (e) => { if (e.pointerId !== pid) return; pid = null; if (cur && cur.length) strokes.push(cur); cur = null; draw(); onStroke?.(); };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  for (const t of ['touchstart', 'touchmove']) c.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  draw();
  return {
    el: c,
    strokes: () => strokes.map((s) => s.map((p) => [p[0] / size * 100, p[1] / size * 100, p[2]].map((v) => Math.round(v * 100) / 100))),
    clear: () => { strokes = []; cur = null; draw(); },
    setGuide: (sample) => { guide = sample ? sample.map((s) => s.map((p) => [p[0] / 100 * size, p[1] / 100 * size, p[2]])) : null; draw(); },
    empty: () => !strokes.length,
  };
}

/** Small rendering of a sample for the letter sheet. */
function sampleThumb(strokes, size = 64, color = '#111') {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = h('canvas', { width: size * dpr, height: size * dpr, style: { width: `${size}px`, height: `${size}px` } });
  const ctx = c.getContext('2d'); ctx.setTransform(dpr * size / 100, 0, 0, dpr * size / 100, 0, 0);
  ctx.fillStyle = color;
  for (const st of strokes || []) { const p = new Path2D(); traceStroke(p, { tool: 'tech', width: 1.4, pts: st }); ctx.fill(p); }
  return c;
}

// ---------------------------------------------------------------- screen
export async function openLearn(app) {
  let samples = [];
  const load = async () => { try { samples = await api('GET', '/api/learn/samples'); } catch (e) { toast(e.message, 'error'); } };
  const byChar = () => { const m = new Map(); for (const s of samples) { if (!m.has(s.ch)) m.set(s.ch, []); m.get(s.ch).push(s); } return m; };

  const body = h('div', { class: 'learn-body' });
  const tabs = h('div', { class: 'tabs learn-tabs' });
  const close = () => { screen.remove(); app.editor?.resize(); };
  const screen = h('div', { class: 'learn-screen' },
    h('div', { class: 'learn-head' }, h('span', { class: 'ic' }, icon('learn')), h('h2', {}, 'Handwriting training'), tabs, h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M18 6L6 18"/></svg>' })),
    body);
  document.body.append(screen);

  const show = async (tab) => {
    tabs.replaceChildren(...[['guided', 'Guided session'], ['sheet', 'My letters'], ['practice', 'Practice']].map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => show(k) }, l)));
    await load();
    body.replaceChildren(tab === 'guided' ? guidedStart() : tab === 'sheet' ? sheet() : practice());
  };

  // ---- guided session ----
  function guidedStart() {
    const counts = byChar();
    return h('div', { class: 'learn-pane stack' },
      h('p', { class: 'muted' }, `Write each character ${REPS} times the way you normally do. About 10 minutes for everything. Your samples stay on your server and feed the consistency scores, practice drills and future cleanup.`),
      h('div', { class: 'set-grid' }, Object.entries(SETS).map(([k, set]) => {
        const done = set.chars.filter((c) => (counts.get(c) || []).length >= REPS).length;
        return h('button', { class: 'set-card', onclick: () => body.replaceChildren(guided(set.chars)) },
          h('span', { class: 'set-name' }, set.label), h('span', { class: 'mono muted' }, `${done} / ${set.chars.length} done`),
          h('span', { class: 'set-bar' }, h('i', { style: { width: `${(done / set.chars.length) * 100}%` } })));
      })),
      h('button', { class: 'btn primary', onclick: () => body.replaceChildren(guided(Object.values(SETS).flatMap((s) => s.chars))) }, 'Start full session'));
  }

  function guided(chars) {
    let i = 0;
    const pane = h('div', { class: 'learn-pane stack' });
    const step = () => {
      if (i >= chars.length) { pane.replaceChildren(h('h3', {}, 'Session complete'), h('p', {}, `Saved ${chars.length * REPS} samples.`), h('button', { class: 'btn primary', onclick: () => show('sheet') }, 'See my letters')); return; }
      const ch = chars[i];
      const size = Math.min(220, Math.floor((Math.min(window.innerWidth, 900) - 80) / REPS));
      const boxes = Array.from({ length: REPS }, () => writingBox(size));
      const save = async () => {
        if (boxes.some((b) => b.empty())) { toast(`Write "${ch}" in all ${REPS} boxes first.`, 'warn'); return; }
        try {
          await api('POST', '/api/learn/samples', { samples: boxes.map((b) => ({ id: uid(), ch, strokes: b.strokes(), source: 'guided' })) });
          i++; step();
        } catch (e) { toast(e.message, 'error'); }
      };
      pane.replaceChildren(
        h('div', { class: 'row gap' }, h('span', { class: 'mono muted' }, `${i + 1} / ${chars.length}`), h('span', { class: 'set-bar grow' }, h('i', { style: { width: `${(i / chars.length) * 100}%` } }))),
        h('div', { class: 'prompt' }, h('span', { class: 'prompt-char' }, ch), h('span', { class: 'muted' }, `Write "${ch}" ${REPS} times`)),
        h('div', { class: 'box-row' }, boxes.map((b) => b.el)),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => boxes.forEach((b) => b.clear()) }, 'Clear'),
          h('button', { class: 'btn ghost', onclick: () => { i++; step(); } }, 'Skip'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn primary', onclick: save }, 'Save & next')));
    };
    step();
    return pane;
  }

  // ---- my letters ----
  function sheet() {
    const m = byChar();
    if (!m.size) return h('div', { class: 'learn-pane' }, h('p', { class: 'muted' }, 'No samples yet. Start a guided session first.'));
    const all = Object.values(SETS).flatMap((s) => s.chars);
    const cells = [];
    let sum = 0, n = 0;
    for (const ch of all) {
      const list = m.get(ch);
      if (!list) continue;
      const st = charStats(list);
      if (!st) continue;
      if (st.consistency != null) { sum += st.consistency; n++; }
      const cls = st.consistency == null ? '' : st.consistency >= 80 ? 'good' : st.consistency >= 60 ? 'ok' : 'low';
      cells.push(h('button', { class: `glyph ${cls}`, onclick: () => detail(ch, list) },
        h('span', { class: 'glyph-ch mono' }, ch), sampleThumb(st.best.strokes, 64),
        h('span', { class: 'glyph-score mono' }, st.consistency == null ? `${st.count}×` : `${st.consistency}%`)));
    }
    return h('div', { class: 'learn-pane stack' },
      h('p', { class: 'muted' }, `Your most typical version of each character. The score shows how alike your samples are (100% = identical every time).${n ? ` Overall: ${Math.round(sum / n)}%.` : ''}`),
      h('div', { class: 'glyph-grid' }, cells),
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        if (await confirmBox('Delete all handwriting samples?', 'Your letter sheet and scores will start over.')) { await api('DELETE', '/api/learn/samples'); show('sheet'); }
      } }, 'Delete all samples')));
  }

  function detail(ch, list) {
    body.replaceChildren(h('div', { class: 'learn-pane stack' },
      h('div', { class: 'row gap' }, h('button', { class: 'btn ghost sm', onclick: () => show('sheet') }, '← Letters'), h('span', { class: 'prompt-char sm' }, ch), h('span', { class: 'muted' }, `${list.length} samples`)),
      h('div', { class: 'glyph-grid' }, list.map((s) => h('div', { class: 'glyph' }, sampleThumb(s.strokes, 80),
        h('span', { class: 'muted small' }, s.source),
        h('button', { class: 'btn ghost sm danger-text', onclick: async () => { await api('DELETE', `/api/learn/samples/${s.id}`); await load(); const rest = byChar().get(ch) || []; rest.length ? detail(ch, rest) : show('sheet'); } }, 'Remove')))),
      h('button', { class: 'btn primary', onclick: () => body.replaceChildren(guided([ch])) }, `Add more "${ch}" samples`)));
  }

  // ---- practice ----
  function practice() {
    const m = byChar();
    const ranked = [...m.entries()].map(([ch, list]) => ({ ch, st: charStats(list) })).filter((x) => x.st && x.st.consistency != null)
      .sort((a, b) => a.st.consistency - b.st.consistency);
    if (!ranked.length) return h('div', { class: 'learn-pane' }, h('p', { class: 'muted' }, 'Practice needs at least two samples of a character. Do a guided session first.'));
    const queue = ranked.slice(0, 8);
    let i = 0;
    const pane = h('div', { class: 'learn-pane stack' });
    const step = () => {
      const { ch, st } = queue[i % queue.length];
      const box = writingBox(Math.min(280, window.innerWidth - 60));
      box.setGuide(st.best.strokes);
      const result = h('div', { class: 'practice-score mono' }, '—');
      const check = async () => {
        if (box.empty()) return;
        const r = resample(box.strokes());
        const s = r ? score(pathDist(r, st.bestR)) : 0;
        result.textContent = `${s}`;
        result.className = `practice-score mono ${s >= 80 ? 'good' : s >= 60 ? 'ok' : 'low'}`;
        if (s >= 70) { try { await api('POST', '/api/learn/samples', { samples: [{ id: uid(), ch, strokes: box.strokes(), source: 'practice' }] }); } catch {} }
      };
      pane.replaceChildren(
        h('p', { class: 'muted' }, `Your least consistent characters, weakest first. Write over the faint guide (your own best "${ch}"), then check your score. Scores of 70 or more are saved as new samples.`),
        h('div', { class: 'prompt' }, h('span', { class: 'prompt-char' }, ch), h('span', { class: 'muted' }, `consistency ${st.consistency}%`)),
        h('div', { class: 'row gap wrap' }, box.el, h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Score'), result)),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => { box.clear(); result.textContent = '—'; result.className = 'practice-score mono'; } }, 'Again'),
          h('button', { class: 'btn primary', onclick: check }, 'Check'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn ghost', onclick: () => { i++; step(); } }, 'Next letter')));
    };
    step();
    return pane;
  }

  show('guided');
}
