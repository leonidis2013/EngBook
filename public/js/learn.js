// EngBook — handwriting learn mode.
// 1. Guided session: write each prompted character a few times; samples are saved to your server.
// 2. My letters: your best version of every character, with a consistency score.
// 3. Practice: trace over your own best version of your least consistent characters, and get a score.
// Copyright (c) 2026 Jerod Ulicki
import { h, toast, uid, confirmBox } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { traceStroke } from './ink.js';
import { measureSlant, cleanWord, straightenStroke } from './cleanup.js';

export const SETS = {
  lower: { label: 'Lowercase a–z', chars: 'abcdefghijklmnopqrstuvwxyz'.split('') },
  upper: { label: 'Uppercase A–Z', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  digits: { label: 'Digits 0–9', chars: '0123456789'.split('') },
  symbols: { label: 'Engineering symbols', chars: ['Ω', 'µ', '°', '±', 'Δ', '√', 'Ø', '≈', '≤', '≥', '∞', 'π', '+', '−', '×', '÷', '=', '%', '/', '"', "'"] },
  words: { label: 'Words & labels', words: true, chars: [] },
};
// Real labels you'd write on a drawing: teaches spacing, slant and letter height in context.
const WORDS_UPPER = ['48 VDC', 'QTY 4', 'Ø6.5 THRU', 'R12 TYP.', 'STAGE LEFT', 'CAT6 RUN', 'SEE DWG A-101', '±0.1 MM', 'NOTES:', 'MAX 20A', 'XLR TO TRS', 'REV B'];
const WORDS_MIXED = ['the quick fix', 'check wiring', 'Monday 9am', 'stage left', 'order 4 more', 'see page 12', 'mic 3 low', 'call back', 'budget $250', 'done'];
function setOrder(lettering) {
  return lettering === 'upper' ? ['upper', 'digits', 'words', 'symbols', 'lower'] : ['lower', 'upper', 'digits', 'words', 'symbols'];
}
const REPS = 3;
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
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

/** Your writing profile from all samples: average slant (+ = leaning right) and how steady it is. */
export function writingProfile(samples) {
  const sl = samples.map((s) => measureSlant(s.strokes)).filter((v) => isFinite(v) && v !== 0);
  if (sl.length < 3) return null;
  const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / sl.length);
  const words = samples.filter((s) => s.source === 'word');
  return { slant: Math.round(mean * 1000) / 1000, slantDeg: Math.round(Math.atan(mean) * 180 / Math.PI), steadiness: Math.max(0, Math.round(100 - sd * 300)), samples: samples.length, words: words.length };
}

// ---------------------------------------------------------------- writing box
/** A square box you write one character in. Returns { el, strokes(), clear(), setGuide(strokes) }. */
function writingBox(size = 110, { onStroke, width, upper = true } = {}) {
  const W = width || size;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = h('canvas', { class: 'learn-canvas', width: W * dpr, height: size * dpr, style: { width: `${W}px`, height: `${size}px` } });
  const ctx = c.getContext('2d');
  let strokes = [], cur = null, guide = null, pid = null;
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, size);
    ctx.fillStyle = '#fdfdfb'; ctx.fillRect(0, 0, W, size);
    // guide lines: baseline + cap height (uppercase) or baseline, x-height, cap height
    ctx.strokeStyle = 'rgba(56,132,186,0.35)'; ctx.lineWidth = 1;
    const lines = upper ? [[size * 0.78, []], [size * 0.22, [3, 5]]] : [[size * 0.75, []], [size * 0.45, [4, 4]], [size * 0.2, [2, 6]]];
    for (const [y, dash] of lines) { ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(W - 6, y); ctx.stroke(); }
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
    strokes: () => strokes.map((s) => s.map((p) => [p[0] / size * 100, p[1] / size * 100, p[2]].map((v) => Math.round(v * 100) / 100))), // height = 100 units
    clear: () => { strokes = []; cur = null; draw(); },
    setGuide: (sample) => { guide = sample ? sample.map((s) => s.map((p) => [p[0] / 100 * size, p[1] / 100 * size, p[2]])) : null; draw(); },
    empty: () => !strokes.length,
  };
}

/** Small rendering of a sample for the letter sheet. */
function sampleThumb(strokes, size = 64, color = '#111', width) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = width || size;
  const c = h('canvas', { width: W * dpr, height: size * dpr, style: { width: `${W}px`, height: `${size}px` } });
  const ctx = c.getContext('2d'); ctx.setTransform(dpr * size / 100, 0, 0, dpr * size / 100, 0, 0);
  ctx.fillStyle = color;
  for (const st of strokes || []) { const p = new Path2D(); traceStroke(p, { tool: 'tech', width: 1.4, pts: st }); ctx.fill(p); }
  return c;
}

// ---------------------------------------------------------------- screen
export async function openLearn(app) {
  let samples = [];
  const lettering = app.prefs.get('lettering') || 'upper';
  const words = () => (lettering === 'upper' ? WORDS_UPPER : WORDS_MIXED);
  const updateProfile = async () => { try { await load(); const pr = writingProfile(samples); if (pr) app.prefs.set('hwProfile', pr); } catch {} };
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
    tabs.replaceChildren(...[['train', 'Training'], ['sheet', 'My writing'], ['practice', 'Practice'], ['chars', 'Single characters']].map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => show(k) }, l)));
    await load();
    fill(body, tab === 'train' ? training() : tab === 'chars' ? guidedStart() : tab === 'sheet' ? sheet() : practice());
  };

  // ---- guided session ----
  function guidedStart() {
    const counts = byChar();
    return h('div', { class: 'learn-pane stack' },
      h('p', { class: 'muted' }, `Write each character ${REPS} times, then a few real labels, the way you normally do${lettering === 'upper' ? ' (uppercase engineering lettering)' : ''}. About 8 minutes. Samples stay on your server and tune the cleanup, scores and practice drills.`),
      h('div', { class: 'set-grid' }, setOrder(lettering).map((k) => {
        const set = SETS[k];
        if (set.words) {
          const list = words(); const done = list.filter((w) => (counts.get(w) || []).length >= 1).length;
          return h('button', { class: 'set-card', onclick: () => fill(body, wordSession(list)) },
            h('span', { class: 'set-name' }, set.label), h('span', { class: 'mono muted' }, `${done} / ${list.length} done`),
            h('span', { class: 'set-bar' }, h('i', { style: { width: `${(done / list.length) * 100}%` } })));
        }
        const done = set.chars.filter((c) => (counts.get(c) || []).length >= REPS).length;
        return h('button', { class: 'set-card', onclick: () => fill(body, guided(set.chars)) },
          h('span', { class: 'set-name' }, set.label + (k === 'lower' && lettering === 'upper' ? ' (optional)' : '')), h('span', { class: 'mono muted' }, `${done} / ${set.chars.length} done`),
          h('span', { class: 'set-bar' }, h('i', { style: { width: `${(done / set.chars.length) * 100}%` } })));
      })),
      h('button', { class: 'btn primary', onclick: () => {
        const keys = setOrder(lettering).filter((k) => !(k === 'lower' && lettering === 'upper') && !SETS[k].words);
        fill(body, guided(keys.flatMap((k) => SETS[k].chars), () => fill(body, wordSession(words()))));
      } }, 'Start full session'));
  }

  function guided(chars, onDone) {
    let i = 0;
    const pane = h('div', { class: 'learn-pane stack' });
    const step = () => {
      if (i >= chars.length && onDone) { onDone(); return; }
      if (i >= chars.length) { fill(pane, h('h3', {}, 'Session complete'), h('p', {}, `Saved ${chars.length * REPS} samples.`), h('button', { class: 'btn primary', onclick: () => show('sheet') }, 'See my letters')); return; }
      const ch = chars[i];
      const size = Math.max(84, Math.min(120, Math.floor((Math.min(window.innerWidth, 900) - 80) / REPS)));
      const boxes = Array.from({ length: REPS }, () => writingBox(size, { upper: lettering === 'upper' }));
      const save = async () => {
        if (boxes.some((b) => b.empty())) { toast(`Write "${ch}" in all ${REPS} boxes first.`, 'warn'); return; }
        try {
          await api('POST', '/api/learn/samples', { samples: boxes.map((b) => ({ id: uid(), ch, strokes: b.strokes(), source: 'guided' })) });
          i++; step(); updateProfile();
        } catch (e) { toast(e.message, 'error'); }
      };
      fill(pane, 
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

  // ---- guided training (sentences & problems) ----
  function training() {
    const upper = lettering === 'upper';
    const prompts = upper ? PROMPTS_UPPER : PROMPTS_MIXED;
    const used = new Set();
    let round = 0;
    const pane = h('div', { class: 'learn-pane stack' });
    const intro = () => {
      const cov = coverage(samples, upper);
      fill(pane, 
        h('h3', {}, 'Guided training'),
        h('p', {}, `You'll write short lines${upper ? ' in uppercase engineering lettering' : ''}: sentences, labels and quick calculations. After each line EngBook finds every letter, measures your slant, heights, baseline and spacing, shows what cleanup will do, and picks the next line to cover what it knows least.`),
        h('div', { class: 'train-meter' }, h('span', { class: 'muted small' }, 'Profile trained'), h('b', { class: 'mono' }, `${cov.pct}%`), h('span', { class: 'set-bar grow' }, h('i', { style: { width: `${cov.pct}%` } }))),
        h('p', { class: 'muted small' }, 'About 8–12 lines gets you to a full profile. Write at your normal size and speed; stop any time, progress is saved.'),
        h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => line() }, cov.pct ? 'Continue training' : 'Start training'),
          h('button', { class: 'btn ghost', onclick: () => show('chars') }, 'Single characters instead')));
    };
    const line = () => {
      const cov = coverage(samples, upper);
      const prompt = nextPrompt(prompts, cov, used);
      used.add(prompt); round++;
      const w = Math.min(880, window.innerWidth - 48);
      const strip = writingBox(120, { width: w, upper });
      fill(pane, 
        h('div', { class: 'row gap' }, h('span', { class: 'mono muted' }, `Line ${round}`), h('span', { class: 'set-bar grow' }, h('i', { style: { width: `${cov.pct}%` } })), h('span', { class: 'mono muted' }, `${cov.pct}% trained`)),
        h('div', { class: 'prompt-line mono' }, prompt),
        h('p', { class: 'muted small' }, 'Write the line above on the strip, the way you would on a drawing.'),
        strip.el,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => strip.clear() }, 'Clear'),
          h('button', { class: 'btn ghost', onclick: () => line() }, 'Different line'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn primary', onclick: () => { if (strip.empty()) { toast('Write the line first.', 'warn'); return; } review(prompt, strip.strokes(), w); } }, 'Done')));
    };
    const review = async (prompt, strokes, w) => {
      const seg = segmentLine(strokes, prompt);
      const m = lineMetrics(strokes, seg);
      const sl = (upper ? strokes.map((st) => straightenStroke(st, 0.7)) : strokes);
      const cleaned = cleanWord(sl, { strength: 0.8, upright: upper, targetSlant: upper ? null : (app.prefs.get('hwProfile')?.slant ?? null), equalize: upper, level: true }) || sl;
      const list = seg.glyphs.map((g) => {
        const cx = (g.box.x0 + g.box.x1) / 2;
        return { id: uid(), ch: g.ch, source: 'sentence', strokes: g.strokes.map((st) => st.map((p) => [Math.round((p[0] - cx + 50) * 100) / 100, p[1], p[2]])) };
      });
      list.push({ id: uid(), ch: prompt, source: 'word', strokes });
      try { await api('POST', '/api/learn/samples', { samples: list }); await updateProfile(); } catch (e) { toast(e.message, 'error'); }
      const hgt = 70, scaleW = Math.round(w * hgt / 120);
      const metric = (label, val, bad) => h('div', { class: `metric ${bad ? 'warn' : ''}` }, h('span', { class: 'muted small' }, label), h('b', { class: 'mono' }, val));
      const cov = coverage(samples, upper);
      fill(pane, 
        h('div', { class: 'row gap' }, h('span', { class: 'mono muted' }, `Line ${round} · ${seg.matched} of ${seg.total} letters found`), h('span', { class: 'set-bar grow' }, h('i', { style: { width: `${cov.pct}%` } })), h('span', { class: 'mono muted' }, `${cov.pct}% trained`)),
        h('div', { class: 'compare' },
          h('div', {}, h('span', { class: 'muted small' }, 'You wrote'), lineThumb(strokes, scaleW, hgt)),
          h('div', {}, h('span', { class: 'muted small' }, 'After cleanup'), lineThumb(cleaned, scaleW, hgt, '#1d4ed8'))),
        h('div', { class: 'metrics' },
          metric('Slant', m.slantDeg === 0 ? 'upright' : `${Math.abs(m.slantDeg)}° ${m.slantDeg > 0 ? 'R' : 'L'}`, upper && Math.abs(m.slantDeg) > 4),
          metric('Height variation', `${m.heightVar}%`, m.heightVar > 12),
          metric('Baseline drift', `${m.baseline}%`, m.baseline > 8),
          metric('Spacing variation', `${m.spacing}%`, m.spacing > 45)),
        h('ul', { class: 'tips' }, tipsFor(m, upper).map((t) => h('li', {}, t))),
        seg.matched < seg.total ? h('p', { class: 'muted small' }, 'Some letters touched or were split, so they were skipped. Leaving a little space between letters helps.') : null,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => { used.delete(prompt); round--; line(); } }, 'Redo this line'),
          h('button', { class: 'btn ghost', onclick: () => show('sheet') }, 'Finish'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn primary', onclick: () => line() }, cov.pct >= 100 ? 'One more line' : 'Next line')));
    };
    intro();
    return pane;
  }

  // ---- words & labels ----
  function wordSession(list) {
    let i = 0;
    const pane = h('div', { class: 'learn-pane stack' });
    const step = () => {
      if (i >= list.length) { fill(pane, h('h3', {}, 'Words done'), h('p', {}, 'Your slant, spacing and letter height are now part of your profile.'), h('button', { class: 'btn primary', onclick: () => show('sheet') }, 'See my writing')); return; }
      const word = list[i];
      const box = writingBox(110, { width: Math.min(560, window.innerWidth - 48), upper: lettering === 'upper' });
      fill(pane, 
        h('div', { class: 'row gap' }, h('span', { class: 'mono muted' }, `${i + 1} / ${list.length}`), h('span', { class: 'set-bar grow' }, h('i', { style: { width: `${(i / list.length) * 100}%` } }))),
        h('div', { class: 'prompt' }, h('span', { class: 'prompt-word mono' }, word), h('span', { class: 'muted' }, 'Write it as you would on a drawing')),
        box.el,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost', onclick: () => box.clear() }, 'Clear'),
          h('button', { class: 'btn ghost', onclick: () => { i++; step(); } }, 'Skip'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn primary', onclick: async () => {
            if (box.empty()) { toast('Write the label first.', 'warn'); return; }
            try { await api('POST', '/api/learn/samples', { samples: [{ id: uid(), ch: word, strokes: box.strokes(), source: 'word' }] }); i++; step(); updateProfile(); }
            catch (e) { toast(e.message, 'error'); }
          } }, 'Save & next')));
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
    const prof = writingProfile(samples);
    const wordSamples = samples.filter((x) => x.source === 'word');
    return h('div', { class: 'learn-pane stack' },
      prof ? h('div', { class: 'profile-card' },
        h('div', {}, h('span', { class: 'muted small' }, 'Slant'), h('b', { class: 'mono' }, prof.slantDeg === 0 ? 'upright' : `${Math.abs(prof.slantDeg)}° ${prof.slantDeg > 0 ? 'right' : 'left'}`)),
        h('div', {}, h('span', { class: 'muted small' }, 'Steadiness'), h('b', { class: 'mono' }, `${prof.steadiness}%`)),
        h('div', {}, h('span', { class: 'muted small' }, 'Letters'), h('b', { class: 'mono' }, n ? `${Math.round(sum / n)}%` : '—')),
        h('div', {}, h('span', { class: 'muted small' }, 'Samples'), h('b', { class: 'mono' }, String(prof.samples)))) : null,
      h('p', { class: 'muted' }, `Your most typical version of each character. The score shows how alike your samples are (100% = identical every time). ${lettering === 'upper' ? 'Cleanup makes letters upright and even.' : 'Cleanup keeps your own slant, just steadier.'}`),
      h('div', { class: 'glyph-grid' }, cells),
      wordSamples.length ? h('h3', {}, 'Words & labels') : null,
      wordSamples.length ? h('div', { class: 'word-list' }, wordSamples.slice(-12).map((w) => h('div', { class: 'glyph' }, lineThumb(w.strokes, Math.min(560, Math.round(Math.max(...w.strokes.flat().map((q) => q[0])) * 0.45 + 10)), 45), h('span', { class: 'muted small mono' }, w.ch)))) : null,
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        if (await confirmBox('Delete all handwriting samples?', 'Your letter sheet and scores will start over.')) { await api('DELETE', '/api/learn/samples'); show('sheet'); }
      } }, 'Delete all samples')));
  }

  function detail(ch, list) {
    fill(body, h('div', { class: 'learn-pane stack' },
      h('div', { class: 'row gap' }, h('button', { class: 'btn ghost sm', onclick: () => show('sheet') }, '← Letters'), h('span', { class: 'prompt-char sm' }, ch), h('span', { class: 'muted' }, `${list.length} samples`)),
      h('div', { class: 'glyph-grid' }, list.map((s) => h('div', { class: 'glyph' }, sampleThumb(s.strokes, 80),
        h('span', { class: 'muted small' }, s.source),
        h('button', { class: 'btn ghost sm danger-text', onclick: async () => { await api('DELETE', `/api/learn/samples/${s.id}`); await load(); const rest = byChar().get(ch) || []; rest.length ? detail(ch, rest) : show('sheet'); } }, 'Remove')))),
      h('button', { class: 'btn primary', onclick: () => fill(body, guided([ch])) }, `Add more "${ch}" samples`)));
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
      const box = writingBox(Math.min(170, window.innerWidth - 60), { upper: lettering === 'upper' });
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
      fill(pane, 
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

  show('train');
}

// ======================================================================
// Guided training: short sentences and engineering problems.
// You write one line at a time; EngBook finds each letter in it, measures your writing,
// shows what cleanup will do, and picks the next line to cover what it knows least.
// ======================================================================
const PROMPTS_UPPER = [
  'THE QUICK BROWN FOX JUMPS OVER 13 LAZY DOGS',
  'P = V × I = 120 V × 2.5 A = 300 W',
  'V = I × R = 2 A × 24 Ω = 48 V',
  'DRILL Ø6.5 THRU, 4 PLCS',
  'SEE DETAIL B, SHEET 2 OF 3',
  'F = M × A = 12 KG × 9.81 = 117.7 N',
  'MAX 20 A @ 120 VAC ±5%',
  'JACK WIRED XLR PIN 2 HOT',
  'QTY 6 M4 × 0.7 SCREWS',
  'GAIN -18 DB, HPF 80 HZ',
  'TORQUE 25 IN-LB MAX',
  'CAT6 RUN TO RACK Z, PORT 17',
  'WIDTH 3/4" ± 1/16"',
  'ANGLE 45° TYP. UNLESS NOTED',
  'Δ = 0.25 MM, R = 12.5 MM',
  'FLOW 9 GPM @ 40 PSI',
  'VERIFY JOINT, KEEP 0.8 MM GAP',
  'AREA = π × R² = 78.5 IN²',
];
const PROMPTS_MIXED = [
  'The quick brown fox jumps over 13 lazy dogs',
  'Check gain on mic 3, then pan left',
  'P = V × I = 120 V × 2.5 A = 300 W',
  'Order 6 more cables by Friday',
  'Joe wants the XLR run zipped tight',
  'Budget: $250 for new stands',
  'Drill 4 holes, 6.5 mm through',
  'Verify the jack wiring, pin 2 hot',
  'Max 20 A at 120 VAC',
  'Quiet keys make playing easier',
];
const PUNCT = new Set([' ']);

function lineClusters(strokes) {
  const items = strokes.map((pts, i) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    return { ids: [i], x0, x1, y0, y1 };
  }).sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const it of items) {
    const g = out[out.length - 1];
    const ov = g ? Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0) : -1;
    if (g && ov > 0.25 * Math.min(g.x1 - g.x0 || 2, it.x1 - it.x0 || 2)) {
      g.ids.push(...it.ids); g.x0 = Math.min(g.x0, it.x0); g.x1 = Math.max(g.x1, it.x1); g.y0 = Math.min(g.y0, it.y0); g.y1 = Math.max(g.y1, it.y1);
    } else out.push({ ...it });
  }
  return out;
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const merge = (a, b) => ({ ids: [...a.ids, ...b.ids], x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) });

/** Split a written line into letters and match them to the prompt. Returns { glyphs: [{ch, strokes}], matched, total, clusters }. */
export function segmentLine(strokes, prompt) {
  const cl = lineClusters(strokes);
  const words = prompt.split(' ').filter(Boolean);
  const total = words.join('').length;
  if (!cl.length) return { glyphs: [], matched: 0, total, clusters: cl };
  const H = med(cl.map((c) => c.y1 - c.y0)) || 10;
  // split into words at the widest gaps (as many as the prompt has spaces)
  const gaps = cl.slice(1).map((c, i) => ({ i, g: c.x0 - cl[i].x1 }));
  const cuts = gaps.slice().sort((a, b) => b.g - a.g).slice(0, words.length - 1).filter((x) => x.g > H * 0.25).map((x) => x.i).sort((a, b) => a - b);
  const groups = []; let startI = 0;
  for (const c of cuts) { groups.push(cl.slice(startI, c + 1)); startI = c + 1; }
  groups.push(cl.slice(startI));
  const glyphs = [];
  if (groups.length === words.length) {
    groups.forEach((g, wi) => {
      const chars = [...words[wi]];
      let parts = g.slice();
      // too many pieces (dots, split strokes): join the closest neighbours
      while (parts.length > chars.length && parts.length > 1) {
        let bi = 0, bg = Infinity;
        for (let i = 1; i < parts.length; i++) { const gg = parts[i].x0 - parts[i - 1].x1; if (gg < bg) { bg = gg; bi = i; } }
        parts.splice(bi - 1, 2, merge(parts[bi - 1], parts[bi]));
      }
      if (parts.length !== chars.length) return; // letters touching: skip this word
      parts.forEach((pc, k) => glyphs.push({ ch: chars[k], strokes: pc.ids.map((i) => strokes[i]), box: pc }));
    });
  }
  return { glyphs, matched: glyphs.length, total, clusters: cl };
}

/** Measurements for one written line. */
export function lineMetrics(strokes, seg) {
  const cl = seg.clusters;
  const tall = cl.filter((c) => c.y1 - c.y0 > 0.5 * Math.max(...cl.map((x) => x.y1 - x.y0)));
  const hs = tall.map((c) => c.y1 - c.y0), H = med(hs) || 1;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const allGaps = cl.slice(1).map((c, i) => c.x0 - cl[i].x1);
  const gm = med(allGaps.filter((g) => g > 0)) || 1;
  const gaps = allGaps.filter((g) => g < gm * 2.2); // letter gaps only, not word gaps
  return {
    slantDeg: Math.round(Math.atan(measureSlant(strokes)) * 180 / Math.PI),
    heightVar: Math.round((sd(hs) / H) * 100),
    baseline: Math.round((sd(tall.map((c) => c.y1)) / H) * 100),
    spacing: gaps.length > 2 ? Math.round((sd(gaps) / (mean(gaps) || 1)) * 100) : 0,
  };
}

function tipsFor(m, upper) {
  const t = [];
  if (upper && Math.abs(m.slantDeg) > 4) t.push(`Letters lean ${Math.abs(m.slantDeg)}° ${m.slantDeg > 0 ? 'right' : 'left'}. Engineering lettering is upright: think vertical strokes.`);
  if (m.heightVar > 12) t.push(`Letter heights vary ${m.heightVar}%. Aim to touch the dashed cap line with every capital.`);
  if (m.baseline > 8) t.push(`Letters drift off the line (${m.baseline}%). Rest each letter on the solid baseline.`);
  if (m.spacing > 45) t.push('Spacing between letters is uneven. Leave about one stroke-width between letters.');
  if (!t.length) t.push('Clean, even line. Nice.');
  return t.slice(0, 2);
}

/** Render a line of strokes (100-unit-high coordinates) into a canvas of the given pixel size. */
function lineThumb(strokes, w, hgt, color = '#111') {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = h('canvas', { width: w * dpr, height: hgt * dpr, style: { width: `${w}px`, height: `${hgt}px` }, class: 'line-thumb' });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fdfdfb'; ctx.fillRect(0, 0, c.width, c.height);
  const k = (hgt * dpr) / 100;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.strokeStyle = 'rgba(56,132,186,0.35)'; ctx.lineWidth = 1 / k;
  for (const y of [78, 22]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w * dpr / k, y); ctx.stroke(); }
  ctx.fillStyle = color;
  for (const st of strokes) { const p = new Path2D(); traceStroke(p, { tool: 'fineliner', width: 1.1, pts: st }); ctx.fill(p); }
  return c;
}

/** Characters this lettering style trains, and how sure EngBook is about each. */
function coverage(samples, upper) {
  const alphabet = upper ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'] : [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
  const byCh = new Map();
  for (const s of samples) if ([...s.ch].length === 1) { if (!byCh.has(s.ch)) byCh.set(s.ch, []); byCh.get(s.ch).push(s); }
  const need = new Map();
  let ready = 0;
  for (const ch of alphabet) {
    const list = byCh.get(ch) || [];
    const st = list.length >= 2 ? charStats(list) : null;
    const n = Math.max(0, 3 - list.length) * 2 + (st && st.consistency != null && st.consistency < 75 ? (75 - st.consistency) / 25 : 0);
    need.set(ch, n);
    if (list.length >= 3) ready++;
  }
  return { alphabet, need, pct: Math.round((ready / alphabet.length) * 100) };
}

/** Pick the prompt that teaches EngBook the most right now. */
function nextPrompt(prompts, cov, used) {
  let best = prompts[0], bs = -1;
  for (const p of prompts) {
    if (used.has(p)) continue;
    const chars = new Set([...p.toUpperCase()].filter((c) => cov.need.has(c) || cov.need.has(c.toLowerCase())));
    let sc = 0;
    for (const c of chars) sc += (cov.need.get(c) ?? cov.need.get(c.toLowerCase()) ?? 0);
    if (sc > bs) { bs = sc; best = p; }
  }
  return best;
}
