import { Router } from 'express';
import { sendTestMessage, sendCustomMessage } from '../services/telegram.js';
import { logger } from '../services/logger.js';

export const telegramRouter = Router();

// Send test message
telegramRouter.post('/test', async (req, res) => {
  try {
    const { botId } = req.body;
    await sendTestMessage(botId);
    logger.info('Telegram', '测试消息发送成功');
    res.json({ success: true, message: '测试消息已发送' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send custom message
telegramRouter.post('/send', async (req, res) => {
  try {
    const { botId, text } = req.body;
    if (!text) return res.status(400).json({ error: '消息内容不能为空' });
    await sendCustomMessage(botId, text);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
