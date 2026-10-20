'use strict';
/**
 * Devin Control — a tiny, dependency-free mobile control panel for Devin sessions.
 *
 * The browser never sees your Devin API key. It talks to this server, which:
 *   1. checks a password login (signed, HttpOnly cookie),
 *   2. forwards only a fixed whitelist of Devin v3 session endpoints.
 *
 * Requires Node 18+ (built-in fetch). No npm install needed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync; // Node 22.5+, experimental
} catch {}

// ---------- config ----------
function loadDotEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = (process.env.DEVIN_API_BASE || 'https://api.devin.ai').replace(/\/+$/, '');
const API_KEY = process.env.DEVIN_API_KEY || '';
const ORG_ID = process.env.DEVIN_ORG_ID || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_DAYS = 30;
// Where local state (projects.json) lives. Override for containers/hosts that
// mount a writable volume somewhere else.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
// Devin Desktop local session store (ACP). Override if your data lives elsewhere.
const LOCAL_DIR =
  process.env.DEVIN_DESKTOP_DIR || path.join(os.homedir(), 'Library/Application Support/Devin/User');
const LOCAL_STATE_DB = path.join(LOCAL_DIR, 'globalStorage', 'state.vscdb');
const LOCAL_ACP_DIR = path.join(LOCAL_DIR, 'acp-messages');
// Derive the cookie-signing secret from SESSION_SECRET, or (stable across restarts) from the password + key.
const SECRET = crypto
  .createHash('sha256')
  .update(process.env.SESSION_SECRET || `${APP_PASSWORD}|${API_KEY}|devin-control`)
  .digest();

const missing = [];
if (!API_KEY) missing.push('DEVIN_API_KEY');
if (!ORG_ID) missing.push('DEVIN_ORG_ID');
if (!APP_PASSWORD) missing.push('APP_PASSWORD');
if (missing.length) {
  console.error(`Missing required settings: ${missing.join(', ')}\nCopy .env.example to .env and fill them in.`);
  process.exit(1);
}
if (APP_PASSWORD.length < 8) {
  console.error('APP_PASSWORD must be at least 8 characters (this panel can spend your Devin quota).');
  process.exit(1);
}

// ---------- helpers ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const nonce = crypto.randomBytes(8).toString('base64url');
  const body = `${exp}.${nonce}`;
  return `${body}.${sign(body)}`;
}
function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = sign(body);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(parts[0]) > Date.now();
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}
function cookie(req, value, maxAgeSec) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) flags.push('Secure');
  return `dc_session=${value}; ${flags.join('; ')}`;
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function isAuthed(req) {
  return verifyToken(parseCookies(req).dc_session);
}

// Login rate limiting: 8 failures / 15 min per IP.
const fails = new Map();
function tooManyFails(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) {
    fails.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function noteFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) fails.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of fails) if (now - rec.first > 15 * 60 * 1000) fails.delete(ip);
}, 10 * 60 * 1000).unref();

function passwordOk(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Devin API proxy ----------
function devinId(raw) {
  const id = decodeURIComponent(raw || '');
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) return null;
  return id.startsWith('devin-') ? id : `devin-${id}`;
}

async function devin(method, apiPath, { query, body } = {}) {
  const url = new URL(`${API_BASE}/v3/organizations/${encodeURIComponent(ORG_ID)}${apiPath}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const MODES = new Set(['normal', 'fast', 'lite', 'ultra', 'fusion', 'swe-2-medium', 'swe-2-high', 'swe-2-max']);
const CATEGORIES = new Set([
  'bug_fixing', 'ci_cd_and_devops', 'code_quality_and_security', 'code_review', 'code_review_and_analysis',
  'data_and_automation', 'documentation_and_content', 'feature_development', 'migrations_and_upgrades',
  'other', 'production_investigation', 'refactoring_and_optimization', 'research_and_exploration',
  'security', 'unit_test_generation',
]);
const csvList = (v, max = 20, len = 120) =>
  String(v || '').split(',').map((x) => x.trim()).filter((x) => x && x.length <= len).slice(0, max);
const numOr = (v) => (/^\d+$/.test(String(v || '')) ? parseInt(v, 10) : undefined);

// ---------- analytics sync ----------
// Walk every page of the sessions list (live + archived) and hand the browser a
// compact payload it can slice locally. Cached briefly so flipping between
// dashboard tabs doesn't re-walk the whole history.
const MAX_SYNC_PAGES = 50; // 50 pages x 200 = 10k sessions per archive state
const sync = { at: 0, promise: null, data: null };

function slimSession(s) {
  return {
    id: s.session_id,
    title: s.title || '',
    st: s.status || '',
    sd: s.status_detail || '',
    ca: s.created_at || 0,
    ua: s.updated_at || 0,
    acu: typeof s.acus_consumed === 'number' ? s.acus_consumed : 0,
    od: typeof s.on_demand_usage === 'number' ? s.on_demand_usage : null,
    arch: !!s.is_archived,
    tags: Array.isArray(s.tags) ? s.tags.slice(0, 50) : [],
    cat: s.category || '',
    sub: s.subcategory || '',
    orig: s.origin || '',
    mode: s.devin_mode || '',
    prs: (Array.isArray(s.pull_requests) ? s.pull_requests : [])
      .map((p) => ({ u: p.pr_url || '', s: p.pr_state || '' }))
      .filter((p) => p.u),
    url: s.url || '',
    par: s.parent_session_id || '',
    nk: Array.isArray(s.child_session_ids) ? s.child_session_ids.length : 0,
    auto: s.automation_id || '',
    uid: s.user_id || '',
    su: s.service_user_id || '',
  };
}

async function fetchAllSessions(isArchived) {
  const items = [];
  let after = null;
  let total = null;
  for (let i = 0; i < MAX_SYNC_PAGES; i++) {
    const q = { first: 200, is_archived: isArchived };
    if (after) q.after = after;
    const r = await devin('GET', '/sessions', { query: q });
    if (r.status !== 200) {
      const e = new Error(`Devin API returned ${r.status}`);
      e.status = r.status === 429 ? 429 : 502;
      e.upstream = (r.text || '').slice(0, 300);
      throw e;
    }
    let d;
    try {
      d = JSON.parse(r.text || '{}');
    } catch {
      throw new Error('Bad JSON from Devin API');
    }
    items.push(...(d.items || []));
    if (typeof d.total === 'number') total = d.total;
    if (!d.has_next_page || !d.end_cursor) return { items, total, truncated: false };
    after = d.end_cursor;
  }
  return { items, total, truncated: true };
}

// Local IDE sessions adapted to the slim analytics shape. `st` is inferred from
// last activity — the transcript store doesn't track open/closed state, so a
// session touched in the last 15 min counts as working, everything else ended.
function localSlimSessions() {
  try {
    const d = listLocalSessions();
    if (!d.available) return [];
    const now = Date.now() / 1000;
    return d.items.map((s) => ({
      id: s.id,
      aid: s.aid || '',
      src: 'local',
      title: s.title || '',
      dir: s.cwd ? s.cwd.split('/').filter(Boolean).pop() : '',
      cwd: s.cwd || '',
      st: now - (s.ua || 0) < 900 ? 'running' : 'exit',
      sd: now - (s.ua || 0) < 900 ? 'working' : '',
      ca: s.ca || 0,
      ua: s.ua || 0,
      acu: 0,
      od: null,
      arch: false,
      tags: [],
      cat: '',
      sub: '',
      orig: 'ide',
      mode: s.mode || '',
      prs: [],
      url: '',
      par: '',
      nk: 0,
      msgs: s.msgs || 0,
      tools: s.tools || 0,
      umsgs: s.umsgs || 0,
    }));
  } catch {
    return [];
  }
}

async function runSync() {
  const [live, archived] = await Promise.all([fetchAllSessions(false), fetchAllSessions(true)]);
  const items = live.items.concat(archived.items).map(slimSession);
  const locals = localSlimSessions();
  return {
    fetched_at: Math.floor(Date.now() / 1000),
    truncated: live.truncated || archived.truncated,
    total: (live.total || 0) + (archived.total || 0),
    cloud: items.length,
    items: items.concat(locals),
  };
}

// ---------- projects (local file) ----------
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function readProjects() {
  try {
    const d = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(d.projects) ? d.projects : [];
  } catch {
    return [];
  }
}
function validProjects(list) {
  if (!Array.isArray(list) || list.length > 100) return null;
  const out = [];
  for (const p of list) {
    const name = String(p?.name || '').trim().slice(0, 60);
    const match = (Array.isArray(p?.match) ? p.match : [])
      .map((x) => String(x).trim().toLowerCase()).filter((x) => x && x.length <= 80).slice(0, 20);
    if (!name || !match.length) continue;
    const color = COLOR_RE.test(p?.color || '') ? p.color : undefined;
    out.push(color ? { name, match, color } : { name, match });
  }
  return out;
}
function writeProjects(projects) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2) + '\n', { mode: 0o600 });
}

// ---------- org repositories (for pickers; cached) ----------
const reposCache = { at: 0, data: null };
async function loadRepos() {
  if (reposCache.data && Date.now() - reposCache.at < 10 * 60 * 1000) return reposCache.data;
  const items = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const q = { first: 100, load_indexing_status: 'false' };
    if (after) q.after = after;
    const r = await devin('GET', '/repositories', { query: q });
    if (r.status !== 200) {
      const e = new Error(`Devin API returned ${r.status}`);
      e.status = r.status === 429 ? 429 : 502;
      throw e;
    }
    const d = JSON.parse(r.text || '{}');
    items.push(...(d.items || []));
    if (!d.has_next_page || !d.end_cursor) break;
    after = d.end_cursor;
  }
  const repos = items.map((r) => ({
    name: r.repo_name || '',
    path: r.repo_path || '',
    full: r.repo_full_name || r.repo_path || '',
    lang: r.repo_language || '',
    host: r.git_connection_host || '',
  }));
  reposCache.at = Date.now();
  reposCache.data = { items: repos };
  return reposCache.data;
}

// ---------- local Devin Desktop sessions ----------
// Sessions created in Devin Desktop / CLI live on disk, not in the cloud API.
// Index: globalStorage/state.vscdb -> ItemTable keys 'windsurf.acp.sessioninfo.<uuid>'
// Transcript: acp-messages/<uuid>.db (meta + messages tables).

const LOCAL_UUID_RE = /^[0-9a-fA-F-]{32,40}$/;
const localIndex = { at: 0, data: null };

function openLocalDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return db;
}

function readAcpMeta(id) {
  const file = path.join(LOCAL_ACP_DIR, `${id}.db`);
  if (!fs.existsSync(file)) return null;
  try {
    const db = openLocalDb(file);
    try {
      const meta = {};
      for (const r of db.prepare('SELECT key, value FROM meta').all()) meta[r.key] = r.value;
      const kinds = {};
      for (const r of db.prepare('SELECT kind, count(*) c FROM messages GROUP BY kind').all()) kinds[r.kind] = r.c;
      let mode = '';
      let title = '';
      try {
        const info = JSON.parse(meta.info || '{}');
        title = info.title || '';
        const modeOpt = (info.configOptions || []).find((o) => o.id === 'mode' || o.category === 'mode');
        mode = modeOpt?.currentValue || '';
      } catch {}
      return { msgs: Number(meta.message_count) || 0, kinds, mode, title, truncated: meta.truncated === '1' };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function listLocalSessions() {
  if (!DatabaseSync || !fs.existsSync(LOCAL_STATE_DB))
    return { available: false, items: [] };
  if (localIndex.data && Date.now() - localIndex.at < 30000) return localIndex.data;
  const items = [];
  const db = openLocalDb(LOCAL_STATE_DB);
  try {
    // Key families in state.vscdb (see header comment):
    //   sessioninfo.session.<uuid>            -> {info:{title,cwd,updatedAt}} (older format)
    //   sessioninfo.session.acp/devin-cli/<n> -> stub {info:{sessionId}} (newer format)
    //   messageStore.session.<aid>            -> {uuid, lastUpdated}  aid -> transcript db file
    //   sessionWorkspace/<aid>                -> {workspaceId,label,lastUpdated}  aid -> cwd
    //   session/session_start_time/<aid>      -> ISO string
    //   session/userMessageCount/<aid>        -> integer
    const get = (prefix) => {
      const m = new Map();
      const rows = db
        .prepare("SELECT key, value FROM ItemTable WHERE key LIKE ? ESCAPE '\\'")
        .all(prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
      for (const r of rows) {
        try {
          m.set(r.key.slice(prefix.length), JSON.parse(r.value));
        } catch {}
      }
      return m;
    };
    const infoRecs = get('windsurf.acp.sessioninfo.session.');
    const aidToUuid = get('windsurf.acp.messageStore.session.');
    const aidToWs = get('windsurfSpace.sessionWorkspace/');
    const aidStart = get('windsurf.acp.session/session_start_time/');
    const aidUMsg = get('windsurf.acp.session/userMessageCount/');

    const uuidToAid = new Map();
    for (const [aid, v] of aidToUuid) if (v?.uuid) uuidToAid.set(v.uuid, aid);

    const seen = new Set();
    const push = (id, aid, o) => {
      if (seen.has(id)) return;
      seen.add(id);
      items.push({ id, aid, provider: 'devin-cli', ...o });
    };

    // aid-keyed sessions (current format)
    const aids = new Set([...aidToUuid.keys(), ...aidToWs.keys(), ...aidStart.keys()]);
    const aidStubs = new Map();
    for (const [k, v] of infoRecs) {
      if (!k.startsWith('acp/')) continue;
      aids.add(k);
      aidStubs.set(k, v);
      infoRecs.delete(k);
    }
    for (const aid of aids) {
      const uuid = aidToUuid.get(aid)?.uuid || '';
      const file = uuid ? path.join(LOCAL_ACP_DIR, `${uuid}.db`) : '';
      const stat = file && fs.existsSync(file) ? fs.statSync(file) : null;
      const meta = stat ? readAcpMeta(uuid) : null;
      const ws = aidToWs.get(aid) || {};
      const stub = aidStubs.get(aid)?.info || aidStubs.get(aid) || {};
      const lastUp = Math.max(
        aidToUuid.get(aid)?.lastUpdated || 0,
        ws.lastUpdated || 0,
        stat?.mtimeMs || 0
      );
      const short = aid.split('/').pop() || aid;
      push(uuid || aid, aid, {
        title: meta?.title || stub.title || short,
        cwd: ws.workspaceId || stub.cwd || '',
        ca: Math.floor(Date.parse(aidStart.get(aid) || '') / 1000) || Math.floor((stat?.birthtimeMs || 0) / 1000),
        ua: Math.floor(lastUp / 1000),
        msgs: meta?.msgs || 0,
        tools: meta?.kinds?.tool_call || 0,
        umsgs: Number(aidUMsg.get(aid)) || meta?.kinds?.user_message || 0,
        mode: meta?.mode || '',
        trunc: meta?.truncated || false,
      });
    }

    // uuid-era records + orphan transcript dbs not claimed by any aid
    const uuidRecs = new Map([...infoRecs].filter(([k]) => LOCAL_UUID_RE.test(k)));
    if (fs.existsSync(LOCAL_ACP_DIR)) {
      for (const f of fs.readdirSync(LOCAL_ACP_DIR)) {
        const uuid = f.replace(/\.db$/, '');
        if (f.endsWith('.db') && LOCAL_UUID_RE.test(uuid) && !uuidToAid.has(uuid))
          uuidRecs.set(uuid, uuidRecs.get(uuid) || null);
      }
    }
    for (const [uuid, rec] of uuidRecs) {
      const info = rec?.info || {};
      const file = path.join(LOCAL_ACP_DIR, `${uuid}.db`);
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      const meta = stat ? readAcpMeta(uuid) : null;
      push(uuid, uuidToAid.get(uuid) || '', {
        title: meta?.title || info.title || 'Untitled session',
        cwd: info.cwd || '',
        ca: Math.floor(Date.parse(info.createdAt || info._meta?.['cognition.ai/createdAt'] || '') / 1000) || Math.floor((stat?.birthtimeMs || 0) / 1000),
        ua: Math.floor(Date.parse(info.updatedAt || '') / 1000) || Math.floor((stat?.mtimeMs || 0) / 1000),
        msgs: meta?.msgs || 0,
        tools: meta?.kinds?.tool_call || 0,
        umsgs: meta?.kinds?.user_message || 0,
        mode: meta?.mode || '',
        trunc: meta?.truncated || false,
      });
    }
  } finally {
    db.close();
  }
  const cliIds = cliSessionIds();
  for (const it of items)
    it.resumable = !!it.cwd && cliIds.has((it.aid || it.id).split('/').pop());
  items.sort((a, b) => b.ua - a.ua);
  localIndex.at = Date.now();
  localIndex.data = { available: true, items };
  return localIndex.data;
}

// ---------- local prompt jobs ----------
// POST /api/local/sessions/:id/prompt spawns `devin acp` (Agent Client Protocol
// over stdio), authenticates with the session token from the CLI credentials
// file, loads the session and sends the prompt. session/update notifications
// stream into the job's live message list, which the UI polls.
const localJobs = new Map(); // jobId -> {status, out, msgs, started, sessionId, exit, child}
const localRunning = new Map(); // sessionId -> jobId
let cliIdsCache = { at: 0, ids: new Set() };

// Sessions resumable via `devin acp` session/load — only the friendly-name
// sessions the CLI knows about (sessions.db). Older uuid-era transcripts and
// IDE sessions never registered with the CLI can't be loaded.
function cliSessionIds() {
  if (Date.now() - cliIdsCache.at < 60000) return cliIdsCache.ids;
  const ids = new Set();
  try {
    const f = path.join(os.homedir(), '.local/share/devin/cli/sessions.db');
    if (DatabaseSync && fs.existsSync(f)) {
      const db = openLocalDb(f);
      try {
        for (const r of db.prepare('SELECT id FROM sessions').all()) ids.add(String(r.id));
      } finally {
        db.close();
      }
    }
  } catch {}
  cliIdsCache = { at: Date.now(), ids };
  return ids;
}
const PROMPT_MODES = new Set(['auto', 'accept-edits', 'smart', 'dangerous', 'bypass', 'autonomous']);
const JOB_MAX_AGE = 30 * 60 * 1000;
const CREDS_FILE = path.join(os.homedir(), '.local/share/devin/credentials.toml');

function findLocalSession(id) {
  const d = listLocalSessions();
  return (d.items || []).find((s) => s.id === id || s.aid === id) || null;
}

function devinSessionToken() {
  try {
    const t = fs.readFileSync(CREDS_FILE, 'utf8');
    const m = t.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// Fold one ACP session/update notification into the job's live message list.
function acpUpdate(job, msg) {
  if (msg.method !== 'session/update') return;
  const u = msg.params && msg.params.update;
  if (!u) return;
  const t = u.sessionUpdate;
  const last = job.msgs[job.msgs.length - 1];
  const appendDelta = (kind) => {
    const text = u.content && u.content.text;
    if (typeof text !== 'string' || !text) return;
    if (last && last.kind === kind) last.text += text;
    else job.msgs.push({ kind, text });
  };
  if (t === 'agent_message_chunk') appendDelta('agent');
  else if (t === 'agent_thought_chunk') appendDelta('thought');
  else if (t === 'user_message_chunk') appendDelta('user');
  else if (t === 'tool_call') {
    job.toolIdx = job.toolIdx || {};
    job.toolIdx[u.toolCallId] = job.msgs.length;
    job.msgs.push({ kind: 'tool', title: String(u.title || 'tool call').slice(0, 300), tool: u.kind || '', status: u.status || '' });
  } else if (t === 'tool_call_update') {
    const i = job.toolIdx && job.toolIdx[u.toolCallId];
    if (i != null && job.msgs[i]) job.msgs[i].status = u.status || job.msgs[i].status;
  } else if (t === 'plan') {
    const entries = (Array.isArray(u.entries) ? u.entries : [])
      .map((e) => `[${e.status || ' '}] ${e.content || e.title || ''}`)
      .join('\n');
    job.msgs.push({ kind: 'plan', text: entries.slice(0, 20000) });
  }
  if (job.msgs.length > 400) job.msgs.splice(0, job.msgs.length - 400);
}

function startLocalPrompt(session, prompt, mode) {
  if (localRunning.has(session.id))
    return { error: 'A prompt is already running for this session', status: 409 };
  const token = devinSessionToken();
  if (!token)
    return {
      error: 'No Devin session token found. Run `devin auth login` in a terminal first.',
      status: 400,
    };
  const resume = session.aid ? session.aid.split('/').pop() : session.id;
  if (!resume || !session.cwd || !fs.existsSync(session.cwd))
    return { error: 'Session has no resumable project directory', status: 400 };
  if (!cliSessionIds().has(resume))
    return {
      error:
        'This session cannot be resumed — it is not in the Devin CLI session store (only sessions managed by Devin Desktop can receive prompts).',
      status: 400,
    };

  let child;
  try {
    child = spawn('devin', ['acp'], { cwd: session.cwd, env: process.env });
  } catch (e) {
    return { error: `Could not start devin acp: ${e.message}`, status: 500 };
  }
  const jobId = crypto.randomBytes(6).toString('hex');
  const job = { status: 'running', out: '', msgs: [], started: Date.now(), sessionId: session.id, exit: null, child };
  localJobs.set(jobId, job);
  localRunning.set(session.id, jobId);

  const finish = (status, exit) => {
    job.status = status;
    job.exit = exit;
    localRunning.delete(session.id);
    try { child.kill(); } catch {}
  };
  const pend = new Map();
  let nextId = 1;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id != null && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      } else {
        acpUpdate(job, m);
      }
    }
  });
  child.stderr.on('data', (d) => {
    job.out = (job.out + d.toString()).slice(-60000);
  });
  child.on('error', (e) => {
    job.out += `\n${e.message}`;
    if (job.status === 'running') finish('error', 1);
  });
  child.on('close', (code) => {
    if (job.status === 'running') finish('error', code);
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pend.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pend.delete(id)) resolve({ error: { message: 'ACP request timed out' } });
      }, 60000);
    });
  const errText = (r) => (r && r.error && (r.error.message || JSON.stringify(r.error))) || '';

  (async () => {
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (init.error) throw new Error(`initialize failed: ${errText(init)}`);
    const auth = await call('authenticate', { methodId: 'devin-browser', _meta: { apiKey: token } });
    if (auth.error)
      throw new Error(`authentication failed: ${errText(auth)} — try \`devin auth logout && devin auth login\``);
    const load = await call('session/load', { sessionId: resume, cwd: session.cwd, mcpServers: [] });
    if (load.error) {
      const kind = load.error.data && load.error.data['cognition.ai/errorKind'];
      if (kind === 'session_locked')
        throw new Error('This session is open in Devin Desktop — close it there first, or send the prompt inside the app.');
      throw new Error(`could not resume session: ${errText(load)}`);
    }
    if (mode && PROMPT_MODES.has(mode))
      await call('session/set_mode', { sessionId: resume, modeId: mode }).catch(() => {});
    const pr = await call('session/prompt', {
      sessionId: resume,
      prompt: [{ type: 'text', text: prompt }],
    });
    if (pr.error) throw new Error(`prompt failed: ${errText(pr)}`);
    finish('done', 0);
  })().catch((e) => {
    job.out += `\n${e.message}`;
    finish('error', 1);
  });

  setTimeout(() => {
    if (job.status === 'running') finish('error', 124);
  }, JOB_MAX_AGE).unref();
  return { job: jobId };
}

function chunkText(p) {
  const c = p?.content;
  if (Array.isArray(c)) return c.map((x) => x?.content?.text || '').join('');
  return typeof c === 'string' ? c : '';
}

function localTranscript(id) {
  if (!LOCAL_UUID_RE.test(id)) return null;
  const file = path.join(LOCAL_ACP_DIR, `${id}.db`);
  if (!fs.existsSync(file)) return null;
  const db = openLocalDb(file);
  try {
    const meta = {};
    for (const r of db.prepare('SELECT key, value FROM meta').all()) meta[r.key] = r.value;
    let info = {};
    try {
      info = JSON.parse(meta.info || '{}');
    } catch {}
    const msgs = [];
    for (const r of db.prepare('SELECT position, kind, payload FROM messages ORDER BY position').all()) {
      let p;
      try {
        p = JSON.parse(r.payload);
      } catch {
        continue;
      }
      if (r.kind === 'user_message' || r.kind === 'agent_message' || r.kind === 'agent_thought') {
        const text = chunkText(p).slice(0, 50000);
        if (text.trim())
          msgs.push({
            pos: r.position,
            kind: r.kind === 'user_message' ? 'user' : r.kind === 'agent_thought' ? 'thought' : 'agent',
            text,
          });
      } else if (r.kind === 'tool_call') {
        const c = p.content || {};
        msgs.push({
          pos: r.position,
          kind: 'tool',
          title: String(c.title || 'tool call').slice(0, 300),
          tool: c.kind || '',
          status: c.status || '',
        });
      } else if (r.kind === 'plan') {
        const entries = (Array.isArray(p.content?.entries) ? p.content.entries : [])
          .map((e) => `[${e.status || ' '}] ${e.content || e.title || ''}`)
          .join('\n')
          .slice(0, 20000);
        msgs.push({ pos: r.position, kind: 'plan', text: entries });
      }
    }
    return { title: info.title || '', mode: (info.configOptions || []).find((o) => o.category === 'mode')?.currentValue || '', msgs };
  } finally {
    db.close();
  }
}

// gzip large JSON payloads (analytics can be a few MB)
function sendJson(req, res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
    });
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = url.searchParams;

  // Mutating requests must carry our custom header (blocks cross-site form posts).
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'devin-control') {
    return send(res, 403, { detail: 'Missing X-Requested-With header' });
  }

  // Local endpoints (not simple proxies).
  if (p === '/api/analytics' && m === 'GET') {
    try {
      if (!sync.data || Date.now() - sync.at > 60000 || q.get('refresh') === '1') {
        if (!sync.promise) {
          sync.promise = runSync()
            .then((d) => { sync.data = d; sync.at = Date.now(); })
            .finally(() => { sync.promise = null; });
        }
        await sync.promise;
      }
      return sendJson(req, res, 200, sync.data);
    } catch (e) {
      const detail = e.upstream ? `${e.message}: ${e.upstream}` : e.message;
      return send(res, e.status || 502, { detail });
    }
  }
  if (p === '/api/repos' && m === 'GET') {
    try {
      return send(res, 200, await loadRepos());
    } catch (e) {
      return send(res, e.status || 502, { detail: e.message });
    }
  }
  if (p === '/api/local/sessions' && m === 'GET') {
    try {
      return sendJson(req, res, 200, listLocalSessions());
    } catch (e) {
      return send(res, 500, { detail: `Local read failed: ${e.message}` });
    }
  }
  const lm = p.match(/^\/api\/local\/sessions\/([^/]+)$/);
  if (lm && m === 'GET') {
    try {
      const t = localTranscript(decodeURIComponent(lm[1]));
      if (!t) return send(res, 404, { detail: 'Local session not found' });
      return sendJson(req, res, 200, t);
    } catch (e) {
      return send(res, 500, { detail: `Local read failed: ${e.message}` });
    }
  }
  const lp = p.match(/^\/api\/local\/sessions\/([^/]+)\/prompt$/);
  if (lp && m === 'POST') {
    try {
      const id = decodeURIComponent(lp[1]);
      const b = await readBody(req);
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return send(res, 400, { detail: 'prompt is required' });
      if (prompt.length > 20000) return send(res, 400, { detail: 'prompt too long (max 20k chars)' });
      const session = findLocalSession(id);
      if (!session) return send(res, 404, { detail: 'Local session not found' });
      const r = startLocalPrompt(session, prompt, typeof b.mode === 'string' ? b.mode : '');
      if (r.error) return send(res, r.status || 500, { detail: r.error });
      return send(res, 200, r);
    } catch (e) {
      return send(res, 500, { detail: `Local prompt failed: ${e.message}` });
    }
  }
  const lj = p.match(/^\/api\/local\/jobs\/([a-f0-9]{12})$/);
  if (lj && m === 'GET') {
    const job = localJobs.get(lj[1]);
    if (!job) return send(res, 404, { detail: 'Job not found' });
    return sendJson(req, res, 200, {
      status: job.status,
      exit: job.exit,
      out: job.out.slice(-4000),
      msgs: job.msgs.slice(-200),
    });
  }
  if (p === '/api/projects') {
    if (m === 'GET') return send(res, 200, { projects: readProjects() });
    if (m === 'POST') {
      const b = await readBody(req);
      const projects = validProjects(b.projects);
      if (!projects) return send(res, 400, { detail: 'Invalid projects payload (max 100; each needs name + match[])' });
      try {
        writeProjects(projects);
      } catch (e) {
        return send(res, 500, { detail: `Could not write projects.json: ${e.message}` });
      }
      return send(res, 200, { projects });
    }
    return send(res, 405, { detail: 'Method not allowed' });
  }

  let out;
  // GET /api/sessions
  if (p === '/api/sessions' && m === 'GET') {
    const cat = q.get('category');
    out = await devin('GET', '/sessions', {
      query: {
        first: clampInt(q.get('first'), 1, 200, 50),
        after: q.get('after'),
        is_archived: q.get('is_archived') === 'true' ? 'true' : q.get('is_archived') === 'false' ? 'false' : undefined,
        created_after: numOr(q.get('created_after')),
        created_before: numOr(q.get('created_before')),
        updated_after: numOr(q.get('updated_after')),
        category: cat && CATEGORIES.has(cat) ? cat : undefined,
        repo_names: csvList(q.get('repo_names'), 20, 200),
        tags: csvList(q.get('tags'), 50, 60),
        session_ids: csvList(q.get('session_ids'), 50, 128),
      },
    });
  }
  // POST /api/sessions
  else if (p === '/api/sessions' && m === 'POST') {
    const b = await readBody(req);
    const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    if (!prompt) return send(res, 400, { detail: 'prompt is required' });
    const payload = { prompt };
    if (typeof b.title === 'string' && b.title.trim()) payload.title = b.title.trim().slice(0, 200);
    if (Array.isArray(b.repos)) {
      const repos = b.repos.map((r) => String(r).trim()).filter(Boolean).slice(0, 20);
      if (repos.length) payload.repos = repos;
    }
    if (Array.isArray(b.tags)) {
      const tags = b.tags.map((t) => String(t).trim()).filter((t) => t && t.length <= 50).slice(0, 50);
      if (tags.length) payload.tags = tags;
    }
    if (typeof b.devin_mode === 'string' && MODES.has(b.devin_mode)) payload.devin_mode = b.devin_mode;
    if (Number.isInteger(b.max_acu_limit) && b.max_acu_limit > 0) payload.max_acu_limit = b.max_acu_limit;
    out = await devin('POST', '/sessions', { body: payload });
  } else {
    // /api/sessions/:id[/messages|/archive|/unarchive|/tags]
    const mm = p.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|archive|unarchive|tags))?$/);
    if (!mm) return send(res, 404, { detail: 'Not found' });
    const id = devinId(mm[1]);
    if (!id) return send(res, 400, { detail: 'Bad session id' });
    const sub = mm[2];

    if (!sub && m === 'GET') out = await devin('GET', `/sessions/${id}`);
    else if (!sub && m === 'DELETE')
      out = await devin('DELETE', `/sessions/${id}`, { query: { archive: q.get('archive') === 'true' ? 'true' : undefined } });
    else if (sub === 'messages' && m === 'GET')
      out = await devin('GET', `/sessions/${id}/messages`, {
        query: { first: clampInt(q.get('first'), 1, 200, 200), after: q.get('after') },
      });
    else if (sub === 'messages' && m === 'POST') {
      const b = await readBody(req);
      const message = typeof b.message === 'string' ? b.message.trim() : '';
      if (!message) return send(res, 400, { detail: 'message is required' });
      out = await devin('POST', `/sessions/${id}/messages`, { body: { message } });
    } else if (sub === 'tags' && m === 'GET') out = await devin('GET', `/sessions/${id}/tags`);
    else if (sub === 'tags' && (m === 'POST' || m === 'PUT')) {
      const b = await readBody(req);
      const tags = Array.isArray(b.tags)
        ? b.tags.map((t) => String(t).trim()).filter((t) => t && t.length <= 50).slice(0, 50)
        : null;
      if (!tags) return send(res, 400, { detail: 'tags must be an array of strings' });
      out = await devin(m, `/sessions/${id}/tags`, { body: { tags } });
    } else if (sub === 'archive' && m === 'POST') out = await devin('POST', `/sessions/${id}/archive`);
    else if (sub === 'unarchive' && m === 'POST') out = await devin('POST', `/sessions/${id}/unarchive`);
    else return send(res, 405, { detail: 'Method not allowed' });
  }

  res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(out.text || '{}');
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || file.endsWith('sw.js') || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, { ok: true });

    if (p === '/auth/login' && req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'devin-control') return send(res, 403, { detail: 'Forbidden' });
      const ip = clientIp(req);
      if (tooManyFails(ip)) return send(res, 429, { detail: 'Too many attempts. Try again in 15 minutes.' });
      const b = await readBody(req, 4096);
      if (!passwordOk(b.password)) {
        noteFail(ip);
        return send(res, 401, { detail: 'Wrong password' });
      }
      fails.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeToken(), SESSION_DAYS * 86400) });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (p === '/auth/me') {
      return isAuthed(req) ? send(res, 200, { ok: true }) : send(res, 401, { detail: 'Not signed in' });
    }

    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) return send(res, 401, { detail: 'Not signed in' });
      return await handleApi(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || (e.name === 'AbortError' ? 504 : 502);
    const detail = e.name === 'AbortError' ? 'Devin API timed out' : e.status ? e.message : `Upstream error: ${e.message}`;
    if (!res.headersSent) send(res, status, { detail });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Devin Control running on http://${HOST}:${PORT}  (org ${ORG_ID})`);
});
