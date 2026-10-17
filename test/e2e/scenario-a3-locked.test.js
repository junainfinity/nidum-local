// N6 Scenario A3 — a locked address list (E13, D47, D48, D51, D53, D59, D60), end to end against a
// real, isolated Portless (docs/Nidum Local/Plan/N6 End-to-end verification.md).
//
//   npm run test:e2e        (NIDUM_E2E=1; skipped by plain `npm test`)
//
// Real server (`node src/server.js`, NIDUM_SAFE_MODE=1, temp NIDUM_HOME) + the real Portless
// adapter + an isolated Portless proxy (portlessTestEnv(): temp PORTLESS_STATE_DIR, free port
// ≥ 20000, `--no-tls --tld local`, never --lan) + headless Chrome on the token URL.
//
// The test (never the product: Nidum Local never changes file flags) runs `chflags uchg` on the temp
// PORTLESS_STATE_DIR's routes.json, checks the routes-locked banner, its Finder steps and the
// `chflags -- nouchg <path>` command, the disabled Add / Give it an address / Remove (and Rename,
// Change port) with their reason, then unlocks with `chflags nouchg`, clicks Check again, and
// creates an address. `after()` always runs `chflags -R nouchg` on the temp state dir (also on
// failure) before anything is removed. The real ~/.portless is never touched: every path is checked
// to be the temp state dir before a flag is changed.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPortless } from '../../src/portless.js';
import { haveChrome, launchChrome } from '../helpers/chrome.js';
import { startThrowawayHttp } from '../helpers/net.js';
import { portlessTestEnv } from '../helpers/portless-env.js';
import {
  E2E, addrRow, api, assertGuard, exists, fill, goTab, openDashboard, request, saveShot, sleep, startServerProcess, tempDir, text,
  toastText, unexpectedErrors, waitForState, waitGone, waitSel, waitText, waitUntil,
} from './n6-helpers.js';

const SKIP = !E2E ? 'set NIDUM_E2E=1 (npm run test:e2e)'
  : process.platform !== 'darwin' ? 'macOS only (chflags uchg)'
    : !haveChrome() ? 'Google Chrome not found (set NIDUM_CHROME)' : false;
const MARKER = `n6-a3-body-${process.pid}-${Date.now()}`;
const LOCKED = 'Your address list is locked, so addresses can\'t be added, changed or removed.';
const REASON = 'Your address list is locked.';
const REAL_PORTLESS = join(homedir(), '.portless');

/** `/usr/bin/chflags <args>` with a 5 s limit. Resolves { ok, out }. */
const chflags = (...args) => new Promise((resolve) => {
  execFile('/usr/bin/chflags', args, { timeout: 5000 }, (err, so, se) => resolve({ ok: !err, out: `${so}${se}`.trim() }));
});
/** BSD flags of a path (`stat -f %f`); UF_IMMUTABLE (uchg) is 0x2. */
const flagsOf = (path) => new Promise((resolve, reject) => {
  execFile('/usr/bin/stat', ['-f', '%f', path], { timeout: 5000 }, (err, so) => (err ? reject(err) : resolve(Number(so.trim()))));
});
/** Same rule as public/addr.js shellQuote (single quotes unless only plainly safe characters). */
const shq = (s) => (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

describe('N6 Scenario A3 — locked address list (E13, real isolated Portless)', { skip: SKIP, timeout: 300_000 }, () => {
  let env;
  let adapter;
  let app;
  let spare; // a second app without an address: its Discover row offers "Give it an address"
  let home;
  let server;
  let browser;
  let page;
  let routesPath; // the temp state dir's routes.json
  const proxyUrl = (name) => `http://${name}.local:${env.port}`;
  const routesFile = () => JSON.parse(readFileSync(routesPath, 'utf8'));
  const throughProxy = (name) => request(`http://127.0.0.1:${env.port}/`, { headers: { host: `${name}.local:${env.port}` } });

  /** Only ever change flags inside this run's temp state dir; never under the real ~/.portless. */
  const assertTemp = (path) => {
    const real = realpathSync(path);
    const stateReal = realpathSync(env.stateDir);
    assert.ok(real === stateReal || real.startsWith(`${stateReal}/`), `${path} is inside the temp state dir`);
    assert.equal(dirname(stateReal), realpathSync(tmpdir()), 'the state dir sits in the system temp dir');
    assert.ok(basename(stateReal).startsWith('nidum-portless-'), 'portlessTestEnv() state dir');
    let realPortless = REAL_PORTLESS;
    try {
      realPortless = realpathSync(REAL_PORTLESS);
    } catch {
      /* no ~/.portless */
    }
    assert.ok(real !== realPortless && !real.startsWith(`${realPortless}/`), 'never the real ~/.portless');
  };
  const lock = async () => {
    assertTemp(routesPath);
    const r = await chflags('uchg', routesPath);
    assert.ok(r.ok, `chflags uchg: ${r.out}`);
    assert.equal((await flagsOf(routesPath)) & 0x2, 0x2, 'uchg set');
  };
  const unlock = async () => {
    assertTemp(routesPath);
    const r = await chflags('nouchg', routesPath);
    assert.ok(r.ok, `chflags nouchg: ${r.out}`);
    assert.equal((await flagsOf(routesPath)) & 0x2, 0, 'uchg cleared');
  };

  before(async () => {
    await assertGuard('before Scenario A3');
    env = await portlessTestEnv();
    assert.ok(env.port >= 20000);
    routesPath = join(env.stateDir, 'routes.json');
    adapter = createPortless({ env: env.env, safeMode: true });
    const started = await adapter.startProxy({ tls: false, port: env.port, lan: false, fixedIp: null, wildcard: false });
    assert.equal(started.running, true);
    app = await startThrowawayHttp({ title: 'N6 Locked', body: MARKER });
    spare = await startThrowawayHttp({ title: 'N6 Spare', body: `${MARKER}-spare` });
    home = tempDir('nidum-n6-a3-');
    server = await startServerProcess({ ...env.env, NIDUM_HOME: home, NIDUM_SAFE_MODE: '1', NIDUM_PORT: '0' });
    // One address before the lock, so Your addresses has Remove / Rename / Change port buttons.
    assert.equal((await api(server, 'POST', '/api/routes', { name: 'n6-before', port: app.port })).status, 201);
    assert.deepEqual(routesFile().map((r) => r.hostname), ['n6-before.local']);
    await lock();
    browser = await launchChrome();
    page = await openDashboard(browser, server.tokenUrl);
  });

  after(async () => {
    // First and always: unlock (only inside the temp state dir), so nothing below can fail on EPERM.
    if (env) {
      try {
        assertTemp(env.stateDir);
        await chflags('-R', 'nouchg', env.stateDir);
      } catch {
        /* the dir is gone or isn't ours: nothing to unlock */
      }
    }
    await page?.close().catch(() => {});
    await browser?.close();
    await server?.stop();
    if (adapter) {
      await adapter.stopProxy().catch(() => {});
      await adapter.run(['proxy', 'stop', '-p', String(env.port)], { timeout: 15_000 }).catch(() => {});
    }
    await app?.close();
    await spare?.close();
    env?.cleanup();
    if (home) rmSync(home, { recursive: true, force: true });
    await assertGuard('after Scenario A3');
  });

  test('A3a: the dashboard shows routes-locked with the Finder steps and `chflags -- nouchg <path>`; a write is refused with 423', async () => {
    const st = await waitForState(server, (s) => s.routesAccess?.locked === true, { what: 'routesAccess.locked' });
    const a = st.routesAccess;
    assert.equal(a.flag, 'uchg');
    assert.equal(a.target, 'file');
    assert.equal(a.writable, false);
    assert.equal(a.ownedByYou, true);
    assert.equal(a.owner, userInfo().username);
    assert.equal(realpathSync(a.path), realpathSync(routesPath), 'the blocking path is the temp routes.json');
    const banner = st.banners.find((b) => b.id === 'routes-locked');
    assert.ok(banner, JSON.stringify(st.banners.map((b) => b.id)));
    assert.equal(banner.kind, 'error');
    assert.deepEqual(banner.details, { path: a.path, flag: 'uchg', target: 'file', owner: a.owner, ownedByYou: true }, 'D53');
    assert.equal(st.banners.some((b) => b.id === 'routes-not-writable'), false, 'locked, so not "not writable" too');

    await goTab(page, 'discover');
    await waitSel(page, '[data-banner="routes-locked"][role=alert]', 20_000);
    assert.equal(await text(page, '[data-banner="routes-locked"] .banner-text'), LOCKED);
    assert.equal(await exists(page, '[data-banner="routes-locked"] button[aria-label="Dismiss"]'), false, 'not dismissible');
    const cmd = `chflags -- nouchg ${shq(a.path)}`;
    assert.equal(await text(page, '[data-banner="routes-locked"] .routes-fix'),
      `In Finder, choose Go → Go to Folder…, enter ${dirname(a.path)}, select routes.json, choose File → Get Info, and uncheck Locked. Or in Terminal: ${cmd} Copy`);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-banner] [data-copy-cmd]')].map((b) => b.getAttribute('data-copy-cmd'))), [cmd]);
    assert.equal(await page.evaluate(() => document.title), '(!) Nidum Local');
    await sleep(250);
    saveShot('scenario-a3-locked.png', await page.screenshot());

    // The server refuses a write with the real error shape; routes.json is unchanged.
    const r = await api(server, 'POST', '/api/routes', { name: 'n6-refused', port: app.port });
    assert.equal(r.status, 423, r.body);
    assert.equal(r.json.error.code, 'ROUTES_LOCKED');
    assert.equal(r.json.error.message, 'Your address list is locked, so Nidum Local can\'t change it.');
    assert.deepEqual(r.json.error.details, banner.details, 'banner details equal error details (D53)');
    assert.deepEqual(routesFile().map((x) => x.hostname), ['n6-before.local']);
  });

  test('A3b: Add, Give it an address, Remove, Rename and Change port are disabled with the visible reason', async () => {
    await waitSel(page, '[data-banner="routes-locked"]', 20_000);
    // Discover: "Give it an address" on the row of the app that has none yet.
    await goTab(page, 'discover');
    await page.evaluate(() => fetch('/api/services?refresh=1').then((r) => r.status));
    const assign = `#panel [data-assign-port="${spare.port}"]`;
    await waitSel(page, assign, 25_000);
    assert.deepEqual(await page.evaluate((s) => { const b = document.querySelector(s); return [b.disabled, b.getAttribute('aria-describedby')]; }, assign), [true, 'routes-reason-d']);
    assert.equal(await text(page, '#routes-reason-d'), REASON);
    // Add manually: the form is filled in, but Create address stays disabled with the reason.
    await goTab(page, 'add');
    await fill(page, '#add-port', String(spare.port));
    await fill(page, '#add-name', 'n6-blocked');
    assert.equal(await page.evaluate(() => document.querySelector('.add-card button[type=submit]').disabled), true, 'Create address disabled');
    assert.equal(await text(page, '#routes-reason-add'), REASON);
    assert.equal(await page.evaluate(() => document.querySelector('.add-card button[type=submit]').getAttribute('aria-describedby')), 'routes-reason-add');
    await page.key('Enter'); // submitting anyway does nothing
    await sleep(500);
    assert.deepEqual(routesFile().map((x) => x.hostname), ['n6-before.local']);
    await fill(page, '#add-port', '');
    await fill(page, '#add-name', '');
    // Your addresses: every action of the existing address.
    await goTab(page, 'addresses');
    await waitSel(page, addrRow(proxyUrl('n6-before')));
    const acts = await page.evaluate(() => Object.fromEntries(['Remove', 'Rename', 'Change port of'].map((l) => {
      const b = document.querySelector(`main [aria-label="${l} n6-before.local"]`);
      return [l, b ? b.disabled : 'missing'];
    })));
    assert.deepEqual(acts, { Remove: true, Rename: true, 'Change port of': true });
    assert.equal(await text(page, '#routes-reason-a'), REASON);
    // The address itself keeps working: the lock only blocks changes.
    assert.ok((await throughProxy('n6-before')).body.includes(MARKER));
  });

  test('A3c: the test unlocks routes.json; Check again clears the banner; creating an address works', async () => {
    await goTab(page, 'addresses');
    await waitSel(page, '[data-banner="routes-locked"] [data-fk="routes-check"]', 20_000);
    // Still locked: Check again (a fresh read, no cache) says nothing changed.
    await page.click('[data-banner="routes-locked"] [data-fk="routes-check"]');
    await waitText(page, '[data-banner="routes-locked"]', 'Nothing has changed yet.', 15_000);
    await page.waitFor(() => document.querySelector('[data-fk="routes-check"]')?.getAttribute('aria-busy') !== 'true', { what: 'Check again finished' });
    await unlock();
    await page.click('[data-banner="routes-locked"] [data-fk="routes-check"]');
    await waitGone(page, '[data-banner="routes-locked"]', 15_000);
    await toastText(page, 'Your address list can be changed again.');
    const st = await waitForState(server, (s) => s.routesAccess && s.routesAccess.locked === false && s.routesAccess.writable === true, { what: 'routesAccess unlocked' });
    assert.equal(st.banners.some((b) => b.id === 'routes-locked' || b.id === 'routes-not-writable'), false);
    assert.equal(await exists(page, '#routes-reason-a'), false, 'no reason once unlocked');
    assert.equal(await page.evaluate(() => document.querySelector('main [aria-label="Remove n6-before.local"]').disabled), false);
    // Create an address through Add manually.
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
    await waitGone(page, '.toast', 15_000);
    await goTab(page, 'add');
    await fill(page, '#add-port', String(app.port));
    await fill(page, '#add-name', 'n6-unlocked');
    assert.equal(await exists(page, '#routes-reason-add'), false);
    await page.click('.add-card button[type=submit]');
    await toastText(page, 'n6-unlocked.local is ready.');
    await goTab(page, 'addresses');
    await waitText(page, addrRow(proxyUrl('n6-unlocked')), 'Live', 30_000);
    assert.deepEqual(routesFile().map((x) => x.hostname).sort(), ['n6-before.local', 'n6-unlocked.local']);
    const res = await waitUntil(async () => {
      const r = await throughProxy('n6-unlocked');
      return r.status === 200 && r.body.includes(MARKER) ? r : null;
    }, { timeout: 5000, interval: 50, what: 'n6-unlocked.local through the proxy' });
    assert.equal(res.headers['x-portless'], '1');
    assert.equal((await flagsOf(routesPath)) & 0x2, 0, 'still unlocked: Nidum Local never sets flags');
    assert.ok(statSync(routesPath).isFile());
    await sleep(250);
    saveShot('scenario-a3-unlocked.png', await page.screenshot());
    assert.deepEqual(unexpectedErrors(page, { allowApi: true }), [], 'console errors');
  });
});
