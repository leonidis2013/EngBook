// EngBook — export: SVG, PNG, and print / Save as PDF at true scale.
// Copyright (c) 2026 Jerod Ulicki
import { h, download, toast } from './util.js';
import { strokeToSvg, renderOrder, strokeBounds, drawStroke, UNITS_PER_INCH as IN } from './ink.js';
import { drawBackground, svgAdapter, canvasAdapter, pageSize, styleOf, TONE_COLORS } from './backgrounds.js';

function pageBox(style, strokes) {
  const size = pageSize(style);
  if (size) return { x: 0, y: 0, w: size.w, h: size.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) { const b = strokeBounds(s); x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY); }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 8.5 * IN, h: 11 * IN };
  const m = 0.4 * IN;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

export function pageToSvg(meta, strokes, { grid = true } = {}) {
  const style = styleOf(meta.style);
  const box = pageBox(style, strokes);
  const tone = style.tone;
  const g = svgAdapter(tone, style.grid ?? 1);
  if (grid) drawBackground(g, style, { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h }, 4);
  const bg = TONE_COLORS[tone]?.bg || '#ffffff';
  const body = renderOrder(strokes).map((s) => strokeToSvg(s, tone)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(box.w / IN).toFixed(3)}in" height="${(box.h / IN).toFixed(3)}in" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">`
    + `<title>${escapeXml(meta.title || 'EngBook page')}</title>`
    + `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${bg}"/>${grid ? g.toString() : ''}<g>${body}</g></svg>`;
}

const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fileName = (meta, ext) => `${(meta.title || 'page').replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;

export function exportSvg(meta, strokes, opts) {
  download(fileName(meta, 'svg'), new Blob([pageToSvg(meta, strokes, opts)], { type: 'image/svg+xml' }));
}

export function exportPng(meta, strokes, { grid = true, scale = 2 } = {}) {
  const style = styleOf(meta.style);
  const box = pageBox(style, strokes);
  const c = document.createElement('canvas');
  c.width = Math.round(box.w * scale); c.height = Math.round(box.h * scale);
  const ctx = c.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.fillStyle = TONE_COLORS[style.tone]?.bg || '#fff';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  if (grid) { const g = canvasAdapter(ctx, style.tone, scale, style.grid ?? 1); drawBackground(g, style, { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h }, scale); g.flush(); }
  for (const s of renderOrder(strokes)) drawStroke(ctx, s, { tone: style.tone });
  c.toBlob((b) => download(fileName(meta, 'png'), b), 'image/png');
}

/** Print one or more pages at 100% (use "Save as PDF" in the print dialog for a PDF). */
export function printPages(pages, { grid = true } = {}) {
  if (!pages.length) return;
  document.getElementById('print-root')?.remove();
  document.getElementById('print-style')?.remove();
  const first = pages[0];
  const box = pageBox(styleOf(first.meta.style), first.strokes);
  const root = h('div', { id: 'print-root' });
  for (const p of pages) root.append(h('div', { class: 'print-page', html: pageToSvg(p.meta, p.strokes, { grid }) }));
  const st = h('style', { id: 'print-style' },
    `@page { size: ${(box.w / IN).toFixed(3)}in ${(box.h / IN).toFixed(3)}in; margin: 0; }`);
  document.head.append(st);
  document.body.append(root);
  toast('Print at 100% (Actual size) so grids and dimensions measure true.', 'warn', 5000);
  setTimeout(() => {
    window.print();
    setTimeout(() => { root.remove(); st.remove(); }, 1500);
  }, 300);
}

/** A page with a 4 in and a 100 mm ruler to check the printer scale. */
export function printTestRuler() {
  const W = 8.5 * IN, H = 11 * IN, mm = IN / 25.4;
  let d = '';
  const x0 = IN, yIn = 2 * IN, yMm = 4 * IN;
  for (let i = 0; i <= 32; i++) { const x = x0 + i * IN / 8; const len = i % 8 === 0 ? 24 : i % 4 === 0 ? 16 : i % 2 === 0 ? 11 : 7; d += `M${x} ${yIn}v${len}`; }
  for (let i = 0; i <= 100; i++) { const x = x0 + i * mm; const len = i % 10 === 0 ? 24 : i % 5 === 0 ? 15 : 8; d += `M${x} ${yMm}v${len}`; }
  const labels = [0, 1, 2, 3, 4].map((i) => `<text x="${x0 + i * IN}" y="${yIn + 40}" text-anchor="middle">${i}</text>`).join('')
    + [0, 20, 40, 60, 80, 100].map((i) => `<text x="${x0 + i * mm}" y="${yMm + 40}" text-anchor="middle">${i}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 ${W} ${H}" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11">`
    + `<rect width="${W}" height="${H}" fill="#fff"/>`
    + `<text x="${x0}" y="${1.2 * IN}" font-size="16" font-weight="600">EngBook print scale test</text>`
    + `<text x="${x0}" y="${1.45 * IN}" fill="#555">Measure both rulers. The top one must be exactly 4 in, the bottom one exactly 100 mm.</text>`
    + `<text x="${x0}" y="${1.65 * IN}" fill="#555">If not, set the print scale to 100% / Actual size (not "Fit to page").</text>`
    + `<path d="M${x0} ${yIn}h${4 * IN}M${x0} ${yMm}h${100 * mm}${d}" stroke="#111" stroke-width="0.8" fill="none"/>${labels}`
    + `<text x="${x0 + 4 * IN + 12}" y="${yIn + 14}">in</text><text x="${x0 + 100 * mm + 12}" y="${yMm + 14}">mm</text></svg>`;
  document.getElementById('print-root')?.remove();
  const root = h('div', { id: 'print-root' }, h('div', { class: 'print-page', html: svg }));
  const st = h('style', { id: 'print-style' }, '@page { size: 8.5in 11in; margin: 0; }');
  document.head.append(st); document.body.append(root);
  setTimeout(() => { window.print(); setTimeout(() => { root.remove(); st.remove(); }, 1500); }, 300);
}
