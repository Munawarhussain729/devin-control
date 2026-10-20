// Projects view: group every session under a project — either a user rule
// (match on repo / tag / title) or auto-derived from PR repo names.

import {
  app, state, esc, toast, api, ago, stopTimers, setView, go,
  openSheet, groupByProject, caOf, fmtInt, fmtNum, fmtUsd, autoColor,
} from './core.js';
import { barChart } from './charts.js';
import { renderSessionCard } from './sessions.js';
import { loadAnalytics } from './dashboard.js';

async function ensureData() {
  const jobs = [];
  if (!state.analytics) jobs.push(loadAnalytics(false).catch(() => {}));
  if (!state.projectsLoaded) {
    jobs.push(
      api('GET', '/api/projects')
        .then((d) => {
          state.projects = d.projects || [];
          state.projectsLoaded = true;
        })
        .catch(() => {})
    );
  }
  await Promise.all(jobs);
}

export function showProjects() {
  setView('projects');
  stopTimers();
  app.innerHTML = `
    <div class="topbar">
      <h1>Projects</h1>
      <button class="icon-btn" id="manage" aria-label="Manage projects">⚙</button>
    </div>
    <div class="scroll" id="plist"><div class="empty">Loading…</div></div>`;
  document.getElementById('manage').onclick = openManage;
  ensureData().then(() => {
    if (state.view === 'projects') renderProjects();
  });
}

function projectGroups() {
  const items = (state.analytics && state.analytics.items) || [];
  return groupByProject(items, state.projects);
}

function renderProjects() {
  const box = document.getElementById('plist');
  if (!box) return;
  const groups = projectGroups();
  if (!groups.length) {
    box.innerHTML = `<div class="empty">No sessions synced yet. Pull to sync on the Dashboard.</div>`;
    return;
  }
  const managed = groups.filter((g) => !g.auto);
  const auto = groups.filter((g) => g.auto && g.key !== '~none');
  const none = groups.find((g) => g.key === '~none');
  const card = (g) => `
    <button class="card proj-card" data-key="${esc(g.key)}" style="--pc:${esc(g.color)}">
      <div class="t"><i class="dot"></i>${esc(g.name)}${g.auto ? '' : ' <span class="badge mute">rule</span>'}</div>
      <div class="meta">
        <span>${fmtInt(g.stats.sessions)} sessions</span>
        ${g.stats.working ? `<span class="badge run">${fmtInt(g.stats.working)} active</span>` : ''}
        ${g.stats.needsYou ? `<span class="badge warn">${fmtInt(g.stats.needsYou)} needs you</span>` : ''}
        <span>${fmtNum(g.stats.acu)} ACU</span>
        ${g.stats.prs ? `<span>⎇ ${fmtInt(g.stats.prs)} PRs</span>` : ''}
        <span>${ago(g.stats.last)}</span>
      </div>
    </button>`;
  box.innerHTML =
    (managed.length ? `<h3 class="sect">Your projects</h3>` + managed.map(card).join('') : '') +
    (auto.length ? `<h3 class="sect">From repositories</h3>` + auto.map(card).join('') : '') +
    (none ? `<h3 class="sect">Unmatched</h3>` + card(none) : '') +
    `<div class="empty muted">Add rules under ⚙ to group sessions by repo, tag or title.</div>`;
  box.querySelectorAll('.proj-card').forEach((c) => (c.onclick = () => go('project', c.dataset.key)));
}

export function showProject(key) {
  setView('project');
  stopTimers();
  state.projectKey = key;
  app.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="back" aria-label="Back">←</button>
      <h1 id="ptitle">Project</h1>
      <button class="icon-btn" id="manage" aria-label="Manage projects">⚙</button>
    </div>
    <div class="scroll" id="pbody"><div class="empty">Loading…</div></div>`;
  document.getElementById('back').onclick = () => go('projects');
  document.getElementById('manage').onclick = openManage;
  ensureData().then(() => {
    if (state.view === 'project') renderProject();
  });
}

function renderProject() {
  const box = document.getElementById('pbody');
  if (!box) return;
  const g = projectGroups().find((x) => x.key === state.projectKey);
  if (!g) {
    box.innerHTML = `<div class="empty">Project not found.</div>`;
    return;
  }
  document.getElementById('ptitle').innerHTML = `<i class="dot" style="--pc:${esc(g.color)}"></i> ${esc(g.name)}`;
  const s = g.stats;
  const items = [...g.items].sort((a, b) => (b.ua || 0) - (a.ua || 0));
  // activity over last 30 days
  const days = 30;
  const now = new Date();
  const starts = [], labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    starts.push(d.getTime() / 1000);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  const vals = starts.map(() => 0);
  for (const ses of items) {
    const ts = caOf(ses);
    for (let i = starts.length - 1; i >= 0; i--) {
      if (ts >= starts[i]) {
        vals[i]++;
        break;
      }
    }
  }
  box.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><b>${fmtInt(s.sessions)}</b><span>Sessions</span></div>
      <div class="kpi"><b>${fmtNum(s.acu, s.acu >= 100 ? 0 : 1)}</b><span>ACUs</span></div>
      <div class="kpi"><b>${fmtInt(s.prs)}</b><span>PRs · ${fmtInt(s.prsMerged)} merged</span></div>
      <div class="kpi"><b>${s.od ? fmtUsd(s.od) : '—'}</b><span>On-demand</span></div>
    </div>
    <div class="panel"><h3>Activity · last 30 days</h3>${barChart({ labels, values: vals, color: g.color })}</div>
    <h3 class="sect">Sessions</h3>
    ${items.map(renderSessionCard).join('') || '<div class="empty">No sessions.</div>'}`;
  box.querySelectorAll('.card[data-id]').forEach((c) => (c.onclick = () => go(c.dataset.src === 'local' ? 'localDetail' : 'detail', c.dataset.id)));
}

// ---------- manage rules ----------
function openManage() {
  const rules = (state.projects || []).map((p) => ({ name: p.name, match: [...p.match], color: p.color || autoColor(p.name) }));
  const bg = openSheet(`
    <h2>Project rules</h2>
    <p class="muted" style="margin-top:0">A session joins a project when any match string appears in its repo, tags or title (case-insensitive). First matching rule wins.</p>
    <div id="rules"></div>
    <button class="btn ghost" id="add">+ Add project</button>
    <div class="row">
      <button class="btn ghost" id="close">Cancel</button>
      <button class="btn" id="save">Save</button>
    </div>`);
  const holder = bg.querySelector('#rules');
  const hexColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#4f8cff');
  const row = (r) => {
    const d = document.createElement('div');
    d.className = 'rule-row';
    d.innerHTML = `
      <input type="color" class="rc" value="${esc(hexColor(r.color))}" title="Color">
      <input class="in rn" placeholder="Name" value="${esc(r.name)}">
      <input class="in rm" placeholder="match: owner/repo, tag, title word" value="${esc(r.match.join(', '))}">
      <button class="icon-btn rx" aria-label="Delete">✕</button>`;
    d.querySelector('.rx').onclick = () => d.remove();
    return d;
  };
  rules.forEach((r) => holder.appendChild(row(r)));
  bg.querySelector('#add').onclick = () => holder.appendChild(row({ name: '', match: [], color: '#4f8cff' }));
  bg.querySelector('#close').onclick = () => bg.remove();
  bg.querySelector('#save').onclick = async (e) => {
    const projects = [...holder.querySelectorAll('.rule-row')]
      .map((d) => ({
        name: d.querySelector('.rn').value.trim(),
        match: d.querySelector('.rm').value.split(',').map((x) => x.trim()).filter(Boolean),
        color: d.querySelector('.rc').value,
      }))
      .filter((p) => p.name && p.match.length);
    e.target.disabled = true;
    try {
      const d = await api('POST', '/api/projects', { projects });
      state.projects = d.projects;
      state.projectsLoaded = true;
      bg.remove();
      toast('Projects saved');
      if (state.view === 'projects') renderProjects();
      else if (state.view === 'project') renderProject();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  };
}
