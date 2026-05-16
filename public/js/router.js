const pages = {};
let currentPage = null;

function registerPage(name, renderFn) {
  pages[name] = renderFn;
}

function navigateTo(pageName, params) {
  const main = document.getElementById('main-content');
  const loginPage = document.getElementById('page-login');
  const mainPage = document.getElementById('page-main');

  if (pageName === 'login') {
    loginPage.style.display = '';
    mainPage.style.display = 'none';
    return;
  }

  // Check auth
  if (!API.token) {
    window.location.hash = '#login';
    return;
  }

  loginPage.style.display = 'none';
  mainPage.style.display = '';

  // Update nav active
  document.querySelectorAll('.nav-menu a').forEach(a => a.classList.remove('active'));
  const link = document.querySelector(`[data-page="${pageName}"]`);
  if (link) {
    link.classList.add('active');
    // Highlight parent dropdown trigger if applicable
    const dropdown = link.closest('.nav-dropdown');
    if (dropdown) {
      const trigger = dropdown.parentElement.querySelector('.nav-group-trigger');
      if (trigger) trigger.classList.add('active');
    }
  }

  // Render page
  if (pages[pageName]) {
    main.innerHTML = '<div class="text-center mt-16">加载中...</div>';
    try {
      pages[pageName](main, params);
    } catch (err) {
      main.innerHTML = `<div class="error-msg">页面加载失败: ${err.message}</div>`;
    }
  } else {
    main.innerHTML = '<div class="empty-state">页面不存在</div>';
  }
  currentPage = pageName;
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1) || 'dashboard';
  navigateTo(hash);
});

// Handle login form
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    errorEl.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败');
      API.setToken(data.token);
      document.getElementById('nav-user').textContent = username;
      window.location.hash = '#dashboard';
      navigateTo('dashboard');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = '';
    }
  });

  // Logout button
  document.getElementById('btn-logout').addEventListener('click', () => {
    API.clearToken();
    window.location.hash = '#login';
    navigateTo('login');
  });

  // Utility tools dropdown toggle
  document.querySelector('.nav-group-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const group = e.currentTarget.closest('.nav-group');
    group?.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    document.querySelector('.nav-group.open')?.classList.remove('open');
  });

  // Initial navigation
  if (API.token) {
    window.location.hash = window.location.hash || '#dashboard';
    navigateTo(window.location.hash.slice(1) || 'dashboard');
  } else {
    window.location.hash = '#login';
    navigateTo('login');
  }
});
