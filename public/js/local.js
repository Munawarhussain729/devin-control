// Local IDE sessions — Devin Desktop/CLI sessions stored on this Mac, listed
// from the Devin app's own stores via /api/local/*. Grouped by project dir.

import { app, state, esc, api, ago, setView, go, toast, copyText, md, fmtInt, openSheet, stopTimers } from './core.js';

const lstate = { items: [], search: '', loaded: false, loading: false };

const base = (p) => (p || '').split('/').filter(Boolean).pop() || '';
const isNamey = (s) => s.msgs > 0 || !/^untitled/i.test(s.title || '');

async function loadLocal(force) {
  if (lstate.loading) return;
  if (lstate.loaded && !force) return;
  lstate.loading = true;
  try {
    const d = await api('GET', '/api/local/sessions');
    lstate.items = d.available ? d.items : [];
    lstate.loaded = true;
    if (!d.available) toast('Local Devin data not found on this machine', true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    lstate.loading = false;
  }
}

export async function showLocal() {
  setView('local');
  state.current = null;
  app.innerHTML = `
    <div class="topbar">
      <h1>Local IDE</h1>
      <button class="icon-btn" id="refresh" aria-label="Refresh">⟳</button>
      <button class="icon-btn" id="logout" aria-label="Sign out">⎋</button>
    </div>
    <div class="searchrow"><input class="in" id="search" type="search" placeholder="Search local sessions…" value="${esc(lstate.search)}" autocomplete="off"></div>
    <div class="scroll" id="list"><div class="empty">${lstate.loaded ? '' : 'Scanning local sessions…'}</div></div>`;
  document.getElementById('refresh').onclick = async () => {
    lstate.loaded = false;
    await loadLocal(true);
    renderLocalList();
  };
  document.getElementById('logout').onclick = async () => {
    try { await api('POST', '/auth/logout', {}); } catch {}
    go('login');
  };
  const si = document.getElementById('search');
  si.addEventListener('input', () => { lstate.search = si.value; renderLocalList(); });
  await loadLocal(false);
  if (state.view === 'local') renderLocalList();
}

function renderLocalList() {
  const list = document.getElementById('list');
  if (!list || state.view !== 'local') return;
  const q = lstate.search.trim().toLowerCase();
  let items = lstate.items;
  if (q) items = items.filter((s) => (s.title + ' ' + s.cwd + ' ' + s.id + ' ' + (s.aid || '')).toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = `<div class="empty">${lstate.loading ? 'Scanning local sessions…' : q ? 'No matches.' : 'No local sessions found.'}</div>`;
    return;
  }
  // group by cwd (project dir)
  const groups = new Map();
  for (const s of items) {
    const k = s.cwd || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((s) => s.ua)) - Math.max(...a[1].map((s) => s.ua)));
  list.innerHTML = ordered
    .map(([cwd, ss]) => {
      const name = cwd ? base(cwd) : 'Unknown project';
      return `<div class="pgroup">
        <div class="pghead"><span class="pgname">${esc(name)}</span><span class="pgpath">${esc(cwd)}</span><span class="pgcount">${ss.length}</span></div>
        ${ss.map((s) => `
          <button class="card" data-id="${esc(s.id)}">
            <div class="t">${esc(s.title || 'Untitled session')}</div>
            <div class="meta">
              <span class="badge ${s.msgs ? 'run' : 'mute'}">${s.msgs ? fmtInt(s.msgs) + ' msgs' : 'empty'}</span>
              ${s.tools ? `<span>${fmtInt(s.tools)} tools</span>` : ''}
              ${s.umsgs ? `<span>${fmtInt(s.umsgs)} prompts</span>` : ''}
              ${s.mode ? `<span class="tag">${esc(s.mode)}</span>` : ''}
              <span>${ago(s.ua)}</span>
            </div>
          </button>`).join('')}
      </div>`;
    })
    .join('');
  list.querySelectorAll('.card').forEach((c) => (c.onclick = () => go('localDetail', c.dataset.id)));
}

function renderTranscript(box, msgs) {
  if (!msgs.length) {
    box.innerHTML = '<div class="empty">Transcript is empty.</div>';
    return;
  }
  box.innerHTML = msgs
    .map((m) => {
      if (m.kind === 'tool') {
        return `<button class="lcard tool ${m.status === 'failed' ? 'failed' : ''}" data-tl="${m.pos}"><span class="tk">${m.status === 'in_progress' ? '▸' : m.status === 'failed' ? '✕' : '✓'}</span>${esc(m.title)}${m.tool ? `<span class="tkind">${esc(m.tool)}</span>` : ''}</button>`;
      }
      if (m.kind === 'plan') {
        return `<div class="lcard plan"><div class="lp">Plan</div><pre>${esc(m.text)}</pre></div>`;
      }
      const cls = m.kind === 'user' ? 'user' : 'devin';
      const thought = m.kind === 'thought' ? ' thought' : '';
      return `<div class="msg ${cls}${thought}">${md(m.text)}</div>`;
    })
    .join('');
  box.querySelectorAll('.lcard.tool').forEach((c) => {
    c.onclick = () => copyText(c.textContent.replace(/^[▸✓✕]/, '').trim(), 'Tool call copied');
  });
  box.scrollTop = box.scrollHeight;
}

export async function showLocalDetail(id) {
  setView('localDetail');
  stopTimers();
  const s = lstate.items.find((x) => x.id === id) || { id, title: '', cwd: '', aid: '' };
  const resumable = s.resumable ?? (!!(s.aid || /^[0-9a-f-]{32,40}$/.test(id)) && !!s.cwd);
  app.innerHTML = `
    <div class="topbar">
      <button class="icon-btn" id="back" aria-label="Back">←</button>
      <h1 id="dtitle">Local session</h1>
      <button class="icon-btn" id="menu" aria-label="More">⋯</button>
    </div>
    <div class="msgs" id="msgs"><div class="empty">Loading transcript…</div></div>
    ${resumable ? `
    <div class="composer">
      <textarea id="mtext" rows="1" placeholder="Send a prompt to this session…"></textarea>
      <select class="in mini" id="mmode" title="Permission mode">
        <option value="">session mode</option>
        <option value="auto">auto</option>
        <option value="accept-edits">accept-edits</option>
        <option value="smart">smart</option>
        <option value="dangerous">dangerous</option>
      </select>
      <button class="btn" id="send">Send</button>
    </div>` : ''}`;
  document.getElementById('back').onclick = () => go('local');
  document.getElementById('menu').onclick = () => {
    const bg = openSheet(`
      <h2>${esc(s.title || 'Local session')}</h2>
      ${s.cwd ? `<div class="muted" style="margin-bottom:12px;word-break:break-all">${esc(s.cwd)}</div>` : ''}
      <div class="row"><button class="btn ghost" id="cpid">Copy session id</button></div>
      ${s.aid ? `<div class="row"><button class="btn ghost" id="cpresume">Copy resume cmd (devin -r)</button></div>` : ''}
      ${s.cwd ? `<div class="row"><button class="btn ghost" id="cpcwd">Copy project path</button></div>` : ''}
      <div class="row"><button class="btn ghost" id="close">Close</button></div>`);
    bg.querySelector('#cpid').onclick = () => copyText(s.aid || s.id, 'Session id copied');
    bg.querySelector('#cpresume')?.addEventListener('click', () => copyText(`cd ${s.cwd || '~'} && devin -r ${s.aid.split('/').pop()}`, 'Resume command copied'));
    bg.querySelector('#cpcwd')?.addEventListener('click', () => copyText(s.cwd, 'Path copied'));
    bg.querySelector('#close').onclick = () => bg.remove();
  };

  const box = document.getElementById('msgs');
  const load = async (quiet) => {
    try {
      const d = await api('GET', `/api/local/sessions/${encodeURIComponent(id)}`);
      if (state.view !== 'localDetail') return;
      document.getElementById('dtitle').textContent = d.title || s.title || 'Local session';
      const live = box.querySelector('.live-turn');
      renderTranscript(box, d.msgs);
      if (live) box.appendChild(live); // keep live-turn pinned at the end
    } catch (e) {
      if (!quiet) box.innerHTML = `<div class="empty">${esc(e.message)}${s.msgs ? '' : '<br>This session has no stored transcript yet.'}</div>`;
    }
  };
  await load(false);
  if (state.view !== 'localDetail') return;

  // ---- composer: resume the session non-interactively via `devin -r <id> -p` ----
  const ta = document.getElementById('mtext');
  const sendBtn = document.getElementById('send');
  if (!ta || !sendBtn) return;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  });
  const liveBox = document.createElement('div');
  liveBox.className = 'live-turn';
  box.appendChild(liveBox);
  const renderLive = (msgs, working) => {
    liveBox.innerHTML =
      `<div class="live-turn-head">${working ? '<span class="badge run">Devin is working…</span>' : ''}</div>` +
      (msgs || [])
        .map((m) => {
          if (m.kind === 'tool')
            return `<div class="lcard tool ${m.status === 'failed' ? 'failed' : ''}"><span class="tk">${m.status === 'in_progress' ? '▸' : m.status === 'failed' ? '✕' : '✓'}</span>${esc(m.title)}${m.tool ? `<span class="tkind">${esc(m.tool)}</span>` : ''}</div>`;
          if (m.kind === 'plan') return `<div class="lcard plan"><div class="lp">Plan</div><pre>${esc(m.text)}</pre></div>`;
          const cls = m.kind === 'user' ? 'user' : 'devin';
          return `<div class="msg ${cls}${m.kind === 'thought' ? ' thought' : ''}">${md(m.text)}</div>`;
        })
        .join('');
    box.scrollTop = box.scrollHeight;
  };
  const pollJob = (job) => {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const j = await api('GET', `/api/local/jobs/${job}`);
        renderLive(j.msgs, j.status === 'running');
        if (j.status !== 'running') {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          sendBtn.disabled = false;
          ta.disabled = false;
          if (j.exit === 0) {
            toast('Devin finished');
          } else {
            const tail = (j.out || '').trim().split('\n').filter(Boolean).pop() || '';
            toast(tail ? `Devin failed: ${tail.slice(0, 140)}` : 'Devin failed', true);
            const card = document.createElement('div');
            card.className = 'lcard plan';
            card.innerHTML = `<div class="lp">Devin exited${j.exit != null ? ` (code ${j.exit})` : ''}</div><pre>${esc((j.out || 'no output').slice(-1500))}</pre>`;
            liveBox.appendChild(card);
          }
          lstate.loaded = false; // refresh counts next time the list opens
        }
      } catch {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        sendBtn.disabled = false;
        ta.disabled = false;
      }
    }, 3000);
  };
  sendBtn.onclick = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return;
    sendBtn.disabled = true;
    ta.disabled = true;
    try {
      const r = await api('POST', `/api/local/sessions/${encodeURIComponent(id)}/prompt`, {
        prompt,
        mode: document.getElementById('mmode')?.value || '',
      });
      ta.value = '';
      ta.style.height = 'auto';
      toast('Sent — Devin is working');
      pollJob(r.job);
    } catch (e) {
      toast(e.message, true);
      sendBtn.disabled = false;
      ta.disabled = false;
    }
  };
}

export function refreshLocal() {
  lstate.loaded = false;
  if (state.view === 'local') showLocal();
}
