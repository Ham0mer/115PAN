registerPage('account', async (container) => {
  async function render() {
    try {
      const acct = await API.get('/api/115/account');
      container.innerHTML = `
        <h3>115 账号管理</h3>
        ${acct.loggedIn ? `
          <div class="card">
            <div class="card-header">当前账号</div>
            <p>用户ID: ${acct.userId}</p>
            <p>用户名: ${acct.userName}</p>
            <p>登录时间: ${acct.createdAt}</p>
            <p>状态: <span class="text-success">正常</span></p>
          </div>
          <div class="flex gap-8 mt-16">
            <button class="btn btn-primary" id="btn-scan-new">重新扫码登录</button>
            <button class="btn btn-warn" id="btn-verify">验证Cookie</button>
            <button class="btn btn-danger" id="btn-logout-115">退出登录</button>
          </div>
        ` : `
          <div class="card text-center" style="padding:40px">
            <p style="font-size:16px;margin-bottom:16px">尚未登录 115 账号</p>
            <button class="btn btn-primary" id="btn-scan-new">扫码登录</button>
          </div>
        `}
        <div id="qr-section" style="display:none" class="card mt-16">
          <div class="card-header">扫码登录</div>
          <div class="qr-container">
            <img id="qr-image" src="" alt="QR Code">
            <div class="qr-status" id="qr-status">请使用115手机客户端扫描二维码</div>
          </div>
        </div>
      `;

      bindAccountEvents();
    } catch (err) {
      container.innerHTML = `<div class="error-msg">加载失败: ${err.message}</div>`;
    }
  }

  function bindAccountEvents() {
    const btnScan = document.getElementById('btn-scan-new');
    const btnVerify = document.getElementById('btn-verify');
    const btnLogout = document.getElementById('btn-logout-115');

    if (btnScan) {
      btnScan.addEventListener('click', startQrLogin);
    }
    if (btnVerify) {
      btnVerify.addEventListener('click', async () => {
        try {
          const res = await API.post('/api/115/verify');
          showToast(res.valid ? 'Cookie有效' : 'Cookie已失效', res.valid ? 'success' : 'error');
        } catch (err) { showToast(err.message, 'error'); }
      });
    }
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        if (!confirm('确定要退出115登录吗？')) return;
        await API.post('/api/115/logout');
        showToast('已退出登录', 'success');
        render();
      });
    }
  }

  async function startQrLogin() {
    const qrSection = document.getElementById('qr-section');
    const qrImg = document.getElementById('qr-image');
    const qrStatus = document.getElementById('qr-status');

    try {
      const token = await API.get('/api/115/qr/token');
      qrSection.style.display = '';
      qrImg.src = token.qrDataUrl;
      qrStatus.textContent = '请使用115手机客户端扫描二维码';
      qrStatus.className = 'qr-status';

      // Poll for status
      let pollCount = 0;
      const maxPolls = 120; // 2 minutes
      const poll = setInterval(async () => {
        pollCount++;
        if (pollCount > maxPolls) {
          clearInterval(poll);
          qrStatus.textContent = '二维码已过期，请刷新';
          qrStatus.className = 'qr-status error';
          return;
        }
        try {
          const status = await API.get(`/api/115/qr/status?uid=${token.uid}&time=${token.time}&sign=${token.sign}`);
          if (status.status === 1) {
            // Scanned, waiting for confirm
            qrStatus.textContent = '已扫描，请在手机上确认登录';
            qrStatus.className = 'qr-status success';
          } else if (status.status === 2) {
            // Confirmed - get cookie
            clearInterval(poll);
            qrStatus.textContent = '登录成功！正在获取账号信息...';
            const result = await API.post('/api/115/qr/confirm', { uid: token.uid });
            showToast(`登录成功: ${result.user.user_name}`, 'success');
            qrSection.style.display = 'none';
            render();
          }
        } catch {
          // Silently retry
        }
      }, 1500);
    } catch (err) {
      showToast('获取二维码失败: ' + err.message, 'error');
    }
  }

  render();
});
