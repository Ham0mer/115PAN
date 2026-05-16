import { Router } from 'express';
import { getDb } from '../services/db.js';
import { scheduler } from '../services/scheduler.js';
import { logger } from '../services/logger.js';
import { rerunInPlace, requestCancel } from '../services/organizer.js';

export const taskRouter = Router();

taskRouter.get('/', (req, res) => {
  const db = getDb();
  const { limit = 50, offset = 0 } = req.query;
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?').all(parseInt(limit), parseInt(offset));
  const total = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  res.json({ tasks, total });
});

taskRouter.get('/:id', (req, res) => {
  const task = getDb().prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const items = getDb().prepare('SELECT * FROM task_items WHERE task_id=?').all(req.params.id);
  res.json({ ...task, items });
});

taskRouter.post('/run-now', async (req, res) => {
  try {
    const result = await scheduler.runNow();
    res.json(result || { success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all non-running task records (and their items). Running tasks are preserved.
taskRouter.post('/clear', (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM task_items WHERE task_id IN (SELECT id FROM tasks WHERE status != 'running')").run();
  const result = db.prepare("DELETE FROM tasks WHERE status != 'running'").run();
  logger.info('Tasks', `已清除 ${result.changes} 条任务记录`);
  res.json({ success: true, deleted: result.changes });
});

// Request cancellation of a running task; the organizer checks the token at safe points.
taskRouter.post('/:id/cancel', (req, res) => {
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND status='running'").get(req.params.id);
  if (!task) return res.status(404).json({ error: '没有正在运行的任务' });
  requestCancel(parseInt(req.params.id));
  logger.info('Tasks', `已请求取消任务: ${req.params.id}`);
  res.json({ success: true, message: '取消请求已发送，将在当前操作结束后停止' });
});

// In-place rerun (4.12): re-classify and re-rename items at their CURRENT location.
taskRouter.post('/:id/rerun', async (req, res) => {
  try {
    const result = await rerunInPlace(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

taskRouter.get('/:id/items', (req, res) => {
  const items = getDb().prepare('SELECT * FROM task_items WHERE task_id=? ORDER BY id').all(req.params.id);
  res.json(items);
});

