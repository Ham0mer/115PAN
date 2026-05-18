import { logger } from '../logger.js';
import { fetch115Api, sleep, getOpDelayMs, WRITE_OP_DELAY_MS, DELETE_OP_DELAY_MS, getActiveCookie } from './client.js';

/**
 * 把 115 files 接口返回的一条原始 item 归一化为业务层友好的对象。
 * 规则：fid 存在 → 文件；fid 不存在但 cid 存在 → 文件夹。
 */
export function normalizeItem(item, parentCid) {
  const isFolder = !item.fid && (item.cid != null);
  return {
    id: isFolder ? String(item.cid) : String(item.fid),
    name: item.n || item.file_name || item.name || '',
    isFolder,
    size: Number(item.s || item.file_size || 0),
    parentCid: String(parentCid),
    raw: item,
  };
}

/**
 * 从 115 响应中提取 items 数组。
 * 115 接口有多种响应结构：data 直接是数组 / data.list / 顶层 list / data.files。
 */
function extractItems(data) {
  let raw = data?.data ?? data?.list;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const nested = raw.list ?? raw.files ?? raw.data;
    if (Array.isArray(nested)) return nested;
  }
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

/**
 * 列出单个目录（不递归）。cid='0' 表示根目录。
 * 自动分页（每页 1000）。onlyFolders=true 时仅返回子目录。
 */
export async function listFolder(cid, { onlyFolders = false } = {}) {
  if (!getActiveCookie()) throw new Error('未登录115账号');
  const all = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const ts = Date.now();
    const url = `https://webapi.115.com/files?aid=1&cid=${encodeURIComponent(cid)}&o=user_ptime&asc=0&offset=${offset}&limit=${limit}&show_dir=1&snap=0&natsort=1&format=json&_t=${ts}`;
    const data = await fetch115Api(url);
    const items = extractItems(data);
    if (!items.length) break;
    for (const it of items) {
      const n = normalizeItem(it, cid);
      if (onlyFolders && !n.isFolder) continue;
      all.push(n);
    }
    offset += items.length;
    if (items.length < limit) break;
    const total = Number(data?.count || data?.total || 0);
    if (total && offset >= total) break;
    await sleep(getOpDelayMs());
  }
  return all;
}

export const listFolders = (cid = '0') => listFolder(cid, { onlyFolders: true });
export const listFiles = (cid) => listFolder(cid, { onlyFolders: false });

/**
 * 获取单个文件的详细信息（含 pickcode、mtime 等）。
 */
export async function getFileInfo(fileId) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files?aid=1&file_id=${encodeURIComponent(fileId)}&format=json&_t=${ts}`;
  return fetch115Api(url);
}

/**
 * 批量重命名。pairs 接受 [[fileId, newName], ...] 或 [{id|fileId, name|newName}, ...]
 */
export async function renameFiles(pairs) {
  const norm = (pairs || [])
    .map(p => Array.isArray(p) ? p : [p.id ?? p.fileId, p.name ?? p.newName])
    .filter(([id, name]) => id && name);
  if (!norm.length) return null;
  const url = 'https://webapi.115.com/files/batch_rename';
  const body = new URLSearchParams();
  for (const [id, name] of norm) body.append(`files_new_name[${id}]`, name);
  const res = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await sleep(WRITE_OP_DELAY_MS);
  return res;
}

export async function renameFile(fileId, newName) {
  return renameFiles([[fileId, newName]]);
}

/**
 * 批量移动文件到同一个目标 cid。
 */
export async function moveFiles(fileIds, targetCid) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds])
    .map(v => v == null ? '' : String(v))
    .filter(Boolean);
  if (!ids.length) return null;
  const url = 'https://webapi.115.com/files/move';
  const body = new URLSearchParams();
  ids.forEach((id, i) => body.append(`fid[${i}]`, id));
  body.append('pid', String(targetCid));
  const res = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await sleep(WRITE_OP_DELAY_MS);
  return res;
}

export async function moveFile(fileId, targetCid) {
  return moveFiles([fileId], targetCid);
}

/**
 * 在 parentCid 下创建一个子目录。返回 { cid, name, raw }。
 */
export async function createFolder(parentCid, folderName) {
  const url = 'https://webapi.115.com/files/add';
  const body = new URLSearchParams({ pid: String(parentCid), cname: folderName }).toString();
  const data = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  await sleep(WRITE_OP_DELAY_MS);
  const cid = data.cid || data.data?.cid || data.data?.file_id || data.data?.fid;
  if (!cid) throw new Error('创建目录失败：响应缺少 cid');
  return { cid: String(cid), name: folderName, raw: data };
}

/**
 * 批量移入回收站。
 */
export async function moveToRecycleBatch(fileIds) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds])
    .map(v => v == null ? '' : String(v))
    .filter(Boolean);
  if (!ids.length) return null;
  const url = 'https://webapi.115.com/rb/delete';
  const body = new URLSearchParams();
  ids.forEach((id, i) => body.append(`fid[${i}]`, id));
  const res = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await sleep(WRITE_OP_DELAY_MS);
  return res;
}

export async function moveToRecycle(fileId) {
  return moveToRecycleBatch([fileId]);
}

/** deleteFile 是 moveToRecycle 的别名（115 没有真正"硬删除"接口）。 */
export async function deleteFile(fileId) {
  return moveToRecycle(fileId);
}

/**
 * 删除文件夹（移入回收站）。必须显式带 ignore_warn=1。
 */
export async function deleteFolder(cid, parentCid) {
  const qs = parentCid ? `?pid=${encodeURIComponent(parentCid)}` : '';
  const url = `https://webapi.115.com/rb/delete${qs}`;
  const body = new URLSearchParams();
  body.append('fid[0]', String(cid));
  body.append('ignore_warn', '1');
  const res = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await sleep(DELETE_OP_DELAY_MS);
  return res;
}

/**
 * 获取文件 CDN 下载链接，主要给 ffprobe 流式读取用。
 */
export async function getDownloadUrl(fileId) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/download?pickcode=${encodeURIComponent(fileId)}&_t=${ts}`;
  return fetch115Api(url);
}

/**
 * 文件搜索（在某个目录及其子目录中按关键字搜索）。
 */
export async function searchFiles(keyword, cid = '0') {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/search?search_value=${encodeURIComponent(keyword)}&cid=${encodeURIComponent(cid)}&offset=0&limit=100&format=json&_t=${ts}`;
  return fetch115Api(url);
}

/**
 * 根据 cid 取目录的绝对路径链（115 内部的目录链表示）。
 */
export async function getFolderPath(cid) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/get_path?cid=${encodeURIComponent(cid)}&_t=${ts}`;
  return fetch115Api(url);
}

/**
 * 把单个路径段清洗为 115 能接受的目录名。
 */
export function sanitizeSegment(seg) {
  return String(seg ?? '').replace(/[\/\\:*?"<>|]/g, '').trim();
}

/**
 * 在 parentCid 下按名称查找一个子目录。命中返回 cid，否则 null。
 * 若传入 cache（FolderTreeCache），优先走内存缓存。
 */
export async function findFolderByName(parentCid, name, cache = null) {
  if (!name) return null;
  if (cache) {
    const hit = cache.child(parentCid, name);
    if (hit) return hit;
  }
  const folders = await listFolder(parentCid, { onlyFolders: true });
  const hit = folders.find(f => f.name === name);
  return hit ? hit.id : null;
}

/**
 * 沿路径段链确保目录存在；不存在则逐层创建，返回末端 cid。
 */
export async function ensureFolderPath(parentCid, segments, cache = null) {
  let cid = String(parentCid);
  if (cache) {
    const { cid: startCid, remaining } = cache.resolvePath(cid, segments);
    cid = startCid;
    for (const seg of remaining) {
      const created = await createFolder(cid, seg);
      cache.add(cid, seg, created.cid);
      cid = created.cid;
    }
    return cid;
  }
  for (const seg of segments) {
    const safe = sanitizeSegment(seg);
    if (!safe) continue;
    const existing = await findFolderByName(cid, safe);
    cid = existing ? existing : (await createFolder(cid, safe)).cid;
  }
  return cid;
}

/**
 * 获取非根目录的元数据（含 pick_code）。pickcode 是 downfolders/downfiles 的鉴权凭据。
 */
export async function getFolderInfo(cid) {
  const ts = Date.now();
  const url = `https://webapi.115.com/category/get?cid=${encodeURIComponent(cid)}&_t=${ts}`;
  return fetch115Api(url);
}
