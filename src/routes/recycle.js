import { Router } from 'express';
import { getDb } from '../services/db.js';

export const recycleRouter = Router();

// List recycle records
recycleRouter.get('/', (req, res) => {
  const db = getDb();
  const { limit = 50, offset = 0 } = req.query;
  const records = db.prepare('SELECT * FROM recycle_records ORDER BY created_at DESC LIMIT ? OFFSET ?').all(parseInt(limit), parseInt(offset));
  const total = db.prepare('SELECT COUNT(*) as count FROM recycle_records').get().count;
  res.json({ records, total });
});

// Get single recycle record
recycleRouter.get('/:id', (req, res) => {
  const record = getDb().prepare('SELECT * FROM recycle_records WHERE id=?').get(req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在' });
  res.json(record);
});

// Restore from recycle (placeholder - would require 115 recycle API)
recycleRouter.post('/:id/restore', async (req, res) => {
  try {
    // 115 doesn't have a public restore API for recycle bin
    // User would need to manually restore from 115 client
    res.json({ success: true, message: '请在115客户端中从回收站手动恢复该文件' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
