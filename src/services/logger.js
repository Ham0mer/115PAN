import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';

// 日志级别映射，数值越大优先级越高，用于判定是否达到输出阈值
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
// 日志配置缓存（懒加载，仅首次调用 getConfig 时读取磁盘）
let config = null;
// 当前日期对应的写入流，按日切片
let logStream = null;
// 当前日志文件对应的日期（YYYY-MM-DD），用于检测跨日切换
let currentDate = '';

/**
 * 读取并缓存日志配置。
 * 优先读取 config/config.json，不存在则回退到 config/default.json。
 * 只取其中的 logs 字段（包含 dir、level、retainDays 等）。
 */
function getConfig() {
  if (!config) {
    const configPath = path.join(process.cwd(), 'config', 'config.json');
    const defaultPath = path.join(process.cwd(), 'config', 'default.json');
    const p = fs.existsSync(configPath) ? configPath : defaultPath;
    config = JSON.parse(fs.readFileSync(p, 'utf-8')).logs;
  }
  return config;
}

// 控制台输出的 ANSI 颜色编码，按日志级别区分（DEBUG青/INFO绿/WARN黄/ERROR红）
const COLORS = { DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m' };

// 固定使用上海时区（东八区），避免服务器时区差异导致日志时间错乱
const SHANGHAI = 'Asia/Shanghai';

/**
 * 以上海时区格式化当前时间为 "YYYY-MM-DD HH:mm:ss"。
 * 使用 Intl.DateTimeFormat 的 sv-SE 区域（瑞典）取得 ISO 风格的零填充输出。
 */
function fmtDateTime() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * 以上海时区格式化当前日期为 "YYYY-MM-DD"，用于日志文件命名与按日切片判断。
 */
function fmtDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: SHANGHAI });
}

/**
 * 保证当前存在有效的日志写入流：
 * - 日期发生变化时关闭旧流并创建新文件；
 * - 日志目录不存在时递归创建；
 * - 文件以追加（'a'）方式打开，避免覆盖历史日志。
 */
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

/**
 * 写入一条日志的核心函数。
 * @param {string} level 日志级别 DEBUG/INFO/WARN/ERROR
 * @param {string} category 业务分类标签（例如 "organizer"、"115"），便于过滤
 * @param {string} message 主消息
 * @param {string} detail 附加详情（可选），会以 " | " 分隔附在消息后
 *
 * 写入策略：
 * 1) 控制台带颜色输出；
 * 2) 写入按天切片的日志文件；
 * 3) WARN 及以上级别同时落库（logs 表），便于前端展示；DEBUG/INFO 不入库以避免膨胀。
 * 入库失败被静默吞掉，避免日志副作用反过来影响主流程。
 */
export function log(level, category, message, detail = '') {
  const cfg = getConfig();
  // 低于配置阈值的级别直接丢弃
  if (LOG_LEVELS[level] < LOG_LEVELS[(cfg.level || 'info').toUpperCase()]) return;

  const ts = fmtDateTime();
  const line = `[${ts}] [${level}] [${category}] ${message}${detail ? ' | ' + detail : ''}`;

  // 控制台输出（彩色）
  const c = COLORS[level] || '';
  console.log(`${c}${line}${COLORS.RESET}`);

  // 文件输出
  ensureStream();
  if (logStream) logStream.write(line + '\n');

  // 数据库输出，仅 WARN 及以上以控制表大小
  if (LOG_LEVELS[level] >= LOG_LEVELS.WARN) {
    try {
      const db = getDb();
      db.prepare('INSERT INTO logs (level, category, message, detail) VALUES (?,?,?,?)').run(level, category, message, detail);
    } catch {}
  }
}

/**
 * 业务侧调用入口：logger.info('category', 'msg', 'detail')。
 * 四个级别均委托给 log() 实现。
 */
export const logger = {
  debug: (cat, msg, d) => log('DEBUG', cat, msg, d),
  info: (cat, msg, d) => log('INFO', cat, msg, d),
  warn: (cat, msg, d) => log('WARN', cat, msg, d),
  error: (cat, msg, d) => log('ERROR', cat, msg, d),
};

/**
 * 清理过期日志文件。
 * 遍历日志目录下所有 .log 文件，按 mtime 与配置的 retainDays（默认 30 天）比较，
 * 超过保留期的文件直接删除。由调度器定时调用。
 */
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
