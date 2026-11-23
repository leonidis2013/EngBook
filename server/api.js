// EngBook — notebooks, sections, pages and stroke sync API.
// Copyright (c) 2026 Jerod Ulicki
import crypto from 'node:crypto';
import { tx } from './db.js';

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const newId = () => crypto.randomBytes(12).toString('base64url');
const now = () => Date.now();
const MAX_STROKE_BYTES = 400 * 1024;

const clean = {
  str: (v, max = 200) => String(v ?? '').slice(0, max),
  color: (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : '#22c3e6'),
  json: (v, fallback) => {
    if (v === undefined) return undefined;
    const s = JSON.stringify(v ?? fallback);
    if (s.length > 20000) throw Object.assign(new Error('Field too large'), { status: 400 });
    return s;
  },
  id: (v) => (ID_RE.test(String(v || '')) ? String(v) : newId()),
};

function rowNotebook(r) {
  return { id: r.id, name: r.name, color: r.color, stack: r.stack, defaultStyle: JSON.parse(r.default_style),
    legend: JSON.parse(r.legend), sort: r.sort, archived: !!r.archived, createdAt: r.created_at, updatedAt: r.updated_at };
}
function rowSection(r) {
  return { id: r.id, notebookId: r.notebook_id, parentId: r.parent_id, name: r.name,
    defaultStyle: JSON.parse(r.default_style), sort: r.sort, createdAt: r.created_at, updatedAt: r.updated_at };
}
function rowPage(r) {
  return { id: r.id, notebookId: r.notebook_id, sectionId: r.section_id, title: r.title, style: JSON.parse(r.style),
    tags: JSON.parse(r.tags), pinned: !!r.pinned, sort: r.sort, rev: r.rev, createdAt: r.created_at, updatedAt: r.updated_at };
}

function validStroke(s) {
  if (!s || typeof s !== 'object' || !ID_RE.test(String(s.id || ''))) return false;
  if (!Array.isArray(s.pts) || s.pts.length === 0) return false;
  return true;
}

export function dataRoutes(db, { readBody, send, HttpError, broadcast }) {
  const q = {
    tree: () => ({
      notebooks: db.prepare('SELECT * FROM notebooks ORDER BY sort, created_at').all().map(rowNotebook),
      sections: db.prepare('SELECT * FROM sections ORDER BY sort, created_at').all().map(rowSection),
      pages: db.prepare('SELECT * FROM pages ORDER BY sort, created_at').all().map(rowPage),
    }),
    page: (id) => db.prepare('SELECT * FROM pages WHERE id = ?').get(id),
  };

  function touchTree(clientId) { broadcast({ type: 'tree', clientId }); }

  function patchRow(table, id, fields) {
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    const r = db.prepare(sql).run(...keys.map((k) => fields[k]), now(), id);
    if (!r.changes) throw new HttpError(404, 'Not found');
  }

  function applyOps(pageId, clientId, ops) {
    return tx(db, () => {
      const page = q.page(pageId);
      if (!page) throw new HttpError(404, 'Page not found');
      const insStroke = db.prepare('INSERT INTO strokes(id, page_id, data, deleted, created_at) VALUES(?,?,?,0,?) ON CONFLICT(id) DO NOTHING');
      const setDel = db.prepare('UPDATE strokes SET deleted = ? WHERE id = ? AND page_id = ? AND deleted != ?');
      const log = db.prepare('INSERT INTO ops(page_id, op, stroke_id, client_id, at) VALUES(?,?,?,?,?)');
      let applied = 0;
      for (const o of ops) {
        if (o.op === 'add') {
          if (!validStroke(o.stroke)) continue;
          const data = JSON.stringify(o.stroke);
          if (data.length > MAX_STROKE_BYTES) continue;
          const r = insStroke.run(o.stroke.id, pageId, data, now());
          if (r.changes) { log.run(pageId, 'add', o.stroke.id, clientId, now()); applied++; }
        } else if (o.op === 'del' || o.op === 'undel') {
          const flag = o.op === 'del' ? 1 : 0;
          const r = setDel.run(flag, String(o.id), pageId, flag);
          if (r.changes) { log.run(pageId, o.op, String(o.id), clientId, now()); applied++; }
        }
      }
      if (applied) {
        const rev = db.prepare('SELECT MAX(seq) AS s FROM ops WHERE page_id = ?').get(pageId).s || 0;
        db.prepare('UPDATE pages SET rev = ?, updated_at = ? WHERE id = ?').run(rev, now(), pageId);
        return { applied, rev };
      }
      return { applied, rev: page.rev };
    });
  }

  return async function handle(req, res, url) {
    const p = url.pathname, m = req.method;
    let mm;

    if (p === '/api/tree' && m === 'GET') return send(res, 200, q.tree());

    // ----- notebooks -----
    if (p === '/api/notebooks' && m === 'POST') {
      const b = await readBody(req);
      const id = clean.id(b.id), t = now();
      db.prepare(`INSERT INTO notebooks(id, name, color, stack, default_style, legend, sort, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(id, clean.str(b.name || 'Untitled notebook', 80), clean.color(b.color), clean.str(b.stack, 40),
          clean.json(b.defaultStyle, {}) ?? '{}', clean.json(b.legend, []) ?? '[]', Number(b.sort) || t, t, t);
      touchTree(b.clientId);
      return send(res, 200, rowNotebook(db.prepare('SELECT * FROM notebooks WHERE id = ?').get(id)));
    }
    if ((mm = p.match(/^\/api\/notebooks\/([A-Za-z0-9_-]+)$/))) {
      if (m === 'PATCH') {
        const b = await readBody(req);
        patchRow('notebooks', mm[1], {
          name: b.name !== undefined ? clean.str(b.name, 80) : undefined,
          color: b.color !== undefined ? clean.color(b.color) : undefined,
          stack: b.stack !== undefined ? clean.str(b.stack, 40) : undefined,
          default_style: clean.json(b.defaultStyle, {}),
          legend: clean.json(b.legend, []),
          sort: b.sort !== undefined ? Number(b.sort) || 0 : undefined,
          archived: b.archived !== undefined ? (b.archived ? 1 : 0) : undefined,
        });
        touchTree(b.clientId);
        return send(res, 200, rowNotebook(db.prepare('SELECT * FROM notebooks WHERE id = ?').get(mm[1])));
      }
      if (m === 'DELETE') {
        db.prepare('DELETE FROM notebooks WHERE id = ?').run(mm[1]);
        touchTree(url.searchParams.get('clientId'));
        return send(res, 200, { ok: true });
      }
    }

    // ----- sections -----
    if (p === '/api/sections' && m === 'POST') {
      const b = await readBody(req);
      if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(String(b.notebookId))) throw new HttpError(404, 'Notebook not found');
      let parent = null;
      if (b.parentId) {
        const ps = db.prepare('SELECT * FROM sections WHERE id = ?').get(String(b.parentId));
        if (!ps || ps.notebook_id !== b.notebookId) throw new HttpError(400, 'Bad parent section');
        if (ps.parent_id) throw new HttpError(400, 'Sub-sections can only go one level deep');
        parent = ps.id;
      }
      const id = clean.id(b.id), t = now();
      db.prepare(`INSERT INTO sections(id, notebook_id, parent_id, name, default_style, sort, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(id, b.notebookId, parent, clean.str(b.name || 'New section', 80), clean.json(b.defaultStyle, {}) ?? '{}', Number(b.sort) || t, t, t);
      touchTree(b.clientId);
      return send(res, 200, rowSection(db.prepare('SELECT * FROM sections WHERE id = ?').get(id)));
    }
    if ((mm = p.match(/^\/api\/sections\/([A-Za-z0-9_-]+)$/))) {
      if (m === 'PATCH') {
        const b = await readBody(req);
        patchRow('sections', mm[1], {
          name: b.name !== undefined ? clean.str(b.name, 80) : undefined,
          default_style: clean.json(b.defaultStyle, {}),
          sort: b.sort !== undefined ? Number(b.sort) || 0 : undefined,
        });
        touchTree(b.clientId);
        return send(res, 200, rowSection(db.prepare('SELECT * FROM sections WHERE id = ?').get(mm[1])));
      }
      if (m === 'DELETE') {
        db.prepare('DELETE FROM sections WHERE id = ?').run(mm[1]);
        touchTree(url.searchParams.get('clientId'));
        return send(res, 200, { ok: true });
      }
    }

    // ----- pages -----
    if (p === '/api/pages' && m === 'POST') {
      const b = await readBody(req);
      if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(String(b.notebookId))) throw new HttpError(404, 'Notebook not found');
      const id = clean.id(b.id), t = now();
      db.prepare(`INSERT INTO pages(id, notebook_id, section_id, title, style, tags, sort, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(id, b.notebookId, b.sectionId || null, clean.str(b.title, 120), clean.json(b.style, {}) ?? '{}',
          clean.json(b.tags, []) ?? '[]', Number(b.sort) || t, t, t);
      touchTree(b.clientId);
      return send(res, 200, rowPage(q.page(id)));
    }
    if ((mm = p.match(/^\/api\/pages\/([A-Za-z0-9_-]+)$/))) {
      const id = mm[1];
      if (m === 'GET') {
        const page = q.page(id);
        if (!page) throw new HttpError(404, 'Page not found');
        const strokes = db.prepare('SELECT data FROM strokes WHERE page_id = ? AND deleted = 0 ORDER BY created_at').all(id).map((r) => JSON.parse(r.data));
        return send(res, 200, { page: rowPage(page), strokes, rev: page.rev });
      }
      if (m === 'PATCH') {
        const b = await readBody(req);
        if (b.notebookId !== undefined && !db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(String(b.notebookId))) throw new HttpError(404, 'Notebook not found');
        patchRow('pages', id, {
          title: b.title !== undefined ? clean.str(b.title, 120) : undefined,
          style: clean.json(b.style, {}),
          tags: clean.json(b.tags, []),
          notebook_id: b.notebookId !== undefined ? String(b.notebookId) : undefined,
          section_id: b.sectionId !== undefined ? (b.sectionId || null) : undefined,
          pinned: b.pinned !== undefined ? (b.pinned ? 1 : 0) : undefined,
          sort: b.sort !== undefined ? Number(b.sort) || 0 : undefined,
        });
        touchTree(b.clientId);
        broadcast({ type: 'pagemeta', id, clientId: b.clientId });
        return send(res, 200, rowPage(q.page(id)));
      }
      if (m === 'DELETE') {
        db.prepare('DELETE FROM pages WHERE id = ?').run(id);
        touchTree(url.searchParams.get('clientId'));
        return send(res, 200, { ok: true });
      }
    }

    if ((mm = p.match(/^\/api\/pages\/([A-Za-z0-9_-]+)\/ops$/)) && m === 'POST') {
      const b = await readBody(req);
      const ops = Array.isArray(b.ops) ? b.ops.slice(0, 5000) : [];
      const r = applyOps(mm[1], clean.str(b.clientId, 40), ops);
      if (r.applied) broadcast({ type: 'page', id: mm[1], rev: r.rev, clientId: b.clientId });
      return send(res, 200, r);
    }

    if ((mm = p.match(/^\/api\/pages\/([A-Za-z0-9_-]+)\/changes$/)) && m === 'GET') {
      const page = q.page(mm[1]);
      if (!page) throw new HttpError(404, 'Page not found');
      const since = Number(url.searchParams.get('since') || 0);
      const rows = db.prepare(`SELECT o.seq, o.op, o.stroke_id, o.client_id, s.data FROM ops o
          LEFT JOIN strokes s ON s.id = o.stroke_id WHERE o.page_id = ? AND o.seq > ? ORDER BY o.seq LIMIT 5000`).all(mm[1], since);
      return send(res, 200, {
        rev: page.rev,
        ops: rows.map((r) => ({ seq: r.seq, op: r.op, id: r.stroke_id, clientId: r.client_id,
          stroke: r.op !== 'del' && r.data ? JSON.parse(r.data) : undefined })),
      });
    }

    // ----- export -----
    if (p === '/api/export' && m === 'GET') {
      const tree = q.tree();
      const strokes = db.prepare('SELECT page_id, data FROM strokes WHERE deleted = 0').all();
      const byPage = {};
      for (const s of strokes) (byPage[s.page_id] ||= []).push(JSON.parse(s.data));
      const body = JSON.stringify({ format: 'engbook-export', version: 1, exportedAt: new Date().toISOString(), ...tree, strokes: byPage });
      return send(res, 200, body, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="engbook-export-${new Date().toISOString().slice(0, 10)}.json"`,
      });
    }

    throw new HttpError(404, 'Not found');
  };
}
