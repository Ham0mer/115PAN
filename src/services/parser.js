import { logger } from './logger.js';

// 常见技术规格关键字表。匹配时按出现顺序优先（更具体的形式应当在前面）。
const RESOLUTIONS = ['2160p', '1080p', '720p', '480p', '4K', '2K', '8K'];
const SOURCES = ['BluRay', 'BLURAY', 'Blu-ray', 'WEB-DL', 'WEBDL', 'WEBRip', 'HDTV', 'DVD', 'Remux', 'REMUX', 'Encode', 'BDRip', 'BRRip', 'HDRip', 'TC', 'TS', 'CAM'];
const CODECS = ['H.264', 'H264', 'H.265', 'H265', 'H.266', 'H266', 'AV1', 'AVC', 'HEVC', 'X264', 'x264', 'X265', 'x265', 'VP9', 'MPEG-4', 'MPEG2'];
const AUDIO_CODECS = ['DDP', 'DDP5.1', 'DDP7.1', 'TrueHD', 'TrueHD7.1', 'Atmos', 'DTS', 'DTS-HD', 'DTS-HDMA', 'DTS:X', 'AAC', 'AC3', 'EAC3', 'FLAC', 'PCM', 'MP3', 'WMA', 'OPUS'];

// 季/集匹配规则表，按从严到宽顺序尝试。
// 每条规则字段：
//   re   : 正则
//   si   : season 捕获组索引（null = 不抓季号）
//   ei   : episode 捕获组索引
//   eei  : episodeEnd 捕获组索引（双集/区间）
//   fallback: 是否为宽松规则；遇到"S1-S3"这类多季合集名称时跳过宽松规则，
//             以免一个零散数字被误读成季/集
const SEASON_EP_PATTERNS = [
  { re: /[Ss](\d{1,3})\s*[Ee](\d{1,3})(?:[Ee-](\d{1,3}))?/,                                    si: 1, ei: 2, eei: 3 },
  { re: /[Ss](\d{1,3})\.?[Ee](\d{1,3})(?:[Ee-](\d{1,3}))?/,                                    si: 1, ei: 2, eei: 3 },
  // "1x02" 写法（Plex/Emby 的替代格式）
  { re: /\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/,                                                     si: 1, ei: 2, eei: null },
  { re: /第(\d{1,3})[季]?\s*第(\d{1,3})[集話话](?:[-~至]第?(\d{1,3})[集話话])?/,               si: 1, ei: 2, eei: 3 },
  { re: /[Ss]eason\s*(\d{1,3})[\s.]*[Ee]p?(?:isode)?\s*(\d{1,3})(?:[-~](\d{1,3}))?/i,         si: 1, ei: 2, eei: 3 },
  // 仅集号（无季号）：si 为 null。这些是宽松规则，在季范围容器中需跳过
  { re: /[Ee][Pp]?\s*(\d{1,3})(?:[-~](\d{1,3}))?/,                                             si: null, ei: 1, eei: 2, fallback: true },
  { re: /^(\d{1,3})[\.\-\s]+(?=\D)/,                                                            si: null, ei: 1, eei: null, fallback: true },
];

// 简易中文数字表：用于解析 "第十二集"、"第二十三话" 这类汉字数字
const CN_NUM = { '零':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };

/**
 * 把汉字数字（最多到百以内）转为整数。
 * 处理形态：
 * - 纯阿拉伯数字直接 parseInt；
 * - "十" → 10；
 * - "十X" → 10+X；"X十" → X*10；"X十Y" → X*10+Y；
 * - 其它逐字累乘（兜底）。
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
 * 应对从网页粘贴出来的"2160​p"、"H​265"等被零宽空格分隔的字符串，
 * 否则后面的正则将彻底匹配不上。
 */
function toHalfwidth(s) {
  if (!s) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x3000) { out += ' '; continue; }            // 全角空格 → 半角空格
    if (code >= 0xFF01 && code <= 0xFF5E) { out += String.fromCharCode(code - 0xFEE0); continue; }
    // 去除：零宽空格/连接符、方向标记、BOM
    if (code === 0xFEFF || (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E)) continue;
    out += s[i];
  }
  return out;
}

/**
 * 文件名解析主入口。
 * 按"剥洋葱"策略，从外向内依次抽取并剔除已识别字段，最后剩下的字符串视为 title。
 *
 * 抽取顺序（顺序很重要，调整需谨慎）：
 * 1) 规范化（全角→半角）
 * 2) 去扩展名
 * 3) 抓显式 TMDB ID（[tmdb-xxxxx] / {tmdb-xxxxx} 等）
 * 4) 去广告括号（【...】）、URL、中文 release 标签、帧率等噪声
 * 5) HDR / 分辨率 / 来源 / 视频编码 / 位深 / 发布组 / 音频
 * 6) 季集（区分多季容器避免误判）
 * 7) 年份
 * 8) 兜底 release group
 * 9) 残余字符串 → title，做收尾清理
 *
 * @returns {Object} 平坦对象：title/year/season/episode/episodeEnd/resolution/source/
 *   videoCodec/bitDepth/hdr/audioCodec/audioCount/releaseGroup/mediaType/isMultiEpisode/tmdbId
 */
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

  // 全角→半角，例如 "Ｓ０１Ｅ０１.２１６０Ｐ" 正常化为 "S01E01.2160P"
  let remaining = toHalfwidth(filename);

  // 去扩展名（如 .mp4 / .mkv）
  const extMatch = remaining.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : '';
  if (extMatch) remaining = remaining.slice(0, -extMatch[0].length);

  // 抓显式 TMDB ID：[tmdb-575219]、{tmdb-575219}、[tmdbid575219] 等多种写法。
  // 必须在"去括号噪声"之前做，否则 id 会跟着括号一起被擦掉。
  const tmdbIdMatch = remaining.match(/[\[\{(]\s*tmdb(?:id)?[-_\s]*?(\d{2,8})\s*[\]\})]/i);
  if (tmdbIdMatch) {
    result.tmdbId = tmdbIdMatch[1];
    remaining = remaining.replace(tmdbIdMatch[0], ' ').replace(/\s+/g, ' ');
  }

  // 去 【...】 风格的广告（常见于国内压制：【高清影视之家发布 www.HDBTHD.com】）
  remaining = remaining.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ');
  // 去 www.xxx.com 形式的 URL
  remaining = remaining.replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi, ' ').replace(/\s+/g, ' ');
  // 去包含中文的 [...] 标签（如 [60帧率版本][高码版][国语配音+中文字幕]）
  remaining = remaining.replace(/\[[^\]]*[一-鿿][^\]]*\]/g, ' ').replace(/\s+/g, ' ');
  // 去常见的中文 release 元信息标签
  remaining = remaining.replace(/无台标|有台标|国粤双语|国英双语|中日双语|中英双语|粤英双语|中文字幕|中英字幕|简中字幕|繁中字幕|国语配音|粤语配音|英语配音|日语配音|韩语配音|国语音轨|粤语音轨|高码版|低码版|加长版|导演剪辑版|剧场版|修复版|重制版|无删减|未删减|无水印|去水印|完整版|先行版|预售版/g, ' ').replace(/\s+/g, ' ');
  // 去帧率（60fps / 24fps）与质量标签（HQ/LQ）
  remaining = remaining.replace(/\b\d{2,3}\s*fps\b/gi, ' ').replace(/\b(?:HQ|LQ|HighQuality|LowQuality)\b/g, ' ').replace(/\s+/g, ' ');

  // HDR 探测：HDR / HDR10 / HDR10+ / HLG / Dolby Vision / DoVi
  if (/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/i.test(remaining)) {
    result.hdr = remaining.match(/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/i)[0];
    remaining = remaining.replace(/\b(HDR|HDR10|HDR10\+|HLG|Dolby\s*Vision|DoVi)\b/gi, ' ').replace(/\s+/g, ' ');
  }

  // 分辨率（大小写不敏感，例如 "1080P" 也能命中 "1080p"）
  for (const r of RESOLUTIONS) {
    const re = new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(remaining)) {
      result.resolution = r;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // 片源（BluRay/WEB-DL/...）
  for (const s of SOURCES) {
    const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
    if (re.test(remaining)) {
      result.source = s;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // 视频编码
  for (const c of CODECS) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
    if (re.test(remaining)) {
      result.videoCodec = c;
      remaining = remaining.replace(re, ' ').replace(/\s+/g, ' ');
      break;
    }
  }

  // 位深（8bit/10bit/12bit）
  const bdMatch = remaining.match(/\b(\d{1,2})\s*bit\b/i);
  if (bdMatch) {
    result.bitDepth = bdMatch[1] + 'bit';
    remaining = remaining.replace(/\d{1,2}\s*bit/i, ' ');
  }

  // 先尝试在末尾抓发布组（"-FRDS" 之类），放在音频前面做，否则音频规则可能贪婪吃进去。
  const rgEarly = remaining.match(/[-]\s*([A-Za-z][A-Za-z0-9]{1,9})\s*$/);
  if (rgEarly && !RESOLUTIONS.includes(rgEarly[1]) && !SOURCES.includes(rgEarly[1])) {
    result.releaseGroup = rgEarly[1];
    remaining = remaining.slice(0, -rgEarly[0].length);
  }

  // 音频编码与声轨数。
  // 优先识别 "2 Audios DDP5.1" 这种带计数的标签。
  const audMatch = remaining.match(/(\d+)\s*Audios?\s*([A-Za-z][A-Za-z0-9.+:]*?)(?=[\s.\-]|$)/i);
  if (audMatch) {
    result.audioCount = audMatch[1];
    result.audioCodec = audMatch[2].trim();
    remaining = remaining.replace(/\d+\s*Audios?\s*[A-Za-z][A-Za-z0-9.+:]*/i, ' ');
  } else {
    // 再识别带声道数的形式（如 DDP2.0 / TrueHD7.1 / AAC2.0）
    const audChMatch = remaining.match(/\b(DDP|TrueHD|Atmos|DTS-HD\s*MA|DTS-HD|DTS(?::?X)?|AAC|AC3|EAC3|FLAC|PCM|MP3|WMA|OPUS)(\d+\.\d+|\d+)\b/i);
    if (audChMatch) {
      result.audioCodec = audChMatch[1].toUpperCase();
      remaining = remaining.replace(audChMatch[0], ' ');
    } else {
      // 兜底：扫表匹配纯编码名
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
  // 再扫一遍把残余的音频关键字（如 DDP5.1 旁的 Atmos）清出 remaining，
  // 避免污染最终 title；已经抓到的 audioCodec 不会被改写。
  for (const ac of AUDIO_CODECS) {
    const re = new RegExp(`\\b${ac.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'gi');
    remaining = remaining.replace(re, ' ');
  }
  remaining = remaining.replace(/\s+/g, ' ');

  // 多季合集检测：如果文件名包含 "S1-S3" 或 "1-4季"，则后面解析季集时跳过 fallback 宽松规则，
  // 避免名字里的零散数字被误识别成集号。
  const isSeasonRangeContainer =
    /[Ss]\d{1,2}\s*[-~—–]\s*[Ss]?\d{1,2}\b/.test(remaining) ||
    /(?:第\s*)?\d{1,2}\s*[-~—–]\s*\d{1,2}\s*季/.test(remaining);

  // 季集匹配：从严到宽
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

  // 中文数字兜底：上一步如果还没抓到季号/集号，尝试匹配"第X季"、"第X集|话|回"
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

  // 出现季或集号即判定为剧集
  if (result.season !== null || result.episode !== null) {
    result.mediaType = 'tv';
  }

  // 年份（兼容 "2001年" 的尾标）
  const yearMatch = remaining.match(/\b((?:19|20)\d{2})(?:年(?=[\s.]|$)|\b)/);
  if (yearMatch) {
    result.year = yearMatch[1];
    remaining = remaining.replace(yearMatch[0], ' ').replace(/\s+/g, ' ');
  }

  // releaseGroup 二次兜底：前面没抓到，从最终残余末尾再试一次
  if (!result.releaseGroup) {
    const rgMatch = remaining.match(/[-.]\s*([A-Za-z][A-Za-z0-9]{1,9})\s*$/);
    if (rgMatch && !RESOLUTIONS.includes(rgMatch[1]) && !SOURCES.includes(rgMatch[1])) {
      result.releaseGroup = rgMatch[1];
      remaining = remaining.slice(0, -rgMatch[0].length);
    }
  }

  // 收尾清理：
  // Plex/Emby 风格用 . 或 _ 当词分隔（如 "A.Record.Of.Mortals"），统一转空格而非删除，
  // 否则单词会粘在一起。括号类全部转空格；零散的 4 位年份再去一次（前面可能漏抓）。
  remaining = remaining
    .replace(/[\[\]【】\(\)（）]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  result.title = remaining;

  // title 清理：去掉发行修饰词（COMPLETE/PROPER/REPACK/EXTENDED/UNCUT/DC 等）
  result.title = result.title
    .replace(/\b(COMPLETE|PROPER|REPACK|EXTENDED|UNCUT|DC|Director's\s*Cut|Theatrical)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 若 title 同时含中文和尾部 ASCII 段，剥掉 ASCII 段（多是英文别名）。
  // 例如 "飞驰人生 Pegasus" → "飞驰人生"。
  if (/[一-鿿]/.test(result.title)) {
    const cjkOnly = result.title.replace(/\s+[A-Za-z][\w\s,'.:!?-]*$/, '').trim();
    if (cjkOnly) result.title = cjkOnly;
  }

  // 仍未确定类型则默认按电影处理
  if (!result.mediaType) result.mediaType = 'movie';

  logger.debug('Parser', `解析: ${filename}`, JSON.stringify(result));
  return result;
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
 *
 * @param {string[]} files 同目录下的文件名列表
 * @param {string} folderName 包含目录名
 * @param {Iterable<string>} videoExts 视频扩展名集合（来自 config_organize，保持与过滤层一致）
 */
export function detectMediaTypeFromStructure(files, folderName, videoExts) {
  // 文件夹名出现季集线索 → 直接判定为剧集
  if (/[Ss]\d{1,2}|第\d+季|[Ss]eason\s*\d/i.test(folderName)) return 'tv';

  const extSet = videoExts instanceof Set ? videoExts : new Set(videoExts);
  const videoFiles = files.filter(f => extSet.has(f.split('.').pop()?.toLowerCase()));
  if (videoFiles.length > 1) {
    // 多个视频文件：很可能是剧集
    const hasSE = videoFiles.some(f => {
      const p = parseFilename(f);
      return p.season !== null || p.episode !== null;
    });
    if (hasSE) return 'tv';
    // 文件名中含连续递增数字 → 也按剧集处理
    const nums = videoFiles.map(f => {
      const m = f.match(/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    }).filter(n => n > 0);
    if (nums.length >= 2 && nums.every((n, i) => i === 0 || n >= nums[i - 1])) return 'tv';
  }

  return 'movie';
}

/**
 * 从文件名后缀检测字幕语言：
 * - chs/chi/zh/cn/sc/简/中文 → chs
 * - cht/tc/繁 → cht
 * - eng/en/英文/英 → eng
 * - jpn/jp/ja/日文/日 → jpn
 * - kor/kr/ko/韩文/韩 → kor
 * 未命中返回空串。
 */
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
