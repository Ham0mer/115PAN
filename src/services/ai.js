import { getDb } from './db.js';
import { logger } from './logger.js';

/**
 * 读取 AI 配置（config_ai 表，单行配置）。
 * 包含 api_key、base_url、model、temperature、prompt_template、max_retries、timeout_sec 等。
 */
function getConfig() {
  return getDb().prepare('SELECT * FROM config_ai WHERE id=1').get();
}

/**
 * 根据配置拼接 chat/completions 完整 URL。
 * 兼容 OpenAI 与 OpenAI 协议兼容的第三方端点（如本地 LLM 网关）。
 * 自动去除 base_url 末尾的多余斜杠，避免 // 出现。
 */
function getApiUrl(cfg) {
  return (cfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
}

// 默认提示词模板：使用 {filename} 占位符，结果约定为 JSON 字段
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

/**
 * 使用 AI 模型识别文件名所代表的媒体信息。
 * 作为本地解析 + TMDB 搜索都失败时的兜底手段，由 organizer 的 identifyGroup 调用。
 *
 * @param {string} filename 原始文件名（用于替换提示词中的 {filename}）
 * @param {string} [customPrompt] 可选的自定义提示词；不传时使用配置中的 prompt_template 或内置默认
 * @returns {Promise<{mediaType,title,year,tmdbId,season,episode}>} 解析后的 JSON 对象
 *
 * 行为：
 * - 走 OpenAI chat/completions 协议；
 * - 使用 AbortController 实现超时控制；
 * - 失败按 max_retries 重试，退避线性递增（1s, 2s, 3s ...）；
 * - 用正则截取响应中第一段 {...} 作为 JSON，容忍模型在 JSON 前后添加额外文字。
 * @throws 配置缺失或重试用尽时抛出
 */
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
      // 超时控制：用 AbortController + setTimeout 实现
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
      // 容错抽取首段 JSON 对象（模型可能输出多余说明文字）
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
      // 线性退避，避免连续打满 API
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

/**
 * 简单的 AI 连通性测试：发一条 "回复OK" 的最小请求。
 * 用于 Web 端"测试连接"按钮，校验 api_key/base_url/model 是否可用。
 * @returns {Promise<true>} 成功则返回 true，失败抛出。
 */
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
