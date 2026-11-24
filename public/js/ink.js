// EngBook — ink geometry and rendering. Strokes are vector data, never images.
// A stroke is the union of round "capsules" between consecutive points, with the
// radius driven by pencil pressure. Works with any sink that has moveTo/lineTo/arc/closePath
// (Canvas Path2D, or the SVG path builder below).
// Copyright (c) 2026 Jerod Ulicki

export const UNITS_PER_INCH = 96;
export const UNITS_PER_MM = 96 / 25.4;

// Each pen leaves its own kind of mark:
//  fine-liner — smooth ink that swells a little with pressure
//  technical pen — crisp, perfectly even line
//  pencil — grainy graphite, lighter, shades wider when the Pencil is tilted
//  red-line / marker — bold, slightly translucent felt-tip
//  highlighter — flat chisel tip, see-through, always under the ink
export const TOOLS = {
  fineliner:   { label: 'Fine-liner',     thinning: 0.45, opacity: 1,    minWidth: 0.25 },
  tech:        { label: 'Technical pen',  thinning: 0,    opacity: 1,    minWidth: 0.25 },
  pencil:      { label: 'Pencil',         thinning: 0.7,  opacity: 0.9,  minWidth: 0.25, grain: true, tilt: true },
  redline:     { label: 'Marker / red-line', thinning: 0.15, opacity: 0.92, minWidth: 0.25, bold: 1.6 },
  highlighter: { label: 'Highlighter',    thinning: 0,    opacity: 0.32, minWidth: 2, under: true, chisel: true },
};

export const LINE_WEIGHTS_MM = [0.25, 0.35, 0.5, 0.7, 1.0];
export const HIGHLIGHTER_MM = [3, 5, 8];

export const PALETTE = [
  { name: 'Black', color: '#111111' },
  { name: 'Blue', color: '#1d4ed8' },
  { name: 'Red', color: '#dc2626' },
  { name: 'Green', color: '#16a34a' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Gray', color: '#9ca3af' },
];

// Stroke radius at a point [x, y, pressure, time, altitude], in page units.
export function radiusAt(stroke, pt) {
  const tool = TOOLS[stroke.tool] || TOOLS.fineliner;
  const base = (stroke.width || 0.5) * UNITS_PER_MM / 2 * (tool.bold || 1);
  const p = pt?.[2];
  const pressure = p == null ? 0.5 : Math.min(1, Math.max(0.05, p));
  let r = tool.thinning ? Math.max(base * 0.25, base * (1 + tool.thinning * (pressure - 0.5) * 1.6)) : base;
  // pencil held on its side shades wider (altitude in radians; π/2 = upright)
  const alt = pt?.[4];
  if (tool.tilt && alt != null && alt < 0.95) r *= 1 + (0.95 - alt) * 3.2;
  return r;
}

export function strokePoints(stroke, showOriginal = false) {
  return showOriginal && stroke.raw ? stroke.raw : stroke.pts;
}

// Emit the stroke outline into a path sink.
export function traceStroke(sink, stroke, showOriginal = false) {
  const pts = strokePoints(stroke, showOriginal);
  const n = pts.length;
  if (!n) return;
  const rs = pts.map((p) => radiusAt(stroke, p));
  for (let i = 0; i < n; i++) {
    const [x, y] = pts[i], r = rs[i];
    sink.moveTo(x + r, y);
    sink.arc(x, y, r, 0, Math.PI * 2);
    sink.closePath();
    if (i === 0) continue;
    const [x0, y0] = pts[i - 1], r0 = rs[i - 1];
    const dx = x - x0, dy = y - y0, len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = -dy / len, ny = dx / len;
    // Quad corners. Wind them the same way as the circles (clockwise on screen) so the
    // nonzero fill unions everything instead of punching holes where shapes overlap.
    const q = [[x0 + nx * r0, y0 + ny * r0], [x + nx * r, y + ny * r], [x - nx * r, y - ny * r], [x0 - nx * r0, y0 - ny * r0]];
    let area = 0;
    for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area < 0) q.reverse();
    sink.moveTo(q[0][0], q[0][1]);
    sink.lineTo(q[1][0], q[1][1]);
    sink.lineTo(q[2][0], q[2][1]);
    sink.lineTo(q[3][0], q[3][1]);
    sink.closePath();
  }
}

// Ink colours stay readable on dark and blueprint pages.
export function displayColor(color, tone) {
  if (tone !== 'dark' && tone !== 'blueprint') return color;
  const c = String(color || '#111111');
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.25) return '#f1f5f9';            // black ink -> white
  if (c.toLowerCase() === '#1d4ed8') return '#60a5fa'; // blue -> lighter blue
  if (c.toLowerCase() === '#dc2626') return '#f87171';
  if (c.toLowerCase() === '#16a34a') return '#4ade80';
  return c;
}

const pathCache = new WeakMap();

export function strokePath(stroke, showOriginal = false) {
  const key = showOriginal ? 'o' : 'c';
  let entry = pathCache.get(stroke);
  if (!entry) { entry = {}; pathCache.set(stroke, entry); }
  if (!entry[key]) {
    const p = new Path2D();
    traceStroke(p, stroke, showOriginal);
    entry[key] = p;
  }
  return entry[key];
}

// graphite grain: a small speckled tile in the pencil's colour, cached per colour
const grainCache = new Map();
function grainPattern(ctx, color) {
  let pat = grainCache.get(color);
  if (pat) return pat;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = color; g.globalAlpha = 0.5; g.fillRect(0, 0, 48, 48);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) { g.globalAlpha = 0.25 + rnd() * 0.75; g.fillRect(rnd() * 48, rnd() * 48, 0.6 + rnd() * 0.9, 0.6 + rnd() * 0.9); }
  pat = ctx.createPattern(c, 'repeat');
  pat.setTransform?.(new DOMMatrix().scale(0.5));
  grainCache.set(color, pat);
  return pat;
}

function chiselPath(sink, stroke, extra) {
  const pts = extra ? stroke.pts.concat(extra) : stroke.pts;
  pts.forEach((p, i) => (i ? sink.lineTo(p[0], p[1]) : sink.moveTo(p[0], p[1])));
}

function fillStroke(ctx, stroke, path, tone, extra) {
  const tool = TOOLS[stroke.tool] || TOOLS.fineliner;
  const color = displayColor(stroke.color, tone);
  ctx.globalAlpha = stroke.opacity ?? tool.opacity;
  if (tool.chisel) {
    const p = new Path2D(); chiselPath(p, stroke, extra);
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = (stroke.width || 5) * UNITS_PER_MM; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    ctx.stroke(p); ctx.restore();
  } else {
    ctx.fillStyle = tool.grain ? grainPattern(ctx, color) : color;
    ctx.fill(path, 'nonzero');
  }
  ctx.globalAlpha = 1;
}

export function drawStroke(ctx, stroke, { tone = 'paper', showOriginal = false } = {}) {
  fillStroke(ctx, stroke, strokePath(stroke, showOriginal), tone);
}

// Draw a stroke that is still being written (no caching).
export function drawLiveStroke(ctx, stroke, tone, extraPts) {
  const p = new Path2D();
  traceStroke(p, extraPts && extraPts.length ? { ...stroke, pts: stroke.pts.concat(extraPts) } : stroke);
  fillStroke(ctx, stroke, p, tone, extraPts && extraPts.length ? extraPts : null);
}

export function strokeBounds(stroke) {
  if (stroke._b) return stroke._b;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0;
  for (const p of stroke.pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    const r = radiusAt(stroke, p); if (r > maxR) maxR = r;
  }
  const b = { minX: minX - maxR, minY: minY - maxR, maxX: maxX + maxR, maxY: maxY + maxR };
  Object.defineProperty(stroke, '_b', { value: b, enumerable: false, configurable: true, writable: true });
  return b;
}

export function invalidate(stroke) {
  pathCache.delete(stroke);
  if (stroke._b) stroke._b = undefined;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitStroke(stroke, x, y, radius) {
  const b = strokeBounds(stroke);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  const pts = stroke.pts;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= radius + radiusAt(stroke, pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const r = radiusAt(stroke, pts[i]);
    if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= radius + r) return true;
  }
  return false;
}

// SVG path builder implementing the same sink interface.
export class SvgPath {
  constructor() { this.d = []; }
  moveTo(x, y) { this.d.push(`M${f(x)} ${f(y)}`); }
  lineTo(x, y) { this.d.push(`L${f(x)} ${f(y)}`); }
  closePath() { this.d.push('Z'); }
  arc(x, y, r) { // full circle as two half arcs
    this.d.push(`M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x + r)} ${f(y)}`);
  }
  toString() { return this.d.join(''); }
}
const f = (n) => (Math.round(n * 100) / 100).toString();

export function strokeToSvg(stroke, tone = 'paper') {
  const tool = TOOLS[stroke.tool] || TOOLS.fineliner;
  if (tool.chisel) {
    const d = stroke.pts.map((q, i) => `${i ? 'L' : 'M'}${f(q[0])} ${f(q[1])}`).join('');
    return `<path d="${d}" fill="none" stroke="${displayColor(stroke.color, tone)}" stroke-opacity="${stroke.opacity ?? tool.opacity}" stroke-width="${f((stroke.width || 5) * UNITS_PER_MM)}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }
  const p = new SvgPath();
  traceStroke(p, stroke);
  return `<path d="${p}" fill="${displayColor(stroke.color, tone)}" fill-opacity="${stroke.opacity ?? tool.opacity}" fill-rule="nonzero"/>`;
}

// Order for rendering: highlighters underneath ink.
export function renderOrder(strokes) {
  const imgs = [], under = [], over = [];
  for (const s of strokes) (s.kind === 'image' ? imgs : (TOOLS[s.tool] || {}).under ? under : over).push(s);
  return imgs.concat(under, over);
}
