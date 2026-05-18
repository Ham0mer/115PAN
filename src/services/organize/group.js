import { logger } from '../logger.js';
import { parseFilename } from '../parser.js';
import { extOf, stemOf, parseExts, VIDEO_EXTS_DEFAULT, META_EXTS_DEFAULT } from './util.js';

/**
 * 过滤文件：仅保留视频或元数据扩展名；视频还需达到 min_video_size_mb。
 * 副作用：在文件对象上标注 _ext/_isVideo/_isMeta 以便后续分组无需重复判断。
 */
export function filterFiles(files, cfg) {
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

/**
 * 把过滤后的文件聚合为"媒体单元"组：
 * - 处于子目录中的文件按 parentCid 聚合；
 * - 直接位于源根目录的文件按 (title, year) 子分组；
 * - 嵌套目录：按直接父目录归组。
 * 过滤掉无视频的"孤儿元数据组"。
 */
export function groupFiles(files, cfg) {
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

  for (const subgroup of subgroupRootFiles(rootFiles, cfg)) {
    groups.push({ kind: 'root', parentCid: cfg.source_cid, folderName: '', ...subgroup });
  }

  return groups.filter(g => g.videos.length > 0);
}

/**
 * 把根级散文件按文件名解析出的 (title, year) 聚合成桶。
 * 元数据通过文件名"主干前缀互相包含"匹配到对应视频桶；单桶兜底。
 */
function subgroupRootFiles(files, cfg) {
  const videos = files.filter(f => f._isVideo);
  const metas = files.filter(f => f._isMeta);
  if (!videos.length) return [];

  const buckets = new Map();
  for (const v of videos) {
    const p = parseFilename(v.name);
    const key = `${(p.title || '').toLowerCase()}|${p.year || ''}`;
    if (!buckets.has(key)) buckets.set(key, { parsed: p, videos: [], metas: [] });
    buckets.get(key).videos.push(v);
  }

  for (const m of metas) {
    const stem = stemOf(m.name).toLowerCase();
    let hit = null;
    for (const [, b] of buckets) {
      if (b.videos.some(v => {
        const vs = stemOf(v.name).toLowerCase();
        return stem.startsWith(vs) || vs.startsWith(stem);
      })) { hit = b; break; }
    }
    if (!hit && buckets.size === 1) hit = [...buckets.values()][0];
    if (hit) hit.metas.push(m);
  }

  return [...buckets.values()];
}

/**
 * 把元数据文件（字幕/nfo 等）匹配到具体集。
 * 优先按解析出来的 S/E 严格相等；否则按 stem 前缀互相包含兜底。
 */
export function matchMetasToEpisode(ep, allMetas) {
  return allMetas.filter(m => {
    const parsed = parseFilename(m.name);
    if (parsed.season != null && parsed.episode != null) {
      return parsed.season === ep.season && parsed.episode === ep.episode;
    }
    const vs = stemOf(ep.video.name);
    const ms = stemOf(m.name);
    return ms.startsWith(vs) || vs.startsWith(ms);
  });
}
