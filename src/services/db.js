import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let SQL = null;
let _db = null;
let dbPath = '';

function loadConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'config.json');
  const defaultPath = path.join(__dirname, '..', '..', 'config', 'default.json');
  const p = fs.existsSync(configPath) ? configPath : defaultPath;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    flushSave();
  }, 300);
}

function flushSave() {
  if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
  try {
    if (_db && dbPath) {
      const data = _db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Coerce JS values into sql.js-compatible primitives.
function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function normalizeBindings(params) {
  if (params.length === 0) return null;
  if (params.length === 1 && isPlainObject(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) {
      out['@' + k] = coerce(v);
    }
    return out;
  }
  return params.map(coerce);
}

class Statement {
  constructor(sqlDb, sql) {
    this.sqlDb = sqlDb;
    this.sql = sql;
  }

  run(...params) {
    const bindings = normalizeBindings(params);
    const stmt = this.sqlDb.prepare(this.sql);
    try {
      if (bindings) stmt.bind(bindings);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = this.sqlDb.getRowsModified();
    const r = this.sqlDb.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = r.length && r[0].values.length ? r[0].values[0][0] : 0;
    scheduleSave();
    return { changes, lastInsertRowid };
  }

  get(...params) {
    const bindings = normalizeBindings(params);
    const stmt = this.sqlDb.prepare(this.sql);
    try {
      if (bindings) stmt.bind(bindings);
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params) {
    const bindings = normalizeBindings(params);
    const stmt = this.sqlDb.prepare(this.sql);
    try {
      if (bindings) stmt.bind(bindings);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class DbWrapper {
  constructor(sqlDb) {
    this.inner = sqlDb;
  }

  prepare(sql) {
    return new Statement(this.inner, sql);
  }

  exec(sql) {
    const results = this.inner.exec(sql);
    scheduleSave();
    return results;
  }

  // Run a function inside a transaction. The function may be async; we await it.
  async transaction(fn) {
    this.inner.exec('BEGIN');
    try {
      const result = await fn();
      this.inner.exec('COMMIT');
      flushSave();
      return result;
    } catch (err) {
      try { this.inner.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  save() {
    flushSave();
  }

  backup(filePath) {
    flushSave();
    const data = this.inner.export();
    fs.writeFileSync(filePath, Buffer.from(data));
  }

  close() {
    flushSave();
    this.inner.close();
  }
}

export async function initDb() {
  if (_db) return new DbWrapper(_db);
  if (!SQL) SQL = await initSqlJs();
  const config = loadConfig();
  dbPath = path.resolve(config.database.path);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }
  return new DbWrapper(_db);
}

export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return new DbWrapper(_db);
}

export async function runMigrations() {
  const db = await initDb();
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now','localtime')))");
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));

  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf-8');
    // Split on ; that aren't inside string literals. Naive split is OK here since our migrations don't use ; in strings.
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    flushSave();
    console.log(`[DB] Migration applied: ${f}`);
  }
}

export function closeDb() {
  if (_db) {
    flushSave();
    _db.close();
    _db = null;
  }
}
