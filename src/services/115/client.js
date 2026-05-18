import { getDb } from '../db.js';
import { logger } from '../logger.js';

/**
 * 读取 config_organize.operation_delay_sec（用户配置的写操作间隔秒数），
 * 返回毫秒数；异常或缺失则返回 0。
 * 该延迟主要用于规避 115 的频控/风控。
 */
export function getOpDelayMs() {
  try {
    const row = getDb().prepare('SELECT operation_delay_sec FROM config_organize WHERE id=1').get();
    return Math.max(0, Number(row?.operation_delay_sec) || 0) * 1000;
  } catch {
    return 0;
  }
}

// 写操作（move/rename/delete/create）后强制的最小延时，避免触发风控
export const WRITE_OP_DELAY_MS = 10000;
// 删除操作后的更长等待。115 的删除存在异步效应，过快连发容易报错
export const DELETE_OP_DELAY_MS = 10000;
// Promise 化的 sleep
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 不同 UA 用于不同接口：Apple TV 端 UA 给 webapi/qrcode 用，Chrome UA 给登录接口用
export const UA_APPLE_TV = 'Mozilla/5.0 (Apple TV; CPU tvOS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
export const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36';

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
 * 自动注入 Cookie / UA / Referer 等请求头、15s 超时、429 指数退避、5xx 重试、
 * 非 JSON 标记 PARSE_ERROR 不重试、业务失败（state=0）抛错。
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

/**
 * 从对象的若干候选键中取第一个非空值。
 * 115 不同接口对同一字段会用不同命名（fid/cid/id、fn/n/name…）。
 */
export function pickField(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
