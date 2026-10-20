// Shared state, API plumbing and small utilities used by every view.

export const app = document.getElementById('app');
export const toastEl = document.getElementById('toast');

export const state = {
  view: 'boot',
  // sessions list
  sessions: [],
  filter: 'all',
  search: '',
  hasNext: false,
  cursor: null,
  loading: false,
  // session detail
  current: null,
  messages: [],
  // timers
  pollTimer: null,
  listTimer: null,
  dashTimer: null,
  // analytics
  analytics: null, // { fetched_at, truncated, total, items: [slim] }
  analyticsBusy: false,
  local: null, // { count, withMsgs, projects: [[dir, n]...], last } from /api/local/sessions
  range: '30', // '7' | '30' | '90' | 'all'
  // projects
  projects: [], // user rules from /api/projects
  projectsLoaded: false,
  projectKey: null,
  repos: null, // org repos from /api/repos
};

// ---------- view registry (avoids circular imports) ----------
export const views = {};
export function go(name, ...args) {
  if (views[name]) views[name](...args);
}
export function setView(v) {
  state.view = v;
  document.body.dataset.view = v;
}

// ---------- utils ----------
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, bad) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.className = ''), 2800);
}

export function errMsg(data, status) {
  if (!data) return `HTTP ${status}`;
  const d = data.detail ?? data.title ?? data.error;
  if (typeof d === 'string') return d;
  if (d) return JSON.stringify(d).slice(0, 200);
  return `HTTP ${status}`;
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store', // avoids ERR_CACHE_MISS on POSTs through the SW on installed PWAs
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'devin-control' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text.slice(0, 200) };
  }
  if (res.status === 401 && !url.startsWith('/auth/login')) {
    stopTimers();
    go('login');
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(errMsg(data, res.status));
  return data;
}

export function ago(ts) {
  if (!ts) return '';
  if (ts > 1e12) ts /= 1000;
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export const fmtInt = (n) => (n == null ? '0' : Number(n).toLocaleString());
export const fmtNum = (n, dp = 1) => (n == null ? '0' : Number(n).toFixed(dp));
export const fmtUsd = (n) => '$' + Number(n || 0).toFixed(2);

// Small, safe markdown: everything is escaped first, then a few patterns are re-introduced.
export function md(src) {
  const blocks = [];
  let t = esc(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, c) => {
    blocks.push(c.replace(/\n$/, ''));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  t = t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\n/g, '<br>')
    .replace(/\u0000(\d+)\u0000/g, (m, i) => `<pre><code>${blocks[Number(i)]}</code></pre>`);
  return t;
}

// ---------- session field accessors ----------
// Works on both full SessionResponse objects (list/detail endpoints) and the
// slimmed items returned by /api/analytics.
export const sid = (s) => s.id || s.session_id;
export const stOf = (s) => s.st ?? s.status;
export const sdOf = (s) => s.sd ?? s.status_detail;
export const caOf = (s) => s.ca ?? s.created_at ?? 0;
export const uaOf = (s) => s.ua ?? s.updated_at ?? 0;
export const acuOf = (s) => s.acu ?? s.acus_consumed ?? 0;
export const archOf = (s) => s.arch ?? !!s.is_archived;
export const tagsOf = (s) => s.tags || [];
export const prList = (s) =>
  s.prs ? s.prs : (s.pull_requests || []).map((p) => ({ u: p.pr_url || '', s: p.pr_state || '' }));

export function badge(s) {
  const st = stOf(s);
  const d = sdOf(s);
  if (archOf(s)) return ['Archived', 'mute'];
  if (st === 'running') {
    if (d === 'waiting_for_user') return ['Needs input', 'warn'];
    if (d === 'waiting_for_approval') return ['Needs approval', 'warn'];
    if (d === 'finished') return ['Finished', 'ok'];
    return ['Working', 'run'];
  }
  if (st === 'suspended') {
    if (!d || d === 'inactivity' || d === 'user_request') return ['Sleeping', 'mute'];
    return ['Paused: ' + d.replace(/_/g, ' '), 'err'];
  }
  if (st === 'exit') return ['Ended', 'mute'];
  if (st === 'error') return ['Error', 'err'];
  if (st === 'new' || st === 'claimed' || st === 'resuming') return ['Starting', 'run'];
  return [st || 'unknown', 'mute'];
}

// A coarser status bucket for charts/filters.
export function statusBucket(s) {
  const st = stOf(s);
  const d = sdOf(s);
  if (st === 'running' && (d === 'waiting_for_user' || d === 'waiting_for_approval')) return 'needs_you';
  if (st === 'running' && d === 'finished') return 'finished';
  if (st === 'running' || st === 'new' || st === 'claimed' || st === 'resuming') return 'working';
  if (st === 'suspended') return 'sleeping';
  if (st === 'exit') return 'ended';
  return 'error';
}
export const BUCKETS = [
  ['working', 'Working'],
  ['needs_you', 'Needs you'],
  ['finished', 'Finished'],
  ['sleeping', 'Sleeping'],
  ['ended', 'Ended'],
  ['error', 'Error'],
];

export const needsMe = (s) =>
  stOf(s) === 'running' && (sdOf(s) === 'waiting_for_user' || sdOf(s) === 'waiting_for_approval');
export const isBusy = (s) =>
  ['new', 'claimed', 'resuming'].includes(stOf(s)) || (stOf(s) === 'running' && (!sdOf(s) || sdOf(s) === 'working'));

export function stopTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.listTimer);
  clearInterval(state.dashTimer);
  state.pollTimer = state.listTimer = state.dashTimer = null;
}

export function openSheet(html) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.addEventListener('click', (e) => {
    if (e.target === bg) bg.remove();
  });
  document.body.appendChild(bg);
  return bg;
}

export function copyText(text, okMsg = 'Copied') {
  const done = () => toast(okMsg);
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done, () => fallback());
  return fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {}
    ta.remove();
  }
}

// ---------- projects ----------
// A session belongs to a user-defined project when any match string appears
// (case-insensitive substring) in its repos, tags or title. Unmatched sessions
// fall back to a group per repo (from PR urls), else "No project".
export function repoFromUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    const seg = url.pathname.split('/').filter(Boolean);
    let repo = '';
    if (url.hostname === 'dev.azure.com' || /(^|\.)visualstudio\.com$/.test(url.hostname)) {
      const gi = seg.indexOf('_git');
      if (gi > 0 && seg[gi + 1]) repo = `${seg[0]}/${seg[gi + 1]}`;
    } else if (seg.length >= 2) {
      repo = `${seg[0]}/${seg[1]}`;
    }
    return repo.toLowerCase().replace(/\.git$/, '');
  } catch {
    return '';
  }
}

export function sessionRepos(s) {
  const out = [];
  if (s.dir) out.push(String(s.dir).toLowerCase()); // local IDE sessions group by project dir
  for (const p of prList(s)) {
    const r = repoFromUrl(p.u);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

export function autoColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 55%)`;
}

function projectStats(items) {
  const st = {
    sessions: items.length, working: 0, needsYou: 0, finished: 0,
    acu: 0, od: 0, prs: 0, prsMerged: 0, last: 0,
  };
  for (const s of items) {
    const b = statusBucket(s);
    if (b === 'working') st.working++;
    else if (b === 'needs_you') st.needsYou++;
    else if (b === 'finished' || b === 'ended') st.finished++;
    st.acu += acuOf(s) || 0;
    if (typeof s.od === 'number') st.od += s.od;
    for (const p of prList(s)) {
      st.prs++;
      if (p.s === 'merged') st.prsMerged++;
    }
    const ua = uaOf(s) || caOf(s);
    if (ua > st.last) st.last = ua;
  }
  return st;
}

export function groupByProject(items, rules) {
  const groups = new Map();
  const push = (key, name, color, auto, s) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, name, color, auto, items: [] }));
    g.items.push(s);
  };
  const normRules = (rules || [])
    .filter((r) => r && r.name && Array.isArray(r.match) && r.match.length)
    .map((r) => ({ ...r, ms: r.match.map((x) => String(x).toLowerCase()) }));

  for (const s of items) {
    const hay = [
      (s.title || '').toLowerCase(),
      ...tagsOf(s).map((t) => String(t).toLowerCase()),
      ...sessionRepos(s).map((r) => r.toLowerCase()),
    ];
    const hit = normRules.find((r) => r.ms.some((m) => hay.some((h) => h.includes(m))));
    if (hit) {
      push('u:' + hit.name.toLowerCase(), hit.name, hit.color || autoColor(hit.name), false, s);
      continue;
    }
    const repos = sessionRepos(s);
    if (repos.length) push('r:' + repos[0], repos[0], autoColor(repos[0]), true, s);
    else push('~none', 'No project', 'var(--muted)', true, s);
  }
  const out = [...groups.values()].map((g) => ({ ...g, stats: projectStats(g.items) }));
  out.sort((a, b) => b.stats.last - a.stats.last);
  return out;
}
