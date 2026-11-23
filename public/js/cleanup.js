// EngBook — handwriting cleanup. Keeps your hand, just neater.
// Stage 1: smooth (jitter + pen-down hooks, corners kept)
// Stage 2: straighten (level each word's baseline)
// The original points are always kept on the stroke as `raw`.
// Copyright (c) 2026 Jerod Ulicki

const r2 = (n) => Math.round(n * 100) / 100;

function angleAt(a, b, c) {
  const v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-6 || l2 < 1e-6) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
}

// Remove the little hook that appears when the pencil lands or lifts.
function trimHooks(pts) {
  if (pts.length < 8) return pts;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const limit = Math.min(2.5, total * 0.08);
  const trimEnd = (arr) => {
    let d = 0, i = 1;
    while (i < arr.length - 4 && d < limit) { d += Math.hypot(arr[i][0] - arr[i - 1][0], arr[i][1] - arr[i - 1][1]); i++; }
    if (i < 3) return arr;
    const ang = angleAt(arr[0], arr[i - 1], arr[Math.min(arr.length - 1, i + 3)]);
    return ang < Math.PI * 0.45 ? arr.slice(i - 1) : arr;
  };
  let out = trimEnd(pts);
  out = trimEnd(out.slice().reverse()).reverse();
  return out;
}

/** Smooth points. strength 0..1. Sharp corners (< ~100°) are preserved. */
export function smoothPoints(pts, strength = 0.5) {
  if (!pts || pts.length < 3 || strength <= 0) return pts;
  let out = trimHooks(pts).map((p) => p.slice());
  const passes = Math.round(1 + strength * 3);
  const w = 0.25 + strength * 0.25;
  for (let pass = 0; pass < passes; pass++) {
    const next = out.map((p) => p.slice());
    for (let i = 1; i < out.length - 1; i++) {
      if (angleAt(out[i - 1], out[i], out[i + 1]) < Math.PI * 0.55) continue; // keep corners
      next[i][0] = out[i][0] * (1 - 2 * w) + (out[i - 1][0] + out[i + 1][0]) * w;
      next[i][1] = out[i][1] * (1 - 2 * w) + (out[i - 1][1] + out[i + 1][1]) * w;
      if (out[i][2] != null) next[i][2] = out[i][2] * 0.5 + (out[i - 1][2] + out[i + 1][2]) * 0.25;
    }
    out = next;
  }
  return out.map((p) => p.map((v, k) => (k < 2 ? r2(v) : k === 2 ? Math.round(v * 1000) / 1000 : v)));
}

/** Drop points closer than minDist to keep strokes light. */
export function simplify(pts, minDist = 0.6) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= minDist) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function groupBounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Does this group of strokes look like a written word (wider than tall)? */
export function looksLikeText(strokes) {
  const b = groupBounds(strokes);
  return b.w > 18 && b.w > b.h * 1.6 && b.h < 90;
}

/**
 * Estimate the baseline angle of a word: lowest point in each horizontal slice,
 * then a least-squares line through those points.
 */
export function baselineAngle(strokes) {
  const b = groupBounds(strokes);
  const slice = Math.max(4, b.w / 12);
  const bottoms = new Map();
  for (const s of strokes) for (const p of s.pts) {
    const k = Math.floor((p[0] - b.x0) / slice);
    if (!bottoms.has(k) || p[1] > bottoms.get(k)[1]) bottoms.set(k, p);
  }
  const pts = [...bottoms.values()];
  if (pts.length < 3) return 0;
  // ignore descenders: drop slices much lower than the median
  const ys = pts.map((p) => p[1]).sort((a, c) => a - c);
  const med = ys[Math.floor(ys.length / 2)];
  const use = pts.filter((p) => p[1] <= med + b.h * 0.18);
  if (use.length < 3) return 0;
  const n = use.length;
  const mx = use.reduce((a, p) => a + p[0], 0) / n, my = use.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const p of use) { num += (p[0] - mx) * (p[1] - my); den += (p[0] - mx) ** 2; }
  return den ? Math.atan(num / den) : 0;
}

/**
 * Level a word. Returns new point arrays per stroke (same order), or null when
 * no change is needed. strength 0..1 scales the correction.
 */
export function straightenGroup(strokes, strength = 1) {
  if (!strokes.length || !looksLikeText(strokes)) return null;
  const ang = baselineAngle(strokes);
  const deg = Math.abs(ang * 180 / Math.PI);
  if (deg < 0.8 || deg > 12) return null;
  const b = groupBounds(strokes);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const t = -ang * strength, c = Math.cos(t), s = Math.sin(t);
  return strokes.map((st) => st.pts.map((p) => {
    const dx = p[0] - cx, dy = p[1] - cy;
    const q = p.slice();
    q[0] = r2(cx + dx * c - dy * s); q[1] = r2(cy + dx * s + dy * c);
    return q;
  }));
}
