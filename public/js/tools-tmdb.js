registerPage('tools-tmdb', async (container) => {
  async function render() {
    try {
      const cfg = await API.get('/api/config/tmdb');
      container.innerHTML = `
        <h3>TMDB 配置</h3>
        <form id="tmdb-form" class="card">
          <div class="form-group"><label>API Key *</label><input type="password" id="tmdb-key" value="${esc(cfg.api_key||'')}" placeholder="输入 TMDB API Key"></div>
          <div class="form-group"><label>API Base URL</label><input type="text" id="tmdb-base" value="${esc(cfg.base_url||'https://api.themoviedb.org/3')}"></div>
          <div class="form-group"><label>图片域名</label><input type="text" id="tmdb-img" value="${esc(cfg.image_domain||'https://image.tmdb.org/t/p')}"></div>
          <div class="form-row">
            <div class="form-group"><label>首选语言</label><input type="text" id="tmdb-lang" value="${esc(cfg.primary_lang||'zh-CN')}"></div>
            <div class="form-group"><label>备选语言</label><input type="text" id="tmdb-fallback" value="${esc(cfg.fallback_lang||'en-US')}"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>超时（秒）</label><input type="number" id="tmdb-timeout" value="${cfg.timeout_sec||10}"></div>
            <div class="form-group"><label>最大重试</label><input type="number" id="tmdb-retries" value="${cfg.max_retries||3}"></div>
          </div>
          <div class="flex gap-8">
            <button type="submit" class="btn btn-primary">保存</button>
            <button type="button" class="btn btn-success" id="btn-tmdb-test">测试连通性</button>
          </div>
          <div id="tmdb-result" class="mt-8"></div>
        </form>
        <div class="card mt-16">
          <div class="card-header">TMDB 搜索测试</div>
          <div class="form-row">
            <div class="form-group" style="flex:1"><input type="text" id="tmdb-search-q" placeholder="搜索电影/剧集名称"></div>
            <div class="form-group" style="flex:0 0 120px"><select id="tmdb-search-type"><option value="">全部</option><option value="movie">电影</option><option value="tv">剧集</option></select></div>
            <button class="btn" id="btn-tmdb-search" style="align-self:flex-end">搜索</button>
          </div>
          <div id="tmdb-search-results"></div>
        </div>
      `;

      document.getElementById('tmdb-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await API.put('/api/config/tmdb', {
          api_key: document.getElementById('tmdb-key').value,
          base_url: document.getElementById('tmdb-base').value,
          image_domain: document.getElementById('tmdb-img').value,
          primary_lang: document.getElementById('tmdb-lang').value,
          fallback_lang: document.getElementById('tmdb-fallback').value,
          timeout_sec: parseInt(document.getElementById('tmdb-timeout').value),
          max_retries: parseInt(document.getElementById('tmdb-retries').value),
        });
        showToast('TMDB配置已保存','success');
      });

      document.getElementById('btn-tmdb-test').addEventListener('click', async () => {
        const r = document.getElementById('tmdb-result');
        r.innerHTML = '<p>测试中...</p>';
        try {
          await API.post('/api/tmdb/test');
          r.innerHTML = '<p class="text-success">连接成功</p>';
        } catch(err) { r.innerHTML = `<p class="text-error">${err.message}</p>`; }
      });

      document.getElementById('btn-tmdb-search').addEventListener('click', async () => {
        const q = document.getElementById('tmdb-search-q').value;
        const type = document.getElementById('tmdb-search-type').value;
        const r = document.getElementById('tmdb-search-results');
        r.innerHTML = '<p>搜索中...</p>';
        try {
          const results = await API.get(`/api/tmdb/search?q=${encodeURIComponent(q)}${type?'&type='+type:''}`);
          r.innerHTML = results.map(item => `
            <div class="card" style="padding:12px;margin:4px 0">
              <strong>${esc(item.title||item.name)}</strong> (${item.media_type||type})
              ${item.release_date||item.first_air_date ? ' - '+(item.release_date||item.first_air_date) : ''}
              <br><small>TMDB ID: ${item.id}</small>
            </div>`).join('') || '<p>无结果</p>';
        } catch(err) { r.innerHTML = `<p class="text-error">${err.message}</p>`; }
      });
    } catch(err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }
  render();
});
