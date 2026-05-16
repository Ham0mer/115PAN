import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { getActiveCookie, verifyCookie, expireCookie } from './115.js';
import { notifyCookieExpired } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let organizeTimer = null;
let cookieTimer = null;
let isOrganizing = false;

function getConfig() {
  return getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
}

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
    const { runOrganize } = await import('./organizer.js');
    await runOrganize();
  } catch (err) {
    logger.error('Scheduler', '整理任务异常', err.message);
  } finally {
    isOrganizing = false;
  }
}

export const scheduler = {
  start() {
    const schedCfg = getSchedulerConfig();
    const cookieMs = (schedCfg.cookieRefreshHours || 12) * 3600000;
    cookieTimer = setInterval(checkCookie, cookieMs);
    logger.info('Scheduler', `Cookie检查已启动 (每${schedCfg.cookieRefreshHours}小时)`);

    this.reschedule();
    logger.info('Scheduler', '调度器已启动');
  },

  stop() {
    if (cookieTimer) clearInterval(cookieTimer);
    if (organizeTimer) clearInterval(organizeTimer);
    cookieTimer = null;
    organizeTimer = null;
    logger.info('Scheduler', '调度器已停止');
  },

  reschedule() {
    if (organizeTimer) clearInterval(organizeTimer);
    const cfg = getConfig();
    const intervalMin = Math.max(cfg?.scan_interval_min || 10, 5);
    organizeTimer = setInterval(scanAndOrganize, intervalMin * 60000);
    logger.info('Scheduler', `扫描间隔: ${intervalMin}分钟`);
  },

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

  get isRunning() {
    return isOrganizing;
  }
};
