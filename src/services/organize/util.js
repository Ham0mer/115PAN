import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { FolderTreeCache } from '../115.js';
import { classifyRegion, classifyAnimeRegion } from '../tmdb.js';

// 默认视频/元数据扩展名（用户未配置时使用）
export const VIDEO_EXTS_DEFAULT = 'mp4,mkv,avi,mov,rmvb,wmv,ts,iso,m2ts';
export const META_EXTS_DEFAULT = 'ass,srt,ssa,sub,vtt,nfo,xml';

/**
 * 读取整理配置（单行）。
 */
export function getConfig() {
  return getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
}

/**
 * 在 cfg 上挂载目标目录的内存子树缓存，供 ensureFolderPath / getOrCreateChildFolder /
 * findExistingShowCid 直接命中已知路径而无需调 API。失败一律降级（_targetCache=null）。
 */
export async function attachTargetCache(cfg) {
  if (!cfg || cfg._targetCache !== undefined) return cfg?._targetCache;
  if (!cfg.target_cid || String(cfg.target_cid) === '0') {
    cfg._targetCache = null;
    return null;
  }
  try {
    const cache = new FolderTreeCache(cfg.target_cid);
    await cache.load();
    cfg._targetCache = cache;
    logger.info('Organizer', `目标目录树已缓存 cid=${cfg.target_cid} folders=${cache.byId.size - 1}`);
    return cache;
  } catch (err) {
    logger.warn('Organizer', `加载目标目录树缓存失败，将走逐次查询: ${err.message}`);
    cfg._targetCache = null;
    return null;
  }
}

/**
 * 把逗号分隔的扩展名 CSV 解析为小写、trim 后的数组；空时回退到默认值。
 */
export function parseExts(csv, fallback) {
  return (csv || fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** 取文件名扩展名（小写，不含点）。 */
export function extOf(name) {
  const m = String(name || '').match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** 取文件名主干（去掉扩展名）。 */
export function stemOf(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

/** Promise 化的 sleep。 */
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 取消令牌 =====
// 通过 taskId → 一个 { cancelled } 对象的弱协议实现协作式取消。

const cancelTokens = new Map();

export function getCancelToken(taskId) {
  if (!cancelTokens.has(taskId)) cancelTokens.set(taskId, { cancelled: false });
  return cancelTokens.get(taskId);
}

/**
 * 请求取消指定任务。下次循环边界时该任务会自然退出，并把 tasks.status 改为 'cancelled'。
 */
export function requestCancel(taskId) {
  const t = cancelTokens.get(taskId);
  if (t) t.cancelled = true;
}

export function cleanupCancelToken(taskId) {
  cancelTokens.delete(taskId);
}

/**
 * 给一个组生成可读标签，用于日志/通知（优先文件夹名，否则首个视频名）。
 */
export function groupLabel(g) {
  return g.folderName || g.videos[0]?.name || `parent=${g.parentCid}`;
}

/**
 * 根据识别结果决定目标分类路径段数组：
 * - 一级：电影 / 剧集 / 动漫
 * - 二级（可选）：地区分类
 * - 三级（可选）：年份
 */
export function classifyTargetPath(id, cfg) {
  let region = '其他';
  if (cfg.secondary_category && id.tmdbDetails) {
    region = id.mediaType === 'anime'
      ? classifyAnimeRegion(id.tmdbDetails)
      : classifyRegion(id.tmdbDetails);
  }
  let segs;
  if (id.mediaType === 'anime') segs = ['动漫'];
  else if (id.mediaType === 'tv') segs = ['剧集'];
  else segs = ['电影'];
  if (cfg.secondary_category) segs.push(region);
  if (cfg.tertiary_category && id.year) segs.push(String(id.year));
  return segs;
}
