'use strict';
/**
 * `npm run demo` — starts the mock Devin API and devin-control together with
 * invented demo data. No real credentials needed. Ctrl+C stops both.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-devin-api');

const MOCK_PORT = parseInt(process.env.MOCK_PORT || '8788', 10);
const APP_PORT = parseInt(process.env.PORT || '8787', 10);
const APP_PASSWORD = process.env.APP_PASSWORD || 'demo-password';

mock.listen(MOCK_PORT, '127.0.0.1', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-control-demo-'));
  // Seed project rules matching the mock data so the Projects view has content.
  fs.writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify(
      {
        projects: [
          { name: 'acme-web', match: ['project:acme-web', 'acme-inc/acme-web'], color: '#7c5cff' },
          { name: 'acme-api', match: ['project:acme-api', 'acme-inc/acme-api'], color: '#ff7a59' },
          { name: 'docs-site', match: ['project:docs-site', 'acme-inc/docs-site'], color: '#2fb8a3' },
          { name: 'mobile-app', match: ['project:mobile-app', 'acme-inc/mobile-app'], color: '#e6a23c' },
        ],
      },
      null,
      2
    )
  );
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DEVIN_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      DEVIN_API_KEY: 'cog_demo_key_not_real',
      DEVIN_ORG_ID: 'demo-org',
      APP_PASSWORD,
      PORT: String(APP_PORT),
      DATA_DIR: dataDir,
    },
    stdio: 'inherit',
  });
  console.log(`Mock Devin API: http://127.0.0.1:${MOCK_PORT}`);
  console.log(`Open http://localhost:${APP_PORT} — password: ${APP_PASSWORD}`);
  child.on('exit', (code) => process.exit(code ?? 0));
});
