import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { UA_APPLE_TV, UA_CHROME, getActiveCookie } from './client.js';

export { getActiveCookie };

/**
 * 获取登录二维码 token。返回 uid、time、sign 与二维码图片 URL。
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
 * 轮询二维码状态。data.status：0=待扫码，1=已扫码待确认，2=已确认，-1/-2=过期/异常。
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
 * 保存新的 Cookie 到数据库：旧 active → replaced；新记录 → active；清理 7 天前 replaced。
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
  db.prepare("DELETE FROM cookies_115 WHERE status='replaced' AND updated_at < datetime('now','-7 days','localtime')").run();
  logger.info('115', `Cookie已保存，用户: ${userInfo.user_name}`);
  return getActiveCookie();
}

/**
 * 校验 Cookie 是否仍然有效。
 * 仅在错误消息明显指向认证（cookie/登录/失效/401/403）时才判失效；网络抖动视为 transient。
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
