// N6 Scenario A — the whole product, isolated (docs/Nidum Local/Plan/N6 End-to-end verification.md).
//
//   npm run test:e2e        (NIDUM_E2E=1; skipped by plain `npm test`)
//
// Real server (`node src/server.js`, NIDUM_SAFE_MODE=1, temp NIDUM_HOME) + real Portless adapter
// in safe mode + an isolated Portless proxy (portlessTestEnv(): temp PORTLESS_STATE_DIR, free
// port ≥ 20000, `--no-tls --tld local`, never --lan) + a throwaway HTTP app and raw TCP server +
// headless Chrome on the token URL. Steps 1–9 of the note, in order. The launcher runs twice
// (reuse, then restart) with a recording `open` stub, a portless passthrough that refuses
// everything but read-only commands and NIDUM_NO_MENUBAR=1; a third run (step 8d) checks its
// menu bar app start with stubbed open/pgrep/ps/swiftc, so the real menu app never runs.
// Screenshots go to a temp folder (the vault only with NIDUM_E2E_SAVE_ASSETS=1).
// Cleanup runs in after() also on failure; the guard is checked before and after.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPortless } from '../../src/portless.js';
import { startServer } from '../../src/server.js';
import { haveChrome, launchChrome } from '../helpers/chrome.js';
import { freePort, startThrowawayHttp, startThrowawayTcp } from '../helpers/net.js';
import { portlessTestEnv } from '../helpers/portless-env.js';
import {
  E2E, ROOT, TOKEN_URL_RE, addrRow, api, assertGuard, clickText, exists, fill, goTab, health, makeStubBin, offOrigin, openDashboard,
  pidAlive, readSession, request, runLauncher, saveShot, sleep, startServerProcess, tempDir, text, toastText, unexpectedErrors,
  waitForState, waitGone, waitSel, waitText, waitUntil,
} from './n6-helpers.js';

/** Pids of this user's real `NidumLocalMenu` processes (read only, /usr/bin/pgrep). */
const pgrepMenu = () => new Promise((resolve) => {
  execFile('/usr/bin/pgrep', ['-U', String(process.getuid()), '-x', '--', 'NidumLocalMenu'], { timeout: 5000 }, (err, out) => {
    resolve(String(out || '').split('\n').filter(Boolean).sort());
  });
});

const SKIP = !E2E ? 'set NIDUM_E2E=1 (npm run test:e2e)' : !haveChrome() ? 'Google Chrome not found (set NIDUM_CHROME)' : false;
const TABS = ['discover', 'add', 'addresses', 'sharing', 'tools', 'advanced'];
const MARKER = `n6-body-${process.pid}-${Date.now()}`;

/** A local HTTP server; `handler(req, res)`. close() resolves even with keep-alive clients. */
async function startApp(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** Like Vite's dev server: any Host other than loopback gets 403 "Blocked request. This host … is not allowed." */
const startViteLike = () => startApp((req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`Blocked request. This host ("${host}") is not allowed.\nTo allow this host, add "${host}" to \`server.allowedHosts\` in vite.config.js.`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>N6 Vite Waffles</title><script type="module" src="/@vite/client"></script><p>vite</p>');
});

/** An app whose every page is its own 404 (not Portless's). */
const startPlain404 = () => startApp((req, res) => {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>N6 Plain 404</title><p>n6 plain not found</p>');
});

describe('N6 Scenario A — isolated end to end', { skip: SKIP, timeout: 600_000 }, () => {
  let env; // portlessTestEnv()
  let adapter;
  let app;
  let tcp;
  let home;
  let server;
  let browser;
  let page;
  let stub;
  let emptyPort;
  let vite;
  let plain404;
  const launcherPids = new Set();
  const proxyUrl = (name) => `http://${name}.local:${env.port}`;
  const routesFile = () => {
    try {
      return JSON.parse(readFileSync(join(env.stateDir, 'routes.json'), 'utf8'));
    } catch {
      return [];
    }
  };
  const throughProxy = (name) => request(`http://127.0.0.1:${env.port}/`, { headers: { host: `${name}.local:${env.port}` } });
  /** The proxy re-reads routes.json on a file watch (~100 ms here), so poll for the expected status. */
  const proxyAnswers = (name, status) => waitUntil(async () => {
    const r = await throughProxy(name);
    return r.status === status ? r : null;
  }, { timeout: 5000, interval: 50, what: `${name}.local → ${status} through the proxy` });
  const serverEnv = () => ({ ...env.env, NIDUM_HOME: home, NIDUM_SAFE_MODE: '1', NIDUM_PORT: '0' });
  /**
   * The launcher's environment: no startup service, the stub PATH, and (unless the menu bar step is
   * under test, step 8d) NIDUM_NO_MENUBAR=1, so it never builds or opens the menu bar app.
   */
  const launcherEnv = (bin, { menubar = false } = {}) => {
    const e = { ...serverEnv(), NIDUM_SERVICE_PLIST: join(home, 'no-such-service.plist'), PATH: bin.path, NIDUM_START_TIMEOUT: '20', NIDUM_NO_MENUBAR: '1' };
    if (menubar) {
      delete e.NIDUM_NO_MENUBAR;
      delete e.NIDUM_MENU_EXEC; // the real executable name, never a test override
    }
    return e;
  };
  /** Close whatever an earlier (possibly failed) step left open: dialog, inline editor, assign form; free the toasts. */
  const settle = async () => {
    for (let i = 0; i < 3 && await exists(page, '.dialog, #edit-input, #assign-name'); i += 1) {
      await page.evaluate(() => document.querySelector('.dialog, #edit-input, #assign-name')?.focus());
      await page.key('Escape');
      await sleep(100);
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
  };
  const routeNames = async () => (await api(server, 'GET', '/api/state')).json.routes.map((r) => r.name);
  /** Make a step independent of earlier ones: create the address it starts from if it is missing. */
  const ensureRoute = async (name, port) => {
    if ((await routeNames()).includes(name)) return;
    assert.equal((await api(server, 'POST', '/api/routes', { name, port })).status, 201, `setup: ${name}`);
    await waitSel(page, addrRow(proxyUrl(name)));
  };

  before(async () => {
    await assertGuard('before Scenario A');
    env = await portlessTestEnv();
    assert.ok(env.port >= 20000);
    adapter = createPortless({ env: env.env, safeMode: true });
    // Step 1: isolated proxy on a free high port with --no-tls --tld local (adapter, safe mode).
    const started = await adapter.startProxy({ tls: false, port: env.port, lan: false, fixedIp: null, wildcard: false });
    assert.equal(started.running, true);
    assert.equal(started.managedBy, 'manual');
    assert.deepEqual(started.tlds, ['local']);
    // Step 2: throwaway HTTP app with a <title> and a raw TCP server.
    app = await startThrowawayHttp({ title: 'N6 Pancakes', body: MARKER });
    tcp = await startThrowawayTcp();
    vite = await startViteLike();
    plain404 = await startPlain404();
    // Step 3: Nidum Local itself, then the token URL in headless Chrome.
    home = tempDir('nidum-n6-a-');
    server = await startServerProcess(serverEnv());
    browser = await launchChrome();
    page = await openDashboard(browser, server.tokenUrl);
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close();
    await server?.stop();
    // Servers the launcher started (detached): quit them, else SIGTERM.
    for (const pid of launcherPids) {
      const s = home ? readSession(home) : null;
      if (s && s.pid === pid) await api({ port: s.port, token: s.token }, 'POST', '/api/quit').catch(() => {});
      await sleep(300);
      if (pidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
    }
    if (adapter) {
      await adapter.stopProxy().catch(() => {});
      await adapter.run(['proxy', 'stop', '-p', String(env.port)], { timeout: 15_000 }).catch(() => {});
    }
    await app?.close();
    await tcp?.close();
    await vite?.close();
    await plain404?.close();
    env?.cleanup();
    stub?.cleanup();
    if (home) rmSync(home, { recursive: true, force: true });
    await assertGuard('after Scenario A');
  });

  test('step 4a: Discover shows both services; the TCP one is "Not a web service"', async () => {
    await goTab(page, 'discover');
    await page.evaluate(() => fetch('/api/services?refresh=1').then((r) => r.status));
    // Discover rows carry data-port (only the active panel is rendered).
    const httpRow = `#panel [data-port="${app.port}"]`;
    const tcpRow = `#panel [data-port="${tcp.port}"]`;
    await waitSel(page, httpRow, 25_000);
    await waitSel(page, tcpRow, 25_000);
    assert.match(await text(page, httpRow), /N6 Pancakes/);
    assert.ok(await exists(page, `[data-assign-port="${app.port}"]`), 'HTTP row offers "Give it an address"');
    assert.match(await text(page, tcpRow), /Not a web service/);
    assert.equal(await exists(page, `[data-assign-port="${tcp.port}"]`), false, 'TCP row offers no address');
    const { json } = await api(server, 'GET', '/api/services');
    const svc = json.find((s) => s.port === app.port);
    assert.equal(svc.http.title, 'N6 Pancakes');
    assert.equal(json.find((s) => s.port === tcp.port).http, null);
  });

  test('step 4b: give the HTTP service an address from its row → Live → the proxy serves the app', async () => {
    const url = proxyUrl('n6-pancakes');
    await page.click(`[data-assign-port="${app.port}"]`);
    await waitSel(page, '#assign-name');
    await fill(page, '#assign-name', 'n6-pancakes');
    await waitText(page, '#assign-preview', url.replace(/^http:\/\//, ''));
    await page.click('.assign button[type=submit]');
    await toastText(page, 'n6-pancakes.local is ready.');
    await waitSel(page, `#panel .row[data-port="${app.port}"][data-row-url="${url}"]`);
    await goTab(page, 'addresses');
    await waitSel(page, addrRow(url));
    await waitText(page, addrRow(url), 'Live', 30_000);
    const st = await waitForState(server, (s) => s.routes.some((r) => r.name === 'n6-pancakes' && r.status === 'live'));
    const route = st.routes.find((r) => r.name === 'n6-pancakes');
    assert.equal(route.source, 'nidum');
    assert.equal(route.port, app.port);
    assert.equal(route.url, url);
    assert.deepEqual(routesFile().map((r) => r.hostname), ['n6-pancakes.local']);
    const res = await proxyAnswers('n6-pancakes', 200);
    assert.equal(res.headers['x-portless'], '1');
    assert.ok(res.body.includes(MARKER), `proxy body: ${res.body.slice(0, 200)}`);
    assert.ok(res.body.includes('<title>N6 Pancakes</title>'));
  });

  test('step 5a: Add manually a port with nothing on it → Waiting', async () => {
    await settle();
    emptyPort = await freePort({ min: 30000 });
    await goTab(page, 'add');
    await fill(page, '#add-port', String(emptyPort));
    await waitText(page, '#add-port-hint', `Nothing is running on ${emptyPort} yet.`);
    await fill(page, '#add-name', 'n6-later');
    await page.click('.add-card button[type=submit]');
    await toastText(page, 'n6-later.local is ready.');
    await goTab(page, 'addresses');
    await waitText(page, addrRow(proxyUrl('n6-later')), 'Waiting', 30_000);
    const st = await waitForState(server, (s) => s.routes.some((r) => r.name === 'n6-later' && r.status === 'waiting'));
    assert.deepEqual(st.routes.find((r) => r.name === 'n6-later').statusDetail, { reason: 'refused' });
  });

  test('step 5b: Rename', async () => {
    await settle();
    emptyPort ??= await freePort({ min: 30000 });
    await goTab(page, 'addresses');
    if ((await routeNames()).includes('n6-renamed')) await api(server, 'DELETE', '/api/routes/n6-renamed');
    await ensureRoute('n6-later', emptyPort);
    await page.click('button[aria-label="Rename n6-later.local"]');
    await waitSel(page, '#edit-input');
    await fill(page, '#edit-input', 'n6-renamed');
    await page.key('Enter');
    await toastText(page, 'Renamed to n6-renamed.local.');
    await waitSel(page, addrRow(proxyUrl('n6-renamed')));
    await waitGone(page, addrRow(proxyUrl('n6-later')));
    const hosts = routesFile().map((r) => r.hostname);
    assert.ok(hosts.includes('n6-renamed.local') && !hosts.includes('n6-later.local'), hosts.join(','));
  });

  test('step 5c: Change port (to the app) → Live through the proxy', async () => {
    await settle();
    await goTab(page, 'addresses');
    await ensureRoute('n6-renamed', emptyPort ?? 9);
    await page.click('button[aria-label="Change port of n6-renamed.local"]');
    await waitSel(page, '#edit-input');
    await fill(page, '#edit-input', String(app.port));
    await page.key('Enter');
    await toastText(page, `n6-renamed.local now points to port ${app.port}.`);
    await waitText(page, addrRow(proxyUrl('n6-renamed')), `:${app.port}`);
    await waitText(page, addrRow(proxyUrl('n6-renamed')), 'Live', 30_000);
    assert.equal(routesFile().find((r) => r.hostname === 'n6-renamed.local').port, app.port);
    const res = await proxyAnswers('n6-renamed', 200);
    assert.ok(res.body.includes(MARKER));
  });

  test('step 5d: Remove (confirm) + Undo', async () => {
    await settle();
    await goTab(page, 'addresses');
    await ensureRoute('n6-renamed', app.port);
    await page.click('button[aria-label="Remove n6-renamed.local"]');
    await waitSel(page, '.dialog');
    assert.equal(await text(page, '.dialog h3'), 'Remove n6-renamed.local?');
    await page.click('.dialog [data-confirm]');
    await toastText(page, 'Removed n6-renamed.local.');
    await waitGone(page, addrRow(proxyUrl('n6-renamed')));
    assert.ok(!routesFile().some((r) => r.hostname === 'n6-renamed.local'), 'removed from routes.json');
    const gone = await proxyAnswers('n6-renamed', 404); // Portless's 404 page for an unknown host
    assert.ok(!gone.body.includes(MARKER));
    await clickText(page, '.toast button', 'Undo');
    await toastText(page, 'n6-renamed.local is back.');
    await waitSel(page, addrRow(proxyUrl('n6-renamed')));
    const back = routesFile().find((r) => r.hostname === 'n6-renamed.local');
    assert.equal(back?.port, app.port);
    assert.ok((await proxyAnswers('n6-renamed', 200)).body.includes(MARKER));
  });

  test('step 5e: host check — a Vite-like app that blocks the name gets the warning by itself; an app\'s own 404 does not (validation 1 F1/F2)', async () => {
    await settle();
    for (const name of ['n6-vite', 'n6-plain404']) if ((await routeNames()).includes(name)) await api(server, 'DELETE', `/api/routes/${name}`);
    await goTab(page, 'discover');
    await page.evaluate(() => fetch('/api/services?refresh=1').then((r) => r.status));
    await waitSel(page, `#panel [data-assign-port="${vite.port}"]`, 25_000);
    await waitSel(page, `#panel [data-assign-port="${plain404.port}"]`, 25_000);
    // A toast can cover a row's Create button (validation 1 F5): let them go, and submit with Enter.
    // Hovering a toast holds it, and the pointer is still on the last click (Undo), so move it away.
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
    await waitGone(page, '.toast', 15_000);
    await page.click(`[data-assign-port="${vite.port}"]`);
    await waitSel(page, '#assign-name');
    await fill(page, '#assign-name', 'n6-vite');
    await page.key('Enter');
    await toastText(page, 'n6-vite.local is ready.');
    // No "Check again" here: the warning must come from the check that runs after the create.
    const vRow = `#panel .row[data-port="${vite.port}"]`;
    const title = 'n6-vite.local works, but Vite blocked the name.';
    await waitText(page, `${vRow} .notice`, title, 15_000);
    assert.match(await text(page, `${vRow} .notice`), /server: \{ allowedHosts: \['\.local'\] \}/);
    let route = (await api(server, 'GET', '/api/state')).json.routes.find((r) => r.name === 'n6-vite');
    assert.equal(route.hostCheck?.result, 'host-blocked', JSON.stringify(route.hostCheck));
    assert.equal(route.hostCheck.framework, 'Vite');
    assert.equal(route.hostCheck.httpStatus, 403);
    assert.equal(route.hostCheck.fix, "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.");
    assert.equal(route.status, 'live', 'the app itself answers');
    // Your addresses shows it too, and Check again keeps it.
    await goTab(page, 'addresses');
    await waitText(page, '.addr-section .notice', title);
    const firstAt = route.hostCheck.checkedAt;
    await clickText(page, '.addr-section .notice button', 'Check again');
    route = await waitUntil(async () => {
      const r = (await api(server, 'GET', '/api/state')).json.routes.find((x) => x.name === 'n6-vite');
      return r.hostCheck && r.hostCheck.checkedAt !== firstAt ? r : null;
    }, { timeout: 15_000, what: 'a second host check' });
    assert.equal(route.hostCheck.result, 'host-blocked');
    await page.waitFor(() => !document.querySelector('.addr-section .notice [aria-busy="true"]'), { what: 'Check again finished' });
    await waitText(page, '.addr-section .notice', title);
    saveShot('scenario-a-hostcheck-vite.png', await page.screenshot());
    // An app's own 404 is not a Portless "not routed" and not a warning.
    await goTab(page, 'discover');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
    await waitGone(page, '.toast', 15_000);
    await page.click(`[data-assign-port="${plain404.port}"]`);
    await waitSel(page, '#assign-name');
    await fill(page, '#assign-name', 'n6-plain404');
    await page.key('Enter');
    await toastText(page, 'n6-plain404.local is ready.');
    const plainRoute = await waitUntil(async () => {
      const r = (await api(server, 'GET', '/api/state')).json.routes.find((x) => x.name === 'n6-plain404');
      return r && r.hostCheck ? r : null;
    }, { timeout: 15_000, what: 'the background host check for n6-plain404' });
    assert.equal(plainRoute.hostCheck.result, 'ok', JSON.stringify(plainRoute.hostCheck));
    assert.equal(plainRoute.hostCheck.ok, true);
    assert.equal(plainRoute.hostCheck.httpStatus, 404);
    const own = await proxyAnswers('n6-plain404', 404);
    assert.ok(own.body.includes('n6 plain not found'), 'the proxy serves the app\'s own 404');
    await sleep(500);
    assert.equal(await exists(page, `#panel .row[data-port="${plain404.port}"] .notice`), false, 'no warning on the Discover row');
    await goTab(page, 'addresses');
    await waitSel(page, addrRow(proxyUrl('n6-plain404')));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.addr-section .notice')].some((n) => n.innerText.includes('n6-plain404'))), false, 'no warning in Your addresses');
    // Leave only Scenario A's own two addresses for the later steps.
    for (const name of ['n6-vite', 'n6-plain404']) assert.equal((await api(server, 'DELETE', `/api/routes/${name}`)).status, 200);
    await waitGone(page, addrRow(proxyUrl('n6-vite')));
    assert.ok(!routesFile().some((r) => /^n6-(vite|plain404)\.local$/.test(r.hostname)), 'host-check routes removed');
  });

  test('step 6a: settings toggle (HTTPS) shows "Restart to apply"; toggling back clears it', async () => {
    await settle();
    await goTab(page, 'sharing');
    const sw = '.sw[aria-labelledby="set-https"]';
    await waitSel(page, sw);
    assert.equal(await page.evaluate((s) => document.querySelector(s).getAttribute('aria-checked'), sw), 'false', 'seeded from the HTTP proxy');
    await page.click(sw);
    await page.waitFor((s) => document.querySelector(s).getAttribute('aria-checked') === 'true', { args: [sw], what: 'HTTPS on' });
    await waitText(page, '.strip', 'Restart sharing to apply your changes.');
    await waitText(page, '.strip button', 'Restart to apply');
    let s = (await api(server, 'GET', '/api/settings')).json;
    assert.equal(s.tls, true);
    assert.equal(s.restartNeeded, true);
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(saved.settings.tls, true);
    await page.click(sw);
    await page.waitFor((x) => document.querySelector(x).getAttribute('aria-checked') === 'false', { args: [sw], what: 'HTTPS off' });
    await waitGone(page, '.strip:not([data-strip="service"])');
    s = (await api(server, 'GET', '/api/settings')).json;
    assert.equal(s.restartNeeded, false);
    // Nothing restarted implicitly (Contracts §8): same proxy pid, still HTTP.
    const p = (await api(server, 'GET', '/api/proxy')).json;
    assert.equal(p.tls, false);
    assert.equal(p.running, true);
  });

  test('step 6b: settings toggle (Allow any sub-name) shows "Restart to apply" (D37)', async () => {
    await settle();
    await goTab(page, 'sharing');
    const sw = '.sw[aria-labelledby="set-sub"]';
    await waitSel(page, sw);
    assert.equal(await page.evaluate((x) => document.querySelector(x).getAttribute('aria-checked'), sw), 'false');
    await page.click(sw);
    await page.waitFor((x) => document.querySelector(x).getAttribute('aria-checked') === 'true', { args: [sw], what: 'wildcard on' });
    let s = (await api(server, 'GET', '/api/settings')).json;
    assert.equal(s.wildcard, true);
    assert.equal(s.restartNeeded, true, 'the running proxy was started without --wildcard');
    await waitText(page, '.strip', 'Restart sharing to apply your changes.');
    await waitText(page, '.strip button', 'Restart to apply');
    // D37: Nidum didn't start this proxy (the test's adapter did), so its wildcard is unknown and,
    // once the user has changed the setting, counts as different: switching back keeps the strip.
    // (The "known value" path needs a Nidum restart, which safe mode refuses: LAN is off here.)
    await page.click(sw);
    await page.waitFor((x) => document.querySelector(x).getAttribute('aria-checked') === 'false', { args: [sw], what: 'wildcard off' });
    s = (await api(server, 'GET', '/api/settings')).json;
    assert.equal(s.wildcard, false);
    assert.equal(s.restartNeeded, true, 'unknown applied value + user change → still needs a restart (D37)');
    await waitText(page, '.strip', 'Restart sharing to apply your changes.');
    assert.equal((await api(server, 'GET', '/api/proxy')).json.running, true, 'nothing restarted implicitly');
  });

  test('step 6c: Run diagnostics shows the mapped glyphs; device setup is hidden (HTTP)', async () => {
    await settle();
    await goTab(page, 'tools');
    assert.equal(await exists(page, '[data-tool="setup"]'), false, 'device setup card hidden while HTTPS is off');
    const caps = (await api(server, 'GET', '/api/state')).json.capabilities;
    assert.equal(caps.deviceSetup.supported, false);
    await page.click('[data-tool="doctor"]');
    await waitSel(page, '.output pre', 45_000);
    const out = await page.evaluate(() => document.querySelector('.output pre').innerText);
    const lines = out.split('\n').filter((l) => l.trim() && !/^\s/.test(l));
    assert.ok(lines.length >= 3, `doctor lines: ${out}`);
    for (const l of lines) assert.match(l, /^[✓!✗·] /, `unmapped line: ${l}`);
    // Same mapping as the API (F21: ok→✓ warn→! fail→✗ info→·).
    const { json } = await api(server, 'POST', '/api/tools/doctor');
    const glyph = { ok: '✓', warn: '!', fail: '✗', info: '·' };
    assert.ok(json.findings.length >= 3);
    for (const f of json.findings) assert.equal(f.glyph, glyph[f.status], JSON.stringify(f));
    assert.ok(json.raw.includes(env.stateDir), 'doctor ran against the isolated state dir');
    saveShot('scenario-a-diagnostics.png', await page.screenshot());
    await page.click('#output-close');
    await waitGone(page, '.output');
  });

  test('step 7: Light / Dark / System; a screenshot of every panel in both themes', async () => {
    await settle();
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const backgrounds = {};
    await waitGone(page, '.toast', 15_000); // clean shots
    for (const [theme, label] of [['light', 'Light'], ['dark', 'Dark']]) {
      await page.click(`.theme-group button[aria-label="${label}"]`);
      await page.waitFor((t) => document.documentElement.getAttribute('data-theme') === t, { args: [theme], what: `theme ${theme}` });
      assert.equal(await page.evaluate(() => localStorage.getItem('nidum-theme')), theme);
      for (const tab of TABS) {
        await goTab(page, tab);
        await sleep(250);
        saveShot(`scenario-a-${tab}-${theme}.png`, await page.screenshot());
      }
      backgrounds[theme] = await bg();
    }
    assert.notEqual(backgrounds.light, backgrounds.dark);
    await page.click('.theme-group button[aria-label="Match system"]');
    await page.emulate({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.waitFor(() => document.documentElement.getAttribute('data-theme') === 'dark', { what: 'system → dark' });
    await page.emulate({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.waitFor(() => document.documentElement.getAttribute('data-theme') === 'light', { what: 'system → light' });
    assert.equal(await page.evaluate(() => localStorage.getItem('nidum-theme')), 'system');
    await goTab(page, 'addresses');
    assert.deepEqual(unexpectedErrors(page, { allowApi: true }), [], 'console errors');
    assert.deepEqual(offOrigin(page, server.url), [], 'requests outside 127.0.0.1:<port>');
  });

  test('step 8a: the launcher reuses the running dashboard (same token URL, no proxy command)', async () => {
    await settle();
    stub = makeStubBin();
    const r = await runLauncher(launcherEnv(stub));
    const s8 = readSession(home);
    if (s8 && s8.pid !== server.pid) launcherPids.add(s8.pid); // only if it didn't reuse: stop it in after()
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Dashboard is already running/);
    assert.match(r.output, /stays on for this computer only/, 'closed stdin answered No to the LAN restart');
    assert.deepEqual(stub.opened(), [server.tokenUrl]);
    assert.deepEqual(stub.refused(), [], 'no refused portless command');
    assert.deepEqual([...stub.sudo(), ...stub.osascript()], []);
    assert.ok(stub.portless().every((a) => a === '--version'), stub.portless().join(' | '));
    assert.equal(readSession(home).pid, server.pid);
    const log = readFileSync(join(home, 'launcher.log'), 'utf8');
    assert.ok(!log.includes(server.token), 'launcher.log has no token');
    assert.match(log, /menu bar app: disabled \(NIDUM_NO_MENUBAR\)/, 'the menu bar step is off for this run');
  });

  test('step 8b: Quit → "Nidum Local is closed"; the server exits and removes session.json', async () => {
    await settle();
    await page.click('button[title="Quit Nidum Local"]');
    await waitSel(page, '.dialog');
    assert.equal(await text(page, '.dialog p'), 'Your addresses keep working; only this dashboard closes.');
    await page.click('.dialog [data-confirm]');
    await waitText(page, '.fullpage', 'Nidum Local is closed.');
    saveShot('scenario-a-closed.png', await page.screenshot());
    const ex = await Promise.race([server.exited, sleep(10_000).then(() => null)]);
    assert.deepEqual(ex, { code: 0, signal: null });
    assert.equal(existsSync(join(home, 'session.json')), false);
    assert.equal(await health(server.port), null);
    // Addresses keep working without the dashboard.
    assert.equal((await throughProxy('n6-pancakes')).status, 200);
  });

  test('step 8c: the launcher then restarts the dashboard (new token); quit it again', async () => {
    stub ??= makeStubBin();
    const before = stub.opened().length;
    const r = await runLauncher(launcherEnv(stub));
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Dashboard started/);
    // Track the launcher's server first, so after() stops it even if an assertion below fails
    // (a failed 8c used to leave it running).
    const s = readSession(home);
    if (s && s.pid !== server.pid) launcherPids.add(s.pid);
    const opened = stub.opened().slice(before);
    assert.equal(opened.length, 1);
    const m = TOKEN_URL_RE.exec(opened[0]);
    assert.ok(m, opened[0]);
    assert.ok(s, 'session.json written');
    assert.equal(Number(m[1]), s.port);
    assert.equal(m[2], s.token);
    assert.notEqual(s.token, server.token);
    assert.notEqual(s.pid, server.pid);
    const h = await health(s.port);
    assert.equal(h.app, 'nidum-local');
    assert.equal(h.pid, s.pid);
    assert.deepEqual(stub.refused(), []);
    assert.deepEqual([...stub.sudo(), ...stub.osascript()], []);
    // The restarted dashboard renders and still knows both addresses (state.json + routes.json).
    const p2 = await openDashboard(browser, opened[0]);
    try {
      await goTab(p2, 'addresses');
      await waitSel(p2, addrRow(proxyUrl('n6-pancakes')));
      await waitSel(p2, addrRow(proxyUrl('n6-renamed')));
      const st = (await api({ port: s.port, token: s.token }, 'GET', '/api/state')).json;
      assert.deepEqual(st.routes.map((x) => `${x.name}:${x.source}`).sort(), ['n6-pancakes:nidum', 'n6-renamed:nidum']);
    } finally {
      await p2.close();
    }
    for (const f of ['launcher.log', 'server.log']) {
      const log = readFileSync(join(home, f), 'utf8');
      assert.ok(!log.includes(s.token) && !log.includes(server.token), `${f} has no token`);
    }
    const q = await api({ port: s.port, token: s.token }, 'POST', '/api/quit');
    assert.equal(q.status, 202);
    await waitUntil(() => !pidAlive(s.pid), { timeout: 10_000, what: 'launcher-started server exit' });
    launcherPids.delete(s.pid);
    assert.equal(existsSync(join(home, 'session.json')), false);
  });

  // N5 iterations 4–7 (D40, D52, D54, D58): after the dashboard, the launcher starts the menu bar
  // app with `open -g -a <bundle> --env NIDUM_HOME=… --args --app-root <root> --node <node>`.
  // Here `open`, `pgrep`, `ps` and `swiftc` are stubs: pgrep finds no running menu app, and a
  // stand-in bundle of the current version sits in NIDUM_HOME/app (no executable inside), so
  // nothing is built and nothing is launched. Only the exact `open` call is checked.
  test('step 8d: the launcher starts the menu bar app after the dashboard (exact open arguments, stubbed open/pgrep/ps)', async () => {
    const menuStub = makeStubBin({ menu: true, node: process.execPath });
    const realMenuApps = await pgrepMenu();
    try {
      const prebuilt = join(realpathSync(ROOT), 'macos', 'Nidum Local Menu.app');
      let bundle = prebuilt;
      if (!existsSync(prebuilt)) {
        // What a finished build leaves in NIDUM_HOME/app (N7 Info.plist, this package version).
        bundle = join(home, 'app', 'Nidum Local Menu.app');
        const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
        mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
        writeFileSync(join(bundle, 'Contents', 'Info.plist'), readFileSync(join(ROOT, 'macos', 'menubar', 'Info.plist'), 'utf8').replaceAll('__VERSION__', version));
      }
      const r = await runLauncher(launcherEnv(menuStub, { menubar: true }));
      const s = readSession(home);
      if (s && s.pid !== server.pid) launcherPids.add(s.pid); // stopped in after() if anything fails
      assert.equal(r.code, 0, r.output);
      assert.ok(s, 'a dashboard is running');
      assert.match(r.output, /Menu bar app started/);
      assert.doesNotMatch(r.output, /Building the menu bar app|Updating the menu bar app|Couldn't start the menu bar app/);
      const calls = menuStub.openedArgv();
      assert.equal(calls.length, 2, JSON.stringify(calls).replace(/t=[0-9a-f]+/g, 't=…'));
      // First the browser, at this dashboard's token URL; then the menu bar app.
      assert.deepEqual(calls[0], [`http://127.0.0.1:${s.port}/?t=${s.token}`]);
      assert.deepEqual(calls[1], [
        '-g', '-a', bundle,
        '--env', `NIDUM_HOME=${home}`,
        '--args', '--app-root', realpathSync(ROOT), '--node', join(menuStub.dir, 'node'),
      ]);
      // The running-app check asked for this user's exact executable only; nothing was found, so
      // ps had nothing to look at and no older app was signalled. Nothing was built.
      assert.deepEqual(menuStub.pgrep(), [`-U ${process.getuid()} -x -- NidumLocalMenu`]);
      assert.deepEqual(menuStub.ps(), []);
      assert.deepEqual(menuStub.swiftc(), []);
      assert.deepEqual(menuStub.refused(), []);
      assert.deepEqual([...menuStub.sudo(), ...menuStub.osascript()], []);
      const log = readFileSync(join(home, 'launcher.log'), 'utf8');
      assert.doesNotMatch(log, /menu bar build|SIGTERM|reopening/);
      assert.ok(log.includes(`run: open -g -a `), 'the open call is logged');
      assert.ok(!log.includes(s.token), 'launcher.log has no token');
      // No menu bar app process of this user appeared (the real app never ran).
      assert.deepEqual(await pgrepMenu(), realMenuApps);
      // Quit the dashboard this run started (or reused).
      assert.equal((await api({ port: s.port, token: s.token }, 'POST', '/api/quit')).status, 202);
      await waitUntil(() => !pidAlive(s.pid), { timeout: 10_000, what: 'dashboard exit' });
      launcherPids.delete(s.pid);
    } finally {
      menuStub.cleanup();
    }
  });
});

// Pause and resume (validation 1 F2, optional item): `node src/server.js` always starts the proxy
// with --lan, which safe mode refuses, so this part runs the real server in process with
// `app.lanMode: false` (as the validator did), against its own isolated proxy.
describe('N6 Scenario A2 — pause and resume (in-process server, LAN off)', { skip: SKIP, timeout: 300_000 }, () => {
  let env;
  let adapter;
  let app;
  let home;
  let srv;
  let browser;
  let page;
  const body = `${MARKER}-pause`;
  const throughProxy = () => request(`http://127.0.0.1:${env.port}/`, { headers: { host: `n6-pause.local:${env.port}` }, timeout: 3000 });

  before(async () => {
    await assertGuard('before Scenario A2');
    env = await portlessTestEnv();
    adapter = createPortless({ env: env.env, safeMode: true });
    await adapter.startProxy({ tls: false, port: env.port, lan: false, fixedIp: null, wildcard: false });
    app = await startThrowawayHttp({ title: 'N6 Pause', body });
    home = tempDir('nidum-n6-a2-');
    srv = await startServer({ env: { ...env.env, NIDUM_SAFE_MODE: '1' }, home, port: 0, readOnly: false, onQuit: () => {}, log: () => {}, app: { lanMode: false } });
    assert.equal((await api(srv, 'POST', '/api/routes', { name: 'n6-pause', port: app.port })).status, 201);
    browser = await launchChrome();
    page = await openDashboard(browser, srv.tokenUrl);
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close();
    await srv?.close().catch(() => {});
    if (adapter) {
      await adapter.stopProxy().catch(() => {});
      await adapter.run(['proxy', 'stop', '-p', String(env.port)], { timeout: 15_000 }).catch(() => {});
    }
    await app?.close();
    env?.cleanup();
    if (home) rmSync(home, { recursive: true, force: true });
    await assertGuard('after Scenario A2');
  });

  test('Pause → Paused (banner, header, state.json.paused, proxy offline); Resume → the address is served again', async () => {
    const served = await waitUntil(async () => {
      const r = await throughProxy();
      return r.status === 200 && r.body.includes(body);
    }, { timeout: 5000, what: 'n6-pause served' });
    assert.ok(served);
    await goTab(page, 'sharing');
    await page.click('main [data-action="pause"]');
    await waitSel(page, '.dialog');
    assert.match(await text(page, '.dialog'), /Pause sharing\?/);
    await page.click('.dialog [data-confirm]');
    await waitText(page, 'header .pill', 'Paused', 30_000);
    await waitSel(page, '[data-banner="sharing-paused"]');
    assert.equal(await text(page, '[data-banner="sharing-paused"] .banner-text'), 'Sharing is paused. Your addresses are offline until you resume.');
    assert.equal(await exists(page, '[data-banner="sharing-off"]'), false, 'a pause is not a failure (E11)');
    assert.equal(await text(page, 'header .counter'), 'Sharing paused');
    const p = (await api(srv, 'GET', '/api/proxy')).json;
    assert.equal(p.running, false);
    assert.equal(p.pausedByUser, true);
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).paused, true, 'D33');
    await waitUntil(() => throughProxy().then(() => false, (err) => err.code === 'ECONNREFUSED'), { timeout: 5000, what: 'proxy offline' });
    saveShot('scenario-a-paused.png', await page.screenshot());
    await waitText(page, 'main [data-action="pause"]', 'Resume sharing');
    await page.click('main [data-action="pause"]');
    await toastText(page, 'Sharing is on.', 30_000);
    await page.waitFor(() => !/Paused/.test(document.querySelector('header .pill').textContent), { what: 'pill no longer Paused', timeout: 15_000 });
    await waitGone(page, '[data-banner="sharing-paused"]');
    const q = (await api(srv, 'GET', '/api/proxy')).json;
    assert.equal(q.running, true);
    assert.equal(q.pausedByUser, false);
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).paused, undefined, 'pause cleared');
    await waitUntil(async () => {
      const r = await throughProxy().catch(() => null);
      return r && r.status === 200 && r.body.includes(body);
    }, { timeout: 5000, what: 'n6-pause served again' });
    assert.deepEqual(unexpectedErrors(page, { allowApi: true }), []);
  });
});
