// EngBook — page styles and engineering grids at true physical size.
// 96 page units = 1 inch, so a print at 100% measures correctly.
// Drawing goes through a small graphics interface so the same code renders to
// the screen (canvas) and to SVG for export and printing.
// Copyright (c) 2026 Jerod Ulicki
import { UNITS_PER_INCH as IN, UNITS_PER_MM as MM } from './ink.js';

export const PAGE_SIZES = {
  letter: { label: 'Letter (8.5 × 11 in)', w: 8.5 * IN, h: 11 * IN },
  tabloid: { label: 'Tabloid (11 × 17 in)', w: 11 * IN, h: 17 * IN },
  endless: { label: 'Endless canvas', w: null, h: null },
};

export const PAGE_STYLES = {
  blank: 'Blank',
  lined: 'Lined',
  graph: 'Engineering graph',
  iso: 'Isometric grid',
  isodot: 'Isometric dots',
  dot: 'Dot grid',
  polar: 'Polar',
  semilog: 'Semi-log',
  calc: 'Calc pad',
};

export const TONES = { paper: 'White paper', blueprint: 'Blueprint', dark: 'Dark page' };

export const DEFAULT_STYLE = {
  type: 'graph', size: 'letter', orient: 'portrait', tone: 'paper',
  ruling: 'college', margin: true, graph: '5', decades: 3, grid: 1,
  titleBlock: false, tb: {},
};

export const TONE_COLORS = {
  paper:     { bg: '#fdfdfb', minor: 'rgba(56,132,186,0.30)', major: 'rgba(56,132,186,0.62)', margin: 'rgba(220,38,38,0.55)', text: '#475569', ink: '#1f2937' },
  blueprint: { bg: '#0f3b66', minor: 'rgba(255,255,255,0.16)', major: 'rgba(255,255,255,0.36)', margin: 'rgba(255,170,170,0.55)', text: '#cfe3ff', ink: '#e6f0ff' },
  dark:      { bg: '#16191e', minor: 'rgba(255,255,255,0.08)', major: 'rgba(255,255,255,0.20)', margin: 'rgba(248,113,113,0.45)', text: '#9aa4b2', ink: '#e5e7eb' },
};

export function styleOf(s) { return { ...DEFAULT_STYLE, ...(s || {}), tb: { ...(s?.tb || {}) } }; }

export function pageSize(style) {
  const s = styleOf(style);
  const base = PAGE_SIZES[s.size] || PAGE_SIZES.letter;
  if (!base.w) return null;
  return s.orient === 'landscape' ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}

// ---- geometry helpers ----
function clipLine(x0, y0, x1, y1, r) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy], q = [x0 - r.x0, r.x1 - x0, y0 - r.y0, r.y1 - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

// A family of parallel lines through the origin at `deg`, `spacing` apart.
function lineFamily(g, deg, spacing, rect, z, majorEvery = 0, ox = 0, oy = 0) {
  if (spacing * z < 3.5 && !majorEvery) return;
  const th = (deg * Math.PI) / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
  const corners = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1]];
  const proj = corners.map(([x, y]) => (x - ox) * nx + (y - oy) * ny);
  const lo = Math.ceil(Math.min(...proj) / spacing), hi = Math.floor(Math.max(...proj) / spacing);
  const L = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0) + 10;
  const skipMinor = spacing * z < 3.5;
  for (let k = lo; k <= hi; k++) {
    const major = majorEvery && k % majorEvery === 0;
    if (!major && skipMinor) continue;
    const cx = ox + nx * k * spacing, cy = oy + ny * k * spacing;
    const tAlong = (rect.x0 + rect.x1) / 2 * dx + (rect.y0 + rect.y1) / 2 * dy - (cx * dx + cy * dy);
    const sx = cx + dx * (tAlong - L), sy = cy + dy * (tAlong - L), ex = cx + dx * (tAlong + L), ey = cy + dy * (tAlong + L);
    const c = clipLine(sx, sy, ex, ey, rect);
    if (c) g.line(c[0], c[1], c[2], c[3], major ? 'major' : 'minor');
  }
}

function hLines(g, spacing, rect, z, majorEvery, y0 = 0) {
  if (spacing * z < 3.5 && !majorEvery) return;
  const skipMinor = spacing * z < 3.5;
  for (let k = Math.ceil((rect.y0 - y0) / spacing); k * spacing + y0 <= rect.y1; k++) {
    const major = majorEvery && k % majorEvery === 0;
    if (!major && skipMinor) continue;
    const y = y0 + k * spacing; g.line(rect.x0, y, rect.x1, y, major ? 'major' : 'minor');
  }
}

function vLines(g, spacing, rect, z, majorEvery, x0 = 0) {
  if (spacing * z < 3.5 && !majorEvery) return;
  const skipMinor = spacing * z < 3.5;
  for (let k = Math.ceil((rect.x0 - x0) / spacing); k * spacing + x0 <= rect.x1; k++) {
    const major = majorEvery && k % majorEvery === 0;
    if (!major && skipMinor) continue;
    const x = x0 + k * spacing; g.line(x, rect.y0, x, rect.y1, major ? 'major' : 'minor');
  }
}

function graphSpec(code) {
  switch (String(code)) {
    case '4': return { s: IN / 4, major: 4 };
    case '10': return { s: IN / 10, major: 10 };
    case '5mm': return { s: 5 * MM, major: 5 };
    default: return { s: IN / 5, major: 5 };
  }
}

const RULING = { narrow: IN / 4, college: (9 / 32) * IN, wide: (11 / 32) * IN };

/**
 * Draw a page background.
 * g: graphics adapter { line(x1,y1,x2,y2,kind), dot(x,y,r,kind), text(x,y,str,opts), rect(x,y,w,h,kind,fill) }
 * rect: visible area in page units; z: zoom (screen px per unit) to skip unreadable detail.
 */
export function drawBackground(g, style, rect, z = 1) {
  const s = styleOf(style);
  const size = pageSize(s);
  const area = size ? { x0: Math.max(rect.x0, 0), y0: Math.max(rect.y0, 0), x1: Math.min(rect.x1, size.w), y1: Math.min(rect.y1, size.h) } : rect;
  if (area.x1 <= area.x0 || area.y1 <= area.y0) return;

  switch (s.type) {
    case 'lined': {
      const sp = RULING[s.ruling] || RULING.college;
      const top = size ? IN : 0, bottom = size ? size.h - IN / 2 : area.y1;
      const r = { ...area, y0: Math.max(area.y0, top), y1: Math.min(area.y1, bottom) };
      if (r.y1 > r.y0) hLines(g, sp, r, z, 0, top);
      if (size && s.margin) g.line(1.25 * IN, area.y0, 1.25 * IN, area.y1, 'margin');
      break;
    }
    case 'graph': {
      const gs = graphSpec(s.graph);
      hLines(g, gs.s, area, z, gs.major); vLines(g, gs.s, area, z, gs.major);
      break;
    }
    case 'calc': {
      const gs = graphSpec('5mm');
      const top = size ? 0.9 * IN : 0;
      const r = { ...area, y0: Math.max(area.y0, top) };
      if (r.y1 > r.y0) { hLines(g, gs.s, r, z, 0, top); vLines(g, gs.s, r, z, 0); }
      if (size) {
        g.line(1.1 * IN, top, 1.1 * IN, size.h, 'margin');
        const cells = [['PROJECT', 0, 3.4], ['SUBJECT', 3.4, 2.4], ['BY', 5.8, 1.1], ['DATE', 6.9, 1.6]];
        g.rect(0.25 * IN, 0.25 * IN, size.w - 0.5 * IN, 0.55 * IN, 'major');
        for (const [label, x, w] of cells) {
          const X = 0.25 * IN + x * IN;
          if (x > 0) g.line(X, 0.25 * IN, X, 0.8 * IN, 'major');
          g.text(X + 4, 0.25 * IN + 9, label, { size: 6.5, kind: 'label' });
          const val = { PROJECT: s.tb.project, SUBJECT: s.tb.title, BY: s.tb.drawnBy, DATE: s.tb.date }[label];
          if (val) g.text(X + 6, 0.25 * IN + 40, val, { size: 12, kind: 'value', maxWidth: w * IN - 10 });
        }
      }
      break;
    }
    case 'iso': {
      const a = 5 * MM, d = a * Math.sin(Math.PI / 3);
      lineFamily(g, 90, d, area, z); lineFamily(g, 30, d, area, z); lineFamily(g, 150, d, area, z);
      break;
    }
    case 'isodot': {
      const a = 5 * MM, hx = a * Math.sin(Math.PI / 3);
      if (hx * z < 4) break;
      for (let i = Math.floor(area.x0 / hx); i * hx <= area.x1; i++) {
        const off = (Math.abs(i) % 2) * a / 2;
        for (let j = Math.floor((area.y0 - off) / a); j * a + off <= area.y1; j++) g.dot(i * hx, j * a + off, 0.9, 'major');
      }
      break;
    }
    case 'dot': {
      const sp = 5 * MM;
      if (sp * z < 4) break;
      for (let x = Math.ceil(area.x0 / sp) * sp; x <= area.x1; x += sp)
        for (let y = Math.ceil(area.y0 / sp) * sp; y <= area.y1; y += sp) g.dot(x, y, 0.9, 'major');
      break;
    }
    case 'polar': {
      const cx = size ? size.w / 2 : 0, cy = size ? size.h / 2 : 0;
      const ring = 10 * MM;
      const R = size ? Math.min(size.w, size.h) / 2 - 0.5 * IN
        : Math.max(...[[area.x0, area.y0], [area.x1, area.y0], [area.x0, area.y1], [area.x1, area.y1]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
      const nR = Math.floor(R / ring);
      for (let k = 1; k <= nR; k++) g.circle(cx, cy, k * ring, k % 5 === 0 || k === nR ? 'major' : 'minor');
      for (let deg = 0; deg < 360; deg += 15) {
        const t = (deg * Math.PI) / 180, ex = cx + Math.cos(t) * nR * ring, ey = cy - Math.sin(t) * nR * ring;
        const c = clipLine(cx, cy, ex, ey, area);
        if (c) g.line(c[0], c[1], c[2], c[3], deg % 45 === 0 ? 'major' : 'minor');
        if (size && deg % 30 === 0) {
          const lx = cx + Math.cos(t) * (nR * ring + 12), ly = cy - Math.sin(t) * (nR * ring + 12);
          g.text(lx, ly + 3, `${deg}°`, { size: 8, kind: 'label', anchor: 'middle' });
        }
      }
      break;
    }
    case 'semilog': {
      const left = size ? 0.5 * IN : 0, right = size ? size.w - 0.5 * IN : 0;
      const D = Math.max(1, Math.min(4, Number(s.decades) || 3));
      const W = size ? (right - left) / D : 3 * IN;
      const top = size ? 0.5 * IN : area.y0, bottom = size ? size.h - 0.5 * IN : area.y1;
      const r = { x0: Math.max(area.x0, size ? left : area.x0), x1: Math.min(area.x1, size ? right : area.x1), y0: Math.max(area.y0, top), y1: Math.min(area.y1, bottom) };
      if (r.x1 <= r.x0 || r.y1 <= r.y0) break;
      hLines(g, 5 * MM, r, z, 5, top);
      const k0 = size ? 0 : Math.floor((r.x0 - left) / W), k1 = size ? D - 1 : Math.ceil((r.x1 - left) / W);
      for (let k = k0; k <= k1; k++) {
        for (let m = 1; m <= (size && k === D - 1 ? 10 : 9); m++) {
          const x = left + W * (k + Math.log10(m));
          if (x < r.x0 - 0.01 || x > r.x1 + 0.01) continue;
          if (W * z * 0.046 < 3 && m !== 1 && m !== 10) continue;
          g.line(x, r.y0, x, r.y1, m === 1 || m === 10 ? 'major' : 'minor');
        }
      }
      break;
    }
    default: break; // blank
  }

  if (size && s.titleBlock && s.type !== 'calc') drawTitleBlock(g, s, size);
}

function drawTitleBlock(g, s, size) {
  const inset = 0.25 * IN;
  g.rect(inset, inset, size.w - 2 * inset, size.h - 2 * inset, 'border');
  const bw = 4 * IN, bh = 1.05 * IN, x = size.w - inset - bw, y = size.h - inset - bh;
  g.rect(x, y, bw, bh, 'border', true);
  const rh = bh / 3, c1 = 3 * IN;
  g.line(x, y + rh, x + bw, y + rh, 'border');
  g.line(x, y + 2 * rh, x + bw, y + 2 * rh, 'border');
  g.line(x + c1, y, x + c1, y + bh, 'border');
  const cells = [
    ['PROJECT', s.tb.project, x, y], ['REV', s.tb.rev, x + c1, y],
    ['TITLE', s.tb.title, x, y + rh], ['DATE', s.tb.date, x + c1, y + rh],
    ['DRAWN BY', s.tb.drawnBy, x, y + 2 * rh], ['SHEET', s.tb.sheet, x + c1, y + 2 * rh],
  ];
  for (const [label, val, cx, cy] of cells) {
    g.text(cx + 4, cy + 8.5, label, { size: 6.5, kind: 'label' });
    if (val) g.text(cx + 6, cy + rh - 7, String(val), { size: 12, kind: 'value', maxWidth: (cx === x ? c1 : bw - c1) - 12 });
  }
}

// ---------- adapters ----------
export function canvasAdapter(ctx, tone, z, gridStrength = 1) {
  const col = TONE_COLORS[tone] || TONE_COLORS.paper;
  const paths = { minor: new Path2D(), major: new Path2D(), margin: new Path2D(), border: new Path2D() };
  const dots = new Path2D();
  const texts = [], fills = [];
  return {
    line(x1, y1, x2, y2, kind) { const p = paths[kind] || paths.minor; p.moveTo(x1, y1); p.lineTo(x2, y2); },
    circle(cx, cy, r, kind) { const p = paths[kind] || paths.minor; p.moveTo(cx + r, cy); p.arc(cx, cy, r, 0, Math.PI * 2); },
    dot(x, y, r) { dots.moveTo(x + r, y); dots.arc(x, y, Math.max(r, 1.1 / z), 0, Math.PI * 2); },
    rect(x, y, w, h, kind, fill) { if (fill) fills.push([x, y, w, h]); (paths[kind] || paths.minor).rect(x, y, w, h); },
    text(x, y, str, o) { texts.push([x, y, str, o]); },
    flush() {
      for (const [x, y, w, h] of fills) { ctx.fillStyle = col.bg; ctx.fillRect(x, y, w, h); }
      ctx.save();
      ctx.globalAlpha = Math.max(0.2, Math.min(1.6, gridStrength));
      const lw = (base) => Math.max(base, 0.9 / z);
      ctx.strokeStyle = col.minor; ctx.lineWidth = lw(0.5); ctx.stroke(paths.minor);
      ctx.strokeStyle = col.major; ctx.lineWidth = lw(0.9); ctx.stroke(paths.major);
      ctx.fillStyle = col.major; ctx.fill(dots);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col.margin; ctx.lineWidth = lw(0.9); ctx.stroke(paths.margin);
      ctx.strokeStyle = col.ink; ctx.lineWidth = lw(1.2); ctx.stroke(paths.border);
      for (const [x, y, str, o] of texts) {
        ctx.font = `${o.kind === 'value' ? 500 : 600} ${o.size}px "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`;
        ctx.fillStyle = o.kind === 'value' ? col.ink : col.text;
        ctx.textAlign = o.anchor === 'middle' ? 'center' : 'left';
        ctx.fillText(str, x, y, o.maxWidth);
      }
      ctx.restore();
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n2 = (n) => (Math.round(n * 100) / 100).toString();

export function svgAdapter(tone, gridStrength = 1) {
  const col = TONE_COLORS[tone] || TONE_COLORS.paper;
  const d = { minor: [], major: [], margin: [], border: [] };
  const dots = [], texts = [], fills = [];
  return {
    line(x1, y1, x2, y2, kind) { (d[kind] || d.minor).push(`M${n2(x1)} ${n2(y1)}L${n2(x2)} ${n2(y2)}`); },
    circle(cx, cy, r, kind) { (d[kind] || d.minor).push(`M${n2(cx + r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 1 ${n2(cx - r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 1 ${n2(cx + r)} ${n2(cy)}`); },
    dot(x, y, r) { dots.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="${r}"/>`); },
    rect(x, y, w, h, kind, fill) { if (fill) fills.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${col.bg}"/>`); (d[kind] || d.minor).push(`M${n2(x)} ${n2(y)}h${n2(w)}v${n2(h)}h${n2(-w)}Z`); },
    text(x, y, str, o) {
      texts.push(`<text x="${n2(x)}" y="${n2(y)}" font-size="${o.size}" font-weight="${o.kind === 'value' ? 500 : 600}" fill="${o.kind === 'value' ? col.ink : col.text}"${o.anchor === 'middle' ? ' text-anchor="middle"' : ''}>${esc(str)}</text>`);
    },
    toString() {
      const op = Math.max(0.2, Math.min(1, gridStrength));
      return [
        ...fills,
        `<g fill="none" opacity="${op}"><path d="${d.minor.join('')}" stroke="${col.minor}" stroke-width="0.5"/><path d="${d.major.join('')}" stroke="${col.major}" stroke-width="0.9"/></g>`,
        `<g fill="${col.major}" opacity="${op}">${dots.join('')}</g>`,
        `<path d="${d.margin.join('')}" fill="none" stroke="${col.margin}" stroke-width="0.9"/>`,
        `<path d="${d.border.join('')}" fill="none" stroke="${col.ink}" stroke-width="1.2"/>`,
        `<g font-family="IBM Plex Mono, ui-monospace, Menlo, monospace">${texts.join('')}</g>`,
      ].join('');
    },
  };
}
