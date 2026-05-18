import { logger } from '../logger.js';
import {
  listFolder, deleteFolder, getFolderInfo,
  listAllSubFolders, listAllSubFiles,
} from '../115.js';
import { extOf, parseExts, getConfig, VIDEO_EXTS_DEFAULT, META_EXTS_DEFAULT } from './util.js';

/**
 * 清理空目录的入口。优先快速路径，失败回退慢速路径。
 *
 * 判定一个文件是否"算数"（阻止目录被删）：
 *   - 必须是媒体扩展名，否则视为垃圾（如 .DS_Store/Thumbs.db）
 *   - 视频必须 ≥ min_video_size_mb（与 filterFiles 一致）
 */
export async function cleanupEmptyFolders(rootCid) {
  const cfg = getConfig();
  const videoExts = new Set(parseExts(cfg?.video_extensions, VIDEO_EXTS_DEFAULT));
  const metaExts = new Set(parseExts(cfg?.meta_extensions, META_EXTS_DEFAULT));
  const minSize = (Number(cfg?.min_video_size_mb) || 0) * 1024 * 1024;

  const keepsFolder = (name, size) => {
    const e = extOf(name);
    if (videoExts.has(e)) return !(minSize > 0 && Number(size || 0) < minSize);
    return metaExts.has(e);
  };

  try {
    await cleanupEmptyFoldersFast(rootCid, keepsFolder);
    return;
  } catch (err) {
    logger.warn('Organizer', `快速清理空目录失败，回退到逐目录递归: ${err.message}`);
  }
  await cleanupEmptyFoldersSlow(rootCid, keepsFolder);
}

/**
 * 快速清理：downfolders + downfiles 两次 API 拿到子树骨架与文件父目录映射，
 * 在内存里 rollup 每个目录的 keepCount，找出"顶层空分支"批量删除。
 */
async function cleanupEmptyFoldersFast(rootCid, keepsFolder) {
  const rootStr = String(rootCid);
  const info = await getFolderInfo(rootStr);
  const pickcode = info?.pick_code || info?.pickcode || info?.data?.pick_code;
  if (!pickcode) throw new Error('未取得根目录 pickcode');

  const [folders, files] = await Promise.all([
    listAllSubFolders(pickcode),
    listAllSubFiles(pickcode),
  ]);

  const nodeById = new Map();
  nodeById.set(rootStr, { name: `根目录#${rootStr}`, parentId: null, children: [], keepCount: 0, subtreeKeep: 0 });
  for (const f of folders) {
    const id = String(f.fid || f.cid || f.id || '');
    if (!id) continue;
    const name = String(f.fn || f.n || f.name || '');
    const pid = String(f.pid || f.parent_id || rootStr);
    nodeById.set(id, { name, parentId: pid, children: [], keepCount: 0, subtreeKeep: 0 });
  }
  for (const [id, node] of nodeById) {
    if (id === rootStr) continue;
    const parent = nodeById.get(node.parentId);
    if (parent) parent.children.push(id);
  }
  let droppedJunk = 0;
  for (const f of files) {
    const pid = String(f.pid || f.parent_id || '');
    const node = nodeById.get(pid);
    if (!node) continue;
    const fname = String(f.fn || f.n || f.name || f.file_name || '');
    const fsize = Number(f.fs || f.s || f.size || f.file_size || 0);
    if (keepsFolder(fname, fsize)) node.keepCount++;
    else droppedJunk++;
  }
  function rollup(id) {
    const node = nodeById.get(id);
    if (!node) return 0;
    let n = node.keepCount;
    for (const c of node.children) n += rollup(c);
    node.subtreeKeep = n;
    return n;
  }
  rollup(rootStr);

  const emptyBranches = [];
  function visit(id, parentIsEmpty) {
    const node = nodeById.get(id);
    if (!node) return;
    const isEmpty = node.subtreeKeep === 0;
    if (id !== rootStr && isEmpty && !parentIsEmpty) {
      emptyBranches.push({ id, parentId: node.parentId, name: node.name });
    }
    for (const c of node.children) visit(c, isEmpty || parentIsEmpty);
  }
  for (const c of nodeById.get(rootStr).children) visit(c, false);

  logger.info('Organizer', `[fast-cleanup] 树规模: ${nodeById.size - 1} 目录 / ${files.length} 文件 (忽略垃圾/过小视频 ${droppedJunk}); 待删空分支: ${emptyBranches.length}`);

  for (const b of emptyBranches) {
    logger.info('Organizer', `删除空文件夹分支: ${b.name} cid=${b.id}`);
    try {
      await deleteFolder(b.id, b.parentId);
    } catch (err) {
      logger.warn('Organizer', `删除失败: ${b.name} cid=${b.id} - ${err.message}`);
    }
  }
}

/**
 * 慢速清理：递归遍历，子树内没有"算数文件"就把整个目录回收。
 * 返回值 hasKeep 用于回溯告诉父节点"我这枝有不可丢弃的文件"。
 */
async function cleanupEmptyFoldersSlow(rootCid, keepsFolder) {
  async function walk(cid, parentCid, name) {
    let items;
    try {
      items = await listFolder(cid);
    } catch (err) {
      logger.warn('Organizer', `空文件夹清理：列目录失败 ${name || ''} cid=${cid}`, err.message);
      return true;
    }
    let hasKeep = false;
    for (const it of items) {
      if (it.isFolder) {
        const subHasKeep = await walk(it.id, cid, it.name);
        if (subHasKeep) hasKeep = true;
      } else if (keepsFolder(it.name, it.size)) {
        hasKeep = true;
      }
    }
    if (parentCid != null && !hasKeep) {
      logger.info('Organizer', `删除无有效媒体的子文件夹: ${name} cid=${cid}`);
      try {
        await deleteFolder(cid, parentCid);
      } catch (err) {
        logger.warn('Organizer', `删除空文件夹失败: ${name} cid=${cid}`, err.message);
      }
    }
    return hasKeep;
  }
  await walk(String(rootCid), null, `根目录#${rootCid}`);
}
