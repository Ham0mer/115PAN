import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runMigrations, closeDb } from './services/db.js';
import { logger, cleanupOldLogs } from './services/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { notifySystem } from './services/telegram.js';
import { authRouter } from './routes/auth.js';
import { router115 } from './routes/115.js';
import { configRouter } from './routes/config.js';
import { taskRouter } from './routes/tasks.js';
import { unmatchedRouter } from './routes/unmatched.js';
import { tmdbRouter } from './routes/tmdb.js';
import { aiRouter } from './routes/ai.js';
import { templateRouter } from './routes/templates.js';
import { logRouter } from './routes/logs.js';
import { systemRouter } from './routes/system.js';
import { telegramRouter } from './routes/telegram.js';
import { recycleRouter } from './routes/recycle.js';
import { scheduler } from './services/scheduler.js';
import { telegramBot } from './services/telegram-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadServerConfig() {
  const configPath = path.join(__dirname, '..', 'config', 'config.json');
  const defaultPath = path.join(__dirname, '..', 'config', 'default.json');
  const p = fs.existsSync(configPath) ? configPath : defaultPath;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).server;
}

async function main() {
  // Run DB migrations
  await runMigrations();
  logger.info('系统', '数据库迁移完成');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Static files
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Auth middleware (skip login + health)
  app.use(authMiddleware);

  // API routes
  app.use('/api/auth', authRouter);
  app.use('/api/115', router115);
  app.use('/api/config', configRouter);
  app.use('/api/tasks', taskRouter);
  app.use('/api/unmatched', unmatchedRouter);
  app.use('/api/tmdb', tmdbRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/templates', templateRouter);
  app.use('/api/logs', logRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/telegram', telegramRouter);
  app.use('/api/recycle', recycleRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(publicDir, 'index.html'));
    } else {
      res.status(404).json({ error: '接口不存在' });
    }
  });

  const serverConfig = loadServerConfig();
  const port = parseInt(process.env.PORT) || serverConfig.port || 2333;
  const host = process.env.HOST || serverConfig.host || '0.0.0.0';

  app.listen(port, host, () => {
    logger.info('系统', `服务已启动: http://${host}:${port}`);
    notifySystem(`服务已启动 (${host}:${port})`).catch(() => {});
  });

  // Start scheduler
  scheduler.start();

  // Start Telegram bot long-polling
  telegramBot.start();

  // Cleanup old logs
  cleanupOldLogs();

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info('系统', `收到 ${signal}，正在关闭...`);
    notifySystem('服务正在关闭').catch(() => {});
    try { scheduler.stop(); } catch {}
    try { telegramBot.stop(); } catch {}
    try { closeDb(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
