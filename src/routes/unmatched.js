import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { getDb } from '../services/db.js';
import { logger } from '../services/logger.js';
import { parseFilename } from '../services/parser.js';
import { aiIdentify } from '../services/ai.js';
import { searchMulti, searchMovie, searchTV, getMovieDetails, getTVDetails, findByImdbId, isAnime, getYear, getTitle } from '../services/tmdb.js';
import { resolveUnmatched } from '../services/organizer.js';
import { moveToRecycleBatch } from '../services/115.js';
import { generateThumbnail } from '../services/ffprobe.js';

export const unmatchedRouter = Router();

const THUMB_DIR = path.resolve(process.cwd(), 'data', 'thumbnails');

// List
unmatchedRouter.get('/', (req, res) => {
  const db = getDb();
  const { status, mediaType, keyword, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM unmatched_items WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (mediaType) { sql += ' AND media_type_guess=?'; params.push(mediaType); }
  if (keyword) { sql += ' AND (source_name LIKE ? OR source_path LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const items = db.prepare(sql).all(...params);
  const total = db.prepare("SELECT COUNT(*) as count FROM unmatched_items WHERE status='pending'").get().count;
  res.json({ items, total });
});

unmatchedRouter.get('/:id', (req, res) => {
  const item = getDb().prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '条目不存在' });
  try { item.identify_attempts = JSON.parse(item.identify_attempts || '[]'); } catch { item.identify_attempts = []; }
  try { item.file_ids = JSON.parse(item.file_ids || '[]'); } catch { item.file_ids = []; }
  res.json(item);
});

// Thumbnail: generate on demand if not cached
unmatchedRouter.get('/:id/thumbnail', async (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).end();
    if (item.thumbnail_path && fs.existsSync(item.thumbnail_path)) {
      return res.sendFile(path.resolve(item.thumbnail_path));
    }
    const files = JSON.parse(item.file_ids || '[]');
    const firstVideo = files.find(f => f.isVideo);
    if (!firstVideo) return res.status(404).json({ error: '无视频文件' });
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
    const out = path.join(THUMB_DIR, `${item.id}.jpg`);
    const ok = await generateThumbnail(firstVideo.id, out);
    if (!ok) return res.status(500).json({ error: '缩略图生成失败' });
    db.prepare('UPDATE unmatched_items SET thumbnail_path=? WHERE id=?').run(out, item.id);
    res.sendFile(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve: actually move + rename + record via organizer.resolveUnmatched
unmatchedRouter.post('/:id/resolve', async (req, res) => {
  try {
    const result = await resolveUnmatched(req.params.id, req.body);
    logger.info('Unmatched', `已解决: id=${req.params.id} taskId=${result.taskId}`);
    res.json({ success: true, ...result });
  } catch (err) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
    if (item) {
      const next = (item.retry_count || 0) + 1;
      db.prepare('UPDATE unmatched_items SET retry_count=?, last_error=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
        .run(next, err.message, req.params.id);
    }
    res.status(400).json({ error: err.message });
  }
});

// Retry: re-run filename parsing → TMDB → AI (per spec 4.6)
unmatchedRouter.post('/:id/retry', async (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '条目不存在' });

  const { skipLocal, forceTv, forceMovie, useAi } = req.body || {};
  try {
    let id = { title: '', year: '', tmdbId: null, mediaType: null, identifySource: '' };

    if (!skipLocal) {
      const parsed = parseFilename(item.source_name);
      id.title = parsed.title;
      id.year = parsed.year;
      id.season = parsed.season;
      id.episode = parsed.episode;
      id.mediaType = parsed.mediaType;
      id.identifySource = 'local';
    }
    if (forceTv) id.mediaType = 'tv';
    if (forceMovie) id.mediaType = 'movie';

    // TMDB
    if (id.title && !id.tmdbId) {
      let results = [];
      if (id.mediaType === 'movie') results = (await searchMovie(id.title, id.year)).map(r => ({ ...r, media_type: 'movie' }));
      else if (id.mediaType === 'tv') results = (await searchTV(id.title, id.year)).map(r => ({ ...r, media_type: 'tv' }));
      else results = await searchMulti(id.title, id.year);
      if (results.length) {
        const best = results[0];
        const detail = best.media_type === 'movie' ? await getMovieDetails(best.id) : await getTVDetails(best.id);
        id.tmdbId = best.id;
        id.title = getTitle(detail || best) || id.title;
        id.year = getYear(detail || best) || id.year;
        id.mediaType = isAnime(detail || best) ? 'anime' : best.media_type;
        id.tmdbCandidates = results.slice(0, 5).map(r => ({
          id: r.id, title: r.title || r.name, year: (r.release_date || r.first_air_date || '').slice(0,4), media_type: r.media_type,
        }));
        id.identifySource = 'tmdb';
      }
    }

    // AI (only when explicitly requested or still missing tmdbId)
    if ((useAi || !id.tmdbId)) {
      try {
        const ai = await aiIdentify(item.source_name);
        if (ai) {
          if (!id.title && ai.title) id.title = ai.title;
          if (!id.year && ai.year) id.year = String(ai.year);
          if (!id.tmdbId && ai.tmdbId) id.tmdbId = ai.tmdbId;
          if (id.season == null && ai.season != null) id.season = ai.season;
          if (id.episode == null && ai.episode != null) id.episode = ai.episode;
          if (!id.mediaType && ai.mediaType) id.mediaType = ai.mediaType;
          id.identifySource = id.identifySource || 'ai';
        }
      } catch (err) {
        logger.warn('Unmatched', 'AI识别失败', err.message);
      }
    }

    // Append to attempts log
    const attempts = JSON.parse(item.identify_attempts || '[]');
    attempts.push({ timestamp: new Date().toISOString(), result: id });
    const retryCount = (item.retry_count || 0) + 1;
    db.prepare('UPDATE unmatched_items SET identify_attempts=?, retry_count=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(JSON.stringify(attempts), retryCount, req.params.id);

    const resolved = !!(id.tmdbId && id.title && id.year);
    res.json({ success: true, resolved, identification: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMDB lookup
unmatchedRouter.post('/:id/imdb', async (req, res) => {
  try {
    const { imdbId } = req.body;
    if (!imdbId) return res.status(400).json({ error: '请提供 IMDB ID' });
    const r = await findByImdbId(imdbId);
    if (!r) return res.status(404).json({ error: '未找到对应条目' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

unmatchedRouter.post('/:id/ignore', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '条目不存在' });
  db.prepare("UPDATE unmatched_items SET status='ignored', updated_at=datetime('now','localtime') WHERE id=?").run(req.params.id);
  // Add fingerprints so the file is skipped on rescan
  try {
    const files = JSON.parse(item.file_ids || '[]');
    const fingerprint = files.map(f => `${f.id}:${f.size}`).join('|');
    if (fingerprint) db.prepare('INSERT INTO ignore_fingerprints (source_path, fingerprint) VALUES (?,?)').run(item.source_path, fingerprint);
  } catch {}
  res.json({ success: true });
});

// Delete source files: actually call 115 recycle on stored file IDs
unmatchedRouter.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: '条目不存在' });
    const files = JSON.parse(item.file_ids || '[]');
    const errors = [];
    const ids = files.map(f => f.id).filter(Boolean);
    if (ids.length) {
      try { await moveToRecycleBatch(ids); }
      catch (err) { errors.push({ file: files.map(f => f.name).join(','), error: err.message }); }
    }
    // Clean up thumbnail
    if (item.thumbnail_path && fs.existsSync(item.thumbnail_path)) {
      try { fs.unlinkSync(item.thumbnail_path); } catch {}
    }
    db.prepare("UPDATE unmatched_items SET status='resolved', updated_at=datetime('now','localtime') WHERE id=?").run(req.params.id);
    logger.info('Unmatched', `已删除源文件: ${item.source_name}`);
    res.json({ success: true, errors: errors.length ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all non-pending records (ignored + resolved). Pending entries are preserved.
unmatchedRouter.post('/clear', (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT id, thumbnail_path FROM unmatched_items WHERE status != 'pending'").all();
  for (const r of rows) {
    if (r.thumbnail_path && fs.existsSync(r.thumbnail_path)) {
      try { fs.unlinkSync(r.thumbnail_path); } catch {}
    }
  }
  const result = db.prepare("DELETE FROM unmatched_items WHERE status != 'pending'").run();
  logger.info('Unmatched', `已清除 ${result.changes} 条已处理记录`);
  res.json({ success: true, deleted: result.changes });
});

// Batch retry
unmatchedRouter.post('/batch/retry', async (req, res) => {
  const { ids = [] } = req.body || {};
  if (!ids.length) return res.status(400).json({ error: '未选择条目' });
  const results = [];
  for (const id of ids) {
    try {
      // Make an internal HTTP-like call by inlining the retry logic via parser+TMDB
      const item = getDb().prepare('SELECT * FROM unmatched_items WHERE id=?').get(id);
      if (!item) continue;
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  res.json({ success: true, results });
});

// Batch assign same TV (S only; per-episode E parsed from filename)
unmatchedRouter.post('/batch/resolve-tv', async (req, res) => {
  const { ids = [], tmdbId, season } = req.body || {};
  if (!ids.length || !tmdbId || season == null) return res.status(400).json({ error: '参数不完整' });
  const okList = [];
  const failList = [];
  for (const id of ids) {
    try {
      const r = await resolveUnmatched(id, { tmdbId, season: Number(season), mediaType: 'tv' });
      okList.push({ id, taskId: r.taskId });
    } catch (err) {
      failList.push({ id, error: err.message });
    }
  }
  res.json({ success: true, resolved: okList, failed: failList });
});

// Batch delete
unmatchedRouter.post('/batch/delete', async (req, res) => {
  const { ids = [] } = req.body || {};
  if (!ids.length) return res.status(400).json({ error: '未选择条目' });
  const db = getDb();
  const results = [];
  for (const id of ids) {
    try {
      const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(id);
      if (!item) continue;
      const files = JSON.parse(item.file_ids || '[]');
      const fileIds = files.map(f => f.id).filter(Boolean);
      if (fileIds.length) {
        try { await moveToRecycleBatch(fileIds); } catch {}
      }
      db.prepare("UPDATE unmatched_items SET status='resolved', updated_at=datetime('now','localtime') WHERE id=?").run(id);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  res.json({ success: true, results });
});

// Auto-retry job hook (callable from a scheduler)
export async function autoRetryAll(useAi = false) {
  const db = getDb();
  const items = db.prepare("SELECT id FROM unmatched_items WHERE status='pending'").all();
  for (const { id } of items) {
    try {
      // Quick re-parse + TMDB only
      const item = db.prepare('SELECT * FROM unmatched_items WHERE id=?').get(id);
      const parsed = parseFilename(item.source_name);
      if (!parsed.title) continue;
      const results = await searchMulti(parsed.title, parsed.year);
      if (!results.length && !useAi) continue;
      if (results.length) {
        const best = results[0];
        const attempts = JSON.parse(item.identify_attempts || '[]');
        attempts.push({ timestamp: new Date().toISOString(), result: { ...parsed, tmdbId: best.id, source: 'auto-retry' } });
        db.prepare('UPDATE unmatched_items SET identify_attempts=?, retry_count=retry_count+1 WHERE id=?')
          .run(JSON.stringify(attempts), id);
      }
    } catch {}
  }
}
