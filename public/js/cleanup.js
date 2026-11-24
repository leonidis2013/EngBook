import { rdp } from './shapes.js';
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

// ======================================================================
// v0.4 cleanup: stronger, still your hand.
// ======================================================================

function turn(a, b, c) {
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
  if (!l1 || !l2) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180 / Math.PI;
}

/**
 * Straighten a stroke that is really one to four straight runs with sharp corners
 * (most strokes in uppercase engineering lettering: E F H K L M N T V W X Y Z 1 4 7).
 * Curved strokes (O C S U D …) are left alone.
 */
export function straightenStroke(pts, strength = 0.6) {
  if (!pts || pts.length < 4 || strength <= 0) return pts;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const size = Math.max(maxX - minX, maxY - minY);
  if (size < 5 || size > 64) return pts; // letters only (≈17 mm); drawings are left as drawn
  const poly = rdp(pts, Math.max(0.9, (0.045 + 0.04 * strength) * size));
  if (poly.length < 2 || poly.length > 5) return pts;
  for (let i = 1; i < poly.length - 1; i++) {
    const t = turn(poly[i - 1], poly[i], poly[i + 1]);
    if (t > 8 && t < 52) return pts; // a gentle bend = a curve, not a corner
  }
  // rebuild the stroke along the straight runs, keeping the pen pressure
  const out = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const f = k / n, pa = a[2] ?? 0.5, pb = b[2] ?? 0.5;
      out.push([r2(a[0] + (b[0] - a[0]) * f), r2(a[1] + (b[1] - a[1]) * f), Math.round((pa + (pb - pa) * f) * 1000) / 1000]);
    }
  }
  return out;
}

/** Slant as dx per unit dy of the near-vertical parts of the writing (0 = upright, + = leaning right). */
export function measureSlant(strokeList) {
  let num = 0, den = 0;
  for (const pts of strokeList) {
    for (let i = 3; i < pts.length; i += 3) {
      const a = pts[i - 3], b = pts[i];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      if (dy < 0) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy);
      if (len < 2.5 || Math.abs(Math.atan2(dx, dy)) > 0.6) continue; // within ~35° of vertical
      num += -dx * len / dy * 1; den += len; // y grows downward: a right lean has top to the right
    }
  }
  return den ? num / den : 0;
}

function clusters(strokeList) {
  // group strokes into letters by horizontal overlap
  const items = strokeList.map((pts, i) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    return { i, x0, x1, y0, y1 };
  }).sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    const overlap = g ? Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0) : -1;
    if (g && overlap > 0.3 * Math.min(g.x1 - g.x0 || 1, it.x1 - it.x0 || 1)) {
      g.ids.push(it.i); g.x0 = Math.min(g.x0, it.x0); g.x1 = Math.max(g.x1, it.x1); g.y0 = Math.min(g.y0, it.y0); g.y1 = Math.max(g.y1, it.y1);
    } else groups.push({ ids: [it.i], ...it });
  }
  return groups;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/**
 * Clean up one written word / label. strokeList: arrays of points. Returns new arrays, or null when nothing changes.
 * opts: { strength 0..1, upright, targetSlant, equalize, level, alignY(baselineY) -> targetY|null }
 */
export function cleanWord(strokeList, opts = {}) {
  const k = Math.max(0, Math.min(1, opts.strength ?? 0.6));
  if (!strokeList.length) return null;
  let out = strokeList.map((pts) => pts.map((p) => p.slice()));
  let changed = false;
  const all = () => out.flat();
  const bottomOf = () => {
    const g = clusters(out);
    return median(g.filter((c) => c.y1 - c.y0 > 3).map((c) => c.y1)) || Math.max(...all().map((p) => p[1]));
  };

  // 1. upright (or your own steady slant)
  const target = opts.upright ? 0 : (opts.targetSlant ?? null);
  if (target != null) {
    const slant = measureSlant(out);
    const d = slant - target;
    const deg = Math.abs(Math.atan(d) * 180 / Math.PI);
    if (deg > 1.5 && deg < 32) {
      const base = bottomOf();
      // shear: x' = x - d*k*(base - y) moves tops back toward the target slant
      out = out.map((pts, si) => pts.map((p, pi) => { const o = strokeList[si][pi]; const q = p.slice(); q[0] = r2(o[0] - d * Math.min(1, k * 1.35) * (base - o[1])); return q; }));
      changed = true;
    }
  }

  // 2. level the baseline
  if (opts.level !== false && looksLikeText(out.map((pts) => ({ pts })))) {
    const fixed = straightenGroup(out.map((pts) => ({ pts })), k);
    if (fixed) { out = fixed; changed = true; }
  }

  // 3. even letter heights, all sitting on one baseline (uppercase lettering)
  if (opts.equalize) {
    const groups = clusters(out);
    const tall = groups.filter((g) => g.y1 - g.y0 > 0.45 * Math.max(...groups.map((x) => x.y1 - x.y0)));
    if (tall.length >= 2) {
      const H = median(tall.map((g) => g.y1 - g.y0)), base = median(tall.map((g) => g.y1));
      for (const g of tall) {
        const h = g.y1 - g.y0;
        const s = Math.max(0.78, Math.min(1.3, H / h));
        if (Math.abs(s - 1) < 0.04 && Math.abs(g.y1 - base) < 1) continue;
        for (const si of g.ids) out[si] = out[si].map((p) => { const q = p.slice(); const ny = base - (g.y1 - p[1]) * s; q[1] = r2(p[1] + (ny - p[1]) * k); return q; });
        changed = true;
      }
    }
  }

  // 4. sit the word on the nearest ruled line / grid line
  if (opts.alignY) {
    const base = bottomOf();
    const t = opts.alignY(base);
    if (t != null && Math.abs(t - base) > 0.3) {
      out = out.map((pts) => pts.map((p) => { const q = p.slice(); q[1] = r2(p[1] + (t - base)); return q; }));
      changed = true;
    }
  }
  return changed ? out : null;
}
