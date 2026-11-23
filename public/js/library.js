// EngBook — library: notebooks → sections → sub-sections → pages.
// Copyright (c) 2026 Jerod Ulicki
import { h, askText, confirmBox, menu, modal, fmtDate, uid, toast } from './util.js';
import { icon } from './icons.js';
import { styleEditor } from './page-settings.js';
import { PALETTE } from './ink.js';

const NB_COLORS = ['#22c3e6', '#f5a524', '#ef4444', '#22c55e', '#a78bfa', '#f472b6', '#94a3b8', '#eab308'];

export class Library {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.query = '';
    try { this.open = new Set(JSON.parse(localStorage.getItem('eb.open') || '[]')); } catch { this.open = new Set(); }
    this.search = h('input', { class: 'input search', placeholder: 'Search notebooks and pages', type: 'search',
      oninput: (e) => { this.query = e.target.value.trim().toLowerCase(); this.render(); } });
    this.list = h('div', { class: 'lib-list' });
    el.append(
      h('div', { class: 'lib-head' }, h('div', { class: 'search-wrap' }, icon('search'), this.search)),
      this.list,
      h('div', { class: 'lib-foot' },
        h('button', { class: 'btn ghost wide', onclick: () => this.newNotebook() }, icon('plus'), 'New notebook')));
  }

  get tree() { return this.app.store.tree; }
  saveOpen() { localStorage.setItem('eb.open', JSON.stringify([...this.open])); }
  toggle(id) { this.open.has(id) ? this.open.delete(id) : this.open.add(id); this.saveOpen(); this.render(); }
  reveal(page) {
    if (!page) return;
    this.open.add(page.notebookId);
    const sec = this.tree.sections.find((s) => s.id === page.sectionId);
    if (sec) { this.open.add(sec.id); if (sec.parentId) this.open.add(sec.parentId); }
    this.saveOpen();
  }

  render() {
    const t = this.tree;
    const cur = this.app.currentPageId;
    if (this.query) { this.renderSearch(); return; }
    const groups = new Map();
    const archived = [];
    for (const nb of t.notebooks) {
      if (nb.archived) { archived.push(nb); continue; }
      const k = nb.stack || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(nb);
    }
    const out = [];
    const pinned = t.pages.filter((p) => p.pinned);
    if (pinned.length) {
      out.push(h('div', { class: 'lib-group' }, 'Pinned'));
      for (const p of pinned) out.push(this.pageRow(p, cur, 0, true));
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    for (const k of keys) {
      out.push(h('div', { class: 'lib-group' }, k || 'Notebooks'));
      for (const nb of groups.get(k)) out.push(...this.notebookRows(nb, cur));
    }
    if (archived.length) {
      out.push(h('button', { class: 'lib-group clickable', onclick: () => this.toggle('__archive') }, `Archive (${archived.length})`));
      if (this.open.has('__archive')) for (const nb of archived) out.push(...this.notebookRows(nb, cur));
    }
    if (!t.notebooks.length) out.push(h('p', { class: 'muted pad' }, 'No notebooks yet.'));
    this.list.replaceChildren(...out);
  }

  renderSearch() {
    const q = this.query, t = this.tree;
    const nbName = (id) => t.notebooks.find((n) => n.id === id)?.name || '';
    const secName = (id) => t.sections.find((s) => s.id === id)?.name || '';
    const hits = t.pages.filter((p) => [p.title, nbName(p.notebookId), secName(p.sectionId), ...(p.tags || []), p.style?.tb?.project, p.style?.tb?.title]
      .some((v) => v && String(v).toLowerCase().includes(q)));
    this.list.replaceChildren(
      h('div', { class: 'lib-group' }, `${hits.length} result${hits.length === 1 ? '' : 's'}`),
      ...hits.map((p) => this.pageRow(p, this.app.currentPageId, 0, true)));
  }

  notebookRows(nb, cur) {
    const t = this.tree;
    const isOpen = this.open.has(nb.id);
    const count = t.pages.filter((p) => p.notebookId === nb.id).length;
    const rows = [h('div', { class: 'lib-row nb', onclick: () => this.toggle(nb.id) },
      h('span', { class: `chev ${isOpen ? 'open' : ''}` }, icon('chevron')),
      h('span', { class: 'nb-chip', style: { background: nb.color } }),
      h('span', { class: 'lib-name' }, nb.name),
      h('span', { class: 'lib-meta mono' }, String(count)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Notebook menu', onclick: (e) => { e.stopPropagation(); this.notebookMenu(e.currentTarget, nb); } }, icon('more')))];
    if (!isOpen) return rows;
    const loose = t.pages.filter((p) => p.notebookId === nb.id && !p.sectionId);
    for (const p of loose) rows.push(this.pageRow(p, cur, 1));
    for (const s of t.sections.filter((x) => x.notebookId === nb.id && !x.parentId)) rows.push(...this.sectionRows(s, cur, 1));
    if (!loose.length && !t.sections.some((x) => x.notebookId === nb.id)) {
      rows.push(h('button', { class: 'lib-row add depth-1', onclick: () => this.newPage(nb.id, null) }, icon('plus'), 'New page'));
    }
    return rows;
  }

  sectionRows(s, cur, depth) {
    const t = this.tree;
    const isOpen = this.open.has(s.id);
    const pages = t.pages.filter((p) => p.sectionId === s.id);
    const subs = t.sections.filter((x) => x.parentId === s.id);
    const rows = [h('div', { class: `lib-row sec depth-${depth}`, onclick: () => this.toggle(s.id) },
      h('span', { class: `chev ${isOpen ? 'open' : ''}` }, icon('chevron')),
      icon('section'),
      h('span', { class: 'lib-name' }, s.name),
      h('span', { class: 'lib-meta mono' }, String(pages.length)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Section menu', onclick: (e) => { e.stopPropagation(); this.sectionMenu(e.currentTarget, s); } }, icon('more')))];
    if (!isOpen) return rows;
    for (const p of pages) rows.push(this.pageRow(p, cur, depth + 1));
    for (const sub of subs) rows.push(...this.sectionRows(sub, cur, depth + 1));
    if (!pages.length && !subs.length) rows.push(h('button', { class: `lib-row add depth-${depth + 1}`, onclick: () => this.newPage(s.notebookId, s.id) }, icon('plus'), 'New page'));
    return rows;
  }

  pageRow(p, cur, depth, withPath = false) {
    const t = this.tree;
    const path = withPath ? [t.notebooks.find((n) => n.id === p.notebookId)?.name, t.sections.find((s) => s.id === p.sectionId)?.name].filter(Boolean).join(' › ') : '';
    return h('div', { class: `lib-row page depth-${depth} ${p.id === cur ? 'active' : ''}`, onclick: () => this.app.openPage(p.id) },
      icon(p.pinned ? 'pin' : 'page'),
      h('span', { class: 'lib-name' }, pageTitle(p), path ? h('small', { class: 'lib-path' }, path) : null),
      h('span', { class: 'lib-meta mono' }, fmtDate(p.updatedAt).slice(5)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Page menu', onclick: (e) => { e.stopPropagation(); this.pageMenu(e.currentTarget, p); } }, icon('more')));
  }

  // ------------------------------------------------------------------ actions
  async newNotebook() {
    const name = await askText('New notebook', '', { placeholder: 'e.g. RHCC AVL, Voron, WaterBox', okLabel: 'Create' });
    if (!name) return;
    const nb = await this.app.store.mutate('nb.create', { id: uid(), name, color: NB_COLORS[this.tree.notebooks.length % NB_COLORS.length], stack: '', defaultStyle: {}, legend: [], archived: false });
    this.open.add(nb.id); this.saveOpen();
    await this.newPage(nb.id, null);
  }

  async newSection(nbId, parentId = null) {
    const name = await askText(parentId ? 'New sub-section' : 'New section', '', { placeholder: 'e.g. Audio, Network, Video', okLabel: 'Create' });
    if (!name) return;
    const s = await this.app.store.mutate('sec.create', { id: uid(), notebookId: nbId, parentId, name, defaultStyle: {} });
    this.open.add(nbId); this.open.add(s.id); if (parentId) this.open.add(parentId); this.saveOpen();
    this.render();
  }

  async newPage(nbId, sectionId) {
    const p = await this.app.createPage(nbId, sectionId);
    this.reveal(p); this.render();
    return p;
  }

  notebookMenu(anchor, nb) {
    const s = this.app.store;
    menu(anchor, [
      { label: 'New page', onClick: () => this.newPage(nb.id, null) },
      { label: 'New section', onClick: () => this.newSection(nb.id) },
      '-',
      { label: 'Rename', onClick: async () => { const v = await askText('Rename notebook', nb.name); if (v) s.mutate('nb.update', { id: nb.id, name: v }); } },
      { label: 'Cover color', onClick: () => this.pickColor(nb) },
      { label: 'Group (stack)', onClick: async () => { const v = await askText('Group this notebook under', nb.stack, { placeholder: 'e.g. Church, Home, Projects (blank for none)' }); if (v !== null) s.mutate('nb.update', { id: nb.id, stack: v }); } },
      { label: 'Default page style', onClick: () => this.editDefaultStyle('nb', nb) },
      { label: 'Color legend', onClick: () => this.editLegend(nb) },
      '-',
      { label: 'Print / Save as PDF', onClick: () => this.app.printNotebook(nb.id) },
      { label: nb.archived ? 'Unarchive' : 'Archive', onClick: () => s.mutate('nb.update', { id: nb.id, archived: !nb.archived }) },
      { label: 'Delete notebook', danger: true, onClick: async () => {
        if (await confirmBox('Delete notebook?', `"${nb.name}" and every page in it will be deleted. This can't be undone.`)) { s.mutate('nb.delete', { id: nb.id }); this.app.pageDeleted(); }
      } },
    ]);
  }

  sectionMenu(anchor, sec) {
    const s = this.app.store;
    menu(anchor, [
      { label: 'New page', onClick: () => this.newPage(sec.notebookId, sec.id) },
      ...(sec.parentId ? [] : [{ label: 'New sub-section', onClick: () => this.newSection(sec.notebookId, sec.id) }]),
      '-',
      { label: 'Rename', onClick: async () => { const v = await askText('Rename section', sec.name); if (v) s.mutate('sec.update', { id: sec.id, name: v }); } },
      { label: 'Default page style', onClick: () => this.editDefaultStyle('sec', sec) },
      '-',
      { label: 'Delete section', danger: true, onClick: async () => {
        if (await confirmBox('Delete section?', `"${sec.name}", its sub-sections and their pages will be deleted.`)) { s.mutate('sec.delete', { id: sec.id }); this.app.pageDeleted(); }
      } },
    ]);
  }

  pageMenu(anchor, p) {
    const s = this.app.store;
    menu(anchor, [
      { label: 'Open', onClick: () => this.app.openPage(p.id) },
      { label: 'Rename', onClick: async () => { const v = await askText('Page title', p.title); if (v !== null) s.mutate('page.update', { id: p.id, title: v }); } },
      { label: p.pinned ? 'Unpin' : 'Pin to top', onClick: () => s.mutate('page.update', { id: p.id, pinned: !p.pinned }) },
      { label: 'Move to…', onClick: () => this.movePage(p) },
      '-',
      { label: 'Delete page', danger: true, onClick: async () => {
        if (await confirmBox('Delete page?', `"${pageTitle(p)}" will be deleted.`)) { s.mutate('page.delete', { id: p.id }); if (p.id === this.app.currentPageId) this.app.pageDeleted(); }
      } },
    ]);
  }

  pickColor(nb) {
    const m = modal('Cover color', h('div', { class: 'swatch-row big' }, NB_COLORS.map((c) => h('button', { class: `swatch-mini lg ${c === nb.color ? 'on' : ''}`, style: { background: c },
      onclick: () => { this.app.store.mutate('nb.update', { id: nb.id, color: c }); m.close(); } }))));
  }

  editDefaultStyle(kind, obj) {
    let style = obj.defaultStyle || {};
    const m = modal(`Default page style — ${obj.name}`, h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'New pages here start with this style.'),
      styleEditor(style, (s) => { style = s; }),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => {
        this.app.store.mutate(`${kind}.update`, { id: obj.id, defaultStyle: style }); m.close(); toast('Default style saved');
      } }, 'Save'))));
  }

  editLegend(nb) {
    const legend = PALETTE.map((p) => ({ color: p.color, name: (nb.legend || []).find((l) => l.color === p.color)?.name || '' }));
    const m = modal(`Color legend — ${nb.name}`, h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Name what each color means in this notebook, e.g. red = revision, green = checked.'),
      ...legend.map((l) => h('label', { class: 'row gap' }, h('span', { class: 'swatch', style: { background: l.color } }),
        h('input', { class: 'input', value: l.name, placeholder: PALETTE.find((p) => p.color === l.color).name, oninput: (e) => { l.name = e.target.value; } }))),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => {
        this.app.store.mutate('nb.update', { id: nb.id, legend: legend.filter((l) => l.name.trim()) }); m.close(); this.app.refreshLegend();
      } }, 'Save'))));
  }

  movePage(p) {
    const t = this.tree;
    const opts = [];
    for (const nb of t.notebooks) {
      opts.push({ label: nb.name, nb: nb.id, sec: null, depth: 0 });
      for (const s of t.sections.filter((x) => x.notebookId === nb.id && !x.parentId)) {
        opts.push({ label: s.name, nb: nb.id, sec: s.id, depth: 1 });
        for (const sub of t.sections.filter((x) => x.parentId === s.id)) opts.push({ label: sub.name, nb: nb.id, sec: sub.id, depth: 2 });
      }
    }
    const m = modal('Move page to', h('div', { class: 'move-list' }, opts.map((o) => h('button', {
      class: `lib-row depth-${o.depth} ${o.nb === p.notebookId && o.sec === (p.sectionId || null) ? 'active' : ''}`,
      onclick: () => { this.app.store.mutate('page.update', { id: p.id, notebookId: o.nb, sectionId: o.sec }); m.close(); toast('Page moved'); },
    }, icon(o.depth ? 'section' : 'notebook'), h('span', { class: 'lib-name' }, o.label)))));
  }
}

export function pageTitle(p) {
  return p.title || `Untitled · ${fmtDate(p.createdAt)}`;
}
