import { ensureFolderPath } from '../115.js';
import { parseFilename } from '../parser.js';
import { generateMovieNames, generateTVNames } from '../template.js';
import { notifySuccess } from '../telegram.js';
import { extOf, classifyTargetPath } from './util.js';
import { matchMetasToEpisode } from './group.js';
import { identifyGroup, resolveViaTmdb } from './identify.js';
import { extractMediaInfo, mergeMediaInfo } from './mediainfo.js';
import { placeVideo, getOrCreateChildFolder, findExistingShowCid } from './place.js';
import { pushUnmatched, recordTaskItem } from './tasks.js';

/**
 * 单个媒体单元的处理入口：识别 → 校验 → 分流到 movie/TV 流程。
 * 校验策略：仅 title 是硬性必填；缺 year/tmdbId 时再以空年份做一次 TMDB 搜索补齐。
 */
export async function processGroup(group, cfg, taskId, stats, cancel, episodeSummary) {
  const id = await identifyGroup(group, cfg);

  if (!id.title) {
    await pushUnmatched(group, id, '缺少必要字段 (title)');
    stats.skip++;
    return;
  }
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
    await processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary);
  } else {
    await processMovieGroup(group, id, cfg, taskId, stats);
  }
}

/**
 * 处理"识别为电影"的组。
 */
export async function processMovieGroup(group, id, cfg, taskId, stats) {
  if (!id.tmdbId) {
    await pushUnmatched(group, id, '缺少 tmdbId');
    stats.skip++;
    return;
  }

  const cache = cfg._targetCache || null;
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);

  const videoUnits = [];
  for (const v of group.videos) {
    const parsed = parseFilename(v.name);
    const probe = await extractMediaInfo(v, cfg);
    const mediaInfo = mergeMediaInfo(parsed, probe);
    const { folderName, fileName } = generateMovieNames(id, mediaInfo);
    videoUnits.push({ video: v, mediaInfo, folderName, fileName });
  }

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

/**
 * 处理"识别为剧集/动漫"的组。每个视频独立解析 S/E；按季缓存 seasonCid。
 */
export async function processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary) {
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

  if (!id.tmdbId) {
    for (const ep of episodes) {
      await pushUnmatched({ ...group, videos: [ep.video], metas: [] },
        { ...id, season: ep.season, episode: ep.episode }, '缺少 tmdbId');
      stats.skip++;
    }
    return;
  }

  const cache = cfg._targetCache || null;
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath, cache);
  const showSampleNames = generateTVNames(id, episodes[0].mediaInfo, episodes[0].season, episodes[0].episode);
  const showFolderName = showSampleNames.showName;
  const showCid = (await findExistingShowCid(id.tmdbId, id.mediaType, catCid, cache))
    ?? await getOrCreateChildFolder(catCid, showFolderName, cache);

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
