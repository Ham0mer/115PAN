import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { listFilesRecursive, ensureFolderPath, moveFile, renameFile } from '../115.js';
import { parseFilename } from '../parser.js';
import { getMovieDetails, getTVDetails, isAnime, getYear, getTitle } from '../tmdb.js';
import { generateMovieNames, generateTVNames } from '../template.js';
import { notifyFailure, notifyEpisodes, notifySuccess } from '../telegram.js';
import {
  extOf, sleep, getConfig, attachTargetCache,
  getCancelToken, cleanupCancelToken, groupLabel, classifyTargetPath,
} from './util.js';
import { filterFiles, groupFiles, matchMetasToEpisode } from './group.js';
import { processGroup, processMovieGroup } from './process.js';
import { extractMediaInfo, mergeMediaInfo } from './mediainfo.js';
import { placeVideo, getOrCreateChildFolder, findExistingShowCid } from './place.js';
import { pushUnmatched, recordTaskItem } from './tasks.js';
import { cleanupEmptyFolders } from './cleanup.js';

/**
 * 整理任务主入口。
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
 */
export async function runOrganize(taskId, options = {}) {
  const db = getDb();
  const cfg = getConfig();
  if (!cfg) throw new Error('整理配置未设置');
  if (!cfg.source_cid || !cfg.target_cid) throw new Error('未配置源/目标目录');

  if (!taskId) {
    const r = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
    taskId = r.lastInsertRowid;
  } else {
    db.prepare("UPDATE tasks SET status='running', started_at=datetime('now','localtime') WHERE id=?").run(taskId);
  }
  const cancel = getCancelToken(taskId);
  const stats = { scan: 0, success: 0, fail: 0, skip: 0 };
  const episodeSummary = new Map();

  try {
    logger.info('Organizer', `开始扫描 cid=${cfg.source_cid}`);
    await attachTargetCache(cfg);
    const files = await listFilesRecursive(cfg.source_cid, { maxDepth: 8 });
    stats.scan = files.length;
    logger.info('Organizer', `扫描完成: ${files.length} 个文件`);

    if (!files.length) {
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
        await notifyFailure(`处理失败: ${groupLabel(group)}`, err.message).catch(() => {});
      }
      const delaySec = Number(cfg.operation_delay_sec) || 5;
      await sleep(delaySec * 1000);
    }

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

/**
 * 基于一个旧任务的 task_items，重新按当前 TMDB 信息与命名模板把文件移动/重命名到合适位置。
 * 适用场景：改了命名模板、TMDB 元数据补全、二级/三级分类配置变化。
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

  try {
    for (const item of items) {
      if (cancel.cancelled) break;
      try {
        const id = {
          title: '', year: '', tmdbId: item.tmdb_id, mediaType: item.media_type,
          identifySource: 'rerun',
        };
        if (id.tmdbId) {
          id.tmdbDetails = id.mediaType === 'movie'
            ? await getMovieDetails(id.tmdbId)
            : await getTVDetails(id.tmdbId);
          if (id.tmdbDetails) {
            id.year = getYear(id.tmdbDetails);
            id.title = getTitle(id.tmdbDetails);
            if (id.mediaType === 'tv' && isAnime(id.tmdbDetails)) id.mediaType = 'anime';
          }
        }
        if (!id.title || !id.year || !id.tmdbId) { stats.skip++; continue; }

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

/**
 * 用户在 Web 端手动指定 TMDB 元数据后，把对应未匹配条目下的文件按指定信息入库。
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
  if (id.tmdbId) {
    id.tmdbDetails = id.mediaType === 'movie'
      ? await getMovieDetails(id.tmdbId)
      : await getTVDetails(id.tmdbId);
    if (id.tmdbDetails) {
      if (!id.title) id.title = getTitle(id.tmdbDetails);
      if (!id.year) id.year = getYear(id.tmdbDetails);
      if (id.mediaType === 'tv' && isAnime(id.tmdbDetails)) id.mediaType = 'anime';
    }
  }
  if (!id.title || !id.year || !id.tmdbId) throw new Error('必填字段缺失 (title/year/tmdbId)');

  const videos = files.filter(f => f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isVideo: true }));
  const metas = files.filter(f => !f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isMeta: true }));
  if (!videos.length) throw new Error('该条目下没有视频文件');

  const group = { kind: 'manual', parentCid: item.parent_cid, folderName: item.source_name, videos, metas };

  const taskRow = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
  const taskId = taskRow.lastInsertRowid;
  const stats = { scan: videos.length, success: 0, fail: 0, skip: 0 };
  const episodeSummary = new Map();
  const cancel = getCancelToken(taskId);

  try {
    if (id.mediaType === 'tv' || id.mediaType === 'anime') {
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
