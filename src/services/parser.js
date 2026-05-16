import { logger } from './logger.js';

const RESOLUTIONS = ['2160p', '1080p', '720p', '480p', '4K', '2K', '8K'];
const SOURCES = ['BluRay', 'BLURAY', 'Blu-ray', 'WEB-DL', 'WEBDL', 'WEBRip', 'HDTV', 'DVD', 'Remux', 'REMUX', 'Encode', 'BDRip', 'BRRip', 'HDRip', 'TC', 'TS', 'CAM'];
const CODECS = ['H.264', 'H264', 'H.265', 'H265', 'H.266', 'H266', 'AV1', 'AVC', 'HEVC', 'X264', 'x264', 'X265', 'x265', 'VP9', 'MPEG-4', 'MPEG2'];
const AUDIO_CODECS = ['DDP', 'DDP5.1', 'DDP7.1', 'TrueHD', 'TrueHD7.1', 'Atmos', 'DTS', 'DTS-HD', 'DTS-HDMA', 'DTS:X', 'AAC', 'AC3', 'EAC3', 'FLAC', 'PCM', 'MP3', 'WMA', 'OPUS'];

// Each pattern: re = regex, si/ei/eei = capture-group indices for season/episode/episodeEnd (null = not captured).
// fallback=true means the pattern is loose (e.g. bare leading number) and should be skipped
// when the name is a season-range container like "S1-S3" / "1-4季".
const SEASON_EP_PATTERNS = [
  { re: /[Ss](\d{1,3})\s*[Ee](\d{1,3})(?:[Ee-](\d{1,3}))?/,                                    si: 1, ei: 2, eei: 3 },
  { re: /[Ss](\d{1,3})\.?[Ee](\d{1,3})(?:[Ee-](\d{1,3}))?/,                                    si: 1, ei: 2, eei: 3 },
  // "1x02" notation (Plex/Emby alt form)
  { re: /\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/,                                                     si: 1, ei: 2, eei: null },
  { re: /第(\d{1,3})[季]?\s*第(\d{1,3})[集話话](?:[-~至]第?(\d{1,3})[集話话])?/,               si: 1, ei: 2, eei: 3 },
  { re: /[Ss]eason\s*(\d{1,3})[\s.]*[Ee]p?(?:isode)?\s*(\d{1,3})(?:[-~](\d{1,3}))?/i,         si: 1, ei: 2, eei: 3 },
  // Episode-only patterns: no season captured (si: null). These are loose; skip in season-range containers.
  { re: /[Ee][Pp]?\s*(\d{1,3})(?:[-~](\d{1,3}))?/,                                             si: null, ei: 1, eei: 2, fallback: true },
  { re: /^(\d{1,3})[\.\-\s]+(?=\D)/,                                                            si: null, ei: 1, eei: null, fallback: true },
];

// Chinese numeral table for parsing "第十二集" / "第二十三话" etc.
const CN_NUM = { '零':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };

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

// Convert fullwidth Unicode to halfwidth ASCII and drop zero-width / directional control chars
// that show up in copy-pasted names (e.g. "2160​p", "H​265" with U+200B between glyphs).
function toHalfwidth(s) {
  if (!s) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x3000) { out += ' '; continue; }
    if (code >= 0xFF01 && code <= 0xFF5E) { out += String.fromCharCode(code - 0xFEE0); continue; }
    // Strip zero-width spaces, joiners, direction marks, BOM.
    if (code === 0xFEFF || (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E)) continue;
    out += s[i];
  }
  return out;
}

export function parseFilename(filename) {
  const result = {
    title: '',
    year: '',
    season: null,
    episode: null,
    episodeEnd: null,
    resolution: '',
    source: '',
    videoCodec: '',
    bitDepth: '',
    hdr: '',
    audioCodec: '',
    audioCount: '',
    releaseGroup: '',
    mediaType: null,
    isMultiEpisode: false,
    tmdbId: null,
  };

  // Fullwidth → halfwidth so e.g. "Ｓ０１Ｅ０１.２１６０Ｐ" parses normally.
  let remaining = toHalfwidth(filename);

  // Remove extension
  const extMatch = remaining.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : '';
  if (extMatch) remaining = remaining.slice(0, -extMatch[0].length);

  // Extract explicit TMDB id in Plex/Emby/Jellyfin notation (e.g. [tmdb-575219], {tmdb-575219}, [tmdbid575219]).
  // Doing this BEFORE the bracket-junk strip preserves the id; the surrounding brackets get cleared below.
  const tmdbIdMatch = remaining.match(/[\[\{(]\s*tmdb(?:id)?[-_\s]*?(\d{2,8})\s*[\]\})]/i);
  if (tmdbIdMatch) {
    result.tmdbId = tmdbIdMatch[1];
    remaining = remaining.replace(tmdbIdMatch[0], ' ').replace(/\s+/g, ' ');
  }

  // Strip 【...】 bracketed junk (release-group ads, e.g. 【高清影视之家发布 www.HDBTHD.com】)
  remaining = remaining.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ');
  // Strip www.xxx.com URLs
  remaining = remaining.replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi, ' ').replace(/\s+/g, ' ');
  // Strip [...] tags with Chinese content (release tags like [60帧率版本][高码版][国语配音+中文字幕])
  remaining = remaining.replace(/\[[^\]]*[一-鿿][^\]]*\]/g, ' ').replace(/\s+/g, ' ');
  // Strip common Chinese release meta-tags
  remaining = remaining.replace(/无台标|有台标|国粤双语|国英双语|中日双语|中英双语|粤英双语|中文字幕|中英字幕|简中字幕|繁中字幕|国语配音|粤语配音|英语配音|日语配音|韩语配音|国语音轨|粤语音轨|高码版|低码版|加长版|导演剪辑版|剧场版|修复版|重制版|无删减|未删减|无水印|去水印|完整版|先行版|预售版/g, ' ').replace(/\s+/g, ' ');
  // Strip framerate (e.g. 60fps, 24fps) and quality markers (HQ/LQ)
  remaining = remaining.replace(/\b\d{2,3}\s*fps\b/gi, ' ').replace(/\b(?:HQ|LQ|HighQuality|LowQuality)\b/g, ' ').replace(/\s+/g, ' ');

  // Detect HDR
  if (/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/i.test(remaining)) {
    result.hdr = remaining.match(/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/i)[0];
    remaining = remaining.replace(/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/gi, ' ').replace(/\s+/g, ' ');
  }

  // Detect resolution (case-insensitive so "1080P" matches "1080p")
  for (const r of RESOLUTIONS) {
    const re = new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(remaining)) {
      result.resolution = r;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // Detect source
  for (const s of SOURCES) {
    const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
    if (re.test(remaining)) {
      result.source = s;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // Detect video codec
  for (const c of CODECS) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
    if (re.test(remaining)) {
      result.videoCodec = c;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // Detect bit depth
  const bdMatch = remaining.match(/\b(\d{1,2})\s*bit\b/i);
  if (bdMatch) {
    result.bitDepth = bdMatch[1] + 'bit';
    remaining = remaining.replace(/\d{1,2}\s*bit/i, ' ');
  }

  // Extract release group first (last dash segment, e.g. "-FRDS") so audio detection
  // below doesn't greedily eat into it.
  const rgEarly = remaining.match(/[-]\s*([A-Za-z][A-Za-z0-9]{1,9})\s*$/);
  if (rgEarly && !RESOLUTIONS.includes(rgEarly[1]) && !SOURCES.includes(rgEarly[1])) {
    result.releaseGroup = rgEarly[1];
    remaining = remaining.slice(0, -rgEarly[0].length);
  }

  // Detect audio codec(s) and count
  const audMatch = remaining.match(/(\d+)\s*Audios?\s*([A-Za-z][A-Za-z0-9.+:]*?)(?=[\s.\-]|$)/i);
  if (audMatch) {
    result.audioCount = audMatch[1];
    result.audioCodec = audMatch[2].trim();
    remaining = remaining.replace(/\d+\s*Audios?\s*[A-Za-z][A-Za-z0-9.+:]*/i, ' ');
  } else {
    // Detect audio codec with optional channel config (e.g. DDP2.0, TrueHD7.1, AAC2.0)
    const audChMatch = remaining.match(/\b(DDP|TrueHD|Atmos|DTS-HD\s*MA|DTS-HD|DTS(?::?X)?|AAC|AC3|EAC3|FLAC|PCM|MP3|WMA|OPUS)(\d+\.\d+|\d+)\b/i);
    if (audChMatch) {
      result.audioCodec = audChMatch[1].toUpperCase();
      remaining = remaining.replace(audChMatch[0], ' ');
    } else {
      for (const ac of AUDIO_CODECS) {
        const re = new RegExp(`\\b${ac.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
        if (re.test(remaining)) {
          result.audioCodec = ac;
          remaining = remaining.replace(re, ' ');
          break;
        }
      }
    }
  }
  // Sweep any remaining audio tokens out of `remaining` (e.g. "Atmos" sitting next to "DDP5.1")
  // so they don't pollute the title. We don't overwrite an already-captured audioCodec.
  for (const ac of AUDIO_CODECS) {
    const re = new RegExp(`\\b${ac.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'gi');
    remaining = remaining.replace(re, ' ');
  }
  remaining = remaining.replace(/\s+/g, ' ');

  // If the name is a multi-season container (e.g. "S1-S3" / "1-4季"), suppress loose
  // fallback patterns so a stray digit isn't misread as season/episode.
  const isSeasonRangeContainer =
    /[Ss]\d{1,2}\s*[-~—–]\s*[Ss]?\d{1,2}\b/.test(remaining) ||
    /(?:第\s*)?\d{1,2}\s*[-~—–]\s*\d{1,2}\s*季/.test(remaining);

  // Detect season/episode
  for (const { re, si, ei, eei, fallback } of SEASON_EP_PATTERNS) {
    if (fallback && isSeasonRangeContainer) continue;
    const m = remaining.match(re);
    if (m) {
      const sNum = si != null ? parseInt(m[si]) : NaN;
      result.season = Number.isFinite(sNum) ? sNum : null;
      const eNum = ei != null ? parseInt(m[ei]) : NaN;
      result.episode = Number.isFinite(eNum) ? eNum : null;
      if (eei != null && m[eei]) {
        const epEnd = parseInt(m[eei]);
        if (Number.isFinite(epEnd)) {
          result.episodeEnd = epEnd;
          result.isMultiEpisode = true;
        }
      }
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // Chinese-numeral fallback for standalone "第X季" / "第X集|话|回" (X may be CJK numerals).
  if (result.season === null) {
    const sM = remaining.match(/第\s*([零一二三四五六七八九十\d]{1,4})\s*季/);
    if (sM) {
      const n = chineseToInt(sM[1]);
      if (n != null) {
        result.season = n;
        remaining = remaining.replace(sM[0], ' ').replace(/\s+/g, ' ');
      }
    }
  }
  if (result.episode === null) {
    const eM = remaining.match(/第\s*([零一二三四五六七八九十\d]{1,4})\s*[集話话回]/);
    if (eM) {
      const n = chineseToInt(eM[1]);
      if (n != null) {
        result.episode = n;
        remaining = remaining.replace(eM[0], ' ').replace(/\s+/g, ' ');
      }
    }
  }

  // Media type from S/E
  if (result.season !== null || result.episode !== null) {
    result.mediaType = 'tv';
  }

  // Detect year (also strip trailing 年 if present, e.g. "2001年")
  const yearMatch = remaining.match(/\b((?:19|20)\d{2})(?:年(?=[\s.]|$)|\b)/);
  if (yearMatch) {
    result.year = yearMatch[1];
    remaining = remaining.replace(yearMatch[0], ' ').replace(/\s+/g, ' ');
  }

  // Late fallback: if releaseGroup wasn't captured early, retry on whatever remains.
  if (!result.releaseGroup) {
    const rgMatch = remaining.match(/[-.]\s*([A-Za-z][A-Za-z0-9]{1,9})\s*$/);
    if (rgMatch && !RESOLUTIONS.includes(rgMatch[1]) && !SOURCES.includes(rgMatch[1])) {
      result.releaseGroup = rgMatch[1];
      remaining = remaining.slice(0, -rgMatch[0].length);
    }
  }

  // Clean up remaining to extract title.
  // Dot/underscore are word separators in Plex/Emby-style names ("A.Record.Of.Mortals" → "A Record Of Mortals"),
  // so convert them to spaces instead of splitting on them.
  remaining = remaining
    .replace(/[\[\]【】\(\)（）]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  result.title = remaining;

  // Remove common garbage from title
  result.title = result.title
    .replace(/\b(COMPLETE|PROPER|REPACK|EXTENDED|UNCUT|DC|Director's\s*Cut|Theatrical)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If title has both CJK and a trailing ASCII segment, drop the ASCII (foreign/English alias).
  // e.g. "飞驰人生 Pegasus" → "飞驰人生", "你好，李焕英 Hi, Mom" → "你好，李焕英".
  if (/[一-鿿]/.test(result.title)) {
    const cjkOnly = result.title.replace(/\s+[A-Za-z][\w\s,'.:!?-]*$/, '').trim();
    if (cjkOnly) result.title = cjkOnly;
  }

  // If no media type yet, default to movie
  if (!result.mediaType) result.mediaType = 'movie';

  logger.debug('Parser', `解析: ${filename}`, JSON.stringify(result));
  return result;
}

// Detect structural patterns for media type.
// `videoExts` is an iterable of lowercase extensions (without the dot), supplied by the caller
// from config_organize.video_extensions so this stays consistent with the filtering layer.
export function detectMediaTypeFromStructure(files, folderName, videoExts) {
  // Check folder name for season/episode hints
  if (/[Ss]\d{1,2}|第\d+季|[Ss]eason\s*\d/i.test(folderName)) return 'tv';

  const extSet = videoExts instanceof Set ? videoExts : new Set(videoExts);
  const videoFiles = files.filter(f => extSet.has(f.split('.').pop()?.toLowerCase()));
  if (videoFiles.length > 1) {
    // Multiple video files → likely TV
    const hasSE = videoFiles.some(f => {
      const p = parseFilename(f);
      return p.season !== null || p.episode !== null;
    });
    if (hasSE) return 'tv';
    // Sequential numbering
    const nums = videoFiles.map(f => {
      const m = f.match(/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    }).filter(n => n > 0);
    if (nums.length >= 2 && nums.every((n, i) => i === 0 || n >= nums[i - 1])) return 'tv';
  }

  return 'movie';
}

export function detectLanguage(filename) {
  const langPatterns = [
    { re: /\.(chs|chi|zh|cn|sc|简|中文|chs)/i, lang: 'chs' },
    { re: /\.(cht|tc|繁)/i, lang: 'cht' },
    { re: /\.(eng|en|英文|英)/i, lang: 'eng' },
    { re: /\.(jpn|jp|ja|日文|日)/i, lang: 'jpn' },
    { re: /\.(kor|kr|ko|韩文|韩)/i, lang: 'kor' },
  ];
  for (const { re, lang } of langPatterns) {
    if (re.test(filename)) return lang;
  }
  return '';
}
