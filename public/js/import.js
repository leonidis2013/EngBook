// EngBook — insert images and import PDFs (each PDF page becomes a page you can write on).
// PDF pages are rendered on the device with pdf.js, which is bundled into the Docker image.
// Copyright (c) 2026 Jerod Ulicki
import { toast, uid, fmtDate } from './util.js';
import { prepareImage, addAsset, makeImage } from './assets.js';
import { pageSize, styleOf } from './backgrounds.js';

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

/** Insert a photo or picture onto the open page, centred in view. */
export async function insertImage(app) {
  const ed = app.editor;
  if (!ed.meta) return;
  const file = await pickFile('image/*');
  if (!file) return;
  try {
    const { blob, w, h, mime } = await prepareImage(file);
    const asset = await addAsset(blob, mime);
    const size = pageSize(ed.style);
    const vis = ed.visibleRect();
    const maxW = (size ? size.w : vis.x1 - vis.x0) * 0.6;
    const W = Math.min(maxW, w / 2), H = W * (h / w);
    let x = (vis.x0 + vis.x1) / 2 - W / 2, y = (vis.y0 + vis.y1) / 2 - H / 2;
    if (size) { x = Math.max(0, Math.min(size.w - W, x)); y = Math.max(0, Math.min(size.h - H, y)); }
    const obj = makeImage(asset, x, y, W, H);
    await app.store.pageOps(ed.doc.id, [{ op: 'add', stroke: obj }]);
    ed.pushHistory({ undo: [{ op: 'del', id: obj.id }], redo: [{ op: 'undel', id: obj.id }] });
    ed.render();
    ed.setMode('lasso'); ed.select([obj.id]);
    toast('Image added. Drag it with the lasso to move it.', 'ok');
  } catch (e) { toast(`Couldn't add that image: ${e.message}`, 'error'); }
}

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

/** Import a PDF as new pages in a notebook / section. */
export async function importPdf(app, nbId, sectionId) {
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return;
  let pdfjs;
  try { pdfjs = await loadPdfJs(); } catch { pdfjsPromise = null; toast('PDF import needs pdf.js, which is not in this build.', 'error', 6000); return; }
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise; }
  catch (e) { toast(`Couldn't open that PDF: ${e.message}`, 'error'); return; }
  const n = Math.min(doc.numPages, 200);
  const base = file.name.replace(/\.pdf$/i, '');
  let firstId = null;
  toast(`Importing ${n} page${n === 1 ? '' : 's'}…`, 'info', 4000);
  for (let i = 1; i <= n; i++) {
    const pg = await doc.getPage(i);
    const vp1 = pg.getViewport({ scale: 1 });
    const landscape = vp1.width > vp1.height;
    // ~200 dpi keeps text sharp when zoomed while staying light
    const scale = Math.min(200 / 72, 4000 / Math.max(vp1.width, vp1.height));
    const vp = pg.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const asset = await addAsset(blob, 'image/jpeg');
    const style = { ...styleOf({ type: 'blank', size: 'letter', orient: landscape ? 'landscape' : 'portrait', tone: 'paper' }), pageNumbers: true, tb: { date: fmtDate(Date.now()) } };
    const ps = pageSize(style);
    const k = Math.min(ps.w / vp1.width, ps.h / vp1.height);
    const W = vp1.width * k, H = vp1.height * k;
    const page = await app.store.mutate('page.create', { id: uid(), notebookId: nbId, sectionId: sectionId || null, title: n > 1 ? `${base} · p${i}` : base, style, tags: ['pdf'], pinned: false, rev: 0 });
    await app.store.pageOps(page.id, [{ op: 'add', stroke: makeImage(asset, (ps.w - W) / 2, (ps.h - H) / 2, W, H) }]);
    firstId ||= page.id;
    pg.cleanup();
  }
  toast(`Imported ${n} page${n === 1 ? '' : 's'} from ${file.name}.`, 'ok', 4000);
  if (firstId) app.openPage(firstId);
}
