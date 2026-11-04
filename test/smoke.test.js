'use strict';
/**
 * Smoke test: boots server.js against the bundled mock Devin API on random
 * ports and checks auth, proxying, analytics and the ENABLE_LOCAL gate.
 * Zero dependencies — built-in node:test + fetch only.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const mock = require('../scripts/mock-devin-api');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'test-password-123';

let mockPort;
let appPort;
let child;
let dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${appPort}${p}`, opts);

const login = (password) =>
  api('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'devin-control' },
    body: JSON.stringify({ password }),
  });

before(async () => {
  mockPort = await freePort();
  appPort = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-control-test-'));
  await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      DEVIN_API_BASE: `http://127.0.0.1:${mockPort}`,
      DEVIN_API_KEY: 'cog_test_key_not_real',
      DEVIN_ORG_ID: 'test-org',
      APP_PASSWORD: PASSWORD,
      PORT: String(appPort),
      DATA_DIR: dataDir,
      ENABLE_LOCAL: '',
    },
    stdio: 'ignore',
  });
  await waitFor(`http://127.0.0.1:${appPort}/healthz`);
});

after(() => {
  child?.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /healthz returns 200', async () => {
  const r = await api('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('unauthenticated /api/sessions returns 401', async () => {
  const r = await api('/api/sessions');
  assert.equal(r.status, 401);
});

test('login with wrong password returns 401', async () => {
  const r = await login('definitely-wrong');
  assert.equal(r.status, 401);
});

test('login sets an HttpOnly, SameSite=Strict cookie and advertises features', async () => {
  const r = await login(PASSWORD);
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie') || '';
  assert.match(cookie, /dc_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const body = await r.json();
  assert.equal(body.features?.local, false);
});

async function authed() {
  const r = await login(PASSWORD);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { headers: { Cookie: cookie } };
}

test('/api/analytics returns the expected shape with mock data', async () => {
  const { headers } = await authed();
  const r = await api('/api/analytics', { headers });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(typeof d.fetched_at, 'number');
  assert.equal(typeof d.total, 'number');
  assert.ok(Array.isArray(d.items));
  assert.ok(d.items.length > 0);
  const s = d.items[0];
  assert.ok(s.id && typeof s.st === 'string' && typeof s.acu === 'number');
});

test('/api/sessions proxies the mock list once authenticated', async () => {
  const { headers } = await authed();
  const r = await api('/api/sessions?first=5&is_archived=false', { headers });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.items));
  assert.equal(d.items.length, 5);
  assert.ok(d.items.every((s) => !s.is_archived));
});

test('/api/local/sessions returns 404 when ENABLE_LOCAL is unset', async () => {
  const { headers } = await authed();
  const r = await api('/api/local/sessions', { headers });
  assert.equal(r.status, 404);
  const d = await r.json();
  assert.match(d.detail, /ENABLE_LOCAL=1/);
});

test('server refuses to start when APP_PASSWORD is shorter than 8 characters', async () => {
  const port = await freePort();
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        DEVIN_API_KEY: 'cog_test_key_not_real',
        DEVIN_ORG_ID: 'test-org',
        APP_PASSWORD: 'short',
        PORT: String(port),
      },
    });
    let buf = '';
    c.stderr.on('data', (d) => (buf += d));
    c.on('exit', (code) => resolve({ code, err: buf }));
  });
  assert.notEqual(out.code, 0);
  assert.match(out.err, /APP_PASSWORD must be at least 8/);
});
