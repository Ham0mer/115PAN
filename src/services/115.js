import { getDb } from './db.js';
import { logger } from './logger.js';

/**
 * 读取 config_organize.operation_delay_sec（用户配置的写操作间隔秒数），
 * 返回毫秒数；异常或缺失则返回 0。
 * 该延迟主要用于规避 115 的频控/风控。
 */
function getOpDelayMs() {
  try {
    const row = getDb().prepare('SELECT operation_delay_sec FROM config_organize WHERE id=1').get();
    return Math.max(0, Number(row?.operation_delay_sec) || 0) * 1000;
  } catch {
    return 0;
  }
}

// 写操作（move/rename/delete/create）后强制的最小延时，避免触发风控
const WRITE_OP_DELAY_MS = 1200;
// 删除操作后的更长等待。115 的删除存在异步效应，过快连发容易报错
const DELETE_OP_DELAY_MS = 10000;
// Promise 化的 sleep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 不同 UA 用于不同接口：Apple TV 端 UA 给 webapi/qrcode 用，Chrome UA 给登录接口用
const UA_APPLE_TV = 'Mozilla/5.0 (Apple TV; CPU tvOS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36';

/**
 * 取出当前活跃 Cookie 记录（status='active'）。
 * 若存在多条按 updated_at 倒序取最新。无可用 Cookie 时返回 undefined。
 */
export function getActiveCookie() {
  const db = getDb();
  return db.prepare("SELECT * FROM cookies_115 WHERE status='active' ORDER BY updated_at DESC LIMIT 1").get();
}

/**
 * 校验 115 webapi 的统一响应结构。
 * - 成功：data.state 为 1 或 true；
 * - 失败：state=false/0，抽出 code/message 拼装为可读错误，并把原始 data 挂在 err.responseData 上。
 */
function checkResponse(data) {
  // 115 webapi 返回 { state: 1 } 或 { state: true }；失败为 state=false/0
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

/**
 * 判断错误是否值得重试。
 * 不可重试：JSON 解析失败、Cookie/认证错误（40101/40110/40102）、911 操作风控等。
 * 这些错误重试不会变好，反而会浪费请求配额。
 */
function isRetriableError(err) {
  if (err instanceof SyntaxError) return false;
  const code = String(err?.code ?? '');
  if (code === 'PARSE_ERROR') return false;
  if (code === '40101' || code === '40110' || code === '40102') return false;
  if (code === '911') return false;
  return true;
}

/**
 * 所有 115 webapi 调用的统一入口。
 * 职责：
 * - 自动注入 Cookie / UA / Referer 等请求头；
 * - 15s 超时；
 * - 429 风控：指数退避（2s, 4s, 8s...）后重试；
 * - 5xx：抛错走重试逻辑；
 * - 非 JSON 响应：标记 PARSE_ERROR 不重试；
 * - 业务失败（state=0）：通过 checkResponse 抛错；可重试错误按 1s/2s/4s 退避重试。
 *
 * @param {string} url 完整 URL
 * @param {Object} [options] fetch 选项
 * @param {number} [retries=3] 最大重试次数
 * @returns {Promise<Object>} 成功的 JSON 对象
 */
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
        // 风控限速：指数退避后重试
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
        // 拿到 HTML/纯文本错误页等异常响应：截前 200 字符方便排查；标记 PARSE_ERROR 不重试
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
      // 普通错误重试退避：1s → 2s → 4s
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  throw lastErr;
}

// ===== 扫码登录 =====

/**
 * 获取登录二维码 token。返回 uid、time、sign 与二维码图片 URL。
 * appName 默认 apple_tv，可以选其他端（影响 UA 与登录鉴权细节）。
 */
export async function fetchQrToken(appName = 'apple_tv') {
  const url = `https://qrcodeapi.115.com/api/1.0/${appName}/1.0/token`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_APPLE_TV, 'Accept': 'application/json' } });
  const data = await res.json();
  if (data.state !== 1 || !data.data) throw new Error(data.message || '获取二维码Token失败');
  const { uid, time, sign } = data.data;
  return { uid, time, sign, qrcode: `https://qrcodeapi.115.com/api/1.0/${appName}/1.0/qrcode?uid=${encodeURIComponent(uid)}` };
}

/**
 * 轮询二维码状态。data.status 含义大致为：0=待扫码，1=已扫码待确认，2=已确认，-1/-2=过期/异常。
 * 由前端定时调用。
 */
export async function fetchQrStatus(uid, time, sign) {
  const qs = new URLSearchParams({ uid: String(uid), time: String(time), sign: String(sign) });
  const url = `https://qrcodeapi.115.com/get/status/?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_APPLE_TV, 'Accept': 'application/json' } });
  const data = await res.json();
  if (data.state !== 1 || !data.data) throw new Error(data.message || '检查扫码状态异常');
  return data.data;
}

/**
 * 扫码确认后用 uid 换取登录态 Cookie 字符串。
 * 返回形如 "USERID=...; UID=...; ..." 的整串 Cookie。
 * 优先用响应里的 _cookie_header；否则把 data.cookie 对象拼成 "k=v; k=v" 形式。
 */
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

/**
 * 拿 Cookie 反查用户信息（用户名/容量/VIP 等），用于落库展示。
 */
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

/**
 * 保存新的 Cookie 到数据库：
 * 1) 把当前 active 状态的旧记录改为 replaced；
 * 2) 插入新 Cookie 并标记 active；
 * 3) 清理超过 7 天的 replaced 历史记录；
 * 4) 返回新写入的活跃记录。
 */
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
  // 清理 7 天前的旧记录
  db.prepare("DELETE FROM cookies_115 WHERE status='replaced' AND updated_at < datetime('now','-7 days','localtime')").run();
  logger.info('115', `Cookie已保存，用户: ${userInfo.user_name}`);
  return getActiveCookie();
}

/**
 * 校验 Cookie 是否仍然有效。
 * 关键点：仅在错误消息明显指向认证（cookie/登录/失效/401/403）时才判失效；
 * 网络抖动等瞬时错误一律视为 valid+transient，避免错误地把好 Cookie 标记为过期。
 */
export async function verifyCookie(cookieStr) {
  try {
    const info = await fetch115UserInfo(cookieStr);
    return { valid: true, info };
  } catch (err) {
    if (/cookie|登录|未登录|失效|401|403/i.test(err.message)) {
      return { valid: false, reason: err.message };
    }
    return { valid: true, transient: true, reason: err.message };
  }
}

/**
 * 把指定 Cookie 标记为 expired（仅改状态，不删记录，便于回溯）。
 */
export function expireCookie(id) {
  const db = getDb();
  db.prepare("UPDATE cookies_115 SET status='expired', updated_at=datetime('now','localtime') WHERE id=?").run(id);
}

// ===== 文件/目录列表 =====

/**
 * 把 115 files 接口返回的一条原始 item 归一化为业务层友好的对象。
 * 规则：fid 存在 → 文件；fid 不存在但 cid 存在 → 文件夹。
 * @returns {{id,name,isFolder,size,parentCid,raw}}
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
 * 这里穷举常见形态以保证健壮性。
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
 * 自动分页（每页 1000，115 实际上限约 1150，留余量）。
 * @param {string} cid 目录 ID
 * @param {{onlyFolders?:boolean}} opts onlyFolders=true 时仅返回子目录
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
    // 翻页间也做小延时；读操作的延时上限封到 10s
    await new Promise(r => setTimeout(r, Math.min(getOpDelayMs(), 10000)));
  }
  return all;
}

// 向后兼容的便捷别名
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
 * 批量重命名。
 * pairs 接受两种格式：[[fileId, newName], ...] 或 [{id|fileId, name|newName}, ...]
 * 自动归一化并跳过非法项（缺 id 或缺名称）。
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
  // 写操作后小睡避免风控
  await sleep(WRITE_OP_DELAY_MS);
  return res;
}

/**
 * 单文件重命名（便捷封装）。
 */
export async function renameFile(fileId, newName) {
  return renameFiles([[fileId, newName]]);
}

/**
 * 批量移动文件到目标 cid。所有传入的文件必须移动到同一个目标目录。
 * @param {string|string[]} fileIds 单个或一组文件 ID
 * @param {string} targetCid 目标目录 cid
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

/** 单文件移动（便捷封装）。 */
export async function moveFile(fileId, targetCid) {
  return moveFiles([fileId], targetCid);
}

/**
 * 在 parentCid 下创建一个子目录。
 * 返回 { cid, name, raw }。响应里的 cid 字段可能位于不同层级，多处兜底。
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
  // 响应结构可能是 { state, cid, cname } 或 { state, data: { ... } }
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

/** 单文件移入回收站。 */
export async function moveToRecycle(fileId) {
  return moveToRecycleBatch([fileId]);
}

/** deleteFile 是 moveToRecycle 的别名（115 没有真正"硬删除"接口）。 */
export async function deleteFile(fileId) {
  return moveToRecycle(fileId);
}

/**
 * 删除文件夹（移入回收站）。
 * 必须显式带 ignore_warn=1，否则当文件夹内仍有空子目录时会被服务端的"二次确认"提示挡住。
 * 删除后等待较长（10s），因为 115 删除有异步效应。
 */
export async function deleteFolder(cid, parentCid) {
  const qs = parentCid ? `?pid=${encodeURIComponent(parentCid)}` : '';
  const url = `https://webapi.115.com/rb/delete${qs}`;
  const body = new URLSearchParams();
  body.append('fid[0]', String(cid));
  // 115 rb/delete 接口：即便子目录已空，ignore_warn=0 仍会触发服务端二次确认而失败
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
 * 注意：此处 pickcode 字段实际传的是 fileId，调用方需保证一致性。
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
 * 去除 / \ : * ? " < > | 等特殊字符并 trim。
 */
function sanitizeSegment(seg) {
  return String(seg ?? '').replace(/[\/\\:*?"<>|]/g, '').trim();
}

/**
 * 在 parentCid 下按名称查找一个子目录。
 * 命中返回其 cid，否则返回 null。
 * 若传入 cache（FolderTreeCache），优先走内存缓存，避免一次 listFolder API 调用。
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
 * 用于把 ['电影','国产','2023'] 这样的层级一次性建出来。
 *
 * 提供 cache 时：
 * - 先在缓存里走能走到的最深层，剩余段才走 createFolder；
 * - 新建出的目录同步写入缓存，下次再走相同路径就完全无 API 调用。
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
 * 一个 115 目录子树的内存镜像。
 * 通过 /files/downfolders 接口一次性拉取目标目录下所有子文件夹的扁平列表，
 * 在内存中重建父子结构。后续 ensureFolderPath / findFolderByName 可以完全离线命中已存在的路径，
 * 显著减少 API 调用次数。
 */
export class FolderTreeCache {
  /**
   * @param {string} rootCid 缓存所镜像的根目录 cid
   */
  constructor(rootCid) {
    this.rootCid = String(rootCid);
    // cid → { name, parentId, children: Map<sanitizedName, cid> }
    this.byId = new Map();
    this.byId.set(this.rootCid, { name: '', parentId: null, children: new Map() });
  }

  /**
   * 从 115 拉取全部子目录并构建索引。
   * 必须先拿到 root 的 pickcode 才能调 downfolders。
   */
  async load() {
    const info = await getFolderInfo(this.rootCid);
    const pickcode = String(
      pickField(info, 'pick_code', 'pickcode', 'pc') ||
      pickField(info?.data || {}, 'pick_code', 'pickcode', 'pc') || ''
    );
    if (!pickcode) throw new Error(`FolderTreeCache: 未取得根 cid=${this.rootCid} 的 pickcode`);
    const folders = await listAllSubFolders(pickcode);
    // 第一遍：把所有节点放进 byId
    for (const f of folders) {
      const id = String(pickField(f, 'fid', 'cid', 'id') || '');
      const name = String(pickField(f, 'fn', 'n', 'name') || '');
      const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || this.rootCid);
      if (!id) continue;
      this.byId.set(id, { name, parentId: pid, children: new Map() });
    }
    // 第二遍：根据 parentId 把每个节点挂到父节点的 children 上
    for (const [id, node] of this.byId) {
      if (id === this.rootCid) continue;
      const parent = this.byId.get(node.parentId);
      if (parent) parent.children.set(node.name, id);
    }
    logger.debug('115', `FolderTreeCache loaded root=${this.rootCid} folders=${this.byId.size - 1}`);
    return this;
  }

  /**
   * 查找 parentCid 下名为 name 的子目录 cid。
   * 同时尝试原名与 sanitize 后的名字，应对历史目录可能未清洗的情形。
   */
  child(parentCid, name) {
    const safe = sanitizeSegment(name);
    if (!safe) return undefined;
    const node = this.byId.get(String(parentCid));
    if (!node) return undefined;
    return node.children.get(name) || node.children.get(safe);
  }

  /**
   * 把一个新建的目录添加进缓存（在 ensureFolderPath 创建出新目录后调用）。
   */
  add(parentCid, name, cid) {
    const pid = String(parentCid);
    const id = String(cid);
    const safe = sanitizeSegment(name) || String(name);
    this.byId.set(id, { name: safe, parentId: pid, children: new Map() });
    const parent = this.byId.get(pid);
    if (parent) parent.children.set(safe, id);
  }

  /**
   * 从 parentCid 出发尽可能匹配 segments 路径。
   * @returns {{cid:string, remaining:string[]}} cid=能走到的最深 cid；remaining=还没建出来的剩余段
   */
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

// ===== 离线下载 =====

/**
 * 获取离线下载的会话签名（web 接口必需）。
 * 调用 /?ct=offline&ac=space 拿到一组短期有效的 sign/time，作为后续 add_task_url(s) 的鉴权参数。
 * 每次添加任务前调用一次，避免缓存过期。
 */
async function getOfflineSign() {
  const ts = Date.now();
  const url = `https://115.com/?ct=offline&ac=space&_=${ts}`;
  const data = await fetch115Api(url);
  const sign = data?.sign || data?.data?.sign;
  const time = data?.time || data?.data?.time;
  if (!sign || !time) throw new Error('获取离线签名失败：响应缺少 sign/time');
  return { sign: String(sign), time: String(time) };
}

/**
 * 批量添加 115 离线下载任务。
 * 支持 HTTP、HTTPS、FTP、磁力链(magnet)、电驴链(ed2k)。
 *
 * @param {string[]|string} urls 单个或一组链接
 * @param {string} [savePathCid] 保存到的目录 cid；缺省时落到 115 默认离线目录
 * @returns {Promise<Object>} 115 返回的原始响应，含 result 数组（每条链接的状态）
 */
export async function addOfflineUrls(urls, savePathCid) {
  const cookie = getActiveCookie();
  if (!cookie) throw new Error('未登录115账号');
  const userId = cookie.user_id;
  if (!userId) throw new Error('无法获取用户ID，请重新登录');

  const list = (Array.isArray(urls) ? urls : [urls])
    .map(s => String(s ?? '').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('未提供链接');

  const { sign, time } = await getOfflineSign();

  const url = 'https://115.com/web/lixian/?ct=lixian&ac=add_task_urls';
  const body = new URLSearchParams();
  list.forEach((u, i) => body.append(`url[${i}]`, u));
  if (savePathCid) body.append('wp_path_id', String(savePathCid));
  body.append('uid', String(userId));
  body.append('sign', sign);
  body.append('time', time);

  const data = await fetch115Api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  logger.info('115', `离线任务已提交 count=${list.length} → cid=${savePathCid || 'default'}`);
  return data;
}

// ===== 分享转存 =====

/**
 * 解析 115 分享链接，提取 shareCode（s/<code>）与 receiveCode（?password=<code>）。
 * 兼容 115/115cdn/anxia 三个主域名。无法识别返回 null。
 */
export function parseShareLink(link) {
  if (!link) return null;
  const text = String(link).trim();
  const m = text.match(/https?:\/\/(?:115|115cdn|anxia)\.com\/s\/(\w+)\?password=(\w+)/i);
  if (!m) return null;
  return { shareCode: m[1], receiveCode: m[2] };
}

/**
 * 翻页获取分享根目录下的全部条目。
 * @returns {{shareInfo, list}} shareInfo 含分享标题等元信息；list 为顶层条目数组
 */
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

/**
 * 把分享的所有顶层条目转存到目标 cid（默认根目录）。
 * 流程：解析链接 → 拿当前用户 user_id → 抓分享条目 → 拼一次 /share/receive 调用。
 *
 * 容错：若服务端返回"无需重复接收/已接收"，视为成功并标记 alreadyTransferred=true，
 * 这样 UI 可以友好提示而不是当成错误。
 */
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

/**
 * 递归列出某目录下的所有文件。
 *
 * 实现策略：
 *   1) 快速路径（非根目录）：调用 listFilesRecursiveHybrid —— 用 downfolders + downfiles
 *      两次批量调用拿全树骨架；然后只对"实际包含文件的叶子目录"调 listFolder 拿真实文件名。
 *   2) 慢速回退：逐目录 DFS。当快速路径失败（如根目录没有 pickcode）或抛错时使用。
 *
 * @param {string} rootCid 起始目录 cid
 * @param {{maxDepth?:number, onItem?:Function}} opts maxDepth=深度上限（防御病态结构）
 * @returns {Promise<Array>} 文件条目数组（含 pathSegs/depth/isFolder=false）
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
 * 混合扫描实现：
 * - 一次 downfolders 拿全部子目录骨架；一次 downfiles 拿所有文件的"所属父目录"集合；
 * - 取 distinct(downfiles.pid) 得到"真正含直接文件的目录"列表；
 * - 只对这些目录调 listFolder 拿到真实文件名（带正确大小写、扩展名）。
 *
 * 优点：中间层"只含子目录、无直接文件"的节点完全在内存中遍历，零 API 调用。
 * 对深目录树扫描性能影响巨大（实测百级目录可减少 10× 调用）。
 */
async function listFilesRecursiveHybrid(rootCid, { maxDepth = 8, onItem } = {}) {
  const rootStr = String(rootCid);
  const info = await getFolderInfo(rootStr);
  const pickcode = String(
    pickField(info, 'pick_code', 'pickcode', 'pc') ||
    pickField(info?.data || {}, 'pick_code', 'pickcode', 'pc') || ''
  );
  if (!pickcode) throw new Error('未取得根 pickcode');

  // 并发拉子目录骨架 + 文件父目录集合
  const [folders, files] = await Promise.all([
    listAllSubFolders(pickcode),
    listAllSubFiles(pickcode),
  ]);

  // 构建 cid → 节点 表
  const dirById = new Map();
  dirById.set(rootStr, { name: '', parentId: null });
  for (const f of folders) {
    const id = String(pickField(f, 'fid', 'cid', 'id') || '');
    if (!id) continue;
    const name = String(pickField(f, 'fn', 'n', 'name') || '');
    const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || rootStr);
    dirById.set(id, { name, parentId: pid });
  }

  // 给定 cid 反推从根到自身的路径段（带缓存避免重复回溯）
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

  // 真正持有文件的父目录集合
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
    // 读操作延时上限 10s：用户配置的 operation_delay_sec 是给写操作准的，
    // 直接套用到扫描会让扁平库的扫描时间爆炸性增长。
    const delay = Math.min(getOpDelayMs(), 10000);
    if (delay > 0) await sleep(delay);
  }
  logger.info('115', `[fast-scan] 完成 ${done}/${targetsArr.length} 用时 ${Date.now() - t0}ms，文件 ${result.length}`);
  return result;
}

/**
 * 慢速递归实现（兜底）：朴素 DFS 遍历每个目录调一次 listFolder。
 * 用于快速路径失败或扫根目录（cid='0' 没有 pickcode）的场景。
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
        await new Promise(r => setTimeout(r, Math.min(getOpDelayMs(), 10000)));
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

// ===== 批量树遍历（依赖 115 下载器后台接口） =====

/**
 * 获取非根目录的元数据（含 pick_code）。pickcode 是 downfolders/downfiles 的鉴权凭据。
 */
export async function getFolderInfo(cid) {
  const ts = Date.now();
  const url = `https://webapi.115.com/category/get?cid=${encodeURIComponent(cid)}&_t=${ts}`;
  return fetch115Api(url);
}

/**
 * 从对象的若干候选键中取第一个非空值。
 * 115 不同接口对同一字段会用不同命名（fid/cid/id、fn/n/name…），用此函数统一取值。
 */
function pickField(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 对 /files/downfolders 或 /files/downfiles 做分页抓取，把所有页合并为一个扁平数组。
 * 每页 5000 条；翻页之间走 op delay 节流。
 * has_next_page 与 count 互为兜底，保证收尾正确性。
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

/** 一次性拉取某目录下所有子文件夹（扁平）。 */
export async function listAllSubFolders(pickcode) {
  return fetchAllPages('downfolders', pickcode);
}

/** 一次性拉取某目录下所有文件（扁平）。 */
export async function listAllSubFiles(pickcode) {
  return fetchAllPages('downfiles', pickcode);
}

/**
 * 纯快速实现的递归列表：两次分页 API + 一次根目录 /category/get，
 * 之后所有 path 重建都在内存里完成。
 *
 * 与 listFilesRecursiveHybrid 的区别：本函数不再对叶子目录二次 listFolder，
 * 文件名直接来自 downfiles 响应（字段命名各异，由 pickField 兜底）。
 *
 * 返回结构与 listFilesRecursiveSlow 完全一致，便于上层互换。
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

  // 建立 id → { name, parentId } 索引
  const dirById = new Map();
  dirById.set(cidStr, { name: '', parentId: null });
  for (const f of rawFolders) {
    const id = String(pickField(f, 'fid', 'cid', 'id') || '');
    const name = String(pickField(f, 'fn', 'n', 'name') || '');
    const pid = String(pickField(f, 'pid', 'parent_id', 'cpid') || '');
    if (!id) continue;
    dirById.set(id, { name, parentId: pid || cidStr });
  }

  /** 根据 id 回溯到根，组装从根到自身的路径段数组。 */
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
