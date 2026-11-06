// Analytics dashboard: KPIs, time-series charts and breakdowns across all sessions.

import {
  app, state, esc, toast, api, ago, needsMe, stopTimers, setView, go,
  statusBucket, BUCKETS, caOf, uaOf, acuOf, prList, fmtInt, fmtNum, fmtUsd,
  groupByProject,
} from './core.js';
import { barChart, areaChart, donut, hbars, theme, PALETTE } from './charts.js';
import { renderSessionCard } from './sessions.js';

export async function loadAnalytics(force) {
  if (state.analyticsBusy) return;
  state.analyticsBusy = true;
  try {
    state.analytics = await api('GET', `/api/analytics${force ? '?refresh=1' : ''}`);
  } catch (e) {
    if (e.message !== 'Signed out') toast(e.message, true);
    throw e;
  } finally {
    state.analyticsBusy = false;
  }
}

// Local IDE session summary for the dashboard strip (server caches 30s).
async function loadLocalStats() {
  if (state.features?.local === false) {
    state.local = { count: 0 };
    return;
  }
  try {
    const d = await api('GET', '/api/local/sessions');
    if (!d.available) {
      state.local = { count: 0 };
      return;
    }
    const proj = new Map();
    let withMsgs = 0, last = 0;
    for (const s of d.items) {
      const dir = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : 'unknown';
      proj.set(dir, (proj.get(dir) || 0) + 1);
      if (s.msgs > 0) withMsgs++;
      if (s.ua > last) last = s.ua;
    }
    state.local = {
      count: d.items.length,
      withMsgs,
      last,
      projects: [...proj.entries()].sort((a, b) => b[1] - a[1]),
    };
  } catch {
    if (!state.local) state.local = { count: 0 };
  }
}

export function showDashboard() {
  setView('dashboard');
  stopTimers();
  app.innerHTML = `
    <div class="topbar">
      <h1>Dashboard</h1>
      <button class="icon-btn" id="sync" aria-label="Sync">⟳</button>
    </div>
    <div class="scroll" id="dash"><div class="empty">Syncing sessions…</div></div>`;
  document.getElementById('sync').onclick = async () => {
    const el = document.getElementById('dash');
    if (el) el.innerHTML = `<div class="empty">Syncing sessions…</div>`;
    try {
      await loadAnalytics(true);
    } catch {}
    render();
  };
  const ready = state.analytics
    ? Promise.resolve()
    : loadAnalytics(false).catch(() => {});
  Promise.all([ready, loadProjects(), loadLocalStats()]).then(() => {
    if (state.view === 'dashboard') render();
  });
  state.dashTimer = setInterval(async () => {
    if (state.view !== 'dashboard' || document.hidden) return;
    try {
      await Promise.all([loadAnalytics(false), loadLocalStats()]);
      render();
    } catch {}
  }, 60000);
}

let _projectsLoading = null;
function loadProjects() {
  if (state.projectsLoaded) return Promise.resolve();
  _projectsLoading =
    _projectsLoading ||
    api('GET', '/api/projects')
      .then((d) => {
        state.projects = d.projects || [];
        state.projectsLoaded = true;
      })
      .catch(() => {
        state.projects = [];
      })
      .finally(() => {
        _projectsLoading = null;
      });
  return _projectsLoading;
}

// ---------- time buckets ----------
function rangeDays(items) {
  if (state.range !== 'all') return parseInt(state.range, 10);
  const now = Date.now();
  const min = items.length ? Math.min(...items.map((s) => caOf(s) * 1000)) : now;
  return Math.max(7, Math.ceil((now - min) / 86400000));
}

function inRange(items) {
  if (state.range === 'all') return items;
  const cutoff = Date.now() / 1000 - parseInt(state.range, 10) * 86400;
  return items.filter((s) => caOf(s) >= cutoff);
}

// Returns {labels, bucketIndex(ts)} covering `days` ending today.
function makeBuckets(days) {
  const unit = days <= 31 ? 'day' : days <= 210 ? 'week' : 'month';
  const now = new Date();
  const starts = [];
  const labels = [];
  if (unit === 'day') {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      starts.push(d.getTime() / 1000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
  } else if (unit === 'week') {
    const n = Math.ceil(days / 7);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7);
      starts.push(d.getTime() / 1000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
  } else {
    const n = Math.min(24, Math.ceil(days / 30));
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      starts.push(d.getTime() / 1000);
      labels.push(`${d.toLocaleString(undefined, { month: 'short' })} '${String(d.getFullYear()).slice(2)}`);
    }
  }
  const idx = (ts) => {
    if (ts < starts[0]) return -1;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      if (starts[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { labels, idx };
}

function series(items, rangeD, acc) {
  const b = makeBuckets(rangeD);
  const values = b.labels.map(() => 0);
  for (const s of items) {
    const i = b.idx(caOf(s));
    if (i >= 0) values[i] += acc(s);
  }
  return { labels: b.labels, values };
}

const CAT_LABEL = (c) => (c || 'uncategorized').replace(/_/g, ' ');

// ---------- render ----------
function render() {
  const box = document.getElementById('dash');
  if (!box || state.view !== 'dashboard') return;
  const keepScroll = box.scrollTop;
  const t = theme();
  const a = state.analytics;
  if (!a) {
    box.innerHTML = `<div class="empty">Couldn’t load session data.<br><button class="btn ghost" id="retry">Retry</button></div>`;
    document.getElementById('retry').onclick = () => {
      loadAnalytics(true)
        .then(render)
        .catch(() => toast('Sync failed', true));
    };
    return;
  }
  const all = a.items || [];
  const items = inRange(all);
  const days = rangeDays(all);

  // live strip — always current state, not range filtered
  const live = { working: 0, needs: 0, sleeping: 0 };
  for (const s of all) {
    if (s.arch) continue;
    const b = statusBucket(s);
    if (b === 'working') live.working++;
    else if (b === 'needs_you') live.needs++;
    else if (b === 'sleeping') live.sleeping++;
  }

  // KPIs over the range-filtered set
  let created = items.length, finished = 0, prs = 0, merged = 0, acus = 0, od = 0, odKnown = false;
  let cloudCount = 0;
  const catMap = new Map(), origMap = new Map(), modeMap = new Map();
  for (const s of items) {
    if (s.src !== 'local') cloudCount++;
    const b = statusBucket(s);
    if (b === 'finished' || b === 'ended') finished++;
    for (const p of prList(s)) {
      prs++;
      if (p.s === 'merged') merged++;
    }
    acus += acuOf(s) || 0;
    if (typeof s.od === 'number') {
      od += s.od;
      odKnown = true;
    }
    const c = s.cat || '';
    catMap.set(c, (catMap.get(c) || 0) + 1);
    const o = s.orig || 'other';
    origMap.set(o, (origMap.get(o) || 0) + 1);
    const mo = s.mode || 'default';
    modeMap.set(mo, (modeMap.get(mo) || 0) + 1);
  }

  const createdSeries = series(items, days, () => 1);
  const acuSeries = series(items, days, (s) => acuOf(s) || 0);
  const statusParts = BUCKETS.map(([k, label], i) => ({
    label,
    value: all.filter((s) => statusBucket(s) === k).length,
    color: [t.run, t.warn, t.ok, t.muted, t.line, t.err][i],
  }));
  const catRows = [...catMap.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([c, n], i) => ({ label: CAT_LABEL(c), value: n, color: PALETTE[i % PALETTE.length] }));
  const origParts = [...origMap.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([o, n], i) => ({ label: o, value: n, color: PALETTE[i % PALETTE.length] }));
  const modeRows = [...modeMap.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([mo, n], i) => ({ label: mo, value: n, color: PALETTE[i % PALETTE.length] }));

  const projGroups = groupByProject(items, state.projects);
  const projRows = projGroups
    .filter((g) => g.key !== '~none')
    .sort((x, y) => y.stats.sessions - x.stats.sessions)
    .slice(0, 8)
    .map((g) => ({ label: g.name, value: g.stats.sessions, hint: `${fmtNum(g.stats.acu)} ACU`, color: g.color, key: g.key }));

  const attn = all.filter(needsMe).sort((x, y) => uaOf(x) - uaOf(y)).slice(0, 6);
  const RANGES = [['7', '7d'], ['30', '30d'], ['90', '90d'], ['all', 'All']];
  const loc = state.local;

  box.innerHTML = `
    ${loc && loc.count ? `
    <button class="panel local-strip" id="localStrip">
      <div class="ls-title">⌘ Local IDE sessions <span class="muted">(Devin Desktop on this Mac)</span></div>
      <div class="ls-body"><b>${fmtInt(loc.count)}</b> sessions · ${fmtInt(loc.withMsgs)} with transcripts · ${loc.projects.length} projects · last active ${ago(loc.last)}</div>
      <div class="ls-projs">${loc.projects.slice(0, 6).map(([d, n]) => `<span class="tag">${esc(d)} ${n}</span>`).join('')}</div>
    </button>` : ''}
    <div class="live-strip">
      <button class="live-pill" data-f="busy"><b>${fmtInt(live.working)}</b> working</button>
      <button class="live-pill warn" data-f="attn"><b>${fmtInt(live.needs)}</b> needs you</button>
      <button class="live-pill" data-f="done"><b>${fmtInt(live.sleeping)}</b> sleeping</button>
    </div>
    <div class="chips">${RANGES.map(([v, l]) => `<button class="chip ${state.range === v ? 'on' : ''}" data-r="${v}">${l}</button>`).join('')}</div>
    <div class="kpi-grid">
      <div class="kpi"><b>${fmtInt(created)}</b><span>Sessions created</span></div>
      <div class="kpi"><b>${fmtInt(finished)}</b><span>Finished / ended</span></div>
      <div class="kpi"><b>${fmtInt(prs)}</b><span>PRs · ${fmtInt(merged)} merged</span></div>
      <div class="kpi"><b>${fmtNum(acus, acus >= 100 ? 0 : 1)}</b><span>ACUs · avg ${fmtNum(cloudCount ? acus / cloudCount : 0)}/cloud session</span></div>
      ${odKnown ? `<div class="kpi"><b>${fmtUsd(od)}</b><span>On-demand spend</span></div>` : ''}
    </div>
    ${attn.length ? `<div class="panel"><h3>Needs you now</h3><div class="attn-list">${attn.map(renderSessionCard).join('')}</div></div>` : ''}
    <div class="dash-grid">
      <div class="panel"><h3>Sessions started</h3>${barChart(createdSeries)}</div>
      <div class="panel"><h3>ACUs burned <span class="muted">(by session start)</span></h3>${areaChart(acuSeries)}</div>
      <div class="panel"><h3>Status right now <span class="muted">(all sessions)</span></h3>${donut({ parts: statusParts })}</div>
      <div class="panel"><h3>Work type</h3>${hbars({ rows: catRows, maxRows: 8 })}</div>
      <div class="panel"><h3>Top projects</h3>${projRows.length ? hbars({ rows: projRows, maxRows: 8 }) : '<div class="empty">No projects yet — tag sessions or add rules in Projects.</div>'}</div>
      <div class="panel"><h3>Where sessions start</h3>${donut({ parts: origParts })}</div>
      <div class="panel"><h3>Devin mode</h3>${hbars({ rows: modeRows, maxRows: 8 })}</div>
    </div>
    <div class="dash-foot">
      ${fmtInt(a.cloud ?? 0)} cloud + ${fmtInt(a.items.length - (a.cloud ?? a.items.length))} local · synced ${ago(a.fetched_at)}${a.truncated ? ' · <b class="warn-text">history truncated</b>' : ''}
      <span class="spacer"></span>
      <button class="btn ghost" id="export">Export JSON</button>
      <button class="btn ghost" id="resync">Sync now</button>
    </div>`;

  const ls = document.getElementById('localStrip');
  if (ls) ls.onclick = () => go('local');
  box.querySelectorAll('.live-pill').forEach((p) => {
    p.onclick = () => {
      state.filter = p.dataset.f === 'attn' ? 'attn' : p.dataset.f;
      state.search = '';
      go('list');
    };
  });
  box.querySelectorAll('.chip[data-r]').forEach((c) => {
    c.onclick = () => {
      state.range = c.dataset.r;
      render();
    };
  });
  box.querySelectorAll('.hbar.click').forEach((r) => {
    r.onclick = () => go('project', r.dataset.key);
  });
  box.querySelectorAll('.card[data-id]').forEach((c) => {
    c.onclick = () => go(c.dataset.src === 'local' ? 'localDetail' : 'detail', c.dataset.id);
  });
  document.getElementById('resync').onclick = async () => {
    try {
      await loadAnalytics(true);
    } catch {}
    render();
  };
  document.getElementById('export').onclick = () => {
    const blob = new Blob([JSON.stringify(state.analytics, null, 2)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = u;
    el.download = `devin-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    el.click();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  };
  box.scrollTop = keepScroll;
}
