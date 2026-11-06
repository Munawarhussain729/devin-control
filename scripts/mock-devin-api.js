'use strict';
/**
 * Mock Devin API — a zero-dependency stand-in for https://api.devin.ai v3,
 * used by `npm run demo`, the smoke test and the README screenshots.
 *
 * Everything here is invented: fake org, fake session ids, fake repos under
 * github.com/acme-inc. Point devin-control at it with
 *   DEVIN_API_BASE=http://127.0.0.1:8788
 *
 * Implements only what server.js proxies:
 *   GET    /v3/organizations/:org/sessions            (filters + pagination)
 *   POST   /v3/organizations/:org/sessions
 *   GET    /v3/organizations/:org/sessions/:id
 *   DELETE /v3/organizations/:org/sessions/:id
 *   GET    /v3/organizations/:org/sessions/:id/messages
 *   POST   /v3/organizations/:org/sessions/:id/messages
 *   GET    /v3/organizations/:org/sessions/:id/tags
 *   POST|PUT /v3/organizations/:org/sessions/:id/tags
 *   POST   /v3/organizations/:org/sessions/:id/archive
 *   POST   /v3/organizations/:org/sessions/:id/unarchive
 *   GET    /v3/organizations/:org/repositories
 */
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8788', 10);

// ---------- invented dataset ----------
const now = Math.floor(Date.now() / 1000);
const H = 3600;
const D = 86400;

const REPOS = [
  { repo_name: 'acme-web', repo_path: 'acme-inc/acme-web', repo_full_name: 'acme-inc/acme-web', repo_language: 'TypeScript', git_connection_host: 'github.com' },
  { repo_name: 'acme-api', repo_path: 'acme-inc/acme-api', repo_full_name: 'acme-inc/acme-api', repo_language: 'TypeScript', git_connection_host: 'github.com' },
  { repo_name: 'docs-site', repo_path: 'acme-inc/docs-site', repo_full_name: 'acme-inc/docs-site', repo_language: 'MDX', git_connection_host: 'github.com' },
  { repo_name: 'mobile-app', repo_path: 'acme-inc/mobile-app', repo_full_name: 'acme-inc/mobile-app', repo_language: 'TypeScript', git_connection_host: 'github.com' },
];

// [title, repo, status, status_detail, ageDays, acu, category, origin, mode, tags, prState, archived]
const SEED = [
  ['Fix race condition in checkout webhook handler', 'acme-api', 'running', 'working', 0.1, 4.2, 'bug_fixing', 'web', 'swe-2-high', ['backend', 'project:acme-api'], null, false],
  ['Add retry logic to the invoice email worker', 'acme-api', 'running', 'working', 0.2, 2.8, 'feature_development', 'web', 'normal', ['project:acme-api'], null, false],
  ['Upgrade eslint config across the frontend', 'acme-web', 'running', 'working', 0.4, 1.1, 'migrations_and_upgrades', 'web', 'fast', ['project:acme-web', 'lint'], null, false],
  ['Document the webhook retry policy', 'docs-site', 'running', 'waiting_for_user', 0.6, 0.9, 'documentation_and_content', 'web', 'normal', ['project:docs-site'], null, false],
  ['Dark-mode contrast pass on settings screens', 'mobile-app', 'running', 'waiting_for_user', 1, 3.4, 'code_quality_and_security', 'slack', 'swe-2-high', ['project:mobile-app', 'ui'], null, false],
  ['Bump the deployment action to Node 22', 'acme-api', 'running', 'waiting_for_approval', 1, 0.6, 'ci_cd_and_devops', 'web', 'normal', ['ci', 'project:acme-api'], null, false],
  ['Migrate onboarding flow to the new flags API', 'acme-web', 'running', 'finished', 2, 12.5, 'migrations_and_upgrades', 'web', 'swe-2-high', ['project:acme-web'], 'open', false],
  ['Add unit tests for the pricing calculator', 'acme-api', 'running', 'finished', 3, 6.7, 'unit_test_generation', 'api', 'swe-2-medium', ['tests', 'project:acme-api'], 'merged', false],
  ['Investigate 5xx spike on /v1/search', 'acme-api', 'running', 'finished', 4, 8.9, 'production_investigation', 'slack', 'swe-2-max', ['incident', 'project:acme-api'], 'merged', false],
  ['Refresh getting-started guide screenshots', 'docs-site', 'running', 'finished', 5, 2.3, 'documentation_and_content', 'web', 'lite', ['project:docs-site'], 'merged', false],
  ['Profile the push-notification fan-out job', 'acme-api', 'suspended', 'inactivity', 6, 5.1, 'refactoring_and_optimization', 'web', 'normal', ['project:acme-api'], 'open', false],
  ['Rework empty states on the dashboard', 'acme-web', 'suspended', 'user_request', 8, 7.4, 'feature_development', 'web', 'swe-2-high', ['ui', 'project:acme-web'], 'open', false],
  ['Spike: offline mode for field reports', 'mobile-app', 'suspended', 'inactivity', 11, 9.8, 'research_and_exploration', 'slack', 'normal', ['project:mobile-app'], null, false],
  ['Cache layer for the catalog endpoint', 'acme-api', 'suspended', 'inactivity', 14, 4.6, 'refactoring_and_optimization', 'web', 'swe-2-medium', ['project:acme-api'], 'closed', false],
  ['Fix broken anchor links in API reference', 'docs-site', 'suspended', 'user_request', 18, 1.5, 'bug_fixing', 'web', 'lite', ['project:docs-site'], 'merged', false],
  ['Extract shared form validation helpers', 'acme-web', 'exit', '', 21, 10.2, 'refactoring_and_optimization', 'web', 'swe-2-high', ['project:acme-web'], 'merged', false],
  ['Add pagination to the audit log endpoint', 'acme-api', 'exit', '', 26, 7.9, 'feature_development', 'api', 'normal', ['project:acme-api'], 'merged', false],
  ['Set up visual regression checks in CI', 'acme-web', 'exit', '', 32, 5.5, 'ci_cd_and_devops', 'web', 'swe-2-medium', ['ci', 'project:acme-web'], 'merged', false],
  ['Generate changelog from merged PRs', 'docs-site', 'exit', '', 40, 3.1, 'data_and_automation', 'api', 'normal', ['automation', 'project:docs-site'], 'merged', false],
  ['Bump react-native and fix deprecation warnings', 'mobile-app', 'exit', '', 48, 11.6, 'migrations_and_upgrades', 'web', 'swe-2-high', ['project:mobile-app'], 'merged', false],
  ['Write ADR for the event-bus decision', 'docs-site', 'exit', '', 58, 2.0, 'documentation_and_content', 'web', 'normal', ['project:docs-site'], null, false],
  ['Old experiment: prompt-length benchmarking', 'acme-api', 'exit', '', 66, 15.4, 'research_and_exploration', 'api', 'ultra', ['experiment'], null, true],
  ['Legacy password-reset email template', 'acme-web', 'exit', '', 72, 4.0, 'bug_fixing', 'slack', 'normal', ['project:acme-web'], 'merged', true],
  ['Abandoned: GraphQL gateway spike', 'acme-api', 'exit', '', 80, 21.3, 'research_and_exploration', 'web', 'fusion', ['spike'], 'closed', true],
  ['Archive test: stale session cleanup', 'mobile-app', 'exit', '', 88, 1.2, 'other', 'web', 'lite', [], null, true],
];

let counter = 0;
const sessions = SEED.map(([title, repo, status, status_detail, ageDays, acu, category, origin, devin_mode, tags, prState, archived]) => {
  const id = `devin-${crypto.randomBytes(8).toString('hex')}`;
  const created = now - Math.floor(ageDays * D);
  const prs = prState
    ? [{ pr_url: `https://github.com/acme-inc/${repo}/pull/${101 + counter}`, pr_state: prState }]
    : [];
  return {
    session_id: id,
    title,
    status,
    status_detail: status_detail || undefined,
    created_at: created,
    updated_at: created + Math.floor(ageDays * 400),
    acus_consumed: acu,
    on_demand_usage: acu > 15 ? +(acu * 0.4).toFixed(2) : undefined,
    is_archived: archived,
    tags,
    category,
    origin,
    devin_mode,
    pull_requests: prs,
    url: `https://app.devin.ai/sessions/${id}`,
    user_id: 'svc-demo-user',
    service_user_id: 'svc-demo-user',
    _repo: `acme-inc/${repo}`,
    _n: counter++,
  };
});

const MESSAGES = [
  { source: 'user', message: 'Please look into this and open a PR when it is ready.' },
  { source: 'devin', message: 'I scanned the repo and reproduced the issue locally. Drafting a fix now.' },
  { source: 'devin', message: 'Pushed a branch with the fix and opened a pull request. CI is green.' },
];

// ---------- helpers ----------
function send(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function pub(s) {
  const { _repo, _n, ...rest } = s;
  return rest;
}

function page(items, q, perCursor) {
  const first = Math.max(1, Math.min(200, parseInt(q.get('first'), 10) || 50));
  const start = perCursor(q.get('after'));
  const slice = items.slice(start, start + first);
  const hasNext = start + first < items.length;
  return {
    items: slice,
    total: items.length,
    has_next_page: hasNext,
    end_cursor: hasNext ? `cur_${start + first}` : null,
  };
}

const sessionCursor = (c) => (c && /^cur_\d+$/.test(c) ? parseInt(c.slice(4), 10) : 0);

function listSessions(q) {
  let items = sessions.slice().sort((a, b) => b.updated_at - a.updated_at);
  const arch = q.get('is_archived');
  if (arch === 'true') items = items.filter((s) => s.is_archived);
  else if (arch === 'false') items = items.filter((s) => !s.is_archived);
  const cat = q.get('category');
  if (cat) items = items.filter((s) => s.category === cat);
  const repoNames = q.getAll('repo_names');
  if (repoNames.length) items = items.filter((s) => repoNames.includes(s._repo));
  const wantTags = q.getAll('tags');
  if (wantTags.length) items = items.filter((s) => s.tags.some((t) => wantTags.includes(t)));
  const ids = q.getAll('session_ids');
  if (ids.length) items = items.filter((s) => ids.includes(s.session_id) || ids.includes(s.session_id.replace(/^devin-/, '')));
  const num = (k) => (/^\d+$/.test(q.get(k) || '') ? parseInt(q.get(k), 10) : null);
  const ca = num('created_after'), cb = num('created_before'), ua = num('updated_after');
  if (ca != null) items = items.filter((s) => s.created_at >= ca);
  if (cb != null) items = items.filter((s) => s.created_at <= cb);
  if (ua != null) items = items.filter((s) => s.updated_at >= ua);
  const p = page(items, q, sessionCursor);
  p.items = p.items.map(pub);
  return p;
}

function messagesFor(s, q) {
  const items = MESSAGES.map((m, i) => ({
    event_id: `${s.session_id}-ev${i}`,
    source: m.source,
    message: m.message,
    created_at: s.created_at + 60 * (i + 1),
    username: m.source === 'user' ? 'demo-user' : undefined,
  }));
  const p = page(items, q, sessionCursor);
  return p;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = req.method;
    const base = url.pathname.match(/^\/v3\/organizations\/([^/]+)(\/.*)?$/);
    if (!base) return send(res, 404, { detail: 'Not found' });
    const p = base[2] || '';
    const q = url.searchParams;

    if (p === '/repositories' && m === 'GET') {
      const out = page(REPOS, q, sessionCursor);
      return send(res, 200, out);
    }

    if (p === '/sessions' && m === 'GET') return send(res, 200, listSessions(q));
    if (p === '/sessions' && m === 'POST') {
      const b = await readBody(req);
      if (typeof b.prompt !== 'string' || !b.prompt.trim())
        return send(res, 400, { detail: 'prompt is required' });
      const id = `devin-${crypto.randomBytes(8).toString('hex')}`;
      const s = {
        session_id: id,
        title: (typeof b.title === 'string' && b.title.trim()) || b.prompt.slice(0, 80),
        status: 'running',
        status_detail: 'working',
        created_at: now,
        updated_at: now,
        acus_consumed: 0,
        is_archived: false,
        tags: Array.isArray(b.tags) ? b.tags : [],
        devin_mode: typeof b.devin_mode === 'string' ? b.devin_mode : undefined,
        pull_requests: [],
        url: `https://app.devin.ai/sessions/${id}`,
        _repo: Array.isArray(b.repos) && b.repos[0] ? b.repos[0] : '',
        _n: sessions.length,
      };
      sessions.unshift(s);
      return send(res, 200, pub(s));
    }

    const sm = p.match(/^\/sessions\/([^/]+)(?:\/(messages|archive|unarchive|tags))?$/);
    if (!sm) return send(res, 404, { detail: 'Not found' });
    const rawId = decodeURIComponent(sm[1]);
    const id = rawId.startsWith('devin-') ? rawId : `devin-${rawId}`;
    const s = sessions.find((x) => x.session_id === id);
    if (!s) return send(res, 404, { detail: 'Session not found' });
    const sub = sm[2];

    if (!sub && m === 'GET') return send(res, 200, pub(s));
    if (!sub && m === 'DELETE') {
      s.status = 'exit';
      s.status_detail = undefined;
      s.updated_at = now;
      if (q.get('archive') === 'true') s.is_archived = true;
      return send(res, 200, pub(s));
    }
    if (sub === 'messages' && m === 'GET') return send(res, 200, messagesFor(s, q));
    if (sub === 'messages' && m === 'POST') {
      s.status = 'running';
      if (!s.status_detail) s.status_detail = 'working';
      s.updated_at = now;
      return send(res, 200, pub(s));
    }
    if (sub === 'tags' && m === 'GET') return send(res, 200, { tags: s.tags });
    if (sub === 'tags' && (m === 'POST' || m === 'PUT')) {
      const b = await readBody(req);
      if (!Array.isArray(b.tags)) return send(res, 400, { detail: 'tags must be an array of strings' });
      s.tags = m === 'PUT' ? b.tags : [...new Set([...s.tags, ...b.tags])];
      return send(res, 200, { tags: s.tags });
    }
    if (sub === 'archive' && m === 'POST') {
      s.is_archived = true;
      if (s.status === 'running') s.status = 'suspended';
      return send(res, 200, pub(s));
    }
    if (sub === 'unarchive' && m === 'POST') {
      s.is_archived = false;
      return send(res, 200, pub(s));
    }
    return send(res, 405, { detail: 'Method not allowed' });
  } catch (e) {
    return send(res, 500, { detail: e.message });
  }
});

module.exports = server;

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Mock Devin API listening on http://127.0.0.1:${PORT}`);
    console.log(`Point devin-control at it with: DEVIN_API_BASE=http://127.0.0.1:${PORT}`);
  });
}
