import { getDb } from './db.js';
import { logger } from './logger.js';

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

export async function renameFile(fileId, newName) {
  const url = 'https://webapi.115.com/files/batch_rename';
  // 115 batch_rename takes files_new_name[FID]=NEWNAME
  const body = new URLSearchParams();
  body.append(`files_new_name[${fileId}]`, newName);
  return fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

export async function moveFile(fileId, targetCid) {
  const url = 'https://webapi.115.com/files/move';
  const body = new URLSearchParams();
  body.append('fid[0]', String(fileId));
  body.append('pid', String(targetCid));
  return fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

export async function createFolder(parentCid, folderName) {
  const url = 'https://webapi.115.com/files/add';
  const body = new URLSearchParams({ pid: String(parentCid), cname: folderName }).toString();
  const data = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  // Response may be { state, cid, cname } or { state, data: { ... } }
  const cid = data.cid || data.data?.cid || data.data?.file_id || data.data?.fid;
  if (!cid) throw new Error('创建目录失败：响应缺少 cid');
  return { cid: String(cid), name: folderName, raw: data };
}

export async function moveToRecycle(fileId) {
  const url = 'https://webapi.115.com/rb/delete';
  const body = new URLSearchParams();
  body.append('fid[0]', String(fileId));
  return fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
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
  return fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
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

// Find a folder by name under parent; return the folder's cid or null.
export async function findFolderByName(parentCid, name) {
  if (!name) return null;
  const folders = await listFolder(parentCid, { onlyFolders: true });
  const hit = folders.find(f => f.name === name);
  return hit ? hit.id : null;
}

// Get or create a chain of folders. segments: ['电影', '国产', '2023'] => returns final cid.
export async function ensureFolderPath(parentCid, segments) {
  let cid = String(parentCid);
  for (const seg of segments) {
    if (!seg) continue;
    const safe = String(seg).replace(/[\/\\:*?"<>|]/g, '').trim();
    if (!safe) continue;
    const existing = await findFolderByName(cid, safe);
    if (existing) {
      cid = existing;
    } else {
      const created = await createFolder(cid, safe);
      cid = created.cid;
    }
  }
  return cid;
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
export async function listFilesRecursive(rootCid, { maxDepth = 8, onItem } = {}) {
  const result = [];
  async function walk(cid, depth, pathSegs) {
    if (depth > maxDepth) return;
    const items = await listFolder(cid, { onlyFolders: false });
    const folders = items.filter(i => i.isFolder);
    const files = items.filter(i => !i.isFolder);
    logger.debug('115', `listFolder(${cid}) depth=${depth} → ${folders.length} 文件夹, ${files.length} 文件`);
    for (const it of items) {
      if (it.isFolder) {
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
