registerPage('dashboard', async (container) => {
  container.innerHTML = '<h3>仪表盘</h3><div class="text-center mt-16">加载中...</div>';

  try {
    const stats = await API.get('/api/system/stats');
    container.innerHTML = `
      <h3>仪表盘</h3>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value">${stats.todayCount}</div><div class="stat-label">今日入库</div></div>
        <div class="stat-card"><div class="stat-value">${stats.monthCount}</div><div class="stat-label">本月入库</div></div>
        <div class="stat-card"><div class="stat-value">${stats.totalCount}</div><div class="stat-label">累计入库</div></div>
        <div class="stat-card"><div class="stat-value" style="color:${stats.pendingUnmatched>0?'var(--warn)':'var(--primary)'}">${stats.pendingUnmatched}</div><div class="stat-label">待处理失败</div></div>
      </div>
      <div class="card-row">
        <div class="card">
          <div class="card-header">115 账号状态</div>
          ${stats.cookieStatus === 'active' ? `
            <div style="display:flex;gap:12px;align-items:center">
              ${stats.cookieFaceM ? `<img src="${stats.cookieFaceM}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : ''}
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  <strong>${stats.cookieUser}</strong>
                  ${stats.cookieVipName ? `<span style="background:linear-gradient(135deg,#f5b942,#e8941a);color:#fff;padding:1px 6px;border-radius:8px;font-size:11px">${stats.cookieVipName}</span>` : ''}
                </div>
                ${stats.cookieVipExpire ? `<div style="font-size:12px;color:var(--text-secondary,#888);margin-top:2px">VIP 到期: ${stats.cookieVipExpire}${stats.cookieVipForever ? '（永久）' : ''}</div>` : ''}
              </div>
            </div>
            ${stats.cookieSizeTotal ? `
              <div style="margin-top:10px">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                  <span>存储</span>
                  <span>${stats.cookieSizeUsed} / ${stats.cookieSizeTotal} (${stats.cookieSizePercent}%)</span>
                </div>
                <div style="background:var(--border,#eee);border-radius:4px;height:6px;overflow:hidden">
                  <div style="height:100%;width:${Math.min(stats.cookieSizePercent, 100)}%;background:linear-gradient(90deg,#42a5f5,${stats.cookieSizePercent > 90 ? '#ef5350' : '#1976d2'})"></div>
                </div>
              </div>
            ` : ''}
          ` : '<p class="text-error">未登录</p>'}
        </div>
        <div class="card">
          <div class="card-header">系统信息</div>
          <p>运行时间: ${formatUptime(stats.uptime)}</p>
          <p>节点版本: ${stats.nodeVersion || '-'}</p>
        </div>
      </div>
      ${stats.lastTask ? `
        <div class="card mt-16">
          <div class="card-header">最近任务</div>
          <p>状态: <span class="text-${stats.lastTask.status==='completed'?'success':stats.lastTask.status==='failed'?'error':'warn'}">${stats.lastTask.status}</span></p>
          <p>扫描: ${stats.lastTask.scan_count} | 成功: ${stats.lastTask.success_count} | 失败: ${stats.lastTask.fail_count}</p>
          <p>时间: ${stats.lastTask.started_at || stats.lastTask.created_at}</p>
        </div>
      ` : ''}
      <div class="mt-16">
        <button class="btn btn-primary" onclick="window.location.hash='#tasks';navigateTo('tasks')">查看任务历史</button>
        <button class="btn btn-success" style="margin-left:8px" id="btn-run-now-dash">立即整理</button>
      </div>
      <div class="card mt-16">
        <div class="card-header">测试解析</div>
        <div class="form-group">
          <label>粘贴文件名，查看本地解析结果</label>
          <input type="text" id="parse-test-input" placeholder="例：飞驰人生 Pegasus (2019) 1080P [tmdb575219]">
        </div>
        <div id="parse-test-output" style="font-size:13px;color:#9aa9b9;"></div>
      </div>

      <div class="card mt-16">
        <div class="card-header">分享转存</div>
        <div class="form-group">
          <label>115 分享链接</label>
          <input type="text" id="share-link-input" placeholder="https://115.com/s/xxxxxxxx?password=xxxx">
        </div>
        <div class="form-group">
          <label>转存到</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="share-target-name" readonly placeholder="根目录" style="flex:1">
            <input type="hidden" id="share-target-cid" value="0">
            <button type="button" class="btn btn-sm" id="btn-share-pick">选择目录</button>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" id="btn-share-preview">预览文件</button>
          <button class="btn btn-primary btn-sm" id="btn-share-transfer">开始转存</button>
        </div>
        <div id="share-output" style="font-size:13px;color:#9aa9b9;margin-top:12px;"></div>
      </div>

      <div id="share-picker-modal" class="modal-overlay" style="display:none">
        <div class="modal">
          <div class="modal-header"><h3>选择转存目录</h3><button class="btn btn-sm" id="btn-share-picker-close">✕</button></div>
          <div id="share-picker-content" style="max-height:400px;overflow-y:auto"></div>
        </div>
      </div>
    `;

    document.getElementById('btn-run-now-dash').addEventListener('click', async () => {
      try {
        await API.post('/api/tasks/run-now');
        showToast('整理任务已启动', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });

    bindShareTransfer();

    const parseInput = document.getElementById('parse-test-input');
    const parseOut = document.getElementById('parse-test-output');
    let parseTimer = null;
    parseInput.addEventListener('input', () => {
      clearTimeout(parseTimer);
      const filename = parseInput.value.trim();
      if (!filename) { parseOut.innerHTML = ''; return; }
      parseTimer = setTimeout(async () => {
        try {
          const { result } = await API.post('/api/system/parse-test', { filename });
          parseOut.innerHTML = renderParseResult(result);
        } catch (err) {
          parseOut.textContent = '解析失败: ' + err.message;
        }
      }, 200);
    });
  } catch (err) {
    container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
  }
});

function bindShareTransfer() {
  const linkInput = document.getElementById('share-link-input');
  const targetCid = document.getElementById('share-target-cid');
  const targetName = document.getElementById('share-target-name');
  const output = document.getElementById('share-output');
  const modal = document.getElementById('share-picker-modal');
  const pickerContent = document.getElementById('share-picker-content');

  function fmtSize(n) {
    if (!n) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function loadPicker(cid, currentName) {
    pickerContent.innerHTML = '<p>加载中...</p>';
    try {
      const folders = await API.get(`/api/115/folders?cid=${encodeURIComponent(cid)}`);
      let html = '';
      if (cid !== '0') {
        html += '<button class="btn btn-sm" style="margin-bottom:4px" data-back="0">📁 根目录</button> ';
        html += `<button class="btn btn-primary btn-sm" style="margin-bottom:8px" data-select="${cid}">✅ 选择此目录${currentName ? '：' + escHtml(currentName) : ''}</button>`;
      } else {
        html += `<button class="btn btn-primary btn-sm" style="margin-bottom:8px" data-select="0">✅ 选择根目录</button>`;
        html += '<p style="color:var(--text-tertiary);margin-bottom:8px;font-size:13px">点击文件夹进入子目录</p>';
      }
      if (folders.length === 0) {
        html += '<p style="color:var(--text-tertiary)">此目录下没有子文件夹</p>';
      } else {
        folders.forEach(f => {
          html += `<button class="btn btn-sm" style="margin:2px;display:block;width:100%;text-align:left" data-nav="${f.cid}" data-name="${escHtml(f.name)}">📁 ${escHtml(f.name)}</button>`;
        });
      }
      pickerContent.innerHTML = html;
      const selectBtn = pickerContent.querySelector('[data-select]');
      if (selectBtn) {
        selectBtn.addEventListener('click', () => {
          targetCid.value = cid;
          targetName.value = cid === '0' ? '根目录' : (currentName || cid);
          modal.style.display = 'none';
        });
      }
      const backBtn = pickerContent.querySelector('[data-back]');
      if (backBtn) backBtn.addEventListener('click', () => loadPicker('0'));
      pickerContent.querySelectorAll('button[data-nav]').forEach(btn => {
        btn.addEventListener('click', () => loadPicker(btn.dataset.nav, btn.dataset.name));
      });
    } catch (err) {
      pickerContent.innerHTML = `<p class="error-msg">加载失败: ${escHtml(err.message)}</p>`;
    }
  }

  document.getElementById('btn-share-pick').addEventListener('click', () => {
    modal.style.display = '';
    loadPicker('0');
  });
  document.getElementById('btn-share-picker-close').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  document.getElementById('btn-share-preview').addEventListener('click', async () => {
    const link = linkInput.value.trim();
    if (!link) { showToast('请输入分享链接', 'error'); return; }
    output.innerHTML = '解析中...';
    try {
      const data = await API.post('/api/115/share/parse', { link });
      const info = data.shareInfo || {};
      const title = info.share_title || info.title || '';
      const rows = data.files.map(f => `<div>${f.isFolder ? '📁' : '📄'} ${escHtml(f.name)} <span style="color:var(--text-tertiary)">${fmtSize(f.size)}</span></div>`).join('');
      output.innerHTML = `
        <div style="color:var(--text-secondary);margin-bottom:6px">分享信息: ${escHtml(title)} · 共 ${data.files.length} 项</div>
        <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">${rows || '<span style="color:var(--text-tertiary)">空</span>'}</div>
      `;
    } catch (err) {
      output.innerHTML = `<span class="error-msg">${escHtml(err.message)}</span>`;
    }
  });

  document.getElementById('btn-share-transfer').addEventListener('click', async () => {
    const link = linkInput.value.trim();
    if (!link) { showToast('请输入分享链接', 'error'); return; }
    const cid = targetCid.value || '0';
    output.innerHTML = '转存中...';
    try {
      const data = await API.post('/api/115/share/transfer', { link, targetCid: cid });
      const where = cid === '0' ? '根目录' : (targetName.value || cid);
      const note = data.alreadyTransferred ? '（已转存过，无需重复接收）' : '';
      output.innerHTML = `<span class="text-success">✅ 转存成功：${data.fileCount} 项 → ${escHtml(where)} ${note}</span>`;
      showToast('转存成功', 'success');
    } catch (err) {
      output.innerHTML = `<span class="error-msg">转存失败: ${escHtml(err.message)}</span>`;
      showToast(err.message, 'error');
    }
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}天 ${h}小时 ${m}分钟` : h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`;
}

function renderParseResult(r) {
  const labels = {
    title: '标题', year: '年份', tmdbId: 'TMDB ID', mediaType: '类型',
    season: '季', episode: '集', episodeEnd: '集结束', isMultiEpisode: '多集',
    resolution: '分辨率', source: '来源', videoCodec: '视频编码', bitDepth: '位深',
    hdr: 'HDR', audioCodec: '音频编码', audioCount: '音轨数', releaseGroup: '压制组',
  };
  const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const rows = Object.entries(labels)
    .filter(([k]) => r[k] !== '' && r[k] !== null && r[k] !== false && r[k] !== undefined)
    .map(([k, label]) => `<span style="color:#6bd4a0">${label}</span>: ${escHtml(r[k])}`);
  if (!rows.length) return '未提取到任何字段';
  return rows.join('&nbsp;&nbsp;|&nbsp;&nbsp;');
}
