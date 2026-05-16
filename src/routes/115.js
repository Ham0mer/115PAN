import { Router } from 'express';
import { fetchQrToken, fetchQrStatus, fetchQrLoginResult, fetch115UserInfo, saveCookie, getActiveCookie, listFolders, verifyCookie, expireCookie, parseShareLink, fetchShareSnap, transferShareLink } from '../services/115.js';
import { logger } from '../services/logger.js';

export const router115 = Router();

// Get QR token (proxy the QR image from 115 so the 115 app can scan it)
router115.get('/qr/token', async (req, res) => {
  try {
    const token = await fetchQrToken();
    // Fetch the actual QR code image from 115's servers — it contains
    // the correct login payload that the 115 app recognizes.
    const imgRes = await fetch(token.qrcode, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36' },
    });
    if (!imgRes.ok) throw new Error(`获取二维码图片失败: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const qrDataUrl = `data:${imgRes.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`;
    res.json({ ...token, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check QR status
router115.get('/qr/status', async (req, res) => {
  try {
    const { uid, time, sign } = req.query;
    if (!uid || !time || !sign) return res.status(400).json({ error: '参数缺失' });
    const status = await fetchQrStatus(uid, parseInt(time), sign);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm QR login (get cookie)
router115.post('/qr/confirm', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid缺失' });
    const cookieStr = await fetchQrLoginResult(uid);
    const userInfo = await fetch115UserInfo(cookieStr);
    const cookie = saveCookie(cookieStr, userInfo);
    res.json({ success: true, user: { user_id: userInfo.user_id, user_name: userInfo.user_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current account info
router115.get('/account', (req, res) => {
  const cookie = getActiveCookie();
  if (!cookie) return res.json({ loggedIn: false });
  let vipInfo = null;
  try { vipInfo = cookie.vip_info ? JSON.parse(cookie.vip_info) : null; } catch {}
  const used = Number(cookie.size_used_raw) || 0;
  const total = Number(cookie.size_total_raw) || 0;
  res.json({
    loggedIn: true,
    userId: cookie.user_id,
    userName: cookie.user_name,
    createdAt: cookie.created_at,
    status: cookie.status,
    faceM: cookie.face_m || '',
    sizeUsed: cookie.size_used || '',
    sizeTotal: cookie.size_total || '',
    sizeUsedRaw: used,
    sizeTotalRaw: total,
    sizePercent: total > 0 ? +(used / total * 100).toFixed(2) : 0,
    vipInfo,
  });
});

// Verify cookie
router115.post('/verify', async (req, res) => {
  try {
    const cookie = getActiveCookie();
    if (!cookie) return res.json({ valid: false, message: '未登录' });
    const result = await verifyCookie(cookie.cookie_str);
    if (!result.valid) expireCookie(cookie.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
router115.post('/logout', (req, res) => {
  try {
    const cookie = getActiveCookie();
    if (cookie) expireCookie(cookie.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List folders for directory picker
router115.get('/folders', async (req, res) => {
  try {
    const cid = req.query.cid || '0';
    const folders = await listFolders(cid);
    res.json(folders.map(f => ({ cid: f.id, name: f.name, isDir: true })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share link: preview file list
router115.post('/share/parse', async (req, res) => {
  try {
    const { link } = req.body || {};
    const parsed = parseShareLink(link);
    if (!parsed) return res.status(400).json({ error: '链接格式错误，正确格式：https://115.com/s/<code>?password=<code>' });
    if (!getActiveCookie()) return res.status(401).json({ error: '未登录115账号' });
    const { shareInfo, list } = await fetchShareSnap(parsed.shareCode, parsed.receiveCode);
    res.json({
      shareCode: parsed.shareCode,
      receiveCode: parsed.receiveCode,
      shareInfo,
      files: list.map(f => ({ id: String(f.fid || f.cid), name: f.n, size: Number(f.s || 0), isFolder: !f.fid })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share link: transfer all files into target folder
router115.post('/share/transfer', async (req, res) => {
  try {
    const { link, targetCid } = req.body || {};
    if (!link) return res.status(400).json({ error: '请提供分享链接' });
    const result = await transferShareLink(link, targetCid || '0');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
