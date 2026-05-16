import { getDb } from './db.js';
import { logger } from './logger.js';

function getBotConfig(botId) {
  const db = getDb();
  if (botId) return db.prepare('SELECT * FROM config_telegram WHERE id=?').get(botId);
  // Use the bot selected in organize config, falling back to any enabled bot.
  const org = db.prepare('SELECT notify_bot_id FROM config_organize WHERE id=1').get();
  if (org?.notify_bot_id) {
    const chosen = db.prepare('SELECT * FROM config_telegram WHERE id=? AND enabled=1').get(org.notify_bot_id);
    if (chosen) return chosen;
  }
  return db.prepare('SELECT * FROM config_telegram WHERE enabled=1 ORDER BY id LIMIT 1').get();
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

export async function sendTestMessage(botId) {
  const cfg = getBotConfig(botId);
  if (!cfg?.bot_token) throw new Error('Bot Token未配置');
  if (!cfg?.chat_ids) throw new Error('Chat ID未配置');
  await sendMessage(cfg.bot_token, cfg.chat_ids, '✅ <b>测试消息</b>\n115 整理系统通知通道正常。');
  logger.info('Telegram', '测试消息已发送');
}

function fmtSpec(item) {
  const parts = [];
  if (item.resolution) parts.push(item.resolution);
  if (item.source) parts.push(item.source);
  if (item.videoCodec) parts.push(item.videoCodec);
  return parts.length ? parts.join(' ') : '';
}

function episodeRangeLabel(items) {
  const grouped = new Map();
  for (const it of items) {
    if (!grouped.has(it.season)) grouped.set(it.season, []);
    grouped.get(it.season).push(it.episode);
  }
  const seasons = [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  return seasons.map(([s, eps]) => {
    const sortedEps = [...new Set(eps)].sort((a, b) => a - b);
    return `S${String(s).padStart(2, '0')} ${sortedEps.map(e => `E${String(e).padStart(2, '0')}`).join(',')}`;
  }).join(' | ');
}

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

export async function notifyFailure(error, detail) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_failure) return;
  const text = `⚠️ <b>整理失败</b>\n错误: ${htmlEscape(error)}\n详情: ${htmlEscape(detail || '')}`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

export async function notifyCookieExpired() {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_cookie) return;
  const text = `🔑 <b>115 Cookie 已失效</b>\n请尽快在控制台重新扫码登录。`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

export async function notifySystem(msg) {
  const cfg = getBotConfig();
  if (!cfg || !cfg.enabled || !cfg.notify_system) return;
  const text = `🤖 <b>系统通知</b>\n${htmlEscape(msg)}`;
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}

export async function sendCustomMessage(botId, text) {
  const cfg = getBotConfig(botId);
  if (!cfg?.bot_token) throw new Error('Bot Token未配置');
  await sendMessage(cfg.bot_token, cfg.chat_ids, text);
}
