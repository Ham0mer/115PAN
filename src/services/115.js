import { getDb } from './db.js';
import { logger } from './logger.js';

function getOpDelayMs() {
  try {
    const row = getDb().prepare('SELECT operation_delay_sec FROM config_organize WHERE id=1').get();
    return Math.max(0, Number(row?.operation_delay_sec) || 0) * 1000;
  } catch {
    return 0;
  }
}

// 每次写操作（move/rename/delete/create）后的小延时，避免风控
const WRITE_OP_DELAY_MS = 1200;
const DELETE_OP_DELAY_MS = 1500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UA_APPLE_TV = 'Mozilla/5.0 (Apple TV; CPU tvOS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36';

export function getActiveCookie() {
  const db = getDb();
  return db.prepare("SELECT * FROM cookies_115 WHERE status='active' ORDER BY updated_at DESC LIMIT 1").get();
}

// Normalize 115 webapi response: success when state is truthy (1 / true), failure with err.
function checkResponse(data) {
  // 115 webapi returns either { state: 1 } or { state: true }; failure has state=false/0
  const ok = data && (data.state === 1 || data.state === true);
  if (!ok) {
    const code = data?.code || data?.errno || '';
    const msg = data?.message || data?.error || data?.msg || '115 API 返回错误';
    const err = new Error(`${msg}${code ? ` (code: ${code})` : ''}`);
    err.code = code;
    err.responseData = data;
    throw err;
  }
  return data;
}

// Whether a 115 error should be retried. Cookie / auth errors should NOT retry.
function isRetriableError(err) {
  if (err instanceof SyntaxError) return false;
  const code = String(err?.code ?? '');
  if (code === 'PARSE_ERROR') return false;
  if (code === '40101' || code === '40110' || code === '40102') return false;
  if (code === '911') return false;
  return true;
}

export async function fetch115Api(url, options = {}, retries = 3) {
  const cookie = getActiveCookie();
  const headers = {
    'User-Agent': UA_APPLE_TV,
    'Accept': 'application/json',
    'Referer': 'https://115.com/',
    ...(cookie ? { 'Cookie': cookie.cookie_str } : {}),
    ...options.headers,
  };

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        const delay = Math.pow(2, i) * 2000;
        logger.warn('115API', `风控限制，${delay}ms 后重试 (${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        lastErr = new Error(`115 API 限速 (429)，已重试 ${i + 1}/${retries} 次`);
        continue;
      }
      if (res.status >= 500) {
        throw new Error(`115 HTTP ${res.status}`);
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const preview = text.slice(0, 200);
        const err = new Error(`115 API 返回非JSON响应 (HTTP ${res.status}): ${preview}`);
        err.code = 'PARSE_ERROR';
        throw err;
      }
      return checkResponse(data);
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || i === retries - 1) {
        throw err;
      }
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  throw lastErr;
}

// ----- QR login (mirrors 示例.js) -----

export async function fetchQrToken(appName = 'apple_tv') {
  const url = `https://qrcodeapi.115.com/api/1.0/${appName}/1.0/token`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_APPLE_TV, 'Accept': 'application/json' } });
  const data = await res.json();
  if (data.state !== 1 || !data.data) throw new Error(data.message || '获取二维码Token失败');
  const { uid, time, sign } = data.data;
  return { uid, time, sign, qrcode: `https://qrcodeapi.115.com/api/1.0/${appName}/1.0/qrcode?uid=${encodeURIComponent(uid)}` };
}

export async function fetchQrStatus(uid, time, sign) {
  const qs = new URLSearchParams({ uid: String(uid), time: String(time), sign: String(sign) });
  const url = `https://qrcodeapi.115.com/get/status/?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_APPLE_TV, 'Accept': 'application/json' } });
  const data = await res.json();
  if (data.state !== 1 || !data.data) throw new Error(data.message || '检查扫码状态异常');
  return data.data;
}

export async function fetchQrLoginResult(uid, appName = 'apple_tv') {
  const url = `https://passportapi.115.com/app/1.0/${appName}/1.0/login/qrcode`;
  const body = `account=${encodeURIComponent(uid)}&app=${appName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA_CHROME, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    body,
  });
  const data = await res.json();
  if (data._cookie_header) return String(data._cookie_header);
  if (data.data?.cookie) {
    return Object.entries(data.data.cookie).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  throw new Error(data.message || data.error || '未拿到Cookie');
}

export async function fetch115UserInfo(cookieStr, appName = 'apple_tv') {
  const ts = Date.now();
  const url = `https://passportapi.115.com/app/1.0/${appName}/26.0/user/base_info?_t=${ts}`;
  const res = await fetch(url, {
    headers: { 'Cookie': cookieStr, 'Referer': 'https://115.com/', 'User-Agent': UA_APPLE_TV, 'Accept': '*/*', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.state !== 1 || !data.data) throw new Error(data.message || '获取用户信息失败');
  return data.data;
}

export function saveCookie(cookieStr, userInfo) {
  const db = getDb();
  db.prepare("UPDATE cookies_115 SET status='replaced', updated_at=datetime('now','localtime') WHERE status='active'").run();
  db.prepare(`INSERT INTO cookies_115
      (cookie_str, user_id, user_name, face_m, size_used, size_total, size_used_raw, size_total_raw, vip_info, status)
      VALUES (?,?,?,?,?,?,?,?,?, 'active')`)
    .run(
      cookieStr,
      String(userInfo.user_id || ''),
      userInfo.user_name || '',
      userInfo.face?.face_m || '',
      userInfo.size_used || '',
      userInfo.size_total || '',
      Number(userInfo.size_used_raw) || 0,
      Number(userInfo.size_total_raw) || 0,
      userInfo.vip_info ? JSON.stringify(userInfo.vip_info) : null,
    );
  // Purge replaced cookies older than 7 days
  db.prepare("DELETE FROM cookies_115 WHERE status='replaced' AND updated_at < datetime('now','-7 days','localtime')").run();
  logger.info('115', `Cookie已保存，用户: ${userInfo.user_name}`);
  return getActiveCookie();
}

export async function verifyCookie(cookieStr) {
  try {
    const info = await fetch115UserInfo(cookieStr);
    return { valid: true, info };
  } catch (err) {
    // Only mark invalid for definitive auth failures, not transient network errors.
    if (/cookie|登录|未登录|失效|401|403/i.test(err.message)) {
      return { valid: false, reason: err.message };
    }
    return { valid: true, transient: true, reason: err.message };
  }
}

export function expireCookie(id) {
  const db = getDb();
  db.prepare("UPDATE cookies_115 SET status='expired', updated_at=datetime('now','localtime') WHERE id=?").run(id);
}

// ----- File / folder listing -----

// Normalize a single item from 115 `files` API into { id, name, isFolder, size, parentCid }.
export function normalizeItem(item, parentCid) {
  // Folders: cid present, no fid. Files: fid present.
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

// Normalize the items array out of a 115 API response.
// 115 returns either { data: [...] } or (rarely) { data: { list: [...] }, list: [...] }.
function extractItems(data) {
  let raw = data?.data ?? data?.list;
  if (Array.isArray(raw)) return raw;
  // Nested format: data is an object; look for a list inside it.
  if (raw && typeof raw === 'object') {
    const nested = raw.list ?? raw.files ?? raw.data;
    if (Array.isArray(nested)) return nested;
  }
  // Last resort: top-level list field.
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

// Page through one folder. cid='0' = root.
export async function listFolder(cid, { onlyFolders = false } = {}) {
  if (!getActiveCookie()) throw new Error('未登录115账号');
  const all = [];
  let offset = 0;
  const limit = 1000;
  // 115 caps page size around 1150; keep at 1000.
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
    await new Promise(r => setTimeout(r, Math.min(getOpDelayMs(), 1500)));
  }
  return all;
}

// Backwards-compatible aliases
export const listFolders = (cid = '0') => listFolder(cid, { onlyFolders: true });
export const listFiles = (cid) => listFolder(cid, { onlyFolders: false });

export async function getFileInfo(fileId) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files?aid=1&file_id=${encodeURIComponent(fileId)}&format=json&_t=${ts}`;
  return fetch115Api(url);
}

// Batch rename. pairs: [[fileId, newName], ...] or [{id|fileId, name|newName}, ...]
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

// Batch move. fileIds: string|string[]; all files go to the same target cid.
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

export async function createFolder(parentCid, folderName) {
  const url = 'https://webapi.115.com/files/add';
  const body = new URLSearchParams({ pid: String(parentCid), cname: folderName }).toString();
  const data = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  await sleep(WRITE_OP_DELAY_MS);
  // Response may be { state, cid, cname } or { state, data: { ... } }
  const cid = data.cid || data.data?.cid || data.data?.file_id || data.data?.fid;
  if (!cid) throw new Error('创建目录失败：响应缺少 cid');
  return { cid: String(cid), name: folderName, raw: data };
}

// Batch recycle. fileIds: string|string[].
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

export async function deleteFile(fileId) {
  return moveToRecycle(fileId);
}

export async function deleteFolder(cid, parentCid) {
  const qs = parentCid ? `?pid=${encodeURIComponent(parentCid)}` : '';
  const url = `https://webapi.115.com/rb/delete${qs}`;
  const body = new URLSearchParams();
  body.append('fid[0]', String(cid));
  // 115 的 rb/delete 接口：文件夹下若残留子目录（即使没有文件），
  // ignore_warn=0 会被服务端的二次确认提示挡住而无法删除。
  body.append('ignore_warn', '1');
  const res = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await sleep(DELETE_OP_DELAY_MS);
  return res;
}

export async function getDownloadUrl(fileId) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/download?pickcode=${encodeURIComponent(fileId)}&_t=${ts}`;
  return fetch115Api(url);
}

export async function searchFiles(keyword, cid = '0') {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/search?search_value=${encodeURIComponent(keyword)}&cid=${encodeURIComponent(cid)}&offset=0&limit=100&format=json&_t=${ts}`;
  return fetch115Api(url);
}

export async function getFolderPath(cid) {
  const ts = Date.now();
  const url = `https://webapi.115.com/files/get_path?cid=${encodeURIComponent(cid)}&_t=${ts}`;
  return fetch115Api(url);
}

function sanitizeSegment(seg) {
  return String(seg ?? '').replace(/[\/\\:*?"<>|]/g, '').trim();
}

// Find a folder by name under parent; return the folder's cid or null.
// Optional `cache` skips the API call when present.
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

// Get or create a chain of folders. segments: ['电影', '国产', '2023'] => returns final cid.
// If `cache` is provided, existing folders are resolved from memory and only missing
// segments cause a createFolder call; the cache is updated as new folders are created.
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

// In-memory mirror of a 115 folder subtree, populated via the bulk
// /files/downfolders endpoint. Lets ensureFolderPath / findFolderByName
// resolve known paths without any API call.
export class FolderTreeCache {
  constructor(rootCid) {
    this.rootCid = String(rootCid);
    // cid -> { name, parentId, children: Map<sanitizedName, cid> }
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

  // Resolve as many segments as possible from cache. Returns the cid reached
  // and the remaining segments that need to be created.
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

// ----- Share link transfer -----

// Parse a 115 share URL like https://115.com/s/<code>?password=<code>
export function parseShareLink(link) {
  if (!link) return null;
  const text = String(link).trim();
  const m = text.match(/https?:\/\/(?:115|115cdn|anxia)\.com\/s\/(\w+)\?password=(\w+)/i);
  if (!m) return null;
  return { shareCode: m[1], receiveCode: m[2] };
}

// Page through the top-level entries of a share.
export async function fetchShareSnap(shareCode, receiveCode) {
  const all = [];
  const limit = 20;
  let shareInfo = null;
  let offset = 0;
  while (true) {
    const url = `https://webapi.115.com/share/snap?share_code=${encodeURIComponent(shareCode)}&receive_code=${encodeURIComponent(receiveCode)}&offset=${offset}&limit=${limit}&cid=`;
    const data = await fetch115Api(url);
    shareInfo = data?.data?.shareinfo || shareInfo;
    const list = Array.isArray(data?.data?.list) ? data.data.list : [];
    if (!list.length) break;
    all.push(...list);
    const count = Number(data?.data?.count || 0);
    offset += list.length;
    if (count && offset >= count) break;
    if (list.length < limit) break;
  }
  return { shareInfo, list: all };
}

// Transfer all top-level entries of a share into targetCid. targetCid '0' = root.
export async function transferShareLink(link, targetCid = '0') {
  const parsed = parseShareLink(link);
  if (!parsed) throw new Error('链接格式错误，正确格式：https://115.com/s/<code>?password=<code>');
  const cookie = getActiveCookie();
  if (!cookie) throw new Error('未登录115账号');
  const userId = cookie.user_id;
  if (!userId) throw new Error('无法获取用户ID，请重新登录');

  const { shareInfo, list } = await fetchShareSnap(parsed.shareCode, parsed.receiveCode);
  if (!list.length) throw new Error('分享链接中未找到任何文件');
  const fileIds = list.map(item => String(item.fid || item.cid)).filter(Boolean);
  if (!fileIds.length) throw new Error('未能提取到文件ID');

  const body = new URLSearchParams({
    user_id: String(userId),
    share_code: parsed.shareCode,
    receive_code: parsed.receiveCode,
    file_id: fileIds.join(','),
    cid: String(targetCid || '0'),
  }).toString();

  try {
    const result = await fetch115Api('https://webapi.115.com/share/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    logger.info('115', `转存成功 share=${parsed.shareCode} files=${fileIds.length} → cid=${targetCid}`);
    return { success: true, shareInfo, fileCount: fileIds.length, targetCid: String(targetCid || '0'), result };
  } catch (err) {
    const errMsg = err?.responseData?.error || err?.message || '';
    if (/无需重复接收|已接收/.test(errMsg)) {
      logger.info('115', `分享已转存过 share=${parsed.shareCode}`);
      return { success: true, shareInfo, fileCount: fileIds.length, targetCid: String(targetCid || '0'), alreadyTransferred: true };
    }
    throw err;
  }
}

// List videos / metas recursively. maxDepth guards against pathological structures.
// Strategy:
//   1. Fast: one downfolders + one downfiles call expose the full tree. distinct(downfiles.pid)
//      gives every folder that actually contains files (downfiles.pid == downfolders.fid).
//      We then listFolder ONLY those folders to obtain real filenames. Intermediate folders
//      with no direct files are visited entirely in-memory (no API call).
//   2. Slow fallback: original per-folder DFS, in case the bulk endpoints reject or root has
//      no pickcode (cid=0).
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

// Hybrid scanner: bulk tree + targeted listFolder on leaf folders that hold files.
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

  // Distinct parent folders that hold direct files
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
    // Reads need only mild pacing; the user's operation_delay_sec is tuned for writes
    // and would otherwise blow up scan time on flat libraries.
    const delay = Math.min(getOpDelayMs(), 1500);
    if (delay > 0) await sleep(delay);
  }
  logger.info('115', `[fast-scan] 完成 ${done}/${targetsArr.length} 用时 ${Date.now() - t0}ms，文件 ${result.length}`);
  return result;
}

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
        await new Promise(r => setTimeout(r, Math.min(getOpDelayMs(), 1500)));
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

// ----- Fast bulk tree listing via 115 download-manager API -----

// Get folder metadata (incl. pick_code) for a non-root cid.
export async function getFolderInfo(cid) {
  const ts = Date.now();
  const url = `https://webapi.115.com/category/get?cid=${encodeURIComponent(cid)}&_t=${ts}`;
  return fetch115Api(url);
}

function pickField(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Paginated GET against /app/chrome/downfolders or /app/chrome/downfiles.
// Returns the flat list of raw items across all pages.
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

// Bulk tree walker. Two paginated calls (folders + files) plus one /category/get for root,
// then path reconstruction in-memory via parent_id. Returns same shape as listFilesRecursiveSlow.
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

  // Build dir tree: id -> { name, parentId }
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
    const entry = {
      id,
      name,
      isFolder: false,
      size,
      parentCid: pid,
      raw: f,
      depth,
      pathSegs,
    };
    result.push(entry);
    if (onItem) onItem(entry);
  }
  return result;
}
