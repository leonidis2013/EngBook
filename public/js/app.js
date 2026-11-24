// EngBook — app shell: startup, sign-in, layout, top bar and wiring.
// Copyright (c) 2026 Jerod Ulicki
import { h, $, uid, toast, menu, askText, modal, debounce, fmtDate } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { Store } from './store.js';
import { Editor } from './editor.js';
import { Library, pageTitle } from './library.js';
import { Prefs, openSettings, reloadApp } from './settings-ui.js';
import { renderSetup, renderLogin, logoSvg } from './auth-ui.js';
import { styleEditor } from './page-settings.js';
import { exportSvg, exportPng, printPages } from './export.js';
import { styleOf } from './backgrounds.js';
import { initAssets } from './assets.js';
import { insertImage, importPdf } from './import.js';
import { openLearn } from './learn.js';

const BOOT_AT = performance.now();
/** Fade out the boot screen once its sketch has finished (~1.9 s), or when the app is ready if that's later. */
function hideLoader() {
  const el = document.getElementById('loader');
  if (!el || el.classList.contains('done')) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = Math.max(0, (reduce ? 700 : 1900) - (performance.now() - BOOT_AT));
  setTimeout(() => { el.classList.add('done'); setTimeout(() => el.remove(), 400); }, wait);
}

class App {
  constructor() {
    this.root = $('#root');
    this.prefs = new Prefs();
    this.store = new Store();
    this.currentPageId = null;
    this.version = '';
    this.applyTheme();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.applyTheme());
  }

  applyTheme() {
    const t = this.prefs.get('theme');
    const light = t === 'light' || (t === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    // solid status bar in the app's own top-bar colour (no translucent blur over the app)
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.setAttribute('content', light ? '#ffffff' : '#13161b'); m.removeAttribute('media'); });
    this.editor?.render();
  }

  async boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    let state;
    try { state = await api('GET', '/api/auth/state'); }
    catch (e) {
      // offline: open from the device cache if we've signed in here before
      if (e.status === 0 && localStorage.getItem('eb.signedIn')) return this.start({ offline: true });
      hideLoader();
      this.root.replaceChildren(h('div', { class: 'auth-screen' }, h('div', { class: 'auth-card' }, h('h1', {}, 'Can\'t reach EngBook'), h('p', { class: 'muted' }, e.message),
        h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again'))));
      return;
    }
    this.version = state.version;
    if (state.setup) { hideLoader(); return renderSetup(this.root, () => location.reload()); }
    if (!state.authenticated) { localStorage.removeItem('eb.signedIn'); hideLoader(); return renderLogin(this.root, state, () => location.reload()); }
    localStorage.setItem('eb.signedIn', '1');
    this.start({});
  }

  async start({ offline }) {
    if (!this.version) this.version = (document.querySelector('#loader .ver')?.textContent || '').replace(/^v/, '').replace('{{VERSION}}', '');
    await this.store.init();
    initAssets(this.store, () => this.editor?.render());
    this.buildLayout();
    this.store.addEventListener('status', (e) => this.showStatus(e.detail));
    this.store.addEventListener('tree', () => this.onTree());
    this.store.addEventListener('page', (e) => { if (e.detail.id === this.currentPageId) this.editor.onRemoteChange(); });
    this.store.addEventListener('page-missing', (e) => { if (e.detail.id === this.currentPageId) this.pageDeleted(); });
    this.store.addEventListener('auth', () => { localStorage.removeItem('eb.signedIn'); location.reload(); });
    this.store.addEventListener('server-version', (e) => this.checkVersion(e.detail.version));
    this.store.addEventListener('dropped', (e) => toast(`A change could not be saved: ${e.detail.error}`, 'error', 6000));
    this.showStatus({ status: this.store.status, pending: this.store.pending });
    this.library.render();
    if (!offline) {
      await this.store.refreshTree();
      this.store.connectEvents();
      this.store.flush();
      if (!this.store.tree.notebooks.length) await this.firstRun();
    }
    const last = localStorage.getItem('eb.lastPage');
    if (last && this.store.tree.pages.some((p) => p.id === last)) await this.openPage(last);
    else this.showHome();
    hideLoader();
    const low = sessionStorage.getItem('eb.lowRecovery');
    if (low) { sessionStorage.removeItem('eb.lowRecovery'); toast(`Only ${low} recovery code${low === '1' ? '' : 's'} left. Make new ones in Settings.`, 'warn', 7000); }
  }

  checkVersion(v) {
    if (!v || !this.version || v === this.version || this.updateShown) return;
    this.updateShown = true;
    const bar = h('div', { class: 'update-bar' },
      h('span', {}, `EngBook v${v} is available (this device has v${this.version}).`),
      h('button', { class: 'btn primary sm', onclick: () => reloadApp() }, 'Reload now'),
      h('button', { class: 'btn ghost sm', onclick: () => bar.remove() }, 'Later'));
    document.body.append(bar);
  }

  async firstRun() {
    const nb = await this.store.mutate('nb.create', { id: uid(), name: 'Quick notes', color: '#22c3e6', stack: '', defaultStyle: {}, legend: [], archived: false });
    const p = await this.createPage(nb.id, null, 'Welcome');
    this.library.reveal(p);
  }

  // ------------------------------------------------------------------ layout
  buildLayout() {
    const wide = matchMedia('(min-width: 1000px)').matches;
    const sidebarOpen = localStorage.getItem('eb.sidebar') ? localStorage.getItem('eb.sidebar') === '1' : wide;
    this.sidebar = h('aside', { class: 'sidebar' });
    this.editorHost = h('main', { class: 'editor-host' });
    this.crumb = h('div', { class: 'crumb' });
    this.syncEl = h('div', { class: 'sync', title: 'Sync status' }, h('span', { class: 'light' }), h('span', { class: 'sync-label mono' }));
    this.undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Undo', onclick: () => this.editor.undo() }, icon('undo'));
    this.redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Redo', onclick: () => this.editor.redo() }, icon('redo'));
    this.styleBtn = h('button', { class: 'icon-btn', 'aria-label': 'Page style', onclick: () => this.openStylePanel() }, icon('grid'));
    this.pageMenuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Page menu', onclick: (e) => this.openPageMenu(e.currentTarget) }, icon('more'));
    const top = h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Library', onclick: () => this.toggleSidebar() }, icon('menu')),
      h('button', { class: 'brand-btn', onclick: () => this.showHome(), 'aria-label': 'Home' }, h('span', { class: 'brand-mark', html: logoSvg() }), h('span', { class: 'brand-name' }, 'EngBook'), h('span', { class: 'brand-ver mono' }, this.version ? `v${this.version}` : '')),
      this.crumb, h('div', { class: 'grow' }), this.syncEl,
      h('div', { class: 'tb-group' }, this.undoBtn, this.redoBtn, this.styleBtn, this.pageMenuBtn),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => openSettings(this) }, icon('gear')));
    this.shade = h('div', { class: 'shade', onclick: () => this.toggleSidebar(false) });
    const shell = h('div', { class: `app ${sidebarOpen ? 'with-sidebar' : ''}` }, top, h('div', { class: 'body' }, this.sidebar, this.shade, this.editorHost));
    this.shell = shell;
    this.root.replaceChildren(shell);
    this.library = new Library(this.sidebar, this);
    this.editor = new Editor(this.editorHost, this.store, this.prefs);
    this.editorHost.addEventListener('history', (e) => { this.undoBtn.disabled = !e.detail.undo; this.redoBtn.disabled = !e.detail.redo; });
    this.undoBtn.disabled = this.redoBtn.disabled = true;
    this.home = h('div', { class: 'home' });
    this.editorHost.append(this.home);
  }

  toggleSidebar(force) {
    const on = force ?? !this.shell.classList.contains('with-sidebar');
    this.shell.classList.toggle('with-sidebar', on);
    localStorage.setItem('eb.sidebar', on ? '1' : '0');
    setTimeout(() => this.editor.resize(), 220);
  }

  narrow() { return !matchMedia('(min-width: 1000px)').matches; }

  showStatus({ status, pending }) {
    this.syncEl.dataset.status = status;
    this.syncEl.querySelector('.sync-label').textContent = { synced: 'Synced', pending: `Saving ${pending}`, offline: pending ? `Offline · ${pending}` : 'Offline', error: 'Retrying' }[status] || status;
  }

  onTree() {
    this.library.render();
    const meta = this.currentMeta();
    if (this.currentPageId && !meta) { this.pageDeleted(); return; }
    if (meta) {
      if (!this.stylePanelOpen) this.editor.setMeta(meta);
      this.editor.setPageInfo(this.pageInfo(meta));
      this.refreshLegend();
      this.renderCrumb();
    }
    if (!this.currentPageId) this.renderHome();
  }

  currentMeta() { return this.store.tree.pages.find((p) => p.id === this.currentPageId); }

  /** Pages of a notebook in reading order: loose pages, then each section (and its sub-sections). */
  notebookOrder(nbId) {
    const t = this.store.tree;
    const bySort = (a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt);
    const pagesIn = (secId) => t.pages.filter((p) => p.notebookId === nbId && (p.sectionId || null) === secId).sort(bySort);
    const out = [...pagesIn(null)];
    for (const s of t.sections.filter((x) => x.notebookId === nbId && !x.parentId).sort(bySort)) {
      out.push(...pagesIn(s.id));
      for (const sub of t.sections.filter((x) => x.parentId === s.id).sort(bySort)) out.push(...pagesIn(sub.id));
    }
    return out;
  }

  pageInfo(p) {
    const order = this.notebookOrder(p.notebookId);
    return { no: order.findIndex((x) => x.id === p.id) + 1, count: order.length };
  }

  renderCrumb() {
    const p = this.currentMeta();
    if (!p) { this.crumb.replaceChildren(); return; }
    const t = this.store.tree;
    const nb = t.notebooks.find((n) => n.id === p.notebookId);
    const sec = t.sections.find((s) => s.id === p.sectionId);
    const parent = sec?.parentId ? t.sections.find((s) => s.id === sec.parentId) : null;
    this.crumb.replaceChildren(...[
      nb ? h('span', { class: 'crumb-nb' }, h('span', { class: 'nb-chip', style: { background: nb.color } }), nb.name) : null,
      parent ? h('span', { class: 'crumb-sep' }, '›') : null, parent ? h('span', { class: 'crumb-sec' }, parent.name) : null,
      sec ? h('span', { class: 'crumb-sep' }, '›') : null, sec ? h('span', { class: 'crumb-sec' }, sec.name) : null,
      h('span', { class: 'crumb-sep' }, '›'),
      h('button', { class: 'crumb-title', onclick: async () => { const v = await askText('Page title', p.title); if (v !== null) this.store.mutate('page.update', { id: p.id, title: v }); } }, pageTitle(p)),
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------ pages
  async openPage(id) {
    const meta = this.store.tree.pages.find((p) => p.id === id);
    if (!meta) return;
    if (this.currentPageId && this.currentPageId !== id) { this.editor.saveView(); this.store.closePage(this.currentPageId); }
    this.currentPageId = id;
    localStorage.setItem('eb.lastPage', id);
    this.home.style.display = 'none';
    const doc = await this.store.loadPage(id);
    if (this.currentPageId !== id) return;
    this.editor.pageInfo = this.pageInfo(meta);
    this.editor.open(meta, doc);
    this.refreshLegend();
    this.renderCrumb();
    this.library.reveal(meta);
    this.library.render();
    this.setPageButtons(true);
    if (this.narrow()) this.toggleSidebar(false);
  }

  async createPage(nbId, sectionId, title = '') {
    const t = this.store.tree;
    const sec = t.sections.find((s) => s.id === sectionId);
    const parent = sec?.parentId ? t.sections.find((s) => s.id === sec.parentId) : null;
    const nb = t.notebooks.find((n) => n.id === nbId);
    const pick = [sec?.defaultStyle, parent?.defaultStyle, nb?.defaultStyle].find((s) => s && Object.keys(s).length) || this.prefs.get('defaultStyle');
    const style = { ...styleOf(pick), tb: { ...(styleOf(pick).tb), drawnBy: this.prefs.get('drawnBy') || undefined, date: fmtDate(Date.now()) } };
    const page = await this.store.mutate('page.create', { id: uid(), notebookId: nbId, sectionId: sectionId || null, title, style, tags: [], pinned: false, rev: 0 });
    await this.openPage(page.id);
    return page;
  }

  pageDeleted() {
    if (this.currentPageId && !this.currentMeta()) {
      this.store.closePage(this.currentPageId);
      this.currentPageId = null;
      localStorage.removeItem('eb.lastPage');
      this.editor.close();
      this.crumb.replaceChildren();
      this.showHome();
    }
  }

  setPageButtons(on) { for (const b of [this.styleBtn, this.pageMenuBtn]) b.disabled = !on; if (!on) this.undoBtn.disabled = this.redoBtn.disabled = true; }

  showHome() {
    if (this.currentPageId) { this.editor.saveView(); this.store.closePage(this.currentPageId); }
    this.currentPageId = null;
    localStorage.removeItem('eb.lastPage');
    this.editor.close();
    this.crumb.replaceChildren();
    this.setPageButtons(false);
    this.home.style.display = '';
    this.renderHome();
    this.library.render();
  }

  renderHome() {
    const t = this.store.tree;
    const recent = [...t.pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
    const nbOf = (p) => t.notebooks.find((n) => n.id === p.notebookId);
    this.home.replaceChildren(
      h('div', { class: 'home-inner' },
        h('h1', {}, 'Recent pages'),
        recent.length ? h('div', { class: 'cards' }, recent.map((p) => h('button', { class: 'card', onclick: () => this.openPage(p.id) },
          h('span', { class: 'card-bar', style: { background: nbOf(p)?.color || '#888' } }),
          h('span', { class: 'card-title' }, pageTitle(p)),
          h('span', { class: 'card-sub' }, nbOf(p)?.name || ''),
          h('span', { class: 'card-date mono' }, fmtDate(p.updatedAt))))) : h('p', { class: 'muted' }, 'No pages yet. Make a notebook from the library.'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary', onclick: () => this.quickNote() }, icon('plus'), 'Quick note'),
          h('button', { class: 'btn ghost', onclick: () => this.toggleSidebar(true) }, icon('notebook'), 'Library'),
          h('button', { class: 'btn ghost', onclick: () => this.importPdfQuick() }, icon('page'), 'Import PDF'),
          h('button', { class: 'btn ghost', onclick: () => openLearn(this) }, icon('learn'), 'Handwriting training'))));
  }

  async quickNote() {
    let nb = this.store.tree.notebooks.find((n) => n.name === 'Quick notes' && !n.archived) || this.store.tree.notebooks.find((n) => !n.archived);
    if (!nb) nb = await this.store.mutate('nb.create', { id: uid(), name: 'Quick notes', color: '#22c3e6', stack: '', defaultStyle: {}, legend: [], archived: false });
    await this.createPage(nb.id, null);
  }

  async importPdfQuick() {
    let nb = this.store.tree.notebooks.find((n) => n.name === 'Imported PDFs' && !n.archived);
    if (!nb) nb = await this.store.mutate('nb.create', { id: uid(), name: 'Imported PDFs', color: '#94a3b8', stack: '', defaultStyle: {}, legend: [], archived: false });
    await importPdf(this, nb.id, null);
  }

  refreshLegend() {
    const meta = this.currentMeta();
    const nb = meta && this.store.tree.notebooks.find((n) => n.id === meta.notebookId);
    this.editor.setLegend(nb?.legend || []);
  }

  openStylePanel() {
    const meta = this.currentMeta();
    if (!meta) return;
    this.stylePanelOpen = true;
    const save = debounce((style) => this.store.mutate('page.update', { id: meta.id, style }), 500);
    modal('Page style', styleEditor(meta.style, (style) => {
      this.editor.setMeta({ ...this.editor.meta, style });
      save(style);
    }), { onClose: () => { this.stylePanelOpen = false; setTimeout(() => this.onTree(), 600); } });
  }

  openPageMenu(anchor) {
    const meta = this.currentMeta();
    if (!meta) return;
    const strokes = () => this.editor.doc?.strokes || [];
    menu(anchor, [
      { label: 'Fit page to screen', onClick: () => this.editor.fit() },
      { label: 'Insert image…', onClick: () => insertImage(this) },
      { label: 'Import PDF as pages…', onClick: () => importPdf(this, meta.notebookId, meta.sectionId) },
      { label: this.editor.showOriginal ? 'Show cleaned handwriting' : 'Compare original handwriting', onClick: () => this.editor.toggleOriginal() },
      '-',
      { label: 'Print / Save as PDF', onClick: () => printPages([{ meta, strokes: strokes(), info: this.pageInfo(meta) }]) },
      { label: 'Export PNG', onClick: () => exportPng(meta, strokes(), { info: this.pageInfo(meta) }) },
      { label: 'Export SVG', onClick: () => exportSvg(meta, strokes(), { info: this.pageInfo(meta) }) },
      { label: 'Export ink only (SVG, no grid)', onClick: () => exportSvg(meta, strokes(), { grid: false }) },
      '-',
      { label: 'Page info', onClick: () => modal('Page info', h('div', { class: 'stack mono small' },
        h('div', {}, `Strokes: ${strokes().length}`), h('div', {}, `Created: ${fmtDate(meta.createdAt)}`), h('div', {}, `Updated: ${fmtDate(meta.updatedAt)}`), h('div', {}, `Sync revision: ${this.editor.doc?.rev ?? 0}`))) },
    ]);
  }

  async printNotebook(nbId) {
    const pages = this.notebookOrder(nbId);
    if (!pages.length) { toast('This notebook has no pages.'); return; }
    toast(`Preparing ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
    try {
      const docs = await Promise.all(pages.map((p) => api('GET', `/api/pages/${p.id}`)));
      printPages(docs.map((d, i) => ({ meta: pages[i], strokes: d.strokes, info: { no: i + 1, count: pages.length } })));
    } catch (e) { toast(`Could not load pages: ${e.message}`, 'error'); }
  }
}

const app = new App();
window.engbook = app;
app.boot();
