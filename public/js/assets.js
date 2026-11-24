// EngBook — images on pages (photos, imported PDF pages).
// Image files are stored on the device first (IndexedDB) and uploaded from the outbox,
// so an image placed offline shows right away and syncs later.
// Copyright (c) 2026 Jerod Ulicki
import { uid } from './util.js';

const cache = new Map(); // asset id -> { img, ok }
let store = null;
let onAnyLoad = null;

export function initAssets(s, onLoad) { store = s; onAnyLoad = onLoad; }

/** Returns a loaded HTMLImageElement, or null while it loads (a redraw is triggered when ready). */
export function getImage(id) {
  let e = cache.get(id);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    cache.set(id, e);
    img.onload = () => { e.ok = true; onAnyLoad?.(); };
    img.onerror = () => { cache.delete(id); };
    (async () => {
      const blob = store ? await store.getAsset(id) : null;
      img.src = blob ? URL.createObjectURL(blob) : `/api/assets/${id}`;
    })();
  }
  return e.ok ? e.img : null;
}

/** Shrink very large photos so pages stay light (longest side ≤ maxPx). */
export async function prepareImage(file, maxPx = 2400) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  if (scale === 1 && /jpe?g|png|webp/.test(file.type) && file.size < 4e6) return { blob: file, w, h, mime: file.type };
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  return { blob, w, h, mime: 'image/jpeg' };
}

/** Save an image locally and queue its upload. Returns the asset id. */
export async function addAsset(blob, mime) {
  const id = uid();
  await store.putAsset(id, blob, mime);
  return id;
}

/** Image object stored on a page, just like a stroke. */
export function makeImage(asset, x, y, w, h) {
  const r = (n) => Math.round(n * 100) / 100;
  return { id: uid(), kind: 'image', asset, x: r(x), y: r(y), w: r(w), h: r(h), color: '#000000', width: 0.1, pts: [[r(x), r(y), 0.5], [r(x + w), r(y + h), 0.5]] };
}

export function drawImageObj(ctx, s, onMissing) {
  const img = getImage(s.asset);
  if (img) ctx.drawImage(img, s.x, s.y, s.w, s.h);
  else {
    ctx.save(); ctx.fillStyle = 'rgba(128,128,128,0.12)'; ctx.fillRect(s.x, s.y, s.w, s.h); ctx.restore();
    onMissing?.();
  }
}
