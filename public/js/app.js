// Boot, auth gate, bottom tab navigation and view wiring.

import { app, state, esc, api, stopTimers, setView, go, views } from './core.js';
import { showList, showDetail, openNewSheet, refreshList, refreshDetail } from './sessions.js';
import { showDashboard } from './dashboard.js';
import { showProjects, showProject } from './projects.js';
import { showLocal, showLocalDetail, refreshLocal } from './local.js';

views.list = showList;
views.detail = showDetail;
views.dashboard = showDashboard;
views.projects = showProjects;
views.project = showProject;
views.local = showLocal;
views.localDetail = showLocalDetail;

// ---------- login ----------
views.login = function showLogin(msg) {
  setView('login');
  stopTimers();
  app.innerHTML = `
    <form class="login" id="loginForm">
      <h1>Devin Control</h1>
      <p>Sign in to manage your Devin sessions.</p>
      <input class="in" type="password" id="pw" placeholder="Password" autocomplete="current-password" required>
      <div class="err-text" id="loginErr">${esc(msg || '')}</div>
      <div class="row"><button class="btn" type="submit">Sign in</button></div>
    </form>`;
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', '/auth/login', { password: document.getElementById('pw').value });
      go('dashboard');
    } catch (err) {
      document.getElementById('loginErr').textContent = err.message;
      btn.disabled = false;
    }
  });
  setTimeout(() => document.getElementById('pw')?.focus(), 50);
};

// ---------- tab bar ----------
const TABS = [
  ['dashboard', '▦', 'Dash'],
  ['list', '☰', 'Cloud'],
  ['local', '⌘', 'Local'],
  ['projects', '◈', 'Projects'],
  ['new', '＋', 'New'],
];

function renderTabbar() {
  const el = document.getElementById('tabbar');
  el.innerHTML = TABS.map(
    ([v, icon, label]) =>
      `<button class="tab" data-v="${v}" aria-label="${label}"><span class="ti">${icon}</span><span>${label}</span></button>`
  ).join('');
  el.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.v === 'new') return openNewSheet();
      go(b.dataset.v);
    };
  });
  // highlight active tab on view changes
  const obs = new MutationObserver(() => {
    el.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.v === state.view));
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
}

// ---------- boot ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.view === 'list') refreshList();
  else if (state.view === 'detail') refreshDetail(false);
  else if (state.view === 'local') refreshLocal();
  else if (state.view === 'dashboard') go('dashboard');
});

(async function boot() {
  renderTabbar();
  try {
    await api('GET', '/auth/me');
    go('dashboard');
  } catch {
    if (state.view !== 'login') go('login');
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
