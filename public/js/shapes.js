// EngBook — shape snap: turn a rough stroke into a clean line, arc, polyline,
// triangle, rectangle, polygon, circle or ellipse, then snap it to the grid,
// to clean angles and to other shapes' points.
// Copyright (c) 2026 Jerod Ulicki

const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Ramer–Douglas–Peucker simplification.
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps), right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

function turnAngle(a, b, c) {
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
  if (!l1 || !l2) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2))));
}

// Remove nearly straight vertices from a closed polygon.
function cleanClosed(v, minTurnDeg = 25) {
  let out = v.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      if (turnAngle(a, b, c) * 180 / Math.PI < minTurnDeg) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

function circleFrom3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

function pointAtLength(pts, target) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (acc + l >= target) { const t = (target - acc) / (l || 1); return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; }
    acc += l;
  }
  return pts[pts.length - 1];
}

/**
 * Recognise a stroke. pts: [[x,y,...]]. Returns a shape description or null.
 * line {a,b} · arc {c,r,a0,sweep} · poly {pts, closed} · rect (poly with rect:true) · circle {c,r} · ellipse {c,rx,ry}
 */
export function recognize(raw) {
  const pts = raw.map((p) => [p[0], p[1]]);
  if (pts.length < 2) return null;
  const L = pathLength(pts);
  if (L < 12) return null;
  const a = pts[0], b = pts[pts.length - 1], d = dist(a, b);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const w = maxX - minX, h = maxY - minY, size = Math.max(w, h);
  const closed = d < Math.max(14, 0.18 * L) && L > 2.2 * d && size > 10;

  if (!closed) {
    // straight line?
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, segDist(p, a, b));
    if (d > 0.9 * L || maxDev < Math.max(2.5, 0.045 * d)) return { type: 'line', a: [a[0], a[1]], b: [b[0], b[1]] };
    // a few straight runs with sharp corners = polyline; a smooth bend = arc
    const arc = fitArc(pts, L);
    const poly = rdp(pts, Math.max(3, 0.035 * L));
    let sharp = 0;
    for (let i = 1; i < poly.length - 1; i++) if (turnAngle(poly[i - 1], poly[i], poly[i + 1]) > 0.6) sharp++;
    if (poly.length >= 3 && poly.length <= 7 && sharp === poly.length - 2) return { type: 'poly', pts: poly.map((p) => [p[0], p[1]]), closed: false };
    if (arc) return arc;
    return null;
  }

  // ---- closed shapes ----
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (w > 4 && h > 4) {
    const rs = pts.map((p) => Math.hypot((p[0] - cx) / (w / 2), (p[1] - cy) / (h / 2)));
    const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
    const cv = Math.sqrt(rs.reduce((s, r) => s + (r - mean) ** 2, 0) / rs.length) / mean;
    if (cv < 0.085) {
      const ratio = w / h;
      if (ratio > 0.82 && ratio < 1.22) return { type: 'circle', c: [cx, cy], r: (w + h) / 4 };
      return { type: 'ellipse', c: [cx, cy], rx: w / 2, ry: h / 2 };
    }
  }
  let v = rdp(pts, Math.max(3, 0.03 * L));
  if (dist(v[0], v[v.length - 1]) < Math.max(14, 0.18 * L)) v = v.slice(0, -1);
  v = cleanClosed(v);
  if (v.length < 3 || v.length > 8) return null;
  if (v.length === 4) {
    let square = true;
    for (let i = 0; i < 4; i++) {
      const t = turnAngle(v[(i + 3) % 4], v[i], v[(i + 1) % 4]) * 180 / Math.PI;
      if (Math.abs(t - 90) > 18) square = false;
    }
    if (square) return makeRect(v);
  }
  return { type: 'poly', pts: v.map((p) => [p[0], p[1]]), closed: true };
}

function fitArc(pts, L) {
  const mid = pointAtLength(pts, L / 2);
  const c = circleFrom3(pts[0], mid, pts[pts.length - 1]);
  if (!c || c.r > 4000) return null;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, Math.abs(Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r));
  if (maxDev > Math.max(3, 0.09 * c.r)) return null;
  const a0 = Math.atan2(pts[0][1] - c.c[1], pts[0][0] - c.c[0]);
  const am = Math.atan2(mid[1] - c.c[1], mid[0] - c.c[0]);
  const a1 = Math.atan2(pts[pts.length - 1][1] - c.c[1], pts[pts.length - 1][0] - c.c[0]);
  // sweep direction through the midpoint
  const norm = (x) => ((x % TAU) + TAU) % TAU;
  const ccw = norm(am - a0) < norm(a1 - a0);
  const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
  if (Math.abs(sweep) < 0.35 || Math.abs(sweep) > TAU - 0.35) return null;
  return { type: 'arc', c: c.c, r: c.r, a0, sweep };
}

function makeRect(v) {
  // direction of the first edge decides rotation; snap near-axis rectangles square to the page
  const ang = Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]);
  const rot = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
  const off = ang - rot;
  const theta = Math.abs(off) < (8 * Math.PI) / 180 ? 0 : ang;
  const cs = Math.cos(-theta), sn = Math.sin(-theta);
  const loc = v.map((p) => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs]);
  const xs = loc.map((p) => p[0]), ys = loc.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const back = (x, y) => [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)];
  return { type: 'poly', closed: true, rect: true, theta, pts: [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)] };
}

// ---------------------------------------------------------------- snapping
export const SNAP_ANGLE_STEP = 15;

/** Snap a direction vector to the nearest 15° step when close enough. */
export function snapAngle(a, b, tolDeg = 6) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (!len) return b;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const snapped = Math.round(ang / SNAP_ANGLE_STEP) * SNAP_ANGLE_STEP;
  if (Math.abs(snapped - ang) > tolDeg) return b;
  const r = snapped * Math.PI / 180;
  return [a[0] + Math.cos(r) * len, a[1] + Math.sin(r) * len];
}

/** Points other shapes offer for snapping (ends, corners, centres, midpoints). */
export function snapTargets(strokes, exceptId) {
  const out = [];
  for (const s of strokes) {
    if (s.id === exceptId || s.kind === 'dim') continue;
    const sh = s.shape;
    if (!sh) {
      if (s.pts.length) { out.push(s.pts[0]); out.push(s.pts[s.pts.length - 1]); }
      continue;
    }
    if (sh.type === 'line') { out.push(sh.a, sh.b, [(sh.a[0] + sh.b[0]) / 2, (sh.a[1] + sh.b[1]) / 2]); }
    else if (sh.type === 'poly') out.push(...sh.pts);
    else if (sh.type === 'circle' || sh.type === 'ellipse') out.push(sh.c);
    else if (sh.type === 'arc') {
      out.push(sh.c, [sh.c[0] + sh.r * Math.cos(sh.a0), sh.c[1] + sh.r * Math.sin(sh.a0)],
        [sh.c[0] + sh.r * Math.cos(sh.a0 + sh.sweep), sh.c[1] + sh.r * Math.sin(sh.a0 + sh.sweep)]);
    }
  }
  return out;
}

/**
 * Snap one point. opts: { targets, targetTol, grid(x,y)->{x,y,s}|null, gridOn, endsOn }
 * Returns { p, kind } where kind is 'end' | 'grid' | null.
 */
export function snapPoint(p, opts) {
  if (opts.endsOn && opts.targets) {
    let best = null, bd = opts.targetTol;
    for (const t of opts.targets) { const dd = dist(p, t); if (dd < bd) { bd = dd; best = t; } }
    if (best) return { p: [best[0], best[1]], kind: 'end' };
  }
  if (opts.gridOn && opts.grid) {
    const g = opts.grid(p[0], p[1]);
    if (g && Math.hypot(g.x - p[0], g.y - p[1]) < Math.min(opts.gridTol, g.s * 0.45)) return { p: [g.x, g.y], kind: 'grid' };
  }
  return { p: [p[0], p[1]], kind: null };
}

/** Apply snapping to a recognised shape. */
export function snapShape(sh, opts) {
  const sp = (p) => snapPoint(p, opts).p;
  if (sh.type === 'line') {
    const a = sp(sh.a);
    let b = opts.angleOn ? snapAngle(a, sh.b) : sh.b;
    const sb = snapPoint(b, opts);
    b = sb.kind ? sb.p : b;
    return { ...sh, a, b };
  }
  if (sh.type === 'poly' && sh.rect && !sh.theta) {
    const xs = sh.pts.map((p) => p[0]), ys = sh.pts.map((p) => p[1]);
    const p0 = sp([Math.min(...xs), Math.min(...ys)]), p1 = sp([Math.max(...xs), Math.max(...ys)]);
    return { ...sh, pts: [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]]] };
  }
  if (sh.type === 'poly') {
    const out = [sp(sh.pts[0])];
    for (let i = 1; i < sh.pts.length; i++) {
      let q = opts.angleOn ? snapAngle(out[i - 1], sh.pts[i]) : sh.pts[i];
      const s2 = snapPoint(q, opts);
      out.push(s2.kind ? s2.p : q);
    }
    return { ...sh, pts: out };
  }
  if (sh.type === 'circle') {
    const c = sp(sh.c);
    let r = sh.r;
    if (opts.gridOn && opts.grid) { const g = opts.grid(c[0], c[1]); if (g) r = Math.max(g.s / 2, Math.round(r / (g.s / 2)) * (g.s / 2)); }
    return { ...sh, c, r };
  }
  if (sh.type === 'ellipse') return { ...sh, c: sp(sh.c) };
  if (sh.type === 'arc') return sh;
  return sh;
}

/** Points to draw for a shape (the stroke's pts). Constant pressure gives a clean technical line. */
export function shapePoints(sh) {
  const P = 0.5;
  const r2 = (n) => Math.round(n * 100) / 100;
  const pt = (x, y) => [r2(x), r2(y), P];
  if (sh.type === 'line') return [pt(...sh.a), pt(...sh.b)];
  if (sh.type === 'poly') {
    const p = sh.pts.map((q) => pt(q[0], q[1]));
    return sh.closed ? p.concat([p[0]]) : p;
  }
  if (sh.type === 'circle' || sh.type === 'ellipse') {
    const rx = sh.type === 'circle' ? sh.r : sh.rx, ry = sh.type === 'circle' ? sh.r : sh.ry;
    const n = Math.max(32, Math.min(120, Math.round((rx + ry) / 2)));
    const out = [];
    for (let i = 0; i <= n; i++) { const t = (i / n) * TAU; out.push(pt(sh.c[0] + rx * Math.cos(t), sh.c[1] + ry * Math.sin(t))); }
    return out;
  }
  if (sh.type === 'arc') {
    const n = Math.max(12, Math.min(100, Math.round(Math.abs(sh.sweep) * sh.r / 4)));
    const out = [];
    for (let i = 0; i <= n; i++) { const t = sh.a0 + (i / n) * sh.sweep; out.push(pt(sh.c[0] + sh.r * Math.cos(t), sh.c[1] + sh.r * Math.sin(t))); }
    return out;
  }
  return [];
}

export const SHAPE_NAMES = { line: 'Line', arc: 'Arc', poly: 'Polyline', circle: 'Circle', ellipse: 'Ellipse' };
export function shapeName(sh) {
  if (sh.type === 'poly' && sh.closed) return sh.rect ? (sh.theta ? 'Rotated rectangle' : 'Rectangle') : sh.pts.length === 3 ? 'Triangle' : `${sh.pts.length}-sided polygon`;
  return SHAPE_NAMES[sh.type] || 'Shape';
}

/** Distance from point to a shape outline (for tapping shapes with the dimension tool). */
export function shapeDistance(sh, p) {
  if (sh.type === 'line') return segDist(p, sh.a, sh.b);
  if (sh.type === 'poly') {
    let best = Infinity;
    const n = sh.pts.length, m = sh.closed ? n : n - 1;
    for (let i = 0; i < m; i++) best = Math.min(best, segDist(p, sh.pts[i], sh.pts[(i + 1) % n]));
    return best;
  }
  if (sh.type === 'circle') return Math.abs(dist(p, sh.c) - sh.r);
  if (sh.type === 'arc') return Math.abs(dist(p, sh.c) - sh.r);
  if (sh.type === 'ellipse') {
    const k = Math.hypot((p[0] - sh.c[0]) / sh.rx, (p[1] - sh.c[1]) / sh.ry);
    return Math.abs(k - 1) * Math.min(sh.rx, sh.ry);
  }
  return Infinity;
}

/** Nearest polygon edge index to a point. */
export function nearestEdge(sh, p) {
  let best = 0, bd = Infinity;
  const n = sh.pts.length, m = sh.closed ? n : n - 1;
  for (let i = 0; i < m; i++) { const d = segDist(p, sh.pts[i], sh.pts[(i + 1) % n]); if (d < bd) { bd = d; best = i; } }
  return best;
}
