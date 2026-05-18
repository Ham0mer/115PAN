import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

// 规则全部外置到 config/parse_rules.json。这里只做"装载 + 编译一次 + 驱动"。
// 新文件名扛不住时，先看是不是改 JSON 即可，避免在代码里堆正则。
const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, '..', '..', 'config', 'parse_rules.json');
const RULES = JSON.parse(readFileSync(RULES_PATH, 'utf-8'));

// 简易中文数字表：用于解析 "第十二集"、"第二十三话" 这类汉字数字
const CN_NUM = { '零':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };

const REGEX_META_RE = /[.*+?^${}()|[\]\\-]/g;
const escapeRe = (s) => s.replace(REGEX_META_RE, '\\$&');

/** 编译 { re, flags } 形式的规则；spec 缺省时返回 null。 */
function compile(spec) {
  if (!spec || !spec.re) return null;
  return new RegExp(spec.re, spec.flags || '');
}

/** 从字符串列表构建一次性 alternation 正则：`\b(?:a|b|c)\b`，长项优先以避免被短项截断。 */
function buildListRegex(items, flags = 'gi', boundary = true) {
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => b.length - a.length);
  const body = sorted.map(escapeRe).join('|');
  return new RegExp(boundary ? `\\b(?:${body})\\b` : `(?:${body})`, flags);
}

/**
 * 把命中文本映射回列表中的"规范写法"（保留原大小写/连字符），未找到则返回原样。
 * 比较前会剥掉空白与点号，让 "DTS-HD MA" / "DTS-HD.MA" 都能命中列表里的 "DTS-HDMA"。
 */
function canonicalize(match, list) {
  const norm = (s) => s.toLowerCase().replace(/[\s.]+/g, '');
  const k = norm(match);
  return list.find(item => norm(item) === k) || match;
}

// 预编译：模块加载时一次性把 JSON 里的字符串吃成 RegExp 对象，避免热路径重复 new RegExp。
const RX = {
  ext:        compile(RULES.extensionPattern),
  tmdb:       compile(RULES.tmdbIdPattern),
  hdr:        compile(RULES.hdrPattern),
  bitDepth:   compile(RULES.bitDepthPattern),
  year:       compile(RULES.yearPattern),
  audioCount: compile(RULES.audioCountPattern),
  audioChan:  compile(RULES.audioChannelPattern),
  cnSeason:   compile(RULES.chineseSeasonPattern),
  cnEpisode:  compile(RULES.chineseEpisodePattern),
  cnSEStrip:  compile(RULES.chineseSeasonEpisodeStripPattern),
  releaseGroup:         compile(RULES.releaseGroupPattern),
  releaseGroupFallback: compile(RULES.releaseGroupFallbackPattern),
  titleModifiers:       compile(RULES.titleStripModifiersPattern),

  noise: (RULES.noisePatterns || []).map(compile),
  chineseTags: buildListRegex(RULES.chineseReleaseTags, 'g', false),
  // 流媒体平台名末尾可能带非词字符（如 Disney+），不能直接 \b 包裹；用 (?![A-Za-z0-9]) 兜底。
  streaming: RULES.streamingPlatforms?.length
    ? new RegExp(`\\b(?:${RULES.streamingPlatforms.join('|')})(?![A-Za-z0-9])`, 'gi')
    : null,

  resolutions: (RULES.resolutions || []).map(r => ({ name: r, re: new RegExp(escapeRe(r), 'i') })),
  videoCodecs: (RULES.videoCodecs || []).map(c => ({ name: c, re: new RegExp(`\\b${escapeRe(c)}\\b`, 'i') })),
  sourcesAll:     buildListRegex(RULES.sources,      'gi'),
  audioCodecsAll: buildListRegex(RULES.audioCodecs,  'gi'),

  seasonEpisode: (RULES.seasonEpisodePatterns || []).map(p => ({ ...p, re: new RegExp(p.re, p.flags || '') })),
  seasonRangeContainer: (RULES.seasonRangeContainerPatterns || []).map(compile),

  subtitleLanguages: (RULES.subtitleLanguagePatterns || []).map(p => ({ lang: p.lang, re: new RegExp(p.re, p.flags || '') })),
};

const RG_REJECT_RES = [
  /^[Ss]\d{1,3}([Ee]\d{1,3})?$/,
  /^[Ee][Pp]?\d{1,3}$/,
  /^\d{1,2}[xX]\d{1,3}$/,
];
function isReleaseGroupReject(s) {
  if (RULES.resolutions.includes(s)) return true;
  if (RULES.sources.includes(s)) return true;
  return RG_REJECT_RES.some(re => re.test(s));
}

/**
 * 把汉字数字（最多到百以内）转为整数。
 * 处理形态：纯阿拉伯数字直接 parseInt；"十"=10；"十X"/"X十"/"X十Y"；其它逐字累乘。
 * 无法识别时返回 null。
 */
function chineseToInt(s) {
  s = (s || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s);
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十' && CN_NUM[s[1]] != null) return 10 + CN_NUM[s[1]];
  if (s.length === 2 && s[1] === '十' && CN_NUM[s[0]] != null) return CN_NUM[s[0]] * 10;
  if (s.length === 3 && s[1] === '十' && CN_NUM[s[0]] != null && CN_NUM[s[2]] != null) {
    return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  }
  let total = 0;
  for (const ch of s) {
    if (CN_NUM[ch] == null) return null;
    total = total * 10 + CN_NUM[ch];
  }
  return total;
}

/**
 * 把全角字符（Unicode 全角拉丁）转半角，并剥离零宽/方向控制字符。
 * 应对从网页粘贴出来的"2160​p"、"H​265"等被零宽空格分隔的字符串。
 */
function toHalfwidth(s) {
  if (!s) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x3000) { out += ' '; continue; }
    if (code >= 0xFF01 && code <= 0xFF5E) { out += String.fromCharCode(code - 0xFEE0); continue; }
    if (code === 0xFEFF || (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E)) continue;
    out += s[i];
  }
  return out;
}

/** `remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ')` 的速写。 */
function stripCollapse(remaining, re) {
  return remaining.replace(re, ' ').replace(/\s+/g, ' ');
}

/**
 * 文件名解析主入口。
 * "剥洋葱"策略：从外向内依次抽取并剔除已识别字段，最后剩下的字符串视为 title。
 *
 * 抽取顺序：normalize → 去扩展名 → TMDB ID → 噪声/标签/平台 → HDR/分辨率/源/视频编码/
 * 位深 → 发布组（早识别） → 音频(计数/编码+声道/兜底) → 季集（多季容器跳宽松规则） →
 * 年份 → 发布组兜底 → title 收尾。
 *
 * @returns {Object} 平坦对象：title/year/season/episode/episodeEnd/resolution/source[]/
 *   videoCodec/bitDepth/hdr/audioCodec[]/audioCount/releaseGroup/mediaType/isMultiEpisode/tmdbId
 */
export function parseFilename(filename) {
  const result = {
    title: '',
    year: '',
    season: null,
    episode: null,
    episodeEnd: null,
    resolution: '',
    source: [],         // 数组：保留 "Blu-ray Remux" 这种并列源
    videoCodec: '',
    bitDepth: '',
    hdr: '',
    audioCodec: [],     // 数组：保留 "TrueHD Atmos" 这种并列编码
    audioCount: '',
    releaseGroup: '',
    mediaType: null,
    isMultiEpisode: false,
    tmdbId: null,
  };

  let remaining = toHalfwidth(filename);

  // 去扩展名
  if (RX.ext) {
    const m = remaining.match(RX.ext);
    if (m) remaining = remaining.slice(0, -m[0].length);
  }

  // TMDB ID（必须在去括号噪声之前）
  if (RX.tmdb) {
    const m = remaining.match(RX.tmdb);
    if (m) {
      result.tmdbId = m[1];
      remaining = stripCollapse(remaining, m[0]);
    }
  }

  // 噪声/广告/URL/中文标签/帧率/质量
  for (const re of RX.noise) remaining = remaining.replace(re, ' ');
  if (RX.chineseTags) remaining = remaining.replace(RX.chineseTags, ' ');
  if (RX.streaming)   remaining = remaining.replace(RX.streaming, ' ');
  remaining = remaining.replace(/\s+/g, ' ');

  // HDR
  if (RX.hdr) {
    const m = remaining.match(RX.hdr);
    if (m) {
      result.hdr = m[0];
      remaining = stripCollapse(remaining, new RegExp(RX.hdr.source, 'gi'));
    }
  }

  // 分辨率（单值，列表内首匹配）
  for (const { name, re } of RX.resolutions) {
    if (re.test(remaining)) {
      result.resolution = name;
      remaining = stripCollapse(remaining, re);
      break;
    }
  }

  // 片源（数组，全量收集）
  if (RX.sourcesAll) {
    const found = [...remaining.matchAll(RX.sourcesAll)].map(m => canonicalize(m[0], RULES.sources));
    if (found.length) {
      result.source = [...new Set(found)];
      remaining = stripCollapse(remaining, RX.sourcesAll);
    }
  }

  // 视频编码（单值）
  for (const { name, re } of RX.videoCodecs) {
    if (re.test(remaining)) {
      result.videoCodec = name;
      remaining = stripCollapse(remaining, re);
      break;
    }
  }

  // 位深
  if (RX.bitDepth) {
    const m = remaining.match(RX.bitDepth);
    if (m) {
      result.bitDepth = m[1] + 'bit';
      remaining = remaining.replace(new RegExp(RX.bitDepth.source, 'i'), ' ');
    }
  }

  // 发布组早识别——放在音频之前，否则贪婪的音频规则可能把 "-FRDS" 吃掉。
  // 排除掉看起来像季/集标记的形态（S04E10 / 1x02 / E10）。
  if (RX.releaseGroup) {
    const m = remaining.match(RX.releaseGroup);
    if (m && !isReleaseGroupReject(m[1])) {
      result.releaseGroup = m[1];
      remaining = remaining.slice(0, -m[0].length);
    }
  }

  // 音频：先 "X Audios Codec"，再 "Codec + 声道数"，最后全量扫表收集
  if (RX.audioCount) {
    const m = remaining.match(RX.audioCount);
    if (m) {
      result.audioCount = m[1];
      result.audioCodec = [canonicalize(m[2].trim(), RULES.audioCodecs)];
      remaining = remaining.replace(new RegExp(RX.audioCount.source, 'i'), ' ');
    }
  }
  if (!result.audioCodec.length && RX.audioChan) {
    const m = remaining.match(RX.audioChan);
    if (m) {
      result.audioCodec = [canonicalize(m[1], RULES.audioCodecs)];
      remaining = remaining.replace(m[0], ' ');
    }
  }
  if (RX.audioCodecsAll) {
    const extra = [...remaining.matchAll(RX.audioCodecsAll)].map(m => canonicalize(m[0], RULES.audioCodecs));
    if (extra.length) {
      result.audioCodec = [...new Set([...result.audioCodec, ...extra])];
      remaining = stripCollapse(remaining, RX.audioCodecsAll);
    }
  }

  // 多季合集容器：在解析季集时跳过 fallback 宽松规则，避免零散数字误读成集号
  const isSeasonRangeContainer = RX.seasonRangeContainer.some(re => re.test(remaining));

  for (const p of RX.seasonEpisode) {
    if (p.fallback && isSeasonRangeContainer) continue;
    const m = remaining.match(p.re);
    if (!m) continue;
    const sNum = p.si != null ? parseInt(m[p.si]) : NaN;
    result.season = Number.isFinite(sNum) ? sNum : null;
    const eNum = p.ei != null ? parseInt(m[p.ei]) : NaN;
    result.episode = Number.isFinite(eNum) ? eNum : null;
    if (p.eei != null && m[p.eei]) {
      const epEnd = parseInt(m[p.eei]);
      if (Number.isFinite(epEnd)) {
        result.episodeEnd = epEnd;
        result.isMultiEpisode = true;
      }
    }
    remaining = stripCollapse(remaining, p.re);
    break;
  }

  // 中文季/集兜底
  if (result.season === null && RX.cnSeason) {
    const m = remaining.match(RX.cnSeason);
    const n = m ? chineseToInt(m[1]) : null;
    if (n != null) {
      result.season = n;
      remaining = stripCollapse(remaining, m[0]);
    }
  }
  if (result.episode === null && RX.cnEpisode) {
    const m = remaining.match(RX.cnEpisode);
    const n = m ? chineseToInt(m[1]) : null;
    if (n != null) {
      result.episode = n;
      remaining = stripCollapse(remaining, m[0]);
    }
  }
  // 即使上面 S/E 已抓到，残留的中文季/集标记也要从 title 里清掉
  if (RX.cnSEStrip) remaining = stripCollapse(remaining, RX.cnSEStrip);

  if (result.season !== null || result.episode !== null) result.mediaType = 'tv';

  // 年份
  if (RX.year) {
    const m = remaining.match(RX.year);
    if (m) {
      result.year = m[1];
      remaining = stripCollapse(remaining, m[0]);
    }
  }

  // 发布组兜底
  if (!result.releaseGroup && RX.releaseGroupFallback) {
    const m = remaining.match(RX.releaseGroupFallback);
    if (m && !isReleaseGroupReject(m[1])) {
      result.releaseGroup = m[1];
      remaining = remaining.slice(0, -m[0].length);
    }
  }

  // title 收尾：. / _ 统一转空格；括号转空格；漏抓的 4 位年份再清一次
  remaining = remaining
    .replace(/[\[\]【】\(\)（）]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-]+|[\s\-]+$/g, '');

  result.title = remaining;

  if (RX.titleModifiers) {
    result.title = result.title.replace(RX.titleModifiers, '').replace(/\s+/g, ' ').trim();
  }

  // 中文 + 尾部 ASCII 段：剥掉 ASCII 段（多是英文别名）
  if (/[一-鿿]/.test(result.title)) {
    const cjkOnly = result.title.replace(/\s+[A-Za-z][\w\s,'.:!?-]*$/, '').trim();
    if (cjkOnly) result.title = cjkOnly;
  }

  if (!result.mediaType) result.mediaType = 'movie';

  logger.debug('Parser', `解析: ${filename}`, JSON.stringify(result));
  return result;
}

/**
 * 把 source/audioCodec 这类可能是数组也可能是字符串的字段，规范成一个用于显示/落库的字符串。
 * 数组：用 sep 拼接；字符串：原样返回；null/undefined：空串。
 */
export function joinList(v, sep = ' ') {
  if (Array.isArray(v)) return v.filter(Boolean).join(sep);
  return v == null ? '' : String(v);
}

/**
 * 通过文件夹结构推断媒体类型（电影 / 剧集）。
 * 用于"文件夹里多个视频文件"的批量场景，不依赖单文件名解析。
 *
 * 判定流程：
 * 1) 文件夹名出现 S01 / 第N季 / Season N → tv；
 * 2) 文件夹内多个视频文件：
 *    a) 任一文件能解析出 S/E → tv；
 *    b) 文件名抽出连续递增数字（≥2 个）→ tv；
 * 3) 其余 → movie。
 */
export function detectMediaTypeFromStructure(files, folderName, videoExts) {
  if (/[Ss]\d{1,2}|第\d+季|[Ss]eason\s*\d/i.test(folderName)) return 'tv';

  const extSet = videoExts instanceof Set ? videoExts : new Set(videoExts);
  const videoFiles = files.filter(f => extSet.has(f.split('.').pop()?.toLowerCase()));
  if (videoFiles.length > 1) {
    const hasSE = videoFiles.some(f => {
      const p = parseFilename(f);
      return p.season !== null || p.episode !== null;
    });
    if (hasSE) return 'tv';
    const nums = videoFiles.map(f => {
      const m = f.match(/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    }).filter(n => n > 0);
    if (nums.length >= 2 && nums.every((n, i) => i === 0 || n >= nums[i - 1])) return 'tv';
  }

  return 'movie';
}

/**
 * 从文件名后缀检测字幕语言。命中规则来自 parse_rules.json 的 subtitleLanguagePatterns。
 * 未命中返回空串。
 */
export function detectLanguage(filename) {
  for (const { re, lang } of RX.subtitleLanguages) {
    if (re.test(filename)) return lang;
  }
  return '';
}
