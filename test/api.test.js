// N3: the JSON API, security rules and SSE against fake adapter, discovery and
// network (dependency injection). No Portless process is ever started here.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, PortlessError } from '../src/portless.js';
import { ERROR_STATUS, CSP, apiCodeFor, toErrorResponse, DOCTOR_GLYPHS, CLEAN_REMOVES } from '../src/api.js';
import {
  StateStore,
  bannersView,
  capabilitiesView,
  hostCheck,
  probeRoutePort,
  safeSuggestedName,
  seedSettings,
  sessionLine,
  settingsView,
  sortRoutes,
  PAUSE_SERVICE_REASON,
  INTERNET_SHARING_REASON,
  normalizeRoutesAccess,
  routesAccessBanner,
  ROUTES_LOCKED_MESSAGE,
  ROUTES_NOT_WRITABLE_MESSAGE,
} from '../src/state.js';
import { createDeviceSetup } from '../src/setup-device.js';
import { validateName } from '../src/portless.js';
import { FIXTURE_NETWORKS, SCENARIO_NAMES, createFakeAdapter, createFakeDiscovery, createFakeNetwork, startMockApi } from './helpers/mock-api.js';
import { startThrowawayHttp, startThrowawayTcp, freePort } from './helpers/net.js';
import { snapshot as guardSnapshot, compare as guardCompare } from './helpers/guard.js';

const FAST = { core: 100, services: 150, probes: 150, network: 150, heartbeat: 250 };

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

function request(port, method, p, { headers = {}, body, raw, token, cookie, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: host ?? `127.0.0.1:${port}`, ...headers };
    if (token) h['x-nidum-token'] = token;
    if (cookie) h.cookie = cookie;
    let data = null;
    if (body !== undefined) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      if (!('content-type' in h)) h['content-type'] = 'application/json';
    } else if (raw !== undefined) data = raw;
    if (data !== null) h['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
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
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${method} ${p}`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function api(mock) {
  const t = mock.token;
  return {
    get: (p, o = {}) => request(mock.port, 'GET', p, { token: t, ...o }),
    post: (p, body = {}, o = {}) => request(mock.port, 'POST', p, { token: t, body, ...o }),
    patch: (p, body = {}, o = {}) => request(mock.port, 'PATCH', p, { token: t, body, ...o }),
    del: (p, o = {}) => request(mock.port, 'DELETE', p, { token: t, body: {}, ...o }),
  };
}

function sse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers }, agent: false }, (res) => {
      const events = [];
      let buf = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (!m) continue;
            ev[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
          }
          if (ev.event) {
            ev.id = Number(ev.id);
            events.push(ev);
          }
        }
      });
      res.on('end', () => {
        ended = true;
      });
      res.on('error', () => {});
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        get ended() {
          return ended;
        },
        async waitFor(pred, ms = 3000, from = 0) {
          const deadline = Date.now() + ms;
          for (;;) {
            const e = events.slice(from).find(pred);
            if (e) return e;
            if (Date.now() > deadline) throw new Error(`event not seen within ${ms} ms; got ${events.map((x) => x.event).join(',')}`);
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

async function waitUntil(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function readState(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
}

const guardBefore = guardSnapshot();
after(() => {
  assert.deepEqual(guardCompare(guardBefore, guardSnapshot()), [], 'real Portless / Nidum state changed');
});

// ---------------------------------------------------------------------------
// Error mapping (Contracts §7)
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('maps every adapter error code to exactly one HTTP status', () => {
    for (const code of ERROR_CODES) {
      const apiCode = apiCodeFor(code);
      assert.ok(Object.prototype.hasOwnProperty.call(ERROR_STATUS, apiCode), `${code} has no mapping`);
      const { status, body } = toErrorResponse(new PortlessError(code, undefined, { raw: 'raw out' }));
      assert.equal(status, ERROR_STATUS[apiCode], code);
      assert.equal(body.error.code, apiCode);
      assert.equal(typeof body.error.message, 'string');
    }
  });

  it('pins the Contracts §7 statuses', () => {
    const expected = {
      BAD_REQUEST: 400, INVALID_NAME: 400, INVALID_PORT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
      NAME_TAKEN: 409, NAME_TAKEN_BY_APP: 409, SERVICE_MANAGED: 409, PORT_IN_USE: 409, BUSY: 409, UNSUPPORTED_MEDIA_TYPE: 415,
      UNSUPPORTED: 422, PERMISSION: 423, ROUTES_LOCKED: 423, ROUTES_NOT_WRITABLE: 423, PROXY_DOWN: 502, CLI_MISSING: 502, STATE_UNREADABLE: 503, TIMEOUT: 504, INTERNAL: 500,
    };
    assert.deepEqual({ ...ERROR_STATUS }, expected);
    assert.equal(apiCodeFor('UNKNOWN'), 'INTERNAL');
    const unknown = toErrorResponse(new PortlessError('UNKNOWN', undefined, { raw: 'boom' }));
    assert.deepEqual(unknown, { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Nothing was changed.', raw: 'boom' } } });
    const unreadable = toErrorResponse(Object.assign(new Error('x'), { code: 'STATE_UNREADABLE' }));
    assert.equal(unreadable.status, 503);
    assert.equal(unreadable.body.error.message, 'Couldn’t read the address list just now. Try again.');
    const plain = toErrorResponse(new TypeError('kaput'));
    assert.equal(plain.status, 500);
    assert.equal(plain.body.error.raw, 'kaput');
  });
});

// ---------------------------------------------------------------------------
// Pure state helpers
// ---------------------------------------------------------------------------

describe('state helpers', () => {
  it('sessionLine has the fixed key order on one line', () => {
    const line = sessionLine({ version: '1.0.0', pid: 5, token: 'a'.repeat(64), port: 47800, startedAt: '2026-10-15T07:00:00.000Z' });
    assert.equal(line, `{"port":47800,"token":"${'a'.repeat(64)}","pid":5,"startedAt":"2026-10-15T07:00:00.000Z","version":"1.0.0"}\n`);
  });

  it('seeds settings from reality (F1)', () => {
    const proxy = { running: true, port: 80, tls: false, wildcard: false, managedBy: 'service' };
    assert.deepEqual(seedSettings(proxy, { fixedIp: '10.0.0.5', wildcard: true }), { tls: false, port: 80, fixedIp: '10.0.0.5', wildcard: true, keepAfterRestart: true });
    assert.deepEqual(seedSettings({ running: false, port: 443, tls: true, wildcard: null, managedBy: null }, null), { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false });
  });

  it('computes restartNeeded and serviceReinstallNeeded', () => {
    const saved = { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: false };
    assert.equal(settingsView(saved, { running: true, tls: false, port: 80, wildcard: false, lanIp: '1.2.3.4', managedBy: 'manual' }, null).restartNeeded, false);
    assert.equal(settingsView({ ...saved, tls: true }, { running: true, tls: false, port: 80, wildcard: false, managedBy: 'manual' }, null).restartNeeded, true);
    assert.equal(settingsView({ ...saved, port: 8080 }, { running: false, tls: false, port: 80, managedBy: null }, null).restartNeeded, false);
    const svc = { tls: false, port: 80, fixedIp: null, wildcard: false };
    const managed = { running: true, tls: false, port: 80, managedBy: 'service' };
    assert.deepEqual(settingsView({ ...saved, keepAfterRestart: true }, managed, svc), { ...saved, keepAfterRestart: true, restartNeeded: false, serviceReinstallNeeded: false });
    assert.equal(settingsView({ ...saved, keepAfterRestart: true, tls: true }, managed, svc).serviceReinstallNeeded, true);
    assert.equal(settingsView({ ...saved, keepAfterRestart: true, tls: true }, managed, svc).restartNeeded, false);
  });

  it('capabilities and banners', () => {
    const caps = capabilitiesView({ tls: false, managedBy: 'service' }, 'win32');
    assert.deepEqual(caps.internetSharing, { supported: false, reason: INTERNET_SHARING_REASON });
    assert.equal(caps.deviceSetup.supported, false);
    assert.equal(typeof caps.deviceSetup.reason, 'string');
    assert.deepEqual(caps.pause, { supported: false, reason: PAUSE_SERVICE_REASON }, 'no service stop on Windows yet');
    for (const platform of ['darwin', 'linux']) {
      assert.deepEqual(capabilitiesView({ tls: false, managedBy: 'service' }, platform).pause, { supported: true, reason: null }, `E12 on ${platform}`);
    }
    assert.equal(capabilitiesView({ tls: true, managedBy: 'manual' }).deviceSetup.supported, true);
    assert.equal(capabilitiesView({ tls: true, managedBy: 'manual' }).pause.supported, true);
    const b = bannersView({ proxy: { running: false }, network: { ssid: 'Airport Free WiFi' }, dismissed: [], portlessInstalled: false });
    assert.deepEqual(b.map((x) => x.id), ['portless-missing', 'first-run', 'sharing-off', 'public-network']);
    assert.equal(b.find((x) => x.id === 'sharing-off').kind, 'error');
    const paused = bannersView({ proxy: { running: false }, network: null, dismissed: ['first-run'], portlessInstalled: true, pausedByUser: true });
    assert.deepEqual(paused, [{ id: 'sharing-paused', kind: 'info', message: 'Sharing is paused. Your addresses are offline until you resume.' }]);
    const b2 = bannersView({ proxy: { running: true, lan: true }, network: { ssid: 'Airport Free WiFi' }, dismissed: ['first-run', 'public-network:Airport Free WiFi'], portlessInstalled: true });
    assert.deepEqual(b2, []);
  });

  it('sorts routes error, live, waiting, unknown then by hostname', () => {
    const r = (hostname, status) => ({ hostname, status });
    const sorted = sortRoutes([r('b.local', 'unknown'), r('a.local', 'waiting'), r('c.local', 'live'), r('a2.local', 'live'), r('z.local', 'error')]);
    assert.deepEqual(sorted.map((x) => x.hostname), ['z.local', 'a2.local', 'c.local', 'a.local', 'b.local']);
  });

  it('runs suggestions through validateName and appends -app to reserved names (F11)', () => {
    assert.equal(safeSuggestedName('recipes', 5173, validateName), 'recipes');
    assert.equal(safeSuggestedName('list', 4000, validateName), 'list-app');
    assert.equal(safeSuggestedName('setup', 4000, validateName), 'setup-app');
    assert.equal(safeSuggestedName('', 4000, validateName), 'app-4000');
    assert.equal(safeSuggestedName('Bad_Name', 4001, validateName), 'app-4001');
  });

  it('StateStore seeds on first run and moves a corrupt file aside', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-store-'));
    try {
      const s = new StateStore(home);
      await s.load(() => ({ tls: false, port: 80, keepAfterRestart: true }));
      assert.equal(s.firstRun, true);
      const text = fs.readFileSync(path.join(home, 'state.json'), 'utf8');
      assert.deepEqual(JSON.parse(text), { version: 1, names: [], settings: { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: true }, dismissed: [] });
      assert.equal(fs.statSync(path.join(home, 'state.json')).mode & 0o777, 0o600);
      fs.writeFileSync(path.join(home, 'state.json'), '{ torn');
      const s2 = new StateStore(home);
      await s2.load(() => ({ tls: true, port: 443 }));
      assert.equal(s2.firstRun, true);
      assert.ok(s2.recoveredFrom && fs.existsSync(s2.recoveredFrom));
      const s3 = new StateStore(home);
      await s3.load(() => assert.fail('must not seed again'));
      assert.equal(s3.firstRun, false);
      assert.equal(s3.settings.port, 443);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Probes and host checks (local throwaway servers; no proxy)
// ---------------------------------------------------------------------------

describe('route probes', () => {
  it('live, error (5xx), waiting (refused), error (protocol)', async () => {
    const ok = await startThrowawayHttp();
    const bad = http.createServer((req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    const tcp = await startThrowawayTcp();
    const closed = await freePort();
    try {
      assert.deepEqual(await probeRoutePort(ok.port), { status: 'live', statusDetail: { httpStatus: 200, tls: false } });
      assert.deepEqual(await probeRoutePort(bad.address().port), { status: 'error', statusDetail: { httpStatus: 503, tls: false } });
      assert.equal((await probeRoutePort(closed)).status, 'waiting');
      assert.equal((await probeRoutePort(tcp.port, { timeout: 1000 })).status, 'error');
    } finally {
      await ok.close();
      await new Promise((r) => bad.close(r));
      await tcp.close();
    }
  });

  it('a server that accepts but never answers counts as live (slow)', async () => {
    const sockets = new Set();
    const srv = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const res = await probeRoutePort(srv.address().port, { timeout: 300 });
      assert.equal(res.status, 'live');
      assert.equal(res.statusDetail.slow, true);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('host check through a (fake) proxy', () => {
  let proxy;
  let port;
  const pages = {
    'routed.local': [200, { 'content-type': 'text/html' }, '<title>ok</title>'],
    'missing.local': [404, { 'content-type': 'text/html' }, '<p class="desc">No app registered for <strong>missing.local</strong></p>'],
    'down.local': [502, { 'content-type': 'text/html' }, '<h1>Bad Gateway</h1><p>The target app is not responding.</p>'],
    'vite.local': [403, { 'content-type': 'text/plain' }, 'Blocked request. This host ("vite.local") is not allowed.\nTo allow this host, add "vite.local" to `server.allowedHosts` in vite.config.js.'],
    'django.local': [400, { 'content-type': 'text/html' }, "DisallowedHost at / Invalid HTTP_HOST header: 'django.local'. You may need to add 'django.local' to ALLOWED_HOSTS."],
    'redir.local': [302, { location: 'http://localhost:3000/login' }, ''],
    'next.local': [200, { 'x-powered-by': 'Next.js' }, '<div id="__next"></div>'],
    'boom.local': [500, {}, 'oops'],
  };
  before(async () => {
    proxy = http.createServer((req, res) => {
      const host = String(req.headers.host).split(':')[0];
      const [status, headers, body] = pages[host] || [404, {}, 'No app registered for x'];
      res.writeHead(status, { 'x-portless': '1', ...headers });
      res.end(body);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    port = proxy.address().port;
  });
  after(() => new Promise((r) => proxy.close(r)));

  const check = (hostname) => hostCheck({ route: { hostname, port: 1234, url: `http://${hostname}:${port}` }, proxy: { port, tls: false } });

  it('classifies by status and body, not X-Portless', async () => {
    assert.equal((await check('routed.local')).result, 'ok');
    assert.equal((await check('missing.local')).result, 'not-routed');
    assert.equal((await check('down.local')).result, 'app-down');
    const vite = await check('vite.local');
    assert.equal(vite.result, 'host-blocked');
    assert.equal(vite.framework, 'Vite');
    assert.match(vite.fix, /allowedHosts/);
    const dj = await check('django.local');
    assert.equal(dj.framework, 'Django');
    assert.match(dj.fix, /ALLOWED_HOSTS/);
    const redir = await check('redir.local');
    assert.equal(redir.result, 'redirect-localhost');
    assert.match(redir.message, /localhost/);
    const next = await check('next.local');
    assert.equal(next.result, 'ok');
    assert.equal(next.framework, 'Next.js');
    assert.match(next.fix, /allowedDevOrigins/);
    assert.equal((await check('boom.local')).result, 'app-error');
  });

  it('reports proxy-down when nothing listens', async () => {
    const closed = await freePort();
    const res = await hostCheck({ route: { hostname: 'x.local', port: 1, url: 'http://x.local' }, proxy: { port: closed, tls: false } });
    assert.equal(res.result, 'proxy-down');
    assert.equal((await hostCheck({ route: { hostname: 'x.local' }, proxy: null })).result, 'proxy-down');
  });
});

// ---------------------------------------------------------------------------
// HTTP: security (criterion 2)
// ---------------------------------------------------------------------------

describe('security', () => {
  let mock;
  let publicDir;
  before(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-public-'));
    publicDir = path.join(root, 'public');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Dash</title>');
    fs.writeFileSync(path.join(publicDir, 'app.js'), 'export {};');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(publicDir, 'link.txt'));
    mock = await startMockApi({ app: { publicDir, intervals: FAST } });
  });
  after(async () => {
    await mock.close();
    fs.rmSync(path.dirname(publicDir), { recursive: true, force: true });
  });

  it('GET / without a cookie → 401 HTML page', async () => {
    const r = await request(mock.port, 'GET', '/');
    assert.equal(r.status, 401);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.text, /Open Nidum Local from its launcher again\./);
  });

  it('/api without auth → 401 JSON; /api/health needs none', async () => {
    const r = await request(mock.port, 'GET', '/api/state');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    const h = await request(mock.port, 'GET', '/api/health');
    assert.equal(h.status, 200);
    assert.deepEqual(h.json, { ok: true, app: 'nidum-local', version: '1.0.0', pid: process.pid });
  });

  it('wrong token → 401 (query, header and cookie)', async () => {
    assert.equal((await request(mock.port, 'GET', '/?t=deadbeef')).status, 401);
    assert.match((await request(mock.port, 'GET', `/?t=${'0'.repeat(64)}`)).text, /launcher again/);
    assert.equal((await request(mock.port, 'GET', '/api/state', { headers: { 'x-nidum-token': 'nope' } })).status, 401);
    assert.equal((await request(mock.port, 'GET', '/api/state', { cookie: 'nidum_session=nope' })).status, 401);
  });

  it('?t=<token> sets the HttpOnly SameSite=Strict cookie and 302s to /', async () => {
    const r = await request(mock.port, 'GET', `/?t=${mock.token}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    assert.deepEqual(r.headers['set-cookie'], [`nidum_session=${mock.token}; HttpOnly; SameSite=Strict; Path=/`]);
    const cookie = `nidum_session=${mock.token}`;
    const page = await request(mock.port, 'GET', '/', { cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Dash<\/title>/);
    const st = await request(mock.port, 'GET', '/api/state', { cookie });
    assert.equal(st.status, 200);
    const js = await request(mock.port, 'GET', '/app.js', { cookie });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    // the token keeps working for the life of the process (not one-time, D6)
    assert.equal((await request(mock.port, 'GET', `/?t=${mock.token}`)).status, 302);
  });

  it('Host must be 127.0.0.1:<port> or localhost:<port>', async () => {
    const other = mock.port === 65535 ? 65534 : mock.port + 1;
    const r = await request(mock.port, 'GET', '/api/state', { token: mock.token, host: `127.0.0.1:${other}` });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'FORBIDDEN');
    assert.equal((await request(mock.port, 'GET', '/api/health', { host: 'evil.example' })).status, 403);
    assert.equal((await request(mock.port, 'GET', '/', { host: `nidum.local:${mock.port}` })).status, 403);
    assert.equal((await request(mock.port, 'GET', '/api/state', { token: mock.token, host: `localhost:${mock.port}` })).status, 200);
  });

  it('foreign Origin or Sec-Fetch-Site cross-site → 403 even with a valid cookie', async () => {
    const cookie = `nidum_session=${mock.token}`;
    const evil = await request(mock.port, 'GET', '/api/state', { cookie, headers: { origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'FORBIDDEN');
    const otherPort = await request(mock.port, 'POST', '/api/routes', { cookie, headers: { origin: 'http://127.0.0.1:3000' }, body: { name: 'x', port: 1 } });
    assert.equal(otherPort.status, 403);
    assert.equal((await request(mock.port, 'GET', '/api/state', { cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request(mock.port, 'GET', '/', { cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request(mock.port, 'GET', '/api/state', { cookie, headers: { origin: `http://127.0.0.1:${mock.port}`, 'sec-fetch-site': 'same-origin' } })).status, 200);
  });

  it('/api/events without a cookie → 401', async () => {
    const r = await request(mock.port, 'GET', '/api/events');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
  });

  it('no traversal out of public/ → 404', async () => {
    const cookie = `nidum_session=${mock.token}`;
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/link.txt', '/.%2e/secret.txt', '/nope.js', '/%00']) {
      const r = await request(mock.port, 'GET', p, { cookie });
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /SECRET/, p);
    }
  });

  it('mutations need Content-Type: application/json → 415', async () => {
    for (const [method, p] of [['POST', '/api/routes'], ['PATCH', '/api/settings'], ['DELETE', '/api/routes/recipes'], ['POST', '/api/quit']]) {
      const r = await request(mock.port, method, p, { token: mock.token, raw: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(r.status, 415, `${method} ${p}`);
      assert.equal(r.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const noType = await request(mock.port, 'POST', '/api/routes', { token: mock.token, raw: '{"name":"x","port":1}' });
    assert.equal(noType.status, 415);
  });

  it('bad JSON → 400 BAD_REQUEST; unknown endpoint → 404', async () => {
    const r = await request(mock.port, 'POST', '/api/routes', { token: mock.token, body: '{nope' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'BAD_REQUEST');
    const arr = await request(mock.port, 'POST', '/api/routes', { token: mock.token, body: '[1]' });
    assert.equal(arr.status, 400);
    const nf = await api(mock).get('/api/nothing');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'NOT_FOUND');
  });

  it('security headers on every response; no-store on /api', async () => {
    for (const r of [await api(mock).get('/api/state'), await request(mock.port, 'GET', '/'), await request(mock.port, 'GET', '/api/health')]) {
      assert.equal(r.headers['content-security-policy'], CSP);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal(CSP, "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'");
    assert.equal((await api(mock).get('/api/state')).headers['cache-control'], 'no-store');
  });

  it('serves a placeholder page when public/index.html is missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-empty-public-'));
    const m = await startMockApi({ app: { publicDir: empty } });
    try {
      const r = await request(m.port, 'GET', '/', { token: m.token });
      assert.equal(r.status, 200);
      assert.match(r.text, /dashboard page isn’t installed/);
    } finally {
      await m.close();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP: state, routes, services
// ---------------------------------------------------------------------------

describe('GET /api/state (Contracts §5)', () => {
  let mock;
  before(async () => {
    mock = await startMockApi({ scenario: 'mac-service', app: { intervals: FAST } });
  });
  after(() => mock.close());

  it('has every top-level key with the pinned shapes', async () => {
    await mock.app.live.warm();
    const { json: s, status } = await api(mock).get('/api/state');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(s).sort(), ['banners', 'capabilities', 'network', 'proxy', 'routes', 'routesAccess', 'routesUnavailable', 'scannedAt', 'services', 'settings', 'updatedAt', 'versions'].sort());
    // E13: unlocked and writable outside the routes-locked scenarios
    assert.deepEqual(s.routesAccess, { locked: false, flag: null, target: null, writable: true, path: '/fake/.portless/routes.json', owner: null, ownedByYou: null });
    for (const k of ['running', 'pid', 'port', 'tls', 'lan', 'lanIp', 'tlds', 'wildcard', 'elevated', 'managedBy', 'baseUrl']) assert.ok(k in s.proxy, k);
    assert.equal(s.proxy.baseUrl, 'http://127.0.0.1:80');
    for (const r of s.routes) {
      for (const k of ['name', 'hostname', 'url', 'port', 'kind', 'pid', 'foreignTld', 'source', 'status', 'statusDetail', 'hostCheck', 'createdAt']) assert.ok(k in r, `${r.hostname} ${k}`);
    }
    assert.deepEqual(Object.keys(s.settings).sort(), ['fixedIp', 'keepAfterRestart', 'port', 'restartNeeded', 'serviceReinstallNeeded', 'tls', 'wildcard'].sort());
    assert.deepEqual(Object.keys(s.capabilities).sort(), ['deviceSetup', 'internetSharing', 'pause']);
    assert.deepEqual(Object.keys(s.versions).sort(), ['nidum', 'node', 'portless']);
    assert.equal(s.versions.portless, '0.15.6');
    assert.deepEqual(Object.keys(s.network).sort(), ['interface', 'interfaces', 'ip', 'kind', 'ssid']);
    assert.ok(!Number.isNaN(Date.parse(s.updatedAt)));
  });

  it('service-managed: first-run seeding matches the fake proxy; pause supported via the service (E12, D43)', async () => {
    const { json: s } = await api(mock).get('/api/state');
    assert.deepEqual(readState(mock.home).settings, { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: true });
    assert.deepEqual(s.settings, { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: true, restartNeeded: false, serviceReinstallNeeded: false });
    assert.deepEqual(s.capabilities.pause, { supported: true, reason: null });
    assert.equal(s.proxy.serviceLoaded, true);
    assert.deepEqual(s.capabilities.internetSharing, { supported: false, reason: "Sharing outside your network isn't available for addresses added here yet." });
    assert.equal(s.capabilities.deviceSetup.supported, false);
  });

  it('decorates routes: source, status, foreignTld, sort order', async () => {
    const { json: s } = await api(mock).get('/api/state');
    const by = Object.fromEntries(s.routes.map((r) => [r.hostname, r]));
    assert.equal(by['plex.local'].source, 'cli');
    assert.equal(by['shop.local'].source, 'app');
    assert.equal(by['shop.local'].kind, 'app');
    assert.equal(by['old.localhost'].foreignTld, true);
    assert.equal(by['old.localhost'].name, 'old.localhost');
    assert.equal(by['plex.local'].url, 'http://plex.local');
    assert.equal(s.routesUnavailable, false);
    assert.equal(by['plex.local'].status, 'live');
    assert.equal(by['jupyter.local'].status, 'live');
    assert.equal(by['old.localhost'].status, 'waiting');
    const order = { error: 0, live: 1, waiting: 2, unknown: 3 };
    for (let i = 1; i < s.routes.length; i += 1) {
      const a = s.routes[i - 1];
      const b = s.routes[i];
      assert.ok(order[a.status] < order[b.status] || (order[a.status] === order[b.status] && a.hostname < b.hostname), `${a.hostname} before ${b.hostname}`);
    }
  });

  it('services: routeName, validated suggestions, dashboard port hidden option passed', async () => {
    const { json: services } = await api(mock).get('/api/services');
    const by = Object.fromEntries(services.map((x) => [x.port, x]));
    assert.equal(by[8888].routeName, 'jupyter');
    assert.equal(by[5173].routeName, null);
    assert.equal(by[4000].suggestedName, 'list-app');
    assert.equal(by[5173].suggestedName, 'recipes');
    assert.equal(mock.discovery.lastOptions.dashboardPort, mock.port);
    assert.equal(mock.discovery.lastOptions.proxyPort, 80);
    // the cached scan result is not mutated by decoration
    assert.equal(mock.discovery.services.find((x) => x.port === 4000).suggestedName, 'list');
  });

  it('sub-resources /api/routes, /api/proxy, /api/network, /api/settings', async () => {
    const c = api(mock);
    assert.ok(Array.isArray((await c.get('/api/routes')).json));
    assert.equal((await c.get('/api/proxy')).json.managedBy, 'service');
    assert.equal((await c.get('/api/network')).json.ip, '192.168.68.119');
    assert.equal((await c.get('/api/settings')).json.port, 80);
  });

  it('service-managed: proxy restart → 409 SERVICE_MANAGED (E12)', async () => {
    const r = await api(mock).post('/api/proxy/restart');
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'SERVICE_MANAGED');
    assert.equal(mock.adapter.calls.filter((c) => ['startProxy', 'stopProxy', 'stopService', 'startService'].includes(c.method)).length, 0);
  });

  it('service-managed: settings return serviceReinstallNeeded; POST /api/service applies them elevated', async () => {
    const c = api(mock);
    const r = await c.patch('/api/settings', { tls: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.tls, true);
    assert.equal(r.json.serviceReinstallNeeded, true);
    assert.equal(r.json.restartNeeded, false);
    assert.equal(readState(mock.home).settings.tls, true);
    assert.equal(mock.adapter.calls.filter((x) => ['stopProxy', 'startProxy', 'serviceInstall'].includes(x.method)).length, 0, 'nothing restarts implicitly');
    const job = await c.post('/api/service', { action: 'apply' });
    assert.equal(job.status, 202);
    assert.equal(job.json.job.action, 'service-install');
    await waitUntil(async () => (await c.get('/api/proxy')).json.job?.phase === 'done');
    const call = mock.adapter.calls.find((x) => x.method === 'serviceInstall');
    assert.deepEqual(call.args[0], { tls: true, port: 80, lan: true, fixedIp: null, wildcard: false });
    assert.equal((await c.get('/api/settings')).json.serviceReinstallNeeded, false);
    const bad = await c.post('/api/service', { action: 'explode' });
    assert.equal(bad.status, 400);
  });
});

describe('route mutations (Contracts §8)', () => {
  let mock;
  let c;
  before(async () => {
    mock = await startMockApi({ scenario: 'manual-https', app: { intervals: FAST } });
    c = api(mock);
  });
  after(() => mock.close());

  it('POST /api/routes → 201 route with source nidum; name saved to state.json', async () => {
    const r = await c.post('/api/routes', { name: 'notes.local', port: 8888 });
    assert.equal(r.status, 201);
    assert.equal(r.json.name, 'notes');
    assert.equal(r.json.hostname, 'notes.local');
    assert.equal(r.json.url, 'https://notes.local');
    assert.equal(r.json.source, 'nidum');
    assert.equal(r.json.kind, 'alias');
    assert.ok(r.json.createdAt);
    assert.ok(readState(mock.home).names.includes('notes'));
    const st = await waitUntil(async () => {
      const s = (await c.get('/api/state')).json;
      const n = s.routes.find((x) => x.name === 'notes');
      return n && n.status === 'live' ? n : null;
    });
    assert.equal(st.statusDetail.httpStatus, 302);
  });

  it('validates names and ports (400)', async () => {
    for (const [body, code] of [
      [{ name: 'Bad', port: 3000 }, 'INVALID_NAME'],
      [{ name: 'list', port: 3000 }, 'INVALID_NAME'],
      [{ name: 'setup', port: 3000 }, 'INVALID_NAME'],
      [{ name: '', port: 3000 }, 'INVALID_NAME'],
      [{ port: 3000 }, 'INVALID_NAME'],
      [{ name: 'ok', port: 0 }, 'INVALID_PORT'],
      [{ name: 'ok', port: 70000 }, 'INVALID_PORT'],
      [{ name: 'ok', port: 3.5 }, 'INVALID_PORT'],
      [{ name: 'ok' }, 'INVALID_PORT'],
    ]) {
      const r = await c.post('/api/routes', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, code, JSON.stringify(body));
      assert.equal(typeof r.json.error.message, 'string');
    }
  });

  it('existing alias → 409 NAME_TAKEN; force replaces it', async () => {
    const r = await c.post('/api/routes', { name: 'dashboard', port: 3001 });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NAME_TAKEN');
    assert.equal(r.json.error.message, 'dashboard already points to port 3000.');
    assert.equal(r.json.error.details.route.port, 3000);
    const f = await c.post('/api/routes', { name: 'dashboard', port: 3001, force: true });
    assert.equal(f.status, 201);
    assert.equal(f.json.port, 3001);
    assert.equal(f.json.source, 'nidum');
  });

  it('app route → 409 NAME_TAKEN_BY_APP even with force (F9)', async () => {
    mock.adapter.routes.push({ hostname: 'shop.local', port: 4312, pid: 4312 });
    for (const force of [false, true]) {
      const r = await c.post('/api/routes', { name: 'shop', port: 9999, force });
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'NAME_TAKEN_BY_APP');
      assert.equal(r.json.error.message, 'shop is used by a running app. Stop that app or pick another name.');
    }
    assert.equal(mock.adapter.calls.filter((x) => x.method === 'addAlias' && x.args[0] === 'shop').length, 0);
    const del = await c.del('/api/routes/shop');
    assert.equal(del.status, 409);
    const patch = await c.patch('/api/routes/shop', { port: 1 });
    assert.equal(patch.status, 409);
  });

  it('PATCH changes the port or renames (names follow)', async () => {
    const p = await c.patch('/api/routes/recipes', { port: 5174 });
    assert.equal(p.status, 200);
    assert.equal(p.json.port, 5174);
    const r = await c.patch('/api/routes/recipes', { newName: 'cookbook' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'cookbook');
    assert.equal(r.json.source, 'nidum');
    const names = readState(mock.home).names;
    assert.ok(names.includes('cookbook') && !names.includes('recipes'));
    assert.equal((await c.patch('/api/routes/cookbook', {})).status, 400);
    assert.equal((await c.patch('/api/routes/cookbook', { port: 1, newName: 'x' })).status, 400);
    assert.equal((await c.patch('/api/routes/cookbook', { newName: 'Nope' })).json.error.code, 'INVALID_NAME');
    assert.equal((await c.patch('/api/routes/cookbook', { port: 'abc' })).json.error.code, 'INVALID_PORT');
    const nf = await c.patch('/api/routes/ghost', { port: 1 });
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'NOT_FOUND');
    const clash = await c.patch('/api/routes/cookbook', { newName: 'dashboard' });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error.code, 'NAME_TAKEN');
  });

  it('DELETE → { removed }; Undo = POST with the same name/port', async () => {
    const d = await c.del('/api/routes/cookbook');
    assert.equal(d.status, 200);
    assert.equal(d.json.removed.name, 'cookbook');
    assert.equal(d.json.removed.port, 5174);
    assert.equal(d.json.removed.source, 'nidum');
    assert.ok(!readState(mock.home).names.includes('cookbook'));
    assert.equal((await c.del('/api/routes/cookbook')).status, 404);
    const undo = await c.post('/api/routes', { name: d.json.removed.name, port: d.json.removed.port });
    assert.equal(undo.status, 201);
  });

  it('foreign-TLD routes: only Remove', async () => {
    mock.adapter.routes.push({ hostname: 'legacy.localhost', port: 7000, pid: 0 });
    const p = await c.patch('/api/routes/legacy.localhost', { port: 7001 });
    assert.equal(p.status, 422);
    assert.equal(p.json.error.code, 'UNSUPPORTED');
    const d = await c.del('/api/routes/legacy.localhost');
    assert.equal(d.status, 200);
    assert.equal(d.json.removed.foreignTld, true);
  });

  it('POST /api/routes/:name/check → hostCheck, stored on the route', async () => {
    const r = await c.post('/api/routes/dashboard/check');
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'ok');
    const s = (await c.get('/api/state')).json;
    assert.equal(s.routes.find((x) => x.name === 'dashboard').hostCheck.result, 'ok');
    assert.equal((await c.post('/api/routes/ghost/check')).status, 404);
  });

  it('adapter errors surface with the mapped status', async () => {
    const cases = [
      ['addAlias', new PortlessError('PERMISSION', 'Password not entered. Nothing changed.'), 423, 'PERMISSION'],
      ['addAlias', new PortlessError('TIMEOUT'), 504, 'TIMEOUT'],
      ['addAlias', new PortlessError('UNKNOWN', undefined, { raw: 'EIO' }), 500, 'INTERNAL'],
      ['listRoutes', new PortlessError('STATE_UNREADABLE'), 503, 'STATE_UNREADABLE'],
      ['addAlias', new PortlessError('CLI_MISSING'), 502, 'CLI_MISSING'],
      ['addAlias', new PortlessError('PROXY_DOWN'), 502, 'PROXY_DOWN'],
      ['addAlias', new Error('kaput'), 500, 'INTERNAL'],
    ];
    for (const [method, err, status, code] of cases) {
      mock.adapter.failNext(method, err);
      const r = await c.post('/api/routes', { name: `err-${status}-${code.toLowerCase().replace(/_/g, '-')}`, port: 1234 });
      assert.equal(r.status, status, code);
      assert.equal(r.json.error.code, code);
      if (code === 'INTERNAL' && err instanceof PortlessError) assert.equal(r.json.error.raw, 'EIO');
    }
  });
});

describe('background loop and SSE (Contracts §6, criterion 3)', () => {
  let mock;
  let c;
  before(async () => {
    mock = await startMockApi({ scenario: 'manual-https', app: { intervals: FAST } });
    c = api(mock);
  });
  after(() => mock.close());

  it('state on connect; routes within 3 s of POST; ids increase; heartbeat arrives', async () => {
    const s = await sse(mock.port, { cookie: `nidum_session=${mock.token}` });
    try {
      assert.equal(s.status, 200);
      assert.match(s.headers['content-type'], /text\/event-stream/);
      const first = await s.waitFor((e) => e.event === 'state');
      assert.equal(first.retry, '2000');
      assert.ok(Array.isArray(first.data.routes));
      const from = s.events.length;
      const t0 = Date.now();
      const r = await c.post('/api/routes', { name: 'live-one', port: 3000 });
      assert.equal(r.status, 201);
      const ev = await s.waitFor((e) => e.event === 'routes' && e.data.some((x) => x.name === 'live-one'), 3000, from);
      assert.ok(Date.now() - t0 < 3000);
      assert.ok(Array.isArray(ev.data));
      await s.waitFor((e) => e.event === 'heartbeat', 2000);
      const hb = s.events.find((e) => e.event === 'heartbeat');
      assert.ok(!Number.isNaN(Date.parse(hb.data.at)));
      const ids = s.events.map((e) => e.id);
      for (let i = 1; i < ids.length; i += 1) assert.equal(ids[i], ids[i - 1] + 1, `ids contiguous: ${ids.join(',')}`);
    } finally {
      s.close();
    }
  });

  it('sends a sub-object only when its JSON changed', async () => {
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      await new Promise((r) => setTimeout(r, 600));
      const before = s.events.filter((e) => e.event === 'network').length;
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(s.events.filter((e) => e.event === 'network').length, before, 'no repeat network events');
      const from = s.events.length;
      mock.network.value = { ...FIXTURE_NETWORKS.guest };
      const net = await s.waitFor((e) => e.event === 'network', 3000, from);
      assert.equal(net.data.ssid, 'Hotel Guest');
      const banners = await s.waitFor((e) => e.event === 'banners' && e.data.some((b) => b.id === 'public-network'), 3000, from);
      assert.ok(banners);
      const fromServices = s.events.length;
      mock.discovery.services = mock.discovery.services.filter((x) => x.port !== 4000);
      const svc = await s.waitFor((e) => e.event === 'services', 3000, fromServices);
      assert.ok(!svc.data.some((x) => x.port === 4000));
    } finally {
      s.close();
    }
  });

  it('the loop runs only while an SSE client is connected', async () => {
    await waitUntil(() => mock.app.clientCount === 0);
    assert.equal(mock.app.live.looping, false);
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    await s.waitFor((e) => e.event === 'state');
    assert.equal(mock.app.live.looping, true);
    s.close();
    await waitUntil(() => mock.app.clientCount === 0);
    assert.equal(mock.app.live.looping, false);
  });

  it('STATE_UNREADABLE: keeps the last good routes and never prunes names', async () => {
    await c.post('/api/routes', { name: 'keepme', port: 3000 });
    assert.ok(readState(mock.home).names.includes('keepme'));
    for (let i = 0; i < 5; i += 1) mock.adapter.failNext('listRoutes', new PortlessError('STATE_UNREADABLE'));
    for (let i = 0; i < 3; i += 1) await mock.app.live.refreshCore();
    assert.ok(readState(mock.home).names.includes('keepme'));
    assert.ok(mock.app.live.snapshot().routes.some((r) => r.name === 'keepme'));
    // a successful read without the route prunes it
    mock.adapter.routes = mock.adapter.routes.filter((r) => r.hostname !== 'keepme.local');
    await mock.app.live.refreshCore().catch(() => {});
    await mock.app.live.refreshCore();
    await mock.app.live.refreshCore();
    assert.ok(!readState(mock.home).names.includes('keepme'));
  });

  it('PATCH /api/ui dismisses banners (public network per SSID)', async () => {
    mock.network.value = { ...FIXTURE_NETWORKS.guest };
    await mock.app.live.refreshNetwork();
    let banners = (await c.get('/api/state')).json.banners.map((b) => b.id);
    assert.ok(banners.includes('first-run') && banners.includes('public-network'));
    const r = await c.patch('/api/ui', { dismiss: 'first-run' });
    assert.equal(r.status, 200);
    assert.ok(!r.json.banners.some((b) => b.id === 'first-run'));
    const p = await c.patch('/api/ui', { dismiss: 'public-network' });
    assert.ok(!p.json.banners.some((b) => b.id === 'public-network'));
    assert.deepEqual(readState(mock.home).dismissed, ['first-run', 'public-network:Hotel Guest']);
    assert.equal((await c.patch('/api/ui', { dismiss: 'sharing-off' })).status, 400);
    assert.equal((await c.patch('/api/ui', {})).status, 400);
    mock.network.value = { ...FIXTURE_NETWORKS.guest, ssid: 'Other Guest' };
    await mock.app.live.refreshNetwork();
    banners = (await c.get('/api/state')).json.banners.map((b) => b.id);
    assert.ok(banners.includes('public-network'), 'dismissal lasts for that network only');
  });
});

describe('proxy jobs (manual proxy)', () => {
  it('start/stop/restart → 202 { job }; progress as proxy events incl. waitingForPassword', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const mock = await startMockApi({
      scenario: 'stopped',
      app: { intervals: FAST },
      state: { version: 1, names: [], settings: { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] },
    });
    const c = api(mock);
    mock.adapter.onElevate = async () => {
      mock.app.elevationStarted();
      await gate;
      mock.app.elevationEnded();
    };
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const r = await c.post('/api/proxy/start');
      assert.equal(r.status, 202);
      assert.equal(r.json.job.action, 'start');
      assert.equal(r.json.job.phase, 'starting');
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.phase === 'waitingForPassword');
      const again = await c.post('/api/proxy/start');
      assert.equal(again.status, 202);
      assert.equal(again.json.job.id, r.json.job.id, 'a running job is reused');
      release();
      const done = await s.waitFor((e) => e.event === 'proxy' && e.data.job?.phase === 'done' && e.data.running);
      assert.equal(done.data.port, 80);
      const call = mock.adapter.calls.find((x) => x.method === 'startProxy');
      assert.deepEqual(call.args[0], { tls: false, port: 80, lan: true, fixedIp: null, wildcard: false });
      const stop = await c.post('/api/proxy/stop');
      assert.equal(stop.json.job.phase, 'stopping');
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === stop.json.job.id && e.data.job.phase === 'done' && !e.data.running);
      mock.adapter.failNext('startProxy', new PortlessError('PORT_IN_USE', 'Another program is using port 80.'));
      const fail = await c.post('/api/proxy/restart');
      const failed = await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === fail.json.job.id && e.data.job.phase === 'failed');
      assert.deepEqual(failed.data.job.error, { code: 'PORT_IN_USE', message: 'Another program is using port 80.' });
    } finally {
      s.close();
      await mock.close();
    }
  });

  it('settings PATCH on a manual proxy: restartNeeded, nothing restarts implicitly; validation', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      const r = await c.patch('/api/settings', { port: 8443, wildcard: true, fixedIp: '192.168.1.42' });
      assert.equal(r.status, 200);
      assert.equal(r.json.restartNeeded, true);
      assert.deepEqual(readState(mock.home).settings, { tls: true, port: 8443, fixedIp: '192.168.1.42', wildcard: true, keepAfterRestart: false });
      assert.equal(mock.adapter.calls.filter((x) => ['startProxy', 'stopProxy', 'serviceInstall', 'serviceUninstall'].includes(x.method)).length, 0);
      for (const body of [{}, { tls: 'yes' }, { fixedIp: 'nope' }, { colour: 'red' }]) {
        const bad = await c.patch('/api/settings', body);
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.equal(bad.json.error.code, 'BAD_REQUEST');
      }
      assert.equal((await c.patch('/api/settings', { port: 0 })).json.error.code, 'INVALID_PORT');
      assert.equal((await c.patch('/api/settings', { keepAfterRestart: true })).json.serviceReinstallNeeded, true);
    } finally {
      await mock.close();
    }
  });
});

describe('tools', () => {
  let mock;
  let c;
  before(async () => {
    mock = await startMockApi({ scenario: 'manual-https' });
    c = api(mock);
  });
  after(() => mock.close());

  it('doctor maps ok→✓ warn→! fail→✗ info→· (F21)', async () => {
    assert.deepEqual({ ...DOCTOR_GLYPHS }, { ok: '✓', warn: '!', fail: '✗', info: '·' });
    const r = await c.post('/api/tools/doctor');
    assert.equal(r.status, 200);
    assert.ok(r.json.findings.length > 0);
    for (const f of r.json.findings) assert.equal(f.glyph, DOCTOR_GLYPHS[f.status]);
    assert.equal(typeof r.json.raw, 'string');
  });

  it('clean requires { confirm: "reset" } and lists what it removes', async () => {
    const r = await c.post('/api/tools/clean', {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'BAD_REQUEST');
    assert.deepEqual(r.json.error.details.removes, [...CLEAN_REMOVES]);
    assert.equal(mock.adapter.calls.filter((x) => x.method === 'clean').length, 0);
    const g = await c.get('/api/tools/clean');
    assert.deepEqual(g.json.removes, [...CLEAN_REMOVES]);
    const ok = await c.post('/api/tools/clean', { confirm: 'reset' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.removed, [...CLEAN_REMOVES]);
  });

  it('prune counts stopped servers; trust and hosts-sync run; unknown tool → 404', async () => {
    const p = await c.post('/api/tools/prune');
    assert.equal(p.json.count, 1);
    assert.equal((await c.post('/api/tools/trust')).status, 200);
    assert.equal((await c.post('/api/tools/hosts-sync')).status, 200);
    assert.equal((await c.post('/api/tools/explode')).status, 404);
  });

  it('cancelled password → 423 PERMISSION; missing CLI → 502; timeout → 504', async () => {
    mock.adapter.failNext('trust', new PortlessError('PERMISSION', 'Password not entered. Nothing changed.', { raw: 'User canceled. (-128)' }));
    const t = await c.post('/api/tools/trust');
    assert.equal(t.status, 423);
    assert.deepEqual(t.json, { error: { code: 'PERMISSION', message: 'Password not entered. Nothing changed.', raw: 'User canceled. (-128)' } });
    mock.adapter.failNext('doctor', new PortlessError('CLI_MISSING'));
    const d = await c.post('/api/tools/doctor');
    assert.equal(d.status, 502);
    assert.equal(d.json.error.message, "Portless isn't installed anymore.");
    mock.adapter.failNext('hostsSync', new PortlessError('TIMEOUT'));
    assert.equal((await c.post('/api/tools/hosts-sync')).status, 504);
  });
});

describe('read-only mode (NIDUM_READ_ONLY=1, criterion 4)', () => {
  it('rejects every mutation with 403 FORBIDDEN and changes nothing', async () => {
    const mock = await startMockApi({ scenario: 'mac-service', readOnly: true });
    const c = api(mock);
    try {
      const before = JSON.stringify(mock.adapter.routes);
      const mutations = [
        ['POST', '/api/routes', { name: 'x', port: 3000 }],
        ['PATCH', '/api/routes/plex', { port: 1 }],
        ['DELETE', '/api/routes/plex', {}],
        ['POST', '/api/proxy/start', {}],
        ['POST', '/api/proxy/stop', {}],
        ['POST', '/api/proxy/restart', {}],
        ['PATCH', '/api/settings', { tls: true }],
        ['POST', '/api/service', {}],
        ['POST', '/api/tools/trust', {}],
        ['POST', '/api/tools/hosts-sync', {}],
        ['POST', '/api/tools/prune', {}],
        ['POST', '/api/tools/clean', { confirm: 'reset' }],
        ['POST', '/api/setup-device', {}],
        ['DELETE', '/api/setup-device', {}],
        ['PATCH', '/api/ui', { dismiss: 'first-run' }],
      ];
      for (const [method, p, body] of mutations) {
        const r = await request(mock.port, method, p, { token: mock.token, body });
        assert.equal(r.status, 403, `${method} ${p}`);
        assert.equal(r.json.error.code, 'FORBIDDEN');
        assert.match(r.json.error.message, /Read-only/);
      }
      assert.equal(JSON.stringify(mock.adapter.routes), before);
      const mutating = mock.adapter.calls.filter((x) => !['getProxyState', 'listRoutes', 'getRoutesAccess'].includes(x.method));
      assert.deepEqual(mutating, []);
      // reads, checks and diagnostics still work
      assert.equal((await c.get('/api/state')).status, 200);
      assert.equal((await c.post('/api/routes/plex/check')).status, 200);
      assert.equal((await c.post('/api/tools/doctor')).status, 200);
      const s = (await c.get('/api/state')).json;
      assert.ok(s.routes.every((r) => r.source !== 'nidum'));
    } finally {
      await mock.close();
    }
  });
});

describe('device setup (D21: plain HTTP on the LAN IP; TLS unverifiable on this Mac)', () => {
  const SETUP_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'];

  it('422 UNSUPPORTED when HTTPS is off', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    try {
      const r = await api(mock).post('/api/setup-device');
      assert.equal(r.status, 422);
      assert.equal(r.json.error.code, 'UNSUPPORTED');
      assert.equal(r.json.error.details.reason, 'tls-off');
    } finally {
      await mock.close();
    }
  });

  it('serves the CA and steps at http://<LAN IP>:<port>/ — no proxy, no alias, no state.json write', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      const stateBefore = fs.readFileSync(path.join(mock.home, 'state.json'), 'utf8');
      const r = await c.post('/api/setup-device');
      assert.equal(r.status, 201);
      const setup = r.json.setup;
      assert.equal(setup.ip, '192.168.1.42', 'the running LAN proxy’s IP');
      assert.equal(setup.url, `http://192.168.1.42:${setup.port}/`);
      assert.ok(Date.parse(setup.expiresAt) - Date.now() > 9 * 60 * 1000);
      assert.deepEqual(setup.steps.map((x) => x.id), ['ios', 'android', 'mac', 'windows']);
      // bound where the injected bindAddress said (127.0.0.1 in tests), never 0.0.0.0
      const bound = mock.app.deviceSetup;
      assert.equal(bound.active, true);
      const page = await request(setup.port, 'GET', '/');
      assert.equal(page.status, 200);
      assert.match(page.text, /Download certificate/);
      const ca = await request(setup.port, 'GET', '/portless-ca.pem');
      assert.match(ca.text, /BEGIN CERTIFICATE/);
      assert.match(ca.headers['content-disposition'], /attachment/);
      for (const res of [page, ca, await request(setup.port, 'GET', '/nope')]) {
        for (const h of SETUP_HEADERS) assert.ok(res.headers[h], `${h} on ${res.status}`);
      }
      assert.equal((await request(setup.port, 'GET', '/../etc/passwd')).status, 404);
      // nothing touched Portless or state.json
      assert.deepEqual(mock.adapter.calls.filter((x) => !['getProxyState', 'listRoutes', 'getRoutesAccess'].includes(x.method)), []);
      assert.equal(fs.readFileSync(path.join(mock.home, 'state.json'), 'utf8'), stateBefore);
      assert.ok(!(await c.get('/api/state')).json.routes.some((x) => x.name === 'setup'));
      const again = await c.post('/api/setup-device');
      assert.equal(again.json.setup.port, setup.port, 'a second start returns the running page');
      assert.equal((await c.get('/api/setup-device')).json.setup.port, setup.port);
      const d = await c.del('/api/setup-device');
      assert.deepEqual(d.json, { stopped: true });
      assert.equal((await c.get('/api/setup-device')).json.setup, null);
      await assert.rejects(request(setup.port, 'GET', '/'));
      assert.deepEqual((await c.del('/api/setup-device')).json, { stopped: false });
    } finally {
      await mock.close();
    }
  });

  it('never binds 0.0.0.0, broadcast, multicast or loopback (D27) → no-network', async () => {
    for (const bad of ['0.0.0.0', '255.255.255.255', '224.0.0.1', '127.0.0.1', '240.0.0.1', 'nope', null]) {
      const binds = [];
      const d = createDeviceSetup({
        adapter: { stateDir: () => '/nowhere' },
        getProxy: async () => ({ tls: true, running: true, port: 443 }),
        getLanIp: async () => bad,
        bindAddress: (ip) => {
          binds.push(ip);
          return '127.0.0.1';
        },
        readCa: () => 'CA',
      });
      await assert.rejects(d.start(), (e) => e.code === 'UNSUPPORTED' && e.details.reason === 'no-network', String(bad));
      assert.deepEqual(binds, [], `${bad} was never bound`);
      assert.equal(d.active, false);
    }
  });

  it('falls back to the saved fixed IP, then the network IP — only addresses this computer lists; none → "You’re not connected to a network."', async () => {
    const twoNics = { ip: '192.168.1.42', interface: 'en0', kind: 'wifi', ssid: 'HomeWiFi', interfaces: [{ name: 'en0', ip: '192.168.1.42', kind: 'wifi' }, { name: 'en7', ip: '10.9.8.7', kind: 'ethernet' }] };
    const stopped = { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] };
    const m = await startMockApi({ scenario: 'stopped', network: createFakeNetwork(twoNics), state: stopped });
    try {
      const plain = await api(m).post('/api/setup-device');
      assert.equal(plain.status, 201);
      assert.equal(plain.json.setup.ip, '192.168.1.42', 'network.ip when no proxy and no fixed IP');
      await api(m).del('/api/setup-device');
      assert.equal((await api(m).patch('/api/settings', { fixedIp: '10.9.8.7' })).status, 200);
      const fixed = await api(m).post('/api/setup-device');
      assert.equal(fixed.json.setup.ip, '10.9.8.7', 'the saved fixed IP comes before network.ip');
      await api(m).del('/api/setup-device');
      // the fixed IP's interface goes away: fall back to network.ip
      m.network.value = { ...twoNics, interfaces: [twoNics.interfaces[0]] };
      const gone = await api(m).post('/api/setup-device');
      assert.equal(gone.json.setup.ip, '192.168.1.42');
      await api(m).del('/api/setup-device');
      // a running LAN proxy whose lanIp is no longer listed is skipped too
      m.adapter.proxy = { ...m.adapter.proxy, running: true, lan: true, lanIp: '172.16.0.9' };
      const stale = await api(m).post('/api/setup-device');
      assert.equal(stale.json.setup.ip, '192.168.1.42');
    } finally {
      await m.close();
    }
    const none = await startMockApi({ scenario: 'stopped', network: createFakeNetwork(FIXTURE_NETWORKS.none), state: stopped });
    try {
      const r = await api(none).post('/api/setup-device');
      assert.equal(r.status, 422);
      assert.equal(r.json.error.message, 'You’re not connected to a network.');
      assert.equal(r.json.error.details.reason, 'no-network');
    } finally {
      await none.close();
    }
  });

  it('a stale LAN IP that can’t be bound → no-network error', async () => {
    const d = createDeviceSetup({
      adapter: { stateDir: () => '/nowhere' },
      getProxy: async () => ({ tls: true }),
      getLanIp: async () => '192.0.2.123', // TEST-NET: not on this machine
      readCa: () => 'CA',
    });
    await assert.rejects(d.start(), (e) => e.code === 'UNSUPPORTED' && e.details.reason === 'no-network');
    assert.equal(d.active, false);
  });

  it('expires after its duration and stops on quit', async () => {
    const d = createDeviceSetup({
      adapter: { stateDir: () => '/nowhere' },
      getProxy: async () => ({ tls: true }),
      getLanIp: async () => '10.0.0.2',
      bindAddress: () => '127.0.0.1',
      readCa: () => 'CA',
      durationMs: 150,
    });
    await d.start();
    assert.equal(d.active, true);
    await waitUntil(() => !d.active, 2000);
    const mock = await startMockApi({ scenario: 'manual-https' });
    const r = await api(mock).post('/api/setup-device');
    await mock.close();
    await assert.rejects(request(r.json.setup.port, 'GET', '/'));
  });
});

describe('iteration 2 robustness (N3 validation 1 findings 2–9, P1)', () => {
  it('until the first good route read: /api/routes → 503, /api/state routesUnavailable: true; flips with a routes event', async () => {
    const adapter = createFakeAdapter({ proxy: { running: true, pid: 1, port: 80, tls: false, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'manual' }, routes: [] });
    for (let i = 0; i < 12; i += 1) adapter.failNext('listRoutes', new PortlessError('STATE_UNREADABLE'));
    const mock = await startMockApi({ adapter, app: { intervals: FAST } });
    const c = api(mock);
    try {
      const r = await c.get('/api/routes');
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, 'STATE_UNREADABLE');
      const s = (await c.get('/api/state')).json;
      assert.equal(s.routesUnavailable, true);
      assert.deepEqual(s.routes, []);
      const ev = await sse(mock.port, { 'x-nidum-token': mock.token });
      try {
        const first = await ev.waitFor((e) => e.event === 'state');
        assert.equal(first.data.routesUnavailable, true);
        // the queued failures drain through the loop; the next good read flips the flag
        adapter.routes = [];
        const failsLeft = () => adapter.calls.filter((x) => x.method === 'listRoutes').length;
        await waitUntil(() => failsLeft() > 12, 10000);
        const routesEv = await ev.waitFor((e) => e.event === 'routes', 5000);
        assert.deepEqual(routesEv.data, []);
        assert.equal((await c.get('/api/state')).json.routesUnavailable, false);
        assert.equal((await c.get('/api/routes')).status, 200);
      } finally {
        ev.close();
      }
    } finally {
      await mock.close();
    }
  });

  it('a hung adapter call answers 504 and doesn’t wedge refreshes; a hung scan doesn’t block services', async () => {
    const logs = [];
    const mock = await startMockApi({ scenario: 'manual-https', log: (m) => logs.push(m), app: { deadlines: { proxy: 200, routes: 200, scan: 200, network: 200, probe: 300, afterMutation: 200 } } });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      mock.adapter.hangNext('listRoutes');
      const t0 = Date.now();
      const r = await c.post('/api/routes', { name: 'hung', port: 3000 });
      assert.equal(r.status, 504);
      assert.equal(r.json.error.code, 'TIMEOUT');
      assert.equal(r.json.error.message, 'This is taking longer than expected.');
      assert.ok(Date.now() - t0 < 2000);
      // a hang inside the background refresh frees the slot after its deadline
      mock.adapter.hangNext('listRoutes');
      mock.adapter.hangNext('getProxyState');
      await mock.app.live.refreshCore();
      const ok = await c.post('/api/routes', { name: 'after-hang', port: 3000 });
      assert.equal(ok.status, 201);
      // the post-mutation wait is bounded too
      mock.adapter.hangNext('listRoutes');
      mock.adapter.hangNext('getProxyState');
      await mock.app.live.refreshCore().catch(() => {});
      mock.discovery.hang = 1;
      await mock.app.live.refreshServices();
      mock.discovery.services = mock.discovery.services.filter((x) => x.port !== 5432);
      await mock.app.live.refreshServices();
      assert.ok(!mock.app.live.part('services').some((x) => x.port === 5432));
    } finally {
      await mock.close();
    }
  });

  it('logs a lasting failure once and its recovery once', async () => {
    const logs = [];
    const mock = await startMockApi({ scenario: 'manual-https', log: (m) => logs.push(m) });
    try {
      for (let i = 0; i < 6; i += 1) mock.adapter.failNext('listRoutes', new PortlessError('STATE_UNREADABLE'));
      for (let i = 0; i < 6; i += 1) await mock.app.live.refreshCore();
      await mock.app.live.refreshCore();
      const lines = logs.filter((l) => l.startsWith('listRoutes'));
      assert.equal(lines.length, 2, lines.join('\n'));
      assert.match(lines[0], /failed \(STATE_UNREADABLE/);
      assert.match(lines[1], /works again/);
    } finally {
      await mock.close();
    }
  });

  it('malformed % in an API path → 400, nothing logged', async () => {
    const logs = [];
    const mock = await startMockApi({ log: (m) => logs.push(m) });
    try {
      for (const p of ['/api/routes/%', '/api/routes/%E0%A4%A', '/api/routes/%zz/check']) {
        const r = await request(mock.port, p.endsWith('check') ? 'POST' : 'GET', p, { token: mock.token, body: p.endsWith('check') ? {} : undefined });
        assert.equal(r.status, 400, p);
        assert.equal(r.json.error.code, 'BAD_REQUEST');
      }
      const d = await request(mock.port, 'DELETE', '/api/routes/%E0%A4%A', { token: mock.token, body: {} });
      assert.equal(d.status, 400);
      assert.equal(logs.filter((l) => /URI|stack|Error/.test(l)).length, 0, logs.join('\n'));
    } finally {
      await mock.close();
    }
  });

  it('a body over 64 KB gets 400 "That request is too large." (declared and chunked)', async () => {
    const mock = await startMockApi();
    try {
      const big = JSON.stringify({ name: 'x', port: 1, pad: 'a'.repeat(70 * 1024) });
      const r = await request(mock.port, 'POST', '/api/routes', { token: mock.token, body: big });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.message, 'That request is too large.');
      const chunked = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: mock.port, method: 'POST', path: '/api/routes', agent: false, headers: { host: `127.0.0.1:${mock.port}`, 'x-nidum-token': mock.token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          const chunks = [];
          res.on('data', (x) => chunks.push(x));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        for (let i = 0; i < 10; i += 1) req.write('a'.repeat(8 * 1024));
        req.end();
      });
      assert.equal(chunked.status, 400);
      assert.equal(chunked.json.error.message, 'That request is too large.');
      assert.equal((await api(mock).get('/api/health')).status, 200, 'server still answers');
    } finally {
      await mock.close();
    }
  });

  it('any matching nidum_session cookie is accepted (a planted duplicate can’t lock the dashboard out)', async () => {
    const mock = await startMockApi();
    try {
      const r = await request(mock.port, 'GET', '/api/state', { cookie: `nidum_session=junk; nidum_session=${mock.token}` });
      assert.equal(r.status, 200);
      const ev = await request(mock.port, 'GET', '/', { cookie: `nidum_session=junk; other=1; nidum_session=${mock.token}` });
      assert.equal(ev.status, 200);
      assert.equal((await request(mock.port, 'GET', '/api/state', { cookie: 'nidum_session=junk; nidum_session=junk2' })).status, 401);
    } finally {
      await mock.close();
    }
  });

  it('a different proxy action during a job → 409 BUSY; the same action → 202 reused: true', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const mock = await startMockApi({ scenario: 'stopped', state: { version: 1, names: [], settings: { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] } });
    mock.adapter.onElevate = () => gate;
    const c = api(mock);
    try {
      const start = await c.post('/api/proxy/start');
      assert.equal(start.status, 202);
      assert.equal(start.json.reused, false);
      const same = await c.post('/api/proxy/start');
      assert.equal(same.status, 202);
      assert.equal(same.json.reused, true);
      assert.equal(same.json.job.id, start.json.job.id);
      for (const p of ['/api/proxy/stop', '/api/proxy/restart']) {
        const busy = await c.post(p);
        assert.equal(busy.status, 409, p);
        assert.equal(busy.json.error.code, 'BUSY');
        assert.equal(busy.json.error.details.job.id, start.json.job.id);
      }
      const svc = await c.post('/api/service', { action: 'install' });
      assert.equal(svc.status, 409);
      assert.equal(svc.json.error.code, 'BUSY');
      release();
      await waitUntil(async () => (await c.get('/api/proxy')).json.job?.phase === 'done');
      assert.equal((await c.post('/api/proxy/stop')).status, 202);
    } finally {
      release();
      await mock.close();
    }
  });

  it('refuses an address for the dashboard’s own port (400)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      const r = await c.post('/api/routes', { name: 'dash', port: mock.port });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'BAD_REQUEST');
      assert.match(r.json.error.message, /own port/);
      const p = await c.patch('/api/routes/recipes', { port: mock.port });
      assert.equal(p.status, 400);
      assert.equal(mock.adapter.calls.filter((x) => ['addAlias', 'changePort'].includes(x.method)).length, 0);
    } finally {
      await mock.close();
    }
  });

  it('read-only is checked before the content type (403, not 415)', async () => {
    const mock = await startMockApi({ readOnly: true });
    try {
      const r = await request(mock.port, 'POST', '/api/routes', { token: mock.token, raw: 'name=x', headers: { 'content-type': 'text/plain' } });
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'FORBIDDEN');
      const q = await request(mock.port, 'POST', '/api/routes/x/check', { token: mock.token, raw: 'x', headers: { 'content-type': 'text/plain' } });
      assert.equal(q.status, 415, 'allowed endpoints still need JSON');
    } finally {
      await mock.close();
    }
  });

  it('P1: the status probe falls back to ::1 (Vite’s default localhost on macOS)', async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('v6');
    });
    try {
      await new Promise((r, j) => srv.once('error', j).listen(0, '::1', r));
    } catch {
      return; // no IPv6 loopback here
    }
    try {
      const res = await probeRoutePort(srv.address().port);
      assert.deepEqual(res, { status: 'live', statusDetail: { httpStatus: 200, tls: false, host: '::1' } });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('iteration 3 (N3 validation 2, D27, N4 backlog)', () => {
  it('D27: PATCH fixedIp accepts only a unicast IPv4 this computer lists', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      for (const bad of ['0.0.0.0', '255.255.255.255', '224.0.0.1', '239.255.255.250', '127.0.0.1', '240.1.2.3']) {
        const r = await c.patch('/api/settings', { fixedIp: bad });
        assert.equal(r.status, 400, bad);
        assert.equal(r.json.error.code, 'BAD_REQUEST');
        assert.equal(r.json.error.details.reason, 'not-unicast', bad);
      }
      for (const unlisted of ['169.254.1.1', '192.168.99.99', '8.8.8.8']) {
        const r = await c.patch('/api/settings', { fixedIp: unlisted });
        assert.equal(r.status, 400, unlisted);
        assert.equal(r.json.error.details.reason, 'not-listed', unlisted);
      }
      assert.equal(readState(mock.home).settings.fixedIp, null, 'nothing bad was saved');
      const ok = await c.patch('/api/settings', { fixedIp: '192.168.1.42' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.fixedIp, '192.168.1.42');
      assert.equal((await c.patch('/api/settings', { fixedIp: null })).json.fixedIp, null);
    } finally {
      await mock.close();
    }
  });

  it('D27: state.json fixedIp that is not unicast or not listed is ignored with a log line', async () => {
    for (const [fixedIp, why] of [['0.0.0.0', /not a unicast/], ['255.255.255.255', /not a unicast/], ['10.1.2.3', /doesn't list/]]) {
      const logs = [];
      const state = { version: 1, names: [], settings: { tls: true, port: 443, fixedIp, wildcard: false, keepAfterRestart: false }, dismissed: [] };
      const mock = await startMockApi({ scenario: 'manual-https', state, log: (m) => logs.push(m) });
      try {
        const s = (await api(mock).get('/api/settings')).json;
        assert.equal(s.fixedIp, null, fixedIp);
        assert.ok(logs.some((l) => l.includes(fixedIp) && why.test(l)), logs.join('\n'));
        assert.equal(readState(mock.home).settings.fixedIp, fixedIp, 'state.json is not rewritten on load');
        const r = await api(mock).post('/api/setup-device');
        assert.equal(r.json.setup.ip, '192.168.1.42', 'device setup never uses it');
      } finally {
        await mock.close();
      }
    }
    const listed = await startMockApi({ scenario: 'manual-https', state: { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: '192.168.1.42', wildcard: false, keepAfterRestart: false }, dismissed: [] } });
    try {
      assert.equal((await api(listed).get('/api/settings')).json.fixedIp, '192.168.1.42');
    } finally {
      await listed.close();
    }
  });

  it('mock probe answers always carry statusDetail.tls; ::1 and slow samples', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    try {
      await mock.app.live.warm();
      const routes = (await api(mock).get('/api/routes')).json;
      const by = Object.fromEntries(routes.map((r) => [r.name, r]));
      for (const r of routes) if (r.statusDetail && 'httpStatus' in r.statusDetail) assert.equal(typeof r.statusDetail.tls, 'boolean', r.name);
      assert.deepEqual(by.jupyter.statusDetail, { httpStatus: 302, tls: false, host: '::1' });
      assert.deepEqual(by.shop.statusDetail, { httpStatus: null, tls: false, slow: true });
      assert.deepEqual(by.plex.statusDetail, { httpStatus: 200, tls: false });
    } finally {
      await mock.close();
    }
  });

  it('SSE: capabilities event on change; heartbeat and /api/state carry updatedAt and scannedAt', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', app: { intervals: FAST } });
    try {
      await mock.app.live.warm();
      const st = (await api(mock).get('/api/state')).json;
      assert.ok(!Number.isNaN(Date.parse(st.scannedAt)));
      const s = await sse(mock.port, { 'x-nidum-token': mock.token });
      try {
        await s.waitFor((e) => e.event === 'state');
        const from = s.events.length;
        mock.adapter.proxy = { ...mock.adapter.proxy, tls: false, port: 80 };
        const cap = await s.waitFor((e) => e.event === 'capabilities', 3000, from);
        assert.equal(cap.data.deviceSetup.supported, false);
        assert.deepEqual(Object.keys(cap.data).sort(), ['deviceSetup', 'internetSharing', 'pause']);
        const hb = await s.waitFor((e) => e.event === 'heartbeat', 2000);
        assert.deepEqual(Object.keys(hb.data).sort(), ['at', 'scannedAt', 'updatedAt']);
        assert.ok(!Number.isNaN(Date.parse(hb.data.updatedAt)));
        assert.ok(!Number.isNaN(Date.parse(hb.data.scannedAt)));
        const ids = s.events.map((e) => e.id);
        for (let i = 1; i < ids.length; i += 1) assert.equal(ids[i], ids[i - 1] + 1);
      } finally {
        s.close();
      }
    } finally {
      await mock.close();
    }
  });

  it('GET /api/services?refresh=1 forces a scan now', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', app: { forcedScanMinMs: 0 } });
    try {
      await mock.app.live.warm();
      const before = mock.discovery.scans;
      mock.discovery.services = [...mock.discovery.services, { ...mock.discovery.services[0], port: 9999, pid: 42, suggestedName: 'fresh' }];
      const cached = (await api(mock).get('/api/services')).json;
      assert.ok(!cached.some((x) => x.port === 9999), 'no refresh: served from the cache');
      const forced = (await api(mock).get('/api/services?refresh=1')).json;
      assert.ok(forced.some((x) => x.port === 9999));
      assert.ok(mock.discovery.scans > before);
      mock.discovery.hang = 1;
      const t0 = Date.now();
      assert.equal((await api(mock).get('/api/services?refresh=1')).status, 200, 'a hung scan is bounded by its deadline');
      assert.ok(Date.now() - t0 < 6000);
    } finally {
      await mock.close();
    }
  });

  it('network.ip is null when kind is none (never the proxy lanIp)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', network: { async getNetwork({ proxyLanIp }) { return { ip: proxyLanIp, interface: null, kind: 'none', ssid: null, interfaces: [] }; } } });
    try {
      await mock.app.live.warm();
      const n = (await api(mock).get('/api/network')).json;
      assert.equal(n.kind, 'none');
      assert.equal(n.ip, null);
      const f = await createFakeNetwork(FIXTURE_NETWORKS.none).getNetwork({ proxyLanIp: '192.168.1.42' });
      assert.equal(f.ip, null, 'the fake network does the same');
    } finally {
      await mock.close();
    }
  });

  it('the mock adapter reports elevation to the app (waitingForPassword without a custom onElevate)', async () => {
    const mock = await startMockApi({ scenario: 'stopped', state: { version: 1, names: [], settings: { tls: false, port: 80, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] } });
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const r = await api(mock).post('/api/proxy/start');
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === r.json.job.id && e.data.job.phase === 'waitingForPassword');
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === r.json.job.id && e.data.job.phase === 'done');
    } finally {
      s.close();
      await mock.close();
    }
  });
});

describe('E11 pause vs. unexpected stop (D28, D29)', () => {
  it('POST /api/proxy/stop → sharing-paused (info) + proxy.pausedByUser; the next start clears it; an unexpected stop → sharing-off (error)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', state: { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: ['first-run'] } });
    const c = api(mock);
    const until = (phaseOf) => waitUntil(async () => {
      const p = (await c.get('/api/proxy')).json;
      return p.job && p.job.id === phaseOf && p.job.finishedAt ? p : null;
    });
    try {
      let st = (await c.get('/api/state')).json;
      assert.equal(st.proxy.pausedByUser, false);
      assert.equal(st.capabilities.internetSharing.reason, "Sharing outside your network isn't available for addresses added here yet.");
      const stop = await c.post('/api/proxy/stop');
      const stopped = await until(stop.json.job.id);
      assert.equal(stopped.job.phase, 'done');
      assert.equal(stopped.running, false);
      assert.equal(stopped.pausedByUser, true);
      st = (await c.get('/api/state')).json;
      assert.deepEqual(st.banners, [{ id: 'sharing-paused', kind: 'info', message: 'Sharing is paused. Your addresses are offline until you resume.' }]);
      const start = await c.post('/api/proxy/start');
      const started = await until(start.json.job.id);
      assert.equal(started.running, true);
      assert.equal(started.pausedByUser, false);
      assert.deepEqual((await c.get('/api/state')).json.banners, []);
      // the proxy dies on its own: an error, not a pause
      mock.adapter.proxy = { ...mock.adapter.proxy, running: false, pid: null };
      st = (await c.get('/api/state')).json;
      assert.equal(st.proxy.pausedByUser, false);
      assert.deepEqual(st.banners.map((b) => [b.id, b.kind]), [['sharing-off', 'error']]);
      // a failed stop is not a pause
      mock.adapter.proxy = { ...mock.adapter.proxy, running: true, pid: 9 };
      mock.adapter.failNext('stopProxy', new PortlessError('PERMISSION', 'Password not entered. Nothing changed.'));
      const failed = await until((await c.post('/api/proxy/stop')).json.job.id);
      assert.equal(failed.job.phase, 'failed');
      assert.equal(failed.pausedByUser, false);
      // after a pause, a start from outside (launcher) also ends it
      await until((await c.post('/api/proxy/stop')).json.job.id);
      assert.equal((await c.get('/api/proxy')).json.pausedByUser, true);
      mock.adapter.proxy = { ...mock.adapter.proxy, running: true, pid: 10 };
      assert.equal((await c.get('/api/proxy')).json.pausedByUser, false);
    } finally {
      await mock.close();
    }
  });
});

describe('D33 pause survives a server restart', () => {
  it('state.json.paused is set on a user stop, read on load, cleared by the next start', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-d33-'));
    const settings = { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false };
    const proxy = { running: true, pid: 3333, port: 443, tls: true, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'manual' };
    try {
      const first = await startMockApi({ home, adapter: createFakeAdapter({ proxy, routes: [] }), state: { version: 1, names: [], settings, dismissed: ['first-run'] } });
      try {
        assert.equal('paused' in readState(home), false, 'absent by default');
        const stop = await api(first).post('/api/proxy/stop');
        await waitUntil(async () => (await api(first).get('/api/proxy')).json.job?.finishedAt && (await api(first).get('/api/proxy')).json.job.id === stop.json.job.id);
        assert.equal(readState(home).paused, true);
        assert.equal(fs.statSync(path.join(home, 'state.json')).mode & 0o777, 0o600);
      } finally {
        await first.close();
      }
      // a new server process on the same NIDUM_HOME, proxy still stopped
      const second = await startMockApi({ home, state: false, adapter: createFakeAdapter({ proxy: { ...proxy, running: false, pid: null, lanIp: null, managedBy: null }, routes: [] }) });
      try {
        const st = (await api(second).get('/api/state')).json;
        assert.equal(st.proxy.pausedByUser, true);
        assert.deepEqual(st.banners, [{ id: 'sharing-paused', kind: 'info', message: 'Sharing is paused. Your addresses are offline until you resume.' }]);
        const start = await api(second).post('/api/proxy/start');
        await waitUntil(async () => {
          const p = (await api(second).get('/api/proxy')).json;
          return p.job?.id === start.json.job.id && p.job.phase === 'done';
        });
        assert.equal((await api(second).get('/api/proxy')).json.pausedByUser, false);
        assert.equal('paused' in readState(home), false, 'cleared from state.json');
      } finally {
        await second.close();
      }
      // a paused flag whose proxy is found running on load is cleared too
      const s = readState(home);
      fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ ...s, paused: true }));
      const third = await startMockApi({ home, state: false, adapter: createFakeAdapter({ proxy, routes: [] }) });
      try {
        assert.equal((await api(third).get('/api/proxy')).json.pausedByUser, false);
        assert.equal('paused' in readState(home), false);
      } finally {
        await third.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('iteration 4 (N3 validation 3 backlog)', () => {
  const twoNics = { ip: '192.168.1.42', interface: 'en0', kind: 'wifi', ssid: 'HomeWiFi', interfaces: [{ name: 'en0', ip: '192.168.1.42', kind: 'wifi' }, { name: 'en7', ip: '10.9.8.7', kind: 'ethernet' }] };
  const stateWith = (extra = {}) => ({ version: 1, names: [], settings: { tls: false, port: 80, fixedIp: '10.9.8.7', wildcard: false, keepAfterRestart: false }, dismissed: [], ...extra });

  it('a saved fixedIp that is not listed at startup stays in state.json, reads null, and applies once listed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-fixedip-'));
    const stoppedProxy = { running: false, pid: null, port: 80, tls: false, lan: false, lanIp: null, tlds: ['local'], wildcard: null, elevated: false, managedBy: null };
    try {
      const logs = [];
      const net1 = createFakeNetwork(FIXTURE_NETWORKS.wifi); // en0 only: 10.9.8.7 is not listed
      const a = await startMockApi({ home, state: stateWith(), network: net1, adapter: createFakeAdapter({ proxy: stoppedProxy, routes: [] }), log: (m) => logs.push(m) });
      try {
        assert.equal((await api(a).get('/api/settings')).json.fixedIp, null, 'reported as unavailable');
        assert.ok(logs.some((l) => /10\.9\.8\.7 kept but not used/.test(l)), logs.join('\n'));
        // an unrelated write keeps the saved value
        assert.equal((await api(a).patch('/api/ui', { dismiss: 'first-run' })).status, 200);
        assert.equal((await api(a).patch('/api/settings', { wildcard: true })).status, 200);
        assert.equal(readState(home).settings.fixedIp, '10.9.8.7');
        // proxy start while unlisted goes without --ip
        await api(a).post('/api/proxy/start');
        await waitUntil(async () => (await api(a).get('/api/proxy')).json.job?.finishedAt);
        assert.equal(a.adapter.calls.find((x) => x.method === 'startProxy').args[0].fixedIp, null);
        // the address appears (Wi-Fi joins): the same process applies it
        net1.value = twoNics;
        await a.app.live.refreshNetwork();
        assert.equal((await api(a).get('/api/settings')).json.fixedIp, '10.9.8.7');
      } finally {
        await a.close();
      }
      assert.equal(readState(home).settings.fixedIp, '10.9.8.7');
      assert.deepEqual(readState(home).dismissed, ['first-run']);
      // restart with the address listed → applied, and used in the proxy flags
      const b = await startMockApi({ home, state: false, network: createFakeNetwork(twoNics), adapter: createFakeAdapter({ proxy: stoppedProxy, routes: [] }) });
      try {
        assert.equal((await api(b).get('/api/settings')).json.fixedIp, '10.9.8.7');
        await api(b).post('/api/proxy/start');
        await waitUntil(async () => (await api(b).get('/api/proxy')).json.job?.finishedAt);
        assert.equal(b.adapter.calls.find((x) => x.method === 'startProxy').args[0].fixedIp, '10.9.8.7');
        const setup = await startMockApi({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-fixedip2-')), state: { ...stateWith(), settings: { ...stateWith().settings, tls: true, port: 443 } }, network: createFakeNetwork(twoNics), adapter: createFakeAdapter({ proxy: { ...stoppedProxy, tls: true, port: 443 }, routes: [] }) });
        try {
          assert.equal((await api(setup).post('/api/setup-device')).json.setup.ip, '10.9.8.7');
        } finally {
          await setup.close();
          fs.rmSync(setup.home, { recursive: true, force: true });
        }
      } finally {
        await b.close();
      }
      // garbage values are still dropped on load (and may be persisted as null)
      const s = readState(home);
      fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ ...s, settings: { ...s.settings, fixedIp: '0.0.0.0' } }));
      const c = await startMockApi({ home, state: false, network: createFakeNetwork(twoNics) });
      try {
        assert.equal((await api(c).get('/api/settings')).json.fixedIp, null);
      } finally {
        await c.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('service install uses the saved fixedIp only while it is listed', async () => {
    const service = { stateDir: '/fake/.portless', port: 80, tls: false, lan: true, fixedIp: null, tlds: ['local'], wildcard: false };
    const proxy = { running: true, pid: 1, port: 80, tls: false, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'service' };
    const net1 = createFakeNetwork(FIXTURE_NETWORKS.wifi);
    const m = await startMockApi({ state: stateWith({ settings: { ...stateWith().settings, keepAfterRestart: true } }), network: net1, adapter: createFakeAdapter({ proxy, service, routes: [] }) });
    try {
      await api(m).post('/api/service', { action: 'install' });
      await waitUntil(async () => (await api(m).get('/api/proxy')).json.job?.finishedAt);
      assert.equal(m.adapter.calls.find((x) => x.method === 'serviceInstall').args[0].fixedIp, null);
      net1.value = twoNics;
      await api(m).post('/api/service', { action: 'install' });
      await waitUntil(async () => (await api(m).get('/api/proxy')).json.job?.finishedAt && m.adapter.calls.filter((x) => x.method === 'serviceInstall').length === 2);
      assert.equal(m.adapter.calls.filter((x) => x.method === 'serviceInstall')[1].args[0].fixedIp, '10.9.8.7');
    } finally {
      await m.close();
    }
  });

  it('50 sequential ?refresh=1 requests reuse a scan finished < 2 s ago', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    try {
      await mock.app.live.warm();
      const before = mock.discovery.scans;
      const t0 = Date.now();
      for (let i = 0; i < 50; i += 1) assert.equal((await api(mock).get('/api/services?refresh=1')).status, 200);
      const elapsed = Date.now() - t0;
      const ran = mock.discovery.scans - before;
      assert.ok(ran <= Math.ceil(elapsed / 2000) + 1, `${ran} scans in ${elapsed} ms`);
      await new Promise((r) => setTimeout(r, 2100));
      mock.discovery.services = [...mock.discovery.services, { ...mock.discovery.services[0], port: 9998, pid: 7, suggestedName: 'later' }];
      const after = mock.discovery.scans;
      const fresh = (await api(mock).get('/api/services?refresh=1')).json;
      assert.equal(mock.discovery.scans, after + 1, 'older than 2 s → a new scan');
      assert.ok(fresh.some((x) => x.port === 9998));
    } finally {
      await mock.close();
    }
  });
});

describe('iteration 5: wildcard restartNeeded for a manual proxy (N6 defect)', () => {
  it('settingsView uses wildcardDiffers when given', () => {
    const saved = { tls: false, port: 80, fixedIp: null, wildcard: true, keepAfterRestart: false };
    const proxy = { running: true, tls: false, port: 80, wildcard: true, managedBy: 'manual' };
    assert.equal(settingsView(saved, proxy, null).restartNeeded, false, 'echoed proxy.wildcard alone can never differ');
    assert.equal(settingsView(saved, proxy, null, { wildcardDiffers: true }).restartNeeded, true);
    assert.equal(settingsView(saved, proxy, null, { wildcardDiffers: false }).restartNeeded, false);
  });

  it('proxy started outside Nidum: no prompt on open; a requested wildcard asks to restart; a Nidum restart applies it', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', state: { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] } });
    const c = api(mock);
    const job = async (action) => {
      const r = await c.post(`/api/proxy/${action}`);
      await waitUntil(async () => {
        const p = (await c.get('/api/proxy')).json;
        return p.job?.id === r.json.job.id && p.job.finishedAt;
      });
    };
    try {
      assert.equal((await c.get('/api/settings')).json.restartNeeded, false, 'no strip on open');
      // N1 echoes the saved wildcard back as proxy.wildcard; that must not hide the change
      const on = await c.patch('/api/settings', { wildcard: true });
      assert.equal(on.json.wildcard, true);
      assert.equal(on.json.restartNeeded, true, 'unknown wildcard on a proxy started outside Nidum ≠ requested');
      await job('restart');
      assert.equal(mock.adapter.calls.filter((x) => x.method === 'startProxy').at(-1).args[0].wildcard, true);
      assert.equal((await c.get('/api/settings')).json.restartNeeded, false, 'started by Nidum with --wildcard');
      assert.equal((await c.patch('/api/settings', { wildcard: false })).json.restartNeeded, true);
      assert.equal((await c.patch('/api/settings', { wildcard: true })).json.restartNeeded, false, 'back to what the proxy runs with');
      // another process restarts the proxy (new pid): unknown again
      mock.adapter.proxy = { ...mock.adapter.proxy, pid: 5555 };
      assert.equal((await c.get('/api/settings')).json.restartNeeded, false);
      assert.equal((await c.patch('/api/settings', { wildcard: true })).json.restartNeeded, false, 'an unchanged value is not a request');
      assert.equal((await c.patch('/api/settings', { wildcard: false })).json.restartNeeded, true);
    } finally {
      await mock.close();
    }
  });

  it('service-managed: still compared with the plist (serviceReinstallNeeded), never restartNeeded', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    try {
      const r = await api(mock).patch('/api/settings', { wildcard: true });
      assert.equal(r.json.restartNeeded, false);
      assert.equal(r.json.serviceReinstallNeeded, true);
    } finally {
      await mock.close();
    }
  });
});

describe('iteration 6: host check vs Portless’s real 404 page (N6 validation 1 finding 1)', () => {
  const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'api');
  const PAGE_404 = fs.readFileSync(path.join(FIX, 'portless-404.html'));
  const PAGE_502 = fs.readFileSync(path.join(FIX, 'portless-502.html'));
  let proxy;
  let proxyPort;
  let app404;
  let app200;
  const replies = {};
  before(async () => {
    assert.ok(PAGE_404.length > 140 * 1024, 'the captured page is the real ~153 KB one');
    assert.ok(PAGE_404.indexOf('No app registered for') > 64 * 1024, 'marker sits past the old 64 KB cut');
    proxy = http.createServer((req, res) => {
      const host = String(req.headers.host).split(':')[0];
      const [status, headers, body] = replies[host] || [404, { 'content-type': 'text/html' }, PAGE_404];
      res.writeHead(status, { 'x-portless': '1', ...headers });
      // stream in small chunks like a real socket would
      let i = 0;
      const step = () => {
        if (i >= body.length) return res.end();
        res.write(body.subarray(i, i + 8192));
        i += 8192;
        setImmediate(step);
      };
      step();
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = proxy.address().port;
    app404 = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"no root"}');
    });
    await new Promise((r) => app404.listen(0, '127.0.0.1', r));
    app200 = await startThrowawayHttp();
    replies['own404.local'] = [404, { 'content-type': 'application/json' }, Buffer.from('{"error":"no root"}')];
    replies['fake404.local'] = [404, { 'content-type': 'text/plain' }, Buffer.from('nothing here')];
    replies['down.local'] = [502, { 'content-type': 'text/html' }, PAGE_502];
  });
  after(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => app404.close(r));
    await app200.close();
  });
  const check = (hostname, port = 1) => hostCheck({ route: { hostname, port, url: `http://${hostname}:${proxyPort}` }, proxy: { port: proxyPort, tls: false } });

  it('Portless’s real 404 page → not-routed (never ok)', async () => {
    const r = await check('unknown-name.local', app200.port);
    assert.equal(r.result, 'not-routed');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 404);
  });

  it('Portless’s real 502 page → app-down', async () => {
    assert.equal((await check('down.local')).result, 'app-down');
  });

  it('a 404 without the marker is the app’s own answer (E5 after validation 4)', async () => {
    const own = await check('own404.local', app404.address().port);
    assert.equal(own.result, 'ok', 'the app’s own 404');
    assert.equal(own.httpStatus, 404);
    const nameOnly = await check('fake404.local', app200.port);
    assert.equal(nameOnly.result, 'host-blocked', 'the app 404s only for its .local name');
    assert.match(nameOnly.message, /doesn’t serve that name/);
  });

  it('POST /api/routes/:name/check retries not-routed (route not loaded yet) and reports the real result', async () => {
    let calls = 0;
    const blocked = { result: 'host-blocked', ok: false, httpStatus: 403, framework: 'Vite', message: 'Vite blocks requests for recipes.local.', fix: "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.", checkedAt: new Date().toISOString() };
    const notRouted = { result: 'not-routed', ok: false, httpStatus: 404, framework: null, message: 'Portless doesn’t know recipes.local yet.', fix: null, checkedAt: new Date().toISOString() };
    const mock = await startMockApi({ scenario: 'manual-https', app: { hostCheck: async () => (++calls <= 2 ? notRouted : blocked) } });
    try {
      const r = await api(mock).post('/api/routes/recipes/check');
      assert.equal(r.json.result, 'host-blocked');
      assert.equal(calls, 3);
      const st = (await api(mock).get('/api/state')).json.routes.find((x) => x.name === 'recipes');
      assert.equal(st.hostCheck.result, 'host-blocked');
    } finally {
      await mock.close();
    }
    let n = 0;
    const always = await startMockApi({ scenario: 'manual-https', app: { notRoutedRetryMs: 400, hostCheck: async () => { n += 1; return notRouted; } } });
    try {
      const t0 = Date.now();
      const r = await api(always).post('/api/routes/recipes/check');
      assert.equal(r.json.result, 'not-routed');
      assert.ok(Date.now() - t0 >= 400 && n >= 2, `${n} tries in ${Date.now() - t0} ms`);
    } finally {
      await always.close();
    }
  });

  it('a stored host check is cleared when the route is re-created or changed', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      await c.post('/api/routes/recipes/check');
      assert.equal((await c.get('/api/routes')).json.find((x) => x.name === 'recipes').hostCheck.result, 'ok');
      await c.del('/api/routes/recipes');
      await c.post('/api/routes', { name: 'recipes', port: 5173 });
      assert.equal((await c.get('/api/routes')).json.find((x) => x.name === 'recipes').hostCheck, null);
    } finally {
      await mock.close();
    }
  });
});

describe('iteration 7 (N3 validation 4)', () => {
  let proxy;
  let proxyPort;
  const replies = {};
  before(async () => {
    proxy = http.createServer((req, res) => {
      const host = String(req.headers.host).split(':')[0];
      const r = replies[host];
      if (!r) {
        res.writeHead(404);
        return res.end('No app registered for x');
      }
      return r(req, res);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = proxy.address().port;
  });
  after(() => new Promise((r) => {
    proxy.closeAllConnections?.();
    proxy.close(r);
  }));
  const check = (hostname, port, deadline) => hostCheck({ route: { hostname, port, url: `http://${hostname}:${proxyPort}` }, proxy: { port: proxyPort, tls: false }, deadline });

  it('a slow app whose own 404 takes 3.5 s → ok (404) within ~5 s', async () => {
    const slowApp = http.createServer((req, res) => setTimeout(() => {
      res.writeHead(404);
      res.end('nope');
    }, 3500));
    await new Promise((r) => slowApp.listen(0, '127.0.0.1', r));
    replies['slow404.local'] = (req, res) => setTimeout(() => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }, 3500);
    try {
      const t0 = Date.now();
      const r = await check('slow404.local', slowApp.address().port, Date.now() + 5000);
      const took = Date.now() - t0;
      assert.equal(r.result, 'ok');
      assert.equal(r.httpStatus, 404);
      assert.ok(took < 5300, `took ${took} ms`);
    } finally {
      slowApp.closeAllConnections?.();
      await new Promise((r) => slowApp.close(r));
    }
  });

  it('a 404 over 512 KB without the marker → ok (the app’s own page)', async () => {
    const big = Buffer.alloc(700 * 1024, 'x');
    replies['big404.local'] = (req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(big);
    };
    const closed = await freePort();
    const r = await check('big404.local', closed, Date.now() + 5000);
    assert.equal(r.result, 'ok');
    assert.equal(r.httpStatus, 404);
  });

  it('an app that 404s only for its .local name → host-blocked “doesn’t serve that name”', async () => {
    const app = http.createServer((req, res) => {
      const h = String(req.headers.host).split(':')[0];
      res.writeHead(h.endsWith('.local') ? 404 : 200);
      res.end(h.endsWith('.local') ? 'unknown vhost' : 'home');
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    replies['vhost.local'] = (req, res) => {
      const up = http.request({ host: '127.0.0.1', port: app.address().port, path: req.url, headers: req.headers, agent: false }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.end();
    };
    try {
      const r = await check('vhost.local', app.address().port, Date.now() + 5000);
      assert.equal(r.result, 'host-blocked');
      assert.equal(r.httpStatus, 404);
      assert.match(r.message, /doesn’t serve that name/);
      assert.match(r.fix, /vhost\.local/);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it('the whole API check, retries included, is capped at ~5 s', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', app: { notRoutedRetryMs: 10_000, hostCheckBudgetMs: 800, hostCheck: async () => ({ result: 'not-routed', ok: false, httpStatus: 404, framework: null, message: 'x', fix: null, checkedAt: new Date().toISOString() }) } });
    try {
      const t0 = Date.now();
      const r = await api(mock).post('/api/routes/recipes/check');
      assert.equal(r.json.result, 'not-routed');
      assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    } finally {
      await mock.close();
    }
  });

  it('a wildcard PATCH with the unchanged value does not raise restartNeeded', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', state: { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: [] } });
    try {
      assert.equal((await api(mock).patch('/api/settings', { wildcard: false })).json.restartNeeded, false);
      assert.equal((await api(mock).patch('/api/settings', { wildcard: false, tls: true })).json.restartNeeded, false);
      assert.equal((await api(mock).patch('/api/settings', { wildcard: true })).json.restartNeeded, true);
    } finally {
      await mock.close();
    }
  });
});

describe('iteration 8 (graph validation 2 F1, F3)', () => {
  it('F1: turning off Keep sharing after restart uninstalls the service and starts the manual proxy in the same job; no sharing-off', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    const c = api(mock);
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const p = await c.patch('/api/settings', { keepAfterRestart: false });
      assert.equal(p.json.serviceReinstallNeeded, true);
      const from = s.events.length;
      const r = await c.post('/api/service', { action: 'apply' });
      assert.equal(r.status, 202);
      assert.equal(r.json.job.action, 'service-uninstall');
      const done = await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === r.json.job.id && e.data.job.finishedAt, 5000, from);
      assert.equal(done.data.job.phase, 'done', JSON.stringify(done.data.job));
      const after = (await c.get('/api/state')).json;
      assert.equal(after.proxy.running, true);
      assert.equal(after.proxy.managedBy, 'manual');
      assert.equal(after.proxy.pausedByUser, false);
      assert.equal(after.settings.serviceReinstallNeeded, false);
      assert.equal(after.capabilities.pause.supported, true);
      assert.ok(!after.banners.some((b) => b.id === 'sharing-off' || b.id === 'sharing-paused'));
      const calls = mock.adapter.calls.map((x) => x.method).filter((m) => ['serviceUninstall', 'startProxy'].includes(m));
      assert.deepEqual(calls, ['serviceUninstall', 'startProxy']);
      assert.deepEqual(mock.adapter.calls.find((x) => x.method === 'startProxy').args[0], { tls: false, port: 80, lan: true, fixedIp: null, wildcard: false });
      const events = s.events.slice(from);
      const phases = events.filter((e) => e.event === 'proxy' && e.data.job?.id === r.json.job.id).map((e) => e.data.job.phase);
      assert.equal(phases.filter((x) => x === 'waitingForPassword').length, 2, `one dialog per elevated command: ${phases.join(',')}`);
      for (const e of events.filter((x) => x.event === 'banners')) assert.ok(!e.data.some((b) => b.id === 'sharing-off'), 'no crash banner during the change');
    } finally {
      s.close();
      await mock.close();
    }
  });

  it('F1: if the follow-up start fails, the job fails with a clear message and the paused info banner shows', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    const c = api(mock);
    try {
      await c.patch('/api/settings', { keepAfterRestart: false });
      mock.adapter.failNext('startProxy', new PortlessError('PORT_IN_USE', 'Another program is using port 80.', { raw: 'EADDRINUSE' }));
      const r = await c.post('/api/service', { action: 'apply' });
      const p = await waitUntil(async () => {
        const x = (await c.get('/api/proxy')).json;
        return x.job?.id === r.json.job.id && x.job.finishedAt ? x : null;
      });
      assert.equal(p.job.phase, 'failed');
      assert.equal(p.job.error.code, 'PORT_IN_USE');
      assert.match(p.job.error.message, /^Keep sharing after restart is off\. Sharing didn’t start again: Another program is using port 80\./);
      assert.equal(p.running, false);
      assert.equal(p.pausedByUser, true);
      const banners = (await c.get('/api/state')).json.banners;
      assert.ok(banners.some((b) => b.id === 'sharing-paused'));
      assert.ok(!banners.some((b) => b.id === 'sharing-off'));
    } finally {
      await mock.close();
    }
  });

  it('F1: bannersView suppresses stop banners while a service job runs', () => {
    assert.deepEqual(bannersView({ proxy: { running: false }, network: null, dismissed: ['first-run'], portlessInstalled: true, changing: true }), []);
    assert.equal(bannersView({ proxy: { running: false }, network: null, dismissed: ['first-run'], portlessInstalled: true })[0].id, 'sharing-off');
  });

  it('F3: Discover hides other Nidum Local dashboards (by /api/health or the 401 page title)', async () => {
    const other = await startMockApi({ scenario: 'empty' });
    const plain = await startThrowawayHttp({ title: 'Just an app' });
    const mock = await startMockApi({ scenario: 'manual-https', app: { forcedScanMinMs: 0 } });
    try {
      const base = { pid: 99, process: 'node', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: '/Users/me/code/x', command: 'node', hidden: null };
      mock.discovery.services = [
        { ...base, port: other.port, http: { status: 401, title: null, server: null, framework: null, redirectsTo: null, tls: false }, suggestedName: 'nidum' },
        { ...base, port: 6123, pid: 98, http: { status: 401, title: 'Nidum Local', server: null, framework: null, redirectsTo: null, tls: false }, suggestedName: 'nidum-local' },
        { ...base, port: plain.port, pid: 97, http: { status: 200, title: 'Just an app', server: null, framework: null, redirectsTo: null, tls: false }, suggestedName: 'just-an-app' },
      ];
      const list = (await api(mock).get('/api/services?refresh=1')).json;
      const by = Object.fromEntries(list.map((x) => [x.port, x]));
      assert.equal(by[other.port].hidden, 'nidum-dashboard', 'identified by /api/health');
      assert.equal(by[6123].hidden, 'nidum-dashboard', 'identified by its page title');
      assert.equal(by[plain.port].hidden, null);
      // cached per port + pid: a rescan doesn't ask again
      const asked = mock.app.live.cache.dashboards.get(other.port);
      assert.deepEqual(asked, { pid: 99, nidum: true });
    } finally {
      await mock.close();
      await other.close();
      await plain.close();
    }
  });
});

describe('iteration 9: stop and start a service-managed proxy (E12, D40–D43)', () => {
  const pollJob = (c, id) => waitUntil(async () => {
    const p = (await c.get('/api/proxy')).json;
    return p.job?.id === id && p.job.finishedAt ? p : null;
  }, 5000);

  it('POST /api/proxy/stop → service-stop job (password phase) → paused; POST /api/proxy/start → service-start → sharing again', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    const c = api(mock);
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const stop = await c.post('/api/proxy/stop');
      assert.equal(stop.status, 202);
      assert.equal(stop.json.job.action, 'service-stop');
      assert.equal(stop.json.job.phase, 'stopping');
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === stop.json.job.id && e.data.job.phase === 'waitingForPassword');
      const stopped = await pollJob(c, stop.json.job.id);
      assert.equal(stopped.job.phase, 'done');
      assert.equal(stopped.running, false);
      assert.equal(stopped.managedBy, 'service', 'the service file stays');
      assert.equal(stopped.serviceLoaded, false);
      assert.equal(stopped.pausedByUser, true);
      assert.equal(readState(mock.home).paused, true);
      let st = (await c.get('/api/state')).json;
      assert.deepEqual(st.banners.filter((b) => b.id.startsWith('sharing-')).map((b) => b.id), ['sharing-paused']);
      assert.deepEqual(st.capabilities.pause, { supported: true, reason: null });
      assert.deepEqual(mock.adapter.calls.filter((x) => /Proxy$|Service$/.test(x.method) && x.method !== 'getProxyState').map((x) => x.method), ['stopService']);
      const start = await c.post('/api/proxy/start');
      assert.equal(start.json.job.action, 'service-start');
      const started = await pollJob(c, start.json.job.id);
      assert.equal(started.job.phase, 'done');
      assert.equal(started.running, true);
      assert.equal(started.serviceLoaded, true);
      assert.equal(started.pausedByUser, false);
      assert.equal('paused' in readState(mock.home), false);
      st = (await c.get('/api/state')).json;
      assert.ok(!st.banners.some((b) => b.id.startsWith('sharing-')));
      for (const e of s.events.filter((x) => x.event === 'banners')) assert.ok(!e.data.some((b) => b.id === 'sharing-off'), 'no crash banner at any point');
    } finally {
      s.close();
      await mock.close();
    }
  });

  it('a cancelled password leaves sharing on and unpaused; a failed start stays paused', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    const c = api(mock);
    try {
      mock.adapter.failNext('stopService', new PortlessError('PERMISSION', 'Password not entered. Nothing changed.', { raw: 'User canceled. (-128)' }));
      const r = await c.post('/api/proxy/stop');
      const p = await pollJob(c, r.json.job.id);
      assert.equal(p.job.phase, 'failed');
      assert.deepEqual(p.job.error, { code: 'PERMISSION', message: 'Password not entered. Nothing changed.', raw: 'User canceled. (-128)' });
      assert.equal(p.running, true);
      assert.equal(p.pausedByUser, false);
      assert.equal('paused' in readState(mock.home), false);
      await pollJob(c, (await c.post('/api/proxy/stop')).json.job.id);
      mock.adapter.failNext('startService', new PortlessError('TIMEOUT'));
      const f = await pollJob(c, (await c.post('/api/proxy/start')).json.job.id);
      assert.equal(f.job.phase, 'failed');
      assert.equal(f.job.error.code, 'TIMEOUT');
      assert.equal(f.running, false);
      assert.equal(f.pausedByUser, true, 'still a deliberate pause, not a crash');
      assert.ok((await c.get('/api/state')).json.banners.some((b) => b.id === 'sharing-paused'));
    } finally {
      await mock.close();
    }
  });

  it('BUSY: a start while a service-stop runs → 409; the same action is reused', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const mock = await startMockApi({ scenario: 'mac-service', onElevate: () => gate });
    const c = api(mock);
    try {
      const stop = await c.post('/api/proxy/stop');
      assert.equal((await c.post('/api/proxy/stop')).json.reused, true);
      const busy = await c.post('/api/proxy/start');
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error.code, 'BUSY');
      release();
      await pollJob(c, stop.json.job.id);
    } finally {
      release();
      await mock.close();
    }
  });

  it('platforms without service stop (Windows) and adapters without stopService keep 409/422', async () => {
    const win = await startMockApi({ scenario: 'mac-service', app: { platform: 'win32' } });
    try {
      assert.equal((await api(win).post('/api/proxy/stop')).json.error.code, 'SERVICE_MANAGED');
      assert.equal((await api(win).get('/api/state')).json.capabilities.pause.supported, false);
    } finally {
      await win.close();
    }
    const adapter = createFakeAdapter({ proxy: { running: true, pid: 1, port: 80, tls: false, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'service' }, service: { stateDir: '/x', port: 80, tls: false, lan: true, fixedIp: null, tlds: ['local'], wildcard: false }, routes: [] });
    delete adapter.stopService;
    const old = await startMockApi({ adapter });
    try {
      const r = await api(old).post('/api/proxy/stop');
      assert.equal(r.status, 422);
      assert.equal(r.json.error.code, 'UNSUPPORTED');
    } finally {
      await old.close();
    }
  });

  it('the paused service survives a server restart (D33) and a boot that starts it clears the pause', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-e12-'));
    try {
      const a = await startMockApi({ scenario: 'mac-service', home });
      try {
        await pollJob(api(a), (await api(a).post('/api/proxy/stop')).json.job.id);
      } finally {
        await a.close();
      }
      const svc = { stateDir: '/x', port: 80, tls: false, lan: true, fixedIp: null, tlds: ['local'], wildcard: false };
      const stoppedProxy = { running: false, pid: null, port: 80, tls: false, lan: true, lanIp: null, tlds: ['local'], wildcard: false, elevated: false, managedBy: 'service', serviceLoaded: false };
      const b = await startMockApi({ home, state: false, adapter: createFakeAdapter({ proxy: stoppedProxy, service: svc, routes: [] }) });
      try {
        const st = (await api(b).get('/api/state')).json;
        assert.equal(st.proxy.pausedByUser, true);
        assert.equal(st.proxy.serviceLoaded, false);
        assert.ok(st.banners.some((x) => x.id === 'sharing-paused'));
      } finally {
        await b.close();
      }
      const booted = await startMockApi({ home, state: false, adapter: createFakeAdapter({ proxy: { ...stoppedProxy, running: true, pid: 12825, serviceLoaded: true }, service: svc, routes: [] }) });
      try {
        const p = (await api(booted).get('/api/proxy')).json;
        assert.equal(p.serviceLoaded, true);
        assert.equal(p.running, true);
        assert.equal(p.pausedByUser, false, 'after a reboot the loaded, answering service clears a stale pause');
        assert.equal('paused' in readState(home), false, 'and state.json forgets it');
        assert.ok(!(await api(booted).get('/api/state')).json.banners.some((x) => x.id.startsWith('sharing-')));
      } finally {
        await booted.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('iteration 10 (N3 validation 5)', () => {
  const pollJob = (c, id) => waitUntil(async () => {
    const p = (await c.get('/api/proxy')).json;
    return p.job?.id === id && p.job.finishedAt ? p : null;
  }, 5000);

  it('D45: turning off Keep sharing after restart while paused removes the service and keeps the pause', async () => {
    const mock = await startMockApi({ scenario: 'mac-service', passwordDelayMs: 0 });
    const c = api(mock);
    try {
      await pollJob(c, (await c.post('/api/proxy/stop')).json.job.id);
      assert.equal((await c.get('/api/proxy')).json.pausedByUser, true);
      await c.patch('/api/settings', { keepAfterRestart: false });
      const r = await c.post('/api/service', { action: 'apply' });
      assert.equal(r.json.job.action, 'service-uninstall');
      const p = await pollJob(c, r.json.job.id);
      assert.equal(p.job.phase, 'done');
      assert.equal(p.running, false);
      assert.equal(p.managedBy, null, 'the service is gone');
      assert.equal(p.pausedByUser, true, 'the pause stays');
      assert.equal(readState(mock.home).paused, true);
      const calls = mock.adapter.calls.map((x) => x.method);
      assert.ok(calls.includes('serviceUninstall'));
      assert.ok(!calls.includes('startProxy'), 'no manual proxy is started');
      const st = (await c.get('/api/state')).json;
      assert.ok(st.banners.some((b) => b.id === 'sharing-paused'));
      assert.ok(!st.banners.some((b) => b.id === 'sharing-off'));
    } finally {
      await mock.close();
    }
  });

  it('a forced refresh stays within the 4 s scan budget with 40 silent ports; detection finishes in the background', async () => {
    const silent = [];
    const sockets = new Set();
    for (let i = 0; i < 40; i += 1) {
      const srv = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('error', () => {});
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      silent.push(srv);
    }
    const other = await startMockApi({ scenario: 'empty' });
    const mock = await startMockApi({ scenario: 'manual-https', app: { forcedScanMinMs: 0, intervals: FAST } });
    const ev = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await ev.waitFor((e) => e.event === 'state');
      const base = { process: 'node', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: '/x', command: 'node', hidden: null, suggestedName: 'x', http: { status: 200, title: null, server: null, framework: null, redirectsTo: null, tls: false } };
      // the other dashboard comes last, behind 40 ports that never answer
      const list = [...silent.map((srv, i) => ({ ...base, port: srv.address().port, pid: 1000 + i })), { ...base, port: other.port, pid: 2000, http: { ...base.http, status: 401 } }];
      mock.discovery.services = list;
      const t0 = Date.now();
      const r = await api(mock).get('/api/services?refresh=1');
      const took = Date.now() - t0;
      assert.equal(r.status, 200);
      assert.ok(took < 4600, `forced refresh took ${took} ms`);
      const hidden = await waitUntil(async () => {
        const svc = (await api(mock).get('/api/services')).json.find((x) => x.port === other.port);
        return svc?.hidden === 'nidum-dashboard' ? svc : null;
      }, 8000);
      assert.ok(hidden);
      await ev.waitFor((e) => e.event === 'services' && e.data.some((x) => x.port === other.port && x.hidden === 'nidum-dashboard'), 8000);
    } finally {
      ev.close();
      await mock.close();
      await other.close();
      for (const sock of sockets) sock.destroy();
      await Promise.all(silent.map((srv) => new Promise((r) => srv.close(r))));
    }
  });

  it('mock: waitingForPassword really lasts the fake 250 ms', async () => {
    const mock = await startMockApi({ scenario: 'mac-service' });
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const r = await api(mock).post('/api/proxy/stop');
      const id = r.json.job.id;
      const waiting = await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === id && e.data.job.phase === 'waitingForPassword');
      const t0 = Date.now();
      const after = s.events.indexOf(waiting) + 1;
      // the next phase of this job (back to stopping, or done) comes only after the fake dialog closes
      await s.waitFor((e) => e.event === 'proxy' && e.data.job?.id === id && e.data.job.phase !== 'waitingForPassword', 3000, after);
      assert.ok(Date.now() - t0 >= 200, `password phase lasted ${Date.now() - t0} ms`);
      await pollJob(api(mock), id);
    } finally {
      s.close();
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Iteration 11: locked or read-only address list (E13, D46–D48)
// ---------------------------------------------------------------------------

describe('iteration 11: locked address list (E13)', () => {
  const LOCKED_MSG = "Your address list is locked, so Nidum Local can't change it.";
  const NOT_WRITABLE_MSG = "Nidum Local isn't allowed to change your address list.";
  const FILE = '/Users/me/.portless/routes.json';
  const UNLOCKED = { locked: false, flag: null, target: null, writable: true, path: FILE, owner: null, ownedByYou: null };
  // D51/D53: the mock's locked file is the user's own; details carry the full blocking-path facts
  const LOCKED_UCHG = { path: FILE, flag: 'uchg', target: 'file', owner: 'me', ownedByYou: true };

  it('ROUTES_LOCKED and ROUTES_NOT_WRITABLE → 423 with details and raw; never PERMISSION or INTERNAL', () => {
    assert.equal(apiCodeFor('ROUTES_LOCKED'), 'ROUTES_LOCKED');
    assert.equal(apiCodeFor('ROUTES_NOT_WRITABLE'), 'ROUTES_NOT_WRITABLE');
    const locked = toErrorResponse(new PortlessError('ROUTES_LOCKED', undefined, { raw: `EPERM: operation not permitted, open '${FILE}'`, details: LOCKED_UCHG }));
    assert.deepEqual(locked, { status: 423, body: { error: { code: 'ROUTES_LOCKED', message: LOCKED_MSG, details: LOCKED_UCHG, raw: `EPERM: operation not permitted, open '${FILE}'` } } });
    const nwDetails = { path: FILE, target: 'file', owner: 'root', ownedByYou: false };
    const nw = toErrorResponse(new PortlessError('ROUTES_NOT_WRITABLE', undefined, { raw: 'EACCES: permission denied', details: nwDetails }));
    assert.deepEqual(nw, { status: 423, body: { error: { code: 'ROUTES_NOT_WRITABLE', message: NOT_WRITABLE_MSG, details: nwDetails, raw: 'EACCES: permission denied' } } });
    // the adapter's details are passed through as they are (also an older shape)
    const old = toErrorResponse(new PortlessError('ROUTES_LOCKED', undefined, { raw: 'EPERM', details: { path: FILE, flag: 'uchg', target: 'file' } }));
    assert.deepEqual(old.body.error.details, { path: FILE, flag: 'uchg', target: 'file' });
    // a plain object with the code (e.g. from a job) maps the same way
    assert.equal(toErrorResponse(Object.assign(new Error('x'), { code: 'ROUTES_LOCKED' })).status, 423);
  });

  it('normalizeRoutesAccess and the banner helper', () => {
    assert.equal(normalizeRoutesAccess(null), null);
    assert.equal(normalizeRoutesAccess('nope'), null);
    assert.deepEqual(normalizeRoutesAccess({ locked: true, flag: 'schg', target: 'folder', writable: false, path: '/p', owner: 'root', ownedByYou: false, extra: 1 }), { locked: true, flag: 'schg', target: 'folder', writable: false, path: '/p', owner: 'root', ownedByYou: false });
    assert.deepEqual(normalizeRoutesAccess({ locked: false, flag: 'uchg', writable: true, path: '/p' }), { locked: false, flag: null, target: null, writable: true, path: '/p', owner: null, ownedByYou: null }, 'flag only when locked; an adapter from before D51 → ownedByYou null');
    // D51: ownedByYou is exactly true / false / null; D53: target is kept when not locked too
    for (const [v, want] of [[true, true], [false, false], [null, null], [undefined, null], ['true', null], [1, null], [{}, null]]) {
      assert.equal(normalizeRoutesAccess({ locked: false, writable: false, path: '/p', owner: 'x', ownedByYou: v }).ownedByYou, want, String(v));
    }
    assert.equal(normalizeRoutesAccess({ locked: false, target: 'folder', writable: false, path: '/d' }).target, 'folder');
    assert.equal(normalizeRoutesAccess({ locked: false, target: 'disk', writable: false, path: '/d' }).target, null);
    assert.equal(routesAccessBanner(normalizeRoutesAccess(UNLOCKED)), null);
    assert.deepEqual(routesAccessBanner({ locked: true, flag: 'uchg', target: 'file', writable: false, path: FILE, owner: 'me', ownedByYou: true }), { id: 'routes-locked', kind: 'error', message: ROUTES_LOCKED_MESSAGE, details: LOCKED_UCHG });
    assert.deepEqual(routesAccessBanner({ locked: false, flag: null, target: 'file', writable: false, path: FILE, owner: 'root', ownedByYou: false }), { id: 'routes-not-writable', kind: 'error', message: ROUTES_NOT_WRITABLE_MESSAGE, details: { path: FILE, target: 'file', owner: 'root', ownedByYou: false } });
    // D53 key sets and order: { path, flag?, target, owner, ownedByYou }
    assert.deepEqual(Object.keys(routesAccessBanner(normalizeRoutesAccess({ locked: true, flag: 'uchg', target: 'file', writable: false, path: FILE })).details), ['path', 'flag', 'target', 'owner', 'ownedByYou']);
    assert.deepEqual(Object.keys(routesAccessBanner(normalizeRoutesAccess({ locked: false, writable: false, path: FILE })).details), ['path', 'target', 'owner', 'ownedByYou']);
    assert.equal(ROUTES_LOCKED_MESSAGE, "Your address list is locked, so addresses can't be added, changed or removed.");
    assert.equal(ROUTES_NOT_WRITABLE_MESSAGE, "Nidum Local isn't allowed to change your address list.");
    // D59(d) order: portless-missing, first-run, sharing-paused | sharing-off, routes-*, network-off,
    // public-network; locked wins over not-writable
    const LOCKED_ACCESS = { locked: true, flag: 'uchg', target: 'file', writable: false, path: FILE, owner: 'me', ownedByYou: true };
    const NW_ACCESS = { locked: false, flag: null, target: 'file', writable: false, path: FILE, owner: 'root', ownedByYou: false };
    const order = (input) => bannersView({ network: FIXTURE_NETWORKS.guest, dismissed: [], portlessInstalled: false, ...input }).map((b) => b.id);
    assert.deepEqual(order({ proxy: { running: false }, routesAccess: LOCKED_ACCESS }), ['portless-missing', 'first-run', 'sharing-off', 'routes-locked', 'public-network']);
    assert.deepEqual(order({ proxy: { running: false }, pausedByUser: true, routesAccess: LOCKED_ACCESS }), ['portless-missing', 'first-run', 'sharing-paused', 'routes-locked', 'public-network']);
    assert.deepEqual(order({ proxy: { running: false }, pausedByUser: true, routesAccess: NW_ACCESS }), ['portless-missing', 'first-run', 'sharing-paused', 'routes-not-writable', 'public-network']);
    assert.deepEqual(order({ proxy: { running: true, lan: false }, routesAccess: LOCKED_ACCESS }), ['portless-missing', 'first-run', 'routes-locked', 'network-off', 'public-network']);
    assert.deepEqual(order({ proxy: { running: true, lan: false }, routesAccess: NW_ACCESS }), ['portless-missing', 'first-run', 'routes-not-writable', 'network-off', 'public-network']);
    assert.deepEqual(order({ proxy: { running: false }, changing: true, routesAccess: LOCKED_ACCESS }), ['portless-missing', 'first-run', 'routes-locked', 'public-network'], 'no stop banner while a service job runs');
    assert.deepEqual(order({ proxy: null, routesAccess: LOCKED_ACCESS, dismissed: ['first-run'], portlessInstalled: true }), ['routes-locked', 'public-network']);
    const nw = bannersView({ proxy: { running: true, lan: true }, network: null, dismissed: ['first-run'], portlessInstalled: true, routesAccess: { locked: false, writable: false, path: FILE, owner: null } });
    assert.deepEqual(nw.map((b) => b.id), ['routes-not-writable']);
    assert.deepEqual(nw[0].details, { path: FILE, target: null, owner: null, ownedByYou: null });
    assert.deepEqual(bannersView({ proxy: null, network: null, dismissed: ['first-run'], portlessInstalled: true }), [], 'no routesAccess yet → no banner');
  });

  it('mock scenarios: routes-locked (uchg) and routes-locked-schg; every other scenario unlocked and writable', async () => {
    assert.ok(SCENARIO_NAMES.includes('routes-locked') && SCENARIO_NAMES.includes('routes-locked-schg'));
    for (const name of SCENARIO_NAMES) {
      const mock = await startMockApi({ scenario: name });
      try {
        const s = (await api(mock).get('/api/state')).json;
        const direct = await mock.adapter.getRoutesAccess();
        assert.deepEqual(s.routesAccess, direct, name);
        if (name === 'routes-locked' || name === 'routes-locked-schg') {
          const flag = name === 'routes-locked' ? 'uchg' : 'schg';
          assert.deepEqual(direct, { locked: true, flag, target: 'file', writable: false, path: FILE, owner: 'me', ownedByYou: true });
          assert.deepEqual(Object.keys(direct), ['locked', 'flag', 'target', 'writable', 'path', 'owner', 'ownedByYou'], 'N1 key order');
          const lockedBanner = s.banners.find((b) => b.id === 'routes-locked');
          assert.ok(lockedBanner, name);
          assert.deepEqual(lockedBanner.details, { ...LOCKED_UCHG, flag });
          // the fake throws the real error class with N1's shape
          const err = await mock.adapter.addAlias('fresh', 3000).catch((e) => e);
          assert.ok(err instanceof PortlessError);
          assert.equal(err.code, 'ROUTES_LOCKED');
          assert.equal(err.message, LOCKED_MSG);
          assert.deepEqual(err.details, { ...LOCKED_UCHG, flag });
          assert.deepEqual(err.details, lockedBanner.details, 'D53: banner details equal the error details');
          assert.equal(err.raw, `EPERM: operation not permitted, open '${FILE}'`);
          // the rest of the scenario is mac-service
          assert.equal(s.proxy.managedBy, 'service');
          assert.equal(s.routes.length, 4);
        } else {
          assert.equal(direct.locked, false, name);
          assert.equal(direct.writable, true, name);
          assert.equal(direct.ownedByYou, null, name);
          assert.ok(!s.banners.some((b) => b.id.startsWith('routes-')), name);
        }
      } finally {
        await mock.close();
      }
    }
  });

  it('routes-locked: every mutation route → 423 ROUTES_LOCKED with the adapter’s details and raw; nothing changes', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked' });
    const c = api(mock);
    try {
      const routesBefore = JSON.stringify(mock.adapter.routes);
      const stateBefore = fs.readFileSync(path.join(mock.home, 'state.json'), 'utf8');
      const expected = { code: 'ROUTES_LOCKED', message: LOCKED_MSG, details: LOCKED_UCHG, raw: `EPERM: operation not permitted, open '${FILE}'` };
      const cases = [
        ['POST', '/api/routes', { name: 'fresh', port: 3000 }],
        ['POST', '/api/routes', { name: 'plex', port: 3000, force: true }],
        ['PATCH', '/api/routes/plex', { port: 32401 }],
        ['PATCH', '/api/routes/plex', { newName: 'movies' }],
        ['DELETE', '/api/routes/plex', {}],
        ['DELETE', '/api/routes/old.localhost', {}],
      ];
      for (const [method, p, body] of cases) {
        const before = mock.adapter.calls.length;
        const r = await request(mock.port, method, p, { token: mock.token, body });
        assert.equal(r.status, 423, `${method} ${p}`);
        assert.deepEqual(r.json, { error: expected }, `${method} ${p}`);
        // the refused write re-read routesAccess without the adapter's cache
        assert.ok(mock.adapter.calls.slice(before).some((x) => x.method === 'getRoutesAccess' && x.args[0].refresh === true), `${method} ${p} refreshed access`);
      }
      assert.equal(JSON.stringify(mock.adapter.routes), routesBefore);
      assert.equal(fs.readFileSync(path.join(mock.home, 'state.json'), 'utf8'), stateBefore, 'state.json untouched (no name saved)');
      // precondition failures keep their own codes
      assert.equal((await c.post('/api/routes', { name: 'plex', port: 3000 })).json.error.code, 'NAME_TAKEN');
      assert.equal((await c.patch('/api/routes/shop', { port: 1 })).json.error.code, 'NAME_TAKEN_BY_APP');
      assert.equal((await c.del('/api/routes/nope')).status, 404);
      const s = (await c.get('/api/state')).json;
      assert.deepEqual(s.routesAccess, { locked: true, flag: 'uchg', target: 'file', writable: false, path: FILE, owner: 'me', ownedByYou: true });
      // D59(d): after first-run (the proxy is running, so there's no sharing banner)
      assert.deepEqual(s.banners.map((b) => b.id), ['first-run', 'routes-locked']);
      assert.deepEqual(s.banners[1], { id: 'routes-locked', kind: 'error', message: "Your address list is locked, so addresses can't be added, changed or removed.", details: LOCKED_UCHG });
      assert.deepEqual(s.banners[1].details, expected.details, 'D53: banner details equal the error details');
      // portless-missing stays first
      mock.adapter.portless = null;
      assert.deepEqual((await c.get('/api/state')).json.banners.map((b) => b.id), ['portless-missing', 'first-run', 'routes-locked']);
    } finally {
      await mock.close();
    }
  });

  it('routes-locked-schg: the schg flag reaches the error, routesAccess and the banner', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked-schg' });
    const c = api(mock);
    try {
      const r = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.equal(r.status, 423);
      assert.deepEqual(r.json.error.details, { ...LOCKED_UCHG, flag: 'schg' });
      const s = (await c.get('/api/state')).json;
      assert.equal(s.routesAccess.flag, 'schg');
      assert.deepEqual(s.banners.find((b) => b.id === 'routes-locked').details, r.json.error.details);
    } finally {
      await mock.close();
    }
  });

  it('not writable (owner) and a locked folder, flipped at runtime; routesAccess follows a refused write at once', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    const file = '/fake/.portless/routes.json';
    try {
      assert.equal((await c.get('/api/state')).json.routesAccess.locked, false);
      mock.adapter.setRoutesWritable(false, { owner: 'root' });
      const r = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.equal(r.status, 423);
      const rootDetails = { path: file, target: 'file', owner: 'root', ownedByYou: false };
      assert.deepEqual(r.json.error, { code: 'ROUTES_NOT_WRITABLE', message: NOT_WRITABLE_MSG, details: rootDetails, raw: `EACCES: permission denied, open '${file}'` });
      // no scan needed: the refused write already refreshed it
      let s = mock.app.live.snapshot();
      assert.deepEqual(s.routesAccess, { locked: false, flag: null, target: 'file', writable: false, path: file, owner: 'root', ownedByYou: false });
      assert.deepEqual(s.banners.filter((b) => b.id.startsWith('routes-')), [{ id: 'routes-not-writable', kind: 'error', message: NOT_WRITABLE_MSG, details: rootDetails }]);
      // D51: your own file with read-only permissions (chmod u+w), then your own folder
      mock.adapter.setRoutesWritable(false, { owner: 'me', ownedByYou: true });
      const mine = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.deepEqual(mine.json.error.details, { path: file, target: 'file', owner: 'me', ownedByYou: true });
      assert.deepEqual(mock.app.live.snapshot().banners.find((b) => b.id === 'routes-not-writable').details, mine.json.error.details);
      mock.adapter.setRoutesWritable(false, { owner: 'me', target: 'folder' });
      const dir = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.deepEqual(dir.json.error.details, { path: '/fake/.portless', target: 'folder', owner: 'me', ownedByYou: true }, 'ownedByYou defaults to owner === me');
      assert.equal(dir.json.error.raw, "EACCES: permission denied, mkdir '/fake/.portless/routes.lock'");
      assert.deepEqual(mock.app.live.snapshot().banners.find((b) => b.id === 'routes-not-writable').details, dir.json.error.details);
      // an unknown owner → ownedByYou null
      mock.adapter.setRoutesWritable(false);
      assert.deepEqual((await c.post('/api/routes', { name: 'fresh', port: 3000 })).json.error.details, { path: file, target: 'file', owner: null, ownedByYou: null });
      mock.adapter.lockRoutes({ flag: 'uchg', target: 'folder' });
      const f = await c.patch('/api/routes/recipes', { port: 5174 });
      assert.equal(f.status, 423);
      const folderLock = { path: '/fake/.portless', flag: 'uchg', target: 'folder', owner: 'me', ownedByYou: true };
      assert.deepEqual(f.json.error.details, folderLock);
      assert.equal(f.json.error.raw, "EPERM: operation not permitted, mkdir '/fake/.portless/routes.lock'");
      s = mock.app.live.snapshot();
      assert.deepEqual(s.banners.filter((b) => b.id.startsWith('routes-')).map((b) => [b.id, b.details]), [['routes-locked', folderLock]], 'locked wins; never both');
      // a lock on someone else's file (e.g. schg set by an admin on a root-owned list)
      mock.adapter.lockRoutes({ flag: 'schg', owner: 'root' });
      const other = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.deepEqual(other.json.error.details, { path: file, flag: 'schg', target: 'file', owner: 'root', ownedByYou: false });
      assert.deepEqual(mock.app.live.snapshot().banners.find((b) => b.id === 'routes-locked').details, other.json.error.details);
      assert.equal(mock.adapter.routes.find((x) => x.hostname === 'recipes.local').port, 5173);
    } finally {
      await mock.close();
    }
  });

  it('"Check again": GET /api/state?refresh=1 re-reads without the cache; a write that works clears the banner', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      mock.adapter.unlockRoutes(); // the user unchecked "Locked" in Finder
      assert.equal((await c.get('/api/state')).json.routesAccess.locked, true, 'a plain read serves the last value until the next scan');
      const before = mock.adapter.calls.length;
      const s = (await c.get('/api/state?refresh=1')).json;
      assert.deepEqual(s.routesAccess, UNLOCKED);
      assert.ok(!s.banners.some((b) => b.id.startsWith('routes-')));
      assert.ok(mock.adapter.calls.slice(before).some((x) => x.method === 'getRoutesAccess' && x.args[0].refresh === true));
      assert.equal((await c.post('/api/routes', { name: 'fresh', port: 3000 })).status, 201);
      // locked again, then unlocked: a successful write re-reads access by itself
      mock.adapter.lockRoutes();
      assert.equal((await c.post('/api/routes', { name: 'other', port: 3000 })).status, 423);
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
      mock.adapter.unlockRoutes();
      assert.equal((await c.post('/api/routes', { name: 'other', port: 3000 })).status, 201);
      await waitUntil(() => mock.app.live.snapshot().routesAccess.locked === false, 1000);
    } finally {
      await mock.close();
    }
  });

  it('a refused write never joins a forced read that started before it (validation 6 F2); a write that works neither', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      // like the real `stat`: the answer is what the disk said when the read started, delivered later
      const orig = mock.adapter.getRoutesAccess;
      let lagMs = 0;
      mock.adapter.getRoutesAccess = async (opts) => {
        const v = await orig(opts);
        if (lagMs) await new Promise((r) => setTimeout(r, lagMs));
        return v;
      };
      const forcedReads = (from) => mock.adapter.calls.slice(from).filter((x) => x.method === 'getRoutesAccess' && x.args[0].refresh === true).length;
      lagMs = 800;
      let from = mock.adapter.calls.length;
      const checkAgain = c.get('/api/state?refresh=1'); // "Check again": reads "unlocked"
      await waitUntil(() => forcedReads(from) === 1, 1000);
      mock.adapter.lockRoutes(); // the user locks the file in Finder a moment later
      let t0 = Date.now();
      const w = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      const took = Date.now() - t0;
      assert.equal(w.status, 423);
      assert.equal(w.json.error.code, 'ROUTES_LOCKED');
      assert.ok(took < 2300, `refused write took ${took} ms`);
      assert.equal(forcedReads(from), 2, 'the refused write started its own forced read');
      let s = mock.app.live.snapshot();
      assert.equal(s.routesAccess.locked, true, 'the banner shows right after the 423, not after the next scan');
      assert.equal(s.banners.find((b) => b.id.startsWith('routes-'))?.id, 'routes-locked');
      await checkAgain;
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true, "the older read's late answer doesn't win");

      // the cap still holds when the fresh read is slow
      lagMs = 5000;
      from = mock.adapter.calls.length;
      const slowCheck = c.get('/api/state?refresh=1');
      await waitUntil(() => forcedReads(from) === 1, 1000);
      t0 = Date.now();
      assert.equal((await c.post('/api/routes', { name: 'fresh', port: 3000 })).status, 423);
      assert.ok(Date.now() - t0 < 2300, `refused write with a slow read took ${Date.now() - t0} ms`);
      assert.equal(forcedReads(from), 2);
      await slowCheck;

      // the reverse: a "Check again" that read "locked" is in flight when the user unlocks and a write works
      await new Promise((r) => setTimeout(r, 5200)); // let the slow reads finish
      lagMs = 800;
      from = mock.adapter.calls.length;
      const staleLocked = c.get('/api/state?refresh=1');
      await waitUntil(() => forcedReads(from) === 1, 1000);
      mock.adapter.unlockRoutes();
      assert.equal((await c.post('/api/routes', { name: 'fresh', port: 3000 })).status, 201);
      await waitUntil(() => forcedReads(from) === 2, 1000); // its own re-read, not the stale one
      await staleLocked;
      await waitUntil(() => mock.app.live.snapshot().routesAccess.locked === false, 2000);
      await new Promise((r) => setTimeout(r, 100));
      s = mock.app.live.snapshot();
      assert.equal(s.routesAccess.locked, false);
      assert.ok(!s.banners.some((b) => b.id.startsWith('routes-')));

      // concurrent refused writes: never more forced reads than writes (at most 2 in flight; the
      // rest share a follow-up read started after they were refused), all bounded by the same cap
      lagMs = 300;
      mock.adapter.lockRoutes();
      from = mock.adapter.calls.length;
      t0 = Date.now();
      const many = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/routes', { name: 'fresh2', port: 3000 })));
      assert.ok(many.every((r) => r.status === 423));
      assert.ok(Date.now() - t0 < 2300, `10 refused writes took ${Date.now() - t0} ms`);
      assert.ok(forcedReads(from) <= 10, `${forcedReads(from)} forced reads for 10 refused writes`);
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
    } finally {
      await mock.close();
    }
  });

  /** Like the real `stat`: the answer is what the disk said when the read started, delivered `lag()` ms later. */
  function lagAccessReads(adapter, lag) {
    const orig = adapter.getRoutesAccess;
    adapter.getRoutesAccess = async (opts) => {
      const v = await orig(opts);
      const ms = lag();
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return v;
    };
  }
  /** D53: the same keys with the same values, in the same order (deepStrictEqual ignores order). */
  function assertSameInOrder(actual, expected, what) {
    assert.deepStrictEqual(actual, expected, what);
    assert.deepStrictEqual(Object.keys(actual), Object.keys(expected), `${what ?? 'details'}: key order`);
  }
  const forcedAccessReads = (adapter, from) => adapter.calls.slice(from).filter((x) => x.method === 'getRoutesAccess' && x.args[0].refresh === true).length;

  it('a refused write never joins a "Check again" that started during its precondition read (validation 7 F1, R2)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      lagAccessReads(mock.adapter, () => 600);
      // hold every listRoutes (the write's precondition read) until released
      const origList = mock.adapter.listRoutes;
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      let held = 0;
      mock.adapter.listRoutes = async (...a) => {
        held += 1;
        await gate;
        return origList(...a);
      };
      const from = mock.adapter.calls.length;
      const t0 = Date.now();
      const write = c.post('/api/routes', { name: 'fresh', port: 3000 });
      await waitUntil(() => held >= 1, 1000); // the write is in its precondition read
      const checkAgain = c.get('/api/state?refresh=1'); // "Check again" reads "unlocked"
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 1, 1000);
      mock.adapter.lockRoutes(); // the user locks the file a moment later
      release();
      const w = await write;
      const took = Date.now() - t0;
      assert.equal(w.status, 423);
      assert.equal(w.json.error.code, 'ROUTES_LOCKED');
      assert.ok(took < 2300, `refused write took ${took} ms`);
      assert.equal(forcedAccessReads(mock.adapter, from), 2, 'the refused write started its own forced read after the refusal');
      let s = mock.app.live.snapshot();
      assert.equal(s.routesAccess.locked, true, 'the banner shows right after the 423');
      assert.equal(s.banners.find((b) => b.id.startsWith('routes-'))?.id, 'routes-locked');
      assertSameInOrder(s.banners.find((b) => b.id === 'routes-locked').details, w.json.error.details);
      await checkAgain;
      await new Promise((r) => setTimeout(r, 100));
      s = mock.app.live.snapshot();
      assert.equal(s.routesAccess.locked, true, "the older read's late answer doesn't win");
    } finally {
      await mock.close();
    }
  });

  it('"Check again" (?refresh=1) never joins a forced read that started before it arrived (validation 7 F1, R10)', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
      lagAccessReads(mock.adapter, () => 600);
      const from = mock.adapter.calls.length;
      const older = c.get('/api/state?refresh=1'); // reads "locked"
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 1, 1000);
      mock.adapter.unlockRoutes(); // the user unlocks, then clicks "Check again"
      const t0 = Date.now();
      const again = await c.get('/api/state?refresh=1');
      assert.ok(Date.now() - t0 < 3600, `?refresh=1 took ${Date.now() - t0} ms`);
      assert.equal(forcedAccessReads(mock.adapter, from), 2, '"Check again" started its own forced read');
      assert.equal(again.json.routesAccess.locked, false, '"Check again" answers what the disk says now');
      assert.ok(!again.json.banners.some((b) => b.id.startsWith('routes-')));
      await older;
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mock.app.live.snapshot().routesAccess.locked, false);
      // the 3 s cap still holds with a hung read and an older read in flight
      const from2 = mock.adapter.calls.length;
      const slow = c.get('/api/state?refresh=1');
      await waitUntil(() => forcedAccessReads(mock.adapter, from2) === 1, 1000);
      mock.adapter.hangNext('getRoutesAccess');
      const t1 = Date.now();
      const capped = await c.get('/api/state?refresh=1');
      assert.equal(capped.status, 200);
      assert.ok(Date.now() - t1 < 3600, `?refresh=1 with a hung read took ${Date.now() - t1} ms`);
      await slow;
    } finally {
      await mock.close();
    }
  });

  it('a newer routesAccess read that fails still outdates older reads in flight (validation 7 F3, R5)', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
      lagAccessReads(mock.adapter, () => 600);
      mock.adapter.unlockRoutes();
      const from = mock.adapter.calls.length;
      const older = c.get('/api/state?refresh=1'); // reads "unlocked"
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 1, 1000);
      mock.adapter.lockRoutes(); // locked again before the older read lands
      mock.adapter.failNext('getRoutesAccess', new Error('stat exploded'));
      const newer = await c.get('/api/state?refresh=1'); // fails at once
      assert.equal(forcedAccessReads(mock.adapter, from), 2);
      assert.equal(newer.json.routesAccess.locked, true, 'the last good value is kept');
      const o = await older;
      assert.equal(o.json.routesAccess.locked, true, "the older read's late answer is dropped");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
      // an unusable answer outdates older reads the same way; the next good read still applies
      mock.adapter.unlockRoutes();
      const from2 = mock.adapter.calls.length;
      const older2 = c.get('/api/state?refresh=1'); // reads "unlocked"
      await waitUntil(() => forcedAccessReads(mock.adapter, from2) === 1, 1000);
      mock.adapter.lockRoutes();
      const orig = mock.adapter.getRoutesAccess;
      mock.adapter.getRoutesAccess = async () => 'junk';
      await c.get('/api/state?refresh=1');
      mock.adapter.getRoutesAccess = orig;
      assert.equal((await older2).json.routesAccess.locked, true);
      mock.adapter.unlockRoutes();
      assert.equal((await c.get('/api/state?refresh=1')).json.routesAccess.locked, false);
    } finally {
      await mock.close();
    }
  });

  /**
   * Counts forced getRoutesAccess reads in flight (peak) and tags each answer's `path` with the
   * read's id (`…#<id>`), so a response shows which read it came from; `starts[id]` is when it began.
   */
  function instrumentForcedReads(adapter, lag) {
    const orig = adapter.getRoutesAccess;
    const t = { inFlight: 0, peak: 0, starts: [null] };
    adapter.getRoutesAccess = async (opts) => {
      if (!opts?.refresh) return orig(opts);
      const id = t.starts.length;
      t.starts.push(Date.now());
      t.inFlight += 1;
      t.peak = Math.max(t.peak, t.inFlight);
      try {
        const v = await orig(opts); // the answer is what the disk said when the read started
        const ms = lag();
        if (ms) await new Promise((r) => setTimeout(r, ms));
        return { ...v, path: `${v.path}#${id}` };
      } finally {
        t.inFlight -= 1;
      }
    };
    t.readOf = (access) => Number(String(access?.path).split('#')[1]);
    return t;
  }

  it('concurrent forced reads: at most 2 in flight, the rest share one follow-up read, and every answer is fresh (validation 8 F1)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      let lag = () => 500;
      const t = instrumentForcedReads(mock.adapter, () => lag());
      let from = mock.adapter.calls.length;
      // two older "Check again" reads in flight read "unlocked"; then the user locks the file
      const older = [c.get('/api/state?refresh=1'), c.get('/api/state?refresh=1')];
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 2, 1000);
      mock.adapter.lockRoutes();
      const sentAt = Date.now();
      const many = await Promise.all(Array.from({ length: 50 }, () => c.get('/api/state?refresh=1')));
      assert.equal(forcedAccessReads(mock.adapter, from), 3, '50 "Check again" requests shared one follow-up read');
      assert.ok(t.peak <= 2, `peak forced reads in flight: ${t.peak}`);
      for (const r of many) {
        assert.equal(r.status, 200);
        assert.equal(r.json.routesAccess.locked, true, 'answered from a read started after the request');
        assert.ok(t.starts[t.readOf(r.json.routesAccess)] >= sentAt, 'the read started after the request was sent');
        assert.equal(r.json.banners.find((b) => b.id.startsWith('routes-'))?.id, 'routes-locked');
      }
      await Promise.all(older);
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true, "the older reads' late answers don't win");

      // the same for refused writes mixed with "Check again", with uneven read times
      mock.adapter.unlockRoutes();
      await c.get('/api/state?refresh=1');
      t.peak = 0;
      lag = () => Math.floor(Math.random() * 200);
      from = mock.adapter.calls.length;
      lag = () => 300;
      const stale = c.get('/api/state?refresh=1'); // reads "unlocked"
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 1, 1000);
      lag = () => Math.floor(Math.random() * 200);
      mock.adapter.lockRoutes();
      const t0 = Date.now();
      const mixed = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? c.get('/api/state?refresh=1') : c.post('/api/routes', { name: `burst${i}`, port: 3000 }))));
      const reads = forcedAccessReads(mock.adapter, from);
      assert.ok(t.peak <= 2, `peak forced reads in flight: ${t.peak}`);
      assert.ok(reads <= 10, `${reads} forced reads for 60 requests`);
      assert.ok(Date.now() - t0 < 2300, `took ${Date.now() - t0} ms`);
      for (const [i, r] of mixed.entries()) {
        if (i % 2) assert.equal(r.json.routesAccess.locked, true, `"Check again" ${i} is fresh`);
        else assert.equal(r.status, 423, `write ${i}`);
      }
      await stale;
      assert.equal(mock.app.live.snapshot().routesAccess.locked, true);
    } finally {
      await mock.close();
    }
  });

  it('a hung older forced read holds up neither "Check again" nor a refused write; two hung ones only until their deadline', async () => {
    const mock = await startMockApi({ scenario: 'manual-https' });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      let from = mock.adapter.calls.length;
      mock.adapter.hangNext('getRoutesAccess');
      const hung = c.get('/api/state?refresh=1'); // answers at the 3 s cap
      await waitUntil(() => forcedAccessReads(mock.adapter, from) === 1, 1000);
      mock.adapter.lockRoutes();
      let t0 = Date.now();
      const again = await c.get('/api/state?refresh=1');
      assert.ok(Date.now() - t0 < 1000, `"Check again" took ${Date.now() - t0} ms`);
      assert.equal(again.json.routesAccess.locked, true, 'its own read, in the second slot');
      mock.adapter.unlockRoutes();
      mock.adapter.lockRoutes({ flag: 'schg' });
      t0 = Date.now();
      const w = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.equal(w.status, 423);
      assert.ok(Date.now() - t0 < 1000, `refused write took ${Date.now() - t0} ms`);
      assert.equal(mock.app.live.snapshot().routesAccess.flag, 'schg', 'the banner follows right after the 423');
      await hung;
    } finally {
      await mock.close();
    }

    // both slots hung: the follow-up starts when the first one's deadline passes
    const m2 = await startMockApi({ scenario: 'manual-https', app: { deadlines: { routesAccess: 400 } } });
    const c2 = api(m2);
    try {
      await m2.app.live.warm();
      const from = m2.adapter.calls.length;
      m2.adapter.hangNext('getRoutesAccess').hangNext('getRoutesAccess');
      const hung = [c2.get('/api/state?refresh=1'), c2.get('/api/state?refresh=1')];
      await waitUntil(() => forcedAccessReads(m2.adapter, from) === 2, 1000);
      m2.adapter.lockRoutes();
      const t0 = Date.now();
      const r = await c2.get('/api/state?refresh=1');
      const took = Date.now() - t0;
      assert.ok(took >= 300 && took < 1500, `follow-up answered in ${took} ms`);
      assert.equal(r.json.routesAccess.locked, true);
      assert.equal(forcedAccessReads(m2.adapter, from), 3);
      await Promise.all(hung);
    } finally {
      await m2.close();
    }
  });

  it('STATE_UNREADABLE stays 503 for writes and list reads while the list is marked locked or not writable (N1 iteration 11)', async () => {
    for (const blocked of ['locked', 'not-writable']) {
      const adapter = createFakeAdapter({ routes: [{ hostname: 'plex.local', port: 32400, pid: 0 }], ...(blocked === 'locked' ? { routesLock: { flag: 'uchg', target: 'file' } } : { routesWritable: false, routesOwner: 'root' }) });
      // routes.json can't be read (EACCES on read): never a good list read yet
      for (let i = 0; i < 40; i += 1) adapter.failNext('listRoutes', new PortlessError('STATE_UNREADABLE'));
      const mock = await startMockApi({ adapter });
      const c = api(mock);
      try {
        const st = (await c.get('/api/state')).json;
        assert.equal(st.routesUnavailable, true, blocked);
        assert.ok(st.banners.some((b) => b.id === (blocked === 'locked' ? 'routes-locked' : 'routes-not-writable')), blocked);
        const list = await c.get('/api/routes');
        assert.equal(list.status, 503, blocked);
        assert.equal(list.json.error.code, 'STATE_UNREADABLE');
        for (const [method, p, body] of [
          ['POST', '/api/routes', { name: 'fresh', port: 3000 }],
          ['PATCH', '/api/routes/plex', { port: 32401 }],
          ['DELETE', '/api/routes/plex', {}],
        ]) {
          const before = mock.adapter.calls.length;
          const r = await request(mock.port, method, p, { token: mock.token, body });
          assert.equal(r.status, 503, `${blocked} ${method} ${p}: ${r.text}`);
          assert.equal(r.json.error.code, 'STATE_UNREADABLE');
          assert.ok(!mock.adapter.calls.slice(before).some((x) => x.method === 'getRoutesAccess' && x.args[0].refresh === true), 'not a refused write: no forced re-read');
        }
      } finally {
        await mock.close();
      }
    }
    // the write itself can't read the list (the adapter reports it from addAlias) → 503 too
    const mock = await startMockApi({ scenario: 'manual-https' });
    try {
      await mock.app.live.warm();
      mock.adapter.failNext('addAlias', new PortlessError('STATE_UNREADABLE', undefined, { raw: "EACCES: permission denied, open '/x/routes.json'" }));
      const r = await api(mock).post('/api/routes', { name: 'fresh', port: 3000 });
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, 'STATE_UNREADABLE');
      assert.equal((await api(mock).get('/api/routes')).status, 200, 'the last good list still answers');
    } finally {
      await mock.close();
    }
  });

  it('SSE: a routesAccess change sends one full state event (no partial banners event for it)', async () => {
    const mock = await startMockApi({ scenario: 'manual-https', app: { intervals: FAST } });
    const c = api(mock);
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      await new Promise((r) => setTimeout(r, 400)); // let the first loop round settle
      let from = s.events.length;
      mock.adapter.lockRoutes();
      const ev = await s.waitFor((e) => e.event === 'state' && e.data.routesAccess?.locked === true, 3000, from); // picked up by a scan
      assert.equal(ev.data.banners.find((b) => b.id.startsWith('routes-')).id, 'routes-locked');
      assert.deepEqual(Object.keys(ev.data).sort(), Object.keys((await c.get('/api/state')).json).sort());
      await new Promise((r) => setTimeout(r, 400));
      const after = s.events.slice(from);
      assert.ok(!after.some((e) => e.event === 'banners' && e.data.some((b) => b.id === 'routes-locked')), 'the change came only as a state event');
      assert.equal(after.filter((e) => e.event === 'state').length, 1, 'one state event for one change');
      // "Check again" after unlocking → another state event
      from = s.events.length;
      mock.adapter.unlockRoutes();
      await c.get('/api/state?refresh=1');
      const back = await s.waitFor((e) => e.event === 'state' && e.data.routesAccess?.locked === false, 3000, from);
      assert.ok(!back.data.banners.some((b) => b.id.startsWith('routes-')));
      const ids = s.events.map((e) => e.id);
      for (let i = 1; i < ids.length; i += 1) assert.equal(ids[i], ids[i - 1] + 1, `ids contiguous: ${ids.join(',')}`);
    } finally {
      s.close();
      await mock.close();
    }
  });

  it('PATCH /api/ui refuses to dismiss routes-locked and routes-not-writable', async () => {
    const mock = await startMockApi({ scenario: 'routes-locked' });
    const c = api(mock);
    try {
      for (const id of ['routes-locked', 'routes-not-writable']) {
        const r = await c.patch('/api/ui', { dismiss: id });
        assert.equal(r.status, 400, id);
        assert.equal(r.json.error.code, 'BAD_REQUEST');
      }
      assert.deepEqual(readState(mock.home).dismissed, []);
      assert.ok((await c.get('/api/state')).json.banners.some((b) => b.id === 'routes-locked'));
    } finally {
      await mock.close();
    }
  });

  it('deadlines: a slow or hung getRoutesAccess never holds up /api/state, a scan, a refused write or startup', async () => {
    // startup: a hung first read is bounded by deadlines.routesAccess
    const hung = createFakeAdapter({ routes: [] });
    hung.hangNext('getRoutesAccess');
    let t0 = Date.now();
    const m1 = await startMockApi({ adapter: hung, app: { deadlines: { routesAccess: 300 } } });
    try {
      assert.ok(Date.now() - t0 < 2000, `startup took ${Date.now() - t0} ms`);
      await waitUntil(() => m1.app.live.snapshot().routesAccess !== null, 2000); // the warm-up scan reads it
    } finally {
      await m1.close();
    }

    const mock = await startMockApi({ scenario: 'manual-https', app: { deadlines: { scan: 800 } } });
    const c = api(mock);
    try {
      await mock.app.live.warm();
      mock.adapter.routesAccessDelayMs = 1500; // a `stat` that hangs for its full 2 s timeout, roughly
      mock.adapter.lockRoutes();
      // a plain /api/state never waits for it
      t0 = Date.now();
      assert.equal((await c.get('/api/state')).status, 200);
      assert.ok(Date.now() - t0 < 700, `/api/state took ${Date.now() - t0} ms`);
      // a forced scan answers within its 800 ms budget; the late access read reports by itself
      await new Promise((r) => setTimeout(r, 2100)); // forced scans reuse one < 2 s old
      t0 = Date.now();
      const sv = await c.get('/api/services?refresh=1');
      const took = Date.now() - t0;
      assert.equal(sv.status, 200);
      assert.ok(took < 1300, `forced scan took ${took} ms`);
      assert.equal(mock.app.live.snapshot().routesAccess.locked, false, 'not yet');
      await waitUntil(() => mock.app.live.snapshot().routesAccess.locked === true, 3000);
      // a refused write answers within accessAfterRefused (1.5 s) even when the re-read is slower
      mock.adapter.routesAccessDelayMs = 5000;
      t0 = Date.now();
      const w = await c.post('/api/routes', { name: 'fresh', port: 3000 });
      assert.equal(w.status, 423);
      assert.ok(Date.now() - t0 < 2300, `refused write took ${Date.now() - t0} ms`);
      // ?refresh=1 with a hung read answers within the 3 s cap and keeps the last good value
      mock.adapter.routesAccessDelayMs = 0;
      mock.adapter.hangNext('getRoutesAccess');
      t0 = Date.now();
      const st = await c.get('/api/state?refresh=1');
      assert.equal(st.status, 200);
      assert.ok(Date.now() - t0 < 3600, `?refresh=1 took ${Date.now() - t0} ms`);
      assert.equal(st.json.routesAccess.locked, true);
      // an adapter error keeps the last good value too
      mock.adapter.unlockRoutes();
      mock.adapter.failNext('getRoutesAccess', new Error('stat exploded'));
      await new Promise((r) => setTimeout(r, 3100)); // let the hung read's 3 s deadline pass
      assert.equal((await c.get('/api/state?refresh=1')).json.routesAccess.locked, true);
      assert.equal((await c.get('/api/state?refresh=1')).json.routesAccess.locked, false);
    } finally {
      await mock.close();
    }
  });

  it('an adapter without getRoutesAccess: routesAccess is null and no banner shows', async () => {
    const adapter = createFakeAdapter({ routes: [] });
    delete adapter.getRoutesAccess;
    const mock = await startMockApi({ adapter });
    try {
      const s = (await api(mock).get('/api/state?refresh=1')).json;
      assert.equal(s.routesAccess, null);
      assert.ok(!s.banners.some((b) => b.id.startsWith('routes-')));
    } finally {
      await mock.close();
    }
  });
});

describe('quit', () => {
  it('POST /api/quit → 202, closes SSE clients, then onQuit', async () => {
    let quit = 0;
    const mock = await startMockApi({ onQuit: () => { quit += 1; } });
    const s = await sse(mock.port, { 'x-nidum-token': mock.token });
    try {
      await s.waitFor((e) => e.event === 'state');
      const r = await api(mock).post('/api/quit');
      assert.equal(r.status, 202);
      await waitUntil(() => quit === 1 && s.ended);
      assert.ok(!fs.existsSync(path.join(mock.home, 'session.json')));
    } finally {
      s.close();
      await mock.close();
    }
  });
});

describe('fakes', () => {
  it('fake discovery and network behave like N2', async () => {
    const d = createFakeDiscovery();
    const res = await d.scan({ proxyPort: 80 });
    assert.ok(Array.isArray(res.services) && Array.isArray(res.errors));
    const n = createFakeNetwork(FIXTURE_NETWORKS.ethernet);
    assert.equal((await n.getNetwork({ proxyLanIp: '10.1.1.1' })).ip, '10.1.1.1');
    const a = createFakeAdapter({ routes: [] });
    await a.addAlias('x', 1);
    await assert.rejects(a.addAlias('x', 2), (e) => e.code === 'NAME_TAKEN');
  });
});
