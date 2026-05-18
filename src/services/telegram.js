import { getDb } from './db.js';
import { logger } from './logger.js';

/**
 * 获取要使用的 Telegram Bot 配置。
 * 选择优先级：
 * 1) 显式传入的 botId（用于"测试某个 Bot"、"用指定 Bot 发自定义消息"等场景）；
 * 2) 整理配置中通过 notify_bot_id 指定的 Bot（必须 enabled=1）；
 * 3) 任意一条 enabled=1 的 Bot（取最小 id）。
 * 项目支持配置多套 Bot，整理流程使用第一选择，自定义消息可指定具体 Bot。
 */
function getBotConfig(botId) {
  const db = getDb();
  if (botId) return db.prepare('SELECT * FROM config_telegram WHERE id=?').get(botId);
  // 优先使用整理配置中绑定的 Bot；缺失或被禁用时回退到任一启用项
  const org = db.prepare('SELECT notify_bot_id FROM config_organize WHERE id=1').get();
  if (org?.notify_bot_id) {
    const chosen = db.prepare('SELECT * FROM config_telegram WHERE id=? AND enabled=1').get(org.notify_bot_id);
    if (chosen) return chosen;
  }
  return db.prepare('SELECT * FROM config_telegram WHERE enabled=1 ORDER BY id LIMIT 1').get();
}

/**
 * HTML 转义：Telegram 的 parse_mode=HTML 需要转义 & < > " ' 以避免被解析为标签。
 * 任何 null/undefined 都按空字符串处理。
 */
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 向一组 chatId 推送消息。
 * @param {string} botToken Bot Token
 * @param {string} chatIds 半角逗号分隔的多个 chat_id
 * @param {string} text HTML 文本（调用前应已转义不可信内容）
 *
 * 单个 chatId 失败仅记录日志、继续向下一个发送；10s 超时；
 * 不会向调用方抛错，确保通知失败不影响主业务。
 */
async function sendMessage(botToken, chatIds, text) {
  if (!botToken || !chatIds) return;
  const ids = chatIds.split(',').map(s => s.trim()).filter(Boolean);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (const chatId of ids) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        logger.warn('Telegram', `发送失败 chat=${chatId} status=${res.status}`, errText.slice(0, 200));
      }
    } catch (err) {
      logger.warn('Telegram', `发送失败: ${chatId}`, err.message);
    }
  }
}

/**
 * 发送测试消息，用于 Web 端"测试"按钮校验 Bot 是否可用。
 * 缺少 token/chat_ids 时抛错，便于前端给出明确反馈。
 */
export async function sendTestMessage(botId) {
  const cfg = getBotConfig(botId);
  if (!cfg?.bot_token) throw new Error('Bot Token未配置');
  if (!cfg?.chat_ids) throw new Error('Chat ID未配置');
  await sendMessage(cfg.bot_token, cfg.chat_ids, '✅ <b>测试消息</b>\n115 整理系统通知通道正常。');
  logger.info('Telegram', '测试消息已发送');
}

/**
 * 将 item 上的 resolution / source / videoCodec 字段拼成单行规格描述（用于消息显示）。
 * 缺失字段会被自动忽略，结果可能为空字符串。
 */
function fmtSpec(item) {
  const parts = [];
  if (item.resolution) parts.push(item.resolution);
  if (item.source) parts.push(Array.isArray(item.source) ? item.source.join(' ') : item.source);
  if (item.videoCodec) parts.push(item.videoCodec);
  return parts.length ? parts.join(' ') : '';
}

/**
 * 将一批剧集 items 按 season 聚合为 "S01 E01,E02 | S02 E03" 这样的展示串。
 * 用于批量入库通知，避免逐集刷屏。
 */
function episodeRangeLabel(items) {
  const grouped = new Map();
  for (const it of items) {
    if (!grouped.has(it.season)) grouped.set(it.season, []);
    grouped.get(it.season).push(it.episode);
  }
  const seasons = [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  return seasons.map(([s, eps]) => {
    // 集号去重 + 升序，避免重复入库时的杂乱顺序
    const sortedEps = [...new Set(eps)].sort((a, b) => a - b);
    return `S${String(s).padStart(2, '0')} ${sortedEps.map(e => `E${String(e).padStart(2, '0')}`).join(',')}`;
  }).join(' | ');
}

/**
 * 单文件入库成功通知（电影/单集剧/单集动漫）。
 * 受 config_telegram.enabled 与 notify_success 双重开关控制。
 */
export async function notifySuccess(item) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_success) return;

  const typeLabel = item.mediaType === 'tv' ? '剧集'
    : item.mediaType === 'anime' ? '动漫'
    : '电影';

  const lines = [
    `🎬 <b>入库成功</b>`,
    `标题: ${htmlEscape(item.title || '')}${item.year ? ` (${item.year})` : ''}`,
    `类型: ${typeLabel}`,
  ];
  if (item.tmdbId) lines.push(`TMDB: ${item.tmdbId}`);
  if (item.season != null && item.episode != null) {
    // 支持双集（E01-E02）等区间形式
    const epLabel = item.episodeEnd != null
      ? `S${String(item.season).padStart(2,'0')}E${String(item.episode).padStart(2,'0')}-E${String(item.episodeEnd).padStart(2,'0')}`
      : `S${String(item.season).padStart(2,'0')}E${String(item.episode).padStart(2,'0')}`;
    lines.push(`集次: ${epLabel}`);
  }
  const spec = fmtSpec(item);
  if (spec) lines.push(`规格: ${htmlEscape(spec)}`);
  if (item.target_path) lines.push(`路径: ${htmlEscape(item.target_path)}`);
  await sendMessage(cfg.bot_token, cfg.chat_ids, lines.join('\n'));
}

/**
 * 批量剧集入库通知：一次性合并 N 集生成一条消息，避免淹没用户。
 * @param {{items:Array,title:string,year:number,tmdbId:string,target_path:string}} info
 */
export async function notifyEpisodes(info) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_success) return;
  if (!info?.items?.length) return;
  const lines = [
    `📺 <b>剧集入库 (${info.items.length} 集)</b>`,
    `标题: ${htmlEscape(info.title || '')}${info.year ? ` (${info.year})` : ''}`,
    `TMDB: ${info.tmdbId}`,
    `集次: ${episodeRangeLabel(info.items)}`,
    `路径: ${htmlEscape(info.target_path || '')}`,
  ];
  await sendMessage(cfg.bot_token, cfg.chat_ids, lines.join('\n'));
}

/**
 * 整理失败通知（如某个分组抛出异常）。受 notify_failure 开关控制。
 */
export async function notifyFailure(error, detail) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_failure) return;
  const text = `⚠️ <b>整理失败</b>\n错误: ${htmlEscape(error)}\n详情: ${htmlEscape(detail || '')}`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

/**
 * Cookie 失效通知。由调度器的 Cookie 检查 / fetch115Api 检测到 401 时调用。
 * 受 notify_cookie 开关控制。
 */
export async function notifyCookieExpired() {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_cookie) return;
  const text = `🔑 <b>115 Cookie 已失效</b>\n请尽快在控制台重新扫码登录。`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

/**
 * 系统级通知（启动、停止、关键状态变更等）。受 notify_system 开关控制。
 */
export async function notifySystem(msg) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_system) return;
  const text = `🤖 <b>系统通知</b>\n${htmlEscape(msg)}`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

/**
 * 通过指定 Bot 发送自定义消息（Web 端"发送消息"功能）。
 * 调用方应负责对内容做必要的 HTML 转义。
 */
export async function sendCustomMessage(botId, text) {
  const cfg = getBotConfig(botId);
  if (!cfg?.bot_token) throw new Error('Bot Token未配置');
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}
