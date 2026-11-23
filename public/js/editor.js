// EngBook — the page editor: canvas rendering, Apple Pencil input, finger gestures,
// tools, eraser, undo/redo, cleanup and the tool wheel.
// Copyright (c) 2026 Jerod Ulicki
import { h, uid, toast } from './util.js';
import { icon } from './icons.js';
import { TOOLS, PALETTE, LINE_WEIGHTS_MM, HIGHLIGHTER_MM, UNITS_PER_INCH, UNITS_PER_MM,
  drawStroke, drawLiveStroke, strokeBounds, hitStroke, renderOrder, displayColor } from './ink.js';
import { drawBackground, canvasAdapter, pageSize, styleOf, TONE_COLORS } from './backgrounds.js';
import { smoothPoints, simplify, straightenGroup } from './cleanup.js';
import { applyOpsToDoc } from './store.js';

const WRITING_TOOLS = new Set(['fineliner', 'tech', 'pencil', 'redline']);
const MIN_Z = 0.2, MAX_Z = 8;
const TAP_MS = 280, TAP_MOVE = 14, LONG_PRESS_MS = 520;

export class Editor {
  constructor(host, store, prefs) {
    this.host = host; this.store = store; this.prefs = prefs;
    this.view = { ox: 0, oy: 0, z: 1 };
    this.undoStack = []; this.redoStack = [];
    this.hiddenColors = new Set();
    this.showOriginal = false;
    this.eraserMode = false; this.quickEraser = false;
    this.touches = new Map(); this.ignored = new Set();
    this.pencilSeen = false; this.lastPenUp = 0;
    this.cur = null; this.erasing = null; this.group = null;

    this.base = h('canvas', { class: 'cv base' });
    this.live = h('canvas', { class: 'cv live' });
    this.readout = h('div', { class: 'readout mono' });
    this.strip = h('div', { class: 'thumbstrip' });
    this.empty = h('div', { class: 'editor-empty' },
      h('div', { class: 'empty-mark' }, icon('notebook')),
      h('p', {}, 'Pick a page from the library, or make a new one.'));
    this.wrap = h('div', { class: 'canvas-wrap' }, this.base, this.live);
    host.append(this.wrap, this.readout, this.strip, this.empty);

    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.buildStrip();
    this.resize();
  }

  // ------------------------------------------------------------------ page
  get preset() { return this.prefs.get('presets')[this.prefs.get('activePreset')] || this.prefs.get('presets')[0]; }
  get style() { return styleOf(this.meta?.style); }
  get tone() { return this.style.tone; }
  get activeTool() { return this.eraserMode || this.quickEraser ? 'eraser' : this.preset.tool; }

  open(meta, doc) {
    this.finalizeGroup();
    this.meta = meta; this.doc = doc;
    this.undoStack = []; this.redoStack = [];
    this.hiddenColors.clear(); this.showOriginal = false;
    this.empty.style.display = 'none';
    this.wrap.style.display = '';
    if (!this.restoreView()) this.fit();
    this.render();
    this.updateStrip();
  }

  close() {
    this.finalizeGroup();
    this.saveView();
    this.meta = null; this.doc = null;
    this.empty.style.display = '';
    this.render();
  }

  setMeta(meta) { this.meta = meta; this.render(); }

  viewKey() { return `eb.view.${this.meta?.id}`; }
  saveView() { if (this.meta) try { localStorage.setItem(this.viewKey(), JSON.stringify(this.view)); } catch {} }
  restoreView() {
    try { const v = JSON.parse(localStorage.getItem(this.viewKey())); if (v && v.z) { this.view = v; return true; } } catch {}
    return false;
  }

  fit() {
    const W = this.W || 800, H = this.H || 600;
    const size = pageSize(this.style);
    if (size) {
      const z = Math.max(MIN_Z, Math.min(MAX_Z, (W - 40) / size.w));
      this.view = { z, ox: -(W / z - size.w) / 2, oy: -20 / z };
    } else {
      const z = 1.25;
      this.view = { z, ox: -W / 2 / z, oy: -H / 3 / z };
    }
    this.render();
    this.saveView();
  }

  // ------------------------------------------------------------------ sizing + rendering
  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr);
      c.style.width = `${this.W}px`; c.style.height = `${this.H}px`;
    }
    this.render();
  }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.renderBase(); this.renderLive(); });
  }

  pageTransform(ctx) {
    const { ox, oy, z } = this.view, d = this.dpr;
    ctx.setTransform(d * z, 0, 0, d * z, -ox * z * d, -oy * z * d);
  }

  visibleRect() {
    const { ox, oy, z } = this.view;
    return { x0: ox, y0: oy, x1: ox + this.W / z, y1: oy + this.H / z };
  }

  renderBase() {
    const ctx = this.base.getContext('2d');
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const desk = getComputedStyle(document.documentElement).getPropertyValue('--desk').trim() || '#0b0d10';
    ctx.fillStyle = desk; ctx.fillRect(0, 0, this.W, this.H);
    if (!this.meta || !this.doc) return;

    const style = this.style, tone = style.tone, col = TONE_COLORS[tone] || TONE_COLORS.paper;
    const size = pageSize(style);
    const { ox, oy, z } = this.view;
    if (size) {
      const sx = -ox * z, sy = -oy * z, sw = size.w * z, sh = size.h * z;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
      ctx.fillStyle = col.bg; ctx.fillRect(sx, sy, sw, sh);
      ctx.restore();
      this.drawCropMarks(ctx, sx, sy, sw, sh);
    } else {
      ctx.fillStyle = col.bg; ctx.fillRect(0, 0, this.W, this.H);
    }

    ctx.save();
    this.pageTransform(ctx);
    if (size) { ctx.beginPath(); ctx.rect(0, 0, size.w, size.h); ctx.clip(); }
    const vis = this.visibleRect();
    const g = canvasAdapter(ctx, tone, z, style.grid ?? 1);
    drawBackground(g, style, vis, z);
    g.flush();
    for (const s of renderOrder(this.doc.strokes)) {
      if (this.hiddenColors.has(s.color)) continue;
      const b = strokeBounds(s);
      if (b.maxX < vis.x0 || b.minX > vis.x1 || b.maxY < vis.y0 || b.minY > vis.y1) continue;
      drawStroke(ctx, s, { tone, showOriginal: this.showOriginal });
    }
    ctx.restore();
    this.updateReadout();
  }

  drawCropMarks(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#6b7280';
    ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    const L = 10, G = 6;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
      ctx.moveTo(cx + dx * G, cy); ctx.lineTo(cx + dx * (G + L), cy);
      ctx.moveTo(cx, cy + dy * G); ctx.lineTo(cx, cy + dy * (G + L));
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Draw one new stroke on top without a full redraw (keeps writing smooth). */
  drawCommitted(s) {
    if ((TOOLS[s.tool] || {}).under) { this.render(); return; }
    const ctx = this.base.getContext('2d');
    ctx.save();
    this.pageTransform(ctx);
    const size = pageSize(this.style);
    if (size) { ctx.beginPath(); ctx.rect(0, 0, size.w, size.h); ctx.clip(); }
    drawStroke(ctx, s, { tone: this.tone });
    ctx.restore();
  }

  renderLive() {
    const ctx = this.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!this.meta) return;
    if (this.cur) {
      this.pageTransform(ctx);
      drawLiveStroke(ctx, this.cur, this.tone, this.predicted);
    }
    if (this.eraserCursor) {
      const { x, y, r } = this.eraserCursor;
      this.pageTransform(ctx);
      ctx.lineWidth = 1 / this.view.z;
      ctx.strokeStyle = '#f5a524';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  updateReadout() {
    if (!this.meta) { this.readout.textContent = ''; return; }
    const metric = this.prefs.get('units') === 'mm';
    const unit = metric ? UNITS_PER_MM : UNITS_PER_INCH;
    const z = this.view.z;
    const choices = metric ? [5, 10, 20, 50, 100, 200] : [0.25, 0.5, 1, 2, 5];
    let len = choices[0];
    for (const c of choices) if (c * unit * z <= 140) len = c;
    const px = len * unit * z;
    const pos = this.lastPos ? `X ${(this.lastPos.x / unit).toFixed(metric ? 1 : 2)}  Y ${(this.lastPos.y / unit).toFixed(metric ? 1 : 2)} ${metric ? 'mm' : 'in'}` : '';
    this.readout.replaceChildren(
      h('span', { class: 'ro-zoom' }, `${Math.round(z * 100)}%`),
      h('span', { class: 'ro-pos' }, pos),
      h('span', { class: 'ro-scale' }, h('i', { style: { width: `${px}px` } }), `${len} ${metric ? 'mm' : 'in'}`));
  }

  // ------------------------------------------------------------------ coordinates
  toPage(e) {
    const r = this.live.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.view.z + this.view.ox, y: (e.clientY - r.top) / this.view.z + this.view.oy };
  }

  zoomAt(clientX, clientY, newZ) {
    const r = this.live.getBoundingClientRect();
    const z = Math.max(MIN_Z, Math.min(MAX_Z, newZ));
    const px = (clientX - r.left) / this.view.z + this.view.ox, py = (clientY - r.top) / this.view.z + this.view.oy;
    this.view = { z, ox: px - (clientX - r.left) / z, oy: py - (clientY - r.top) / z };
    this.render();
  }

  // ------------------------------------------------------------------ input
  bindInput() {
    const el = this.live;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener('lostpointercapture', (e) => { if (this.drawPointer === e.pointerId) this.onUp(e); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // stop iOS from treating touches as scroll/zoom/selection
    for (const t of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange']) el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.meta) return;
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, this.view.z * Math.exp(-e.deltaY * 0.01));
      else { this.view.ox += e.deltaX / this.view.z; this.view.oy += e.deltaY / this.view.z; this.render(); }
      this.saveViewSoon();
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
  }

  saveViewSoon() { clearTimeout(this._svT); this._svT = setTimeout(() => this.saveView(), 400); }

  onKey(e) {
    if (!this.meta || e.target.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (e.code === 'Space') { this.spaceDown = true; return; }
    if (mod) return;
    if (e.key === 'e') this.setEraser(!this.eraserMode);
    if (/^[1-9]$/.test(e.key)) this.selectPreset(Number(e.key) - 1);
    if (e.key === '0') this.fit();
  }

  isDrawingPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0 && !this.spaceDown;
    if (e.pointerType === 'touch') return this.prefs.get('fingerDraw') && !this.pencilSeen && this.touches.size === 0 && !this.cur;
    return false;
  }

  onDown(e) {
    if (!this.meta) return;
    this.closeWheel();
    if (e.pointerType === 'pen') { this.pencilSeen = true; this.cancelTouchGesture(); }

    if (this.drawPointer == null && this.isDrawingPointer(e)) {
      this.live.setPointerCapture(e.pointerId);
      this.drawPointer = e.pointerId;
      this.drawType = e.pointerType;
      this.startDraw(e);
      return;
    }

    if (e.pointerType === 'mouse') { // middle button or space+drag pans
      this.live.setPointerCapture(e.pointerId);
      this.mousePan = { x: e.clientX, y: e.clientY };
      return;
    }

    if (e.pointerType !== 'touch') return;
    // ---- palm rejection ----
    if (this.drawPointer != null && this.drawType === 'pen') { this.ignored.add(e.pointerId); return; }
    if (this.pencilSeen && (e.width > 36 || e.height > 36)) { this.ignored.add(e.pointerId); return; }
    if (performance.now() - this.lastPenUp < 220) { this.ignored.add(e.pointerId); return; }

    // a second finger while finger-drawing turns the stroke into a pan/zoom
    if (this.drawPointer != null && this.drawType === 'touch') { this.cur = null; this.drawPointer = null; this.renderLive(); }

    this.live.setPointerCapture(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (!this.gesture) this.gesture = { start: performance.now(), maxCount: 0, moved: false };
    this.gesture.maxCount = Math.max(this.gesture.maxCount, this.touches.size);
    this.beginPinch();

    clearTimeout(this.lpTimer);
    if (this.touches.size === 1) {
      const t = { x: e.clientX, y: e.clientY };
      this.lpTimer = setTimeout(() => { if (this.gesture && !this.gesture.moved && this.touches.size === 1) { this.gesture.consumed = true; this.openWheel(t.x, t.y); } }, LONG_PRESS_MS);
    }
  }

  beginPinch() {
    const pts = [...this.touches.values()];
    const c = centroid(pts);
    this.pinch = { c, dist: pts.length > 1 ? spread(pts) : 0, view: { ...this.view }, n: pts.length };
  }

  cancelTouchGesture() {
    clearTimeout(this.lpTimer);
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear(); this.gesture = null; this.pinch = null;
  }

  onMove(e) {
    if (!this.meta) return;
    if (e.pointerId === this.drawPointer) { this.moveDraw(e); return; }
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') { this.lastPos = this.toPage(e); this.updateReadoutSoon(); }
    if (this.mousePan && e.pointerType === 'mouse') {
      this.view.ox -= (e.clientX - this.mousePan.x) / this.view.z; this.view.oy -= (e.clientY - this.mousePan.y) / this.view.z;
      this.mousePan = { x: e.clientX, y: e.clientY }; this.render(); return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_MOVE && this.gesture) { this.gesture.moved = true; clearTimeout(this.lpTimer); }
    if (this.gesture?.consumed || !this.pinch) return;
    const pts = [...this.touches.values()];
    if (pts.length !== this.pinch.n) { this.beginPinch(); return; }
    const c = centroid(pts), v0 = this.pinch.view;
    let z = v0.z;
    if (pts.length > 1 && this.pinch.dist > 10) z = Math.max(MIN_Z, Math.min(MAX_Z, v0.z * spread(pts) / this.pinch.dist));
    const r = this.live.getBoundingClientRect();
    const px = (this.pinch.c.x - r.left) / v0.z + v0.ox, py = (this.pinch.c.y - r.top) / v0.z + v0.oy;
    this.view = { z, ox: px - (c.x - r.left) / z, oy: py - (c.y - r.top) / z };
    this.render();
  }

  onUp(e, cancelled = false) {
    if (e.pointerId === this.drawPointer) {
      this.drawPointer = null;
      if (this.drawType === 'pen') this.lastPenUp = performance.now();
      if (cancelled && this.cur && this.cur.pts.length < 3) { this.cur = null; this.renderLive(); return; }
      this.endDraw();
      return;
    }
    if (this.ignored.delete(e.pointerId)) return;
    if (e.pointerType === 'mouse') { this.mousePan = null; this.saveViewSoon(); return; }
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    clearTimeout(this.lpTimer);
    if (this.touches.size) { this.beginPinch(); return; }
    // all fingers lifted: was it a two- or three-finger tap?
    const g = this.gesture; this.gesture = null; this.pinch = null;
    this.saveViewSoon();
    if (!g || g.consumed || g.moved || performance.now() - g.start > TAP_MS) return;
    if (g.maxCount === 2) this.undo();
    else if (g.maxCount === 3) this.redo();
  }

  // ------------------------------------------------------------------ drawing
  startDraw(e) {
    if (this.activeTool === 'eraser') {
      this.erasing = { ids: [] };
      this.eraseAt(this.toPage(e));
      return;
    }
    const p = this.preset;
    this.cur = { id: uid(), tool: p.tool, color: p.color, width: p.width, pts: [], t0: Date.now() };
    this.addPoint(e);
    this.renderLive();
  }

  addPoint(e) {
    const p = this.toPage(e);
    const pts = this.cur.pts;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 0.35 / Math.max(0.5, this.view.z)) return;
    const pressure = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5;
    pts.push([Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(pressure * 1000) / 1000, Date.now() - this.cur.t0]);
  }

  moveDraw(e) {
    this.lastPos = this.toPage(e);
    if (this.erasing) {
      const evs = e.getCoalescedEvents?.() || [e];
      for (const ev of (evs.length ? evs : [e])) this.eraseAt(this.toPage(ev));
      return;
    }
    if (!this.cur) return;
    const evs = e.getCoalescedEvents?.() || [];
    for (const ev of (evs.length ? evs : [e])) this.addPoint(ev);
    const pred = e.getPredictedEvents?.() || [];
    this.predicted = pred.slice(0, 2).map((ev) => { const p = this.toPage(ev); return [p.x, p.y, ev.pressure || 0.5]; });
    this.renderLive();
  }

  endDraw() {
    this.predicted = null;
    if (this.erasing) {
      const ids = this.erasing.ids; this.erasing = null; this.eraserCursor = null; this.renderLive();
      if (ids.length) {
        this.store.pageOps(this.doc.id, ids.map((id) => ({ op: 'del', id })));
        this.pushHistory({ undo: ids.map((id) => ({ op: 'undel', id })), redo: ids.map((id) => ({ op: 'del', id })) });
      }
      return;
    }
    const s = this.cur; this.cur = null;
    if (!s || !s.pts.length) { this.renderLive(); return; }
    delete s.t0;
    const cleanup = this.prefs.get('cleanup');
    if (cleanup.on && s.tool !== 'highlighter' && s.pts.length > 3) {
      const smoothed = smoothPoints(simplify(s.pts, 0.45), cleanup.smooth);
      if (smoothed !== s.pts) { s.raw = s.pts; s.pts = smoothed; }
    }
    s.created = Date.now();
    this.store.pageOps(this.doc.id, [{ op: 'add', stroke: s }]);
    this.pushHistory({ undo: [{ op: 'del', id: s.id }], redo: [{ op: 'undel', id: s.id }] });
    this.drawCommitted(s);
    this.renderLive();
    if (cleanup.on && cleanup.straighten && WRITING_TOOLS.has(s.tool)) this.trackWord(s);
  }

  eraseAt(p) {
    const r = Math.max(5, 12 / this.view.z);
    this.eraserCursor = { x: p.x, y: p.y, r };
    const hits = [];
    for (const s of this.doc.strokes) {
      if (this.hiddenColors.has(s.color)) continue;
      if (hitStroke(s, p.x, p.y, r)) hits.push(s.id);
    }
    if (hits.length) {
      applyOpsToDoc(this.doc, hits.map((id) => ({ op: 'del', id })));
      this.erasing.ids.push(...hits);
      this.render();
    } else this.renderLive();
  }

  // ---- word grouping for baseline straightening ----
  trackWord(s) {
    const b = strokeBounds(s);
    const g = this.group;
    const near = g && Date.now() - g.lastEnd < 1100 && b.minX < g.b.maxX + 40 && b.maxX > g.b.minX - 40
      && b.minY < g.b.maxY + 25 && b.maxY > g.b.minY - 25;
    if (!near) { this.finalizeGroup(); this.group = { ids: [], b: { ...b }, lastEnd: 0 }; }
    const grp = this.group;
    grp.ids.push(s.id); grp.lastEnd = Date.now();
    grp.b.minX = Math.min(grp.b.minX, b.minX); grp.b.maxX = Math.max(grp.b.maxX, b.maxX);
    grp.b.minY = Math.min(grp.b.minY, b.minY); grp.b.maxY = Math.max(grp.b.maxY, b.maxY);
    clearTimeout(this.groupTimer);
    this.groupTimer = setTimeout(() => this.finalizeGroup(), 1100);
  }

  finalizeGroup() {
    clearTimeout(this.groupTimer);
    const g = this.group; this.group = null;
    if (!g || !this.doc || this.cur) return;
    const strokes = g.ids.map((id) => this.doc.byId.get(id)).filter(Boolean);
    if (!strokes.length) return;
    const fixed = straightenGroup(strokes, 1);
    if (!fixed) return;
    const replacements = strokes.map((s, i) => ({ ...s, id: uid(), pts: fixed[i], raw: s.raw || s.pts }));
    const ops = [...strokes.map((s) => ({ op: 'del', id: s.id })), ...replacements.map((s) => ({ op: 'add', stroke: s }))];
    this.store.pageOps(this.doc.id, ops);
    this.pushHistory({
      undo: [...replacements.map((s) => ({ op: 'del', id: s.id })), ...strokes.map((s) => ({ op: 'undel', id: s.id }))],
      redo: [...strokes.map((s) => ({ op: 'del', id: s.id })), ...replacements.map((s) => ({ op: 'undel', id: s.id }))],
    });
    this.render();
  }

  // ------------------------------------------------------------------ history
  pushHistory(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.emitHistory();
  }

  undo() {
    this.finalizeGroup();
    const e = this.undoStack.pop();
    if (!e) return;
    this.store.pageOps(this.doc.id, e.undo);
    this.redoStack.push(e);
    this.render(); this.emitHistory(); flash(this.host, 'Undo');
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.store.pageOps(this.doc.id, e.redo);
    this.undoStack.push(e);
    this.render(); this.emitHistory(); flash(this.host, 'Redo');
  }

  emitHistory() { this.host.dispatchEvent(new CustomEvent('history', { detail: { undo: this.undoStack.length, redo: this.redoStack.length } })); }

  // ------------------------------------------------------------------ tools
  selectPreset(i) {
    const presets = this.prefs.get('presets');
    if (i < 0 || i >= presets.length) return;
    this.prefs.set('activePreset', i);
    this.eraserMode = false;
    this.updateStrip();
  }

  setEraser(on) { this.eraserMode = on; this.updateStrip(); }

  updatePreset(patch) {
    const presets = this.prefs.get('presets').map((p) => ({ ...p }));
    Object.assign(presets[this.prefs.get('activePreset')], patch);
    this.prefs.set('presets', presets);
    if (patch.color) {
      const recent = [patch.color, ...this.prefs.get('recentColors').filter((c) => c !== patch.color)].slice(0, 8);
      this.prefs.set('recentColors', recent);
    }
    this.eraserMode = false;
    this.updateStrip();
  }

  buildStrip() {
    this.strip.replaceChildren();
    const presets = this.prefs.get('presets');
    this.presetBtns = presets.map((p, i) => {
      const b = h('button', { class: 'ts-btn', 'aria-label': TOOLS[p.tool]?.label || p.tool, onclick: () => this.selectPreset(i) },
        icon(p.tool), h('span', { class: 'ts-dot' }));
      return b;
    });
    const eraser = h('button', { class: 'ts-btn', 'aria-label': 'Eraser (hold for quick erase)' }, icon('eraser'));
    let downAt = 0;
    eraser.addEventListener('pointerdown', (e) => { e.preventDefault(); downAt = performance.now(); this.quickEraser = true; this.updateStrip(); });
    const release = () => {
      if (!downAt) return;
      const short = performance.now() - downAt < 260; downAt = 0;
      this.quickEraser = false;
      if (short) this.eraserMode = !this.eraserMode;
      this.updateStrip();
    };
    eraser.addEventListener('pointerup', release);
    eraser.addEventListener('pointercancel', release);
    eraser.addEventListener('pointerleave', () => { if (downAt && performance.now() - downAt > 260) release(); });
    this.eraserBtn = eraser;

    this.colorBtn = h('button', { class: 'ts-btn ts-color', 'aria-label': 'Color', onclick: () => this.openColorPopover(this.colorBtn) }, h('span', { class: 'swatch big' }));
    this.widthBtn = h('button', { class: 'ts-btn ts-width mono', 'aria-label': 'Line weight', onclick: () => this.openWidthPopover(this.widthBtn) }, '');
    this.strip.append(...this.presetBtns, h('div', { class: 'ts-sep' }), eraser, h('div', { class: 'ts-sep' }), this.colorBtn, this.widthBtn,
      h('div', { class: 'ts-sep' }),
      h('button', { class: 'ts-btn', 'aria-label': 'Undo', onclick: () => this.undo() }, icon('undo')),
      h('button', { class: 'ts-btn', 'aria-label': 'Redo', onclick: () => this.redo() }, icon('redo')));
    this.updateStrip();
  }

  updateStrip() {
    const presets = this.prefs.get('presets');
    const active = this.prefs.get('activePreset');
    this.strip.classList.toggle('left', this.prefs.get('stripSide') === 'left');
    this.strip.style.display = this.meta ? '' : 'none';
    this.presetBtns?.forEach((b, i) => {
      const p = presets[i];
      b.classList.toggle('on', i === active && this.activeTool !== 'eraser');
      b.querySelector('.ts-dot').style.background = p.color;
    });
    this.eraserBtn?.classList.toggle('on', this.activeTool === 'eraser');
    this.eraserBtn?.classList.toggle('quick', this.quickEraser);
    const p = this.preset;
    if (this.colorBtn) this.colorBtn.querySelector('.swatch').style.background = p.color;
    if (this.widthBtn) this.widthBtn.textContent = p.tool === 'highlighter' ? `${p.width}` : `${p.width}`;
  }

  openColorPopover(anchor) {
    this.closePopover();
    const legend = this.legend || [];
    const nameOf = (c) => legend.find((l) => l.color === c)?.name;
    const swatch = (c, label) => h('button', { class: `swatch-btn ${this.preset.color === c ? 'on' : ''}`, title: label || c,
      onclick: () => { this.updatePreset({ color: c }); this.closePopover(); } },
      h('span', { class: 'swatch', style: { background: c } }), h('span', { class: 'sw-label' }, nameOf(c) || label || ''));
    const custom = h('input', { type: 'color', value: this.preset.color, class: 'color-input',
      onchange: (e) => { this.updatePreset({ color: e.target.value }); this.closePopover(); } });
    const used = [...new Set((this.doc?.strokes || []).map((s) => s.color).concat([...this.hiddenColors]))];
    const pop = h('div', { class: 'popover' },
      h('div', { class: 'pop-title' }, 'Engineering palette'),
      h('div', { class: 'swatch-grid' }, PALETTE.map((p) => swatch(p.color, p.name))),
      this.prefs.get('recentColors').length ? h('div', { class: 'pop-title' }, 'Recent') : null,
      h('div', { class: 'swatch-row' }, this.prefs.get('recentColors').map((c) => h('button', { class: 'swatch-mini', style: { background: c }, title: c,
        onclick: () => { this.updatePreset({ color: c }); this.closePopover(); } }))),
      h('label', { class: 'row gap' }, h('span', { class: 'muted' }, 'Custom'), custom),
      used.length ? h('div', { class: 'pop-title' }, 'Colors on this page') : null,
      h('div', { class: 'stack tight' }, used.map((c) => h('label', { class: 'row gap toggle-row' },
        h('input', { type: 'checkbox', checked: !this.hiddenColors.has(c),
          onchange: (e) => { e.target.checked ? this.hiddenColors.delete(c) : this.hiddenColors.add(c); this.render(); } }),
        h('span', { class: 'swatch', style: { background: displayColor(c, 'paper') } }),
        h('span', {}, nameOf(c) || PALETTE.find((p) => p.color === c)?.name || c)))));
    this.showPopover(pop, anchor);
  }

  openWidthPopover(anchor) {
    this.closePopover();
    const isHl = this.preset.tool === 'highlighter';
    const list = isHl ? HIGHLIGHTER_MM : LINE_WEIGHTS_MM;
    const pop = h('div', { class: 'popover' },
      h('div', { class: 'pop-title' }, isHl ? 'Highlighter width (mm)' : 'Line weight (mm)'),
      h('div', { class: 'weights' }, list.map((w) => h('button', { class: `weight ${this.preset.width === w ? 'on' : ''}`,
        onclick: () => { this.updatePreset({ width: w }); this.closePopover(); } },
        h('i', { style: { height: `${Math.max(1, w * 2.2)}px`, background: this.preset.color } }), h('span', { class: 'mono' }, String(w))))),
      h('div', { class: 'pop-title' }, 'Pen type'),
      h('div', { class: 'tool-grid' }, Object.entries(TOOLS).map(([k, t]) => h('button', { class: `tool-pick ${this.preset.tool === k ? 'on' : ''}`,
        onclick: () => { this.updatePreset({ tool: k, width: k === 'highlighter' ? 5 : (this.preset.tool === 'highlighter' ? 0.5 : this.preset.width) }); this.buildStrip(); this.closePopover(); } },
        icon(k), h('span', {}, t.label)))));
    this.showPopover(pop, anchor);
  }

  showPopover(pop, anchor) {
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const left = this.prefs.get('stripSide') === 'left';
    const x = left ? r.right + 10 : r.left - pop.offsetWidth - 10;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, x))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 8, r.top - 20))}px`;
    this.popover = pop;
    setTimeout(() => {
      this._popDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) this.closePopover(); };
      document.addEventListener('pointerdown', this._popDoc);
    }, 0);
  }

  closePopover() {
    this.popover?.remove(); this.popover = null;
    if (this._popDoc) document.removeEventListener('pointerdown', this._popDoc);
  }

  // ---- long-press tool wheel ----
  openWheel(x, y) {
    this.closeWheel();
    const presets = this.prefs.get('presets');
    const R1 = 62, R2 = 112;
    const wheel = h('div', { class: 'wheel', style: { left: `${x}px`, top: `${y}px` } },
      h('div', { class: 'wheel-ring' }),
      h('button', { class: 'wheel-center', 'aria-label': 'Close', onclick: () => this.closeWheel() }, icon('fit')));
    const items = presets.map((p, i) => ({ node: h('span', {}, icon(p.tool), h('span', { class: 'ts-dot', style: { background: p.color } })), act: () => this.selectPreset(i), on: !this.eraserMode && i === this.prefs.get('activePreset') }))
      .concat([{ node: icon('eraser'), act: () => this.setEraser(true), on: this.eraserMode }]);
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2;
      wheel.append(h('button', { class: `wheel-item ${it.on ? 'on' : ''}`, style: { transform: `translate(${Math.cos(a) * R1}px, ${Math.sin(a) * R1}px)` },
        onclick: () => { it.act(); this.closeWheel(); } }, it.node));
    });
    PALETTE.forEach((p, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) / PALETTE.length) * Math.PI * 2;
      wheel.append(h('button', { class: 'wheel-color', title: p.name, style: { background: p.color, transform: `translate(${Math.cos(a) * R2}px, ${Math.sin(a) * R2}px)` },
        onclick: () => { this.updatePreset({ color: p.color }); this.closeWheel(); } }));
    });
    document.body.append(wheel);
    this.wheel = wheel;
  }

  closeWheel() { this.wheel?.remove(); this.wheel = null; }

  setLegend(legend) { this.legend = legend; }

  updateReadoutSoon() { if (!this._roT) this._roT = requestAnimationFrame(() => { this._roT = null; this.updateReadout(); }); }

  onRemoteChange() { this.render(); }

  toggleOriginal() { this.showOriginal = !this.showOriginal; this.render(); toast(this.showOriginal ? 'Showing original handwriting' : 'Showing cleaned handwriting'); }
}

function centroid(pts) {
  return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
}
function spread(pts) {
  const c = centroid(pts);
  return pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.y - c.y), 0) / pts.length * 2;
}
function flash(host, text) {
  const f = h('div', { class: 'flash mono' }, text);
  host.append(f);
  setTimeout(() => f.remove(), 700);
}
