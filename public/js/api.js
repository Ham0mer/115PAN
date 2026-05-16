const API = {
  token: localStorage.getItem('token'),

  setToken(token) {
    this.token = token;
    localStorage.setItem('token', token);
  },

  clearToken() {
    this.token = null;
    localStorage.removeItem('token');
  },

  async request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    try {
      const res = await fetch(url, opts);
      if (res.status === 401) {
        this.clearToken();
        window.location.hash = '#login';
        throw new Error('登录已过期');
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (err.message === '登录已过期') throw err;
      throw err;
    }
  },

  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  delete(url) { return this.request('DELETE', url); },
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
