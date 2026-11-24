// EngBook — local-first storage and sync.
// Every change is written to the device (IndexedDB) first, then sent to the server
// from an outbox in order. Other devices' changes arrive over Server-Sent Events.
// Copyright (c) 2026 Jerod Ulicki
import { api, ApiError } from './api.js';
import { uid } from './util.js';

const DB_NAME = 'engbook';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore('kv');
        db.createObjectStore('pages', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      }
      if (ev.oldVersion < 2) db.createObjectStore('assets');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Apply stroke ops to an in-memory page doc. Returns true when something changed. */
export function applyOpsToDoc(doc, ops) {
  let changed = false;
  for (const o of ops) {
    if (o.op === 'add' && o.stroke) {
      if (!doc.byId.has(o.stroke.id) && !doc.grave.has(o.stroke.id)) {
        doc.strokes.push(o.stroke); doc.byId.set(o.stroke.id, o.stroke); changed = true;
      }
    } else if (o.op === 'del') {
      const s = doc.byId.get(o.id);
      if (s) { doc.byId.delete(o.id); doc.grave.set(o.id, s); doc.strokes = doc.strokes.filter((x) => x.id !== o.id); changed = true; }
    } else if (o.op === 'undel') {
      if (!doc.byId.has(o.id)) {
        const s = doc.grave.get(o.id) || o.stroke;
        if (s) { doc.grave.delete(o.id); doc.strokes.push(s); doc.byId.set(o.id, s); changed = true; }
      }
    }
  }
  return changed;
}

function makeDoc(id, strokes, rev, page) {
  return { id, strokes: strokes.slice(), byId: new Map(strokes.map((s) => [s.id, s])), grave: new Map(), rev: rev || 0, page };
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.clientId = localStorage.getItem('eb.clientId') || uid();
    localStorage.setItem('eb.clientId', this.clientId);
    this.tree = { notebooks: [], sections: [], pages: [] };
    this.status = navigator.onLine ? 'synced' : 'offline';
    this.pending = 0;
    this.docs = new Map();      // open page docs
    this.flushing = false;
    this.retryTimer = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async init() {
    this.db = await idbOpen();
    const cached = await idb(this.db, 'kv', 'readonly', (s) => reqP(s.get('tree')));
    if (cached) this.tree = cached;
    this.pending = await idb(this.db, 'outbox', 'readonly', (s) => reqP(s.count()));
    window.addEventListener('online', () => { this.setStatus(); this.flush(); this.refreshTree(); });
    window.addEventListener('offline', () => this.setStatus('offline'));
    this.setStatus();
  }

  setStatus(forced) {
    const s = forced || (!navigator.onLine ? 'offline' : this.pending ? 'pending' : 'synced');
    if (s !== this.status) { this.status = s; }
    this.emit('status', { status: this.status, pending: this.pending });
  }

  // ---------------- tree ----------------
  async saveTree() { await idb(this.db, 'kv', 'readwrite', (s) => s.put(this.tree, 'tree')); }

  async refreshTree() {
    try {
      // Changes still in the outbox (before and after the download) are re-applied so a
      // change that is mid-flight never flickers away.
      const before = await idb(this.db, 'outbox', 'readonly', (s) => reqP(s.getAll()));
      const t = await api('GET', '/api/tree');
      const after = await idb(this.db, 'outbox', 'readonly', (s) => reqP(s.getAll()));
      const seen = new Set();
      const pend = [...before, ...after].filter((e) => (seen.has(e.seq) ? false : seen.add(e.seq))).sort((a, b) => a.seq - b.seq);
      this.tree = t;
      for (const e of pend) if (e.type === 'req' && e.local) this.reduceTree(e.local);
      await this.saveTree();
      this.emit('tree');
    } catch (e) { this.handleError(e); }
  }

  reduceTree({ kind, data }) {
    const t = this.tree;
    const list = { nb: 'notebooks', sec: 'sections', page: 'pages' }[kind.split('.')[0]];
    const op = kind.split('.')[1];
    const arr = t[list];
    if (op === 'create') { if (!arr.some((x) => x.id === data.id)) arr.push({ ...data }); }
    else if (op === 'update') { const x = arr.find((y) => y.id === data.id); if (x) Object.assign(x, data, { updatedAt: Date.now() }); }
    else if (op === 'delete') {
      t[list] = arr.filter((x) => x.id !== data.id);
      if (list === 'notebooks') { t.sections = t.sections.filter((s) => s.notebookId !== data.id); t.pages = t.pages.filter((p) => p.notebookId !== data.id); }
      if (list === 'sections') {
        const gone = new Set([data.id, ...t.sections.filter((s) => s.parentId === data.id).map((s) => s.id)]);
        t.sections = t.sections.filter((s) => !gone.has(s.id)); t.pages = t.pages.filter((p) => !gone.has(p.sectionId));
      }
    }
  }

  /** Change the tree locally and queue it for the server. */
  async mutate(kind, data) {
    const now = Date.now();
    if (kind.endsWith('.create')) Object.assign(data, { createdAt: now, updatedAt: now, sort: data.sort ?? now });
    this.reduceTree({ kind, data });
    await this.saveTree();
    this.emit('tree');
    const [what, op] = kind.split('.');
    const base = { nb: '/api/notebooks', sec: '/api/sections', page: '/api/pages' }[what];
    const method = { create: 'POST', update: 'PATCH', delete: 'DELETE' }[op];
    const path = op === 'create' ? base : `${base}/${data.id}${op === 'delete' ? `?clientId=${this.clientId}` : ''}`;
    await this.enqueue({ type: 'req', method, path, body: op === 'delete' ? undefined : { ...data, clientId: this.clientId }, local: { kind, data } });
    return data;
  }

  // ---------------- pages ----------------
  async loadPage(id) {
    let doc = this.docs.get(id);
    if (!doc) {
      const cached = await idb(this.db, 'pages', 'readonly', (s) => reqP(s.get(id)));
      doc = makeDoc(id, cached?.strokes || [], cached?.rev || 0);
      this.docs.set(id, doc);
    }
    this.syncPage(id); // fetch in the background
    return doc;
  }

  async syncPage(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    try {
      if (!doc.loaded) {
        const r = await api('GET', `/api/pages/${id}`);
        const pend = await idb(this.db, 'outbox', 'readonly', (s) => reqP(s.getAll()));
        const fresh = makeDoc(id, r.strokes, r.rev);
        fresh.grave = doc.grave;
        for (const e of pend) if (e.type === 'ops' && e.pageId === id) applyOpsToDoc(fresh, e.ops);
        // keep local undo history (graveyard) and the same object for the editor
        doc.strokes = fresh.strokes; doc.byId = fresh.byId; doc.rev = fresh.rev; doc.loaded = true;
        this.persistDoc(doc);
        this.emit('page', { id, remote: true });
      } else {
        await this.fetchChanges(id);
      }
    } catch (e) {
      if (e.status === 404) { this.emit('page-missing', { id }); return; }
      this.handleError(e);
    }
  }

  async fetchChanges(id) {
    const doc = this.docs.get(id);
    if (!doc || !doc.loaded) return;
    try {
      const r = await api('GET', `/api/pages/${id}/changes?since=${doc.rev}`);
      const changed = applyOpsToDoc(doc, r.ops.map((o) => ({ op: o.op, id: o.id, stroke: o.stroke })));
      doc.rev = Math.max(doc.rev, r.ops.length ? r.ops[r.ops.length - 1].seq : r.rev);
      this.persistDoc(doc);
      if (changed) this.emit('page', { id, remote: true });
    } catch (e) { this.handleError(e); }
  }

  persistDoc(doc) {
    clearTimeout(doc._saveT);
    doc._saveT = setTimeout(() => {
      idb(this.db, 'pages', 'readwrite', (s) => s.put({ id: doc.id, strokes: doc.strokes, rev: doc.rev })).catch(() => {});
    }, 250);
  }

  /** Local stroke changes: apply now, save on the device, queue for the server. */
  async pageOps(id, ops) {
    const doc = this.docs.get(id);
    if (doc) { applyOpsToDoc(doc, ops); this.persistDoc(doc); }
    await this.enqueue({ type: 'ops', pageId: id, ops });
  }

  // ---------------- images ----------------
  async putAsset(id, blob, mime) {
    await idb(this.db, 'assets', 'readwrite', (s) => s.put({ blob, mime }, id));
    await this.enqueue({ type: 'asset', id, mime });
  }

  async getAsset(id) {
    try { const r = await idb(this.db, 'assets', 'readonly', (s) => reqP(s.get(id))); return r ? r.blob : null; } catch { return null; }
  }

  closePage(id) {
    const doc = this.docs.get(id);
    if (doc) { clearTimeout(doc._saveT); idb(this.db, 'pages', 'readwrite', (s) => s.put({ id: doc.id, strokes: doc.strokes, rev: doc.rev })).catch(() => {}); }
    this.docs.delete(id);
  }

  // ---------------- outbox ----------------
  async enqueue(entry) {
    entry.at = Date.now();
    await idb(this.db, 'outbox', 'readwrite', (s) => s.add(entry));
    this.pending++;
    this.setStatus();
    this.flush();
  }

  async flush() {
    if (this.flushing || !this.db) return;
    this.flushing = true;
    try {
      for (;;) {
        const batch = await idb(this.db, 'outbox', 'readonly', (s) => reqP(s.getAll(null, 50)));
        if (!batch.length) break;
        let entry = batch[0];
        const seqs = [entry.seq];
        // merge consecutive stroke ops for the same page into one request
        if (entry.type === 'ops') {
          entry = { ...entry, ops: entry.ops.slice() };
          for (let i = 1; i < batch.length && batch[i].type === 'ops' && batch[i].pageId === entry.pageId && entry.ops.length < 2000; i++) {
            entry.ops.push(...batch[i].ops); seqs.push(batch[i].seq);
          }
        }
        try {
          if (entry.type === 'asset') {
            const blob = await this.getAsset(entry.id);
            if (blob) {
              let res;
              try { res = await fetch(`/api/assets/${entry.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'X-EngBook': '1', 'Content-Type': entry.mime }, body: blob }); }
              catch { throw new ApiError(0, 'Offline'); }
              if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
            }
          } else if (entry.type === 'ops') {
            const r = await api('POST', `/api/pages/${entry.pageId}/ops`, { clientId: this.clientId, ops: entry.ops });
            const doc = this.docs.get(entry.pageId);
            if (doc && r.rev > doc.rev) this.fetchChanges(entry.pageId);
          } else {
            await api(entry.method, entry.path, entry.body);
          }
        } catch (e) {
          if (e.status === 0 || e.status >= 500 || e.status === 429) { this.scheduleRetry(); this.setStatus(e.status === 0 ? 'offline' : 'error'); return; }
          if (e.status === 401) { this.emit('auth'); return; }
          console.warn('[engbook] dropped change', entry, e);
          this.emit('dropped', { entry, error: e.message });
        }
        await idb(this.db, 'outbox', 'readwrite', (s) => { for (const q of seqs) s.delete(q); });
        this.pending = Math.max(0, this.pending - seqs.length);
        this.setStatus();
      }
    } finally {
      this.flushing = false;
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.flush(), 5000);
  }

  handleError(e) {
    if (e instanceof ApiError && e.status === 401) this.emit('auth');
    else if (e instanceof ApiError && e.status === 0) this.setStatus('offline');
  }

  // ---------------- live events ----------------
  connectEvents() {
    if (this.es) this.es.close();
    this.es = new EventSource('/api/events');
    this.es.onopen = () => {
      this.refreshTree();
      for (const id of this.docs.keys()) this.syncPage(id);
      this.flush();
    };
    this.es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === 'hello') { this.emit('server-version', { version: ev.version }); return; }
      if (ev.clientId && ev.clientId === this.clientId) return;
      if (ev.type === 'tree' || ev.type === 'pagemeta') this.debouncedTree();
      if (ev.type === 'page' && this.docs.has(ev.id)) this.fetchChanges(ev.id);
    };
  }

  debouncedTree() {
    clearTimeout(this._treeT);
    this._treeT = setTimeout(() => this.refreshTree(), 300);
  }

  async clearLocal() {
    await idb(this.db, 'pages', 'readwrite', (s) => s.clear());
    await idb(this.db, 'kv', 'readwrite', (s) => s.clear());
  }
}
