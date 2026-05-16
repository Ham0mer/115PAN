registerPage('tools-templates', async (container) => {
  async function render() {
    try {
      const [tmpl, presets] = await Promise.all([
        API.get('/api/templates'),
        API.get('/api/templates/presets'),
      ]);

      const activeTab = container.dataset.tab || 'movie';
      container.innerHTML = `
        <div class="flex-between mb-16">
          <h3>命名模板</h3>
          <div class="flex gap-8">
            <select id="preset-select"><option value="">加载预设...</option>${Object.keys(presets).map(k => `<option value="${k}">${k}</option>`).join('')}</select>
            <button class="btn btn-sm btn-warn" id="btn-reset">恢复默认</button>
          </div>
        </div>
        <div class="tabs">
          <button class="tab-btn ${activeTab==='movie'?'active':''}" data-tab="movie">电影模板</button>
          <button class="tab-btn ${activeTab==='tv'?'active':''}" data-tab="tv">剧集模板</button>
          <button class="tab-btn ${activeTab==='common'?'active':''}" data-tab="common">通用</button>
        </div>
        <div id="tab-content" class="card"></div>
        <div class="card mt-16">
          <div class="card-header">实时预览</div>
          <div class="form-row">
            <div class="form-group"><label>标题</label><input type="text" id="preview-title" value="流浪地球2"></div>
            <div class="form-group"><label>年份</label><input type="text" id="preview-year" value="2023"></div>
            <div class="form-group"><label>TMDB ID</label><input type="text" id="preview-tmdb" value="842675"></div>
            <div class="form-group"><label>分辨率</label><input type="text" id="preview-res" value="2160p"></div>
            <div class="form-group"><label>来源</label><input type="text" id="preview-source" value="BluRay"></div>
            <div class="form-group"><label>编码</label><input type="text" id="preview-codec" value="H.265"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>位深</label><input type="text" id="preview-bit" value="10bit"></div>
            <div class="form-group"><label>音轨数</label><input type="text" id="preview-ac" value="2"></div>
            <div class="form-group"><label>音频编码</label><input type="text" id="preview-acodec" value="DDP"></div>
            <div class="form-group"><label>压制组</label><input type="text" id="preview-rg" value="FRDS"></div>
            <div class="form-group"><label>季</label><input type="text" id="preview-season" value="1"></div>
            <div class="form-group"><label>集</label><input type="text" id="preview-ep" value="1"></div>
          </div>
          <div class="form-group"><label>预览结果</label><div class="preview-box" id="preview-output"></div></div>
        </div>
        <div class="mt-16"><button class="btn btn-primary" id="btn-save-tmpl">保存模板</button></div>
      `;

      renderTabContent(activeTab, tmpl);
      updatePreview(tmpl);

      container.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          container.dataset.tab = btn.dataset.tab;
          renderTabContent(btn.dataset.tab, tmpl);
          container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      document.getElementById('preset-select').addEventListener('change', async (e) => {
        if (!e.target.value) return;
        await API.post('/api/templates/reset', { preset: e.target.value });
        showToast(`已加载 ${e.target.value} 预设`, 'success');
        const newTmpl = await API.get('/api/templates');
        renderTabContent(container.dataset.tab || 'movie', newTmpl);
        updatePreview(newTmpl);
      });

      document.getElementById('btn-reset').addEventListener('click', async () => {
        if (!confirm('确定恢复默认模板吗？')) return;
        await API.post('/api/templates/reset');
        showToast('已恢复默认','success');
        const newTmpl = await API.get('/api/templates');
        renderTabContent(container.dataset.tab || 'movie', newTmpl);
        updatePreview(newTmpl);
      });

      document.getElementById('btn-save-tmpl').addEventListener('click', async () => {
        const data = {
          movie_folder: document.getElementById('tmpl-movie-folder')?.value,
          movie_file: document.getElementById('tmpl-movie-file')?.value,
          tv_show: document.getElementById('tmpl-tv-show')?.value,
          tv_season: document.getElementById('tmpl-tv-season')?.value,
          tv_episode: document.getElementById('tmpl-tv-episode')?.value,
          tv_episode_range: document.getElementById('tmpl-tv-range')?.value,
          common_subtitle_suffix: document.getElementById('tmpl-sub-suffix')?.value,
          common_multi_version_suffix: document.getElementById('tmpl-ver-suffix')?.value,
        };
        try {
          await API.put('/api/templates', data);
          showToast('模板已保存','success');
        } catch(err) { showToast(err.message,'error'); }
      });

      // Live preview on input change
      container.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => {
          updatePreview(getCurrentTemplateValues());
        });
      });

    } catch(err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }

  function renderTabContent(tab, tmpl) {
    const content = document.getElementById('tab-content');
    if (tab === 'movie') {
      content.innerHTML = `
        <div class="form-group"><label>电影目录模板</label><input type="text" id="tmpl-movie-folder" value="${esc(tmpl.movie_folder||'')}"></div>
        <div class="form-group"><label>电影文件模板</label><input type="text" id="tmpl-movie-file" value="${esc(tmpl.movie_file||'')}"></div>
        <div class="chip-group">
          <span class="chip" data-var="{title}">标题</span><span class="chip" data-var="{year}">年份</span><span class="chip" data-var="{tmdbId}">TMDB ID</span>
          <span class="chip" data-var="{resolution}">分辨率</span><span class="chip" data-var="{source}">来源</span><span class="chip" data-var="{videoCodec}">编码</span>
          <span class="chip" data-var="{bitDepth}">位深</span><span class="chip" data-var="{hdr}">HDR</span><span class="chip" data-var="{audioCount}">音轨数</span>
          <span class="chip" data-var="{audioCodec}">音频编码</span><span class="chip" data-var="{releaseGroup}">压制组</span>
          <span class="chip" data-var="{imdbId}">IMDB ID</span><span class="chip" data-var="{originalTitle}">原名</span>
        </div>
      `;
    } else if (tab === 'tv') {
      content.innerHTML = `
        <div class="form-group"><label>剧集总目录模板</label><input type="text" id="tmpl-tv-show" value="${esc(tmpl.tv_show||'')}"></div>
        <div class="form-group"><label>季目录模板</label><input type="text" id="tmpl-tv-season" value="${esc(tmpl.tv_season||'')}"></div>
        <div class="form-group"><label>单集文件模板</label><input type="text" id="tmpl-tv-episode" value="${esc(tmpl.tv_episode||'')}"></div>
        <div class="form-group"><label>多集文件模板</label><input type="text" id="tmpl-tv-range" value="${esc(tmpl.tv_episode_range||'')}"></div>
        <div class="chip-group">
          <span class="chip" data-var="{title}">标题</span><span class="chip" data-var="{year}">年份</span><span class="chip" data-var="{tmdbId}">TMDB ID</span>
          <span class="chip" data-var="{season}">季</span><span class="chip" data-var="{episode}">集</span><span class="chip" data-var="{episode_start}">集开始</span>
          <span class="chip" data-var="{episode_end}">集结束</span><span class="chip" data-var="{episodeTitle}">集标题</span><span class="chip" data-var="{seasonTitle}">季标题</span>
          <span class="chip" data-var="{airDate}">播出日</span><span class="chip" data-var="{resolution}">分辨率</span><span class="chip" data-var="{source}">来源</span>
          <span class="chip" data-var="{videoCodec}">编码</span><span class="chip" data-var="{bitDepth}">位深</span><span class="chip" data-var="{audioCount}">音轨数</span>
          <span class="chip" data-var="{audioCodec}">音频编码</span><span class="chip" data-var="{releaseGroup}">压制组</span>
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="form-group"><label>字幕语言后缀</label><input type="text" id="tmpl-sub-suffix" value="${esc(tmpl.common_subtitle_suffix||'')}"></div>
        <div class="form-group"><label>多版本后缀</label><input type="text" id="tmpl-ver-suffix" value="${esc(tmpl.common_multi_version_suffix||'')}"></div>
        <div class="chip-group"><span class="chip" data-var="{lang}">语言代码</span><span class="chip" data-var="{n}">版本号</span></div>
      `;
    }

    // Click chips to insert variable
    content.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const input = content.querySelector('input:focus') || content.querySelector('input');
        if (input) {
          const start = input.selectionStart;
          input.value = input.value.slice(0, start) + chip.dataset.var + input.value.slice(input.selectionEnd);
          input.focus();
          input.dispatchEvent(new Event('input'));
        }
      });
    });
  }

  function getCurrentTemplateValues() {
    return {
      movie_folder: document.getElementById('tmpl-movie-folder')?.value || '',
      movie_file: document.getElementById('tmpl-movie-file')?.value || '',
      tv_show: document.getElementById('tmpl-tv-show')?.value || '',
      tv_season: document.getElementById('tmpl-tv-season')?.value || '',
      tv_episode: document.getElementById('tmpl-tv-episode')?.value || '',
      tv_episode_range: document.getElementById('tmpl-tv-range')?.value || '',
      common_subtitle_suffix: document.getElementById('tmpl-sub-suffix')?.value || '',
      common_multi_version_suffix: document.getElementById('tmpl-ver-suffix')?.value || '',
    };
  }

  async function updatePreview(tmpl) {
    const vars = {
      title: document.getElementById('preview-title')?.value || '',
      year: document.getElementById('preview-year')?.value || '',
      tmdbId: document.getElementById('preview-tmdb')?.value || '',
      resolution: document.getElementById('preview-res')?.value || '',
      source: document.getElementById('preview-source')?.value || '',
      videoCodec: document.getElementById('preview-codec')?.value || '',
      bitDepth: document.getElementById('preview-bit')?.value || '',
      audioCount: document.getElementById('preview-ac')?.value || '',
      audioCodec: document.getElementById('preview-acodec')?.value || '',
      releaseGroup: document.getElementById('preview-rg')?.value || '',
      season: parseInt(document.getElementById('preview-season')?.value) || 1,
      episode: parseInt(document.getElementById('preview-ep')?.value) || 1,
    };
    const template = tmpl?.movie_folder || document.getElementById('tmpl-movie-folder')?.value || '';
    try {
      const preview = await API.post('/api/templates/preview', { template, vars });
      const outEl = document.getElementById('preview-output');
      if (outEl) outEl.textContent = preview.result;
    } catch {}
  }

  render();
});
