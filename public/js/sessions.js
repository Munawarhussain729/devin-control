// Sessions list, session detail (conversation + actions) and the new-session sheet.

import {
  app, state, esc, toast, api, ago, md, badge, needsMe, isBusy, stopTimers,
  openSheet, copyText, setView, go, sid, tagsOf, fmtNum, fmtInt,
} from './core.js';

const FILTERS = [
  ['all', 'All'],
  ['attn', 'Needs me'],
  ['busy', 'Working'],
  ['done', 'Done'],
  ['archived', 'Archived'],
];

function filtered() {
  const f = state.filter;
  let items = state.sessions;
  if (f === 'attn') items = items.filter(needsMe);
  else if (f === 'busy') items = items.filter(isBusy);
  else if (f === 'done')
    items = items.filter((s) => (s.status === 'running' && s.status_detail === 'finished') || s.status === 'exit' || s.status === 'suspended');
  const q = state.search.trim().toLowerCase();
  if (q)
    items = items.filter(
      (s) =>
        (s.title || '').toLowerCase().includes(q) ||
        tagsOf(s).some((t) => String(t).toLowerCase().includes(q)) ||
        String(s.session_id || '').toLowerCase().includes(q)
    );
  return items;
}

function countFor(key) {
  if (key === 'attn') return state.sessions.filter(needsMe).length;
  if (key === 'busy') return state.sessions.filter(isBusy).length;
  return null;
}

export function renderSessionCard(s) {
  const [label, cls] = badge(s);
  const prs = (s.pull_requests || s.prs || []).length;
  const tags = tagsOf(s).slice(0, 3);
  return `<button class="card ${needsMe(s) ? 'attn' : ''}" data-id="${esc(sid(s))}" data-src="${esc(s.src || 'cloud')}">
    <div class="t">${s.src === 'local' ? '⌘ ' : ''}${esc(s.title || 'Untitled session')}</div>
    <div class="meta">
      <span class="badge ${cls}">${esc(label)}</span>
      <span>${ago(s.updated_at || s.ua || s.created_at || s.ca)}</span>
      ${s.src === 'local' ? `<span class="tag">IDE</span>${s.msgs ? `<span>${fmtInt(s.msgs)} msgs</span>` : ''}` : ''}
      ${prs ? `<span>⎇ ${prs} PR${prs > 1 ? 's' : ''}</span>` : ''}
      ${typeof (s.acus_consumed ?? s.acu) === 'number' && s.src !== 'local' ? `<span>${fmtNum(s.acus_consumed ?? s.acu)} ACU</span>` : ''}
      ${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
    </div></button>`;
}

export function showList() {
  setView('list');
  stopTimers();
  app.innerHTML = `
    <div class="topbar">
      <h1>Sessions</h1>
      <button class="icon-btn" id="refresh" aria-label="Refresh">⟳</button>
      <button class="icon-btn" id="logout" aria-label="Sign out">⎋</button>
    </div>
    <div class="searchrow"><input class="in" id="search" type="search" placeholder="Search title, tag or id…" value="${esc(state.search)}" autocomplete="off"></div>
    <div class="chips" id="chips"></div>
    <div class="scroll" id="list"></div>
    <button class="fab" id="newBtn" aria-label="New session">+</button>`;
  document.getElementById('refresh').onclick = () => loadSessions(true);
  document.getElementById('logout').onclick = async () => {
    try {
      await api('POST', '/auth/logout');
    } catch {}
    stopTimers();
    go('login');
  };
  document.getElementById('newBtn').onclick = openNewSheet;
  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    state.search = search.value;
    renderList();
  });
  renderList();
  loadSessions(true);
  state.listTimer = setInterval(() => {
    if (state.view === 'list' && !document.hidden) loadSessions(true, true);
  }, 15000);
}

function renderList() {
  const chips = document.getElementById('chips');
  const list = document.getElementById('list');
  if (!chips || !list) return;
  chips.innerHTML = FILTERS.map(([k, label]) => {
    const n = countFor(k);
    return `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('');
  chips.querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => {
      const prevArchived = state.filter === 'archived';
      state.filter = b.dataset.f;
      if (prevArchived !== (state.filter === 'archived')) {
        state.sessions = [];
        renderList();
        loadSessions(true);
      } else renderList();
    };
  });

  const items = filtered();
  if (!items.length) {
    list.innerHTML = `<div class="empty">${state.loading ? 'Loading…' : 'No sessions here.'}</div>`;
  } else {
    list.innerHTML =
      items.map(renderSessionCard).join('') +
      (state.hasNext && !state.search ? `<button class="btn ghost more" id="more">Load more</button>` : '');
    list.querySelectorAll('.card').forEach((c) => (c.onclick = () => go(c.dataset.src === 'local' ? 'localDetail' : 'detail', c.dataset.id)));
    const more = document.getElementById('more');
    if (more) more.onclick = () => loadSessions(false);
  }
}

export function refreshList() {
  if (state.view === 'list') loadSessions(true, true);
}

async function loadSessions(reset, silent) {
  if (state.loading) return;
  state.loading = true;
  if (!silent) renderList();
  try {
    const params = new URLSearchParams({ first: '50' });
    params.set('is_archived', state.filter === 'archived' ? 'true' : 'false');
    if (!reset && state.cursor) params.set('after', state.cursor);
    const data = await api('GET', `/api/sessions?${params}`);
    const items = data.items || [];
    if (reset) state.sessions = items;
    else state.sessions = state.sessions.concat(items);
    state.hasNext = Boolean(data.has_next_page);
    state.cursor = data.end_cursor || null;
  } catch (e) {
    if (e.message !== 'Signed out' && !silent) toast(e.message, true);
  } finally {
    state.loading = false;
    if (state.view === 'list') renderList();
  }
}

// ---------- new session ----------
export async function openNewSheet() {
  let repoOptions = '';
  if (!state.repos) {
    try {
      state.repos = (await api('GET', '/api/repos')).items || [];
    } catch {
      state.repos = [];
    }
  }
  repoOptions = state.repos.map((r) => `<option value="${esc(r.path || r.full)}">${esc(r.full)}</option>`).join('');
  const projectOpts = (state.projects || [])
    .map((p, i) => `<option value="${i}">${esc(p.name)}</option>`)
    .join('');

  const bg = openSheet(`
    <h2>New Devin session</h2>
    <label class="f">What should Devin do?</label>
    <textarea class="in" id="np" placeholder="Describe the task…"></textarea>
    <label class="f">Title (optional)</label>
    <input class="in" id="nt" placeholder="Short name">
    ${projectOpts ? `<label class="f">Project (optional — fills repos &amp; tag)</label>
    <select class="in" id="nproj"><option value="">—</option>${projectOpts}</select>` : ''}
    <label class="f">Repos (optional, comma separated, owner/name)</label>
    <input class="in" id="nr" list="repoList" placeholder="acme/web, acme/api" autocapitalize="off" autocorrect="off">
    <datalist id="repoList">${repoOptions}</datalist>
    <label class="f">Tags (optional, comma separated)</label>
    <input class="in" id="ntg" placeholder="project:my-app, backend" autocapitalize="off" autocorrect="off">
    <label class="f">Mode</label>
    <select class="in" id="nm">
      <option value="">Org default</option>
      <option value="normal">Normal</option>
      <option value="fast">Fast (2x speed, higher cost)</option>
      <option value="lite">Lite</option>
      <option value="ultra">Ultra</option>
      <option value="fusion">Fusion</option>
      <option value="swe-2-medium">SWE-2 medium</option>
      <option value="swe-2-high">SWE-2 high</option>
      <option value="swe-2-max">SWE-2 max</option>
    </select>
    <label class="f">Max ACUs (optional)</label>
    <input class="in" id="na" type="number" min="1" inputmode="numeric" placeholder="e.g. 10">
    <div class="row">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn" id="go">Start</button>
    </div>`);

  const projSel = bg.querySelector('#nproj');
  if (projSel)
    projSel.onchange = () => {
      const p = state.projects[Number(projSel.value)];
      if (!p) return;
      const repoish = p.match.filter((m) => /^[\w.-]+\/[\w.-]+$/.test(m));
      if (repoish.length) bg.querySelector('#nr').value = repoish.join(', ');
      const tg = bg.querySelector('#ntg');
      const ptag = `project:${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      const cur = tg.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!cur.includes(ptag)) tg.value = cur.concat(ptag).join(', ');
    };

  bg.querySelector('#cancel').onclick = () => bg.remove();
  bg.querySelector('#go').onclick = async (e) => {
    const prompt = bg.querySelector('#np').value.trim();
    if (!prompt) return toast('Write a task first', true);
    const body = { prompt };
    const title = bg.querySelector('#nt').value.trim();
    if (title) body.title = title;
    const repos = bg.querySelector('#nr').value.split(',').map((x) => x.trim()).filter(Boolean);
    if (repos.length) body.repos = repos;
    const tags = bg.querySelector('#ntg').value.split(',').map((x) => x.trim()).filter(Boolean);
    if (tags.length) body.tags = tags;
    const mode = bg.querySelector('#nm').value;
    if (mode) body.devin_mode = mode;
    const acu = parseInt(bg.querySelector('#na').value, 10);
    if (acu > 0) body.max_acu_limit = acu;
    e.target.disabled = true;
    try {
      const s = await api('POST', '/api/sessions', body);
      bg.remove();
      toast('Session started');
      go('detail', s.session_id, s);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  };
  setTimeout(() => bg.querySelector('#np').focus(), 50);
}

// ---------- detail ----------
export async function showDetail(id, preload) {
  setView('detail');
  stopTimers();
  state.current = preload || state.sessions.find((s) => s.session_id === id) || { session_id: id, status: 'new' };
  state.messages = [];
  app.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="back" aria-label="Back">←</button>
      <h1 id="dtitle"></h1>
      <button class="icon-btn" id="menu" aria-label="More">⋯</button>
    </div>
    <div class="sub" id="dsub"></div>
    <div id="dnotice"></div>
    <div class="msgs" id="msgs"><div class="empty">Loading…</div></div>
    <div class="composer">
      <textarea id="mtext" rows="1" placeholder="Message Devin…"></textarea>
      <button class="btn" id="send">Send</button>
    </div>`;
  document.getElementById('back').onclick = () => go('list');
  document.getElementById('menu').onclick = openMenu;
  const ta = document.getElementById('mtext');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMessage();
  });
  document.getElementById('send').onclick = sendMessage;
  renderDetailHeader();
  await refreshDetail(true);
  state.pollTimer = setInterval(() => {
    if (state.view === 'detail' && !document.hidden) refreshDetail(false);
  }, 4000);
}

function renderDetailHeader() {
  const s = state.current;
  if (!s) return;
  const [label, cls] = badge(s);
  document.getElementById('dtitle').textContent = s.title || 'Session';
  const prs = (s.pull_requests || [])
    .filter((p) => /^https?:\/\//.test(p.pr_url || ''))
    .map((p) => `<a href="${esc(p.pr_url)}" target="_blank" rel="noopener noreferrer">⎇ PR${p.pr_state ? ' · ' + esc(p.pr_state) : ''}</a>`)
    .join('');
  const facts = [
    s.category ? `<span class="tag">${esc(s.category.replace(/_/g, ' '))}</span>` : '',
    s.devin_mode ? `<span class="tag">${esc(s.devin_mode)}</span>` : '',
    s.origin ? `<span class="tag">${esc(s.origin)}</span>` : '',
    ...tagsOf(s).map((t) => `<span class="tag">${esc(t)}</span>`),
  ].join('');
  document.getElementById('dsub').innerHTML =
    `<span class="badge ${cls}">${esc(label)}</span>` +
    (typeof s.acus_consumed === 'number' ? `<span>${fmtNum(s.acus_consumed)} ACU</span>` : '') +
    (typeof s.on_demand_usage === 'number' && s.on_demand_usage > 0 ? `<span>$${s.on_demand_usage.toFixed(2)}</span>` : '') +
    (s.url && /^https?:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open in Devin ↗</a>` : '') +
    prs + facts;
  let notice = '';
  if (needsMe(s))
    notice = `<div class="notice warn">${s.status_detail === 'waiting_for_approval' ? 'Devin is waiting for an approval. Approve it in the Devin web app, or reply here.' : 'Devin is waiting for your input.'}</div>`;
  else if (s.status === 'suspended') notice = `<div class="notice">Session is asleep. Sending a message will wake it up.</div>`;
  else if (s.status === 'exit') notice = `<div class="notice">This session has ended and can’t be resumed.</div>`;
  document.getElementById('dnotice').innerHTML = notice;
  const dead = s.status === 'exit';
  const ta = document.getElementById('mtext');
  const send = document.getElementById('send');
  if (ta) ta.disabled = dead;
  if (send) send.disabled = dead;
}

async function fetchAllMessages(id) {
  let all = [];
  let after = null;
  for (let i = 0; i < 6; i++) {
    const p = new URLSearchParams({ first: '200' });
    if (after) p.set('after', after);
    const d = await api('GET', `/api/sessions/${encodeURIComponent(id)}/messages?${p}`);
    all = all.concat(d.items || []);
    if (!d.has_next_page || !d.end_cursor) break;
    after = d.end_cursor;
  }
  return all;
}

export async function refreshDetail(first) {
  const id = state.current.session_id;
  try {
    const [s, msgs] = await Promise.all([
      api('GET', `/api/sessions/${encodeURIComponent(id)}`),
      fetchAllMessages(id),
    ]);
    if (state.view !== 'detail' || state.current.session_id !== id) return;
    state.current = s;
    const changed =
      msgs.length !== state.messages.length || msgs.at(-1)?.event_id !== state.messages.at(-1)?.event_id;
    state.messages = msgs;
    renderDetailHeader();
    if (changed || first) renderMessages(first);
  } catch (e) {
    if (e.message !== 'Signed out' && first) toast(e.message, true);
  }
}

function renderMessages(forceBottom) {
  const box = document.getElementById('msgs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (!state.messages.length) {
    box.innerHTML = `<div class="empty">No messages yet.</div>`;
    return;
  }
  box.innerHTML = state.messages
    .map(
      (m) =>
        `<div class="msg ${m.source === 'user' ? 'user' : 'devin'}">${md(m.message)}<span class="when">${ago(m.created_at)}${m.username ? ' · ' + esc(m.username) : ''}</span></div>`
    )
    .join('');
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const ta = document.getElementById('mtext');
  const btn = document.getElementById('send');
  const text = ta.value.trim();
  if (!text) return;
  btn.disabled = true;
  try {
    const id = state.current.session_id;
    const s = await api('POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { message: text });
    ta.value = '';
    ta.style.height = 'auto';
    state.current = s || state.current;
    state.messages.push({ event_id: 'local-' + Date.now(), source: 'user', message: text, created_at: Date.now() / 1000 });
    renderDetailHeader();
    renderMessages(true);
    setTimeout(() => refreshDetail(false), 1500);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = state.current?.status === 'exit';
  }
}

function openTagsSheet() {
  const s = state.current;
  const tags = [...tagsOf(s)];
  const bg = openSheet(`
    <h2>Session tags</h2>
    <div class="chips wrap" id="tagchips"></div>
    <label class="f">Add tag</label>
    <div class="row" style="margin-top:4px">
      <input class="in" id="newtag" placeholder="project:my-app" autocapitalize="off" autocorrect="off">
      <button class="btn ghost" id="add" style="flex:0 0 auto">Add</button>
    </div>
    <div class="row"><button class="btn ghost" id="close">Done</button></div>`);
  const render = () => {
    bg.querySelector('#tagchips').innerHTML = tags.length
      ? tags.map((t, i) => `<button class="chip" data-i="${i}" title="Remove">${esc(t)} ✕</button>`).join('')
      : '<span class="muted" style="padding:4px">No tags. Tags like <code>project:web</code> group sessions on the dashboard.</span>';
    bg.querySelectorAll('#tagchips .chip').forEach((c) => {
      c.onclick = async () => {
        const next = tags.filter((_, i) => i !== Number(c.dataset.i));
        try {
          await api('PUT', `/api/sessions/${encodeURIComponent(s.session_id)}/tags`, { tags: next });
          tags.length = 0;
          tags.push(...next);
          s.tags = [...tags];
          renderDetailHeader();
          render();
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  };
  const add = async () => {
    const inp = bg.querySelector('#newtag');
    const t = inp.value.trim();
    if (!t || tags.includes(t)) return;
    try {
      await api('POST', `/api/sessions/${encodeURIComponent(s.session_id)}/tags`, { tags: [t] });
      tags.push(t);
      inp.value = '';
      s.tags = [...tags];
      renderDetailHeader();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };
  bg.querySelector('#add').onclick = add;
  bg.querySelector('#newtag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  bg.querySelector('#close').onclick = () => bg.remove();
  render();
}

function openMenu() {
  const s = state.current;
  const archived = s.is_archived;
  const bg = openSheet(`
    <h2>Session actions</h2>
    ${s.url && /^https?:\/\//.test(s.url) ? `<a class="menu-item" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open in Devin ↗</a>` : ''}
    <button class="menu-item" id="tags">Edit tags</button>
    <button class="menu-item" id="copyid">Copy session ID</button>
    ${s.url ? `<button class="menu-item" id="copyurl">Copy Devin link</button>` : ''}
    <button class="menu-item" id="arch">${archived ? 'Unarchive' : 'Sleep &amp; archive'}</button>
    <button class="menu-item danger" id="term">Terminate (can’t be resumed)</button>
    <div class="row"><button class="btn ghost" id="close">Close</button></div>`);
  bg.querySelector('#close').onclick = () => bg.remove();
  bg.querySelector('#tags').onclick = () => {
    bg.remove();
    openTagsSheet();
  };
  bg.querySelector('#copyid').onclick = () => {
    bg.remove();
    copyText(s.session_id, 'Session ID copied');
  };
  const cu = bg.querySelector('#copyurl');
  if (cu)
    cu.onclick = () => {
      bg.remove();
      copyText(s.url, 'Link copied');
    };
  bg.querySelector('#arch').onclick = async () => {
    bg.remove();
    try {
      const id = encodeURIComponent(s.session_id);
      state.current = await api('POST', `/api/sessions/${id}/${archived ? 'unarchive' : 'archive'}`);
      renderDetailHeader();
      toast(archived ? 'Unarchived' : 'Archived');
    } catch (e) {
      toast(e.message, true);
    }
  };
  bg.querySelector('#term').onclick = () => {
    bg.remove();
    const c = openSheet(`
      <h2>Terminate this session?</h2>
      <p>Devin stops immediately and the session can’t be resumed. You can still read it afterwards.</p>
      <div class="row"><button class="btn ghost" id="no">Keep running</button><button class="btn danger" id="yes">Terminate</button></div>`);
    c.querySelector('#no').onclick = () => c.remove();
    c.querySelector('#yes').onclick = async () => {
      c.remove();
      try {
        state.current = await api('DELETE', `/api/sessions/${encodeURIComponent(s.session_id)}`);
        renderDetailHeader();
        toast('Session terminated');
      } catch (e) {
        toast(e.message, true);
      }
    };
  };
}
