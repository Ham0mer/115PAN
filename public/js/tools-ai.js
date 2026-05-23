const DEFAULT_AI_PROMPT = `你是一个媒体文件识别助手。请根据给定的文件名识别该媒体文件的信息。

请返回JSON格式，包含以下字段：
- mediaType: "movie" 或 "tv"
- title: 中文标题（优先）或原标题
- year: 上映/首播年份
- tmdbId: TMDB ID（如果知道）
- season: 季号（剧集时必填，数字）
- episode: 集号（剧集时必填，数字）

如果无法确定某个字段，设为null。

文件名: {filename}`;

registerPage('tools-ai', async (container) => {
  async function render() {
    try {
      const cfg = await API.get('/api/config/ai');
      container.innerHTML = `
        <h3>AI 辅助识别配置</h3>
        <form id="ai-form" class="card">
          <div class="form-group"><label>Base URL *</label><input type="text" id="ai-url" value="${esc(cfg.base_url||'')}" placeholder="https://api.openai.com/v1"></div>
          <div class="form-group"><label>API Key *</label><input type="password" id="ai-key" value="${esc(cfg.api_key||'')}" placeholder="输入 API Key"></div>
          <div class="form-row">
            <div class="form-group"><label>模型</label><input type="text" id="ai-model" value="${esc(cfg.model||'gpt-3.5-turbo')}"></div>
            <div class="form-group"><label>温度 (0-2)</label><input type="number" id="ai-temp" value="${cfg.temperature??0.3}" step="0.1" min="0" max="2"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>超时（秒）</label><input type="number" id="ai-timeout" value="${cfg.timeout_sec||30}"></div>
            <div class="form-group"><label>最大重试</label><input type="number" id="ai-retries" value="${cfg.max_retries||2}"></div>
          </div>
          <div class="form-group"><label>Prompt 模板</label>
            <textarea id="ai-prompt" rows="6" placeholder="自定义 Prompt 模板，使用 {filename} 作为文件名占位符">${esc(cfg.prompt_template||DEFAULT_AI_PROMPT)}</textarea>
          </div>
          <div class="flex gap-8">
            <button type="submit" class="btn btn-primary">保存</button>
            <button type="button" class="btn btn-success" id="btn-ai-test">测试连通性</button>
          </div>
          <div id="ai-result" class="mt-8"></div>
        </form>
        <div class="card mt-16">
          <div class="card-header">AI 识别测试</div>
          <div class="form-row">
            <div class="form-group" style="flex:1"><input type="text" id="ai-test-filename" placeholder="输入测试文件名"></div>
            <button class="btn" id="btn-ai-identify" style="align-self:flex-end;margin-bottom:16px">识别</button>
          </div>
          <div id="ai-identify-result" class="mt-8"></div>
        </div>
      `;

      document.getElementById('ai-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await API.put('/api/config/ai', {
          base_url: document.getElementById('ai-url').value,
          api_key: document.getElementById('ai-key').value,
          model: document.getElementById('ai-model').value,
          temperature: parseFloat(document.getElementById('ai-temp').value),
          timeout_sec: parseInt(document.getElementById('ai-timeout').value),
          max_retries: parseInt(document.getElementById('ai-retries').value),
          prompt_template: document.getElementById('ai-prompt').value,
        });
        showToast('AI配置已保存','success');
      });

      document.getElementById('btn-ai-test').addEventListener('click', async () => {
        const r = document.getElementById('ai-result');
        r.innerHTML = '<p>测试中...</p>';
        try {
          await API.post('/api/ai/test');
          r.innerHTML = '<p class="text-success">AI连接正常</p>';
        } catch(err) { r.innerHTML = `<p class="text-error">${err.message}</p>`; }
      });

      document.getElementById('btn-ai-identify').addEventListener('click', async () => {
        const fn = document.getElementById('ai-test-filename').value;
        const r = document.getElementById('ai-identify-result');
        r.innerHTML = '<p>识别中...</p>';
        try {
          const result = await API.post('/api/ai/identify', { filename: fn });
          r.innerHTML = `<pre class="preview-box">${esc(JSON.stringify(result,null,2))}</pre>`;
        } catch(err) { r.innerHTML = `<p class="text-error">${err.message}</p>`; }
      });
    } catch(err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }
  render();
});
