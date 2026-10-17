// N6 Scenario C — the real launcher, once, on this Mac (docs/Nidum Local/Plan/N6 End-to-end verification.md, D36).
//
//   NIDUM_E2E_REAL=1 npm run test:e2e
//   NIDUM_E2E_REAL=1 NIDUM_E2E_KEEP=1 NIDUM_E2E=1 node --test test/e2e/scenario-c.test.js
//        (keeps the dashboard running for NIDUM_E2E_KEEP_SECONDS, default 600, so the orchestrator
//         can open it; a detached watchdog then quits it through /api/quit and removes the temp dirs)
//
// Gated behind NIDUM_E2E_REAL=1: it runs `Nidum Local.command` for real (via /bin/bash) against the
// real startup service on :80, with NIDUM_HOME=<temp>, NIDUM_READ_ONLY=1, no PORTLESS_* variables,
// and a PATH where only `open`/`xdg-open` are recording stubs; `portless` is a recording
// passthrough that refuses anything but --version/--help/list/doctor/get; `sudo`/`osascript` stubs
// refuse and record. node, curl and the real Portless (for --version) are used as they are.
// NIDUM_NO_MENUBAR=1 keeps the menu bar app out of it (Scenario A step 8d covers that step).
// The launcher must detect the service, start no proxy, start the server and "open" the token URL.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { haveChrome, launchChrome } from '../helpers/chrome.js';
import {
  E2E, REAL, TOKEN_URL_RE, addrRow, api, assertGuard, cleanEnv, goTab, health, makeStubBin, offOrigin, openDashboard,
  pidAlive, readSession, request, runLauncher, saveAsset, saveShot, sleep, tempDir, unexpectedErrors, waitSel, waitUntil,
} from './n6-helpers.js';

const SKIP = !E2E ? 'set NIDUM_E2E=1 (npm run test:e2e)'
  : !REAL ? 'real-machine scenario: set NIDUM_E2E_REAL=1 (only on the Mac with the real Portless service)'
    : !haveChrome() ? 'Google Chrome not found (set NIDUM_CHROME)' : false;
const KEEP = process.env.NIDUM_E2E_KEEP === '1';
const KEEP_SECONDS = Math.min(Math.max(Number(process.env.NIDUM_E2E_KEEP_SECONDS) || 600, 10), 600);
const PORTLESS_DIR = join(homedir(), '.portless');
const readReal = (f) => readFileSync(join(PORTLESS_DIR, f), 'utf8');

// Detached watchdog for KEEP mode: after N seconds, quit the dashboard named by session.json
// (only if /api/health answers for that pid), SIGTERM it if it is still alive, then remove the
// two temp dirs (only paths inside the system temp dir with the N6 prefixes).
const WATCHDOG_JS = `
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const [home, bin, secs] = process.argv.slice(1);
const inTmp = (p, pre) => path.dirname(fs.realpathSync(p)) === fs.realpathSync(os.tmpdir()) && path.basename(p).startsWith(pre);
const req = (port, method, p, headers) => new Promise((res) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 3000 }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => res({ s: x.statusCode, b })); });
  r.on('error', () => res(null)); r.on('timeout', () => r.destroy()); if (method === 'POST') r.end('{}'); else r.end();
});
setTimeout(async () => {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(home, 'session.json'), 'utf8')); } catch {}
  if (s) {
    const h = await req(s.port, 'GET', '/api/health', {});
    let ok = false; try { ok = h && JSON.parse(h.b).pid === s.pid; } catch {}
    if (ok) await req(s.port, 'POST', '/api/quit', { 'x-nidum-token': s.token, 'content-type': 'application/json' });
    await new Promise((r) => setTimeout(r, 3000));
    if (ok) { try { process.kill(s.pid, 0); process.kill(s.pid, 'SIGTERM'); } catch {} }
  }
  for (const [d, pre] of [[home, 'nidum-n6-c-'], [bin, 'nidum-n6-bin-']]) {
    try { if (inTmp(d, pre)) fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  process.exit(0);
}, Number(secs) * 1000);
`;

describe('N6 Scenario C — the real launcher, once', { skip: SKIP, timeout: 300_000 }, () => {
  let home;
  let stub;
  let browser;
  let session;
  let proxyPidBefore;
  let launched = null;
  let kept = false;

  before(async () => {
    await assertGuard('before Scenario C');
    proxyPidBefore = readReal('proxy.pid').trim();
    home = tempDir('nidum-n6-c-');
    stub = makeStubBin();
  });

  after(async () => {
    await browser?.close();
    if (!kept) {
      const s = session || (home && readSession(home));
      if (s) {
        await api(s, 'POST', '/api/quit').catch(() => {});
        await waitUntil(() => !pidAlive(s.pid), { timeout: 10_000, what: 'dashboard exit' }).catch(() => {
          try {
            process.kill(s.pid, 'SIGTERM');
          } catch {
            /* gone */
          }
        });
      }
      stub?.cleanup();
      if (home) rmSync(home, { recursive: true, force: true });
    }
    assert.equal(existsSync(join(homedir(), '.nidum-local')), false, 'the real ~/.nidum-local was never created');
    assert.equal(readReal('proxy.pid').trim(), proxyPidBefore, 'the real proxy was not restarted');
    await assertGuard('after Scenario C');
  });

  test('the launcher detects the live startup service on :80, starts no proxy, starts the server and opens the token URL', async (t) => {
    // NIDUM_NO_MENUBAR=1: the menu bar step isn't under test here (Scenario A step 8d checks it
    // with stubs), and nothing may build or launch the real menu bar app.
    const env = cleanEnv({ NIDUM_HOME: home, NIDUM_READ_ONLY: '1', NIDUM_NO_MENUBAR: '1', PATH: stub.path });
    const r = await runLauncher(env, { timeout: 120_000 });
    launched = r;
    t.diagnostic(r.output.replace(/\?t=[0-9a-f]{64}/g, '?t=<redacted>').trim().split('\n').map((l) => `launcher | ${l}`).join('\n'));
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Network sharing is on \(kept on by the startup service\)/);
    assert.match(r.output, /Dashboard started/);
    assert.match(r.output, /Opening http:\/\/127\.0\.0\.1:\d+ in your browser/);
    // No proxy command, no elevation.
    assert.deepEqual(stub.refused(), [], 'no refused portless command');
    assert.deepEqual(stub.portless(), ['--version'], 'the launcher only asked Portless for its version');
    assert.deepEqual(stub.sudo(), []);
    assert.deepEqual(stub.osascript(), []);
    const log = readFileSync(join(home, 'launcher.log'), 'utf8');
    assert.doesNotMatch(log, /run: .*portless/, 'launcher.log records no portless run');
    assert.match(log, /menu bar app: disabled \(NIDUM_NO_MENUBAR\)/);
    assert.match(log, /proxy config: service=1 file=\/Library\/LaunchDaemons\/sh\.portless\.proxy\.plist .*port=80 tls=0/);
    // The URL handed to `open`.
    const opened = stub.opened();
    assert.equal(opened.length, 1, opened.join(' | ').replace(/t=[0-9a-f]+/g, 't=…'));
    const m = TOKEN_URL_RE.exec(opened[0]);
    assert.ok(m, 'open got http://127.0.0.1:<port>/?t=<64 hex>');
    session = readSession(home);
    assert.ok(session, 'session.json written');
    assert.equal(Number(m[1]), session.port);
    assert.equal(m[2], session.token);
    assert.equal(statSync(join(home, 'session.json')).mode & 0o777, 0o600);
    const h = await health(session.port);
    assert.deepEqual({ app: h.app, pid: h.pid }, { app: 'nidum-local', pid: session.pid });
    for (const f of ['launcher.log', 'server.log']) {
      assert.ok(!readFileSync(join(home, f), 'utf8').includes(session.token), `${f} has no token`);
    }
    // The server runs read-only against the real service-managed proxy.
    const st = (await api(session, 'GET', '/api/state')).json;
    assert.equal(st.proxy.managedBy, 'service');
    assert.equal(st.proxy.port, 80);
    const ro = await api(session, 'PATCH', '/api/ui', { dismiss: 'first-run' });
    assert.equal(ro.status, 403, 'read-only server');
    assert.equal(readReal('proxy.pid').trim(), proxyPidBefore, 'the real proxy was not restarted');
    // Files for the orchestrator: the redacted URL as evidence (vault only with NIDUM_E2E_SAVE_ASSETS=1),
    // the full one (mode 600) in NIDUM_HOME.
    saveAsset('scenario-c-url.txt', `${opened[0].replace(/t=[0-9a-f]{64}/, 't=<redacted>')}\n`);
    const full = join(home, 'scenario-c-url.txt');
    writeFileSync(full, `${opened[0]}\n`, { mode: 0o600 });
    chmodSync(full, 0o600);
  });

  test('the opened URL works in headless Chrome (dashboard with the real addresses)', async () => {
    assert.ok(session, 'launcher step passed');
    browser = await launchChrome();
    const url = `http://127.0.0.1:${session.port}/?t=${session.token}`;
    const page = await openDashboard(browser, url);
    try {
      await goTab(page, 'addresses');
      const st = (await api(session, 'GET', '/api/state')).json;
      // As many as the real ~/.portless/routes.json lists (read only; five since D46).
      assert.equal(st.routes.length, JSON.parse(readReal('routes.json')).length);
      assert.ok(st.routes.length > 0);
      for (const r of st.routes) await waitSel(page, addrRow(r.url));
      // The token was swapped for the cookie and the address bar no longer carries it.
      assert.equal(await page.evaluate(() => location.search), '');
      await sleep(300);
      saveShot('scenario-c-dashboard.png', await page.screenshot());
      assert.deepEqual(unexpectedErrors(page), [], 'console errors');
      assert.deepEqual(offOrigin(page, `http://127.0.0.1:${session.port}/`), []);
    } finally {
      await page.close();
    }
    // A wrong token is refused.
    const bad = await request(`http://127.0.0.1:${session.port}/?t=${'0'.repeat(64)}`);
    assert.equal(bad.status, 401);
  });

  test(KEEP ? `kept running for the orchestrator (watchdog quits it after ${KEEP_SECONDS} s)` : 'quit through /api/quit', async (t) => {
    assert.ok(session, 'launcher step passed');
    if (KEEP) {
      const w = spawn(process.execPath, ['-e', WATCHDOG_JS, '--', home, stub.dir, String(KEEP_SECONDS)], { detached: true, stdio: 'ignore', cwd: tmpdir() });
      w.unref();
      kept = true;
      t.diagnostic(`KEEP: dashboard pid ${session.pid} on port ${session.port}; full URL (mode 600) in ${join(home, 'scenario-c-url.txt')}; watchdog pid ${w.pid} quits it in ${KEEP_SECONDS} s`);
      return;
    }
    const q = await api(session, 'POST', '/api/quit');
    assert.equal(q.status, 202);
    await waitUntil(() => !pidAlive(session.pid), { timeout: 10_000, what: 'dashboard exit' });
    assert.equal(existsSync(join(home, 'session.json')), false);
    assert.equal(await health(session.port), null);
    assert.ok(launched);
  });
});
