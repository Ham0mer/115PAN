import { logger } from '../logger.js';
import { parseFilename, detectMediaTypeFromStructure } from '../parser.js';
import {
  searchMovie, searchTV, searchMulti, getMovieDetails, getTVDetails,
  isAnime, getYear, getTitle,
} from '../tmdb.js';
import { aiIdentify } from '../ai.js';
import { parseExts, VIDEO_EXTS_DEFAULT } from './util.js';

/**
 * 对一个媒体单元做综合识别：本地文件名解析 → TMDB 搜索 → AI 兜底。
 *
 * 关键设计：
 * - 解析名字池 = 所有祖先目录名 + 所有视频文件名；
 * - 通过 pickBestParsed 综合打分挑出"主版本"信息；
 * - 结构启发式只在没有显式 tmdbId 时才允许把媒体类型翻转为 tv；
 * - TMDB / AI 是各自独立的可关闭兜底；AI 拿到 tmdbId 后还会回头再走一次 TMDB 拿详情；
 * - 最终用 tmdbDetails 判断动漫（Genre=Animation）并刷新 title/year。
 */
export async function identifyGroup(group, cfg) {
  const ancestorNames = new Set();
  for (const v of group.videos) {
    if (Array.isArray(v.pathSegs)) {
      for (const seg of v.pathSegs) if (seg) ancestorNames.add(seg);
    }
  }
  if (group.folderName) ancestorNames.add(group.folderName);
  const names = [...ancestorNames, ...group.videos.map(v => v.name)].filter(Boolean);
  const parsedAll = names.map(n => parseFilename(n));

  const merged = pickBestParsed(parsedAll, group);

  const videoExts = new Set(parseExts(cfg.video_extensions, VIDEO_EXTS_DEFAULT));
  const struct = detectMediaTypeFromStructure(group.videos.map(v => v.name), group.folderName, videoExts);
  if (struct === 'tv' && !merged.tmdbId) {
    merged.mediaType = 'tv';
  }

  if (!merged.tmdbId && merged.title) {
    const tmdb = await resolveViaTmdb(merged);
    if (tmdb) Object.assign(merged, tmdb);
  }

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
 * 通过 TMDB 解析媒体信息。优先按 mediaType 调具体接口，再用 multi 兜底。
 */
export async function resolveViaTmdb(info) {
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
 * 年份完全匹配 +3；标题完全相等 +3；互相包含 +1；流行度归一化 +0~2。
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
