import { getDb } from './db.js';
import { logger } from './logger.js';
import {
  listFilesRecursive, renameFile, moveFile, createFolder, ensureFolderPath,
  moveToRecycle, listFolder, findFolderByName, deleteFolder,
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

const VIDEO_EXTS_DEFAULT = 'mp4,mkv,avi,mov,rmvb,wmv,ts,iso,m2ts';
const META_EXTS_DEFAULT = 'ass,srt,ssa,sub,vtt,nfo,xml';

function getConfig() {
  return getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
}

function parseExts(csv, fallback) {
  return (csv || fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function extOf(name) {
  const m = String(name || '').match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function stemOf(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ----- Cancellation -----

const cancelTokens = new Map();
function getCancelToken(taskId) {
  if (!cancelTokens.has(taskId)) cancelTokens.set(taskId, { cancelled: false });
  return cancelTokens.get(taskId);
}
export function requestCancel(taskId) {
  const t = cancelTokens.get(taskId);
  if (t) t.cancelled = true;
}
function cleanupCancelToken(taskId) {
  cancelTokens.delete(taskId);
}

// ----- Entry point -----

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
  const episodeSummary = new Map(); // tmdbId -> { title, items: [{season, episode, target}] }

  try {
    logger.info('Organizer', `开始扫描 cid=${cfg.source_cid}`);
    const files = await listFilesRecursive(cfg.source_cid, { maxDepth: 8 });
    stats.scan = files.length;
    logger.info('Organizer', `扫描完成: ${files.length} 个文件`);

    if (!files.length) {
      logger.info('Organizer', `源目录无文件，仅清理残留空目录 cid=${cfg.source_cid}`);
      await cleanupEmptyFolders(cfg.source_cid);
      db.prepare(`UPDATE tasks SET status='completed', ended_at=datetime('now','localtime'),
        scan_count=0, success_count=0, fail_count=0, skip_count=0 WHERE id=?`).run(taskId);
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
      const delaySec = Number(cfg.operation_delay_sec) || 1.5;
      await sleep(delaySec * 1000);
    }

    // Clean up empty subfolders after processing
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

  // Aggregated TV episode notifications (one per show per task).
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

// ----- Filtering & grouping -----

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

// Group filtered files into media units.
// - Files inside a subfolder share that folder's group (forms A / C).
// - Files directly in the root are sub-grouped by parsed (title, year) (forms B / D).
// - Nested directories (form E): items inherit their direct-parent CID as the group, but identification
//   later pulls metadata from the file itself, so nesting depth is irrelevant.
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
      logger.debug('Organizer', `跳过孤立元数据组 parent=${parentCid}`);
      continue;
    }
    const folderName = parentFiles[0].pathSegs[parentFiles[0].pathSegs.length - 1] || '';
    groups.push({ kind: 'folder', parentCid, folderName, videos, metas });
  }

  // Subgroup root-level files by parsed (title, year)
  for (const subgroup of subgroupRootFiles(rootFiles, cfg)) {
    groups.push({ kind: 'root', parentCid: cfg.source_cid, folderName: '', ...subgroup });
  }

  return groups.filter(g => g.videos.length > 0);
}

function subgroupRootFiles(files, cfg) {
  const videos = files.filter(f => f._isVideo);
  const metas = files.filter(f => f._isMeta);
  if (!videos.length) return [];

  // Parse each video; group by (title|year). When parse fails, fall back to per-file group.
  const buckets = new Map();
  for (const v of videos) {
    const p = parseFilename(v.name);
    const key = `${(p.title || '').toLowerCase()}|${p.year || ''}`;
    if (!buckets.has(key)) buckets.set(key, { parsed: p, videos: [], metas: [] });
    buckets.get(key).videos.push(v);
  }

  // Attach metas by stem-prefix match against any video in a bucket
  for (const m of metas) {
    const stem = stemOf(m.name).toLowerCase();
    let hit = null;
    for (const [, b] of buckets) {
      if (b.videos.some(v => {
        const vs = stemOf(v.name).toLowerCase();
        return stem.startsWith(vs) || vs.startsWith(stem);
      })) { hit = b; break; }
    }
    // Fallback: attach to the first bucket if we couldn't match (best-effort).
    if (!hit && buckets.size === 1) hit = [...buckets.values()][0];
    if (hit) hit.metas.push(m);
  }

  return [...buckets.values()];
}

function groupLabel(g) {
  return g.folderName || g.videos[0]?.name || `parent=${g.parentCid}`;
}

// ----- Identification -----

async function identifyGroup(group, cfg) {
  // Pool of filenames to parse: include all ancestor directory names + video filenames.
  // The topmost ancestor (e.g. "庆余年.S01.全集") usually has the cleanest title.
  const ancestorNames = new Set();
  for (const v of group.videos) {
    if (Array.isArray(v.pathSegs)) {
      for (const seg of v.pathSegs) if (seg) ancestorNames.add(seg);
    }
  }
  if (group.folderName) ancestorNames.add(group.folderName);
  const names = [...ancestorNames, ...group.videos.map(v => v.name)].filter(Boolean);
  const parsedAll = names.map(n => parseFilename(n));

  // Merge: pick title/year from the most-informative entry, but keep per-file S/E.
  const merged = pickBestParsed(parsedAll, group);

  // Structural hint for media type
  const videoExts = new Set(parseExts(cfg.video_extensions, VIDEO_EXTS_DEFAULT));
  const struct = detectMediaTypeFromStructure(group.videos.map(v => v.name), group.folderName, videoExts);
  if (struct === 'tv') merged.mediaType = 'tv';

  // 4.6.2: TMDB search if we lack tmdbId
  if (!merged.tmdbId && merged.title) {
    const tmdb = await resolveViaTmdb(merged);
    if (tmdb) Object.assign(merged, tmdb);
  }

  // 4.6.3: AI fallback when TMDB still empty
  if (!merged.tmdbId && cfg.ai_enabled) {
    try {
      const seed = group.folderName || group.videos[0]?.name;
      const ai = await aiIdentify(seed);
      if (ai) {
        if (ai.title && !merged.title) merged.title = ai.title;
        if (ai.year && !merged.year) merged.year = String(ai.year);
        if (ai.tmdbId && !merged.tmdbId) merged.tmdbId = ai.tmdbId;
        if (ai.season != null && merged.season == null) merged.season = Number(ai.season);
        if (ai.episode != null && merged.episode == null) merged.episode = Number(ai.episode);
        if (ai.mediaType && !merged.mediaType) merged.mediaType = ai.mediaType;
        merged.identifySource = 'ai';
        if (ai.tmdbId) {
          const t = await resolveViaTmdb(merged);
          if (t) Object.assign(merged, t);
        }
      }
    } catch (err) {
      logger.warn('Organizer', 'AI识别失败', err.message);
    }
  }

  // Make sure we have details for region classification + anime check.
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
    if (isAnime(merged.tmdbDetails)) merged.mediaType = 'anime';
    const dy = getYear(merged.tmdbDetails);
    if (dy) merged.year = dy;
    const dt = getTitle(merged.tmdbDetails);
    if (dt) merged.title = dt;
  }

  if (!merged.mediaType) merged.mediaType = 'movie';
  return merged;
}

function pickBestParsed(parsedAll, group) {
  // Score by presence of title + year; tie-break by S/E presence.
  const scored = parsedAll.map(p => ({
    p,
    score: (p.title ? 2 : 0) + (p.year ? 2 : 0) + (p.season != null ? 1 : 0) + (p.episode != null ? 1 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.p || parsedAll[0] || {};
  // For TV-ish groups, we keep season from whichever video had it.
  const seasonFromAny = parsedAll.find(p => p.season != null)?.season ?? null;
  // Pick up an explicit TMDB id from whichever parsed name carried it (e.g. "... [tmdb-575219]").
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

async function resolveViaTmdb(info) {
  // Try the type the parser suggested first; fall back to multi.
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
      // Pick best: prefer year match
      const best = pickBestTmdb(results, info);
      if (!best) continue;
      const detail = best.media_type === 'movie'
        ? await getMovieDetails(best.id)
        : await getTVDetails(best.id);
      const mediaType = isAnime(detail || best) ? 'anime' : best.media_type;
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

function pickBestTmdb(results, info) {
  const wantedYear = info.year ? String(info.year) : '';
  // Score: year exact (3), title contains (2), popularity tiebreak.
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

// ----- Process a single group -----

async function processGroup(group, cfg, taskId, stats, cancel, episodeSummary) {
  const id = await identifyGroup(group, cfg);

  // Push to unmatched if required fields missing
  const baseRequired = id.title && id.year && id.tmdbId;
  if (!baseRequired) {
    await pushUnmatched(group, id, '缺少必要字段 (title/year/tmdbId)');
    stats.skip++;
    return;
  }

  if (id.mediaType === 'tv' || id.mediaType === 'anime') {
    // For TV: missing season/episode is OK at group level, but each video must have S+E.
    await processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary);
  } else {
    await processMovieGroup(group, id, cfg, taskId, stats);
  }
}

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

// ----- Movie -----

async function processMovieGroup(group, id, cfg, taskId, stats) {
  // For each video in the group, decide multi-version vs single. Metas tag along by stem-prefix.
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath);

  // For each video: extract per-file media info, build name
  const videoUnits = [];
  for (const v of group.videos) {
    const parsed = parseFilename(v.name);
    const probe = await extractMediaInfo(v, cfg);
    const mediaInfo = mergeMediaInfo(parsed, probe);
    const { folderName, fileName } = generateMovieNames(id, mediaInfo);
    videoUnits.push({ video: v, mediaInfo, folderName, fileName });
  }

  // Multi-version: dedupe by tmdb_id across videos AND existing library
  const winningFileName = videoUnits[0].folderName;
  const movieType = id.mediaType === 'anime' ? 'anime' : 'movie';
  const movieFolderCid = (await findExistingShowCid(id.tmdbId, movieType, catCid))
    ?? await getOrCreateChildFolder(catCid, winningFileName);

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

// ----- TV / anime -----

async function processTVGroup(group, id, cfg, taskId, stats, cancel, episodeSummary) {
  // Build per-episode work items: each video gets its own S/E.
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

  // Compute target paths once for the show
  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath);
  const showSampleNames = generateTVNames(id, episodes[0].mediaInfo, episodes[0].season, episodes[0].episode);
  const showFolderName = showSampleNames.showName;
  const showCid = (await findExistingShowCid(id.tmdbId, id.mediaType, catCid))
    ?? await getOrCreateChildFolder(catCid, showFolderName);

  const seasonsCache = new Map();
  const summaryItems = [];

  for (const ep of episodes) {
    if (cancel.cancelled) break;
    let seasonCid = seasonsCache.get(ep.season);
    if (!seasonCid) {
      const { seasonName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);
      seasonCid = await getOrCreateChildFolder(showCid, seasonName);
      seasonsCache.set(ep.season, seasonCid);
    }
    const { episodeName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);

    // Find metas that match this episode (by S/E or by stem prefix)
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

function matchMetasToEpisode(ep, allMetas) {
  return allMetas.filter(m => {
    const parsed = parseFilename(m.name);
    if (parsed.season != null && parsed.episode != null) {
      return parsed.season === ep.season && parsed.episode === ep.episode;
    }
    // Fallback: stem prefix
    const vs = stemOf(ep.video.name);
    const ms = stemOf(m.name);
    return ms.startsWith(vs) || vs.startsWith(ms);
  });
}

// ----- Common: place one video + its metas into target, with conflict / multi-version handling -----

async function placeVideo({ video, mediaInfo, id, targetCid, showCid, baseName, cfg, metas, mediaType, season, episode }) {
  const db = getDb();
  const ext = extOf(video.name);

  // Multi-version comparison against existing library entries.
  const versionDecision = await resolveMultiVersion({
    mediaType: mediaType === 'anime' ? 'anime' : mediaType,
    tmdbId: id.tmdbId,
    season,
    episode,
    incoming: { id: video.id, size: video.size, info: mediaInfo, name: video.name },
    cfg,
  });
  if (versionDecision.action === 'recycleIncoming') {
    try { await moveToRecycle(video.id); } catch (err) { logger.warn('Organizer', '回收新文件失败', err.message); }
    db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
      VALUES (?,?,?,?,?,?,?)`).run(video.name, video.id, video.size, versionDecision.winnerPath || '', versionDecision.winnerSize || 0, '', '多版本-体积/规格较低');
    return 'recycled';
  }
  if (versionDecision.action === 'recycleExisting') {
    for (const old of versionDecision.losers) {
      try { if (old.file_id) await moveToRecycle(old.file_id); } catch (err) { logger.warn('Organizer', '回收旧版本失败', err.message); }
      db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
        VALUES (?,?,?,?,?,?,?)`).run(old.file_path, old.file_id, old.file_size, video.name, video.size, '', '多版本-被新版本替换');
      db.prepare('DELETE FROM media_library WHERE id=?').run(old.id);
    }
  }

  // True same-name conflict resolution (conflict_mode)
  let placedName = baseName + '.' + ext;
  let multiSuffixN = 1;

  // Check for an existing same-named file inside the target folder.
  const targetExisting = await listFolder(targetCid, { onlyFolders: false }).catch(() => []);
  let conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);

  if (conflict) {
    if (cfg.conflict_mode === 2) {
      logger.info('Organizer', `同名跳过: ${placedName}`);
      return 'skipped';
    }
    if (cfg.multi_version) {
      // Differentiate via multi-version suffix
      while (conflict) {
        multiSuffixN++;
        const suffix = buildMultiVersionSuffix(multiSuffixN);
        placedName = sanitizeName(baseName + suffix) + '.' + ext;
        conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);
      }
    } else {
      // Compare sizes per cfg.conflict_mode (0 small-wins, 1 big-wins)
      const winsBig = cfg.conflict_mode === 1;
      const incomingSize = video.size;
      const existingSize = conflict.size;
      const incomingWins = winsBig ? incomingSize > existingSize : incomingSize < existingSize;
      if (!incomingWins) {
        try { await moveToRecycle(video.id); } catch {}
        return 'recycled';
      }
      // Incoming wins: recycle the existing
      try { await moveToRecycle(conflict.id); } catch (err) { logger.warn('Organizer', '回收同名文件失败', err.message); }
    }
  }

  // Move and rename the video
  await moveFile(video.id, targetCid);
  if (cfg.rename_enabled) await renameFile(video.id, placedName);

  // Place metas: rename each to share baseName + lang suffix, preserving extension
  for (const m of metas) {
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
    try {
      await moveFile(m.id, targetCid);
      if (cfg.rename_enabled) await renameFile(m.id, metaName);
    } catch (err) {
      logger.warn('Organizer', `元数据移动失败: ${m.name}`, err.message);
    }
  }

  // Record into media_library
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

  return 'placed';
}

async function getOrCreateChildFolder(parentCid, name) {
  const existing = await findFolderByName(parentCid, name);
  if (existing) return existing;
  const created = await createFolder(parentCid, name);
  return created.cid;
}

// Two-stage lookup for an existing show/movie folder by tmdbId:
// 1. Query media_library (covers files organised by this system)
// 2. Scan the 115 category folder for a subfolder whose name contains "tmdb-{tmdbId}"
//    (covers pre-existing folders organised manually or by other tools that follow the
//    default naming convention  "{title} ({year}) {tmdb-{tmdbId}}")
async function findExistingShowCid(tmdbId, mediaType, catCid) {
  // Stage 1: local DB
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

  // Stage 2: scan 115 category folder for "tmdb-{tmdbId}" in folder name
  try {
    const marker = `tmdb-${tmdbId}`;
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

// ----- Multi-version resolution -----

// resolution-priority compares numeric value: 2160 > 1080 > 720 etc.
function resolutionScore(r) {
  if (!r) return 0;
  const m = String(r).match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function isRemuxLike(info) {
  return /remux|bluray|blu-ray/i.test(info?.source || '');
}

function hasDolby(info) {
  return /truehd|atmos|dolby/i.test(info?.audioCodec || '');
}

async function resolveMultiVersion({ mediaType, tmdbId, season, episode, incoming, cfg }) {
  if (cfg.conflict_mode === 2) return { action: 'none' }; // skip mode disables version handling
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM media_library WHERE media_type=? AND tmdb_id=? AND season IS ? AND episode IS ?`
  ).all(mediaType, tmdbId, season, episode);

  if (!existing.length) return { action: 'none' };

  // Multi-version keep all: leave both, naming differentiates them.
  if (cfg.multi_version) return { action: 'none' };

  // Single-version mode: keep the strongest. Compare incoming vs each existing.
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
    // 'tie' is treated as keep-existing
    else incomingWins = false;
  }
  if (!incomingWins) {
    // Pick the strongest existing as the winner to record
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
  // Tie-break by size per conflict_mode: 0 = small wins, 1 = big wins
  if (aSize !== bSize) {
    if (cfg.conflict_mode === 1) return aSize > bSize ? 'incoming' : 'existing';
    return aSize < bSize ? 'incoming' : 'existing';
  }
  return 'tie';
}

// ----- ffprobe helper -----

async function extractMediaInfo(video, cfg) {
  if (!cfg.ffprobe_enabled) return {};
  try {
    return await getMediaInfo(video.id) || {};
  } catch (err) {
    logger.debug('Organizer', `ffprobe 跳过 ${video.name}: ${err.message}`);
    return {};
  }
}

// Merge filename-parsed info with ffprobe results: ffprobe wins where it has a value.
function mergeMediaInfo(parsed, probe) {
  const out = { ...parsed };
  for (const [k, v] of Object.entries(probe || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

// ----- task_items helper -----

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

// ----- Re-organize an existing task in place (4.12) -----

export async function rerunInPlace(originalTaskId) {
  const db = getDb();
  const original = db.prepare('SELECT * FROM tasks WHERE id=?').get(originalTaskId);
  if (!original) throw new Error('原任务不存在');
  const items = db.prepare(`SELECT * FROM task_items
    WHERE task_id=? AND target_cid IS NOT NULL AND file_id IS NOT NULL`).all(originalTaskId);
  if (!items.length) throw new Error('原任务无可重跑的条目');

  const cfg = getConfig();
  const newTask = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
  const newTaskId = newTask.lastInsertRowid;
  const cancel = getCancelToken(newTaskId);
  const stats = { scan: items.length, success: 0, fail: 0, skip: 0 };

  // Group items by media (tmdbId, mediaType) - we re-classify/re-rename in their CURRENT location.
  try {
    for (const item of items) {
      if (cancel.cancelled) break;
      try {
        const id = {
          title: '', year: '', tmdbId: item.tmdb_id, mediaType: item.media_type,
          identifySource: 'rerun',
        };
        // Fetch fresh details for re-classification
        if (id.tmdbId) {
          id.tmdbDetails = id.mediaType === 'movie'
            ? await getMovieDetails(id.tmdbId)
            : await getTVDetails(id.tmdbId);
          if (id.tmdbDetails) {
            id.year = getYear(id.tmdbDetails);
            id.title = getTitle(id.tmdbDetails);
            if (isAnime(id.tmdbDetails)) id.mediaType = 'anime';
          }
        }
        if (!id.title || !id.year || !id.tmdbId) { stats.skip++; continue; }

        // Determine new target path
        const categoryPath = classifyTargetPath(id, cfg);
        const catCid = await ensureFolderPath(cfg.target_cid, categoryPath);
        let targetFolderCid;
        if (id.mediaType === 'tv' || id.mediaType === 'anime') {
          const { showName, seasonName, episodeName } = generateTVNames(id, {}, item.season, item.episode, item.episode_end);
          const showCid = await getOrCreateChildFolder(catCid, showName);
          targetFolderCid = await getOrCreateChildFolder(showCid, seasonName);
          const newName = episodeName + '.' + extOf(item.new_name || item.original_name);
          if (item.target_cid !== targetFolderCid) await moveFile(item.file_id, targetFolderCid);
          if (cfg.rename_enabled) await renameFile(item.file_id, newName);
        } else {
          const { folderName, fileName } = generateMovieNames(id, {});
          targetFolderCid = await getOrCreateChildFolder(catCid, folderName);
          const newName = fileName + '.' + extOf(item.new_name || item.original_name);
          if (item.target_cid !== targetFolderCid) await moveFile(item.file_id, targetFolderCid);
          if (cfg.rename_enabled) await renameFile(item.file_id, newName);
        }
        stats.success++;
        const delaySec = Number(cfg.operation_delay_sec) || 1.5;
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

// ----- Resolve an unmatched item manually (4.13) -----

export async function resolveUnmatched(unmatchedId, payload) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(unmatchedId);
  if (!item) throw new Error('条目不存在');
  const files = JSON.parse(item.file_ids || '[]');
  if (!files.length) throw new Error('条目缺少文件信息，无法继续');

  const cfg = getConfig();
  const id = {
    title: payload.title || '',
    year: String(payload.year || ''),
    tmdbId: payload.tmdbId || null,
    mediaType: payload.mediaType || 'movie',
    identifySource: 'manual',
  };
  // Fetch TMDB details if we have an id
  if (id.tmdbId) {
    id.tmdbDetails = id.mediaType === 'movie'
      ? await getMovieDetails(id.tmdbId)
      : await getTVDetails(id.tmdbId);
    if (id.tmdbDetails) {
      if (!id.title) id.title = getTitle(id.tmdbDetails);
      if (!id.year) id.year = getYear(id.tmdbDetails);
      if (isAnime(id.tmdbDetails)) id.mediaType = 'anime';
    }
  }
  if (!id.title || !id.year || !id.tmdbId) throw new Error('必填字段缺失 (title/year/tmdbId)');

  // Build group from stored files
  const videos = files.filter(f => f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isVideo: true }));
  const metas = files.filter(f => !f.isVideo).map(f => ({ id: f.id, name: f.name, size: f.size, parentCid: item.parent_cid, _isMeta: true }));
  if (!videos.length) throw new Error('该条目下没有视频文件');

  const group = { kind: 'manual', parentCid: item.parent_cid, folderName: item.source_name, videos, metas };

  // Inline a new task to wrap the work
  const taskRow = db.prepare("INSERT INTO tasks (status, started_at) VALUES ('running', datetime('now','localtime'))").run();
  const taskId = taskRow.lastInsertRowid;
  const stats = { scan: videos.length, success: 0, fail: 0, skip: 0 };
  const episodeSummary = new Map();
  const cancel = getCancelToken(taskId);

  try {
    // For TV: allow caller to provide explicit season/episode that overrides parsed
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

async function processTVManual(group, id, cfg, taskId, stats, cancel, overrides, episodeSummary) {
  // Build per-episode list using overrides where parsing falls short.
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

  const categoryPath = classifyTargetPath(id, cfg);
  const catCid = await ensureFolderPath(cfg.target_cid, categoryPath);
  const { showName } = generateTVNames(id, episodes[0].mediaInfo, episodes[0].season, episodes[0].episode);
  const showCid = (await findExistingShowCid(id.tmdbId, id.mediaType, catCid))
    ?? await getOrCreateChildFolder(catCid, showName);
  const seasonsCache = new Map();

  for (const ep of episodes) {
    if (cancel.cancelled) break;
    let seasonCid = seasonsCache.get(ep.season);
    if (!seasonCid) {
      const { seasonName } = generateTVNames(id, ep.mediaInfo, ep.season, ep.episode, ep.episodeEnd);
      seasonCid = await getOrCreateChildFolder(showCid, seasonName);
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

// ----- Clean up empty folders -----

async function cleanupEmptyFolders(cid) {
  const cfg = getConfig();
  const videoExts = new Set(parseExts(cfg?.video_extensions, VIDEO_EXTS_DEFAULT));
  const metaExts = new Set(parseExts(cfg?.meta_extensions, META_EXTS_DEFAULT));
  const isMedia = name => { const e = extOf(name); return videoExts.has(e) || metaExts.has(e); };

  let items;
  try {
    items = await listFolder(cid);
  } catch (err) {
    logger.warn('Organizer', `空文件夹清理：列目录失败 cid=${cid}`, err.message);
    return;
  }

  for (const item of items) {
    if (!item.isFolder) continue;
    let children;
    try {
      children = await listFilesRecursive(item.id, { maxDepth: 8 });
    } catch (err) {
      logger.warn('Organizer', `空文件夹清理：递归列举失败 ${item.name} cid=${item.id}`, err.message);
      continue;
    }
    const mediaCount = children.filter(f => isMedia(f.name)).length;
    if (mediaCount > 0) continue;

    logger.info('Organizer', `删除无媒体子文件夹: ${item.name} cid=${item.id} (共${children.length}个文件)`);
    try {
      await deleteFolder(item.id, cid);
    } catch (err) {
      logger.warn('Organizer', `删除空文件夹失败: ${item.name} cid=${item.id}`, err.message);
    }
  }
}
