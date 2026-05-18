import { logger } from '../logger.js';
import { fetch115Api, getOpDelayMs, sleep, pickField } from './client.js';
import { listFolder, getFolderInfo, sanitizeSegment } from './files.js';

/**
 * 一个 115 目录子树的内存镜像。
 * 通过 /files/downfolders 接口一次性拉取子文件夹扁平列表，在内存中重建父子结构，
 * 让 ensureFolderPath / findFolderByName 离线命中已存在的路径。
 */
export class FolderTreeCache {
  constructor(rootCid) {
    this.rootCid = String(rootCid);
    // cid → { name, parentId, children: Map<sanitizedName, cid> }
    this.byId = new Map();
    this.byId.set(this.rootCid, { name: '', parentId: null, children: new Map() });
  }

  async load() {
    const info = await getFolderInfo(this.rootCid);
    const pickcode = String(
      pickField(info, 'pick_code', 'pickcode', 'pc') ||
      pickField(info?.data || {}, 'pick_code', 'pickcode', 'pc') || ''
    );
    if (!pickcode) throw new Error(`FolderTreeCache: 未取得根 cid=${this.rootCid} 的 pickcode`);
    const folders = await listAllSubFolders(pickcode);
    for (const f of folders) {
      const id = String(pickField(f, 'fid', 'cid', 'id') || '');
      const name = String(pickField(f, 'fn', 'n', 'name') || '');
      const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || this.rootCid);
      if (!id) continue;
      this.byId.set(id, { name, parentId: pid, children: new Map() });
    }
    for (const [id, node] of this.byId) {
      if (id === this.rootCid) continue;
      const parent = this.byId.get(node.parentId);
      if (parent) parent.children.set(node.name, id);
    }
    logger.debug('115', `FolderTreeCache loaded root=${this.rootCid} folders=${this.byId.size - 1}`);
    return this;
  }

  child(parentCid, name) {
    const safe = sanitizeSegment(name);
    if (!safe) return undefined;
    const node = this.byId.get(String(parentCid));
    if (!node) return undefined;
    return node.children.get(name) || node.children.get(safe);
  }

  add(parentCid, name, cid) {
    const pid = String(parentCid);
    const id = String(cid);
    const safe = sanitizeSegment(name) || String(name);
    this.byId.set(id, { name: safe, parentId: pid, children: new Map() });
    const parent = this.byId.get(pid);
    if (parent) parent.children.set(safe, id);
  }

  resolvePath(parentCid, segments) {
    let cid = String(parentCid);
    const segs = (segments || []).map(sanitizeSegment).filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const c = this.child(cid, segs[i]);
      if (c) {
        cid = c;
      } else {
        return { cid, remaining: segs.slice(i) };
      }
    }
    return { cid, remaining: [] };
  }
}

/**
 * 对 /files/downfolders 或 /files/downfiles 做分页抓取并合并。
 * 每页 5000 条；翻页之间走 op delay 节流。
 */
async function fetchAllPages(endpoint, pickcode) {
  const all = [];
  let page = 1;
  const perPage = 5000;
  while (true) {
    const url = `https://webapi.115.com/files/${endpoint}?pickcode=${encodeURIComponent(pickcode)}&page=${page}&per_page=${perPage}`;
    const data = await fetch115Api(url);
    const list = Array.isArray(data?.data?.list) ? data.data.list
      : Array.isArray(data?.list) ? data.list
      : Array.isArray(data?.data) ? data.data
      : [];
    if (list.length) all.push(...list);
    const hasNext = pickField(data?.data || {}, 'has_next_page') ?? pickField(data, 'has_next_page');
    const count = Number(pickField(data?.data || {}, 'count', 'total') ?? pickField(data, 'count', 'total') ?? 0);
    if (list.length < perPage) {
      if (hasNext === true) {
        page += 1;
        await sleep(getOpDelayMs());
        continue;
      }
      break;
    }
    if (count && all.length >= count) break;
    page += 1;
    await sleep(getOpDelayMs());
  }
  return all;
}

export async function listAllSubFolders(pickcode) {
  return fetchAllPages('downfolders', pickcode);
}

export async function listAllSubFiles(pickcode) {
  return fetchAllPages('downfiles', pickcode);
}

/**
 * 递归列出某目录下的所有文件。
 * 1) 快速路径（非根目录）：listFilesRecursiveHybrid；
 * 2) 慢速回退：逐目录 DFS。
 */
export async function listFilesRecursive(rootCid, { maxDepth = 8, onItem } = {}) {
  const cidStr = String(rootCid);
  if (cidStr !== '0') {
    try {
      return await listFilesRecursiveHybrid(cidStr, { maxDepth, onItem });
    } catch (err) {
      logger.warn('115', `快速源扫描失败，回退到逐目录递归: ${err.message}`);
    }
  }
  return listFilesRecursiveSlow(cidStr, { maxDepth, onItem });
}

/**
 * 混合扫描：downfolders + downfiles 拿全树骨架与文件父目录集合；
 * 只对实际包含文件的叶子目录调 listFolder 拿真实文件名。
 */
async function listFilesRecursiveHybrid(rootCid, { maxDepth = 8, onItem } = {}) {
  const rootStr = String(rootCid);
  const info = await getFolderInfo(rootStr);
  const pickcode = String(
    pickField(info, 'pick_code', 'pickcode', 'pc') ||
    pickField(info?.data || {}, 'pick_code', 'pickcode', 'pc') || ''
  );
  if (!pickcode) throw new Error('未取得根 pickcode');

  const [folders, files] = await Promise.all([
    listAllSubFolders(pickcode),
    listAllSubFiles(pickcode),
  ]);

  const dirById = new Map();
  dirById.set(rootStr, { name: '', parentId: null });
  for (const f of folders) {
    const id = String(pickField(f, 'fid', 'cid', 'id') || '');
    if (!id) continue;
    const name = String(pickField(f, 'fn', 'n', 'name') || '');
    const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || rootStr);
    dirById.set(id, { name, parentId: pid });
  }

  const segsCache = new Map();
  function segsFor(cid) {
    if (cid === rootStr) return [];
    const cached = segsCache.get(cid);
    if (cached) return cached;
    const segs = [];
    let cur = cid, safety = 64;
    while (cur && cur !== rootStr && safety-- > 0) {
      const node = dirById.get(cur);
      if (!node) break;
      segs.unshift(node.name);
      cur = node.parentId;
    }
    segsCache.set(cid, segs);
    return segs;
  }

  const targets = new Set();
  for (const f of files) {
    const pid = String(pickField(f, 'pid', 'parent_id') || '');
    if (!pid) continue;
    if (pid !== rootStr && !dirById.has(pid)) continue;
    targets.add(pid);
  }

  const targetsArr = [...targets];
  logger.info('115', `[fast-scan] 总目录=${dirById.size - 1} downfiles=${files.length} 待扫含文件目录=${targets.size}`);

  const result = [];
  const t0 = Date.now();
  let done = 0;
  for (const pid of targetsArr) {
    const segs = pid === rootStr ? [] : segsFor(pid);
    const depth = segs.length;
    if (depth > maxDepth) { done++; continue; }
    const callStart = Date.now();
    const label = segs.length ? segs[segs.length - 1] : `cid=${pid}`;
    logger.info('115', `[fast-scan] (${done + 1}/${targetsArr.length}) → ${label}`);
    let items;
    try {
      items = await listFolder(pid, { onlyFolders: false });
    } catch (err) {
      logger.warn('115', `[fast-scan] listFolder(${pid}) 失败 用时${Date.now() - callStart}ms: ${err.message}`);
      done++;
      continue;
    }
    const fileCount = items.filter(it => !it.isFolder).length;
    for (const it of items) {
      if (it.isFolder) continue;
      const entry = { ...it, depth, pathSegs: [...segs] };
      result.push(entry);
      if (onItem) onItem(entry);
    }
    done++;
    logger.info('115', `[fast-scan]   ← ${fileCount} 文件 用时${Date.now() - callStart}ms`);
    const delay = getOpDelayMs();
    if (delay > 0) await sleep(delay);
  }
  logger.info('115', `[fast-scan] 完成 ${done}/${targetsArr.length} 用时 ${Date.now() - t0}ms，文件 ${result.length}`);
  return result;
}

/**
 * 慢速递归：朴素 DFS。用于快速路径失败或扫根目录（cid='0' 没有 pickcode）的场景。
 */
async function listFilesRecursiveSlow(rootCid, { maxDepth = 8, onItem } = {}) {
  const result = [];
  async function walk(cid, depth, pathSegs) {
    if (depth > maxDepth) return;
    const items = await listFolder(cid, { onlyFolders: false });
    const folders = items.filter(i => i.isFolder);
    const files = items.filter(i => !i.isFolder);
    logger.debug('115', `listFolder(${cid}) depth=${depth} → ${folders.length} 文件夹, ${files.length} 文件`);
    for (const it of items) {
      if (it.isFolder) {
        await sleep(getOpDelayMs());
        await walk(it.id, depth + 1, [...pathSegs, it.name]);
      } else {
        const entry = { ...it, depth, pathSegs: [...pathSegs] };
        result.push(entry);
        if (onItem) onItem(entry);
      }
    }
  }
  await walk(String(rootCid), 0, []);
  return result;
}

/**
 * 纯快速实现：两次分页 API + 一次根目录 /category/get，path 重建全在内存。
 * 文件名直接来自 downfiles 响应。返回结构与 listFilesRecursiveSlow 一致。
 */
export async function listFilesRecursiveFast(rootCid, { maxDepth = 8, onItem } = {}) {
  const cidStr = String(rootCid);
  const rootInfo = await getFolderInfo(cidStr);
  const rootPickcode = String(
    pickField(rootInfo, 'pick_code', 'pickcode', 'pc') ||
    pickField(rootInfo?.data || {}, 'pick_code', 'pickcode', 'pc') || ''
  );
  if (!rootPickcode) throw new Error('未取得根目录 pickcode');

  const [rawFolders, rawFiles] = await Promise.all([
    listAllSubFolders(rootPickcode),
    listAllSubFiles(rootPickcode),
  ]);
  logger.debug('115', `bulk tree cid=${cidStr} → ${rawFolders.length} 文件夹 + ${rawFiles.length} 文件`);

  const dirById = new Map();
  dirById.set(cidStr, { name: '', parentId: null });
  for (const f of rawFolders) {
    const id = String(pickField(f, 'fid', 'cid', 'id') || '');
    const name = String(pickField(f, 'fn', 'n', 'name') || '');
    const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || '');
    if (!id) continue;
    dirById.set(id, { name, parentId: pid || cidStr });
  }

  function ancestorsOf(id) {
    const segs = [];
    let cur = id;
    let safety = 64;
    while (cur && cur !== cidStr && safety-- > 0) {
      const node = dirById.get(cur);
      if (!node) break;
      segs.unshift(node.name);
      cur = node.parentId;
    }
    return segs;
  }

  const result = [];
  for (const f of rawFiles) {
    const id = String(pickField(f, 'fid', 'file_id', 'id') || '');
    const name = String(pickField(f, 'fn', 'n', 'file_name', 'name') || '');
    const size = Number(pickField(f, 'fs', 's', 'size', 'file_size') || 0);
    const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || cidStr);
    if (!id || !name) continue;
    const pathSegs = ancestorsOf(pid);
    const depth = pathSegs.length;
    if (depth > maxDepth) continue;
    const entry = { id, name, isFolder: false, size, parentCid: pid, raw: f, depth, pathSegs };
    result.push(entry);
    if (onItem) onItem(entry);
  }
  return result;
}
