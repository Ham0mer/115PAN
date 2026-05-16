import { getDb } from './db.js';
import { logger } from './logger.js';

let requestQueue = [];
let processing = false;
let lastRequestTime = 0;
const MIN_INTERVAL = 250; // ~4 req/s conservative

function getConfig() {
  return getDb().prepare('SELECT * FROM config_tmdb WHERE id=1').get();
}

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

function enqueueRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
    setTimeout(() => reject(new Error('TMDB请求超时')), timeout * 1000);
  });
}

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

// Search multi (movies + TV)
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

// Get movie details
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

// Get TV show details
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

// Get TV season details
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

// Test connectivity
export async function testConnection() {
  const data = await tmdbRequest('/movie/550');
  return data?.title ? true : false;
}

// Get external IDs (for IMDB lookup)
export async function getMovieExternalIds(tmdbId) {
  return tmdbRequest(`/movie/${tmdbId}/external_ids`);
}

export async function getTVExternalIds(tmdbId) {
  return tmdbRequest(`/tv/${tmdbId}/external_ids`);
}

// Find by IMDB ID
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

// Determine region classification
export function classifyRegion(details) {
  const countries = details?.origin_country || details?.production_countries?.map(c => c.iso_3166_1) || [];
  if (countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) return '国产';
  if (countries.includes('JP')) return '日韩';
  if (countries.includes('KR')) return '日韩';
  if (countries.includes('US') || countries.includes('GB') || countries.includes('FR') || countries.includes('DE') || countries.includes('IT') || countries.includes('ES')) return '欧美';
  return '其他';
}

export function classifyAnimeRegion(details) {
  const countries = details?.origin_country || details?.production_countries?.map(c => c.iso_3166_1) || [];
  if (countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) return '国漫';
  if (countries.includes('JP')) return '日漫';
  if (countries.includes('US') || countries.includes('GB') || countries.includes('FR') || countries.includes('DE')) return '欧美动画';
  return '其他';
}

export function isAnime(details) {
  return details?.genre_ids?.includes(16) || details?.genres?.some(g => g.id === 16) || false;
}

export function getYear(details) {
  if (details?.release_date) return details.release_date.slice(0, 4);
  if (details?.first_air_date) return details.first_air_date.slice(0, 4);
  return '';
}

export function getTitle(details) {
  return details?.title || details?.name || '';
}
