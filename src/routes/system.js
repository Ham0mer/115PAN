import { Router } from 'express';
import { getDb } from '../services/db.js';
import { changeAdminPassword } from '../middleware/auth.js';
import { parseFilename } from '../services/parser.js';
import fs from 'fs';
import path from 'path';

export const systemRouter = Router();

// Get system stats for dashboard
systemRouter.get('/stats', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);

  const todayCount = db.prepare("SELECT COUNT(*) as count FROM task_items WHERE date(created_at)=? ").get(today)?.count || 0;
  const monthCount = db.prepare("SELECT COUNT(*) as count FROM task_items WHERE created_at LIKE ?").get(thisMonth + '%')?.count || 0;
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM task_items').get()?.count || 0;
  const pendingUnmatched = db.prepare("SELECT COUNT(*) as count FROM unmatched_items WHERE status='pending'").get()?.count || 0;
  const lastTask = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1').get();
  const cookie = db.prepare("SELECT * FROM cookies_115 WHERE status='active' LIMIT 1").get();

  let vipInfo = null;
  try { vipInfo = cookie?.vip_info ? JSON.parse(cookie.vip_info) : null; } catch {}
  const used = Number(cookie?.size_used_raw) || 0;
  const total = Number(cookie?.size_total_raw) || 0;

  res.json({
    todayCount,
    monthCount,
    totalCount,
    pendingUnmatched,
    lastTask,
    cookieStatus: cookie ? 'active' : 'none',
    cookieUser: cookie?.user_name || '',
    cookieFaceM: cookie?.face_m || '',
    cookieSizeUsed: cookie?.size_used || '',
    cookieSizeTotal: cookie?.size_total || '',
    cookieSizePercent: total > 0 ? +(used / total * 100).toFixed(2) : 0,
    cookieVipName: vipInfo?.level_name || '',
    cookieVipExpire: vipInfo?.expire_date || '',
    cookieVipForever: !!vipInfo?.is_forever,
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
});

// Change password (bcrypt hash stored in app_settings)
systemRouter.post('/change-password', (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写新旧密码' });
    const username = req.user?.username;
    changeAdminPassword(username, oldPassword, newPassword);
    res.json({ success: true, message: '密码已更新' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Export database backup
systemRouter.post('/backup', (req, res) => {
  try {
    const db = getDb();
    const backupDir = path.resolve(process.cwd(), 'data');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `backup-${ts}.db`);

    db.backup(backupPath);
    res.json({ success: true, path: backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import database backup
systemRouter.post('/restore', (req, res) => {
  res.status(501).json({ error: '恢复功能需要在服务器停止状态下手动替换 data/app.db' });
});

// Test filename parser (dashboard tool)
systemRouter.post('/parse-test', (req, res) => {
  const { filename } = req.body || {};
  if (!filename || typeof filename !== 'string') return res.status(400).json({ error: '请提供文件名' });
  res.json({ result: parseFilename(filename) });
});

// Get version info
systemRouter.get('/version', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    res.json({ version: pkg.version, node: process.version });
  } catch {
    res.json({ version: '1.0.0', node: process.version });
  }
});
