import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "../paths.ts";

export function openDb(file = paths().catalogDb): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, ns TEXT, status TEXT, reason TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS tools(id INTEGER PRIMARY KEY, server TEXT NOT NULL, name TEXT NOT NULL, ident TEXT NOT NULL, ns TEXT NOT NULL,
      summary TEXT, description TEXT, decl TEXT, check_decl TEXT, access TEXT, hash TEXT, usage REAL DEFAULT 0, UNIQUE(server, name));
    CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(ident, summary, description);
    CREATE TABLE IF NOT EXISTS recipes(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, status TEXT, reason TEXT, usage REAL DEFAULT 0);
    CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(name, description);
    CREATE TABLE IF NOT EXISTS calls(ts INTEGER, server TEXT, tool TEXT, ms INTEGER, bytes INTEGER, run_id TEXT);
    CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
    CREATE TABLE IF NOT EXISTS key_sizes(server TEXT, tool TEXT, key TEXT, total INTEGER, n INTEGER, PRIMARY KEY(server, tool, key));
    CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, server TEXT, tool TEXT, key TEXT, status TEXT, UNIQUE(server, tool, key));
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}
