import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 当前模块所在目录（ESM 中没有 __dirname，需要从 import.meta.url 推导）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// sql.js 运行时单例（首次 initDb 时加载 wasm）
let SQL = null;
// 底层 sql.js Database 实例（内存数据库）
let _db = null;
// 持久化文件路径（来自 config.database.path）
let dbPath = '';

/**
 * 加载应用配置（含数据库路径）。
 * 优先 config/config.json（用户自定义），否则回退 config/default.json。
 */
function loadConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'config.json');
  const defaultPath = path.join(__dirname, '..', '..', 'config', 'default.json');
  const p = fs.existsSync(configPath) ? configPath : defaultPath;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// 防抖保存定时器：sql.js 是内存数据库，任何写操作需要主动 export 到磁盘
let saveTimeout = null;

/**
 * 安排一次延迟 300ms 的磁盘落盘。
 * 多次连续写操作会被合并成一次写文件，显著降低磁盘 IO。
 */
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    flushSave();
  }, 300);
}

/**
 * 立即执行落盘：导出 sql.js 内存数据库为二进制并覆盖写入文件。
 * 在事务提交、close、backup 等关键节点调用，确保数据不会因进程退出而丢失。
 */
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

/**
 * 判断是否为普通对象（用于识别命名参数绑定）。
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 将 JS 值转换为 sql.js 可识别的原始类型。
 * - undefined → null（sql.js 不接受 undefined 作为绑定值）
 * - boolean → 0/1（SQLite 没有原生 boolean，用整数表示）
 * - 其他值保持原样
 */
function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * 归一化参数绑定为 sql.js 支持的形式。
 * - 无参数：返回 null
 * - 单个对象参数：视为命名参数，自动给键加上 '@' 前缀（sql.js 命名占位符约定）
 * - 多个参数：视为按顺序的位置参数数组
 */
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

/**
 * 预编译语句封装，模拟 better-sqlite3 的同步 API（run/get/all）。
 * 注意：sql.js 没有真正的"预编译复用"，每次调用都会重新 prepare。
 */
class Statement {
  /**
   * @param {Object} sqlDb 底层 sql.js Database 实例
   * @param {string} sql SQL 语句字符串
   */
  constructor(sqlDb, sql) {
    this.sqlDb = sqlDb;
    this.sql = sql;
  }

  /**
   * 执行写操作（INSERT/UPDATE/DELETE/DDL）。
   * @returns {{changes:number, lastInsertRowid:number}} 受影响行数与最近插入的 rowid
   * 副作用：触发防抖落盘。
   */
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

  /**
   * 执行查询，返回首行结果。
   * @returns {Object|undefined} 首行对象（列名 → 值），无结果时返回 undefined
   */
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

  /**
   * 执行查询，返回所有结果行。
   * @returns {Array<Object>} 行对象数组
   */
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

/**
 * 数据库门面：对外暴露 prepare/exec/transaction/save/backup/close。
 * 该包装保证调用风格与 better-sqlite3 兼容（项目其他代码无需感知 sql.js 差异）。
 */
class DbWrapper {
  constructor(sqlDb) {
    this.inner = sqlDb;
  }

  /**
   * 预编译 SQL，返回 Statement 实例（可链式调用 .run/.get/.all）。
   */
  prepare(sql) {
    return new Statement(this.inner, sql);
  }

  /**
   * 直接执行 SQL（可包含多条语句）。
   * 触发防抖落盘。
   */
  exec(sql) {
    const results = this.inner.exec(sql);
    scheduleSave();
    return results;
  }

  /**
   * 在事务内执行一段逻辑（fn 可以是 async）。
   * 成功则 COMMIT 并立即落盘；任何异常都会 ROLLBACK 并重新抛出。
   * @param {Function} fn 业务逻辑函数（同步或异步）
   * @returns {Promise<any>} fn 的返回值
   */
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

  /**
   * 立即落盘（同步）。一般用于关键节点强制持久化。
   */
  save() {
    flushSave();
  }

  /**
   * 将当前数据库导出为独立文件副本，用于备份。
   * 调用前先 flush 一次，保证备份内容为最新状态。
   */
  backup(filePath) {
    flushSave();
    const data = this.inner.export();
    fs.writeFileSync(filePath, Buffer.from(data));
  }

  /**
   * 关闭数据库连接：先落盘，再释放底层资源。
   */
  close() {
    flushSave();
    this.inner.close();
  }
}

/**
 * 初始化数据库（异步）。幂等：重复调用返回同一个包装实例。
 * - 首次调用：加载 sql.js wasm 运行时；若磁盘文件存在则读取，否则建新库。
 * - 必须在服务器启动早期 await 完成，再调用 runMigrations。
 */
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

/**
 * 同步获取数据库实例。
 * 必须在 initDb() 完成之后才能调用，否则抛错。
 * 项目内绝大多数业务代码应通过此函数取得 DB。
 */
export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return new DbWrapper(_db);
}

/**
 * 执行 src/migrations 目录下的迁移脚本。
 * - 自动建立 _migrations 表记录已执行的脚本名；
 * - 按文件名字典序执行尚未应用的 .sql 文件；
 * - 简单地用 ';' 切分多条语句（迁移内不允许在字符串中出现分号）。
 * 必须在 initDb 后、对外提供服务前完成。
 */
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
    // 朴素切分：本项目迁移不会在字符串字面量中出现分号，所以可直接 split。
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    flushSave();
    console.log(`[DB] Migration applied: ${f}`);
  }
}

/**
 * 关闭数据库连接（落盘 + 释放）。一般在进程退出钩子中调用。
 */
export function closeDb() {
  if (_db) {
    flushSave();
    _db.close();
    _db = null;
  }
}
