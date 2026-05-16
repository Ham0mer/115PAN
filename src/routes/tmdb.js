import { Router } from 'express';
import { searchMulti, searchMovie, searchTV, testConnection, findByImdbId } from '../services/tmdb.js';
import { logger } from '../services/logger.js';

export const tmdbRouter = Router();

// Search TMDB
tmdbRouter.get('/search', async (req, res) => {
  try {
    const { q, year, type } = req.query;
    if (!q) return res.status(400).json({ error: '搜索关键词不能为空' });

    let results;
    if (type === 'movie') {
      results = await searchMovie(q, year);
    } else if (type === 'tv') {
      results = await searchTV(q, year);
    } else {
      results = await searchMulti(q, year);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test TMDB connection
tmdbRouter.post('/test', async (req, res) => {
  try {
    await testConnection();
    logger.info('TMDB', '连接测试成功');
    res.json({ success: true, message: 'TMDB 连接正常' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find by IMDB ID
tmdbRouter.get('/find/imdb/:imdbId', async (req, res) => {
  try {
    const result = await findByImdbId(req.params.imdbId);
    if (!result) return res.status(404).json({ error: '未找到对应条目' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
