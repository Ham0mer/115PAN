registerPage('system', async (container) => {
  async function render() {
    try {
      const [stats, version] = await Promise.all([
        API.get('/api/system/stats'),
        API.get('/api/system/version'),
      ]);
      container.innerHTML = `
        <h3>系统设置</h3>
        <div class="card">
          <div class="card-header">系统信息</div>
          <p>版本: ${version.version}</p>
          <p>Node.js: ${version.node}</p>
          <p>运行时间: ${formatUptime(stats.uptime)}</p>
        </div>
        <div class="card mt-16">
          <div class="card-header">修改管理员密码</div>
          <div class="form-group"><label>旧密码</label><input type="password" id="sys-old-pw"></div>
          <div class="form-group"><label>新密码</label><input type="password" id="sys-new-pw"></div>
          <button class="btn btn-primary" id="btn-change-pw">修改密码</button>
          <p class="form-hint mt-8">提示：密码存储在 config/config.json 中，也可以直接修改该文件。</p>
        </div>
        <div class="card mt-16">
          <div class="card-header">数据管理</div>
          <div class="flex gap-8">
            <button class="btn" id="btn-backup">导出数据库备份</button>
            <button class="btn btn-warn" id="btn-clean-logs">清理旧日志</button>
          </div>
          <div id="backup-result" class="mt-8"></div>
        </div>
      `;

      document.getElementById('btn-change-pw').addEventListener('click', async () => {
        const oldPw = document.getElementById('sys-old-pw').value;
        const newPw = document.getElementById('sys-new-pw').value;
        if (!oldPw || !newPw) { showToast('请填写新旧密码','error'); return; }
        try {
          await API.post('/api/system/change-password', { oldPassword: oldPw, newPassword: newPw });
          showToast('密码修改请求已提交','success');
        } catch(err) { showToast(err.message,'error'); }
      });

      document.getElementById('btn-backup').addEventListener('click', async () => {
        const r = document.getElementById('backup-result');
        r.innerHTML = '<p>备份中...</p>';
        try {
          const result = await API.post('/api/system/backup');
          r.innerHTML = `<p class="text-success">备份成功: ${result.path}</p>`;
        } catch(err) { r.innerHTML = `<p class="text-error">备份失败: ${err.message}</p>`; }
      });

      document.getElementById('btn-clean-logs').addEventListener('click', async () => {
        if (!confirm('确定清理旧日志文件吗？（保留30天）')) return;
        await API.delete('/api/logs');
        showToast('日志已清理','success');
      });
    } catch(err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }
  render();
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}天 ${h}小时 ${m}分钟` : h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`;
}
