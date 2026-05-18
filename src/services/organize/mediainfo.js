import { logger } from '../logger.js';
import { getMediaInfo } from '../ffprobe.js';

/**
 * 调用 ffprobe 抽取媒体技术规格。未启用或失败时返回空对象，不打断流程。
 */
export async function extractMediaInfo(video, cfg) {
  if (!cfg.ffprobe_enabled) return {};
  try {
    return await getMediaInfo(video.id) || {};
  } catch (err) {
    logger.debug('Organizer', `ffprobe 跳过 ${video.name}: ${err.message}`);
    return {};
  }
}

/**
 * 文件名解析结果与 ffprobe 结果合并：ffprobe 有值的字段覆盖文件名解析的同名字段。
 */
export function mergeMediaInfo(parsed, probe) {
  const out = { ...parsed };
  for (const [k, v] of Object.entries(probe || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * 把分辨率串（如 "1080p"）转为可比较的数值（提取首段数字）。
 */
export function resolutionScore(r) {
  if (!r) return 0;
  const m = String(r).match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

/** Remux/BluRay 类高码率源头判定。 */
export function isRemuxLike(info) {
  return /remux|bluray|blu-ray/i.test(info?.source || '');
}

/** 含 TrueHD/Atmos/Dolby 字样视为杜比音轨。 */
export function hasDolby(info) {
  return /truehd|atmos|dolby/i.test(info?.audioCodec || '');
}
