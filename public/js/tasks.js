registerPage('tasks', async (container) => {
  async function render(page = 1) {
    try {
      const data = await API.get(`/api/tasks?limit=20&offset=${(page-1)*20}`);
      container.innerHTML = `
        <div class="flex-between mb-16">
          <h3>任务历史</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="btn-run-now">立即整理</button>
            <button class="btn btn-warn" id="btn-clear-tasks">清除任务</button>
          </div>
        </div>
        <div class="card">
          <table class="table">
            <thead><tr><th>ID</th><th>状态</th><th>扫描</th><th>成功</th><th>失败</th><th>跳过</th><th>开始时间</th><th>结束时间</th><th>操作</th></tr></thead>
            <tbody>
              ${data.tasks.length === 0 ? '<tr><td colspan="9" class="text-center">暂无任务记录</td></tr>' :
                data.tasks.map(t => `
                  <tr>
                    <td>${t.id}</td>
                    <td class="text-${t.status==='completed'?'success':t.status==='failed'?'error':t.status==='running'?'warn':''}">${t.status}</td>
                    <td>${t.scan_count}</td>
                    <td>${t.success_count}</td>
                    <td>${t.fail_count}</td>
                    <td>${t.skip_count}</td>
                    <td>${t.started_at||'-'}</td>
                    <td>${t.ended_at||'-'}</td>
                    <td>
                      <button class="btn btn-sm view-task" data-id="${t.id}">详情</button>
                      ${t.status==='running' ? `<button class="btn btn-sm btn-warn cancel-task" data-id="${t.id}">取消</button>` : ''}
                    </td>
                  </tr>
                `).join('')
              }
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <button ${page<=1?'disabled':''} data-page="${page-1}">上一页</button>
          <span>第 ${page} 页，共 ${Math.ceil(data.total/20)||1} 页</span>
          <button ${page*20>=data.total?'disabled':''} data-page="${page+1}">下一页</button>
        </div>
        <div id="task-detail" style="display:none" class="card mt-16"></div>
      `;

      document.getElementById('btn-run-now').addEventListener('click', async () => {
        try { await API.post('/api/tasks/run-now'); showToast('整理任务已启动','success'); render(); }
        catch(err) { showToast(err.message,'error'); }
      });

      document.getElementById('btn-clear-tasks').addEventListener('click', async () => {
        if (!confirm('确定清除所有非运行中的任务记录吗？此操作不可恢复。')) return;
        try {
          const r = await API.post('/api/tasks/clear');
          showToast(`已清除 ${r.deleted} 条任务记录`, 'success');
          render();
        } catch(err) { showToast(err.message, 'error'); }
      });

      container.querySelectorAll('.view-task').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const detail = document.getElementById('task-detail');
          detail.style.display = '';
          detail.innerHTML = '<p>加载中...</p>';
          try {
            const task = await API.get(`/api/tasks/${id}`);
            detail.innerHTML = `
              <div class="card-header">任务 #${task.id} 详情</div>
              <table class="table">
                <thead><tr><th>类型</th><th>原名</th><th>新名</th><th>TMDB ID</th><th>S/E</th><th>识别来源</th><th>耗时</th><th>错误</th></tr></thead>
                <tbody>${(task.items||[]).map(i => `
                  <tr class="${i.error?'tr-highlight':''}">
                    <td>${i.media_type}</td>
                    <td class="truncate" style="max-width:150px">${esc(i.original_name||'')}</td>
                    <td class="truncate" style="max-width:150px">${esc(i.new_name||'')}</td>
                    <td>${i.tmdb_id||'-'}</td>
                    <td>${i.season?'S'+String(i.season).padStart(2,'0'):''}${i.episode?'E'+String(i.episode).padStart(2,'0'):''}</td>
                    <td>${i.identify_source||'-'}</td>
                    <td>${i.duration_ms?i.duration_ms+'ms':'-'}</td>
                    <td class="truncate" style="max-width:150px">${esc(i.error||'')}</td>
                  </tr>`).join('')}</tbody>
              </table>
            `;
          } catch(err) { detail.innerHTML = `<p class="error-msg">${err.message}</p>`; }
        });
      });

      container.querySelectorAll('.cancel-task').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('确定取消此任务吗？')) return;
          await API.post(`/api/tasks/${btn.dataset.id}/cancel`);
          render();
        });
      });

      container.querySelectorAll('.pagination button[data-page]').forEach(btn => {
        btn.addEventListener('click', () => render(parseInt(btn.dataset.page)));
      });
    } catch (err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }
  render();
});
