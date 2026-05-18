import { getDb } from './db.js';
import { logger } from './logger.js';
import {
  listFilesRecursive, renameFile, renameFiles, moveFile, moveFiles, createFolder, ensureFolderPath,
  moveToRecycle, moveToRecycleBatch, listFolder, findFolderByName, deleteFolder,
  getFolderInfo, listAllSubFolders, listAllSubFiles, FolderTreeCache,
} from './115.js';
import {
  parseFilename,
  detectMediaTypeFromStructure, detectLanguage,
} from './parser.js';
import {
  searchMovie, searchTV, searchMulti, getMovieDetails, getTVDetails,
  classifyRegion, classifyAnimeRegion, isAnime, getYear, getTitle,
} from './tmdb.js';
import { aiIdentify } from './ai.js';
import { getMediaInfo } from './ffprobe.js';
import {
  generateMovieNames, generateTVNames, buildSubtitleSuffix,
  buildMultiVersionSuffix, sanitizeName,
} from './template.js';
import { notifySuccess, notifyFailure, notifyEpisodes } from './telegram.js';

// 默认视频/元数据扩展名（用户未配置时使用）
const VIDEO_EXTS_DEFAULT = 'mp4,mkv,avi,mov,rmvb,wmv,ts,iso,m2ts';
const META_EXTS_DEFAULT = 'ass,srt,ssa,sub,vtt,nfo,xml';

/**
 * 读取整理配置（单行）。
 */
function getConfig() {
  return getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
}

/**
 * 在 cfg 上挂载目标目录的内存子树缓存，供 ensureFolderPath / getOrCreateChildFolder /
 * findExistingShowCid 直接命中已知路径而无需调 API。
 *
 * - 失败一律降级（_targetCache=null），后续函数会自动回退到逐次 API 查询；
 * - 用 cfg._targetCache 透传，避免在所有 helper 之间显式传 cache。
 *
 * @returns {Promise<FolderTreeCache|null>}
 */
async function attachTargetCache(cfg) {
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
function parseExts(csv, fallback) {
  return (csv || fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** 取文件名扩展名（小写，不含点）。 */
function extOf(name) {
  const m = String(name || '').match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** 取文件名主干（去掉扩展名）。 */
function stemOf(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

/** Promise 化的 sleep。 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 取消令牌 =====
// 通过 taskId → 一个 { cancelled } 对象的弱协议实现协作式取消。
// 整理流程中各处会读取 cancel.cancelled 主动退出，避免硬中断。

const cancelTokens = new Map();
function getCancelToken(taskId) {
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
function cleanupCancelToken(taskId) {
  cancelTokens.delete(taskId);
}

// ===== 入口 =====

/**
 * 整理任务主入口。可在调度器或人工触发时调用。
 *
 * 流程：
 * 1) 读取配置，校验源/目标目录 → 创建或复用 tasks 记录；
 * 2) 加载目标目录子树缓存；
 * 3) listFilesRecursive 扫描源目录；空则仅清理空目录后退出；
 * 4) filterFiles + groupFiles 形成"媒体单元"列表；
 * 5) 逐组调用 processGroup，期间频繁检查取消令牌；
 * 6) 任务完成后再清一次源目录残留空目录；
 * 7) 若启用了聚合通知，按 tmdbId 一次性发送剧集合并通知；
 * 8) 更新 tasks 状态并返回 { taskId, stats }。
 *
 * @param {number} [taskId] 可选：在已有任务行上继续运行（用于"重新运行"等场景）
 * @param {Object} [options] 预留参数
 * @returns {Promise<{taskId,stats,cancelled?}>} 统计信息含 scan/success/fail/skip
 */
export async function runOrganize(taskId, options = {}) {
  const db = getDb();
  const cfg = getConfig();
  if (!cfg) throw new Error('整理配置未设置');
  if (!cfg.source_cid || !cfg.target_cid) throw new Error('未配置源/目标目录');

  // 新建任务行或复用已有
  if (!taskId) {
    const r = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
    taskId = r.lastInsertRowid;
  } else {
    db.prepare("UPDATE tasks SET status='running', started_at=datetime('now','localtime') WHERE id=?").run(taskId);
  }
  const cancel = getCancelToken(taskId);
  const stats = { scan: 0, success: 0, fail: 0, skip: 0 };
  // 用于聚合剧集通知：tmdbId → { title, items: [{season,episode}] }
  const episodeSummary = new Map();

  try {
    logger.info('Organizer', `开始扫描 cid=${cfg.source_cid}`);
    await attachTargetCache(cfg);
    const files = await listFilesRecursive(cfg.source_cid, { maxDepth: 8 });
    stats.scan = files.length;
    logger.info('Organizer', `扫描完成: ${files.length} 个文件`);

    if (!files.length) {
      // 源目录为空：仅清理残留空目录后结束。任务行也清理掉以免污染历史。
      logger.info('Organizer', `源目录无文件，仅清理残留空目录 cid=${cfg.source_cid}`);
      await cleanupEmptyFolders(cfg.source_cid);
      db.prepare('DELETE FROM task_items WHERE task_id=?').run(taskId);
      db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
      cleanupCancelToken(taskId);
      return { taskId, stats };
    }

    const filtered = filterFiles(files, cfg);
    const groups = groupFiles(filtered, cfg);
    logger.info('Organizer', `分组完成: ${groups.length} 个媒体单元`);

    if (!groups.length) {
      logger.info('Organizer', `无媒体单元，仅清理残留空目录 cid=${cfg.source_cid}`);
      await cleanupEmptyFolders(cfg.source_cid);
      db.prepare(`UPDATE tasks SET status='completed', ended_at=datetime('now','localtime'),
        scan_count=?, success_count=0, fail_count=0, skip_count=0 WHERE id=?`).run(stats.scan, taskId);
      cleanupCancelToken(taskId);
      return { taskId, stats };
    }

    // 逐组处理。组之间用 operation_delay_sec 节流。
    for (const group of groups) {
      if (cancel.cancelled) {
        logger.warn('Organizer', '任务被取消');
        db.prepare("UPDATE tasks SET status='cancelled', ended_at=datetime('now','localtime') WHERE id=?").run(taskId);
        return { taskId, stats, cancelled: true };
      }
      try {
        await processGroup(group, cfg, taskId, stats, cancel, episodeSummary);
      } catch (err) {
        logger.error('Organizer', `组处理失败: ${groupLabel(group)}`, err.message);
        stats.fail++;
        recordTaskItem(taskId, { error: err.message, source_path: group.parentCid, original_name: groupLabel(group) });
        // 失败通知错误本身不应阻塞后续组，吞掉
        await notifyFailure(`处理失败: ${groupLabel(group)}`, err.message).catch(() => {});
      }
      const delaySec = Number(cfg.operation_delay_sec) || 5;
      await sleep(delaySec * 1000);
    }

    // 全部组结束后再清理一次（处理过程中可能产生新空目录）
    await cleanupEmptyFolders(cfg.source_cid);
  } catch (err) {
    logger.error('Organizer', '整理任务异常', err.message);
    db.prepare("UPDATE tasks SET status='failed', ended_at=datetime('now','localtime') WHERE id=?").run(taskId);
    await notifyFailure('整理任务异常', err.message).catch(() => {});
    cleanupCancelToken(taskId);
    throw err;
  }

  db.prepare(`UPDATE tasks SET status='completed', ended_at=datetime('now','localtime'),
    scan_count=?, success_count=?, fail_count=?, skip_count=? WHERE id=?`)
    .run(stats.scan, stats.success, stats.fail, stats.skip, taskId);

  // 聚合剧集通知：每个剧只发一次合并消息。仅在该剧有 >1 集入库时发送。
  if (cfg.notify_enabled && !cfg.episode_per_notify) {
    for (const [, info] of episodeSummary) {
      if (info.items.length > 1) {
        await notifyEpisodes(info).catch(() => {});
      }
    }
  }

  logger.info('Organizer', `完成: 扫描${stats.scan} 成功${stats.success} 失败${stats.fail} 跳过${stats.skip}`);
  cleanupCancelToken(taskId);
  return { taskId, stats };
}

// ===== 过滤 & 分组 =====

/**
 * 过滤文件：仅保留视频或元数据扩展名；视频还需达到 min_video_size_mb。
 * 副作用：在文件对象上标注 _ext/_isVideo/_isMeta 以便后续分组无需重复判断。
 */
function filterFiles(files, cfg) {
  const videoExts = parseExts(cfg.video_extensions, VIDEO_EXTS_DEFAULT);
  const metaExts = parseExts(cfg.meta_extensions, META_EXTS_DEFAULT);
  const minSize = (Number(cfg.min_video_size_mb) || 0) * 1024 * 1024;
  return files.filter(f => {
    const ext = extOf(f.name);
    const isVideo = videoExts.includes(ext);
    const isMeta = metaExts.includes(ext);
    if (!isVideo && !isMeta) return false;
    if (isVideo && minSize > 0 && f.size < minSize) return false;
    f._ext = ext;
    f._isVideo = isVideo;
    f._isMeta = isMeta;
    return true;
  });
}

/**
 * 把过滤后的文件聚合为"媒体单元"组：
 * - 处于子目录中的文件按 parentCid 聚合（A/C 形态）；
 * - 直接位于源根目录的文件按 (title, year) 子分组（B/D 形态）；
 * - 嵌套目录（E 形态）：仍按直接父目录归组，后续识别从文件本身拉取元数据，嵌套深度无关紧要。
 *
 * 过滤掉无视频的"孤儿元数据组"。
 */
function groupFiles(files, cfg) {
  const rootFiles = [];
  const byParent = new Map();
  for (const f of files) {
    if (f.depth === 0) {
      rootFiles.push(f);
    } else {
      const key = f.parentCid;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }
  }

  const groups = [];

  for (const [parentCid, parentFiles] of byParent) {
    const videos = parentFiles.filter(f => f._isVideo);
    const metas = parentFiles.filter(f => f._isMeta);
    if (!videos.length) {
      // 没有视频的目录视为孤儿，跳过（避免空跑下游识别）
      logger.debug('Organizer', `跳过孤立元数据组 parent=${parentCid}`);
      continue;
    }
    const folderName = parentFiles[0].pathSegs[parentFiles[0].pathSegs.length - 1] || '';
    groups.push({ kind: 'folder', parentCid, folderName, videos, metas });
  }

  // 根级散文件按 (title|year) 进一步分组
  for (const subgroup of subgroupRootFiles(rootFiles, cfg)) {
    groups.push({ kind: 'root', parentCid: cfg.source_cid, folderName: '', ...subgroup });
  }

  return groups.filter(g => g.videos.length > 0);
}

/**
 * 把根级散文件按文件名解析出的 (title, year) 聚合成桶。
 * 元数据通过文件名"主干前缀互相包含"匹配到对应视频桶；都没匹配上且只有一个桶时挂到该桶。
 */
function subgroupRootFiles(files, cfg) {
  const videos = files.filter(f => f._isVideo);
  const metas = files.filter(f => f._isMeta);
  if (!videos.length) return [];

  // 用 (title|year) 做分桶 key。解析失败时退化为按文件名独立成组。
  const buckets = new Map();
  for (const v of videos) {
    const p = parseFilename(v.name);
    const key = `${(p.title || '').toLowerCase()}|${p.year || ''}`;
    if (!buckets.has(key)) buckets.set(key, { parsed: p, videos: [], metas: [] });
    buckets.get(key).videos.push(v);
  }

  // 元数据按文件名 stem 前缀挂到对应视频桶
  for (const m of metas) {
    const stem = stemOf(m.name).toLowerCase();
    let hit = null;
    for (const [, b] of buckets) {
      if (b.videos.some(v => {
        const vs = stemOf(v.name).toLowerCase();
        return stem.startsWith(vs) || vs.startsWith(stem);
      })) { hit = b; break; }
    }
    // 单桶兜底：找不到精确匹配时把元数据挂到唯一桶
    if (!hit && buckets.size === 1) hit = [...buckets.values()][0];
    if (hit) hit.metas.push(m);
  }

  return [...buckets.values()];
}

/**
 * 给一个组生成可读标签，用于日志/通知（优先文件夹名，否则首个视频名）。
 */
function groupLabel(g) {
  return g.folderName || g.videos[0]?.name || `parent=${g.parentCid}`;
}

// ===== 识别 =====

/**
 * 对一个媒体单元做综合识别：本地文件名解析 → TMDB 搜索 → AI 兜底。
 *
 * 关键设计：
 * - 解析名字池 = 所有祖先目录名 + 所有视频文件名。最顶层的目录名（如"庆余年.S01.全集"）
 *   通常含最干净的标题，胜过单文件名。
 * - 通过 pickBestParsed 综合打分挑出一份"主版本"信息；季号取任一文件解析到的非空值。
 * - 结构启发式只在没有显式 tmdbId 时才允许把媒体类型翻转为 tv，避免"电影 (年) {tmdb-xxx}"
 *   配着花絮被误判为剧集。
 * - TMDB / AI 是各自独立的可关闭兜底；AI 拿到 tmdbId 后还会回头再走一次 TMDB 拿详情。
 * - 最终用 tmdbDetails 判断是否为动漫（Genre=Animation）并刷新 title/year。
 */
async function identifyGroup(group, cfg) {
  // 收集所有可用作输入的字符串：祖先目录名 + 文件夹名 + 视频文件名
  const ancestorNames = new Set();
  for (const v of group.videos) {
    if (Array.isArray(v.pathSegs)) {
      for (const seg of v.pathSegs) if (seg) ancestorNames.add(seg);
    }
  }
  if (group.folderName) ancestorNames.add(group.folderName);
  const names = [...ancestorNames, ...group.videos.map(v => v.name)].filter(Boolean);
  const parsedAll = names.map(n => parseFilename(n));

  // 综合打分挑出最佳标题/年份/类型；季号从任一解析项取非空。
  const merged = pickBestParsed(parsedAll, group);

  // 媒体类型的结构启发式：仅当未拿到 tmdbId 时允许翻转为 tv。
  const videoExts = new Set(parseExts(cfg.video_extensions, VIDEO_EXTS_DEFAULT));
  const struct = detectMediaTypeFromStructure(group.videos.map(v => v.name), group.folderName, videoExts);
  if (struct === 'tv' && !merged.tmdbId) {
    merged.mediaType = 'tv';
  }

  // 4.6.2：若无 tmdbId 但有 title，则走 TMDB 搜索
  if (!merged.tmdbId && merged.title) {
    const tmdb = await resolveViaTmdb(merged);
    if (tmdb) Object.assign(merged, tmdb);
  }

  // 4.6.3：仍无 tmdbId 且 AI 已启用 → 走 AI 兜底
  if (!merged.tmdbId && cfg.ai_enabled) {
    try {
      const seed = group.folderName || group.videos[0]?.name;
      const ai = await aiIdentify(seed);
      if (ai) {
        // AI 仅补齐尚未确定的字段，避免覆盖前面已识别到的
        if (ai.title && !merged.title) merged.title = ai.title;
        if (ai.year && !merged.year) merged.year = String(ai.year);
        if (ai.tmdbId && !merged.tmdbId) merged.tmdbId = ai.tmdbId;
        if (ai.season != null && merged.season == null) merged.season = Number(ai.season);
        if (ai.episode != null && merged.episode == null) merged.episode = Number(ai.episode);
        if (ai.mediaType && !merged.mediaType) merged.mediaType = ai.mediaType;
        merged.identifySource = 'ai';
        // AI 给出 tmdbId 后再回头拉详情，借用 TMDB 的权威信息覆盖
        if (ai.tmdbId) {
          const t = await resolveViaTmdb(merged);
          if (t) Object.assign(merged, t);
        }
      }
    } catch (err) {
      logger.warn('Organizer', 'AI识别失败', err.message);
    }
  }

  // 确保拿到 details 用于地区分类与动漫判定
  if (merged.tmdbId && !merged.tmdbDetails) {
    try {
      merged.tmdbDetails = merged.mediaType === 'movie'
        ? await getMovieDetails(merged.tmdbId)
        : await getTVDetails(merged.tmdbId);
    } catch (err) {
      logger.debug('Organizer', `TMDB 详情拉取失败 id=${merged.tmdbId}: ${err.message}`);
    }
  }
  if (merged.tmdbDetails) {
    // 仅允许 tv → anime；动画电影应继续按电影处理（项目内 anime 流程强制要求 S/E）
    if (merged.mediaType === 'tv' && isAnime(merged.tmdbDetails)) merged.mediaType = 'anime';
    const dy = getYear(merged.tmdbDetails);
    if (dy) merged.year = dy;
    const dt = getTitle(merged.tmdbDetails);
    if (dt) merged.title = dt;
  }

  if (!merged.mediaType) merged.mediaType = 'movie';
  return merged;
}

/**
 * 给多份解析结果打分，挑出"最有信息量"的一份。
 * 打分项：title(+2)、year(+2)、season(+1)、episode(+1)。
 * 季号最终从任一解析项中取非空；tmdbId 从任一显式标注的解析项取（如 "...[tmdb-575219]"）。
 */
function pickBestParsed(parsedAll, group) {
  const scored = parsedAll.map(p => ({
    p,
    score: (p.title ? 2 : 0) + (p.year ? 2 : 0) + (p.season != null ? 1 : 0) + (p.episode != null ? 1 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.p || parsedAll[0] || {};
  const seasonFromAny = parsedAll.find(p => p.season != null)?.season ?? null;
  const tmdbIdFromAny = parsedAll.find(p => p.tmdbId)?.tmdbId ?? null;
  return {
    title: top.title || '',
    year: top.year || '',
    tmdbId: tmdbIdFromAny,
    mediaType: top.mediaType || null,
    season: seasonFromAny,
    episode: null,
    identifySource: 'local',
  };
}

/**
 * 通过 TMDB 解析媒体信息。
 * 优先按解析出的 mediaType 调具体接口（movie / tv），再用 multi 兜底。
 * 拿到候选后用 pickBestTmdb 选出最佳匹配，再拉 details，最后归并出业务侧字段。
 *
 * @returns {Promise<Object|null>} 含 title/year/tmdbId/mediaType/tmdbDetails 的对象；全部失败返回 null
 */
async function resolveViaTmdb(info) {
  const queries = [];
  if (info.mediaType === 'movie') queries.push(['movie']);
  else if (info.mediaType === 'tv' || info.mediaType === 'anime') queries.push(['tv']);
  queries.push(['multi']);

  for (const [t] of queries) {
    try {
      let results = [];
      if (t === 'movie') results = (await searchMovie(info.title, info.year)).map(r => ({ ...r, media_type: 'movie' }));
      else if (t === 'tv') results = (await searchTV(info.title, info.year)).map(r => ({ ...r, media_type: 'tv' }));
      else results = await searchMulti(info.title, info.year);
      results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) continue;
      const best = pickBestTmdb(results, info);
      if (!best) continue;
      const detail = best.media_type === 'movie'
        ? await getMovieDetails(best.id)
        : await getTVDetails(best.id);
      // 仅允许 tv → anime；动画电影应继续按电影处理
      const mediaType = (best.media_type === 'tv' && isAnime(detail || best)) ? 'anime' : best.media_type;
      return {
        title: getTitle(detail || best) || info.title,
        year: getYear(detail || best) || info.year,
        tmdbId: best.id,
        mediaType,
        tmdbDetails: detail,
        identifySource: 'tmdb',
      };
    } catch (err) {
      logger.debug('Organizer', `TMDB 查询失败 (${t}): ${err.message}`);
    }
  }
  return null;
}

/**
 * 从 TMDB 候选里选出"最像目标"的一条。
 * 打分：年份完全匹配 +3；标题完全相等 +3；标题互相包含 +1；流行度归一化 +0~2（最多 2 分）。
 */
function pickBestTmdb(results, info) {
  const wantedYear = info.year ? String(info.year) : '';
  const scored = results.map(r => {
    const y = (r.release_date || r.first_air_date || '').slice(0, 4);
    let score = 0;
    if (wantedYear && y === wantedYear) score += 3;
    const title = (r.title || r.name || '').toLowerCase();
    const want = (info.title || '').toLowerCase();
    if (title === want) score += 3;
    else if (title.includes(want) || want.includes(title)) score += 1;
    score += Math.min(2, (r.popularity || 0) / 50);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.r;
}

// ===== 处理单个组 =====

/**
 * 单个媒体单元的处理入口：识别 → 校验 → 分流到 movie/TV 流程。
 *
 * 校验策略：仅 title 是硬性必填；缺 year/tmdbId 时再以空年份做一次 TMDB 搜索补齐；
 * 仍然没有也允许走下游（具体流程会按需求决定是否跳过）。
 */
async function processGroup(group, cfg, taskId, stats, cancel, episodeSummary) {
  const id = await identifyGroup(group, cfg);

  if (!id.title) {
    await pushUnmatched(group, id, '缺少必要字段 (title)');
    stats.skip++;
    return;
  }
  // 缺 tmdbId 或 year 时，用 title 再做一次 TMDB 兜底
  if (!id.tmdbId || !id.year) {
    const tmdb = await resolveViaTmdb({ ...id, year: '' });
    if (tmdb) {
      if (!id.tmdbId && tmdb.tmdbId) id.tmdbId = tmdb.tmdbId;
      if (!id.year && tmdb.year) id.year = tmdb.year;
      if (tmdb.tmdbDetails && !id.tmdbDetails) id.tmdbDetails = tmdb.tmdbDetails;
      if (tmdb.mediaType && !id.mediaType) id.mediaType = tmdb.mediaType;
    }
  }

  if (id.mediaType === 'tv' || id.mediaType === 'anime') {
    // 剧集允许 group 级缺 S/E，但每个视频必须能解析出自己的 S/E
    await processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary);
  } else {
    await processMovieGroup(group, id, cfg, taskId, stats);
  }
}

/**
 * 把识别失败的组写入 unmatched_items 表，等待用户手动处理（4.13 流程）。
 * 同时记录 file_ids 列表，便于后续 resolveUnmatched 重建组结构。
 */
async function pushUnmatched(group, id, reason) {
  const db = getDb();
  const fileIds = [...group.videos, ...group.metas].map(f => ({ id: f.id, name: f.name, size: f.size, isVideo: f._isVideo }));
  db.prepare(`INSERT INTO unmatched_items
    (source_path, source_name, media_type_guess, identify_attempts, fail_reason, status, file_ids, parent_cid)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      group.parentCid,
      groupLabel(group),
      id?.mediaType || 'unknown',
      JSON.stringify({ id, group: { kind: group.kind, folderName: group.folderName, videoCount: group.videos.length } }),
      reason,
      JSON.stringify(fileIds),
      group.parentCid,
    );
  logger.warn('Organizer', `加入识别失败队列: ${groupLabel(group)} - ${reason}`);
}

/**
 * 根据识别结果决定目标分类路径段数组：
 * - 一级：电影 / 剧集 / 动漫
 * - 二级（可选）：地区分类（动漫走 classifyAnimeRegion，其余走 classifyRegion）
 * - 三级（可选）：年份
 */
function classifyTargetPath(id, cfg) {
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

// ===== 电影分支 =====

/**
 * 处理"识别为电影"的组：
 * 1) 算出分类路径、确保分类目录存在；
 * 2) 为每个视频独立提取技术规格 + 生成命名；
 * 3) 通过 tmdbId 复用已有电影文件夹（或按首个视频的 folderName 新建一个）；
 * 4) 逐视频走 placeVideo（多版本/同名冲突在那里处理）；
 * 5) 写入 task_items；
 * 6) 启用通知则发送成功通知。
 */
async function processMovieGroup(group, id, cfg, taskId, stats) {
  // 与剧集一致：无 tmdbId 不建目录，避免渲染出 "{tmdb-}" 这类墓碑名。
  if (!id.tmdbId) {
    await pushUnmatched(group, id, '缺少 tmdbId');
    stats.skip++;
    return;
  }

  const cache = cfg._targetCache || null;
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);

  // 为每个视频独立计算技术规格 + 命名
  const videoUnits = [];
  for (const v of group.videos) {
    const parsed = parseFilename(v.name);
    const probe = await extractMediaInfo(v, cfg);
    const mediaInfo = mergeMediaInfo(parsed, probe);
    const { folderName, fileName } = generateMovieNames(id, mediaInfo);
    videoUnits.push({ video: v, mediaInfo, folderName, fileName });
  }

  // 用首个视频生成的 folderName 作为"代表名"；若已有同 tmdbId 的文件夹则复用
  const winningFileName = videoUnits[0].folderName;
  const movieType = id.mediaType === 'anime' ? 'anime' : 'movie';
  const movieFolderCid = (await findExistingShowCid(id.tmdbId, movieType, catCid, cache))
    ?? await getOrCreateChildFolder(catCid, winningFileName, cache);

  for (const u of videoUnits) {
    const result = await placeVideo({
      video: u.video,
      mediaInfo: u.mediaInfo,
      id,
      targetCid: movieFolderCid,
      showCid: movieFolderCid,
      baseName: u.fileName,
      cfg,
      metas: group.metas,
      mediaType: 'movie',
      season: null,
      episode: null,
    });
    if (result === 'placed') stats.success++;
    else if (result === 'skipped') stats.skip++;
    else if (result === 'recycled') stats.skip++;
    recordTaskItem(taskId, {
      task_id: taskId,
      media_type: id.mediaType === 'anime' ? 'anime' : 'movie',
      source_path: group.parentCid,
      target_path: categoryPath.join('/') + '/' + winningFileName,
      target_cid: movieFolderCid,
      original_name: u.video.name,
      new_name: result === 'placed' ? u.fileName + '.' + extOf(u.video.name) : '',
      tmdb_id: id.tmdbId,
      identify_source: id.identifySource || '',
      file_id: u.video.id,
      file_size: u.video.size,
      recycled: result === 'recycled' ? 1 : 0,
    });
  }

  if (cfg.notify_enabled) {
    await notifySuccess({
      title: id.title,
      year: id.year,
      tmdbId: id.tmdbId,
      mediaType: 'movie',
      target_path: categoryPath.join('/') + '/' + winningFileName,
      resolution: videoUnits[0].mediaInfo.resolution,
      source: videoUnits[0].mediaInfo.source,
    }).catch(() => {});
  }
}

// ===== 剧集 / 动漫分支 =====

/**
 * 处理"识别为剧集/动漫"的组：
 * 1) 为每个视频解析 S/E（缺一不可，缺则进入未匹配队列）；
 * 2) 算分类路径与剧目录（可复用已有的 tmdbId 文件夹）；
 * 3) 按季缓存 seasonCid，避免重复创建；
 * 4) 逐集走 placeVideo，匹配对应字幕等元数据；
 * 5) 记录 task_items；
 * 6) episode_per_notify 模式下逐集通知，否则把入库的集合并到 episodeSummary 留待结尾统一通知。
 */
async function processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary) {
  // 解析每个视频的 S/E（可被 group 级 season 兜底）
  const episodes = [];
  for (const v of group.videos) {
    const parsed = parseFilename(v.name);
    const season = parsed.season != null ? parsed.season : (id.season != null ? id.season : null);
    const episode = parsed.episode;
    if (season == null || episode == null) {
      await pushUnmatched({ ...group, videos: [v], metas: [] }, { ...id, season, episode }, '剧集缺少 S/E');
      stats.skip++;
      continue;
    }
    const probe = await extractMediaInfo(v, cfg);
    const mediaInfo = mergeMediaInfo(parsed, probe);
    episodes.push({
      video: v,
      mediaInfo,
      season,
      episode,
      episodeEnd: parsed.episodeEnd ?? null,
      parsed,
    });
  }
  if (!episodes.length) return;

  // 无 tmdbId 不建剧目录：否则模板里的 {tmdb-} / {tmdbid=} 会渲染成"墓碑名"目录，
  // 后续也无法用 findExistingShowCid 复用。统一进 unmatched 等用户手动处理。
  if (!id.tmdbId) {
    for (const ep of episodes) {
      await pushUnmatched({ ...group, videos: [ep.video], metas: [] },
        { ...id, season: ep.season, episode: ep.episode }, '缺少 tmdbId');
      stats.skip++;
    }
    return;
  }

  // 确保剧目录存在（优先复用已有 tmdbId 文件夹）
  const cache = cfg._targetCache || null;
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);
  const showSampleNames = generateTVNames(id, episodes[0].mediaInfo, episodes[0].season, episodes[0].episode);
  const showFolderName = showSampleNames.showName;
  const showCid = (await findExistingShowCid(id.tmdbId, id.mediaType, catCid, cache))
    ?? await getOrCreateChildFolder(catCid, showFolderName, cache);

  // 季目录缓存：避免逐集重复 ensure
  const seasonsCache = new Map();
  const summaryItems = [];

  for (const ep of episodes) {
    if (cancel.cancelled) break;
    let seasonCid = seasonsCache.get(ep.season);
    if (!seasonCid) {
      const { seasonName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);
      seasonCid = await getOrCreateChildFolder(showCid, seasonName, cache);
      seasonsCache.set(ep.season, seasonCid);
    }
    const { episodeName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);

    // 字幕等元数据按 S/E 或 stem 前缀匹配到本集
    const epMetas = matchMetasToEpisode(ep, group.metas);

    const result = await placeVideo({
      video: ep.video,
      mediaInfo: ep.mediaInfo,
      id,
      targetCid: seasonCid,
      showCid,
      baseName: episodeName,
      cfg,
      metas: epMetas,
      mediaType: id.mediaType,
      season: ep.season,
      episode: ep.episode,
    });

    recordTaskItem(taskId, {
      task_id: taskId,
      media_type: id.mediaType,
      source_path: group.parentCid,
      target_path: categoryPath.join('/') + '/' + showFolderName + `/Season ${String(ep.season).padStart(2,'0')}`,
      target_cid: seasonCid,
      original_name: ep.video.name,
      new_name: result === 'placed' ? episodeName + '.' + extOf(ep.video.name) : '',
      tmdb_id: id.tmdbId,
      season: ep.season,
      episode: ep.episode,
      episode_end: ep.episodeEnd,
      identify_source: id.identifySource || '',
      file_id: ep.video.id,
      file_size: ep.video.size,
      recycled: result === 'recycled' ? 1 : 0,
    });

    if (result === 'placed') {
      stats.success++;
      summaryItems.push({ season: ep.season, episode: ep.episode, episodeEnd: ep.episodeEnd });
    } else if (result === 'skipped' || result === 'recycled') {
      stats.skip++;
    }

    if (cfg.notify_enabled && cfg.episode_per_notify && result === 'placed') {
      await notifySuccess({
        title: id.title,
        year: id.year,
        tmdbId: id.tmdbId,
        mediaType: id.mediaType,
        season: ep.season,
        episode: ep.episode,
        target_path: categoryPath.join('/') + '/' + showFolderName,
      }).catch(() => {});
    }
  }

  // 非逐集通知模式：把本组的入库集次累加到全局 summary，待 runOrganize 结尾统一发
  if (cfg.notify_enabled && !cfg.episode_per_notify && summaryItems.length) {
    const key = `${id.tmdbId}`;
    if (!episodeSummary.has(key)) {
      episodeSummary.set(key, {
        title: id.title,
        year: id.year,
        tmdbId: id.tmdbId,
        mediaType: id.mediaType,
        target_path: categoryPath.join('/') + '/' + showFolderName,
        items: [],
      });
    }
    episodeSummary.get(key).items.push(...summaryItems);
  }
}

/**
 * 把元数据文件（字幕/nfo 等）匹配到具体集。
 * 优先按解析出来的 S/E 严格相等；否则按 stem 前缀互相包含兜底。
 */
function matchMetasToEpisode(ep, allMetas) {
  return allMetas.filter(m => {
    const parsed = parseFilename(m.name);
    if (parsed.season != null && parsed.episode != null) {
      return parsed.season === ep.season && parsed.episode === ep.episode;
    }
    const vs = stemOf(ep.video.name);
    const ms = stemOf(m.name);
    return ms.startsWith(vs) || vs.startsWith(ms);
  });
}

// ===== 通用：单视频 + 元数据落位 =====

/**
 * 把单个视频（与其元数据）落位到目标目录，处理多版本与同名冲突。
 *
 * 流程：
 * 1) resolveMultiVersion 与媒体库已有版本对比：
 *    - 新文件落败 → 回收新文件；
 *    - 新文件胜出 → 回收旧版本并删除其 media_library 行；
 *    - 平手或保持现状 → 继续。
 * 2) 目标目录内同名文件冲突：
 *    - mode=2 跳过；
 *    - 启用 multi_version：用 v2 / v3 后缀避开；
 *    - 否则按 mode=0/1 决定保大或保小；
 * 3) 预先计算所有元数据的新名（启用重命名时按字幕语言加后缀）；
 * 4) 一次性批量 move（视频 + 全部元数据），失败回退逐个；
 * 5) 一次性批量 rename，同样回退；
 * 6) 写入 media_library 便于后续多版本比对；
 * 7) 返回 'placed' / 'skipped' / 'recycled'。
 */
async function placeVideo({ video, mediaInfo, id, targetCid, showCid, baseName, cfg, metas, mediaType, season, episode }) {
  const db = getDb();
  const ext = extOf(video.name);

  // 多版本判定
  const versionDecision = await resolveMultiVersion({
    mediaType: mediaType === 'anime' ? 'anime' : mediaType,
    tmdbId: id.tmdbId,
    season,
    episode,
    incoming: { id: video.id, size: video.size, info: mediaInfo, name: video.name },
    cfg,
  });
  if (versionDecision.action === 'recycleIncoming') {
    // 新文件落败：回收并记录
    try { await moveToRecycle(video.id); } catch (err) { logger.warn('Organizer', '回收新文件失败', err.message); }
    db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
      VALUES (?,?,?,?,?,?,?)`).run(video.name, video.id, video.size, versionDecision.winnerPath || '', versionDecision.winnerSize || 0, '', '多版本-体积/规格较低');
    return 'recycled';
  }
  if (versionDecision.action === 'recycleExisting') {
    // 旧版本落败：批量回收并清掉 media_library 中对应行
    const loserIds = versionDecision.losers.map(o => o.file_id).filter(Boolean);
    if (loserIds.length) {
      try { await moveToRecycleBatch(loserIds); }
      catch (err) { logger.warn('Organizer', '回收旧版本失败', err.message); }
    }
    for (const old of versionDecision.losers) {
      db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
        VALUES (?,?,?,?,?,?,?)`).run(old.file_path, old.file_id, old.file_size, video.name, video.size, '', '多版本-被新版本替换');
      db.prepare('DELETE FROM media_library WHERE id=?').run(old.id);
    }
  }

  // 同名冲突处理
  let placedName = baseName + '.' + ext;
  let multiSuffixN = 1;

  const targetExisting = await listFolder(targetCid, { onlyFolders: false }).catch(() => []);
  let conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);

  if (conflict) {
    if (cfg.conflict_mode === 2) {
      logger.info('Organizer', `同名跳过: ${placedName}`);
      return 'skipped';
    }
    if (cfg.multi_version) {
      // 用 v2/v3 后缀避开重名（每存在一个同名版本就递增）
      while (conflict) {
        multiSuffixN++;
        const suffix = buildMultiVersionSuffix(multiSuffixN);
        placedName = sanitizeName(baseName + suffix) + '.' + ext;
        conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);
      }
    } else {
      // 单版本模式：按 conflict_mode 决定保大(1)或保小(0)
      const winsBig = cfg.conflict_mode === 1;
      const incomingSize = video.size;
      const existingSize = conflict.size;
      const incomingWins = winsBig ? incomingSize > existingSize : incomingSize < existingSize;
      if (!incomingWins) {
        try { await moveToRecycle(video.id); } catch {}
        return 'recycled';
      }
      // 新文件胜出 → 回收旧文件
      try { await moveToRecycle(conflict.id); } catch (err) { logger.warn('Organizer', '回收同名文件失败', err.message); }
    }
  }

  // 预先计算元数据新名（要带字幕语言后缀）
  const metaPlan = metas.map(m => {
    const mExt = extOf(m.name);
    let metaName;
    if (cfg.rename_enabled) {
      const lang = detectLanguage(m.name);
      const langSuffix = buildSubtitleSuffix(lang);
      const metaStem = baseName + (lang ? langSuffix : '');
      metaName = sanitizeName(metaStem) + '.' + mExt;
    } else {
      metaName = m.name;
    }
    return { id: m.id, name: m.name, newName: metaName };
  });

  // 一次性批量移动（视频 + 所有元数据）
  const moveIds = [video.id, ...metaPlan.map(m => m.id)];
  try {
    await moveFiles(moveIds, targetCid);
  } catch (err) {
    // 整批失败回退逐个，避免单条坏 id 拖垮整组
    logger.warn('Organizer', `批量移动失败，回退逐个: ${err.message}`);
    try { await moveFile(video.id, targetCid); }
    catch (e) { logger.warn('Organizer', `视频移动失败: ${video.name}`, e.message); }
    for (const m of metaPlan) {
      try { await moveFile(m.id, targetCid); }
      catch (e) { logger.warn('Organizer', `元数据移动失败: ${m.name}`, e.message); }
    }
  }

  // 一次性批量重命名
  if (cfg.rename_enabled) {
    const renamePairs = [[video.id, placedName], ...metaPlan.map(m => [m.id, m.newName])];
    try {
      await renameFiles(renamePairs);
    } catch (err) {
      logger.warn('Organizer', `批量重命名失败，回退逐个: ${err.message}`);
      try { await renameFile(video.id, placedName); }
      catch (e) { logger.warn('Organizer', `视频重命名失败: ${video.name}`, e.message); }
      for (const m of metaPlan) {
        try { await renameFile(m.id, m.newName); }
        catch (e) { logger.warn('Organizer', `元数据重命名失败: ${m.name}`, e.message); }
      }
    }
  }

  // 写入 media_library 表（多版本比对依赖它）。
  // dolby 字段为冗余 boolean 简化查询：音频编码含 truehd/atmos/dolby 视为杜比。
  try {
    db.prepare(`INSERT OR REPLACE INTO media_library
      (media_type, tmdb_id, season, episode, target_cid, show_cid, file_id, file_path, file_size,
       resolution, source, video_codec, audio_codec, dolby)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        mediaType === 'anime' ? 'anime' : mediaType,
        id.tmdbId,
        season,
        episode,
        targetCid,
        showCid ?? targetCid,
        video.id,
        placedName,
        video.size,
        mediaInfo.resolution || null,
        mediaInfo.source || null,
        mediaInfo.videoCodec || null,
        mediaInfo.audioCodec || null,
        /truehd|atmos|dolby/i.test(mediaInfo.audioCodec || '') ? 1 : 0,
      );
  } catch (err) {
    logger.debug('Organizer', `media_library 写入失败: ${err.message}`);
  }

  const seLabel = (season != null && episode != null) ? ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : '';
  logger.info('Organizer', `已入库${seLabel}: ${placedName} → cid=${targetCid}`);
  return 'placed';
}

/**
 * 取或建子目录。优先用 cache 命中；命中后直接返回，未命中才走 createFolder 并同步入 cache。
 */
async function getOrCreateChildFolder(parentCid, name, cache = null) {
  const existing = await findFolderByName(parentCid, name, cache);
  if (existing) return existing;
  const created = await createFolder(parentCid, name);
  if (cache) cache.add(parentCid, name, created.cid);
  return created.cid;
}

/**
 * 通过 tmdbId 找已有的电影/剧目录。两阶段查找：
 * 1) media_library 命中（本系统整理过的文件）；
 * 2) 在分类目录下扫描子目录名包含 "tmdb-{tmdbId}" 的（兼容手工/其他工具按默认命名预先建好的目录）。
 *
 * 缓存命中：直接遍历 catNode.children，无任何 API 调用。
 */
async function findExistingShowCid(tmdbId, mediaType, catCid, cache = null) {
  // 阶段 1：本地 DB。动漫还兼查 tv 类型（动漫可能被早期版本标记为 tv）
  const db = getDb();
  const types = mediaType === 'anime' ? ['anime', 'tv'] : [mediaType];
  for (const t of types) {
    const row = db.prepare(
      `SELECT show_cid FROM media_library WHERE media_type=? AND tmdb_id=? AND show_cid IS NOT NULL LIMIT 1`
    ).get(t, tmdbId);
    if (row?.show_cid) {
      logger.debug('Organizer', `DB命中已有文件夹 tmdb=${tmdbId} cid=${row.show_cid}`);
      return row.show_cid;
    }
  }

  // 阶段 2：扫描分类目录，看是否已有 "tmdb-{tmdbId}" 标记的子目录
  const marker = `tmdb-${tmdbId}`;
  if (cache) {
    const catNode = cache.byId.get(String(catCid));
    if (catNode) {
      for (const [name, cid] of catNode.children) {
        if (name.includes(marker)) {
          logger.debug('Organizer', `缓存命中已有文件夹 tmdb=${tmdbId} name="${name}" cid=${cid}`);
          return cid;
        }
      }
      return null;
    }
  }
  try {
    const folders = await listFolder(catCid, { onlyFolders: true });
    const hit = folders.find(f => f.name.includes(marker));
    if (hit) {
      logger.debug('Organizer', `115扫描命中已有文件夹 tmdb=${tmdbId} name="${hit.name}" cid=${hit.id}`);
      return hit.id;
    }
  } catch (err) {
    logger.debug('Organizer', `115文件夹扫描失败 tmdb=${tmdbId}: ${err.message}`);
  }

  return null;
}

// ===== 多版本判定 =====

/**
 * 把分辨率串（如 "1080p"）转为可比较的数值（提取首段数字）。
 * 无法识别返回 0。
 */
function resolutionScore(r) {
  if (!r) return 0;
  const m = String(r).match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

/** Remux/BluRay 类高码率源头判定。 */
function isRemuxLike(info) {
  return /remux|bluray|blu-ray/i.test(info?.source || '');
}

/** 含 TrueHD/Atmos/Dolby 字样视为杜比音轨。 */
function hasDolby(info) {
  return /truehd|atmos|dolby/i.test(info?.audioCodec || '');
}

/**
 * 多版本决策器。
 * 在 media_library 中查找同 (mediaType, tmdbId, season, episode) 已有记录：
 * - conflict_mode=2（跳过模式）→ 不做多版本处理；
 * - cfg.multi_version=true（保留所有版本）→ 不做处理，依靠后续多版本后缀避免重名；
 * - 否则单版本模式：用 pickVersionWinner 逐个对比，决定回收新文件还是回收旧版本。
 *
 * 结果 action 取值：
 * - 'none'：无需处理
 * - 'recycleIncoming'：回收新文件（保留旧版本）
 * - 'recycleExisting'：回收旧版本列表（保留新文件）
 */
async function resolveMultiVersion({ mediaType, tmdbId, season, episode, incoming, cfg }) {
  if (cfg.conflict_mode === 2) return { action: 'none' };
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM media_library WHERE media_type=? AND tmdb_id=? AND season IS ? AND episode IS ?`
  ).all(mediaType, tmdbId, season, episode);

  if (!existing.length) return { action: 'none' };

  // 多版本保留所有：交由命名后缀解决
  if (cfg.multi_version) return { action: 'none' };

  // 单版本模式：保留最强版本
  const inc = incoming.info || {};
  const losers = [];
  let incomingWins = true;
  for (const ex of existing) {
    const exInfo = {
      source: ex.source,
      resolution: ex.resolution,
      videoCodec: ex.video_codec,
      audioCodec: ex.audio_codec,
    };
    const winner = pickVersionWinner(inc, exInfo, cfg, incoming.size, ex.file_size);
    if (winner === 'incoming') losers.push(ex);
    else if (winner === 'existing') incomingWins = false;
    // 'tie' 视为保留现状
    else incomingWins = false;
  }
  if (!incomingWins) {
    // 记录获胜的旧版本路径，方便日志展示
    const top = existing[0];
    return {
      action: 'recycleIncoming',
      winnerPath: top.file_path,
      winnerSize: top.file_size,
    };
  }
  if (losers.length) return { action: 'recycleExisting', losers };
  return { action: 'none' };
}

/**
 * 两个版本一一对比胜负，按优先级链：
 * 1) remux_priority：Remux/BluRay 优先；
 * 2) resolution_priority：分辨率高者胜；
 * 3) dolby_priority：含杜比音轨者胜；
 * 4) 体积兜底：按 conflict_mode（0=保小，1=保大）；
 * 5) 完全相同 → 'tie'。
 */
function pickVersionWinner(a, b, cfg, aSize, bSize) {
  if (cfg.remux_priority) {
    const ra = isRemuxLike(a), rb = isRemuxLike(b);
    if (ra !== rb) return ra ? 'incoming' : 'existing';
  }
  if (cfg.resolution_priority) {
    const ra = resolutionScore(a.resolution), rb = resolutionScore(b.resolution);
    if (ra !== rb) return ra > rb ? 'incoming' : 'existing';
  }
  if (cfg.dolby_priority) {
    const da = hasDolby(a), db_ = hasDolby(b);
    if (da !== db_) return da ? 'incoming' : 'existing';
  }
  if (aSize !== bSize) {
    if (cfg.conflict_mode === 1) return aSize > bSize ? 'incoming' : 'existing';
    return aSize < bSize ? 'incoming' : 'existing';
  }
  return 'tie';
}

// ===== ffprobe 辅助 =====

/**
 * 调用 ffprobe 抽取媒体技术规格。未启用或失败时返回空对象，不打断流程。
 */
async function extractMediaInfo(video, cfg) {
  if (!cfg.ffprobe_enabled) return {};
  try {
    return await getMediaInfo(video.id) || {};
  } catch (err) {
    logger.debug('Organizer', `ffprobe 跳过 ${video.name}: ${err.message}`);
    return {};
  }
}

/**
 * 将文件名解析结果与 ffprobe 结果合并：ffprobe 有值的字段覆盖文件名解析的同名字段。
 * 用于把权威技术规格写入命名变量。
 */
function mergeMediaInfo(parsed, probe) {
  const out = { ...parsed };
  for (const [k, v] of Object.entries(probe || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

// ===== task_items 写入 =====

/**
 * 把一条入库结果写入 task_items（运行日志/详情表）。
 * 容错地兜底所有字段，缺失字段以合理默认值代入，避免 NOT NULL 约束爆错。
 */
function recordTaskItem(taskId, row) {
  const db = getDb();
  db.prepare(`INSERT INTO task_items
    (task_id, media_type, source_path, target_path, original_name, new_name,
     tmdb_id, season, episode, episode_end, identify_source, overwritten, recycled,
     duration_ms, target_cid, file_id, file_size, error)
    VALUES (@task_id, @media_type, @source_path, @target_path, @original_name, @new_name,
            @tmdb_id, @season, @episode, @episode_end, @identify_source, @overwritten, @recycled,
            @duration_ms, @target_cid, @file_id, @file_size, @error)`).run({
      task_id: row.task_id ?? taskId,
      media_type: row.media_type ?? 'movie',
      source_path: row.source_path ?? '',
      target_path: row.target_path ?? '',
      original_name: row.original_name ?? '',
      new_name: row.new_name ?? '',
      tmdb_id: row.tmdb_id ?? null,
      season: row.season ?? null,
      episode: row.episode ?? null,
      episode_end: row.episode_end ?? null,
      identify_source: row.identify_source ?? '',
      overwritten: row.overwritten ?? 0,
      recycled: row.recycled ?? 0,
      duration_ms: row.duration_ms ?? null,
      target_cid: row.target_cid ?? null,
      file_id: row.file_id ?? null,
      file_size: row.file_size ?? null,
      error: row.error ?? '',
    });
}

// ===== 重新整理已有任务（4.12） =====

/**
 * 基于一个旧任务的 task_items，重新按当前 TMDB 信息与命名模板把文件移动/重命名到合适位置。
 *
 * 适用场景：
 * - 改了命名模板想全库刷新；
 * - 上次整理时 TMDB 元数据不完整，重新拉详情后重组目录结构；
 * - 二级/三级分类配置变化。
 *
 * 注意：不会重新走完整识别流程；mediaType 取自历史记录，仅刷新 TMDB 详情决定分类目录。
 */
export async function rerunInPlace(originalTaskId) {
  const db = getDb();
  const original = db.prepare('SELECT * FROM tasks WHERE id=?').get(originalTaskId);
  if (!original) throw new Error('原任务不存在');
  const items = db.prepare(`SELECT * FROM task_items
    WHERE task_id=? AND target_cid IS NOT NULL AND file_id IS NOT NULL`).all(originalTaskId);
  if (!items.length) throw new Error('原任务无可重跑的条目');

  const cfg = getConfig();
  await attachTargetCache(cfg);
  const newTask = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
  const newTaskId = newTask.lastInsertRowid;
  const cancel = getCancelToken(newTaskId);
  const stats = { scan: items.length, success: 0, fail: 0, skip: 0 };

  // 逐条重跑：在文件当前位置重新决定目标路径与命名
  try {
    for (const item of items) {
      if (cancel.cancelled) break;
      try {
        const id = {
          title: '', year: '', tmdbId: item.tmdb_id, mediaType: item.media_type,
          identifySource: 'rerun',
        };
        // 拉一次最新 TMDB 详情用于重新分类
        if (id.tmdbId) {
          id.tmdbDetails = id.mediaType === 'movie'
            ? await getMovieDetails(id.tmdbId)
            : await getTVDetails(id.tmdbId);
          if (id.tmdbDetails) {
            id.year = getYear(id.tmdbDetails);
            id.title = getTitle(id.tmdbDetails);
            // 仅允许 tv → anime；动画电影应继续按电影处理
            if (id.mediaType === 'tv' && isAnime(id.tmdbDetails)) id.mediaType = 'anime';
          }
        }
        if (!id.title || !id.year || !id.tmdbId) { stats.skip++; continue; }

        // 算新目标目录
        const cache = cfg._targetCache || null;
        const categoryPath = classifyTargetPath(id, cfg);
        const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);
        let targetFolderCid;
        if (id.mediaType === 'tv' || id.mediaType === 'anime') {
          const { showName, seasonName, episodeName } = generateTVNames(id, {}, item.season, item.episode, item.episode_end);
          const showCid = await getOrCreateChildFolder(catCid, showName, cache);
          targetFolderCid = await getOrCreateChildFolder(showCid, seasonName, cache);
          const newName = episodeName + '.' + extOf(item.new_name || item.original_name);
          if (item.target_cid !== targetFolderCid) await moveFile(item.file_id, targetFolderCid);
          if (cfg.rename_enabled) await renameFile(item.file_id, newName);
        } else {
          const { folderName, fileName } = generateMovieNames(id, {});
          targetFolderCid = await getOrCreateChildFolder(catCid, folderName, cache);
          const newName = fileName + '.' + extOf(item.new_name || item.original_name);
          if (item.target_cid !== targetFolderCid) await moveFile(item.file_id, targetFolderCid);
          if (cfg.rename_enabled) await renameFile(item.file_id, newName);
        }
        stats.success++;
        const delaySec = Number(cfg.operation_delay_sec) || 5;
        await sleep(delaySec * 1000);
      } catch (err) {
        logger.warn('Organizer', `重跑失败: ${item.original_name}`, err.message);
        stats.fail++;
      }
    }
    db.prepare(`UPDATE tasks SET status='completed', ended_at=datetime('now','localtime'),
      scan_count=?, success_count=?, fail_count=?, skip_count=? WHERE id=?`)
      .run(stats.scan, stats.success, stats.fail, stats.skip, newTaskId);
  } finally {
    cleanupCancelToken(newTaskId);
  }
  return { taskId: newTaskId, stats };
}

// ===== 手动解析未匹配条目（4.13） =====

/**
 * 用户在 Web 端手动指定 TMDB 元数据后，把对应未匹配条目下的文件按指定信息入库。
 *
 * @param {number} unmatchedId unmatched_items 主键
 * @param {Object} payload 用户提交的元数据 { title, year, tmdbId, mediaType, season?, episode?, episodeEnd? }
 */
export async function resolveUnmatched(unmatchedId, payload) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(unmatchedId);
  if (!item) throw new Error('条目不存在');
  const files = JSON.parse(item.file_ids || '[]');
  if (!files.length) throw new Error('条目缺少文件信息，无法继续');

  const cfg = getConfig();
  await attachTargetCache(cfg);
  const id = {
    title: payload.title || '',
    year: String(payload.year || ''),
    tmdbId: payload.tmdbId || null,
    mediaType: payload.mediaType || 'movie',
    identifySource: 'manual',
  };
  // 用户提供了 tmdbId 时，从 TMDB 拉详情补齐 title/year，并按 Genre 判定动漫
  if (id.tmdbId) {
    id.tmdbDetails = id.mediaType === 'movie'
      ? await getMovieDetails(id.tmdbId)
      : await getTVDetails(id.tmdbId);
    if (id.tmdbDetails) {
      if (!id.title) id.title = getTitle(id.tmdbDetails);
      if (!id.year) id.year = getYear(id.tmdbDetails);
      // 仅允许 tv → anime；动画电影应继续按电影处理
      if (id.mediaType === 'tv' && isAnime(id.tmdbDetails)) id.mediaType = 'anime';
    }
  }
  if (!id.title || !id.year || !id.tmdbId) throw new Error('必填字段缺失 (title/year/tmdbId)');

  // 把存档的 file_ids 还原成组结构（与 runOrganize 中分组后的 group 同形）
  const videos = files.filter(f => f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isVideo: true }));
  const metas = files.filter(f => !f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isMeta: true }));
  if (!videos.length) throw new Error('该条目下没有视频文件');

  const group = { kind: 'manual', parentCid: item.parent_cid, folderName: item.source_name, videos, metas };

  // 包一个独立 task 行用于记录这次手动处理
  const taskRow = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
  const taskId = taskRow.lastInsertRowid;
  const stats = { scan: videos.length, success: 0, fail: 0, skip: 0 };
  const episodeSummary = new Map();
  const cancel = getCancelToken(taskId);

  try {
    if (id.mediaType === 'tv' || id.mediaType === 'anime') {
      // 剧集允许用户传入 season/episode 覆盖单文件解析失败的情况
      const overrides = { season: payload.season, episode: payload.episode, episodeEnd: payload.episodeEnd };
      await processTVManual(group, id, cfg, taskId, stats, cancel, overrides, episodeSummary);
    } else {
      await processMovieGroup(group, id, cfg, taskId, stats);
    }
    db.prepare(`UPDATE tasks SET status='completed', ended_at=datetime('now','localtime'),
      scan_count=?, success_count=?, fail_count=?, skip_count=? WHERE id=?`)
      .run(stats.scan, stats.success, stats.fail, stats.skip, taskId);
    db.prepare("UPDATE unmatched_items SET status='resolved', updated_at=datetime('now','localtime') WHERE id=?").run(unmatchedId);
  } finally {
    cleanupCancelToken(taskId);
  }
  return { taskId, stats };
}

/**
 * processTVGroup 的手动版：允许 overrides.season/episode 在解析失败时兜底。
 * 其余逻辑（季缓存、命名生成、placeVideo、通知）与 processTVGroup 一致。
 */
async function processTVManual(group, id, cfg, taskId, stats, cancel, overrides, episodeSummary) {
  const episodes = [];
  for (const v of group.videos) {
    if (cancel.cancelled) break;
    const parsed = parseFilename(v.name);
    const season = parsed.season != null
      ? parsed.season
      : (overrides.season != null ? Number(overrides.season) : null);
    const episode = parsed.episode != null
      ? parsed.episode
      : (overrides.episode != null ? Number(overrides.episode) : null);
    if (season == null || episode == null) {
      await pushUnmatched({ ...group, videos: [v], metas: [] }, { ...id, season, episode }, '剧集缺少 S/E (手动解析)');
      stats.skip++;
      continue;
    }
    const probe = await extractMediaInfo(v, cfg);
    const mediaInfo = mergeMediaInfo(parsed, probe);
    episodes.push({
      video: v,
      mediaInfo,
      season,
      episode,
      episodeEnd: parsed.episodeEnd ?? (overrides.episodeEnd != null ? Number(overrides.episodeEnd) : null),
      parsed,
    });
  }
  if (!episodes.length) return;

  const cache = cfg._targetCache || null;
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);
  const { showName } = generateTVNames(id, episodes[0].mediaInfo, episodes[0].season, episodes[0].episode);
  const showCid = (await findExistingShowCid(id.tmdbId, id.mediaType, catCid, cache))
    ?? await getOrCreateChildFolder(catCid, showName, cache);
  const seasonsCache = new Map();

  for (const ep of episodes) {
    if (cancel.cancelled) break;
    let seasonCid = seasonsCache.get(ep.season);
    if (!seasonCid) {
      const { seasonName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);
      seasonCid = await getOrCreateChildFolder(showCid, seasonName, cache);
      seasonsCache.set(ep.season, seasonCid);
    }
    const { episodeName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);
    const epMetas = matchMetasToEpisode(ep, group.metas);
    const result = await placeVideo({
      video: ep.video,
      mediaInfo: ep.mediaInfo,
      id,
      targetCid: seasonCid,
      showCid,
      baseName: episodeName,
      cfg,
      metas: epMetas,
      mediaType: id.mediaType,
      season: ep.season,
      episode: ep.episode,
    });
    recordTaskItem(taskId, {
      task_id: taskId,
      media_type: id.mediaType,
      source_path: group.parentCid,
      target_path: categoryPath.join('/') + '/' + showName,
      target_cid: seasonCid,
      original_name: ep.video.name,
      new_name: result === 'placed' ? episodeName + '.' + extOf(ep.video.name) : '',
      tmdb_id: id.tmdbId,
      season: ep.season,
      episode: ep.episode,
      episode_end: ep.episodeEnd,
      identify_source: 'manual',
      file_id: ep.video.id,
      file_size: ep.video.size,
      recycled: result === 'recycled' ? 1 : 0,
    });
    if (result === 'placed') stats.success++;
    else if (result === 'skipped' || result === 'recycled') stats.skip++;
  }

  if (cfg.notify_enabled) {
    const summary = {
      title: id.title,
      year: id.year,
      tmdbId: id.tmdbId,
      mediaType: id.mediaType,
      target_path: categoryPath.join('/') + '/' + showName,
      items: episodes.map(e => ({ season: e.season, episode: e.episode, episodeEnd: e.episodeEnd })),
    };
    if (cfg.episode_per_notify) {
      for (const it of summary.items) {
        await notifySuccess({ ...summary, season: it.season, episode: it.episode }).catch(() => {});
      }
    } else if (summary.items.length) {
      await notifyEpisodes(summary).catch(() => {});
    }
  }
}

// ===== 清理空目录 =====

/**
 * 清理空目录的入口。优先快速路径，失败回退慢速路径。
 *
 * 判定一个文件是否"算数"（阻止目录被删）：
 *   - 必须是媒体扩展名（视频或元数据），否则视为垃圾（如 .DS_Store/Thumbs.db）
 *   - 若是视频，size 必须 ≥ min_video_size_mb（小于阈值的视频与 filterFiles 一致，视作可丢弃）
 *
 * 快/慢两条路径共用上述谓词，行为一致：
 *   - 子树内没有任何"算数"的文件 → 整枝删除
 */
async function cleanupEmptyFolders(rootCid) {
  const cfg = getConfig();
  const videoExts = new Set(parseExts(cfg?.video_extensions, VIDEO_EXTS_DEFAULT));
  const metaExts = new Set(parseExts(cfg?.meta_extensions, META_EXTS_DEFAULT));
  const minSize = (Number(cfg?.min_video_size_mb) || 0) * 1024 * 1024;

  /** @returns true 表示该文件应阻止其所在目录被清理 */
  const keepsFolder = (name, size) => {
    const e = extOf(name);
    if (videoExts.has(e)) return !(minSize > 0 && Number(size || 0) < minSize);
    return metaExts.has(e);
  };

  try {
    await cleanupEmptyFoldersFast(rootCid, keepsFolder);
    return;
  } catch (err) {
    logger.warn('Organizer', `快速清理空目录失败，回退到逐目录递归: ${err.message}`);
  }
  await cleanupEmptyFoldersSlow(rootCid, keepsFolder);
}

/**
 * 快速清理：通过 downfolders + downfiles 两次 API 拿到子树骨架与文件父目录映射，
 * 在内存里 rollup 每个目录的 keepCount，找出子树内无任何"算数文件"的顶层分支批量删除。
 *
 * 设计要点：
 * - keepsFolder 谓词与慢速路径一致：非媒体垃圾、过小视频都不算数；
 * - 只删"顶层空分支"，不重复删除其嵌套子目录（115 删除会级联，ignore_warn=1）。
 */
async function cleanupEmptyFoldersFast(rootCid, keepsFolder) {
  const rootStr = String(rootCid);
  const info = await getFolderInfo(rootStr);
  const pickcode = info?.pick_code || info?.pickcode || info?.data?.pick_code;
  if (!pickcode) throw new Error('未取得根目录 pickcode');

  const [folders, files] = await Promise.all([
    listAllSubFolders(pickcode),
    listAllSubFiles(pickcode),
  ]);

  // 构建 cid → 节点
  const nodeById = new Map();
  nodeById.set(rootStr, { name: `根目录#${rootStr}`, parentId: null, children: [], keepCount: 0, subtreeKeep: 0 });
  for (const f of folders) {
    const id = String(f.fid || f.cid || f.id || '');
    if (!id) continue;
    const name = String(f.fn || f.n || f.name || '');
    const pid = String(f.pid || f.parent_id || rootStr);
    nodeById.set(id, { name, parentId: pid, children: [], keepCount: 0, subtreeKeep: 0 });
  }
  // 反向把每个节点登记到父节点的 children 数组
  for (const [id, node] of nodeById) {
    if (id === rootStr) continue;
    const parent = nodeById.get(node.parentId);
    if (parent) parent.children.push(id);
  }
  // 仅累计"算数"的文件：媒体扩展名 + 视频需达到 min_video_size_mb
  let droppedJunk = 0;
  for (const f of files) {
    const pid = String(f.pid || f.parent_id || '');
    const node = nodeById.get(pid);
    if (!node) continue;
    const fname = String(f.fn || f.n || f.name || f.file_name || '');
    const fsize = Number(f.fs || f.s || f.size || f.file_size || 0);
    if (keepsFolder(fname, fsize)) node.keepCount++;
    else droppedJunk++;
  }
  /** 递归汇总子树"算数文件"总数到 subtreeKeep。 */
  function rollup(id) {
    const node = nodeById.get(id);
    if (!node) return 0;
    let n = node.keepCount;
    for (const c of node.children) n += rollup(c);
    node.subtreeKeep = n;
    return n;
  }
  rollup(rootStr);

  // 收集"顶层空分支"：自己空且父非空，避免重复删嵌套节点
  const emptyBranches = [];
  function visit(id, parentIsEmpty) {
    const node = nodeById.get(id);
    if (!node) return;
    const isEmpty = node.subtreeKeep === 0;
    if (id !== rootStr && isEmpty && !parentIsEmpty) {
      emptyBranches.push({ id, parentId: node.parentId, name: node.name });
    }
    for (const c of node.children) visit(c, isEmpty || parentIsEmpty);
  }
  // 根目录永不删除，故其"空"状态不应向下传播；对每个直接子节点单独入口。
  for (const c of nodeById.get(rootStr).children) visit(c, false);

  logger.info('Organizer', `[fast-cleanup] 树规模: ${nodeById.size - 1} 目录 / ${files.length} 文件 (忽略垃圾/过小视频 ${droppedJunk}); 待删空分支: ${emptyBranches.length}`);

  for (const b of emptyBranches) {
    logger.info('Organizer', `删除空文件夹分支: ${b.name} cid=${b.id}`);
    try {
      await deleteFolder(b.id, b.parentId);
    } catch (err) {
      logger.warn('Organizer', `删除失败: ${b.name} cid=${b.id} - ${err.message}`);
    }
  }
}

/**
 * 慢速清理：递归遍历，子树内没有任何"算数文件"就把整个目录回收。
 * "算数文件"由 keepsFolder 判定：必须是媒体扩展名；视频还要 ≥ min_video_size_mb。
 * 返回值 hasKeep 用于回溯告诉父节点"我这枝有不可丢弃的文件"。
 */
async function cleanupEmptyFoldersSlow(rootCid, keepsFolder) {
  async function walk(cid, parentCid, name) {
    let items;
    try {
      items = await listFolder(cid);
    } catch (err) {
      logger.warn('Organizer', `空文件夹清理：列目录失败 ${name || ''} cid=${cid}`, err.message);
      return true;
    }
    let hasKeep = false;
    for (const it of items) {
      if (it.isFolder) {
        const subHasKeep = await walk(it.id, cid, it.name);
        if (subHasKeep) hasKeep = true;
      } else if (keepsFolder(it.name, it.size)) {
        hasKeep = true;
      }
    }
    if (parentCid != null && !hasKeep) {
      logger.info('Organizer', `删除无有效媒体的子文件夹: ${name} cid=${cid}`);
      try {
        await deleteFolder(cid, parentCid);
      } catch (err) {
        logger.warn('Organizer', `删除空文件夹失败: ${name} cid=${cid}`, err.message);
      }
    }
    return hasKeep;
  }
  await walk(String(rootCid), null, `根目录#${rootCid}`);
}
