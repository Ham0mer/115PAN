import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let config = null;
let logStream = null;
let currentDate = '';

function getConfig() {
  if (!config) {
    const configPath = path.join(process.cwd(), 'config', 'config.json');
    const defaultPath = path.join(process.cwd(), 'config', 'default.json');
    const p = fs.existsSync(configPath) ? configPath : defaultPath;
    config = JSON.parse(fs.readFileSync(p, 'utf-8')).logs;
  }
  return config;
}

const COLORS = { DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m' };

const SHANGHAI = 'Asia/Shanghai';

function fmtDateTime() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function fmtDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: SHANGHAI });
}

function ensureStream() {
  const cfg = getConfig();
  const date = fmtDate();
  if (date !== currentDate || !logStream) {
    if (logStream) logStream.end();
    const dir = path.resolve(cfg.dir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(path.join(dir, `${date}.log`), { flags: 'a' });
    currentDate = date;
  }
}

export function log(level, category, message, detail = '') {
  const cfg = getConfig();
  if (LOG_LEVELS[level] < LOG_LEVELS[(cfg.level || 'info').toUpperCase()]) return;

  const ts = fmtDateTime();
  const line = `[${ts}] [${level}] [${category}] ${message}${detail ? ' | ' + detail : ''}`;

  // Console
  const c = COLORS[level] || '';
  console.log(`${c}${line}${COLORS.RESET}`);

  // File
  ensureStream();
  if (logStream) logStream.write(line + '\n');

  // DB (WARN+ only to avoid bloat)
  if (LOG_LEVELS[level] >= LOG_LEVELS.WARN) {
    try {
      const db = getDb();
      db.prepare('INSERT INTO logs (level, category, message, detail) VALUES (?,?,?,?)').run(level, category, message, detail);
    } catch {}
  }
}

export const logger = {
  debug: (cat, msg, d) => log('DEBUG', cat, msg, d),
  info: (cat, msg, d) => log('INFO', cat, msg, d),
  warn: (cat, msg, d) => log('WARN', cat, msg, d),
  error: (cat, msg, d) => log('ERROR', cat, msg, d),
};

export function cleanupOldLogs() {
  const cfg = getConfig();
  const dir = path.resolve(cfg.dir);
  if (!fs.existsSync(dir)) return;
  const retain = (cfg.retainDays || 30) * 86400000;
  const now = Date.now();
  fs.readdirSync(dir).forEach(f => {
    if (f.endsWith('.log')) {
      const fp = path.join(dir, f);
      if (now - fs.statSync(fp).mtimeMs > retain) fs.unlinkSync(fp);
    }
  });
}
