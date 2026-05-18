import { logger } from '../logger.js';
import { fetch115Api, getActiveCookie } from './client.js';

/**
 * 获取离线下载的会话签名（web 接口必需）。短期有效。
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
 * 批量添加 115 离线下载任务。支持 HTTP/HTTPS/FTP/磁力/电驴。
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
