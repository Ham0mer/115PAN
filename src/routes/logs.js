import { Router } from 'express';
import { getDb } from '../services/db.js';
import fs from 'fs';
import path from 'path';

const SHANGHAI = 'Asia/Shanghai';

function fmtDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: SHANGHAI });
}

export const logRouter = Router();

// Get logs from DB
logRouter.get('/', (req, res) => {
  const db = getDb();
  const { level, category, keyword, limit = 100, offset = 0, startDate, endDate } = req.query;
  let sql = 'SELECT * FROM logs WHERE 1=1';
  const params = [];

  if (level) { sql += ' AND level=?'; params.push(level.toUpperCase()); }
  if (category) { sql += ' AND category=?'; params.push(category); }
  if (keyword) { sql += ' AND (message LIKE ? OR detail LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (startDate) { sql += ' AND created_at >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND created_at <= ?'; params.push(endDate); }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const logs = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM logs').get().count;
  res.json({ logs, total });
});

// Get log file content
logRouter.get('/file', (req, res) => {
  const { date } = req.query;
  const logDir = path.resolve(process.cwd(), 'logs');
  const fileName = date ? `${date}.log` : `${fmtDate()}.log`;
  const filePath = path.join(logDir, fileName);

  if (!fs.existsSync(filePath)) {
    return res.json({ content: '', message: '日志文件不存在' });
  }

  const content = fs.readFileSync(filePath, 'utf-8').split('\n').slice(-500).join('\n');
  res.json({ content, fileName });
});

// SSE stream for real-time logs
logRouter.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const logDir = path.resolve(process.cwd(), 'logs');
  const todayFile = path.join(logDir, `${fmtDate()}.log`);

  let lastSize = 0;
  if (fs.existsSync(todayFile)) lastSize = fs.statSync(todayFile).size;

  const interval = setInterval(() => {
    try {
      if (fs.existsSync(todayFile)) {
        const size = fs.statSync(todayFile).size;
        if (size > lastSize) {
          const stream = fs.createReadStream(todayFile, { start: lastSize, end: size - 1, encoding: 'utf-8' });
          let data = '';
          stream.on('data', chunk => { data += chunk; });
          stream.on('end', () => {
            res.write(`data: ${JSON.stringify({ lines: data.split('\n').filter(Boolean) })}\n\n`);
            lastSize = size;
          });
        }
      }
    } catch {}
  }, 2000);

  req.on('close', () => clearInterval(interval));
});

// Clear logs
logRouter.delete('/', (req, res) => {
  getDb().prepare('DELETE FROM logs').run();
  res.json({ success: true });
});
