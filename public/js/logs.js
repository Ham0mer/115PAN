registerPage('logs', async (container) => {
  let streamSource = null;

  function cleanup() {
    if (streamSource) {
      streamSource.close();
      streamSource = null;
    }
    window.removeEventListener('hashchange', onHashChange);
  }

  function onHashChange() {
    if (window.location.hash.slice(1) !== 'logs') cleanup();
  }

  container.innerHTML = `
    <div class="flex-between mb-16">
      <h3>系统日志</h3>
      <div class="flex gap-8">
        <button class="btn btn-sm btn-danger" id="btn-log-clear">清空</button>
      </div>
    </div>
    <div class="log-viewer" id="log-content">加载中...</div>
  `;

  const viewer = document.getElementById('log-content');

  function append(lines) {
    if (!lines || !lines.length) return;
    const html = lines.map(l => `<span>${esc(l)}</span>`).join('\n');
    if (viewer.innerHTML === '加载中...' || viewer.dataset.empty === '1') {
      viewer.innerHTML = html;
      viewer.dataset.empty = '';
    } else {
      viewer.innerHTML += '\n' + html;
    }
    viewer.scrollTop = viewer.scrollHeight;
  }

  try {
    const data = await API.get('/api/logs/file');
    if (data.content) {
      viewer.innerHTML = data.content.split('\n').filter(Boolean).map(l => `<span>${esc(l)}</span>`).join('\n');
      viewer.scrollTop = viewer.scrollHeight;
    } else {
      viewer.innerHTML = '<span style="color:#888">暂无日志</span>';
      viewer.dataset.empty = '1';
    }
  } catch (err) {
    viewer.innerHTML = `<span style="color:#f44">加载失败: ${err.message}</span>`;
    viewer.dataset.empty = '1';
  }

  streamSource = new EventSource(`/api/logs/stream?token=${encodeURIComponent(API.token)}`);
  streamSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.lines) append(data.lines);
    } catch {}
  };
  streamSource.onerror = () => {
    if (streamSource) {
      streamSource.close();
      streamSource = null;
    }
  };

  document.getElementById('btn-log-clear').addEventListener('click', async () => {
    if (!confirm('确定清空所有日志吗？')) return;
    try {
      await API.delete('/api/logs');
      viewer.innerHTML = '<span style="color:#888">暂无日志</span>';
      viewer.dataset.empty = '1';
    } catch (err) {
      showToast(`清空失败: ${err.message}`, 'error');
    }
  });

  window.addEventListener('hashchange', onHashChange);
});
