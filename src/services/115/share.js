import { logger } from '../logger.js';
import { fetch115Api, getActiveCookie } from './client.js';

/**
 * 解析 115 分享链接，提取 shareCode 与 receiveCode。
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
 * 服务端返回"无需重复接收/已接收"视为成功并标记 alreadyTransferred=true。
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
