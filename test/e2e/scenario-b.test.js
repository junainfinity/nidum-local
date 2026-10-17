// N6 Scenario B — the real machine, read-only (F1; docs/Nidum Local/Plan/N6 End-to-end verification.md).
//
//   NIDUM_E2E_REAL=1 npm run test:e2e
//
// Gated behind NIDUM_E2E_REAL=1 because it reads THIS Mac's real Portless state: a root launchd
// service on port 80, HTTP, LAN, with its real aliases (four until D46 added ai.local; the count is
// read from ~/.portless/routes.json, read only). The server runs with NIDUM_READ_ONLY=1, a temp
// NIDUM_HOME (the real ~/.nidum-local is never created) and no Portless temp env, plus
// NIDUM_SAFE_MODE=1 as a second lock (the adapter refuses every mutation outside an isolated state
// dir; reads are unaffected). Mutation probes use harmless bodies and run only after a harmless
// probe proved read-only mode. The guard and the real proxy's pid are checked before and after.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { haveChrome, launchChrome } from '../helpers/chrome.js';
import {
  E2E, REAL, addrRow, api, assertGuard, cleanEnv, exists, goTab, offOrigin, openDashboard, request, saveShot, sleep,
  startServerProcess, tempDir, text, unexpectedErrors, waitForState, waitSel, waitText,
} from './n6-helpers.js';

const SKIP = !E2E ? 'set NIDUM_E2E=1 (npm run test:e2e)'
  : !REAL ? 'real-machine scenario: set NIDUM_E2E_REAL=1 (only on the Mac with the real Portless service)'
    : !haveChrome() ? 'Google Chrome not found (set NIDUM_CHROME)' : false;
const PORTLESS_DIR = join(homedir(), '.portless');
const readReal = (f) => readFileSync(join(PORTLESS_DIR, f), 'utf8');

describe('N6 Scenario B — real machine, read-only', { skip: SKIP, timeout: 300_000 }, () => {
  let home;
  let server;
  let browser;
  let page;
  let proxyPidBefore;
  let realRoutes;

  before(async () => {
    await assertGuard('before Scenario B');
    proxyPidBefore = readReal('proxy.pid').trim();
    realRoutes = JSON.parse(readReal('routes.json')).map((r) => r.hostname).sort();
    home = tempDir('nidum-n6-b-');
    server = await startServerProcess(cleanEnv({ NIDUM_HOME: home, NIDUM_READ_ONLY: '1', NIDUM_SAFE_MODE: '1', NIDUM_PORT: '0' }));
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close();
    if (server) {
      await api(server, 'POST', '/api/quit').catch(() => {});
      await Promise.race([server.exited, sleep(5000)]);
      await server.stop();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(join(homedir(), '.nidum-local')), false, 'the real ~/.nidum-local was never created');
    assert.equal(readReal('proxy.pid').trim(), proxyPidBefore, 'the real proxy was not restarted');
    await assertGuard('after Scenario B');
  });

  test('GET /api/state reports the real service-managed proxy, the real CLI routes (as in ~/.portless/routes.json) and pause supported (E12)', async (t) => {
    const st = await waitForState(server, (s) => s.routes.length > 0 && s.routes.every((r) => r.status !== 'unknown'), { timeout: 30_000, what: 'probed routes' });
    const p = st.proxy;
    assert.deepEqual(
      { running: p.running, port: p.port, tls: p.tls, lan: p.lan, elevated: p.elevated, managedBy: p.managedBy },
      { running: true, port: 80, tls: false, lan: true, elevated: true, managedBy: 'service' },
    );
    assert.match(p.lanIp, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(p.baseUrl, 'http://127.0.0.1:80');
    assert.ok(realRoutes.length > 0, 'the real routes.json lists aliases');
    assert.equal(st.routes.length, realRoutes.length);
    assert.deepEqual(st.routes.map((r) => r.hostname).sort(), realRoutes);
    for (const r of st.routes) {
      assert.equal(r.source, 'cli', r.name);
      assert.equal(r.foreignTld, false, r.name);
      assert.equal(r.url, `http://${r.hostname}`, 'port 80 → no :port in the URL');
      assert.ok(['live', 'waiting', 'error'].includes(r.status), `${r.name}: ${r.status}`);
    }
    // E12 (D43 reversed D10): a service-managed proxy can be paused on macOS (launchctl bootout).
    // The read-only server would refuse it (403, below); nothing here ever presses Pause.
    assert.deepEqual(st.capabilities.pause, { supported: true, reason: null });
    assert.equal(st.capabilities.deviceSetup.supported, false, 'HTTP proxy: no device setup');
    assert.equal(st.capabilities.internetSharing.supported, false);
    // First-run settings seeded from the startup service (F1), so nothing asks to be applied.
    assert.equal(st.settings.tls, false);
    assert.equal(st.settings.port, 80);
    assert.equal(st.settings.keepAfterRestart, true);
    assert.equal(st.settings.restartNeeded, false);
    assert.equal(st.settings.serviceReinstallNeeded, false);
    assert.equal(st.routesUnavailable, false);
    assert.ok(!st.banners.some((b) => b.id === 'sharing-off' || b.id === 'network-off' || b.id === 'portless-missing'), JSON.stringify(st.banners));
    t.diagnostic(`routes: ${st.routes.map((r) => `${r.name}:${r.status}`).join(', ')}`);
  });

  test('every mutation endpoint answers 403 FORBIDDEN', async () => {
    // A harmless probe first: if read-only mode were off, this would only touch the temp state.json.
    const first = await api(server, 'PATCH', '/api/ui', { dismiss: 'first-run' });
    assert.equal(first.status, 403, 'read-only mode must be on before any other probe');
    assert.equal(first.json.error.code, 'FORBIDDEN');
    assert.equal(first.json.error.message, 'Read-only mode: nothing can be changed.');
    // Harmless bodies: without read-only these would be 400/404/409, never a change.
    const probes = [
      ['POST', '/api/routes', { name: 'N6 not a name', port: 9 }],
      ['PATCH', '/api/routes/n6-no-such-route', { port: 9 }],
      ['PATCH', '/api/routes/n6-no-such-route', { newName: 'n6-other' }],
      ['DELETE', '/api/routes/n6-no-such-route', {}],
      ['POST', '/api/proxy/start', {}],
      ['POST', '/api/proxy/stop', {}],
      ['POST', '/api/proxy/restart', {}],
      ['PATCH', '/api/settings', { n6UnknownKey: true }],
      ['POST', '/api/service', { action: 'n6-bogus' }],
      ['POST', '/api/tools/trust', {}],
      ['POST', '/api/tools/hosts-sync', {}],
      ['POST', '/api/tools/prune', {}],
      ['POST', '/api/tools/clean', {}],
      ['POST', '/api/tools/n6-unknown', {}],
      ['POST', '/api/setup-device', {}],
      ['DELETE', '/api/setup-device', {}],
    ];
    for (const [method, path, body] of probes) {
      const r = await api(server, method, path, body);
      assert.equal(r.status, 403, `${method} ${path} → ${r.status} ${r.body.slice(0, 200)}`);
      assert.equal(r.json.error.code, 'FORBIDDEN', `${method} ${path}`);
    }
    // Read-only is checked before the content type (E8).
    const plain = await request(`http://127.0.0.1:${server.port}/api/routes`, { method: 'POST', headers: { 'x-nidum-token': server.token, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(plain.status, 403);
    // Nothing changed in the real state or in the temp home.
    const st = await waitForState(server);
    assert.deepEqual(st.routes.map((r) => r.hostname).sort(), realRoutes);
    assert.deepEqual(JSON.parse(readReal('routes.json')).map((r) => r.hostname).sort(), realRoutes);
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.deepEqual(saved.names, []);
    assert.ok(!saved.dismissed.includes('first-run'));
  });

  test('the UI renders the real addresses and the service-managed sharing panel (screenshots)', async () => {
    browser = await launchChrome();
    page = await openDashboard(browser, server.tokenUrl);
    await goTab(page, 'addresses');
    const st = (await api(server, 'GET', '/api/state')).json;
    for (const r of st.routes) {
      await waitSel(page, addrRow(r.url));
      assert.match(await text(page, addrRow(r.url)), /Command line/);
      const label = { live: 'Live', waiting: 'Waiting', error: 'Error' }[r.status];
      await waitText(page, addrRow(r.url), label);
    }
    assert.equal(await page.evaluate(() => document.querySelectorAll('.addr-section [data-row-url]').length), realRoutes.length);
    assert.equal(await text(page, '#tab-addresses .nav-count'), String(realRoutes.length));
    await sleep(300);
    saveShot('scenario-b-addresses.png', await page.screenshot());
    await goTab(page, 'sharing');
    // E12: Pause is offered (not disabled, no reason line). It is never clicked here.
    await waitSel(page, 'main [data-action="pause"]');
    assert.equal(await page.evaluate(() => document.querySelector('main [data-action="pause"]').getAttribute('aria-disabled')), null);
    assert.equal(await exists(page, '#pause-reason'), false);
    assert.ok(await page.evaluate(() => document.querySelector('main [data-action="restart"]').disabled), 'Restart disabled (service-managed)');
    assert.ok(await exists(page, '#restart-reason'));
    assert.equal(await page.evaluate(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked')), 'true');
    assert.equal(await page.evaluate(() => document.querySelector('.sw[aria-labelledby="set-https"]').getAttribute('aria-checked')), 'false');
    assert.equal(await exists(page, '[data-strip="service"]'), false, 'no Apply strip: seeded settings match the service');
    assert.match(await text(page, 'main .status-card'), new RegExp(st.proxy.lanIp.replace(/\./g, '\\.')));
    await sleep(300);
    saveShot('scenario-b-sharing.png', await page.screenshot());
    await goTab(page, 'tools');
    assert.equal(await exists(page, '[data-tool="setup"]'), false, 'device setup hidden (HTTP)');
    assert.deepEqual(unexpectedErrors(page), [], 'console errors');
    assert.deepEqual(offOrigin(page, server.url), [], 'requests outside 127.0.0.1:<port>');
  });

  test('POST /api/quit (allowed in read-only mode) stops the server cleanly', async () => {
    const r = await api(server, 'POST', '/api/quit');
    assert.equal(r.status, 202);
    const ex = await Promise.race([server.exited, sleep(10_000).then(() => null)]);
    assert.deepEqual(ex, { code: 0, signal: null });
    assert.equal(existsSync(join(home, 'session.json')), false);
    // The real proxy still answers.
    const p = await request('http://127.0.0.1:80/', { method: 'HEAD', timeout: 3000 });
    assert.equal(p.headers['x-portless'], '1');
  });
});
