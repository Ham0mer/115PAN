import { Router } from 'express';
import { testAiConnection, aiIdentify } from '../services/ai.js';
import { logger } from '../services/logger.js';

export const aiRouter = Router();

// Test AI connection
aiRouter.post('/test', async (req, res) => {
  try {
    await testAiConnection();
    logger.info('AI', '连接测试成功');
    res.json({ success: true, message: 'AI 连接正常' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test AI identification with a filename
aiRouter.post('/identify', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: '请提供文件名' });
    const result = await aiIdentify(filename);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
