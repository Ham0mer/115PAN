import { getDb } from './db.js';
import { logger } from './logger.js';
import { parseShareLink, fetchShareSnap, transferShareLink, listFolders, getActiveCookie } from './115.js';

// Telegram Bot API 根地址
const TG_API = 'https://api.telegram.org';
// long-polling 单次超时（秒），Telegram 推荐 25-50s
const POLL_TIMEOUT_SEC = 30;
// 会话状态过期时间：30 分钟。用户太久不点按钮则视为放弃
const STATE_TTL_MS = 30 * 60 * 1000;
// 目录选择器每页显示的子目录数量
const PAGE_SIZE = 8;

// 当前运行中的 bot 实例表：botId → { stopped, cfg, errCount }
const runningBots = new Map();
// 短 token → 进行中的转存会话状态。所有 inline_keyboard 回调都基于此 token
const states = new Map();

// 定时刷新 bot 列表（应对数据库中新增/删除/修改 bot）的句柄
let refreshTimer = null;
// 定时清理过期会话状态的句柄
let cleanupTimer = null;

/**
 * 生成一段短随机字符串作为会话 token。
 * 用于 inline_keyboard 的 callback_data，受 64 字节长度限制，故只取 8 位。
 */
function newToken() {
  return Math.random().toString(36).slice(2, 10);
}
/** Promise 化的 sleep。 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/** HTML 转义，用于 Telegram parse_mode=HTML。 */
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * 清理过期会话：遍历 states 删除超过 STATE_TTL_MS 的条目。
 * 定时被 cleanupTimer 调用，避免 Map 无限增长。
 */
function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of states) {
    if (now - v.createdAt > STATE_TTL_MS) states.delete(k);
  }
}

/**
 * 读取所有"已启用且配置了 token"的 Bot 配置。
 */
function getEnabledBots() {
  return getDb().prepare(
    "SELECT * FROM config_telegram WHERE enabled=1 AND bot_token IS NOT NULL AND bot_token != ''"
  ).all();
}

/**
 * 判断给定 chatId 是否在该 Bot 的白名单内。
 * config.chat_ids 为半角逗号分隔的字符串。无白名单则一律拒绝（防止任意人触发）。
 */
function isAllowed(chatId, cfg) {
  if (!cfg.chat_ids) return false;
  return cfg.chat_ids.split(',').map(s => s.trim()).filter(Boolean).includes(String(chatId));
}

/**
 * Telegram Bot API 调用封装。
 * - 15 秒整体超时；
 * - 非 ok 响应抛错，并附带 error_code 字段方便上层判定（401/404 视为 token 无效，409 为冲突）。
 */
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

/**
 * editMessageText 的安全包装：当内容与现有相同时，Telegram 会返回 "not modified" 错误，
 * 该错误对业务无影响，吞掉即可；其他错误向上抛出。
 */
async function safeEdit(token, payload) {
  try {
    return await tgApi(token, 'editMessageText', payload);
  } catch (err) {
    if (/not modified/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * 渲染目录选择器：以 inline_keyboard 形式列出当前层级的子目录，
 * 支持翻页、返回上级、"转存到此处"、"转存到待整理目录"、取消等操作。
 *
 * 通过 editMessageText 在原消息上原地刷新，避免刷屏。
 */
async function showPicker(cfg, state) {
  const folders = await listFolders(state.currentCid);
  state.folders = folders.map(f => ({ cid: f.id, name: f.name }));
  const offset = state.pickerOffset || 0;
  const page = state.folders.slice(offset, offset + PAGE_SIZE);

  const keyboard = [];
  // 每个子目录一行，callback_data 形如 n:<token>:<index>
  for (let i = 0; i < page.length; i++) {
    const f = page[i];
    keyboard.push([{ text: `📁 ${f.name}`, callback_data: `n:${state.token}:${offset + i}` }]);
  }

  // 翻页按钮（顶部一行）
  const navRow = [];
  if (offset > 0) navRow.push({ text: '⬅️ 上一页', callback_data: `p:${state.token}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < state.folders.length) navRow.push({ text: '➡️ 下一页', callback_data: `p:${state.token}:${offset + PAGE_SIZE}` });
  if (navRow.length) keyboard.push(navRow);

  // 返回上级（仅非根目录时显示）
  if (state.breadcrumb.length > 0) {
    keyboard.push([{ text: '⬆️ 返回上一级', callback_data: `u:${state.token}` }]);
  }

  // 确认按钮：把当前所处的位置作为目标
  const hereName = state.breadcrumb.length ? state.breadcrumb[state.breadcrumb.length - 1].name : '根目录';
  keyboard.push([{ text: `✅ 转存到此处 (${hereName})`, callback_data: `s:${state.token}` }]);

  // 快捷按钮：直达"待整理目录"。仅当配置了 source_cid 且不与当前位置相同时显示
  if (state.sourceCid && state.sourceCid !== state.currentCid) {
    const label = state.sourceName ? `🚀 待整理目录: ${state.sourceName}` : '🚀 待整理目录';
    keyboard.push([{ text: label, callback_data: `q:${state.token}` }]);
  }

  keyboard.push([{ text: '❌ 取消', callback_data: `c:${state.token}` }]);

  // 面包屑路径展示
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

/**
 * 处理用户发送的 115 分享链接：
 * 1) 校验 Cookie；
 * 2) 解析链接参数；
 * 3) 调用 fetchShareSnap 获取分享概况；
 * 4) 建立会话状态并显示目录选择器。
 * 任何阶段失败都通过 editMessageText 把消息更新为错误提示，避免用户疑惑。
 */
async function handleShareLink(cfg, chatId, link) {
  if (!getActiveCookie()) {
    await tgApi(cfg.bot_token, 'sendMessage', {
      chat_id: chatId, text: '⚠️ 未登录 115 账号，请先在控制台扫码登录。',
    }).catch(() => {});
    return;
  }

  // 先发"解析中"占位消息，后续所有进度都在这条消息上 edit
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
    currentCid: '0',     // 当前浏览到的目录 CID（"0" 代表根目录）
    breadcrumb: [],      // 用户的目录浏览栈，元素为 {cid, name}
    pickerOffset: 0,     // 翻页偏移
    sourceCid: org?.source_cid || '',
    sourceName: org?.source_name || '',
    createdAt: Date.now(),
  };
  states.set(token, state);

  try {
    await showPicker(cfg, state);
  } catch (err) {
    // 加载目录失败时清掉会话，避免悬挂状态
    states.delete(token);
    await safeEdit(cfg.bot_token, {
      chat_id: chatId, message_id: wait.message_id,
      text: `❌ 加载目录失败: ${htmlEscape(err.message)}`, parse_mode: 'HTML',
    }).catch(() => {});
  }
}

/**
 * 执行实际的分享转存操作。
 * 转存中先把消息改为"⏳ 转存中..."，完成后再改为成功/失败结果。
 * 重复转存时 transferShareLink 会标记 alreadyTransferred，UI 上做温和提示而非错误。
 */
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

/**
 * inline_keyboard 回调统一入口。
 * callback_data 约定格式："<action>:<token>[:<arg>]"，action 含义：
 *   n: 进入子目录（arg=索引）
 *   u: 返回上级
 *   p: 翻页（arg=新 offset）
 *   s: 选定当前位置作为目标
 *   q: 直达"待整理目录"
 *   c: 取消
 *
 * 取到 token 找不到会话则提示已过期。所有异常仅记日志，不影响 bot 主循环。
 */
async function handleCallback(cfg, q) {
  const data = q.data || '';
  const [action, token, arg] = data.split(':');
  // 立即 answerCallbackQuery，消除 Telegram 客户端的转圈
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

/**
 * 单条 update 的分发器：
 * - 文字消息：仅处理白名单内 chat，识别分享链接 → 启动转存流程；/start /help 返回帮助文案；
 * - 回调查询：先校验白名单，未授权弹 alert；通过后交给 handleCallback。
 */
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

/**
 * 单个 Bot 的 long-polling 主循环。
 * - 使用 getUpdates 的 long polling 模式（timeout 参数）减少请求数；
 * - 仅订阅 message 与 callback_query 两类事件；
 * - 错误分支处理：401/404 → token 失效直接退出循环；409 → 与其他客户端冲突，等待 10s 重试；
 * - 其他异常使用指数退避（3s → 6s → 12s → 24s → 48s → 60s 封顶）。
 *
 * 更新分发用 fire-and-forget 方式（不 await），保证一次 batch 的所有 update 能并发处理且不阻塞 offset 推进。
 */
async function pollLoop(rec) {
  let offset = 0;
  const allowedJson = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  while (!rec.stopped) {
    const cfg = rec.cfg;
    try {
      const url = `${TG_API}/bot${cfg.bot_token}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=${allowedJson}`;
      // 网络超时略大于 long-polling 超时，给服务端留出响应时间
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
      rec.errCount = (rec.errCount || 0) + 1;
      const isTimeout = /abort|timeout/i.test(err?.message || '');
      // 超时是正常现象（long-polling 无更新时会超时），不打日志；非超时错误首次或每 20 次打一条
      if (!isTimeout && (rec.errCount === 1 || rec.errCount % 20 === 0)) {
        logger.warn('TelegramBot', `轮询异常 (累计${rec.errCount}次): ${err.message}`);
      }
      // 指数退避：3s → 6s → 12s → 24s → 48s → 60s 封顶
      const backoff = Math.min(3000 * Math.pow(2, Math.min(rec.errCount - 1, 5)), 60000);
      await sleep(backoff);
      continue;
    }
    // 正常一轮过后重置错误计数
    rec.errCount = 0;
  }
  logger.info('TelegramBot', `Bot ${rec.cfg.name || rec.cfg.id} 轮询已停止`);
}

/**
 * Telegram Bot 服务门面：服务启动时 start()，配置变化由 refresh() 自动协调。
 * 多 Bot 支持：每个 enabled Bot 起一条 pollLoop；被删除或禁用的 Bot 在下次 refresh 时停止。
 */
export const telegramBot = {
  /**
   * 启动 Bot 服务：先立即同步一次，再每 60 秒刷新一次，每 5 分钟清理一次过期会话。
   */
  start() {
    this.refresh();
    refreshTimer = setInterval(() => this.refresh(), 60000);
    cleanupTimer = setInterval(cleanupStates, 5 * 60000);
    logger.info('TelegramBot', '机器人服务已启动');
  },

  /**
   * 与数据库配置对账：
   * - 新增配置 → 启动对应 pollLoop；
   * - token 改变 → 旧实例停止、按新配置重启；
   * - 配置仅其他字段变化 → 原地更新 cfg 引用（pollLoop 下次循环自然读取新值）；
   * - 不再启用 → 停止 pollLoop 并从表中移除。
   */
  refresh() {
    let list;
    try { list = getEnabledBots(); } catch { return; }
    const seen = new Set();
    for (const cfg of list) {
      seen.add(cfg.id);
      const existing = runningBots.get(cfg.id);
      if (existing) {
        if (existing.cfg.bot_token !== cfg.bot_token) {
          // token 变更：先标记停止旧的，再走下方创建新的逻辑
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

  /**
   * 停止全部 Bot 与定时器（进程退出时调用）。
   */
  stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    refreshTimer = null;
    cleanupTimer = null;
    for (const [, rec] of runningBots) rec.stopped = true;
    runningBots.clear();
  },
};
