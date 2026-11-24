// EngBook — dimensions: linear, diameter and radius, measured at the page's drawing scale.
// A dimension is stored like a stroke (kind: 'dim') so it syncs, erases and undoes the same way.
// Its text is worked out when drawn, so changing the page scale or units updates every dimension.
// Copyright (c) 2026 Jerod Ulicki
import { UNITS_PER_INCH as IN, UNITS_PER_MM as MM, displayColor } from './ink.js';

export const SCALES = {
  '1:1': { label: '1:1 (full size)', f: 1 },
  '2:1': { label: '2:1', f: 0.5 },
  '4:1': { label: '4:1', f: 0.25 },
  '1:2': { label: '1:2', f: 2 },
  '1:4': { label: '1:4', f: 4 },
  '1:5': { label: '1:5', f: 5 },
  '1:10': { label: '1:10', f: 10 },
  '1:20': { label: '1:20', f: 20 },
  '1:50': { label: '1:50', f: 50 },
  '1:100': { label: '1:100', f: 100 },
  '1in=1ft': { label: '1" = 1\'-0"', f: 12, arch: true },
  '1/2in=1ft': { label: '1/2" = 1\'-0"', f: 24, arch: true },
  '1/4in=1ft': { label: '1/4" = 1\'-0"', f: 48, arch: true },
  '1/8in=1ft': { label: '1/8" = 1\'-0"', f: 96, arch: true },
};
for (const v of Object.values(SCALES)) v.short = v.label.replace(' (full size)', '');

export function scaleOf(style) { return SCALES[style?.scale] || SCALES['1:1']; }

/** Format a length given in page units as real-world size. */
export function formatLength(units, style, unitPref = 'in') {
  const sc = scaleOf(style);
  const inches = (units / IN) * sc.f;
  if (sc.arch) {
    let ft = Math.floor(inches / 12), rem = Math.round((inches - ft * 12) * 4) / 4;
    if (rem >= 12) { ft += 1; rem = 0; }
    const frac = (v) => { const w = Math.floor(v), q = Math.round((v - w) * 4); return `${w || (q ? '' : '0')}${q ? `${w ? ' ' : ''}${['', '1/4', '1/2', '3/4'][q]}` : ''}`; };
    return ft ? `${ft}'-${frac(rem)}"` : `${frac(rem)}"`;
  }
  if (unitPref === 'mm') {
    const mm = inches * 25.4;
    return `${mm >= 100 ? mm.toFixed(0) : mm.toFixed(1)} mm`;
  }
  return `${inches >= 100 ? inches.toFixed(1) : inches.toFixed(2)}"`;
}

const ARROW = 2.6 * MM, ARROW_W = 0.9 * MM, TEXT = 10, GAP = 1.2 * MM, OVER = 1.8 * MM;

function arrow(tip, dir) { // dir: unit vector pointing from tip back along the line
  const nx = -dir[1], ny = dir[0];
  const bx = tip[0] + dir[0] * ARROW, by = tip[1] + dir[1] * ARROW;
  return [tip, [bx + nx * ARROW_W, by + ny * ARROW_W], [bx - nx * ARROW_W, by - ny * ARROW_W]];
}

/** Build a dimension object. type: 'linear' | 'diameter' | 'radius'. */
export function makeDim(id, type, a, b, off, color) {
  const d = { id, kind: 'dim', dimType: type, a: [r2(a[0]), r2(a[1])], b: [r2(b[0]), r2(b[1])], off: r2(off || 0), color: color || '#111111', tool: 'tech', width: 0.25 };
  const g = dimGeometry(d, { textW: 60 });
  d.pts = [...g.lines.flatMap((l) => [[l[0], l[1], 0.5], [l[2], l[3], 0.5]]), [g.text.x, g.text.y, 0.5]].map((p) => p.map(r2));
  return d;
}
const r2 = (n) => Math.round(n * 100) / 100;

/** Lines, arrowheads and text placement for a dimension. */
export function dimGeometry(d, { textW = 60 } = {}) {
  const lines = [], tris = [];
  const [ax, ay] = d.a, [bx, by] = d.b;
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  const u = [dx / len, dy / len];
  let text;
  if (d.dimType === 'linear') {
    const n = [-u[1], u[0]], s = Math.sign(d.off) || 1, off = d.off;
    const aO = [ax + n[0] * off, ay + n[1] * off], bO = [bx + n[0] * off, by + n[1] * off];
    if (Math.abs(off) > GAP) {
      lines.push([ax + n[0] * GAP * s, ay + n[1] * GAP * s, aO[0] + n[0] * OVER * s, aO[1] + n[1] * OVER * s]);
      lines.push([bx + n[0] * GAP * s, by + n[1] * GAP * s, bO[0] + n[0] * OVER * s, bO[1] + n[1] * OVER * s]);
    }
    lines.push([aO[0], aO[1], bO[0], bO[1]]);
    tris.push(arrow(aO, u), arrow(bO, [-u[0], -u[1]]));
    let ang = Math.atan2(u[1], u[0]);
    if (ang > Math.PI / 2 + 0.01) ang -= Math.PI; else if (ang < -Math.PI / 2 + 0.01) ang += Math.PI;
    // text sits on the outer side of the dimension line
    const tn = [-Math.sin(ang), Math.cos(ang)]; // "below" the text baseline direction
    const side = (tn[0] * n[0] + tn[1] * n[1]) * s > 0 ? 1 : -1; // pick the side facing away from the part
    const lift = side > 0 ? TEXT + 2 : -2.5;
    text = { x: (aO[0] + bO[0]) / 2 + tn[0] * lift, y: (aO[1] + bO[1]) / 2 + tn[1] * lift, angle: ang, anchor: 'middle' };
  } else {
    // diameter: a and b are the two ends on the circle; radius: a = centre, b = point on the arc
    const tip = d.dimType === 'diameter' ? d.a : d.b;
    const out = d.dimType === 'diameter' ? [-u[0], -u[1]] : u; // outward direction at the tip
    lines.push([ax, ay, bx, by]);
    if (d.dimType === 'diameter') tris.push(arrow(d.a, u), arrow(d.b, [-u[0], -u[1]]));
    else tris.push(arrow(d.b, [-u[0], -u[1]]));
    const k = [tip[0] + out[0] * 6 * MM, tip[1] + out[1] * 6 * MM];
    const dir = out[0] >= 0 ? 1 : -1;
    const k2 = [k[0] + dir * 3 * MM, k[1]];
    lines.push([tip[0], tip[1], k[0], k[1]], [k[0], k[1], k2[0], k2[1]]);
    text = { x: k2[0] + dir * 2, y: k2[1] + 3.5, angle: 0, anchor: dir > 0 ? 'start' : 'end' };
    void textW;
  }
  return { lines, tris, text };
}

export function dimValue(d, style, unitPref) {
  if (d.text) return d.text;
  const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
  const v = formatLength(len, style, unitPref);
  return d.dimType === 'diameter' ? `Ø${v}` : d.dimType === 'radius' ? `R${v}` : v;
}

export function drawDim(ctx, d, { tone = 'paper', style, units = 'in', bg = '#fff' } = {}) {
  const g = dimGeometry(d);
  const col = displayColor(d.color, tone);
  ctx.save();
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 0.25 * MM; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const l of g.lines) { ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]); }
  ctx.stroke();
  for (const t of g.tris) { ctx.beginPath(); ctx.moveTo(...t[0]); ctx.lineTo(...t[1]); ctx.lineTo(...t[2]); ctx.closePath(); ctx.fill(); }
  const str = dimValue(d, style, units);
  ctx.translate(g.text.x, g.text.y); ctx.rotate(g.text.angle);
  ctx.font = `500 ${TEXT}px "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = g.text.anchor === 'middle' ? 'center' : g.text.anchor === 'end' ? 'right' : 'left';
  const w = ctx.measureText(str).width;
  const x0 = g.text.anchor === 'middle' ? -w / 2 : g.text.anchor === 'end' ? -w : 0;
  ctx.fillStyle = bg; ctx.fillRect(x0 - 1.5, -TEXT + 1, w + 3, TEXT + 1.5);
  ctx.fillStyle = col; ctx.fillText(str, 0, 0);
  ctx.restore();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (n) => (Math.round(n * 100) / 100).toString();

export function dimToSvg(d, { tone = 'paper', style, units = 'in', bg = '#fff' } = {}) {
  const g = dimGeometry(d);
  const col = displayColor(d.color, tone);
  const path = g.lines.map((l) => `M${f(l[0])} ${f(l[1])}L${f(l[2])} ${f(l[3])}`).join('');
  const tris = g.tris.map((t) => `<path d="M${f(t[0][0])} ${f(t[0][1])}L${f(t[1][0])} ${f(t[1][1])}L${f(t[2][0])} ${f(t[2][1])}Z"/>`).join('');
  const str = dimValue(d, style, units);
  const deg = (g.text.angle * 180) / Math.PI;
  return `<g fill="${col}"><path d="${path}" stroke="${col}" stroke-width="${f(0.25 * MM)}" stroke-linecap="round" fill="none"/>${tris}`
    + `<text x="${f(g.text.x)}" y="${f(g.text.y)}" font-size="${TEXT}" font-weight="500" text-anchor="${g.text.anchor}" transform="rotate(${f(deg)} ${f(g.text.x)} ${f(g.text.y)})" stroke="${bg}" stroke-width="3" paint-order="stroke" font-family="IBM Plex Mono, ui-monospace, Menlo, monospace">${esc(str)}</text></g>`;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitDim(d, x, y, r) {
  const g = dimGeometry(d);
  if (Math.hypot(x - g.text.x, y - (g.text.y - TEXT / 2)) < r + 14) return true;
  return g.lines.some((l) => segDist(x, y, l[0], l[1], l[2], l[3]) < r + 1);
}

/** Default offset for a linear dimension: 7 mm, on the upper side (or right side if vertical). */
export function defaultOffset(a, b, outward) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const n = [-dy / len, dx / len];
  const o = 7 * MM;
  if (outward) return (n[0] * outward[0] + n[1] * outward[1]) >= 0 ? o : -o;
  if (Math.abs(n[1]) > 0.2) return n[1] < 0 ? o : -o; // up
  return n[0] > 0 ? o : -o; // right
}

/** Parse a typed size into real inches: 2.5 · 2 1/2 · 2-1/2" · 63.5 mm · 6.35 cm · 3'-6" · 42". Bare numbers use the unit setting. */
export function parseLength(str, unitPref = 'in', arch = false) {
  let t = String(str || '').trim().toLowerCase().replace(/^[øør]\s*/, '').replace(/,/g, '.').replace(/[″]/g, '"').replace(/[′’]/g, "'");
  if (!t) return null;
  const num = (x) => {
    x = x.trim();
    let m = x.match(/^(\d+(?:\.\d+)?)?(?:[\s-]+)?(?:(\d+)\/(\d+))?$/);
    if (!m || (!m[1] && !m[2])) return null;
    return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  };
  let m;
  if ((m = t.match(/^(.+?)\s*mm$/))) { const v = num(m[1]); return v == null ? null : v / 25.4; }
  if ((m = t.match(/^(.+?)\s*cm$/))) { const v = num(m[1]); return v == null ? null : v / 2.54; }
  if ((m = t.match(/^(.+?)\s*m$/))) { const v = num(m[1]); return v == null ? null : v / 0.0254; }
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft)\s*-?\s*(.*?)\s*(?:"|in)?$/))) {
    const ft = Number(m[1]); const inch = m[2] ? num(m[2]) : 0;
    return inch == null ? null : ft * 12 + inch;
  }
  if ((m = t.match(/^(.+?)\s*(?:"|in|inch|inches)$/))) return num(m[1]);
  const v = num(t);
  if (v == null) return null;
  return unitPref === 'mm' && !arch ? v / 25.4 : v;
}
