registerPage('config', async (container) => {
  async function render() {
    try {
      const cfg = await API.get('/api/config/organize');
      const bots = await API.get('/api/config/telegram');
      container.innerHTML = `
        <h3>整理配置</h3>
        <form id="config-form">
          <div class="card">
            <div class="card-header">目录设置</div>
            <div class="form-row">
              <div class="form-group" style="flex:2">
                <label>未整理文件夹</label>
                <div class="form-inline">
                  <input type="text" id="cfg-source-name" value="${esc(cfg.source_name||'')}" readonly placeholder="点击选择" style="flex:1">
                  <input type="hidden" id="cfg-source-cid" value="${cfg.source_cid||''}">
                  <button type="button" class="btn btn-sm" id="btn-pick-source">浏览</button>
                </div>
              </div>
              <div class="form-group" style="flex:2">
                <label>整理后文件夹</label>
                <div class="form-inline">
                  <input type="text" id="cfg-target-name" value="${esc(cfg.target_name||'')}" readonly placeholder="点击选择" style="flex:1">
                  <input type="hidden" id="cfg-target-cid" value="${cfg.target_cid||''}">
                  <button type="button" class="btn btn-sm" id="btn-pick-target">浏览</button>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">扫描与过滤</div>
            <div class="form-row">
              <div class="form-group"><label>扫描频率（分钟）</label><input type="number" id="cfg-scan-interval" value="${cfg.scan_interval_min||10}" min="5"></div>
              <div class="form-group"><label>操作延时（秒）</label><input type="number" id="cfg-op-delay" value="${cfg.operation_delay_sec||10}" step="0.5" min="0"></div>
              <div class="form-group"><label>小文件过滤（MB）</label><input type="number" id="cfg-min-size" value="${cfg.min_video_size_mb||100}" step="1" min="0"></div>
            </div>
            <div class="form-row">
              <div class="form-group" style="flex:2">
                <label>视频文件类型</label>
                ${renderTagInput('video-exts', cfg.video_extensions || 'mp4,mkv,avi,mov,rmvb,wmv,ts,iso,m2ts')}
              </div>
              <div class="form-group" style="flex:2">
                <label>元数据文件类型</label>
                ${renderTagInput('meta-exts', cfg.meta_extensions || 'ass,srt,ssa,sub,vtt,nfo,xml')}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">命名与分类</div>
            <div class="toggle-row"><span>启用重命名</span><label class="toggle"><input type="checkbox" id="cfg-rename" ${cfg.rename_enabled?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>ffprobe 媒体信息提取</span><label class="toggle"><input type="checkbox" id="cfg-ffprobe" ${cfg.ffprobe_enabled?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>AI 辅助识别</span><label class="toggle"><input type="checkbox" id="cfg-ai" ${cfg.ai_enabled?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>二次分类（地区）</span><label class="toggle"><input type="checkbox" id="cfg-sec-cat" ${cfg.secondary_category?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>三次分类（年份）</span><label class="toggle"><input type="checkbox" id="cfg-ter-cat" ${cfg.tertiary_category?'checked':''}><span class="slider"></span></label></div>
          </div>

          <div class="card">
            <div class="card-header">版本管理</div>
            <div class="form-row">
              <div class="form-group">
                <label>冲突处理方式</label>
                <select id="cfg-conflict">
                  <option value="2" ${cfg.conflict_mode===2?'selected':''}>不覆盖（同名跳过）</option>
                  <option value="1" ${cfg.conflict_mode===1?'selected':''}>覆盖 - 大文件优先</option>
                  <option value="0" ${cfg.conflict_mode===0?'selected':''}>覆盖 - 小文件优先</option>
                </select>
              </div>
            </div>
            <div class="toggle-row"><span>多版本保留</span><label class="toggle"><input type="checkbox" id="cfg-multi-ver" ${cfg.multi_version?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>Remux / 蓝光优先</span><label class="toggle"><input type="checkbox" id="cfg-remux" ${cfg.remux_priority?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>大分辨率优先</span><label class="toggle"><input type="checkbox" id="cfg-resolution" ${cfg.resolution_priority?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>杜比优先</span><label class="toggle"><input type="checkbox" id="cfg-dolby" ${cfg.dolby_priority?'checked':''}><span class="slider"></span></label></div>
          </div>

          <div class="card">
            <div class="card-header">通知设置</div>
            <div class="toggle-row"><span>启用入库通知</span><label class="toggle"><input type="checkbox" id="cfg-notify" ${cfg.notify_enabled?'checked':''}><span class="slider"></span></label></div>
            <div class="toggle-row"><span>剧集每集独立通知</span><label class="toggle"><input type="checkbox" id="cfg-ep-notify" ${cfg.episode_per_notify?'checked':''}><span class="slider"></span></label></div>
            <div class="form-group">
              <label>通知机器人</label>
              <select id="cfg-bot-id">
                <option value="">-- 选择 --</option>
                ${(Array.isArray(bots)?bots:[]).map(b => `<option value="${b.id}" ${cfg.notify_bot_id===b.id?'selected':''}>${esc(b.name||'Bot '+b.id)}</option>`).join('')}
              </select>
            </div>
          </div>

          <button type="submit" class="btn btn-primary">保存配置</button>
        </form>
        <div id="dir-picker-modal" class="modal-overlay" style="display:none">
          <div class="modal">
            <div class="modal-header"><h3>选择文件夹</h3><button class="btn btn-sm" id="btn-close-picker">✕</button></div>
            <div id="dir-picker-content" style="max-height:400px;overflow-y:auto"></div>
          </div>
        </div>
      `;

      bindConfigEvents(cfg);
      bindTagInputs();
    } catch (err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }

  function renderTagInput(field, value) {
    const tags = String(value || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const chips = tags.map(t => tagChip(t)).join('');
    return `
      <div class="tag-input" data-field="${field}" style="display:flex;flex-wrap:wrap;gap:6px;padding:6px;border:1px solid var(--border, #ccc);border-radius:6px;background:var(--input-bg, #fff);min-height:38px;align-items:center">
        <div class="tag-list" style="display:contents">${chips}</div>
        <input type="text" class="tag-input-field" placeholder="输入扩展名，回车添加"
          style="border:none;outline:none;background:transparent;flex:1;min-width:120px;padding:4px">
      </div>
    `;
  }

  function tagChip(text) {
    return `<span class="tag-chip" data-value="${esc(text)}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--primary-bg, #e3f2fd);color:var(--primary, #1976d2);border-radius:12px;font-size:13px">
      ${esc(text)}
      <button type="button" class="tag-remove" style="border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0">×</button>
    </span>`;
  }

  function collectTags(field) {
    const box = document.querySelector(`.tag-input[data-field="${field}"]`);
    if (!box) return '';
    return Array.from(box.querySelectorAll('.tag-chip'))
      .map(c => c.dataset.value)
      .join(',');
  }

  function bindTagInputs() {
    document.querySelectorAll('.tag-input').forEach(box => {
      const input = box.querySelector('.tag-input-field');
      const list = box.querySelector('.tag-list');

      const addTag = (raw) => {
        const v = String(raw || '').trim().toLowerCase().replace(/^\./, '');
        if (!v) return;
        const existing = Array.from(box.querySelectorAll('.tag-chip')).map(c => c.dataset.value);
        if (existing.includes(v)) { input.value = ''; return; }
        list.insertAdjacentHTML('beforeend', tagChip(v));
        input.value = '';
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addTag(input.value);
        } else if (e.key === 'Backspace' && !input.value) {
          const chips = box.querySelectorAll('.tag-chip');
          if (chips.length) chips[chips.length - 1].remove();
        }
      });

      input.addEventListener('blur', () => {
        if (input.value.trim()) addTag(input.value);
      });

      box.addEventListener('click', (e) => {
        if (e.target.classList.contains('tag-remove')) {
          e.target.closest('.tag-chip').remove();
        } else if (e.target === box) {
          input.focus();
        }
      });
    });
  }

  function bindConfigEvents() {
    let pickTarget = null;

    document.getElementById('config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        source_cid: document.getElementById('cfg-source-cid').value,
        source_name: document.getElementById('cfg-source-name').value,
        target_cid: document.getElementById('cfg-target-cid').value,
        target_name: document.getElementById('cfg-target-name').value,
        scan_interval_min: parseInt(document.getElementById('cfg-scan-interval').value),
        video_extensions: collectTags('video-exts'),
        meta_extensions: collectTags('meta-exts'),
        rename_enabled: document.getElementById('cfg-rename').checked ? 1 : 0,
        ffprobe_enabled: document.getElementById('cfg-ffprobe').checked ? 1 : 0,
        ai_enabled: document.getElementById('cfg-ai').checked ? 1 : 0,
        min_video_size_mb: parseFloat(document.getElementById('cfg-min-size').value),
        operation_delay_sec: parseFloat(document.getElementById('cfg-op-delay').value),
        secondary_category: document.getElementById('cfg-sec-cat').checked ? 1 : 0,
        tertiary_category: document.getElementById('cfg-ter-cat').checked ? 1 : 0,
        episode_per_notify: document.getElementById('cfg-ep-notify').checked ? 1 : 0,
        remux_priority: document.getElementById('cfg-remux').checked ? 1 : 0,
        resolution_priority: document.getElementById('cfg-resolution').checked ? 1 : 0,
        dolby_priority: document.getElementById('cfg-dolby').checked ? 1 : 0,
        multi_version: document.getElementById('cfg-multi-ver').checked ? 1 : 0,
        conflict_mode: parseInt(document.getElementById('cfg-conflict').value),
        notify_enabled: document.getElementById('cfg-notify').checked ? 1 : 0,
        notify_bot_id: document.getElementById('cfg-bot-id').value ? parseInt(document.getElementById('cfg-bot-id').value) : null,
      };
      try {
        await API.put('/api/config/organize', data);
        showToast('配置已保存', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });

    async function openPicker(target) {
      pickTarget = target;
      document.getElementById('dir-picker-modal').style.display = '';
      await loadDirPicker('0');
    }

    async function loadDirPicker(cid, currentName) {
      const content = document.getElementById('dir-picker-content');
      content.innerHTML = '<p>加载中...</p>';
      try {
        const folders = await API.get(`/api/115/folders?cid=${cid}`);
        let html = '';

        // Breadcrumb / current location + select button
        if (cid !== '0') {
          html += '<button class="btn btn-sm" style="margin-bottom:4px" data-back="0">📁 根目录</button> ';
          html += `<button class="btn btn-primary btn-sm" style="margin-bottom:8px" data-select="${cid}">✅ 选择此目录${currentName ? '：' + esc(currentName) : ''}</button>`;
        } else {
          html += '<p style="color:var(--text-tertiary);margin-bottom:8px;font-size:13px">点击文件夹进入子目录</p>';
        }

        if (folders.length === 0) {
          html += '<p style="color:var(--text-tertiary)">此目录下没有子文件夹</p>';
        } else {
          folders.forEach(f => {
            html += `<button class="btn btn-sm" style="margin:2px;display:block;width:100%;text-align:left" data-nav="${f.cid}" data-name="${esc(f.name)}">📁 ${esc(f.name)}</button>`;
          });
        }

        content.innerHTML = html;

        // "选择当前目录" button
        const selectBtn = content.querySelector('[data-select]');
        if (selectBtn) {
          selectBtn.addEventListener('click', () => {
            const name = currentName || selectBtn.textContent.replace('✅ 选择此目录','').replace(/^：/,'').trim();
            if (pickTarget === 'source') {
              document.getElementById('cfg-source-cid').value = cid;
              document.getElementById('cfg-source-name').value = name || cid;
            } else {
              document.getElementById('cfg-target-cid').value = cid;
              document.getElementById('cfg-target-name').value = name || cid;
            }
            document.getElementById('dir-picker-modal').style.display = 'none';
          });
        }

        // Back to root button
        const backBtn = content.querySelector('[data-back]');
        if (backBtn) {
          backBtn.addEventListener('click', () => loadDirPicker('0'));
        }

        // Navigate into subfolder
        content.querySelectorAll('button[data-nav]').forEach(btn => {
          btn.addEventListener('click', () => loadDirPicker(btn.dataset.nav, btn.dataset.name));
        });
      } catch (err) {
        content.innerHTML = `<p class="error-msg">加载失败: ${err.message}</p>`;
      }
    }

    document.getElementById('btn-pick-source').addEventListener('click', () => openPicker('source'));
    document.getElementById('btn-pick-target').addEventListener('click', () => openPicker('target'));
    document.getElementById('btn-close-picker').addEventListener('click', () => {
      document.getElementById('dir-picker-modal').style.display = 'none';
    });
  }

  render();
});

