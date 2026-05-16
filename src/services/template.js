import { getDb } from './db.js';
import { logger } from './logger.js';

function formatValue(value, fmt) {
  if (value === null || value === undefined || value === '') return '';
  const m = fmt?.match(/^(\d+)d$/);
  if (m) {
    const n = typeof value === 'number' ? value : parseInt(value);
    if (!Number.isNaN(n)) return String(n).padStart(parseInt(m[1]), '0');
  }
  return String(value);
}

// Tokenize template into text and var tokens.
// Supports `{{` / `}}` as literal `{` / `}` (Python .format style).
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

const EMPTY_MARK = '\x00';

// Render a template string with variables, applying the spec's segment-omission rule (4.7.3).
// Strategy: replace empty variables with a sentinel char, then fuse the surrounding
// separator characters (./-/space) into a single strongest separator, picking '.' > '-' > ' '.
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

  // Iteratively fuse separators around empty markers.
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

  // Drop empty paired delimiters, collapse junk separators
  raw = raw
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\.\-/g, '-')
    .replace(/\-\./g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\s{2,}/g, ' ');

  // Trim leading/trailing whitespace and stray separators
  raw = raw.replace(/^[\s.\-]+/, '').replace(/[\s.\-]+$/, '');
  return raw;
}

// Sanitize a name for 115 filesystem: strip forbidden characters, cap length.
export function sanitizeName(name, maxBytes = 240) {
  if (!name) return '';
  let s = String(name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim();
  // Cap to maxBytes (UTF-8). 115 allows up to 255 bytes; leave some headroom.
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

export function getTemplates() {
  return getDb().prepare('SELECT * FROM config_templates WHERE id=1').get();
}

const ALL_FIELDS = [
  'movie_folder', 'movie_file', 'tv_show', 'tv_season', 'tv_episode',
  'tv_episode_range', 'common_subtitle_suffix', 'common_multi_version_suffix',
];

export function saveTemplates(data) {
  const db = getDb();
  const present = ALL_FIELDS.filter(f => data[f] !== undefined);
  if (!present.length) return;
  const sets = present.map(f => `${f}=@${f}`).join(', ');
  const params = {};
  present.forEach(f => { params[f] = data[f]; });
  db.prepare(`UPDATE config_templates SET ${sets}, updated_at=datetime('now','localtime') WHERE id=1`).run(params);
  logger.info('Template', '命名模板已更新');
}

// Build movie / TV variable dictionaries
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

export function generateMovieNames(tmdbInfo, mediaInfo) {
  const tmpl = getTemplates();
  const vars = buildMovieVars(tmdbInfo, mediaInfo);
  return {
    folderName: sanitizeName(renderTemplate(tmpl.movie_folder, vars)),
    fileName: sanitizeName(renderTemplate(tmpl.movie_file, vars)),
    vars,
  };
}

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

export function buildSubtitleSuffix(lang) {
  if (!lang) return '';
  const tmpl = getTemplates();
  return renderTemplate(tmpl.common_subtitle_suffix, { lang });
}

export function buildMultiVersionSuffix(n) {
  const tmpl = getTemplates();
  return renderTemplate(tmpl.common_multi_version_suffix, { n });
}

// Reverse-parse a filename against a template to extract variables.
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

// Validate templates (run before saving)
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
      const re = new RegExp(`\\{${v}(:[^}]*)?\\}`);
      if (!re.test(data[field])) errors.push(`${label}模板缺少 {${v}}`);
    }
  }
  return errors;
}

// Built-in presets. Note `{{tmdb-{tmdbId}}}` renders to literal `{tmdb-271110}`.
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
