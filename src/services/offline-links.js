/**
 * 从任意文本中提取可作为 115 离线任务的下载链接。
 * 支持：HTTP、HTTPS、FTP、磁力链(magnet:?xt=...)、电驴(ed2k://|file|...)。
 * 排除：115 分享链接（115/115cdn/anxia 域下的 /s/<code> 形式），它走转存流程，不是离线下载。
 */

// 各类协议的链接匹配。\S+ 会一直贪到空白，足以覆盖含查询串与片段的长链接
const URL_PATTERNS = [
  /https?:\/\/\S+/gi,
  /ftp:\/\/\S+/gi,
  /magnet:\?[^\s]+/gi,
  /ed2k:\/\/\|[^\s]+\|\//gi,
];

// 与 services/115.js parseShareLink 的域名集合保持一致
const SHARE_HOST_RE = /^https?:\/\/(?:115|115cdn|anxia)\.com\/s\//i;

/**
 * 提取文本中的所有离线下载链接。
 * - 去掉尾部常见标点（中英文逗号/句号/分号、右括号、引号等），避免把"链接后面的标点"算进 URL
 * - 去重（保持首次出现顺序）
 * - 排除 115 分享链接
 *
 * @param {string} text
 * @returns {string[]} 唯一链接数组
 */
export function extractOfflineLinks(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const re of URL_PATTERNS) {
    const matches = String(text).match(re) || [];
    for (let m of matches) {
      // 把链接尾部的标点修剪掉（这些字符在 URL 里出现概率极低）
      m = m.replace(/[)\]，。；,;.'"`>}】）]+$/u, '');
      if (!m) continue;
      if (SHARE_HOST_RE.test(m)) continue;
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
