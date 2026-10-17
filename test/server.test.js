// N3: server lifecycle (session.json, ports, `node src/server.js`) and the
// live smoke test against an isolated Portless proxy (criterion 5).
//
// Live Portless use only through portlessTestEnv() + createPortless({ safeMode: true });
// NIDUM_HOME is always a temp dir. The guard snapshot is compared at the end.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPortless, findPortless } from '../src/portless.js';
import { startServer, listenWithFallback, DEFAULT_PORT } from '../src/server.js';
import { readSession, removeSession, writeSession } from '../src/state.js';
import * as discovery from '../src/discovery.js';
import * as network from '../src/network.js';
import { createFakeAdapter, createFakeDiscovery, createFakeNetwork } from './helpers/mock-api.js';
import { portlessTestEnv } from './helpers/portless-env.js';
import { freePort, startThrowawayHttp } from './helpers/net.js';
import { snapshot as guardSnapshot, compare as guardCompare } from './helpers/guard.js';

const execFileP = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = findPortless();

function get(port, p, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    const data = body === undefined ? null : JSON.stringify(body);
    if (data !== null) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${p}`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function waitUntil(fn, ms = 5000, step = 50) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, step));
  }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-home-'));
}

function fakes() {
  return { adapter: createFakeAdapter({ routes: [] }), discovery: createFakeDiscovery([]), network: createFakeNetwork() };
}

const guardBefore = guardSnapshot();
after(() => {
  assert.deepEqual(guardCompare(guardBefore, guardSnapshot()), [], 'real Portless / Nidum state changed');
});

describe('session.json and health (Contracts §4)', () => {
  it('is written atomically after listen: one line, fixed key order, mode 600; launcher sed lines work; deleted on close', async () => {
    const home = tempHome();
    const s = await startServer({ ...fakes(), home, port: 0, log: () => {} });
    try {
      const file = path.join(home, 'session.json');
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(text.split('\n').filter(Boolean).length, 1);
      assert.match(text, /^\{"port":\d+,"token":"[0-9a-f]{64}","pid":\d+,"startedAt":"[^"]+","version":"1\.0\.0"\}\n$/);
      const json = JSON.parse(text);
      assert.deepEqual(Object.keys(json), ['port', 'token', 'pid', 'startedAt', 'version']);
      assert.equal(json.port, s.port);
      assert.equal(json.pid, process.pid);
      assert.equal(json.token, s.token);
      assert.equal(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
      // the launcher's exact sed lines (bash 3.2, no jq)
      const port = (await execFileP('/usr/bin/sed', ['-n', 's/.*"port":\\([0-9]*\\).*/\\1/p', file])).stdout.trim();
      const token = (await execFileP('/usr/bin/sed', ['-n', 's/.*"token":"\\([0-9a-f]*\\)".*/\\1/p', file])).stdout.trim();
      assert.equal(Number(port), s.port);
      assert.equal(token, s.token);
      const h = await get(s.port, '/api/health');
      assert.deepEqual(h.json, { ok: true, app: 'nidum-local', version: '1.0.0', pid: json.pid });
      const st = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
      assert.deepEqual(Object.keys(JSON.parse(st)), ['version', 'names', 'settings', 'dismissed']);
    } finally {
      await s.close();
    }
    assert.equal(fs.existsSync(path.join(home, 'session.json')), false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removeSession leaves a newer server’s session alone', () => {
    const home = tempHome();
    try {
      writeSession(home, { port: 1, token: 'a'.repeat(64), pid: 999999, startedAt: new Date().toISOString(), version: '1.0.0' });
      assert.equal(removeSession(home, process.pid), false);
      assert.equal(readSession(home).pid, 999999);
      assert.equal(removeSession(home, 999999), true);
      assert.equal(readSession(home), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds 127.0.0.1 only and falls back to the next free port', async () => {
    assert.equal(DEFAULT_PORT, 47800);
    const busy = net.createServer();
    const start = await freePort({ min: 30000 });
    await new Promise((r) => busy.listen(start, '127.0.0.1', r));
    const home = tempHome();
    const s = await startServer({ ...fakes(), home, env: { ...process.env, NIDUM_PORT: String(start) }, log: () => {} });
    try {
      assert.notEqual(s.port, start);
      assert.ok(s.port > start && s.port <= start + 20, `got ${s.port}`);
      assert.equal(s.server.address().address, '127.0.0.1');
      assert.equal(readSession(home).port, s.port);
    } finally {
      await s.close();
      await new Promise((r) => busy.close(r));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('listenWithFallback(0) picks any free port', async () => {
    const srv = http.createServer();
    const port = await listenWithFallback(srv, 0);
    assert.ok(port > 0);
    await new Promise((r) => srv.close(r));
  });
});

describe('node src/server.js (criterion 6)', () => {
  let t;
  before(async () => {
    t = await portlessTestEnv(); // no proxy is started; isolates the adapter's state dir
  });
  after(() => t.cleanup());

  async function launch(home, port) {
    const env = { ...t.env, NIDUM_HOME: home, NIDUM_PORT: String(port), NIDUM_SAFE_MODE: '1', NIDUM_READ_ONLY: '1' };
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    exited.then(() => clearTimeout(killer));
    await waitUntil(() => out.includes('running') || child.exitCode !== null, 15000);
    return { child, exited, out: () => out, err: () => err };
  }

  it('starts, prints its URL (no token when not a TTY), stops on SIGTERM and removes session.json', async () => {
    const home = tempHome();
    const port = await freePort({ min: 30000 });
    const p = await launch(home, port);
    try {
      assert.match(p.out(), new RegExp(`running \\(read-only\\) at http://127\\.0\\.0\\.1:${port}/`));
      const session = readSession(home);
      assert.equal(session.pid, p.child.pid);
      assert.equal(session.port, port);
      assert.ok(!p.out().includes(session.token), 'token never printed to a non-TTY');
      const h = await get(port, '/api/health');
      assert.equal(h.json.pid, session.pid);
      const st = await get(port, '/api/state', { 'x-nidum-token': session.token });
      assert.equal(st.status, 200);
      assert.equal(st.json.proxy.port, t.port);
      assert.equal(st.json.proxy.running, false);
      const ro = await get(port, '/api/routes', { 'x-nidum-token': session.token }, 'POST', { name: 'x', port: 3000 });
      assert.equal(ro.status, 403);
      p.child.kill('SIGTERM');
      const { code } = await p.exited;
      assert.equal(code, 0);
      assert.equal(fs.existsSync(path.join(home, 'session.json')), false);
    } finally {
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/quit → 202, session.json deleted, exit 0', async () => {
    const home = tempHome();
    const port = await freePort({ min: 30000 });
    const p = await launch(home, port);
    try {
      const session = readSession(home);
      const r = await get(port, '/api/quit', { 'x-nidum-token': session.token }, 'POST', {});
      assert.equal(r.status, 202);
      const { code } = await p.exited;
      assert.equal(code, 0);
      assert.equal(fs.existsSync(path.join(home, 'session.json')), false);
      assert.equal(p.err().trim(), '');
    } finally {
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('live smoke: real server + real adapter (safeMode) + isolated proxy (criterion 5)', { skip: !REAL && 'Portless is not installed', timeout: 120000 }, () => {
  let t;
  let adapter;
  let server;
  let app;
  let home;
  const cookie = () => `nidum_session=${server.token}`;

  before(async () => {
    t = await portlessTestEnv();
    home = tempHome();
    adapter = createPortless({ env: t.env, safeMode: true });
    const started = await adapter.startProxy({ tls: false, port: t.port, lan: false });
    assert.equal(started.running, true);
    assert.equal(started.managedBy, 'manual');
    app = await startThrowawayHttp({ title: 'N3 smoke', body: 'n3-smoke-body' });
    server = await startServer({
      adapter,
      discovery,
      network,
      home,
      port: 0,
      log: () => {},
      onQuit: () => {},
      app: { lanMode: false, intervals: { core: 300, services: 1000, probes: 500, network: 2000, heartbeat: 2000 } },
    });
  });

  after(async () => {
    try {
      await server?.close();
    } finally {
      try {
        await adapter.run(['proxy', 'stop', '-p', String(t.port)], { timeout: 15000 });
      } catch {
        /* already stopped */
      }
      await app?.close();
      t.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('seeds settings from the isolated proxy and reports it', async () => {
    const st = await get(server.port, '/api/state', { cookie: cookie() });
    assert.equal(st.status, 200);
    assert.equal(st.json.proxy.running, true);
    assert.equal(st.json.proxy.port, t.port);
    assert.equal(st.json.proxy.tls, false);
    assert.equal(st.json.proxy.managedBy, 'manual');
    assert.deepEqual(st.json.settings, { tls: false, port: t.port, fixedIp: null, wildcard: false, keepAfterRestart: false, restartNeeded: false, serviceReinstallNeeded: false });
    assert.equal(st.json.capabilities.pause.supported, true);
    assert.equal(st.json.capabilities.deviceSetup.supported, false);
    assert.equal(st.json.versions.portless, REAL.version);
  });

  it('creates an address for a throwaway server → live; reachable through the proxy; host check ok', async () => {
    const name = `n3-smoke-${process.pid}`;
    const r = await get(server.port, '/api/routes', { cookie: cookie() }, 'POST', { name, port: app.port });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.url, `http://${name}.local:${t.port}`);
    assert.equal(r.json.source, 'nidum');
    const routes = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'routes.json'), 'utf8'));
    assert.deepEqual(routes.find((x) => x.hostname === `${name}.local`), { hostname: `${name}.local`, port: app.port, pid: 0 });
    const live = await waitUntil(async () => {
      const s = (await get(server.port, '/api/state', { cookie: cookie() })).json;
      const route = s.routes.find((x) => x.name === name);
      return route?.status === 'live' ? route : null;
    }, 10000, 200);
    assert.equal(live.statusDetail.httpStatus, 200);
    const through = await waitUntil(async () => {
      const res = await get(t.port, '/', { host: `${name}.local:${t.port}` });
      return res.status === 200 ? res : null;
    }, 5000, 100);
    assert.match(through.text, /n3-smoke-body/);
    const check = await get(server.port, `/api/routes/${name}/check`, { cookie: cookie() }, 'POST', {});
    assert.equal(check.status, 200);
    assert.equal(check.json.result, 'ok', JSON.stringify(check.json));
    // the throwaway shows up in Discover with routeName
    const svc = await waitUntil(async () => {
      const services = (await get(server.port, '/api/services', { cookie: cookie() })).json;
      return services.find((x) => x.port === app.port);
    }, 8000, 250);
    assert.equal(svc.routeName, name);
    assert.equal(svc.hidden, null);
    const dash = (await get(server.port, '/api/services', { cookie: cookie() })).json.find((x) => x.port === server.port);
    if (dash) assert.equal(dash.hidden, 'nidum-dashboard');
    const del = await get(server.port, `/api/routes/${name}`, { cookie: cookie() }, 'DELETE', {});
    assert.equal(del.status, 200);
    assert.equal(del.json.removed.name, name);
    const after = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'routes.json'), 'utf8'));
    assert.equal(after.some((x) => x.hostname === `${name}.local`), false);
  });

  it('a Vite-like app that blocks the name: the check right after POST /api/routes says host-blocked with the Vite fix (N6 finding 1)', async () => {
    const vite = http.createServer((req, res) => {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== 'localhost' && host !== '127.0.0.1') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end(`Blocked request. This host ("${host}") is not allowed.\nTo allow this host, add "${host}" to \`server.allowedHosts\` in vite.config.js.`);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><script type="module" src="/@vite/client"></script><title>Vite App</title>');
    });
    await new Promise((r) => vite.listen(0, '127.0.0.1', r));
    const name = `n3-vite-${process.pid}`;
    try {
      for (let round = 0; round < 2; round += 1) {
        const created = await get(server.port, '/api/routes', { cookie: cookie() }, 'POST', { name, port: vite.address().port });
        assert.equal(created.status, 201);
        // immediately, like the UI does (Portless loads the route ~100 ms later)
        const check = await get(server.port, `/api/routes/${name}/check`, { cookie: cookie() }, 'POST', {});
        assert.equal(check.status, 200);
        assert.equal(check.json.result, 'host-blocked', JSON.stringify(check.json));
        assert.equal(check.json.framework, 'Vite');
        assert.equal(check.json.fix, "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.");
        const stored = (await get(server.port, '/api/routes', { cookie: cookie() })).json.find((x) => x.name === name);
        assert.equal(stored.hostCheck.result, 'host-blocked');
        assert.equal((await get(server.port, `/api/routes/${name}`, { cookie: cookie() }, 'DELETE', {})).status, 200);
      }
      // an unknown name through the real proxy: Portless's real 404 page is never ok
      const ghost = await get(t.port, '/', { host: `n3-nobody-${process.pid}.local:${t.port}` });
      assert.equal(ghost.status, 404);
      assert.ok(ghost.text.length > 64 * 1024 && ghost.text.lastIndexOf('No app registered for') > 64 * 1024);
    } finally {
      await new Promise((r) => vite.close(r));
    }
  });

  it('an app that 404s only for its .local name → host-blocked, not not-routed (N3 validation 4)', async () => {
    const vhost = http.createServer((req, res) => {
      const h = String(req.headers.host || '').replace(/:\d+$/, '');
      res.writeHead(h.endsWith('.local') ? 404 : 200, { 'content-type': 'text/plain' });
      res.end(h.endsWith('.local') ? 'unknown vhost' : 'home');
    });
    await new Promise((r) => vhost.listen(0, '127.0.0.1', r));
    const name = `n3-vhost-${process.pid}`;
    try {
      assert.equal((await get(server.port, '/api/routes', { cookie: cookie() }, 'POST', { name, port: vhost.address().port })).status, 201);
      const t0 = Date.now();
      const check = await get(server.port, `/api/routes/${name}/check`, { cookie: cookie() }, 'POST', {});
      assert.ok(Date.now() - t0 < 5500, `took ${Date.now() - t0} ms`);
      assert.equal(check.json.result, 'host-blocked', JSON.stringify(check.json));
      assert.equal(check.json.httpStatus, 404);
      assert.equal((await get(server.port, `/api/routes/${name}`, { cookie: cookie() }, 'DELETE', {})).status, 200);
    } finally {
      await new Promise((r) => vhost.close(r));
    }
  });

  it('a stopped app turns the address to waiting', async () => {
    const tmp = await startThrowawayHttp({ title: 'tmp' });
    const name = `n3-wait-${process.pid}`;
    assert.equal((await get(server.port, '/api/routes', { cookie: cookie() }, 'POST', { name, port: tmp.port })).status, 201);
    await waitUntil(async () => (await get(server.port, '/api/routes', { cookie: cookie() })).json.find((x) => x.name === name)?.status === 'live', 10000, 200);
    await tmp.close();
    await waitUntil(async () => (await get(server.port, '/api/routes', { cookie: cookie() })).json.find((x) => x.name === name)?.status === 'waiting', 10000, 200);
    assert.equal((await get(server.port, `/api/routes/${name}`, { cookie: cookie() }, 'DELETE', {})).status, 200);
  });

  it('an app listening only on ::1 (Vite’s localhost) shows as live (Contracts §5, P1)', async () => {
    const v6 = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('n3-v6');
    });
    try {
      await new Promise((r, j) => v6.once('error', j).listen(0, '::1', r));
    } catch {
      return; // no IPv6 loopback on this machine
    }
    const name = `n3-v6-${process.pid}`;
    try {
      assert.equal((await get(server.port, '/api/routes', { cookie: cookie() }, 'POST', { name, port: v6.address().port })).status, 201);
      const route = await waitUntil(async () => {
        const r = (await get(server.port, '/api/routes', { cookie: cookie() })).json.find((x) => x.name === name);
        return r?.status === 'live' ? r : null;
      }, 10000, 200);
      assert.equal(route.statusDetail.host, '::1');
      assert.equal((await get(server.port, `/api/routes/${name}`, { cookie: cookie() }, 'DELETE', {})).status, 200);
    } finally {
      await new Promise((r) => v6.close(r));
    }
  });

  it('pause and resume through the API (jobs) on the isolated proxy', async () => {
    const stop = await get(server.port, '/api/proxy/stop', { cookie: cookie() }, 'POST', {});
    assert.equal(stop.status, 202);
    const stopped = await waitUntil(async () => {
      const p = (await get(server.port, '/api/proxy', { cookie: cookie() })).json;
      return p.job?.id === stop.json.job.id && p.job.phase !== 'stopping' ? p : null;
    }, 20000, 200);
    assert.equal(stopped.job.phase, 'done', JSON.stringify(stopped.job));
    assert.equal(stopped.running, false);
    const start = await get(server.port, '/api/proxy/start', { cookie: cookie() }, 'POST', {});
    assert.equal(start.status, 202);
    const started = await waitUntil(async () => {
      const p = (await get(server.port, '/api/proxy', { cookie: cookie() })).json;
      return p.job?.id === start.json.job.id && p.job.phase !== 'starting' ? p : null;
    }, 30000, 200);
    assert.equal(started.job.phase, 'done', JSON.stringify(started.job));
    assert.equal(started.running, true);
    assert.equal(started.port, t.port);
    assert.equal((await get(server.port, '/api/settings', { cookie: cookie() })).json.restartNeeded, false, 'started by Nidum without --wildcard');
  });

  it('turning on "Allow any sub-name" asks to restart the running manual proxy (N6 repro)', async () => {
    const on = await get(server.port, '/api/settings', { cookie: cookie() }, 'PATCH', { wildcard: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.wildcard, true);
    assert.equal(on.json.restartNeeded, true);
    const off = await get(server.port, '/api/settings', { cookie: cookie() }, 'PATCH', { wildcard: false });
    assert.equal(off.json.restartNeeded, false);
  });
});

// E13 (D47/D48): a real `chflags uchg` on routes.json in a temp PORTLESS_STATE_DIR only.
// Nothing here touches ~/.portless; the flag is always cleared before the dir is removed.
describe('E13 integration: real adapter (safeMode) + temp PORTLESS_STATE_DIR with a locked routes.json', { skip: (process.platform !== 'darwin' && 'chflags is macOS only') || (!REAL && 'Portless is not installed'), timeout: 60000 }, () => {
  let t;
  let adapter;
  let server;
  let home;
  let file;
  const cookie = () => `nidum_session=${server.token}`;
  const call = (method, p, body) => get(server.port, p, { cookie: cookie() }, method, body);

  /** D53: the same keys with the same values, in the same order (deepStrictEqual ignores order). */
  function assertSameInOrder(actual, expected, what) {
    assert.deepStrictEqual(actual, expected, what);
    assert.deepStrictEqual(Object.keys(actual), Object.keys(expected), `${what}: key order`);
  }

  /** D59(d): a routes-* banner comes right after the sharing banner (or where it would be). */
  function assertBannerOrder(banners) {
    const ids = banners.map((b) => b.id);
    const order = ['portless-missing', 'first-run', 'sharing-paused', 'sharing-off', 'routes-locked', 'routes-not-writable', 'network-off', 'public-network'];
    assert.deepEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)), ids, `banner order: ${ids.join(', ')}`);
  }

  /** Refuse any path that isn't routes.json inside a fresh nidum-portless-* temp dir. */
  function assertTempRoutesFile(p) {
    const real = fs.realpathSync(p);
    const tmp = fs.realpathSync(os.tmpdir());
    const realPortless = path.join(os.homedir(), '.portless');
    assert.ok(real.startsWith(tmp + path.sep), `refusing to chflags outside the temp dir: ${real}`);
    assert.match(path.basename(path.dirname(real)), /^nidum-portless-/, `refusing to chflags ${real}`);
    assert.equal(path.basename(real), 'routes.json');
    assert.ok(!real.startsWith(realPortless) && !p.startsWith(realPortless), 'never the real ~/.portless');
  }
  async function chflags(flag) {
    assertTempRoutesFile(file);
    await execFileP('/usr/bin/chflags', [flag, file], { timeout: 5000 });
  }
  async function unlockIfPresent() {
    if (file && fs.existsSync(file)) await chflags('nouchg');
  }

  before(async () => {
    t = await portlessTestEnv();
    home = tempHome();
    file = path.join(t.stateDir, 'routes.json');
    adapter = createPortless({ env: t.env, safeMode: true });
    server = await startServer({ adapter, discovery: createFakeDiscovery([]), network: createFakeNetwork(), home, port: 0, log: () => {}, onQuit: () => {}, app: { lanMode: false } });
  });

  after(async () => {
    try {
      await unlockIfPresent(); // always, even when a test failed half-way
    } finally {
      try {
        await server?.close();
      } finally {
        t.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('every route write → 423 ROUTES_LOCKED with real details; routesAccess and the banner follow; unlocking + ?refresh=1 clears them', async () => {
    const created = await call('POST', '/api/routes', { name: 'locktest', port: 39017 });
    assert.equal(created.status, 201, created.text);
    assert.ok(fs.existsSync(file));
    const bytes = fs.readFileSync(file);
    const inode = fs.statSync(file).ino;
    try {
      await chflags('uchg');
      // D51/D53: the blocking path's owner is the account running the tests, so ownedByYou is true.
      // The error details and the banner details are the same facts, keys in the same order.
      const me = os.userInfo().username;
      const details = { path: file, flag: 'uchg', target: 'file', owner: me, ownedByYou: true };
      for (const [method, p, body] of [
        ['POST', '/api/routes', { name: 'second', port: 39018 }],
        ['PATCH', '/api/routes/locktest', { port: 39019 }],
        ['PATCH', '/api/routes/locktest', { newName: 'renamed' }],
        ['DELETE', '/api/routes/locktest', {}],
      ]) {
        const r = await call(method, p, body);
        assert.equal(r.status, 423, `${method} ${p}: ${r.text}`);
        assert.equal(r.json.error.code, 'ROUTES_LOCKED');
        assert.equal(r.json.error.message, "Your address list is locked, so Nidum Local can't change it.");
        assertSameInOrder(r.json.error.details, details, `${method} ${p} details`);
        assert.match(r.json.error.raw, /EPERM|operation not permitted/i);
      }
      assert.ok(fs.readFileSync(file).equals(bytes), 'routes.json unchanged');
      assert.equal(fs.statSync(file).ino, inode);
      assert.ok(!fs.existsSync(path.join(t.stateDir, 'routes.lock')), 'no lock left behind');
      const st = (await call('GET', '/api/state')).json;
      assertSameInOrder(st.routesAccess, { locked: true, flag: 'uchg', target: 'file', writable: false, path: file, owner: me, ownedByYou: true }, 'routesAccess');
      const banner = st.banners.find((b) => b.id === 'routes-locked');
      assert.ok(banner, JSON.stringify(st.banners));
      assert.equal(banner.kind, 'error');
      assertSameInOrder(banner.details, details, 'banner details');
      assertBannerOrder(st.banners);
      assert.equal((await call('PATCH', '/api/ui', { dismiss: 'routes-locked' })).status, 400);
    } finally {
      await chflags('nouchg');
    }
    const unlocked = { locked: false, flag: null, target: null, writable: true, path: file, owner: null, ownedByYou: null };
    const fresh = (await call('GET', '/api/state?refresh=1')).json;
    assertSameInOrder(fresh.routesAccess, unlocked, 'routesAccess after unlocking');
    assert.ok(!fresh.banners.some((b) => b.id.startsWith('routes-')));
    const again = await call('POST', '/api/routes', { name: 'second', port: 39018 });
    assert.equal(again.status, 201, again.text);

    // D51: your own file with read-only mode bits → ROUTES_NOT_WRITABLE, ownedByYou true (the chmod u+w copy)
    assertTempRoutesFile(file);
    fs.chmodSync(file, 0o444);
    try {
      const me = os.userInfo().username;
      const r = await call('POST', '/api/routes', { name: 'third', port: 39020 });
      assert.equal(r.status, 423, r.text);
      assert.equal(r.json.error.code, 'ROUTES_NOT_WRITABLE');
      const details = { path: file, target: 'file', owner: me, ownedByYou: true };
      const access = { locked: false, flag: null, target: 'file', writable: false, path: file, owner: me, ownedByYou: true };
      // D53: `target` is in the ROUTES_NOT_WRITABLE details and in a not-locked getRoutesAccess answer
      // (N1 iteration 10); strict, no tolerance left (N3 validation 8 F2)
      assertSameInOrder(r.json.error.details, details, 'error details');
      const st = (await call('GET', '/api/state')).json;
      assertSameInOrder(st.routesAccess, access, 'routesAccess');
      const banner = st.banners.find((b) => b.id === 'routes-not-writable');
      assert.ok(banner, JSON.stringify(st.banners));
      assertSameInOrder(banner.details, details, 'banner details');
      assertSameInOrder(banner.details, r.json.error.details, 'banner details = error details');
      assertBannerOrder(st.banners);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assertSameInOrder((await call('GET', '/api/state?refresh=1')).json.routesAccess, unlocked, 'routesAccess after chmod 0644');
    assert.equal((await call('DELETE', '/api/routes/locktest', {})).status, 200);
  });
});
