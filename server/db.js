// EngBook — SQLite storage (Node built-in node:sqlite, no external packages)
// Copyright (c) 2026 Jerod Ulicki
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.ENGBOOK_DATA_DIR || '/data';

export function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'engbook.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,           -- base64url credential id
      name TEXT NOT NULL,
      public_key_jwk TEXT NOT NULL,
      alg INTEGER NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS recovery_codes (
      code_hash TEXT PRIMARY KEY,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS signin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      ip TEXT,
      method TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#22c3e6',
      stack TEXT NOT NULL DEFAULT '',
      default_style TEXT NOT NULL DEFAULT '{}',
      legend TEXT NOT NULL DEFAULT '[]',
      sort REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES sections(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      default_style TEXT NOT NULL DEFAULT '{}',
      sort REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      section_id TEXT REFERENCES sections(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      sort REAL NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strokes (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS strokes_page ON strokes(page_id);

    -- Append-only change log per page: lets devices catch up and keeps full history.
    CREATE TABLE IF NOT EXISTS ops (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      op TEXT NOT NULL,              -- add | del | undel
      stroke_id TEXT NOT NULL,
      client_id TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ops_page ON ops(page_id, seq);

    -- Images placed on pages (photos, imported PDF pages)
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Handwriting learn mode: samples of each character
    CREATE TABLE IF NOT EXISTS hw_samples (
      id TEXT PRIMARY KEY,
      ch TEXT NOT NULL,
      data TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'guided',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hw_ch ON hw_samples(ch);
  `);
  return db;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function deleteSetting(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
