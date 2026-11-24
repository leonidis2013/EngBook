// EngBook — the page editor: canvas rendering, Apple Pencil input, finger gestures,
// tools, eraser, undo/redo, cleanup and the tool wheel.
// Copyright (c) 2026 Jerod Ulicki
import { h, uid, toast, modal } from './util.js';
import { icon } from './icons.js';
import { TOOLS, PALETTE, LINE_WEIGHTS_MM, HIGHLIGHTER_MM, UNITS_PER_INCH, UNITS_PER_MM,
  drawStroke, drawLiveStroke, strokeBounds, hitStroke, renderOrder, displayColor, invalidate } from './ink.js';
import { drawBackground, canvasAdapter, pageSize, styleOf, TONE_COLORS, gridAt } from './backgrounds.js';
import { recognize, snapShape, shapePoints, snapTargets, snapPoint, snapAngle, shapeName, shapeDistance, nearestEdge } from './shapes.js';
import { makeDim, drawDim, hitDim, dimValue, defaultOffset, formatLength, parseLength, scaleOf } from './dims.js';
import { smoothPoints, simplify, straightenStroke, cleanWord } from './cleanup.js';
import { applyOpsToDoc } from './store.js';
import { drawImageObj } from './assets.js';

const WRITING_TOOLS = new Set(['fineliner', 'tech', 'pencil', 'redline']);
const MIN_Z = 0.2, MAX_Z = 8;
const TAP_MS = 280, TAP_MOVE = 14, LONG_PRESS_MS = 520, HOLD_MS = 480, HOLD_PX = 4;

export class Editor {
  constructor(host, store, prefs) {
    this.host = host; this.store = store; this.prefs = prefs;
    this.view = { ox: 0, oy: 0, z: 1 };
    this.undoStack = []; this.redoStack = [];
    this.hiddenColors = new Set();
    this.showOriginal = false;
    this.eraserMode = false; this.quickEraser = false; this.dimMode = false; this.lassoMode = false;
    this.sel = null; this.dragHide = null;
    this.pageInfo = {};
    this.touches = new Map(); this.ignored = new Set();
    this.pencilSeen = false; this.lastPenUp = 0;
    this.cur = null; this.erasing = null; this.group = null;
    this.lastTap = null; this.inertia = null;

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
  get activeTool() { return this.eraserMode || this.quickEraser ? 'eraser' : this.dimMode ? 'dim' : this.lassoMode ? 'lasso' : this.preset.tool; }
  get dimensional() { return this.prefs.get('drawMode') === 'dim'; }
  get snap() { return this.prefs.get('snap'); }

  open(meta, doc) {
    this.finalizeGroup();
    this.meta = meta; this.doc = doc;
    this.undoStack = []; this.redoStack = [];
    this.hiddenColors.clear(); this.showOriginal = false;
    this.clearSelection();
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
    this.updateStrip();
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
      const m = W < 700 ? 12 : 40;
      const ins = this.insets();
      const avail = W - ins.left - ins.right;
      const z = Math.max(MIN_Z, Math.min(MAX_Z, (avail - m) / size.w));
      this.view = { z, ox: -(ins.left + (avail - size.w * z) / 2) / z, oy: -(m / 2) / z };
    } else {
      const z = 1.25;
      this.view = { z, ox: -W / 2 / z, oy: -H / 3 / z };
    }
    this.render();
    this.saveView();
  }

  /** Screen space the tool strip takes, so a fitted page is never covered by it. */
  insets() {
    if (!this.strip || this.W < 700 || this.strip.style.display === 'none') return { left: 0, right: 0 };
    const host = this.host.getBoundingClientRect(), r = this.strip.getBoundingClientRect();
    const left = r.left - host.left, right = host.right - r.right;
    if (left > this.W * 0.35 && right > this.W * 0.35) return { left: 0, right: 0 }; // floating mid-screen: don't reserve
    return left < right ? { left: left + r.width + 12, right: 0 } : { left: 0, right: right + r.width + 12 };
  }

  // ---- drag the tool strip anywhere (grip at the top); double-tap the grip to put it back ----
  placeStrip() {
    const pos = this.prefs.get('stripPos');
    const st = this.strip.style;
    if (!pos || this.W < 700) { st.left = st.top = st.right = st.transform = ''; return; }
    const w = this.strip.offsetWidth, hh = this.strip.offsetHeight;
    st.right = 'auto'; st.transform = 'none';
    st.left = `${Math.max(6, Math.min(this.W - w - 6, pos.x * this.W))}px`;
    st.top = `${Math.max(6, Math.min(this.H - hh - 6, pos.y * this.H))}px`;
  }

  bindStripDrag(grip) {
    let start = null, lastTap = 0;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const r = this.strip.getBoundingClientRect(), host = this.host.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left - host.left, top: r.top - host.top, moved: false };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      this.prefs.set('stripPos', { x: (start.left + dx) / this.W, y: (start.top + dy) / this.H });
      this.placeStrip();
    });
    const end = () => {
      if (!start) return;
      if (!start.moved) {
        const t = performance.now();
        if (t - lastTap < 350) { this.prefs.set('stripPos', null); this.placeStrip(); }
        lastTap = t;
      }
      start = null;
    };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------ sizing + rendering
  resize() {
    const r = this.wrap.getBoundingClientRect();
    // whole CSS pixels so the canvas maps 1:1 onto screen pixels (no resampling blur)
    this.W = Math.max(1, Math.floor(r.width)); this.H = Math.max(1, Math.floor(r.height));
    if (this.strip) this.placeStrip();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr);
      c.style.width = `${c.width / this.dpr}px`; c.style.height = `${c.height / this.dpr}px`;
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
    drawBackground(g, style, vis, z, this.pageInfo);
    g.flush();
    for (const s of renderOrder(this.doc.strokes)) {
      if (this.hiddenColors.has(s.color) || this.dragHide?.has(s.id)) continue;
      const b = strokeBounds(s);
      if (b.maxX < vis.x0 || b.minX > vis.x1 || b.maxY < vis.y0 || b.minY > vis.y1) continue;
      this.paint(ctx, s);
    }
    ctx.restore();
    this.updateReadout();
  }

  paint(ctx, s) {
    if (s.kind === 'image') { drawImageObj(ctx, s); return; }
    if (s.kind === 'dim') drawDim(ctx, s, { tone: this.tone, style: this.style, units: this.prefs.get('units'), bg: (TONE_COLORS[this.tone] || TONE_COLORS.paper).bg });
    else drawStroke(ctx, s, { tone: this.tone, showOriginal: this.showOriginal });
  }

  markOnb(k) { const o = this.prefs.get('onb') || {}; if (!o[k]) this.prefs.set('onb', { ...o, [k]: true }); }

  setPageInfo(info) { this.pageInfo = info || {}; this.render(); }

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
    this.paint(ctx, s);
    ctx.restore();
  }

  renderLive() {
    const ctx = this.live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!this.meta) return;
    const size = pageSize(this.style);
    ctx.save();
    this.pageTransform(ctx);
    if (size) { ctx.beginPath(); ctx.rect(0, 0, size.w, size.h); ctx.clip(); } // ink stays on the paper
    if (this.cur && this.preview && !this.cur.shape) {
      ctx.globalAlpha = 0.22; drawLiveStroke(ctx, { ...this.cur, opacity: 0.22 }, this.tone); ctx.globalAlpha = 1;
      drawLiveStroke(ctx, { ...this.cur, pts: this.preview.pts }, this.tone);
    } else if (this.cur) drawLiveStroke(ctx, this.cur, this.tone, this.cur.shape ? null : this.predicted);
    if (this.dimDraft?.dim) this.paint(ctx, this.dimDraft.dim);
    if (this.dragSel && this.sel) {
      ctx.translate(this.dragSel.dx, this.dragSel.dy);
      for (const o of renderOrder(this.selObjects())) this.paint(ctx, o);
      ctx.translate(-this.dragSel.dx, -this.dragSel.dy);
    }
    ctx.restore();
    if (this.lassoDraft || this.sel) {
      this.pageTransform(ctx);
      ctx.save();
      ctx.lineWidth = 1.2 / this.view.z; ctx.strokeStyle = '#22c3e6'; ctx.setLineDash([5 / this.view.z, 4 / this.view.z]);
      if (this.lassoDraft) {
        ctx.beginPath(); this.lassoDraft.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke();
        ctx.fillStyle = 'rgba(34,195,230,0.06)'; ctx.fill();
      }
      if (this.sel) {
        const b = this.sel.b, dx = this.dragSel?.dx || 0, dy = this.dragSel?.dy || 0, m = 6 / this.view.z;
        ctx.strokeRect(b.minX - m + dx, b.minY - m + dy, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m);
        ctx.fillStyle = 'rgba(34,195,230,0.05)'; ctx.fillRect(b.minX - m + dx, b.minY - m + dy, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m);
      }
      ctx.restore();
      this.placeSelBar();
    }
    if (this.snapMark) { // little target where a point snapped
      const { x, y } = this.snapMark;
      this.pageTransform(ctx);
      ctx.lineWidth = 1.5 / this.view.z; ctx.strokeStyle = '#22c3e6';
      ctx.beginPath(); ctx.arc(x, y, 6 / this.view.z, 0, Math.PI * 2); ctx.stroke();
    }
    if (this.liveLabel) {
      const { x, y, text } = this.liveLabel;
      const sx = (x - this.view.ox) * this.view.z, sy = (y - this.view.oy) * this.view.z;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.font = '600 12px "IBM Plex Mono", ui-monospace, Menlo, monospace';
      const w = ctx.measureText(text).width + 14;
      const bx = Math.min(this.W - w - 6, Math.max(6, sx + 14)), by = Math.max(6, sy - 40);
      ctx.fillStyle = 'rgba(13,15,18,0.88)'; ctx.strokeStyle = '#22c3e6'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(bx, by, w, 24, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6e9ee'; ctx.textAlign = 'left'; ctx.fillText(text, bx + 7, by + 16);
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
      else { this.view.ox += e.deltaX / this.view.z; this.view.oy += e.deltaY / this.view.z; this.clampView(); this.render(); }
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
    if (e.key === 'l') this.setMode(this.lassoMode ? null : 'lasso');
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSelection(); }
    if (e.key === 'Escape') this.clearSelection();
    if (/^[1-9]$/.test(e.key)) this.selectPreset(Number(e.key) - 1);
    if (e.key === '0') this.fit();
  }

  isDrawingPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0 && !this.spaceDown;
    if (e.pointerType === 'touch') return this.fingerDrawing() && this.touches.size === 0 && !this.cur;
    return false;
  }

  fingerDrawing() { return this.prefs.get('fingerDraw') && !this.pencilSeen && this.prefs.get('touchMode') === 'draw'; }

  onDown(e) {
    if (!this.meta) return;
    this.closeWheel();
    this.stopInertia();
    if (e.pointerType === 'pen') { const first = !this.pencilSeen; this.pencilSeen = true; this.cancelTouchGesture(); if (first && this.modeBtn) this.buildStrip(); }

    if (this.drawPointer == null && this.isDrawingPointer(e)) {
      this.live.setPointerCapture(e.pointerId);
      this.drawPointer = e.pointerId;
      this.drawType = e.pointerType;
      this.drawFinger = e.pointerType === 'touch' ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
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
    if (this.drawPointer != null && this.drawType === 'touch') {
      // keep the first finger as part of the pinch, so two fingers zoom
      const f = this.drawFinger;
      this.cur = null; this.drawPointer = null; this.erasing = null; this.dimDraft = null; this.clearHold(); this.liveLabel = null; this.renderLive();
      if (f) {
        this.touches.set(f.id, { x: f.x, y: f.y, sx: f.x, sy: f.y });
        this.gesture = { start: performance.now(), maxCount: 1, moved: true };
      }
    }

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
    this.lastMove = null; this.vel = null;
  }

  cancelTouchGesture() {
    clearTimeout(this.lpTimer);
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear(); this.gesture = null; this.pinch = null;
  }

  onMove(e) {
    if (!this.meta) return;
    if (e.pointerId === this.drawPointer) { if (this.drawFinger) { this.drawFinger.x = e.clientX; this.drawFinger.y = e.clientY; } this.moveDraw(e); return; }
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') { this.lastPos = this.toPage(e); this.updateReadoutSoon(); }
    if (this.mousePan && e.pointerType === 'mouse') {
      this.view.ox -= (e.clientX - this.mousePan.x) / this.view.z; this.view.oy -= (e.clientY - this.mousePan.y) / this.view.z;
      this.mousePan = { x: e.clientX, y: e.clientY }; this.clampView(); this.render(); return;
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
    const now = performance.now();
    if (this.lastMove && pts.length === 1) {
      const dt = Math.max(1, now - this.lastMove.t);
      const vx = (c.x - this.lastMove.x) / dt, vy = (c.y - this.lastMove.y) / dt;
      this.vel = { x: this.vel ? this.vel.x * 0.4 + vx * 0.6 : vx, y: this.vel ? this.vel.y * 0.4 + vy * 0.6 : vy };
    }
    this.lastMove = { x: c.x, y: c.y, t: now };
    this.view = { z, ox: px - (c.x - r.left) / z, oy: py - (c.y - r.top) / z };
    this.clampView();
    this.render();
  }

  // Keep at least part of a bounded page on screen so it can't get lost.
  clampView() {
    const size = pageSize(this.style);
    if (!size) return;
    // Like a scroll view: edges stop near the screen edge; a page smaller than the screen stays centred.
    const { z } = this.view, m = 24 / z, w = this.W / z, hh = this.H / z;
    this.view.ox = size.w + 2 * m <= w ? -(w - size.w) / 2 : Math.min(size.w - w + m, Math.max(-m, this.view.ox));
    this.view.oy = size.h + 2 * m <= hh ? -(hh - size.h) / 2 : Math.min(size.h - hh + m, Math.max(-m, this.view.oy));
  }

  startInertia() {
    const v = this.vel; this.vel = null;
    if (!v || Math.hypot(v.x, v.y) < 0.15 || performance.now() - (this.lastMove?.t || 0) > 80) return;
    let vx = v.x * 16, vy = v.y * 16; // px per frame
    const step = () => {
      vx *= 0.93; vy *= 0.93;
      if (Math.hypot(vx, vy) < 0.3) { this.inertia = null; this.saveViewSoon(); return; }
      this.view.ox -= vx / this.view.z; this.view.oy -= vy / this.view.z;
      this.clampView(); this.renderBase();
      this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  stopInertia() { if (this.inertia) { cancelAnimationFrame(this.inertia); this.inertia = null; } }

  // Double-tap: zoom in to 2.5x at that spot, or back to fit.
  doubleTapZoom(x, y) {
    const size = pageSize(this.style);
    const fitZ = size ? (this.W - (this.W < 700 ? 12 : 40)) / size.w : 1.25;
    if (this.view.z > fitZ * 1.3) { this.fit(); return; }
    this.zoomAt(x, y, Math.max(fitZ * 2.5, 1.5));
    this.clampView(); this.saveViewSoon();
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
    const g = this.gesture; this.gesture = null; this.pinch = null; this.lastMove = null;
    this.saveViewSoon();
    if (g && !g.consumed && g.moved && g.maxCount === 1) { this.startInertia(); return; }
    this.vel = null;
    if (!g || g.consumed || g.moved || performance.now() - g.start > TAP_MS) return;
    if (g.maxCount === 1) {
      const t = performance.now();
      if (this.lastTap && t - this.lastTap.t < 320 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 40) {
        this.lastTap = null; this.doubleTapZoom(e.clientX, e.clientY);
      } else this.lastTap = { t, x: e.clientX, y: e.clientY };
      return;
    }
    if (g.maxCount === 2) this.undo();
    else if (g.maxCount === 3) this.redo();
  }

  // ------------------------------------------------------------------ drawing
  snapOpts(exceptId) {
    const sn = this.snap, z = this.view.z;
    return {
      targets: sn.ends ? snapTargets(this.doc.strokes, exceptId) : null,
      targetTol: 14 / z, gridTol: 12 / z,
      grid: (x, y) => gridAt(this.style, x, y),
      gridOn: sn.on && sn.grid, endsOn: sn.on && sn.ends, angleOn: sn.on && sn.angle,
    };
  }

  inPage(p, pad = 0) {
    const size = pageSize(this.style);
    return !size || (p.x >= -pad && p.y >= -pad && p.x <= size.w + pad && p.y <= size.h + pad);
  }

  startDraw(e) {
    const p0 = this.toPage(e);
    if (!this.inPage(p0, 2)) { this.drawPointer = null; return; } // strokes start on the paper
    if (this.activeTool === 'dim') { this.startDim(p0); return; }
    if (this.activeTool === 'lasso') { this.startLasso(p0); return; }
    if (this.activeTool === 'eraser') {
      this.erasing = { ops: [] };
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
    const size = pageSize(this.style);
    if (size) { p.x = Math.max(0, Math.min(size.w, p.x)); p.y = Math.max(0, Math.min(size.h, p.y)); }
    const pts = this.cur.pts;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 0.35 / Math.max(0.5, this.view.z)) return;
    const pressure = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5;
    const pt = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(pressure * 1000) / 1000, Date.now() - this.cur.t0];
    if (e.pointerType === 'pen' && this.cur.tool === 'pencil') { // tilt shading
      let alt = e.altitudeAngle;
      if (alt == null && (e.tiltX || e.tiltY)) { const tx = Math.tan(e.tiltX * Math.PI / 180), ty = Math.tan(e.tiltY * Math.PI / 180); alt = Math.atan(1 / Math.hypot(tx, ty)); }
      if (alt != null) pt.push(Math.round(alt * 100) / 100);
    }
    pts.push(pt);
  }

  moveDraw(e) {
    this.lastPos = this.toPage(e);
    if (this.erasing) {
      const evs = e.getCoalescedEvents?.() || [e];
      for (const ev of (evs.length ? evs : [e])) this.eraseAt(this.toPage(ev));
      return;
    }
    if (this.dimDraft) { this.moveDim(this.toPage(e), e); return; }
    if (this.lassoDraft || this.dragSel) { this.moveLasso(this.toPage(e)); return; }
    if (!this.cur) return;
    if (this.cur.shape) { this.adjustShape(this.toPage(e)); return; }
    const evs = e.getCoalescedEvents?.() || [];
    for (const ev of (evs.length ? evs : [e])) this.addPoint(ev);
    if (this.dimensional && this.cur.tool !== 'highlighter') this.updatePreview();
    // hold the pencil still at the end of a stroke to snap it into a clean shape
    if (this.snap.on) {
      if (!this.holdAnchor || Math.hypot(e.clientX - this.holdAnchor.x, e.clientY - this.holdAnchor.y) > HOLD_PX) {
        this.holdAnchor = { x: e.clientX, y: e.clientY };
        clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => this.snapCurrent(), HOLD_MS);
      }
    }
    const pred = e.getPredictedEvents?.() || [];
    this.predicted = pred.slice(0, 2).map((ev) => { const p = this.toPage(ev); return [p.x, p.y, ev.pressure || 0.5]; });
    this.renderLive();
  }

  clearHold() { clearTimeout(this.holdTimer); this.holdAnchor = null; }

  /** Dimensional mode: show the clean, snapped shape while the stroke is still being drawn. */
  updatePreview() {
    const now = performance.now();
    if (this._pvT && now - this._pvT < 35) return;
    this._pvT = now;
    const c = this.cur;
    const b = strokeBounds({ ...c, _b: undefined, pts: c.pts });
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) < 22) { this.preview = null; this.liveLabel = null; return; }
    const sh = recognize(c.pts);
    if (!sh) { this.preview = null; this.liveLabel = null; return; }
    const opts = this.snapOpts(); const sn = this.snap;
    opts.gridOn = sn.grid; opts.endsOn = sn.ends; opts.angleOn = sn.angle;
    const snapped = snapShape(sh, opts);
    this.preview = { shape: snapped, pts: shapePoints(snapped) };
    this.liveLabel = this.measureLabel(snapped);
  }

  snapCurrent() {
    const c = this.cur;
    if (!c || c.shape || this.drawPointer == null) return;
    const sh = recognize(c.pts);
    if (!sh) return;
    const snapped = snapShape(sh, this.snapOpts());
    c.raw = c.pts.slice();
    c.shape = snapped;
    c.pts = shapePoints(snapped);
    this.liveLabel = this.measureLabel(snapped);
    navigator.vibrate?.(10);
    this.markOnb('snap');
    flash(this.host, shapeName(snapped));
    this.renderLive();
  }

  // after snapping a line or polyline, the pencil keeps steering the last point
  adjustShape(p) {
    const sh = this.cur.shape;
    if (sh.type !== 'line' && !(sh.type === 'poly' && !sh.closed)) return;
    const opts = this.snapOpts();
    const anchor = sh.type === 'line' ? sh.a : sh.pts[sh.pts.length - 2];
    let q = opts.angleOn ? snapAngle(anchor, [p.x, p.y]) : [p.x, p.y];
    const sp = snapPoint(q, opts);
    if (sp.kind) q = sp.p;
    this.snapMark = sp.kind ? { x: q[0], y: q[1] } : null;
    if (sh.type === 'line') sh.b = q; else sh.pts[sh.pts.length - 1] = q;
    this.cur.pts = shapePoints(sh);
    this.liveLabel = this.measureLabel(sh);
    this.renderLive();
  }

  measureLabel(sh) {
    const units = this.prefs.get('units'), st = this.style;
    const L = (u) => formatLength(u, st, units);
    if (sh.type === 'line') {
      const dx = sh.b[0] - sh.a[0], dy = sh.b[1] - sh.a[1];
      let ang = Math.round(-Math.atan2(dy, dx) * 180 / Math.PI); if (ang < 0) ang += 360;
      return { x: sh.b[0], y: sh.b[1], text: `${L(Math.hypot(dx, dy))}  ${ang}°` };
    }
    if (sh.type === 'circle') return { x: sh.c[0] + sh.r, y: sh.c[1] - sh.r, text: `Ø${L(sh.r * 2)}` };
    if (sh.type === 'arc') return { x: sh.c[0], y: sh.c[1], text: `R${L(sh.r)}  ${Math.round(Math.abs(sh.sweep) * 180 / Math.PI)}°` };
    if (sh.type === 'ellipse') return { x: sh.c[0] + sh.rx, y: sh.c[1] - sh.ry, text: `${L(sh.rx * 2)} × ${L(sh.ry * 2)}` };
    if (sh.type === 'poly' && sh.rect) {
      const w = Math.hypot(sh.pts[1][0] - sh.pts[0][0], sh.pts[1][1] - sh.pts[0][1]), hh = Math.hypot(sh.pts[2][0] - sh.pts[1][0], sh.pts[2][1] - sh.pts[1][1]);
      return { x: sh.pts[2][0], y: sh.pts[1][1], text: `${L(w)} × ${L(hh)}` };
    }
    if (sh.type === 'poly') { const last = sh.pts[sh.pts.length - 1]; const pr = sh.pts[sh.pts.length - 2]; return { x: last[0], y: last[1], text: L(Math.hypot(last[0] - pr[0], last[1] - pr[1])) }; }
    return null;
  }

  // ---------------------------------------------------------------- drawing modes
  /** Dimensional mode: a finished stroke becomes a clean, snapped shape (small strokes like letters stay as written). */
  autoSnap(s) {
    const b = strokeBounds(s);
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) < 22) return;
    const sh = recognize(s.pts);
    if (!sh) return;
    const opts = this.snapOpts();
    const sn = this.snap;
    opts.gridOn = sn.grid; opts.endsOn = sn.ends; opts.angleOn = sn.angle; // always on in dimensional mode
    const snapped = snapShape(sh, opts);
    s.raw = s.raw || s.pts; s.shape = snapped; s.pts = shapePoints(snapped);
    invalidate(s);
    const lbl = this.measureLabel(snapped);
    flash(this.host, lbl ? `${shapeName(snapped)} · ${lbl.text}` : shapeName(snapped));
  }

  setMode(m) {
    this.eraserMode = m === 'eraser'; this.dimMode = m === 'dim'; this.lassoMode = m === 'lasso';
    if (m !== 'lasso') this.clearSelection();
    if (m && this.modeBtn) this.prefs.set('touchMode', 'draw');
    this.updateStrip();
  }

  // ---------------------------------------------------------------- lasso
  startLasso(p) {
    if (this.sel && p.x >= this.sel.b.minX - 8 && p.x <= this.sel.b.maxX + 8 && p.y >= this.sel.b.minY - 8 && p.y <= this.sel.b.maxY + 8) {
      this.dragSel = { from: p, dx: 0, dy: 0 };
      this.dragHide = new Set(this.sel.ids);
      this.render();
      return;
    }
    this.clearSelection();
    this.lassoDraft = [[p.x, p.y]];
  }

  moveLasso(p) {
    if (this.dragSel) {
      this.dragSel.dx = p.x - this.dragSel.from.x; this.dragSel.dy = p.y - this.dragSel.from.y;
      this.renderLive(); return;
    }
    const last = this.lassoDraft[this.lassoDraft.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) * this.view.z > 3) this.lassoDraft.push([p.x, p.y]);
    this.renderLive();
  }

  endLasso() {
    if (this.dragSel) {
      const { dx, dy } = this.dragSel; this.dragSel = null; this.dragHide = null;
      if (Math.hypot(dx, dy) * this.view.z > 2) {
        const olds = this.selObjects();
        this.replaceObjects(olds, olds.map((o) => translateObj(o, dx, dy)));
      } else this.render();
      return;
    }
    const poly = this.lassoDraft; this.lassoDraft = null;
    if (!poly || poly.length < 4) { this.renderLive(); return; }
    const ids = [];
    for (const s of this.doc.strokes) {
      if (this.hiddenColors.has(s.color)) continue;
      const pts = s.kind === 'image' ? [[s.x + s.w / 2, s.y + s.h / 2]] : s.kind === 'dim' ? [[(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]] : s.pts;
      let inside = 0;
      for (const q of pts) if (pointInPoly(q, poly)) inside++;
      if (inside / pts.length >= 0.6) ids.push(s.id);
    }
    if (ids.length) this.select(ids); else { this.renderLive(); toast('Nothing inside the lasso.'); }
  }

  select(ids) {
    const objs = ids.map((id) => this.doc.byId.get(id)).filter(Boolean);
    if (!objs.length) { this.clearSelection(); return; }
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const o of objs) { const x = strokeBounds(o); b.minX = Math.min(b.minX, x.minX); b.minY = Math.min(b.minY, x.minY); b.maxX = Math.max(b.maxX, x.maxX); b.maxY = Math.max(b.maxY, x.maxY); }
    if (objs.some((o) => o.kind === 'dim')) { b.minX -= 12; b.minY -= 12; b.maxX += 12; b.maxY += 12; }
    this.sel = { ids: objs.map((o) => o.id), b };
    this.showSelBar();
    this.renderLive();
  }

  selObjects() { return (this.sel?.ids || []).map((id) => this.doc.byId.get(id)).filter(Boolean); }

  clearSelection() {
    this.sel = null; this.dragSel = null; this.dragHide = null; this.lassoDraft = null;
    this.selBar?.remove(); this.selBar = null;
    if (this.meta) this.renderLive();
  }

  replaceObjects(olds, news, select = true) {
    if (!olds.length) return;
    // moved shapes get new ids: point dimensions that moved with them at the new ids
    const idMap = new Map(olds.map((o, i) => [o.id, news[i]?.id]));
    for (const n of news) if (n.kind === 'dim' && n.ref && idMap.get(n.ref.id)) n.ref = { ...n.ref, id: idMap.get(n.ref.id) };
    const ops = [...olds.map((o) => ({ op: 'del', id: o.id })), ...news.map((n) => ({ op: 'add', stroke: n }))];
    this.store.pageOps(this.doc.id, ops);
    this.pushHistory({
      undo: [...news.map((n) => ({ op: 'del', id: n.id })), ...olds.map((o) => ({ op: 'undel', id: o.id }))],
      redo: [...olds.map((o) => ({ op: 'del', id: o.id })), ...news.map((n) => ({ op: 'undel', id: n.id }))],
    });
    this.render();
    if (select) this.select(news.map((n) => n.id));
  }

  deleteSelection() {
    const objs = this.selObjects();
    if (!objs.length) return;
    this.store.pageOps(this.doc.id, objs.map((o) => ({ op: 'del', id: o.id })));
    this.pushHistory({ undo: objs.map((o) => ({ op: 'undel', id: o.id })), redo: objs.map((o) => ({ op: 'del', id: o.id })) });
    this.clearSelection(); this.render();
  }

  duplicateSelection() {
    const objs = this.selObjects();
    if (!objs.length) return;
    const copies = objs.map((o) => translateObj(o, 24, 24));
    this.store.pageOps(this.doc.id, copies.map((c) => ({ op: 'add', stroke: c })));
    this.pushHistory({ undo: copies.map((c) => ({ op: 'del', id: c.id })), redo: copies.map((c) => ({ op: 'undel', id: c.id })) });
    this.render();
    this.select(copies.map((c) => c.id));
  }

  recolorSelection(color) {
    const objs = this.selObjects().filter((o) => o.kind !== 'image');
    this.replaceObjects(objs, objs.map((o) => ({ ...translateObj(o, 0, 0), color })));
  }

  showSelBar() {
    this.selBar?.remove();
    const btn = (ic, label, fn) => h('button', { class: 'sel-btn', 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic));
    this.selBar = h('div', { class: 'selbar' },
      h('span', { class: 'sel-count mono' }, `${this.sel.ids.length}`),
      ...PALETTE.slice(0, 4).map((p) => h('button', { class: 'sel-swatch', style: { background: p.color }, title: p.name, onclick: () => this.recolorSelection(p.color) })),
      btn('copy', 'Duplicate', () => this.duplicateSelection()),
      btn('trash', 'Delete', () => this.deleteSelection()),
      btn('check', 'Done', () => this.clearSelection()));
    this.host.append(this.selBar);
    this.placeSelBar();
  }

  placeSelBar() {
    if (!this.selBar || !this.sel) return;
    const { ox, oy, z } = this.view, b = this.sel.b;
    const dx = this.dragSel ? this.dragSel.dx : 0, dy = this.dragSel ? this.dragSel.dy : 0;
    const x = ((b.minX + b.maxX) / 2 + dx - ox) * z, y = (b.minY + dy - oy) * z;
    const w = this.selBar.offsetWidth;
    this.selBar.style.left = `${Math.max(8, Math.min(this.W - w - 8, x - w / 2))}px`;
    this.selBar.style.top = `${Math.max(8, y - 54)}px`;
  }

  // ---------------------------------------------------------------- dimension tool
  startDim(p) {
    const opts = this.snapOpts();
    opts.endsOn = true; // dimensions always lock onto shape points
    const sp = snapPoint([p.x, p.y], opts);
    const onDim = this.doc.strokes.find((x) => x.kind === 'dim' && hitDim(x, p.x, p.y, 8 / this.view.z));
    this.dimDraft = { start: sp.p, down: { x: p.x, y: p.y }, moved: false, dim: null, onDim };
    this.snapMark = sp.kind ? { x: sp.p[0], y: sp.p[1] } : null;
    this.renderLive();
  }

  moveDim(p) {
    const d = this.dimDraft;
    if (!d.moved && Math.hypot(p.x - d.down.x, p.y - d.down.y) * this.view.z < 10) return;
    d.moved = true;
    const opts = this.snapOpts(); opts.endsOn = true;
    let q = opts.angleOn ? snapAngle(d.start, [p.x, p.y], 4) : [p.x, p.y];
    const sp = snapPoint(q, opts);
    if (sp.kind) q = sp.p;
    this.snapMark = sp.kind ? { x: q[0], y: q[1] } : null;
    d.dim = makeDim('draft', 'linear', d.start, q, defaultOffset(d.start, q), this.preset.color === '#f59e0b' ? '#111111' : this.preset.color);
    this.liveLabel = { x: q[0], y: q[1], text: dimValue(d.dim, this.style, this.prefs.get('units')) };
    this.renderLive();
  }

  endDim() {
    const d = this.dimDraft; this.dimDraft = null; this.snapMark = null; this.liveLabel = null;
    const color = this.preset.tool === 'highlighter' ? '#111111' : this.preset.color;
    let dims = [];
    if (d.moved && d.dim) {
      if (Math.hypot(d.dim.b[0] - d.dim.a[0], d.dim.b[1] - d.dim.a[1]) > 3) dims = [makeDim(uid(), 'linear', d.dim.a, d.dim.b, d.dim.off, color)];
    } else if (d.onDim) {
      this.renderLive(); this.editDim(d.onDim); return;
    } else {
      dims = this.dimsForTap(d.down, color);
      if (!dims.length) toast('Tap a snapped shape, or drag between two points to dimension.');
    }
    this.renderLive();
    if (!dims.length) return;
    this.markOnb('snap');
    this.store.pageOps(this.doc.id, dims.map((x) => ({ op: 'add', stroke: x })));
    this.pushHistory({ undo: dims.map((x) => ({ op: 'del', id: x.id })), redo: dims.map((x) => ({ op: 'undel', id: x.id })) });
    this.render();
  }

  dimsForTap(p, color) {
    const tol = 14 / this.view.z;
    let best = null, bd = tol;
    for (const s of this.doc.strokes) {
      if (!s.shape || this.hiddenColors.has(s.color)) continue;
      const dd = shapeDistance(s.shape, [p.x, p.y]);
      if (dd < bd) { bd = dd; best = s; }
    }
    if (!best) return [];
    const sh = best.shape;
    // every dimension remembers which shape (and which edge) it measures, so typing a size can resize it
    const D = (part, outward) => {
      const g = dimGeom(sh, part);
      const off = g.type === 'linear' ? defaultOffset(g.a, g.b, outward) : 0;
      const d = makeDim(uid(), g.type, g.a, g.b, off, color);
      d.ref = { id: best.id, part };
      return d;
    };
    if (sh.type === 'line') return [D('line')];
    if (sh.type === 'circle') return [D('dia')];
    if (sh.type === 'arc') return [D('rad')];
    if (sh.type === 'ellipse') return [D('w'), D('h', [1, 0])];
    if (sh.type === 'poly') {
      const pts = sh.pts, n = pts.length;
      const cx = pts.reduce((a, q) => a + q[0], 0) / n, cy = pts.reduce((a, q) => a + q[1], 0) / n;
      const edge = (i) => {
        const a = pts[i], b = pts[(i + 1) % n];
        return D(`edge:${i}`, sh.closed ? [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy] : null);
      };
      if (sh.rect) {
        const edges = [0, 1, 2, 3].map((i) => ({ i, mid: [(pts[i][0] + pts[(i + 1) % 4][0]) / 2, (pts[i][1] + pts[(i + 1) % 4][1]) / 2] }));
        const top = edges.reduce((m, e) => (e.mid[1] < m.mid[1] ? e : m));
        const right = edges.reduce((m, e) => (e.mid[0] > m.mid[0] ? e : m));
        return [edge(top.i), edge(right.i)];
      }
      return [edge(nearestEdge(sh, [p.x, p.y]))];
    }
    return [];
  }

  // ---- type a real size into a dimension ----
  editDim(d) {
    const units = this.prefs.get('units'), st = this.style;
    const shapeStroke = d.ref && this.doc.byId.get(d.ref.id);
    const current = dimValue({ ...d, text: undefined }, st, units);
    const input = h('input', { class: 'input mono', value: d.text || current.replace(/^[ØR]/, ''), inputmode: 'decimal', autocomplete: 'off' });
    const err = h('div', { class: 'form-error' });
    const finish = () => m.close();
    const doResize = () => {
      const inches = parseLength(input.value, units, scaleOf(st).arch);
      if (!(inches > 0)) { err.textContent = 'Type a size such as 2.5, 63.5 mm, 2 1/2" or 3\'-6".'; return; }
      const L = (inches * 96) / scaleOf(st).f; // page units
      this.resizeFromDim(d, shapeStroke, L);
      finish();
    };
    const doLabel = () => {
      const v = input.value.trim();
      this.replaceObjects([d], [{ ...JSON.parse(JSON.stringify(d)), id: uid(), text: v || undefined }], false);
      finish();
    };
    const m = modal('Dimension', h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); shapeStroke ? doResize() : doLabel(); } },
      h('p', { class: 'muted small' }, `Measured: ${current} at scale ${scaleOf(st).short}.`),
      input, err,
      shapeStroke ? h('button', { type: 'submit', class: 'btn primary' }, 'Resize the shape to this size') : null,
      h('button', { type: shapeStroke ? 'button' : 'submit', class: `btn ${shapeStroke ? 'ghost' : 'primary'}`, onclick: shapeStroke ? doLabel : null }, 'Change the label only'),
      d.text ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { this.replaceObjects([d], [{ ...JSON.parse(JSON.stringify(d)), id: uid(), text: undefined }], false); finish(); } }, 'Show the measured size again') : null,
      !shapeStroke ? h('p', { class: 'muted small' }, 'Dimensions placed by tapping a snapped shape can also resize that shape.') : null));
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  resizeFromDim(d, stroke, L) {
    const sh = JSON.parse(JSON.stringify(stroke.shape));
    const part = d.ref.part;
    const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, l]; };
    if (sh.type === 'line') { const [ux, uy] = unit(sh.a, sh.b); sh.b = [sh.a[0] + ux * L, sh.a[1] + uy * L]; }
    else if (sh.type === 'circle') sh.r = L / 2;
    else if (sh.type === 'arc') sh.r = L;
    else if (sh.type === 'ellipse') { if (part === 'w') sh.rx = L / 2; else sh.ry = L / 2; }
    else if (sh.type === 'poly' && part.startsWith('edge:')) {
      const i = Number(part.slice(5)), n = sh.pts.length;
      const [ux, uy, len] = unit(sh.pts[i], sh.pts[(i + 1) % n]);
      const dx = ux * (L - len), dy = uy * (L - len);
      const move = (k) => { sh.pts[k] = [sh.pts[k][0] + dx, sh.pts[k][1] + dy]; };
      if (sh.rect) { move((i + 1) % 4); move((i + 2) % 4); }
      else if (sh.closed) move((i + 1) % n);
      else for (let k = i + 1; k < n; k++) move(k);
    }
    const ns = { ...JSON.parse(JSON.stringify(stroke)), id: uid(), shape: sh, pts: shapePoints(sh) };
    delete ns.raw;
    const oldDims = this.doc.strokes.filter((x) => x.kind === 'dim' && x.ref?.id === stroke.id);
    const newDims = oldDims.map((od) => {
      const g = dimGeom(sh, od.ref.part);
      const nd = makeDim(uid(), g.type, g.a, g.b, od.off, od.color);
      nd.ref = { id: ns.id, part: od.ref.part };
      if (od.text && od.id !== d.id) nd.text = od.text;
      return nd;
    });
    this.replaceObjects([stroke, ...oldDims], [ns, ...newDims], false);
    flash(this.host, `Resized to ${formatLength(L, this.style, this.prefs.get('units'))}`);
  }


  endDraw() {
    this.predicted = null;
    this.clearHold();
    if (this.dimDraft) { this.endDim(); return; }
    if (this.lassoDraft || this.dragSel) { this.endLasso(); return; }
    if (this.erasing) {
      const ops = this.erasing.ops; this.erasing = null; this.eraserCursor = null; this.renderLive();
      if (ops.length) {
        this.store.pageOps(this.doc.id, ops);
        const inv = (o) => (o.op === 'add' ? { op: 'del', id: o.stroke.id } : { op: 'undel', id: o.id });
        const fwd = (o) => (o.op === 'add' ? { op: 'undel', id: o.stroke.id } : o);
        this.pushHistory({ undo: ops.slice().reverse().map(inv), redo: ops.map(fwd) });
      }
      return;
    }
    const s = this.cur; this.cur = null;
    if (!s || !s.pts.length) { this.renderLive(); return; }
    delete s.t0;
    this.liveLabel = null; this.snapMark = null;
    const cleanup = this.prefs.get('cleanup');
    if (!s.shape && cleanup.on && s.tool !== 'highlighter' && s.pts.length > 3) {
      const raw = s.pts;
      let pts = smoothPoints(simplify(s.pts, 0.45), cleanup.smooth);
      // uppercase engineering lettering: strokes that are straight runs with corners become crisp
      if (this.prefs.get('lettering') === 'upper' && cleanup.crisp !== false && WRITING_TOOLS.has(s.tool) && !this.dimensional) pts = straightenStroke(pts, cleanup.smooth);
      if (pts !== raw) { s.raw = raw; s.pts = pts; }
    }
    if (this.dimensional && !s.shape && s.tool !== 'highlighter') this.autoSnap(s);
    this.preview = null;
    s.created = Date.now();
    this.store.pageOps(this.doc.id, [{ op: 'add', stroke: s }]);
    this.pushHistory({ undo: [{ op: 'del', id: s.id }], redo: [{ op: 'undel', id: s.id }] });
    this.drawCommitted(s);
    this.renderLive();
    if (!s.shape && cleanup.on && WRITING_TOOLS.has(s.tool)) this.trackWord(s);
  }

  eraseAt(p) {
    const r = Math.max(5, 12 / this.view.z);
    this.eraserCursor = { x: p.x, y: p.y, r };
    const part = this.prefs.get('eraserKind') === 'part';
    const ops = [];
    for (const s of this.doc.strokes.slice()) {
      if (s.kind === 'image' || this.hiddenColors.has(s.color)) continue;
      const hit = s.kind === 'dim' ? hitDim(s, p.x, p.y, r) : hitStroke(s, p.x, p.y, r);
      if (!hit) continue;
      ops.push({ op: 'del', id: s.id });
      if (part && s.kind !== 'dim') for (const piece of splitStroke(s, p.x, p.y, r)) ops.push({ op: 'add', stroke: piece });
    }
    if (ops.length) {
      applyOpsToDoc(this.doc, ops);
      this.erasing.ops.push(...ops);
      this.render();
    } else this.renderLive();
  }

  // ---- word grouping for baseline straightening ----
  /** Nearest writing line for a baseline: ruled lines on lined paper, grid lines on grid pages. */
  rowAt(y) {
    const st = this.style;
    if (['blank', 'polar', 'semilog'].includes(st.type)) return null;
    const g = gridAt(st, 0, y);
    if (!g) return null;
    return Math.abs(g.y - y) <= g.s * 0.5 ? g.y : null;
  }

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
    const strokes = g.ids.map((id) => this.doc.byId.get(id)).filter((x) => x && !x.shape);
    if (!strokes.length) return;
    const cleanup = this.prefs.get('cleanup');
    const upper = this.prefs.get('lettering') === 'upper';
    const profile = this.prefs.get('hwProfile');
    const fixed = cleanWord(strokes.map((x) => x.pts), {
      strength: Math.max(0.35, cleanup.smooth ?? 0.5),
      upright: upper && cleanup.upright !== false,
      targetSlant: !upper && profile?.slant != null ? profile.slant : null,
      equalize: upper && cleanup.equalize !== false,
      level: cleanup.straighten !== false,
      alignY: cleanup.align !== false ? (y) => this.rowAt(y) : null,
    });
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
    this.eraserMode = false; this.dimMode = false; this.lassoMode = false; this.clearSelection();
    if (this.modeBtn) this.prefs.set('touchMode', 'draw');
    this.updateStrip();
  }

  setEraser(on) { this.eraserMode = on; if (on) { this.dimMode = false; this.lassoMode = false; this.clearSelection(); } if (on && this.modeBtn) this.prefs.set('touchMode', 'draw'); this.updateStrip(); }

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
      if (short) { this.eraserMode = !this.eraserMode; if (this.eraserMode) { this.dimMode = false; this.lassoMode = false; this.clearSelection(); } if (this.eraserMode && this.modeBtn) this.prefs.set('touchMode', 'draw'); }
      this.updateStrip();
    };
    eraser.addEventListener('pointerup', release);
    eraser.addEventListener('pointercancel', release);
    eraser.addEventListener('pointerleave', () => { if (downAt && performance.now() - downAt > 260) release(); });
    this.eraserBtn = eraser;

    this.dimBtn = h('button', { class: 'ts-btn', 'aria-label': 'Dimension tool', onclick: () => { this.dimMode = !this.dimMode; if (this.dimMode) { this.eraserMode = false; this.lassoMode = false; this.clearSelection(); if (this.modeBtn) this.prefs.set('touchMode', 'draw'); } this.updateStrip(); flash(this.host, this.dimMode ? 'Dimension: tap a shape or drag' : 'Dimension off'); } }, icon('dim'));
    this.snapBtn = h('button', { class: 'ts-btn', 'aria-label': 'Snap on/off', onclick: () => { const sn = { ...this.snap, on: !this.snap.on }; this.prefs.set('snap', sn); this.updateStrip(); flash(this.host, sn.on ? 'Snap on: hold the pencil to snap a shape' : 'Snap off'); } }, icon('magnet'));
    this.colorBtn = h('button', { class: 'ts-btn ts-color', 'aria-label': 'Color', onclick: () => this.openColorPopover(this.colorBtn) }, h('span', { class: 'swatch big' }));
    this.widthBtn = h('button', { class: 'ts-btn ts-width mono', 'aria-label': 'Line weight', onclick: () => this.openWidthPopover(this.widthBtn) }, '');
    this.modeBtn = null;
    if (this.prefs.get('fingerDraw') && !this.pencilSeen) {
      this.modeBtn = h('button', { class: 'ts-btn ts-mode', 'aria-label': 'Switch between moving and drawing',
        onclick: () => { this.prefs.set('touchMode', this.prefs.get('touchMode') === 'draw' ? 'nav' : 'draw'); this.updateStrip(); flash(this.host, this.prefs.get('touchMode') === 'draw' ? 'Draw with finger' : 'Move and zoom'); } });
      this.strip.append(this.modeBtn, h('div', { class: 'ts-sep' }));
    }
    this.lassoBtn = h('button', { class: 'ts-btn', 'aria-label': 'Lasso select', onclick: () => this.setMode(this.lassoMode ? null : 'lasso') }, icon('lasso'));
    this.drawModeBtn = h('button', { class: 'ts-btn', 'aria-label': 'Freestyle or Dimensional drawing',
      onclick: () => { const dim = !this.dimensional; this.prefs.set('drawMode', dim ? 'dim' : 'free'); this.updateStrip(); flash(this.host, dim ? 'Dimensional: strokes snap into clean shapes' : 'Freestyle: ink stays as drawn'); } });
    this.collapseBtn = h('button', { class: 'ts-btn ts-collapse keep', 'aria-label': 'Collapse tools', onclick: () => { this.prefs.set('stripCollapsed', !this.prefs.get('stripCollapsed')); this.updateStrip(); setTimeout(() => this.render(), 50); } });
    const grip = h('div', { class: 'ts-grip keep', title: 'Drag to move · double-tap to reset' }, h('i'), h('i'), h('i'));
    this.bindStripDrag(grip);
    this.strip.prepend(grip, this.collapseBtn);
    this.strip.append(...this.presetBtns, h('div', { class: 'ts-sep' }), eraser, this.lassoBtn, this.dimBtn, h('div', { class: 'ts-sep' }), this.drawModeBtn, this.snapBtn, h('div', { class: 'ts-sep' }), this.colorBtn, this.widthBtn,
      h('div', { class: 'ts-sep' }),
      h('button', { class: 'ts-btn', 'aria-label': 'Undo', onclick: () => this.undo() }, icon('undo')),
      h('button', { class: 'ts-btn', 'aria-label': 'Redo', onclick: () => this.redo() }, icon('redo')));
    this.updateStrip();
  }

  updateStrip() {
    const presets = this.prefs.get('presets');
    const active = this.prefs.get('activePreset');
    this.strip.classList.toggle('left', this.prefs.get('stripSide') === 'left');
    requestAnimationFrame(() => this.placeStrip());
    this.strip.style.display = this.meta ? '' : 'none';
    if (this.modeBtn) {
      const draw = this.prefs.get('touchMode') === 'draw';
      this.modeBtn.replaceChildren(icon(draw ? 'fineliner' : 'hand'));
      this.modeBtn.classList.toggle('on', true);
      this.modeBtn.classList.toggle('nav', !draw);
    }
    this.presetBtns?.forEach((b, i) => {
      const p = presets[i];
      b.classList.toggle('on', i === active && !['eraser', 'dim', 'lasso'].includes(this.activeTool));
      b.querySelector('.ts-dot').style.background = p.color;
    });
    this.eraserBtn?.classList.toggle('on', this.activeTool === 'eraser');
    this.dimBtn?.classList.toggle('on', this.activeTool === 'dim');
    this.lassoBtn?.classList.toggle('on', this.activeTool === 'lasso');
    if (this.drawModeBtn) { this.drawModeBtn.replaceChildren(icon(this.dimensional ? 'draft' : 'free')); this.drawModeBtn.classList.toggle('on', this.dimensional); }
    const collapsed = !!this.prefs.get('stripCollapsed');
    this.strip.classList.toggle('collapsed', collapsed);
    const leftSide = this.prefs.get('stripSide') === 'left';
    if (this.collapseBtn) this.collapseBtn.replaceChildren(icon(collapsed !== leftSide ? 'collapse' : 'expand'));
    if (this.widthBtn && this.activeTool === 'eraser') this.widthBtn.textContent = this.prefs.get('eraserKind') === 'part' ? 'PART' : 'ALL';
    this.snapBtn?.classList.toggle('on', !!this.snap.on);
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
    if (this.activeTool === 'eraser') {
      const kind = this.prefs.get('eraserKind') || 'stroke';
      const pick = (k, label, sub) => h('button', { class: `tool-pick ${kind === k ? 'on' : ''}`, onclick: () => { this.prefs.set('eraserKind', k); this.updateStrip(); this.closePopover(); } }, icon('eraser'), h('span', {}, label, h('small', { class: 'muted', style: { display: 'block' } }, sub)));
      this.showPopover(h('div', { class: 'popover' }, h('div', { class: 'pop-title' }, 'Eraser'),
        h('div', { class: 'stack tight' }, pick('stroke', 'Whole stroke', 'Touch a stroke to remove it'), pick('part', 'Partial', 'Erase only where you rub'))), anchor);
      return;
    }
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

  onRemoteChange() { if (this.sel) this.select(this.sel.ids); this.render(); }

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

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Copy of a page object moved by (dx, dy), with a new id. */
function translateObj(s, dx, dy) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const t = (p) => { const q = p.slice(); q[0] = r2(p[0] + dx); q[1] = r2(p[1] + dy); return q; };
  const o = JSON.parse(JSON.stringify(s));
  o.id = uid();
  o.pts = s.pts.map(t);
  if (s.raw) o.raw = s.raw.map(t);
  if (o.kind === 'dim') { o.a = t(s.a); o.b = t(s.b); }
  if (o.kind === 'image') { o.x = r2(s.x + dx); o.y = r2(s.y + dy); }
  if (o.shape) {
    const sh = o.shape;
    for (const k of ['a', 'b', 'c']) if (sh[k]) sh[k] = t(sh[k]);
    if (sh.pts) sh.pts = sh.pts.map(t);
  }
  return o;
}

/** Partial eraser: cut the part of a stroke within r of (x, y); returns the remaining pieces as new strokes. */
function splitStroke(s, x, y, r) {
  const dense = []; // resample so straight shape segments can be cut anywhere
  for (let i = 0; i < s.pts.length; i++) {
    const p = s.pts[i];
    if (i) {
      const q = s.pts[i - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1]), n = Math.floor(d / 2);
      for (let k = 1; k < n; k++) { const f = k / n; dense.push([q[0] + (p[0] - q[0]) * f, q[1] + (p[1] - q[1]) * f, p[2] ?? 0.5]); }
    }
    dense.push(p.slice(0, 3));
  }
  const pieces = []; let cur = [];
  for (const p of dense) {
    if (Math.hypot(p[0] - x, p[1] - y) <= r) { if (cur.length > 1) pieces.push(cur); cur = []; }
    else cur.push([Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, p[2]]);
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces.map((pts) => ({ id: uid(), tool: s.tool, color: s.color, width: s.width, ...(s.opacity != null ? { opacity: s.opacity } : {}), pts, created: Date.now() }));
}

/** Where a dimension sits on a shape. part: line · dia · rad · w · h · edge:i */
function dimGeom(sh, part) {
  if (sh.type === 'line') return { type: 'linear', a: sh.a, b: sh.b };
  if (sh.type === 'circle') { const u = [Math.SQRT1_2, -Math.SQRT1_2]; return { type: 'diameter', a: [sh.c[0] + u[0] * sh.r, sh.c[1] + u[1] * sh.r], b: [sh.c[0] - u[0] * sh.r, sh.c[1] - u[1] * sh.r] }; }
  if (sh.type === 'arc') { const t = sh.a0 + sh.sweep / 2; return { type: 'radius', a: sh.c, b: [sh.c[0] + sh.r * Math.cos(t), sh.c[1] + sh.r * Math.sin(t)] }; }
  if (sh.type === 'ellipse') {
    const { c, rx, ry } = sh;
    return part === 'h' ? { type: 'linear', a: [c[0] + rx, c[1] - ry], b: [c[0] + rx, c[1] + ry] } : { type: 'linear', a: [c[0] - rx, c[1] - ry], b: [c[0] + rx, c[1] - ry] };
  }
  const i = Number(String(part).split(':')[1] || 0), n = sh.pts.length;
  return { type: 'linear', a: sh.pts[i], b: sh.pts[(i + 1) % n] };
}
