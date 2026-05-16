import { getDb } from './db.js';
import { logger } from './logger.js';

function getConfig() {
  return getDb().prepare('SELECT * FROM config_ai WHERE id=1').get();
}

function getApiUrl(cfg) {
  return (cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
}

const DEFAULT_PROMPT = `你是一个媒体文件识别助手。请根据给定的文件名识别该媒体文件的信息。

请返回JSON格式，包含以下字段：
- mediaType: "movie" 或 "tv"
- title: 中文标题（优先）或原标题
- year: 上映/首播年份
- tmdbId: TMDB ID（如果知道）
- season: 季号（剧集时必填，数字）
- episode: 集号（剧集时必填，数字）

如果无法确定某个字段，设为null。

文件名: {filename}`;

export async function aiIdentify(filename, customPrompt) {
  const cfg = getConfig();
  if (!cfg?.api_key) throw new Error('AI未配置: 缺少 api_key');

  const prompt = (customPrompt || cfg.prompt_template || DEFAULT_PROMPT).replace('{filename}', filename);

  const body = JSON.stringify({
    model: cfg.model || 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: '你是一个精准的媒体文件识别助手。只返回JSON，不返回其他内容。' },
      { role: 'user', content: prompt }
    ],
    temperature: cfg.temperature ?? 0.3,
    max_tokens: 500,
  });

  for (let i = 0; i < (cfg.max_retries || 2); i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), (cfg.timeout_sec || 30) * 1000);

      const res = await fetch(getApiUrl(cfg), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`AI API ${res.status}: ${res.statusText}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      // Try to extract JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        logger.info('AI', `识别成功: ${filename} → ${result.title} (${result.mediaType})`);
        return result;
      }
      throw new Error('AI返回无法解析');
    } catch (err) {
      logger.warn('AI', `识别失败 (${i + 1}/${cfg.max_retries || 2}): ${filename}`, err.message);
      if (i === (cfg.max_retries || 2) - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function testAiConnection() {
  const cfg = getConfig();
  if (!cfg?.api_key) throw new Error('AI未配置: 缺少 api_key');

  const body = JSON.stringify({
    model: cfg.model || 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: '回复"OK"' }],
    max_tokens: 10,
  });

  const res = await fetch(getApiUrl(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
    body,
    signal: AbortSignal.timeout((cfg.timeout_sec || 30) * 1000),
  });
  if (!res.ok) throw new Error(`AI API ${res.status}`);
  return true;
}
