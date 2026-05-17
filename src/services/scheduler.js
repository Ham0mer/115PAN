import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { getActiveCookie, verifyCookie, expireCookie } from './115.js';
import { notifyCookieExpired } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 整理任务的 setInterval 句柄
let organizeTimer = null;
// Cookie 健康检查的 setInterval 句柄
let cookieTimer = null;
// 是否有整理任务正在进行（防止重入）
let isOrganizing = false;

/**
 * 读取整理任务的运行配置（含 source_cid/target_cid/scan_interval_min 等）。
 */
function getConfig() {
  return getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
}

/**
 * 读取调度器自身的配置（位于 config/config.json 的 scheduler 字段）。
 * 失败时返回兜底默认值，避免调度器在配置缺失时直接崩溃。
 */
function getSchedulerConfig() {
  try {
    const configPath = path.join(__dirname, '..', '..', 'config', 'config.json');
    const defaultPath = path.join(__dirname, '..', '..', 'config', 'default.json');
    const p = fs.existsSync(configPath) ? configPath : defaultPath;
    return JSON.parse(fs.readFileSync(p, 'utf-8')).scheduler;
  } catch {
    return { cookieRefreshHours: 12 };
  }
}

/**
 * 周期性检查活跃 Cookie 是否仍然有效。
 * - 无 Cookie：跳过；
 * - 失效：在库中标记过期并发送 Telegram 通知；
 * - 有效：仅写一条 DEBUG 日志；
 * - 异常：吞掉错误并写 ERROR 日志，保证调度循环不被打断。
 */
async function checkCookie() {
  try {
    const cookie = getActiveCookie();
    if (!cookie) {
      logger.info('Scheduler', '无有效Cookie，跳过检查');
      return;
    }
    const { valid } = await verifyCookie(cookie.cookie_str);
    if (!valid) {
      expireCookie(cookie.id);
      logger.warn('Scheduler', 'Cookie已失效');
      await notifyCookieExpired().catch(() => {});
    } else {
      logger.debug('Scheduler', 'Cookie有效');
    }
  } catch (err) {
    logger.error('Scheduler', 'Cookie检查失败', err.message);
  }
}

/**
 * 定时入口：扫描源目录并整理到目标目录。
 * 多重前置校验：
 * 1) 上次任务未结束 → 跳过（避免并发）；
 * 2) 缺少源/目标 CID → 跳过；
 * 3) 没有可用 Cookie → 跳过。
 * 全部通过后动态 import 整理器，避免在调度器加载期就引入 organizer 的副作用。
 */
async function scanAndOrganize() {
  if (isOrganizing) {
    logger.debug('Scheduler', '上一次整理尚未完成，跳过');
    return;
  }
  const cfg = getConfig();
  if (!cfg?.source_cid || !cfg?.target_cid) {
    logger.debug('Scheduler', '未配置源/目标目录，跳过');
    return;
  }
  const cookie = getActiveCookie();
  if (!cookie) {
    logger.debug('Scheduler', '未登录115，跳过');
    return;
  }

  isOrganizing = true;
  try {
    // 动态导入，规避循环依赖与启动时副作用
    const { runOrganize } = await import('./organizer.js');
    await runOrganize();
  } catch (err) {
    logger.error('Scheduler', '整理任务异常', err.message);
  } finally {
    isOrganizing = false;
  }
}

/**
 * 调度器对外门面：start / stop / reschedule / runNow / isRunning。
 * 由 server 启动时调用 start()，配置变更时调用 reschedule()，
 * 用户在 Web 端"立即运行"会调用 runNow()。
 */
export const scheduler = {
  /**
   * 启动两个独立定时器：Cookie 检查 + 周期整理。
   * Cookie 检查的频率来自 scheduler 配置；整理的频率来自数据库中的 config_organize.scan_interval_min。
   */
  start() {
    const schedCfg = getSchedulerConfig();
    const cookieMs = (schedCfg.cookieRefreshHours || 12) * 3600000;
    cookieTimer = setInterval(checkCookie, cookieMs);
    logger.info('Scheduler', `Cookie检查已启动 (每${schedCfg.cookieRefreshHours}小时)`);

    this.reschedule();
    logger.info('Scheduler', '调度器已启动');
  },

  /**
   * 停止所有定时器（一般在进程优雅退出钩子中调用）。
   */
  stop() {
    if (cookieTimer) clearInterval(cookieTimer);
    if (organizeTimer) clearInterval(organizeTimer);
    cookieTimer = null;
    organizeTimer = null;
    logger.info('Scheduler', '调度器已停止');
  },

  /**
   * 根据最新的整理配置重新设置整理任务的定时间隔。
   * 当用户在 Web 端修改了 scan_interval_min 后由路由层调用。
   * 最小间隔强制为 5 分钟，避免误填导致请求风暴。
   */
  reschedule() {
    if (organizeTimer) clearInterval(organizeTimer);
    const cfg = getConfig();
    const intervalMin = Math.max(cfg?.scan_interval_min || 10, 5);
    organizeTimer = setInterval(scanAndOrganize, intervalMin * 60000);
    logger.info('Scheduler', `扫描间隔: ${intervalMin}分钟`);
  },

  /**
   * 立即执行一次整理任务（不影响周期定时器）。
   * @returns {Promise<Object>} 整理结果或 {error} 对象
   */
  async runNow() {
    if (isOrganizing) {
      return { error: '整理任务正在运行中' };
    }
    isOrganizing = true;
    try {
      const { runOrganize } = await import('./organizer.js');
      return await runOrganize();
    } finally {
      isOrganizing = false;
    }
  },

  /**
   * 当前是否正有整理任务在执行（供 API/UI 查询）。
   */
  get isRunning() {
    return isOrganizing;
  }
};
