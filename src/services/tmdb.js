import { getDb } from './db.js';
import { logger } from './logger.js';

// 全局请求队列（所有 TMDB 调用都进此队列，避免触发官方限流）
let requestQueue = [];
// 队列处理器是否正在循环，幂等开关
let processing = false;
// 上一次请求实际发出的时间戳，用于节流计算
let lastRequestTime = 0;
// 最小请求间隔：250ms → 约 4 req/s，保守值（官方限制约 40 req/10s）
const MIN_INTERVAL = 250;

/**
 * 读取 TMDB 配置（api_key / base_url / primary_lang / timeout_sec 等）。
 */
function getConfig() {
  return getDb().prepare('SELECT * FROM config_tmdb WHERE id=1').get();
}

/**
 * 处理请求队列：串行发出所有挂起请求，强制相邻请求最小间隔 250ms。
 * 单实例（多次入队也只有一个处理循环），保证全局节流。
 */
async function processQueue() {
  if (processing) return;
  processing = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    const wait = MIN_INTERVAL - (now - lastRequestTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { url, resolve, reject } = requestQueue.shift();
    try {
      const res = await fetch(url);
      lastRequestTime = Date.now();
      resolve(res);
    } catch (err) {
      reject(err);
    }
  }
  processing = false;
}

/**
 * 入队并返回 Promise，附带独立的超时机制。
 * 超时只会让调用方收到 reject，并不会取消底层 fetch（fetch 仍会完成，但其结果被丢弃）。
 */
function enqueueRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
    setTimeout(() => reject(new Error('TMDB请求超时')), timeout * 1000);
  });
}

/**
 * 通用的 TMDB GET 请求封装。
 * - 强制走全局队列；
 * - 自动拼 api_key + language（默认 zh-CN）；
 * - 404 视为"未找到"返回 null（搜索常见情况），其他非 2xx 抛错。
 */
export async function tmdbRequest(endpoint, params = {}) {
  const cfg = getConfig();
  if (!cfg?.api_key) throw new Error('TMDB API Key 未配置');
  const base = cfg.base_url || 'https://api.themoviedb.org/3';
  const qs = new URLSearchParams({ api_key: cfg.api_key, language: cfg.primary_lang || 'zh-CN', ...params });
  const url = `${base}${endpoint}?${qs}`;
  logger.debug('TMDB', `请求: ${endpoint}`);
  const res = await enqueueRequest(url, cfg.timeout_sec || 10);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`TMDB API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

/**
 * 多类型搜索（电影 + 剧集）。
 * 用于不确定是电影还是剧集的情况；过滤掉 person 等非媒体结果。
 * 失败仅 warn 并返回 []，调用方无需处理异常。
 */
export async function searchMulti(query, year) {
  try {
    const params = { query };
    if (year) params.year = String(year);
    const data = await tmdbRequest('/search/multi', params);
    return (data?.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
  } catch (err) {
    logger.warn('TMDB', `搜索失败: ${query}`, err.message);
    return [];
  }
}

/**
 * 搜索电影。year 用于过滤主上映年份。
 */
export async function searchMovie(query, year) {
  try {
    const params = { query };
    if (year) params.primary_release_year = String(year);
    const data = await tmdbRequest('/search/movie', params);
    return data?.results || [];
  } catch (err) {
    logger.warn('TMDB', `搜索电影失败: ${query}`, err.message);
    return [];
  }
}

/**
 * 搜索剧集。year 对应首播年份。
 */
export async function searchTV(query, year) {
  try {
    const params = { query };
    if (year) params.first_air_date_year = String(year);
    const data = await tmdbRequest('/search/tv', params);
    return data?.results || [];
  } catch (err) {
    logger.warn('TMDB', `搜索剧集失败: ${query}`, err.message);
    return [];
  }
}

/**
 * 获取电影详情。
 * 注意：未走 tmdbRequest 通用封装（少了 logger 与 404→null 的处理），仅做最简调用。
 */
export async function getMovieDetails(tmdbId) {
  const cfg = getConfig();
  const base = cfg.base_url || 'https://api.themoviedb.org/3';
  const params = { language: cfg.primary_lang || 'zh-CN' };
  const qs = new URLSearchParams({ api_key: cfg.api_key, ...params });
  const url = `${base}/movie/${tmdbId}?${qs}`;
  const res = await enqueueRequest(url, cfg.timeout_sec || 10);
  if (!res.ok) return null;
  return res.json();
}

/**
 * 获取剧集详情。
 */
export async function getTVDetails(tmdbId) {
  const cfg = getConfig();
  const base = cfg.base_url || 'https://api.themoviedb.org/3';
  const params = { language: cfg.primary_lang || 'zh-CN' };
  const qs = new URLSearchParams({ api_key: cfg.api_key, ...params });
  const url = `${base}/tv/${tmdbId}?${qs}`;
  const res = await enqueueRequest(url, cfg.timeout_sec || 10);
  if (!res.ok) return null;
  return res.json();
}

/**
 * 获取某季详情（含每集列表），用于补全单集标题/播出日期等模板变量。
 */
export async function getTVSeasonDetails(tmdbId, seasonNum) {
  const cfg = getConfig();
  const base = cfg.base_url || 'https://api.themoviedb.org/3';
  const params = { language: cfg.primary_lang || 'zh-CN' };
  const qs = new URLSearchParams({ api_key: cfg.api_key, ...params });
  const url = `${base}/tv/${tmdbId}/season/${seasonNum}?${qs}`;
  const res = await enqueueRequest(url, cfg.timeout_sec || 10);
  if (!res.ok) return null;
  return res.json();
}

/**
 * TMDB 连通性测试：拉取一个稳定存在的电影（Fight Club，ID 550），返回 boolean。
 * 用于 Web 端"测试 API Key"按钮。
 */
export async function testConnection() {
  const data = await tmdbRequest('/movie/550');
  return data?.title ? true : false;
}

/**
 * 获取电影的外部 ID 集（含 imdb_id）。
 */
export async function getMovieExternalIds(tmdbId) {
  return tmdbRequest(`/movie/${tmdbId}/external_ids`);
}

/**
 * 获取剧集的外部 ID 集（含 imdb_id）。
 */
export async function getTVExternalIds(tmdbId) {
  return tmdbRequest(`/tv/${tmdbId}/external_ids`);
}

/**
 * 通过 IMDB ID 反查 TMDB 条目。
 * 返回归一化对象 { mediaType:'movie'|'tv', ...原条目 }，找不到时返回 null。
 * 优先选 movie_results 中第一条，没有再看 tv_results。
 */
export async function findByImdbId(imdbId) {
  try {
    const params = { external_source: 'imdb_id' };
    const data = await tmdbRequest(`/find/${imdbId}`, params);
    if (data?.movie_results?.length > 0) {
      const m = data.movie_results[0];
      return { mediaType: 'movie', ...m };
    }
    if (data?.tv_results?.length > 0) {
      const t = data.tv_results[0];
      return { mediaType: 'tv', ...t, first_air_date: t.first_air_date };
    }
    return null;
  } catch (err) {
    logger.warn('TMDB', `IMDB查找失败: ${imdbId}`, err.message);
    return null;
  }
}

/**
 * 按出品国家把媒体归类到"国产/日韩/欧美/其他"四档。
 * 用于决定目标分类目录（如 /电影/欧美/...）。
 */
export function classifyRegion(details) {
  const countries = details?.origin_country || details?.production_countries?.map(c => c.iso_3166_1) || [];
  if (countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) return '国产';
  if (countries.includes('JP')) return '日韩';
  if (countries.includes('KR')) return '日韩';
  if (countries.includes('US') || countries.includes('GB') || countries.includes('FR') || countries.includes('DE') || countries.includes('IT') || countries.includes('ES')) return '欧美';
  return '其他';
}

/**
 * 动漫专用的地区分类（国漫/日漫/欧美动画/其他）。
 * 在 isAnime() 返回 true 时使用，区别于普通影视的 classifyRegion。
 */
export function classifyAnimeRegion(details) {
  const countries = details?.origin_country || details?.production_countries?.map(c => c.iso_3166_1) || [];
  if (countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) return '国漫';
  if (countries.includes('JP')) return '日漫';
  if (countries.includes('US') || countries.includes('GB') || countries.includes('FR') || countries.includes('DE')) return '欧美动画';
  return '其他';
}

/**
 * 判断是否为动画作品：TMDB Genre ID 16 = Animation。
 * 详情接口返回 genres 数组，搜索结果返回 genre_ids 数组，两种形态都兼容。
 */
export function isAnime(details) {
  return details?.genre_ids?.includes(16) || details?.genres?.some(g => g.id === 16) || false;
}

/**
 * 从详情对象中提取年份字符串（YYYY）。
 * 电影看 release_date，剧集看 first_air_date。
 */
export function getYear(details) {
  if (details?.release_date) return details.release_date.slice(0, 4);
  if (details?.first_air_date) return details.first_air_date.slice(0, 4);
  return '';
}

/**
 * 从详情对象中提取标题。电影字段是 title，剧集字段是 name。
 */
export function getTitle(details) {
  return details?.title || details?.name || '';
}
