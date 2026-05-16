import { getDb } from './db.js';
import { logger } from './logger.js';
import { parseShareLink, fetchShareSnap, transferShareLink, listFolders, getActiveCookie } from './115.js';

const TG_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 30;
const STATE_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 8;

// botId → { stopped, cfg }
const runningBots = new Map();
// token → conversation state
const states = new Map();

let refreshTimer = null;
let cleanupTimer = null;

function newToken() {
  return Math.random().toString(36).slice(2, 10);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of states) {
    if (now - v.createdAt > STATE_TTL_MS) states.delete(k);
  }
}

function getEnabledBots() {
  return getDb().prepare(
    "SELECT * FROM config_telegram WHERE enabled=1 AND bot_token IS NOT NULL AND bot_token != ''"
  ).all();
}

function isAllowed(chatId, cfg) {
  if (!cfg.chat_ids) return false;
  return cfg.chat_ids.split(',').map(s => s.trim()).filter(Boolean).includes(String(chatId));
}

async function tgApi(token, method, payload) {
  const url = `${TG_API}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description || res.status}`);
    err.errorCode = data.error_code;
    throw err;
  }
  return data.result;
}

async function safeEdit(token, payload) {
  try {
    return await tgApi(token, 'editMessageText', payload);
  } catch (err) {
    if (/not modified/i.test(err.message)) return null;
    throw err;
  }
}

async function showPicker(cfg, state) {
  const folders = await listFolders(state.currentCid);
  state.folders = folders.map(f => ({ cid: f.id, name: f.name }));
  const offset = state.pickerOffset || 0;
  const page = state.folders.slice(offset, offset + PAGE_SIZE);

  const keyboard = [];
  for (let i = 0; i < page.length; i++) {
    const f = page[i];
    keyboard.push([{ text: `📁 ${f.name}`, callback_data: `n:${state.token}:${offset + i}` }]);
  }

  const navRow = [];
  if (offset > 0) navRow.push({ text: '⬅️ 上一页', callback_data: `p:${state.token}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < state.folders.length) navRow.push({ text: '➡️ 下一页', callback_data: `p:${state.token}:${offset + PAGE_SIZE}` });
  if (navRow.length) keyboard.push(navRow);

  if (state.breadcrumb.length > 0) {
    keyboard.push([{ text: '⬆️ 返回上一级', callback_data: `u:${state.token}` }]);
  }

  const hereName = state.breadcrumb.length ? state.breadcrumb[state.breadcrumb.length - 1].name : '根目录';
  keyboard.push([{ text: `✅ 转存到此处 (${hereName})`, callback_data: `s:${state.token}` }]);

  if (state.sourceCid && state.sourceCid !== state.currentCid) {
    const label = state.sourceName ? `🚀 待整理目录: ${state.sourceName}` : '🚀 待整理目录';
    keyboard.push([{ text: label, callback_data: `q:${state.token}` }]);
  }

  keyboard.push([{ text: '❌ 取消', callback_data: `c:${state.token}` }]);

  const breadcrumbStr = state.breadcrumb.length === 0 ? '/' : '/' + state.breadcrumb.map(b => b.name).join('/');
  const text =
    `📦 <b>分享转存</b>\n` +
    (state.shareTitle ? `分享: ${htmlEscape(state.shareTitle)}\n` : '') +
    `共 ${state.fileCount} 项\n\n` +
    `当前位置: <code>${htmlEscape(breadcrumbStr)}</code>`;

  await safeEdit(cfg.bot_token, {
    chat_id: state.chatId,
    message_id: state.messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleShareLink(cfg, chatId, link) {
  if (!getActiveCookie()) {
    await tgApi(cfg.bot_token, 'sendMessage', {
      chat_id: chatId, text: '⚠️ 未登录 115 账号，请先在控制台扫码登录。',
    }).catch(() => {});
    return;
  }

  const wait = await tgApi(cfg.bot_token, 'sendMessage', {
    chat_id: chatId, text: '🔍 解析分享链接中...',
  }).catch(() => null);
  if (!wait) return;

  const parsed = parseShareLink(link);
  if (!parsed) {
    await safeEdit(cfg.bot_token, {
      chat_id: chatId, message_id: wait.message_id, text: '⚠️ 链接格式不正确。',
    }).catch(() => {});
    return;
  }

  let snap;
  try {
    snap = await fetchShareSnap(parsed.shareCode, parsed.receiveCode);
  } catch (err) {
    await safeEdit(cfg.bot_token, {
      chat_id: chatId, message_id: wait.message_id,
      text: `❌ 解析失败: ${htmlEscape(err.message)}`, parse_mode: 'HTML',
    }).catch(() => {});
    return;
  }

  if (!snap.list.length) {
    await safeEdit(cfg.bot_token, {
      chat_id: chatId, message_id: wait.message_id, text: '⚠️ 分享中未找到任何文件。',
    }).catch(() => {});
    return;
  }

  const org = getDb().prepare('SELECT source_cid, source_name FROM config_organize WHERE id=1').get();
  const token = newToken();
  const state = {
    token,
    botId: cfg.id,
    chatId: String(chatId),
    messageId: wait.message_id,
    link,
    shareTitle: snap.shareInfo?.share_title || snap.shareInfo?.title || '',
    fileCount: snap.list.length,
    currentCid: '0',
    breadcrumb: [],
    pickerOffset: 0,
    sourceCid: org?.source_cid || '',
    sourceName: org?.source_name || '',
    createdAt: Date.now(),
  };
  states.set(token, state);

  try {
    await showPicker(cfg, state);
  } catch (err) {
    states.delete(token);
    await safeEdit(cfg.bot_token, {
      chat_id: chatId, message_id: wait.message_id,
      text: `❌ 加载目录失败: ${htmlEscape(err.message)}`, parse_mode: 'HTML',
    }).catch(() => {});
  }
}

async function doTransfer(cfg, state, targetCid, targetLabel) {
  await safeEdit(cfg.bot_token, {
    chat_id: state.chatId, message_id: state.messageId, text: '⏳ 转存中...',
  }).catch(() => {});

  try {
    const result = await transferShareLink(state.link, targetCid);
    states.delete(state.token);
    const note = result.alreadyTransferred ? '\n💡 该分享之前已转存过' : '';
    await safeEdit(cfg.bot_token, {
      chat_id: state.chatId, message_id: state.messageId,
      text:
        `✅ <b>转存成功</b>\n` +
        (state.shareTitle ? `分享: ${htmlEscape(state.shareTitle)}\n` : '') +
        `文件数: ${result.fileCount}\n` +
        `目录: ${htmlEscape(targetLabel)}${note}`,
      parse_mode: 'HTML',
    }).catch(() => {});
    logger.info('TelegramBot', `转存完成 chat=${state.chatId} files=${result.fileCount} → ${targetCid}`);
  } catch (err) {
    await safeEdit(cfg.bot_token, {
      chat_id: state.chatId, message_id: state.messageId,
      text: `❌ 转存失败: ${htmlEscape(err.message)}`, parse_mode: 'HTML',
    }).catch(() => {});
  }
}

async function handleCallback(cfg, q) {
  const data = q.data || '';
  const [action, token, arg] = data.split(':');
  tgApi(cfg.bot_token, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});

  const state = states.get(token);
  if (!state) {
    await safeEdit(cfg.bot_token, {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: '⏰ 会话已过期，请重新发送链接。',
    }).catch(() => {});
    return;
  }

  try {
    if (action === 'c') {
      states.delete(token);
      await safeEdit(cfg.bot_token, {
        chat_id: state.chatId, message_id: state.messageId, text: '❌ 已取消。',
      });
      return;
    }
    if (action === 'n') {
      const idx = parseInt(arg);
      const folder = state.folders?.[idx];
      if (folder) {
        state.breadcrumb.push({ cid: folder.cid, name: folder.name });
        state.currentCid = folder.cid;
        state.pickerOffset = 0;
        await showPicker(cfg, state);
      }
      return;
    }
    if (action === 'u') {
      state.breadcrumb.pop();
      state.currentCid = state.breadcrumb.length ? state.breadcrumb[state.breadcrumb.length - 1].cid : '0';
      state.pickerOffset = 0;
      await showPicker(cfg, state);
      return;
    }
    if (action === 'p') {
      state.pickerOffset = parseInt(arg) || 0;
      await showPicker(cfg, state);
      return;
    }
    if (action === 's') {
      const label = state.breadcrumb.length ? '/' + state.breadcrumb.map(b => b.name).join('/') : '根目录';
      await doTransfer(cfg, state, state.currentCid, label);
      return;
    }
    if (action === 'q') {
      if (!state.sourceCid) {
        await safeEdit(cfg.bot_token, {
          chat_id: state.chatId, message_id: state.messageId, text: '⚠️ 系统未配置待整理目录。',
        }).catch(() => {});
        return;
      }
      await doTransfer(cfg, state, state.sourceCid, state.sourceName || '待整理目录');
      return;
    }
  } catch (err) {
    logger.warn('TelegramBot', `回调处理失败: ${err.message}`);
  }
}

async function handleUpdate(cfg, upd) {
  if (upd.message) {
    const chatId = String(upd.message.chat.id);
    if (!isAllowed(chatId, cfg)) return;
    const text = upd.message.text || '';
    if (parseShareLink(text)) {
      await handleShareLink(cfg, chatId, text);
    } else if (/^\/(start|help)/i.test(text.trim())) {
      await tgApi(cfg.bot_token, 'sendMessage', {
        chat_id: chatId,
        text: '👋 发送 115 分享链接即可转存。\n格式: <code>https://115.com/s/&lt;code&gt;?password=&lt;code&gt;</code>',
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  } else if (upd.callback_query) {
    const chatId = String(upd.callback_query.message?.chat?.id || '');
    if (!isAllowed(chatId, cfg)) {
      await tgApi(cfg.bot_token, 'answerCallbackQuery', {
        callback_query_id: upd.callback_query.id, text: '未授权', show_alert: true,
      }).catch(() => {});
      return;
    }
    await handleCallback(cfg, upd.callback_query);
  }
}

async function pollLoop(rec) {
  let offset = 0;
  const allowedJson = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  while (!rec.stopped) {
    const cfg = rec.cfg;
    try {
      const url = `${TG_API}/bot${cfg.bot_token}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=${allowedJson}`;
      const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 5) * 1000) });
      const data = await res.json();
      if (!data.ok) {
        if (data.error_code === 401 || data.error_code === 404) {
          logger.error('TelegramBot', `Bot ${cfg.name || cfg.id} token 无效，停止轮询`);
          rec.stopped = true;
          break;
        }
        if (data.error_code === 409) {
          logger.warn('TelegramBot', `Bot ${cfg.name || cfg.id} 与其他客户端冲突（getUpdates 409）`);
          await sleep(10000);
          continue;
        }
        logger.warn('TelegramBot', `getUpdates 失败: ${data.description}`);
        await sleep(5000);
        continue;
      }
      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        handleUpdate(rec.cfg, upd).catch(err => logger.warn('TelegramBot', `update 处理失败: ${err.message}`));
      }
    } catch (err) {
      if (rec.stopped) break;
      if (!/abort|timeout/i.test(err?.message || '')) {
        logger.warn('TelegramBot', `轮询异常: ${err.message}`);
      }
      await sleep(3000);
    }
  }
  logger.info('TelegramBot', `Bot ${rec.cfg.name || rec.cfg.id} 轮询已停止`);
}

export const telegramBot = {
  start() {
    this.refresh();
    refreshTimer = setInterval(() => this.refresh(), 60000);
    cleanupTimer = setInterval(cleanupStates, 5 * 60000);
    logger.info('TelegramBot', '机器人服务已启动');
  },

  refresh() {
    let list;
    try { list = getEnabledBots(); } catch { return; }
    const seen = new Set();
    for (const cfg of list) {
      seen.add(cfg.id);
      const existing = runningBots.get(cfg.id);
      if (existing) {
        if (existing.cfg.bot_token !== cfg.bot_token) {
          existing.stopped = true;
          runningBots.delete(cfg.id);
        } else {
          existing.cfg = cfg;
          continue;
        }
      }
      const rec = { stopped: false, cfg };
      runningBots.set(cfg.id, rec);
      pollLoop(rec).catch(err => logger.error('TelegramBot', `Bot ${cfg.id} 异常: ${err.message}`));
      logger.info('TelegramBot', `Bot ${cfg.name || cfg.id} 已启动`);
    }
    for (const [id, rec] of runningBots) {
      if (!seen.has(id)) {
        rec.stopped = true;
        runningBots.delete(id);
      }
    }
  },

  stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    refreshTimer = null;
    cleanupTimer = null;
    for (const [, rec] of runningBots) rec.stopped = true;
    runningBots.clear();
  },
};
