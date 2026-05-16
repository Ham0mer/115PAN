import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../services/db.js';

const TOKEN_EXPIRY = '24h';
let cachedSecret = null;

function getAdminConfig() {
  const configPath = path.join(process.cwd(), 'config', 'config.json');
  const defaultPath = path.join(process.cwd(), 'config', 'default.json');
  const p = fs.existsSync(configPath) ? configPath : defaultPath;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).admin;
}

// Persistent JWT secret: env var > app_settings table > newly generated.
function getJwtSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.JWT_SECRET) { cachedSecret = process.env.JWT_SECRET; return cachedSecret; }
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_settings WHERE key='jwt_secret'").get();
    if (row?.value) { cachedSecret = row.value; return cachedSecret; }
    const fresh = crypto.randomBytes(48).toString('hex');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('jwt_secret', ?, datetime('now','localtime'))").run(fresh);
    cachedSecret = fresh;
    return cachedSecret;
  } catch {
    // DB not ready yet - fall back to env-only for the boot phase.
    cachedSecret = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
    return cachedSecret;
  }
}

// Determine the stored admin password hash (or plaintext as a fallback for first boot).
function getStoredAdminAuth() {
  const admin = getAdminConfig();
  const username = admin?.username || 'admin';
  // Prefer hash from app_settings (set on first successful login when config still has plaintext).
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_settings WHERE key='admin_password_hash'").get();
    if (row?.value) return { username, hash: row.value, fromDb: true };
  } catch {}
  return { username, plain: admin?.password || '', fromDb: false };
}

function persistAdminHash(plain) {
  try {
    const db = getDb();
    const hash = bcrypt.hashSync(plain, 10);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('admin_password_hash', ?, datetime('now','localtime'))").run(hash);
  } catch {}
}

export function verifyPassword(username, password) {
  const stored = getStoredAdminAuth();
  if (username !== stored.username) return false;
  if (stored.hash) return bcrypt.compareSync(password, stored.hash);
  // First-time login: config has plaintext. Compare, then upgrade to hash.
  if (password === stored.plain) {
    persistAdminHash(password);
    return true;
  }
  return false;
}

export function changeAdminPassword(username, oldPassword, newPassword) {
  if (!verifyPassword(username, oldPassword)) {
    throw new Error('原密码错误');
  }
  if (!newPassword || newPassword.length < 6) {
    throw new Error('新密码至少 6 位');
  }
  persistAdminHash(newPassword);
}

export function generateToken(username) {
  return jwt.sign({ username, role: 'admin' }, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

export function authMiddleware(req, res, next) {
  if (req.path === '/api/auth/login' || req.path === '/api/health') return next();
  if (!req.path.startsWith('/api')) return next();

  const authHeader = req.headers.authorization;
  const token = (authHeader?.startsWith('Bearer ') && authHeader.slice(7)) || req.query.token;
  if (!token) {
    return res.status(401).json({ error: '未授权访问' });
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}
