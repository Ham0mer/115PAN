registerPage('unmatched', async (container) => {
  async function render(page = 1, filters = {}) {
    try {
      const qs = new URLSearchParams({ limit: 50, offset: (page-1)*50, ...filters });
      const data = await API.get(`/api/unmatched?${qs}`);
      container.innerHTML = `
        <div class="flex-between mb-16">
          <h3>识别失败队列</h3>
          <div class="flex gap-8">
            <button class="btn btn-sm" id="btn-retry-all">批量重试</button>
            <button class="btn btn-sm btn-warn" id="btn-clear-unmatched">清除已处理</button>
          </div>
        </div>
        <div class="form-row mb-16">
          <div class="form-group" style="flex:0 0 150px;margin-bottom:0">
            <select id="filter-status">
              <option value="">全部状态</option>
              <option value="pending" ${filters.status==='pending'?'selected':''}>待处理</option>
              <option value="ignored" ${filters.status==='ignored'?'selected':''}>已忽略</option>
              <option value="resolved" ${filters.status==='resolved'?'selected':''}>已解决</option>
            </select>
          </div>
          <div class="form-group" style="flex:0 0 150px;margin-bottom:0">
            <select id="filter-type">
              <option value="">全部类型</option>
              <option value="movie" ${filters.mediaType==='movie'?'selected':''}>电影</option>
              <option value="tv" ${filters.mediaType==='tv'?'selected':''}>剧集</option>
              <option value="anime" ${filters.mediaType==='anime'?'selected':''}>动漫</option>
              <option value="unknown" ${filters.mediaType==='unknown'?'selected':''}>未知</option>
            </select>
          </div>
          <div class="form-group" style="flex:1;margin-bottom:0">
            <input type="text" id="filter-keyword" placeholder="搜索文件名..." value="${esc(filters.keyword||'')}">
          </div>
          <button class="btn" id="btn-filter">筛选</button>
        </div>
        <div class="card">
          <table class="table">
            <thead><tr><th>文件名</th><th>类型猜测</th><th>失败原因</th><th>重试次数</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              ${data.items.length === 0 ? '<tr><td colspan="6" class="text-center">暂无失败记录</td></tr>' :
                data.items.map(item => `
                  <tr class="${item.retry_count>=5?'tr-highlight':''}">
                    <td class="truncate" style="max-width:200px">${esc(item.source_name)}</td>
                    <td>${item.media_type_guess||'未知'}</td>
                    <td class="truncate" style="max-width:200px">${esc(item.fail_reason||'')}</td>
                    <td>${item.retry_count}/${item.max_retries}</td>
                    <td>${item.created_at}</td>
                    <td>
                      <button class="btn btn-sm view-detail" data-id="${item.id}">处理</button>
                      <button class="btn btn-sm retry-item" data-id="${item.id}">重试</button>
                      <button class="btn btn-sm ignore-item" data-id="${item.id}">忽略</button>
                    </td>
                  </tr>
                `).join('')
              }
            </tbody>
          </table>
        </div>
        <div id="detail-panel" style="display:none" class="card mt-16"></div>
      `;

      bindUnmatchedEvents(page, filters);
    } catch (err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }

  function bindUnmatchedEvents(page, filters) {
    document.getElementById('btn-filter').addEventListener('click', () => {
      filters.status = document.getElementById('filter-status').value;
      filters.mediaType = document.getElementById('filter-type').value;
      filters.keyword = document.getElementById('filter-keyword').value;
      render(1, filters);
    });

    document.getElementById('btn-clear-unmatched').addEventListener('click', async () => {
      if (!confirm('确定清除所有已忽略和已解决的记录吗？待处理条目会保留。此操作不可恢复。')) return;
      try {
        const r = await API.post('/api/unmatched/clear');
        showToast(`已清除 ${r.deleted} 条记录`, 'success');
        render(page, filters);
      } catch(err) { showToast(err.message, 'error'); }
    });

    container.querySelectorAll('.view-detail').forEach(btn => {
      btn.addEventListener('click', async () => {
        const panel = document.getElementById('detail-panel');
        panel.style.display = '';
        panel.innerHTML = '<p>加载中...</p>';
        try {
          const item = await API.get(`/api/unmatched/${btn.dataset.id}`);
          panel.innerHTML = `
            <div class="card-header">处理: ${esc(item.source_name)}</div>
            <p>路径: ${esc(item.source_path)}</p>
            <p>猜测类型: ${item.media_type_guess}</p>
            <p>失败原因: ${esc(item.fail_reason||'')}</p>
            <p>尝试记录: ${esc(JSON.stringify(item.identify_attempts||[]))}</p>
            <div class="form-row mt-16">
              <div class="form-group">
                <label>TMDB ID</label>
                <input type="number" id="resolve-tmdb" placeholder="手动输入TMDB ID">
              </div>
              <div class="form-group">
                <label>类型</label>
                <select id="resolve-type"><option value="movie">电影</option><option value="tv">剧集</option><option value="anime">动漫</option></select>
              </div>
              <div class="form-group"><label>季</label><input type="number" id="resolve-season" placeholder="季号"></div>
              <div class="form-group"><label>集</label><input type="number" id="resolve-episode" placeholder="集号"></div>
            </div>
            <button class="btn btn-primary" id="btn-resolve" data-id="${item.id}">手动入库</button>
          `;
          document.getElementById('btn-resolve').addEventListener('click', async () => {
            await API.post(`/api/unmatched/${item.id}/resolve`, {
              tmdbId: document.getElementById('resolve-tmdb').value,
              mediaType: document.getElementById('resolve-type').value,
              season: document.getElementById('resolve-season').value || null,
              episode: document.getElementById('resolve-episode').value || null,
            });
            showToast('已处理','success');
            render(page, filters);
          });
        } catch (err) {
          panel.innerHTML = `<p class="error-msg">${err.message}</p>`;
        }
      });
    });

    container.querySelectorAll('.retry-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        await API.post(`/api/unmatched/${btn.dataset.id}/retry`);
        showToast('已重试','success');
        render(page, filters);
      });
    });

    container.querySelectorAll('.ignore-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        await API.post(`/api/unmatched/${btn.dataset.id}/ignore`);
        showToast('已忽略','success');
        render(page, filters);
      });
    });
  }
  render();
});
