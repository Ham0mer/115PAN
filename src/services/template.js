import { getDb } from './db.js';
import { logger } from './logger.js';

/**
 * 将变量值按格式说明符（fmt）格式化为字符串。
 * 当前仅支持 Python 风格的零填充宽度："02d" → 把数字补足 2 位。
 * 其他情况（含 fmt 为 null）一律 String(value)。
 * 空值（null/undefined/空串）统一返回空字符串，触发后续的"段落省略"。
 *
 * @param {any} value 原始变量值
 * @param {string|null} fmt 格式说明，如 "02d"
 */
function formatValue(value, fmt) {
  if (value === null || value === undefined || value === '') return '';
  const m = fmt?.match(/^(\d+)d$/);
  if (m) {
    const n = typeof value === 'number' ? value : parseInt(value);
    if (!Number.isNaN(n)) return String(n).padStart(parseInt(m[1]), '0');
  }
  return String(value);
}

/**
 * 把模板字符串拆分为 token 序列。
 * - text token：原样保留；
 * - var token：形如 {name} 或 {name:fmt}，name 为变量名，fmt 为可选格式说明；
 * - {{ 与 }} 视为字面量 { 与 }（与 Python str.format 保持一致），用于 Plex 的
 *   `{tmdb-271110}` 这类元数据后缀格式。
 *
 * @returns {Array<{type:'text'|'var',value?:string,name?:string,fmt?:string}>}
 */
function tokenize(template) {
  const tokens = [];
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { tokens.push({ type: 'text', value: buf }); buf = ''; } };
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '{') { buf += '{'; i += 2; continue; }
    if (ch === '}' && template[i + 1] === '}') { buf += '}'; i += 2; continue; }
    if (ch === '{') {
      // 找到下一个 '}' 作为变量段终止；未闭合则降级为普通字符
      const end = template.indexOf('}', i + 1);
      if (end === -1) { buf += ch; i++; continue; }
      flush();
      const inner = template.slice(i + 1, end);
      const colonIdx = inner.indexOf(':');
      const name = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
      const fmt = colonIdx >= 0 ? inner.slice(colonIdx + 1) : null;
      tokens.push({ type: 'var', name, fmt });
      i = end + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

// 哨兵字符：表示一处"空值变量"，后续合并相邻分隔符时识别用
const EMPTY_MARK = '\x00';

/**
 * 用变量字典渲染模板字符串，并实现"空变量周围分隔符融合"规则（规范 4.7.3）。
 *
 * 算法：
 * 1) tokenize 后逐 token 拼接，遇到空值用 EMPTY_MARK 占位；
 * 2) 反复用正则把 "[分隔符]*EMPTY_MARK[分隔符]*" 合并为单个最强分隔符
 *    （优先级 '.' > '-' > ' '），直到稳定；
 * 3) 再做一轮整理：去掉空的成对括号 ()/[]、修复 ".-"、合并连续分隔符；
 * 4) 修剪首尾的空白与分隔符。
 *
 * 之所以反复执行：当多个变量相邻且都为空时一次正则无法清理干净。
 *
 * @param {string} template 模板字符串
 * @param {Object} vars 变量字典（键名与模板中的占位符对应）
 * @returns {string} 渲染后的字符串
 */
export function renderTemplate(template, vars) {
  if (!template) return '';
  const tokens = tokenize(template);

  let raw = '';
  for (const t of tokens) {
    if (t.type === 'text') {
      raw += t.value;
    } else {
      const rendered = formatValue(vars[t.name], t.fmt);
      raw += rendered === '' ? EMPTY_MARK : rendered;
    }
  }

  // 迭代合并 EMPTY_MARK 周围的分隔符
  let prev;
  do {
    prev = raw;
    raw = raw.replace(/([.\-\s]*)\x00([.\-\s]*)/g, (_m, l, r) => {
      const combined = l + r;
      if (!combined) return '';
      if (combined.includes('.')) return '.';
      if (combined.includes('-')) return '-';
      return ' ';
    });
  } while (raw !== prev);

  // 善后清理：空配对、错乱分隔符、连续分隔符
  raw = raw
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\.\-/g, '-')
    .replace(/\-\./g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\s{2,}/g, ' ');

  // 修剪首尾的空白/分隔符
  raw = raw.replace(/^[\s.\-]+/, '').replace(/[\s.\-]+$/, '');
  return raw;
}

/**
 * 把文件/目录名清洗为 115 文件系统允许的形式。
 * - 去除 / \ : * ? " < > | 及 0x00-0x1F 控制字符；
 * - 限制最大 UTF-8 字节数（115 上限 255，留一些余量默认 240）；
 *   超长时用二分搜索安全截断到字符边界，避免破坏多字节字符。
 */
export function sanitizeName(name, maxBytes = 240) {
  if (!name) return '';
  let s = String(name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim();
  // 限制 UTF-8 字节数（115 允许 255 字节，留些余量）
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/**
 * 读取当前命名模板配置（单行）。
 */
export function getTemplates() {
  return getDb().prepare('SELECT * FROM config_templates WHERE id=1').get();
}

// 允许通过 saveTemplates 更新的字段白名单
const ALL_FIELDS = [
  'movie_folder', 'movie_file', 'tv_show', 'tv_season', 'tv_episode',
  'tv_episode_range', 'common_subtitle_suffix', 'common_multi_version_suffix',
];

/**
 * 部分更新命名模板：只更新调用方传入了值（!== undefined）的字段，其它保持原样。
 * 自动维护 updated_at。
 */
export function saveTemplates(data) {
  const db = getDb();
  const present = ALL_FIELDS.filter(f => data[f] !== undefined);
  if (!present.length) return;
  // 动态拼接 SET 子句，参数走命名绑定避免 SQL 注入
  const sets = present.map(f => `${f}=@${f}`).join(', ');
  const params = {};
  present.forEach(f => { params[f] = data[f]; });
  db.prepare(`UPDATE config_templates SET ${sets}, updated_at=datetime('now','localtime') WHERE id=1`).run(params);
  logger.info('Template', '命名模板已更新');
}

/**
 * 构造电影模板的变量字典。
 * 字段都允许缺失（缺失值用空串），由 renderTemplate 的段落省略规则处理。
 */
function buildMovieVars(tmdb, media) {
  return {
    title: tmdb.title || '',
    originalTitle: tmdb.originalTitle || '',
    year: tmdb.year || '',
    tmdbId: tmdb.tmdbId || '',
    imdbId: tmdb.imdbId || '',
    resolution: media.resolution || '',
    source: media.source || '',
    videoCodec: media.videoCodec || '',
    bitDepth: media.bitDepth || '',
    hdr: media.hdr || '',
    audioCount: media.audioCount || '',
    audioCodec: media.audioCodec || '',
    releaseGroup: media.releaseGroup || '',
  };
}

/**
 * 构造剧集模板的变量字典。
 * 季/集号强制转为整数，便于 02d 格式化；非数字保留 null（→ 渲染为空段）。
 *
 * @param {Object} tmdb 来自 TMDB 的元数据
 * @param {Object} media 来自 ffprobe / 文件名解析的技术规格
 * @param {number|string} season 季号
 * @param {number|string} episode 集号
 * @param {number|string} [episodeEnd] 集号区间结束（双集时使用）
 */
function buildTVVars(tmdb, media, season, episode, episodeEnd) {
  const s = season != null ? parseInt(season) : null;
  const e = episode != null ? parseInt(episode) : null;
  const eEnd = episodeEnd != null ? parseInt(episodeEnd) : null;
  return {
    title: tmdb.title || '',
    originalTitle: tmdb.originalTitle || '',
    year: tmdb.year || '',
    tmdbId: tmdb.tmdbId || '',
    imdbId: tmdb.imdbId || '',
    season: Number.isFinite(s) ? s : null,
    episode: Number.isFinite(e) ? e : null,
    episode_start: Number.isFinite(e) ? e : null,
    episode_end: Number.isFinite(eEnd) ? eEnd : null,
    episodeTitle: tmdb.episodeTitle || '',
    seasonTitle: tmdb.seasonTitle || '',
    airDate: tmdb.airDate || '',
    resolution: media.resolution || '',
    source: media.source || '',
    videoCodec: media.videoCodec || '',
    bitDepth: media.bitDepth || '',
    hdr: media.hdr || '',
    audioCount: media.audioCount || '',
    audioCodec: media.audioCodec || '',
    releaseGroup: media.releaseGroup || '',
  };
}

/**
 * 生成电影目录名与文件名（已 sanitize）。
 * @returns {{folderName,fileName,vars}} vars 也一并返回，便于调用方做日志/校验。
 */
export function generateMovieNames(tmdbInfo, mediaInfo) {
  const tmpl = getTemplates();
  const vars = buildMovieVars(tmdbInfo, mediaInfo);
  return {
    folderName: sanitizeName(renderTemplate(tmpl.movie_folder, vars)),
    fileName: sanitizeName(renderTemplate(tmpl.movie_file, vars)),
    vars,
  };
}

/**
 * 生成剧集目录名 / 季名 / 单集（或区间）文件名（已 sanitize）。
 * 当传入 episodeEnd 时使用 tv_episode_range 模板，否则使用 tv_episode。
 */
export function generateTVNames(tmdbInfo, mediaInfo, season, episode, episodeEnd) {
  const tmpl = getTemplates();
  const vars = buildTVVars(tmdbInfo, mediaInfo, season, episode, episodeEnd);
  return {
    showName: sanitizeName(renderTemplate(tmpl.tv_show, vars)),
    seasonName: sanitizeName(renderTemplate(tmpl.tv_season, vars)),
    episodeName: sanitizeName(renderTemplate(
      episodeEnd != null ? tmpl.tv_episode_range : tmpl.tv_episode,
      vars
    )),
    vars,
  };
}

/**
 * 构造字幕语言后缀（如 ".chs"）。lang 为空时返回空串。
 */
export function buildSubtitleSuffix(lang) {
  if (!lang) return '';
  const tmpl = getTemplates();
  return renderTemplate(tmpl.common_subtitle_suffix, { lang });
}

/**
 * 构造多版本编号后缀（如 " - v2"）。处理"同一作品多个画质版本共存"的命名冲突。
 */
export function buildMultiVersionSuffix(n) {
  const tmpl = getTemplates();
  return renderTemplate(tmpl.common_multi_version_suffix, { n });
}

/**
 * 反向解析：根据模板字符串从已存在的文件名中提取变量。
 * - 文本 token 原样作为字面量并转义正则特殊字符；
 * - var token 替换为非贪婪 `(.+?)` 捕获组；
 * - 用 ^...$ 精确匹配整串。
 *
 * 主要用于模板迁移/校验场景（如根据现有命名反推 tmdbId）。
 *
 * @returns {{vars:Object, error?:string}}
 */
export function parseTemplate(template, input) {
  if (!template || !input) return { vars: {}, error: '模板或输入为空' };
  const tokens = tokenize(template);

  let pattern = '';
  const varNames = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      pattern += t.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      pattern += '(.+?)';
      varNames.push(t.name);
    }
  }

  try {
    const re = new RegExp('^' + pattern + '$');
    const match = input.match(re);
    if (!match) return { vars: {}, error: '无法匹配模板' };
    const vars = {};
    for (let i = 0; i < varNames.length; i++) {
      const val = match[i + 1];
      if (val !== undefined && val !== '') vars[varNames[i]] = val;
    }
    return { vars };
  } catch (e) {
    return { vars: {}, error: e.message };
  }
}

/**
 * 模板保存前的校验：确保关键字段中包含必备占位符。
 * 例如电影目录模板必须含 {title}/{year}/{tmdbId}，否则无法保证唯一性。
 *
 * @returns {Array<string>} 错误信息数组；为空表示通过校验。
 */
export function validateTemplates(data) {
  const errors = [];
  const checks = [
    ['movie_folder', ['title', 'year', 'tmdbId'], '电影目录'],
    ['tv_show', ['title', 'year', 'tmdbId'], '剧集目录'],
    ['tv_season', ['season'], '季目录'],
    ['tv_episode', ['season', 'episode'], '单集'],
  ];
  for (const [field, required, label] of checks) {
    if (data[field] == null) continue;
    for (const v of required) {
      // 允许 {v} 或 {v:fmt} 两种写法
      const re = new RegExp(`\\{${v}(:[^}]*)?\\}`);
      if (!re.test(data[field])) errors.push(`${label}模板缺少 {${v}}`);
    }
  }
  return errors;
}

/**
 * 内置预设：四种风格（标准 / Plex / Emby / Jellyfin）。
 * 注意 `{{tmdb-{tmdbId}}}` 利用 {{ }} 转义渲染为字面量 `{tmdb-271110}`，
 * 这正是 Plex/Emby/Jellyfin 识别 TMDB ID 的标记格式。
 */
export const PRESETS = {
  '标准': {
    movie_folder: '{title} ({year}) {{tmdb-{tmdbId}}}',
    movie_file: '{title} ({year}) - {resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    tv_show: '{title} ({year}) {{tmdb-{tmdbId}}}',
    tv_season: 'Season {season:02d}',
    tv_episode: '{title} ({year}) - S{season:02d}E{episode:02d}.{resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    tv_episode_range: '{title} ({year}) - S{season:02d}E{episode_start:02d}-E{episode_end:02d}.{resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    common_subtitle_suffix: '.{lang}',
    common_multi_version_suffix: ' - v{n}',
  },
  'Plex 友好': {
    movie_folder: '{title} ({year}) {{tmdb-{tmdbId}}}',
    movie_file: '{title} ({year}) - {resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    tv_show: '{title} ({year}) {{tmdb-{tmdbId}}}',
    tv_season: 'Season {season:02d}',
    tv_episode: '{title} ({year}) - S{season:02d}E{episode:02d}',
    tv_episode_range: '{title} ({year}) - S{season:02d}E{episode_start:02d}-E{episode_end:02d}',
    common_subtitle_suffix: '.{lang}',
    common_multi_version_suffix: ' - v{n}',
  },
  'Emby 友好': {
    movie_folder: '{title} ({year}) {{tmdbid={tmdbId}}}',
    movie_file: '{title} ({year}) - {resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    tv_show: '{title} ({year}) {{tmdbid={tmdbId}}}',
    tv_season: 'Season {season:02d}',
    tv_episode: '{title} ({year}) - S{season:02d}E{episode:02d}',
    tv_episode_range: '{title} ({year}) - S{season:02d}E{episode_start:02d}-E{episode_end:02d}',
    common_subtitle_suffix: '.{lang}',
    common_multi_version_suffix: ' - v{n}',
  },
  'Jellyfin 友好': {
    movie_folder: '{title} ({year}) [tmdbid-{tmdbId}]',
    movie_file: '{title} ({year}) - {resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
    tv_show: '{title} ({year}) [tmdbid-{tmdbId}]',
    tv_season: 'Season {season:02d}',
    tv_episode: '{title} ({year}) - S{season:02d}E{episode:02d}',
    tv_episode_range: '{title} ({year}) - S{season:02d}E{episode_start:02d}-E{episode_end:02d}',
    common_subtitle_suffix: '.{lang}',
    common_multi_version_suffix: ' - v{n}',
  },
};
