registerPage('telegram', async (container) => {
  async function render() {
    try {
      const bots = await API.get('/api/config/telegram');
      container.innerHTML = `
        <div class="flex-between mb-16">
          <h3>Telegram 通知配置</h3>
          <button class="btn btn-primary" id="btn-add-bot">添加机器人</button>
        </div>
        <div class="card mb-16" style="background:rgba(80,140,255,0.06);border-left:3px solid var(--primary)">
          <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
            💡 已启用的机器人会自动接收消息：向机器人发送 115 分享链接（<code>https://115.com/s/&lt;code&gt;?password=&lt;code&gt;</code>），机器人会让你选择转存目录，底部带有「待整理目录」快捷按钮。<br>
            ⚠️ 仅 <b>Chat ID</b> 列表中的用户能使用转存功能。
          </div>
        </div>
        <div id="bot-list">
          ${(Array.isArray(bots)?bots:[]).length === 0 ? '<div class="empty-state">未配置任何机器人，请添加</div>' :
            (Array.isArray(bots)?bots:[]).map(b => `
              <div class="card mb-16">
                <div class="card-header">${esc(b.name||'Bot #'+b.id)} ${b.enabled?'<span class="badge badge-success" style="background:var(--success);color:#fff">已启用</span>':'<span class="badge" style="background:#ccc">已禁用</span>'}</div>
                <div class="form-row">
                  <div class="form-group" style="flex:2"><label>Bot Token</label><input type="password" value="${esc(maskStr(b.bot_token))}" data-id="${b.id}" data-field="bot_token"></div>
                  <div class="form-group" style="flex:2"><label>Chat ID (逗号分隔)</label><input type="text" value="${esc(b.chat_ids||'')}" data-id="${b.id}" data-field="chat_ids"></div>
                </div>
                <div class="toggle-row"><span>启用</span><label class="toggle"><input type="checkbox" data-id="${b.id}" data-field="enabled" ${b.enabled?'checked':''}><span class="slider"></span></label></div>
                <div class="toggle-row"><span>入库成功通知</span><label class="toggle"><input type="checkbox" data-id="${b.id}" data-field="notify_success" ${b.notify_success?'checked':''}><span class="slider"></span></label></div>
                <div class="toggle-row"><span>整理失败通知</span><label class="toggle"><input type="checkbox" data-id="${b.id}" data-field="notify_failure" ${b.notify_failure?'checked':''}><span class="slider"></span></label></div>
                <div class="toggle-row"><span>Cookie失效通知</span><label class="toggle"><input type="checkbox" data-id="${b.id}" data-field="notify_cookie" ${b.notify_cookie?'checked':''}><span class="slider"></span></label></div>
                <div class="toggle-row"><span>系统启动/关闭通知</span><label class="toggle"><input type="checkbox" data-id="${b.id}" data-field="notify_system" ${b.notify_system?'checked':''}><span class="slider"></span></label></div>
                <div class="flex gap-8 mt-8">
                  <button class="btn btn-success btn-sm test-bot" data-id="${b.id}">发送测试消息</button>
                  <button class="btn btn-sm save-bot" data-id="${b.id}">保存更改</button>
                  <button class="btn btn-danger btn-sm delete-bot" data-id="${b.id}">删除</button>
                </div>
              </div>
            `).join('')
          }
        </div>
      `;

      bindTelegramEvents(bots);
    } catch(err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }

  function bindTelegramEvents() {
    document.getElementById('btn-add-bot')?.addEventListener('click', async () => {
      await API.post('/api/config/telegram', {
        name: 'New Bot',
        bot_token: '',
        chat_ids: '',
        enabled: false,
        notify_success: true,
        notify_failure: true,
        notify_cookie: true,
        notify_system: true,
      });
      showToast('已添加','success');
      render();
    });

    container.querySelectorAll('.save-bot').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const card = btn.closest('.card');
        const data = {};
        card.querySelectorAll('[data-field]').forEach(el => {
          data[el.dataset.field] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
        });
        data.name = card.querySelector('.card-header').textContent.split(' ')[0];
        delete data.enabled; // handled separately
        await API.put(`/api/config/telegram/${id}`, data);
        showToast('已保存','success');
      });
    });

    container.querySelectorAll('.test-bot').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await API.post('/api/telegram/test', { botId: parseInt(btn.dataset.id) });
          showToast('测试消息已发送','success');
        } catch(err) { showToast(err.message,'error'); }
      });
    });

    container.querySelectorAll('.delete-bot').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('确定删除此机器人配置吗？')) return;
        await API.delete(`/api/config/telegram/${btn.dataset.id}`);
        showToast('已删除','success');
        render();
      });
    });

    // Live update checkbox fields
    container.querySelectorAll('input[type="checkbox"][data-field]').forEach(cb => {
      cb.addEventListener('change', async function() {
        const id = this.dataset.id;
        const field = this.dataset.field;
        await API.put(`/api/config/telegram/${id}`, { [field]: this.checked ? 1 : 0 });
      });
    });
  }

  function maskStr(s) { return s && s.length > 8 ? s.slice(0,4)+'****'+s.slice(-4) : (s||''); }
  render();
});
