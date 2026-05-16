import { Router } from 'express';
import { verifyPassword, generateToken } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  if (verifyPassword(username, password)) {
    const token = generateToken(username);
    res.json({ token, username, role: 'admin' });
  } else {
    res.status(401).json({ error: '用户名或密码错误' });
  }
});

authRouter.get('/verify', (req, res) => {
  res.json({ valid: true, user: req.user });
});
