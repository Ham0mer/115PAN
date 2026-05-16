import { Router } from 'express';
import { getDb } from '../services/db.js';
import { logger } from '../services/logger.js';
import { scheduler } from '../services/scheduler.js';
import { telegramBot } from '../services/telegram-bot.js';

export const configRouter = Router();

// Get organize config
configRouter.get('/organize', (req, res) => {
  const cfg = getDb().prepare('SELECT * FROM config_organize WHERE id=1').get();
  res.json(cfg || {});
});

// Update organize config
configRouter.put('/organize', (req, res) => {
  const db = getDb();
  const fields = [
    'source_cid', 'source_name', 'target_cid', 'target_name',
    'scan_interval_min', 'video_extensions', 'meta_extensions',
    'rename_enabled', 'ffprobe_enabled', 'ai_enabled',
    'min_video_size_mb', 'operation_delay_sec',
    'secondary_category', 'tertiary_category',
    'episode_per_notify', 'remux_priority', 'resolution_priority',
    'dolby_priority', 'multi_version', 'conflict_mode',
    'notify_enabled', 'notify_bot_id',
  ];
  const data = req.body;
  const sets = fields.filter(f => data[f] !== undefined).map(f => `${f}=@${f}`).join(', ');

  if (sets) {
    const stmt = db.prepare(`UPDATE config_organize SET ${sets}, updated_at=datetime('now','localtime') WHERE id=1`);
    const params = {};
    fields.forEach(f => { if (data[f] !== undefined) params[f] = data[f]; });
    stmt.run(params);
  }

  // Reschedule if scan interval changed
  if (data.scan_interval_min !== undefined) scheduler.reschedule();

  logger.info('Config', '整理配置已更新');
  res.json({ success: true });
});

// Get telegram configs
configRouter.get('/telegram', (req, res) => {
  const list = getDb().prepare('SELECT * FROM config_telegram ORDER BY id').all();
  res.json(list);
});

// Get single telegram config
configRouter.get('/telegram/:id', (req, res) => {
  const cfg = getDb().prepare('SELECT * FROM config_telegram WHERE id=?').get(req.params.id);
  if (!cfg) return res.status(404).json({ error: '配置不存在' });
  // Mask token
  if (cfg.bot_token) cfg.bot_token = maskString(cfg.bot_token);
  res.json(cfg);
});

// Create telegram config
configRouter.post('/telegram', (req, res) => {
  const db = getDb();
  const { name, bot_token, chat_ids, enabled, notify_success, notify_failure, notify_cookie, notify_system } = req.body;
  const result = db.prepare(`INSERT INTO config_telegram (name, bot_token, chat_ids, enabled, notify_success, notify_failure, notify_cookie, notify_system)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, bot_token, chat_ids, enabled ? 1 : 0, notify_success ? 1 : 0, notify_failure ? 1 : 0, notify_cookie ? 1 : 0, notify_system ? 1 : 0);
  try { telegramBot.refresh(); } catch {}
  res.json({ id: result.lastInsertRowid });
});

// Update telegram config
configRouter.put('/telegram/:id', (req, res) => {
  const db = getDb();
  const fields = ['name', 'bot_token', 'chat_ids', 'enabled', 'notify_success', 'notify_failure', 'notify_cookie', 'notify_system'];
  const data = req.body;
  const sets = fields.filter(f => data[f] !== undefined).map(f => `${f}=@${f}`).join(', ');
  if (sets) {
    const stmt = db.prepare(`UPDATE config_telegram SET ${sets}, updated_at=datetime('now','localtime') WHERE id=@id`);
    const params = { id: req.params.id };
    fields.forEach(f => { if (data[f] !== undefined) params[f] = data[f]; });
    stmt.run(params);
  }
  try { telegramBot.refresh(); } catch {}
  res.json({ success: true });
});

// Delete telegram config
configRouter.delete('/telegram/:id', (req, res) => {
  getDb().prepare('DELETE FROM config_telegram WHERE id=?').run(req.params.id);
  try { telegramBot.refresh(); } catch {}
  res.json({ success: true });
});

// Get TMDB config
configRouter.get('/tmdb', (req, res) => {
  const cfg = getDb().prepare('SELECT * FROM config_tmdb WHERE id=1').get();
  if (cfg?.api_key) cfg.api_key = maskString(cfg.api_key);
  res.json(cfg || {});
});

// Update TMDB config
configRouter.put('/tmdb', (req, res) => {
  const db = getDb();
  const fields = ['api_key', 'base_url', 'image_domain', 'primary_lang', 'fallback_lang', 'timeout_sec', 'max_retries'];
  const data = req.body;
  const sets = fields.filter(f => data[f] !== undefined).map(f => `${f}=@${f}`).join(', ');
  if (sets) {
    const stmt = db.prepare(`UPDATE config_tmdb SET ${sets}, updated_at=datetime('now','localtime') WHERE id=1`);
    const params = {};
    fields.forEach(f => { if (data[f] !== undefined) params[f] = data[f]; });
    stmt.run(params);
  }
  res.json({ success: true });
});

// Get AI config
configRouter.get('/ai', (req, res) => {
  const cfg = getDb().prepare('SELECT * FROM config_ai WHERE id=1').get();
  if (cfg?.api_key) cfg.api_key = maskString(cfg.api_key);
  res.json(cfg || {});
});

// Update AI config
configRouter.put('/ai', (req, res) => {
  const db = getDb();
  const fields = ['base_url', 'api_key', 'model', 'temperature', 'timeout_sec', 'max_retries', 'prompt_template'];
  const data = req.body;
  const sets = fields.filter(f => data[f] !== undefined).map(f => `${f}=@${f}`).join(', ');
  if (sets) {
    const stmt = db.prepare(`UPDATE config_ai SET ${sets}, updated_at=datetime('now','localtime') WHERE id=1`);
    const params = {};
    fields.forEach(f => { if (data[f] !== undefined) params[f] = data[f]; });
    stmt.run(params);
  }
  res.json({ success: true });
});

function maskString(str) {
  if (!str || str.length <= 8) return str;
  return str.slice(0, 4) + '****' + str.slice(-4);
}
