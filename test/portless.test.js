// Tests for src/portless.js and src/elevate.js (node N1).
// Live tests use portlessTestEnv() + safeMode only; nothing here touches
// ~/.portless, /etc/hosts, the launchd service or the keychain. Destructive
// wrappers run only against a fake binary and a fake elevate().

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import http from 'node:http';
import osModule, { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ERROR_CODES, FileRouteStore, PortlessError, RESERVED_NAMES, createPortless, deriveServiceConfig, findPortless,
  formatUrl, parseDoctor, parseRoutes, parseServiceDefinition, parseServiceStatus, pidStatus, readStateFiles,
  safeArgsProblem, stripAnsi, toRoute, validateName, validatePort, ELEVATION_PROMPTS,
  SERVICE_CONTROL_ENV, isServiceLoaded, isTrustedServiceLabel, serviceControlArgv, serviceLabel,
  FILE_FLAGS_TIMEOUT_MS, ROUTES_ACCESS_TTL_MS, SF_IMMUTABLE, UF_IMMUTABLE, parseLsattr, parseStatFlags, readFileFlags,
} from '../src/portless.js';
import * as portlessModule from '../src/portless.js';
import { buildElevationCommand, elevate, parseOsascriptError, shellQuote } from '../src/elevate.js';
import { portlessTestEnv } from './helpers/portless-env.js';
import { freePort, startThrowawayHttp, withTempDir } from './helpers/net.js';
import { createFakePortless } from './helpers/fake-portless.js';
import { chflagsTemp, flagged as e13Flagged, unlockAll } from './helpers/temp-flags.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portless');
const fixture = (f) => readFileSync(join(FIX, f), 'utf8');
const REAL = findPortless();
const DEAD_PID = 999999;

function tempDir(prefix = 'nidum-n1-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function rejectsCode(promiseOrFn, code, messageRe) {
  await assert.rejects(promiseOrFn, (err) => {
    assert.ok(err instanceof PortlessError, `expected PortlessError, got ${err && err.stack}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (messageRe) assert.match(err.message, messageRe);
    return true;
  });
}

function throwsCode(fn, code, reason) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof PortlessError);
    assert.equal(err.code, code);
    if (reason) assert.equal(err.details.reason, reason);
    return true;
  });
}

/** GET through the proxy with a Host header; resolves { status, body }. */
function viaProxy(proxyPort, host, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/', headers: { Host: host }, agent: false, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, portless: res.headers['x-portless'] }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

/** Retry until predicate(response) holds (the proxy reloads routes on a 100 ms debounce). */
async function eventually(proxyPort, host, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await viaProxy(proxyPort, host);
      if (predicate(last)) return last;
    } catch (err) {
      last = { error: err.message };
    }
    if (Date.now() > deadline) assert.fail(`proxy never satisfied predicate for ${host}: ${JSON.stringify(last).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10000, ...opts }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
describe('validateName (Contracts §1)', () => {
  test('accepts valid names and strips a typed .local', () => {
    assert.equal(validateName('recipes'), 'recipes');
    assert.equal(validateName('my-app'), 'my-app');
    assert.equal(validateName('a'), 'a');
    assert.equal(validateName('api.v2'), 'api.v2');
    assert.equal(validateName('0x1'), '0x1');
    assert.equal(validateName('recipes.local'), 'recipes');
    assert.equal(validateName('proxy.app'), 'proxy.app', 'reserved words are reserved only as the whole name');
    assert.equal(validateName('a'.repeat(63)), 'a'.repeat(63));
  });

  test('rejects empty, uppercase, underscores and bad characters', () => {
    throwsCode(() => validateName(''), 'INVALID_NAME', 'empty');
    throwsCode(() => validateName('.local'), 'INVALID_NAME', 'empty');
    throwsCode(() => validateName(undefined), 'INVALID_NAME', 'empty');
    throwsCode(() => validateName(42), 'INVALID_NAME', 'empty');
    throwsCode(() => validateName('Recipes'), 'INVALID_NAME', 'uppercase');
    throwsCode(() => validateName('RECIPES.local'), 'INVALID_NAME', 'uppercase');
    throwsCode(() => validateName('my_app'), 'INVALID_NAME', 'underscore');
    for (const bad of ['-a', 'a-', 'a..b', 'a.', '.a', ' a', 'a b', 'a/b', 'é', 'a:80', 'http://a']) {
      throwsCode(() => validateName(bad), 'INVALID_NAME', 'characters');
    }
  });

  test('label ≤ 63 and name + .local ≤ 253', () => {
    throwsCode(() => validateName('a'.repeat(64)), 'INVALID_NAME', 'label-too-long');
    throwsCode(() => validateName(`ok.${'b'.repeat(64)}`), 'INVALID_NAME', 'label-too-long');
    const l = 'c'.repeat(63);
    const at247 = `${l}.${l}.${l}.${'d'.repeat(55)}`; // 247 + '.local' = 253
    assert.equal(at247.length, 247);
    assert.equal(validateName(at247), at247);
    const at248 = `${l}.${l}.${l}.${'d'.repeat(56)}`; // 254
    throwsCode(() => validateName(at248), 'INVALID_NAME', 'too-long');
  });

  test("reserved: Portless's 11 + setup", () => {
    assert.deepEqual([...RESERVED_NAMES].sort(), ['alias', 'clean', 'doctor', 'get', 'hosts', 'list', 'proxy', 'prune', 'run', 'service', 'setup', 'trust']);
    for (const r of RESERVED_NAMES) {
      throwsCode(() => validateName(r), 'INVALID_NAME', 'reserved');
      throwsCode(() => validateName(`${r}.local`), 'INVALID_NAME', 'reserved');
    }
  });
});

describe('PortlessError and helpers', () => {
  test('codes match Contracts §2 exactly', () => {
    assert.deepEqual([...ERROR_CODES], [
      'CLI_MISSING', 'NAME_TAKEN', 'NAME_TAKEN_BY_APP', 'INVALID_NAME', 'INVALID_PORT', 'NOT_FOUND', 'PORT_IN_USE',
      'PERMISSION', 'TIMEOUT', 'PROXY_DOWN', 'SERVICE_MANAGED', 'STATE_UNREADABLE', 'ROUTES_LOCKED', 'ROUTES_NOT_WRITABLE',
      'UNSUPPORTED', 'UNKNOWN',
    ]);
    assert.equal(new PortlessError('ROUTES_LOCKED').message, "Your address list is locked, so Nidum Local can't change it.");
    assert.equal(new PortlessError('ROUTES_NOT_WRITABLE').message, "Nidum Local isn't allowed to change your address list.");
    assert.equal(new PortlessError('INVALID_PORT').message, 'Ports are whole numbers from 1 to 65535.');
    const e = new PortlessError('NAME_TAKEN', 'x already points to port 1.', { raw: 'raw', details: { a: 1 } });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'PortlessError');
    assert.deepEqual(e.toJSON(), { code: 'NAME_TAKEN', message: 'x already points to port 1.', details: { a: 1 }, raw: 'raw' });
    assert.equal(new PortlessError('NOPE').code, 'UNKNOWN');
    assert.equal(new PortlessError('PERMISSION').message, 'Portless needs administrator rights for this.');
  });

  test('formatUrl matches Portless (no port for 80/http and 443/https)', () => {
    assert.equal(formatUrl('a.local', 80, false), 'http://a.local');
    assert.equal(formatUrl('a.local', 443, true), 'https://a.local');
    assert.equal(formatUrl('a.local', 443, false), 'http://a.local:443');
    assert.equal(formatUrl('a.local', 23456, false), 'http://a.local:23456');
    assert.equal(formatUrl('a.local', 8443, true), 'https://a.local:8443');
  });

  test('stripAnsi removes CSI and OSC sequences', () => {
    assert.equal(stripAnsi('\x1b[32mok\x1b[39m  \x1b[1;31mfail\x1b[0m'), 'ok  fail');
    assert.equal(stripAnsi('\x1b]8;;http://x\x07link\x1b]8;;\x07'), 'link');
  });

  test('pidStatus distinguishes alive, EPERM and dead', () => {
    assert.equal(pidStatus(process.pid), 'alive');
    assert.equal(pidStatus(1), 'eperm', 'launchd/init is root-owned');
    assert.equal(pidStatus(DEAD_PID), 'dead');
    assert.equal(pidStatus(0), 'dead');
  });

  test('module-level API exposes every Contracts §2 function', () => {
    for (const fn of ['findPortless', 'run', 'listRoutes', 'getProxyState', 'getServiceConfig', 'addAlias', 'removeAlias', 'changePort',
      'renameAlias', 'startProxy', 'stopProxy', 'doctor', 'trust', 'hostsSync', 'prune', 'clean', 'serviceInstall', 'serviceUninstall',
      'serviceStatus', 'validateName', 'stateDir', 'createPortless', 'getRoutesAccess']) {
      assert.equal(typeof portlessModule[fn], 'function', fn);
    }
    assert.equal(typeof portlessModule.PortlessError, 'function');
  });
});

describe('findPortless', { skip: !REAL && 'Portless is not installed' }, () => {
  test('resolves the real install: binPath, launcherPath, packageRoot, version, nodePath', () => {
    assert.deepEqual(Object.keys(REAL), ['binPath', 'launcherPath', 'packageRoot', 'version', 'nodePath']);
    assert.ok(existsSync(REAL.launcherPath));
    assert.equal(realpathSync(REAL.launcherPath), REAL.binPath, 'launcherPath is the unresolved entry, binPath its target');
    assert.ok(!REAL.launcherPath.includes('/Cellar/'), `launcher survives brew upgrade: ${REAL.launcherPath}`);
    assert.ok(existsSync(join(REAL.packageRoot, 'dist', 'index.js')));
    assert.ok(REAL.binPath.endsWith(join('dist', 'cli.js')), REAL.binPath);
    assert.equal(statSync(REAL.binPath).isFile(), true, 'symlinks resolved');
    assert.match(REAL.version, /^\d+\.\d+\.\d+/);
    assert.ok(REAL.nodePath && existsSync(REAL.nodePath), `node from shebang: ${REAL.nodePath}`);
    assert.equal(readFileSync(REAL.binPath, 'utf8').split('\n')[0], `#!${REAL.nodePath}`);
  });

  test('returns null when nothing is on PATH or in the usual places', () => {
    const empty = tempDir();
    try {
      // On macOS the Homebrew/usr-local fallbacks would find the real copy, so use the
      // Windows search (PATH + %APPDATA%\npm only) over an empty PATH.
      assert.equal(findPortless({ env: { PATH: empty, HOME: empty }, platform: 'win32' }), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('parsers against captured fixtures', () => {
  test('routes.json from the service state (anonymised)', () => {
    const routes = parseRoutes(fixture('state-service/routes.json'));
    assert.deepEqual(routes.map((r) => [r.hostname, r.port, r.pid]), [
      ['alpha.local', 1234, 0], ['notes.local', 27123, 0], ['arcade.local', 8180, 0], ['media.local', 32400, 0],
    ]);
    const mapped = routes.map((r) => toRoute(r, { port: 80, tls: false }));
    assert.deepEqual(mapped[0], { name: 'alpha', hostname: 'alpha.local', url: 'http://alpha.local', port: 1234, kind: 'alias', pid: 0, foreignTld: false });
  });

  test('routes.json is alive-filtered and validated like RouteStore.loadRoutes', () => {
    const text = fixture('routes-mixed.json').replace('"__LIVE_PID__"', String(process.pid));
    const routes = parseRoutes(text);
    assert.deepEqual(routes.map((r) => r.hostname), ['zeta.local', 'shop.local', 'legacy.localhost', 'alpha.local']);
    assert.equal(routes[3].tailscaleUrl, 'https://alpha.example.ts.net', 'extra fields kept');
    assert.deepEqual(parseRoutes('{not json'), []);
    assert.deepEqual(parseRoutes('{"hostname":"a.local"}'), []);
    assert.deepEqual(parseRoutes(null), []);
  });

  test('listRoutes: contract shape, foreign TLD, sorted by hostname, URL from proxy.port', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'routes.json'), fixture('routes-mixed.json').replace('"__LIVE_PID__"', String(process.pid)));
      writeFileSync(join(dir, 'proxy.port'), '23456');
      const p = createPortless({ env: { PORTLESS_STATE_DIR: dir, PATH: process.env.PATH, HOME: process.env.HOME }, servicePath: null });
      const routes = await p.listRoutes();
      assert.deepEqual(routes, [
        { name: 'alpha', hostname: 'alpha.local', url: 'http://alpha.local:23456', port: 8080, kind: 'alias', pid: 0, foreignTld: false },
        { name: 'legacy.localhost', hostname: 'legacy.localhost', url: 'http://legacy.localhost:23456', port: 3000, kind: 'alias', pid: 0, foreignTld: true },
        { name: 'shop', hostname: 'shop.local', url: 'http://shop.local:23456', port: 4123, kind: 'app', pid: process.pid, foreignTld: false },
        { name: 'zeta', hostname: 'zeta.local', url: 'http://zeta.local:23456', port: 5173, kind: 'alias', pid: 0, foreignTld: false },
      ]);
      const viaState = await p.listRoutes({ proxy: { port: 443, tls: true } });
      assert.equal(viaState[0].url, 'https://alpha.local');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('state files of the service-managed proxy', () => {
    // proxy.pid is 999998 on purpose: above macOS's PID_MAX (99998), so it can
    // never be a live process — the captured value was the real proxy's live pid.
    assert.deepEqual(readStateFiles(join(FIX, 'state-service')), {
      port: 80, pid: 999998, tls: false, lanIp: '192.0.2.10', tlds: ['local'],
    });
    assert.equal(pidStatus(999998), 'dead');
    assert.deepEqual(readStateFiles(join(FIX, 'does-not-exist')), { port: null, pid: null, tls: false, lanIp: null, tlds: ['localhost'] });
  });

  test('launchd plist (real, anonymised) → argv, env and effective config', () => {
    const def = parseServiceDefinition(fixture('sh.portless.proxy.plist'), 'darwin');
    assert.deepEqual(def.argv, ['/opt/homebrew/Cellar/node/26.10.0_1/bin/node', '/opt/homebrew/bin/portless', 'proxy', 'start', '--foreground', '--port', '80', '--no-tls', '--lan', '--skip-trust']);
    assert.deepEqual(def.env, {
      PORTLESS_STATE_DIR: '/Users/example/.portless', PORTLESS_PORT: '80', PORTLESS_HTTPS: '0', PORTLESS_LAN: '1',
      PORTLESS_WILDCARD: '0', PORTLESS_TLD: 'local', HOME: '/Users/example', SUDO_UID: '501', SUDO_GID: '20',
    });
    assert.deepEqual(deriveServiceConfig(def), {
      stateDir: '/Users/example/.portless', port: 80, tls: false, lan: true, fixedIp: null, tlds: ['local'], wildcard: false,
    });
  });

  test('systemd unit and Windows task script (built in Portless’s format)', () => {
    const linux = parseServiceDefinition(fixture('portless.service'), 'linux');
    assert.equal(linux.argv[2], 'proxy');
    assert.deepEqual(deriveServiceConfig(linux), {
      stateDir: '/home/example/.portless', port: 8443, tls: true, lan: true, fixedIp: '192.0.2.20', tlds: ['local'], wildcard: true,
    });
    const win = parseServiceDefinition(fixture('portless-service.cmd'), 'win32');
    assert.equal(win.argv[0], 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(deriveServiceConfig(win), {
      stateDir: 'C:\\Users\\example\\.portless', port: 443, tls: true, lan: false, fixedIp: null, tlds: ['localhost'], wildcard: false,
    });
    assert.equal(parseServiceDefinition('<plist></plist>', 'darwin'), null);
    assert.equal(parseServiceDefinition('[Unit]\n', 'linux'), null);
  });

  test('doctor output: service proxy, stopped proxy, and a failure', () => {
    const svc = parseDoctor(fixture('doctor-service.txt'));
    assert.deepEqual(svc.header, { version: '0.15.6', node: '26.10.0', platform: 'darwin arm64', stateDir: '/Users/example/.portless', proxyTarget: 'http://127.0.0.1', mode: 'HTTP, .local, LAN' });
    assert.equal(svc.findings.length, 12);
    assert.deepEqual(svc.findings[2], { status: 'ok', message: 'Proxy is responding on port 80.' });
    assert.deepEqual(svc.findings[7], { status: 'warn', message: 'Route alpha.local points to port 1234, but nothing is listening there.', hint: 'Remove the alias or start that service.' });
    assert.deepEqual(svc.summary, { failures: 0, warnings: 3 });

    const stopped = parseDoctor(fixture('doctor-stopped.txt'));
    assert.deepEqual(stopped.findings.map((f) => f.status), ['ok', 'ok', 'warn', 'info', 'info', 'warn', 'warn', 'warn', 'warn', 'warn']);
    assert.equal(stopped.findings[2].hint, 'Run: portless proxy start --no-tls');
    assert.deepEqual(stopped.summary, { failures: 0, warnings: 6 });

    const failed = parseDoctor(fixture('doctor-fail.txt'));
    const fail = failed.findings.find((f) => f.status === 'fail');
    assert.match(fail.message, /is in use, but it is not a portless proxy/);
    assert.equal(fail.hint, 'Process on port: PID 4242');
    assert.deepEqual(failed.summary, { failures: 1, warnings: 0 });

    const colored = parseDoctor('\x1b[32mok   \x1b[39m Fine.\n\x1b[90m      a hint\x1b[39m\n');
    assert.deepEqual(colored.findings, [{ status: 'ok', message: 'Fine.', hint: 'a hint' }]);
  });

  test('service status output', () => {
    assert.deepEqual(parseServiceStatus(fixture('service-status.txt')), {
      managerState: 'running', installed: true, proxyPort: 80, proxyResponding: true, tls: false, tlds: ['local'],
      lan: true, lanIp: null, wildcard: false, stateDir: '/Users/example/.portless',
      serviceEntry: '/Library/LaunchDaemons/sh.portless.proxy.plist',
    });
  });
});

// ---------------------------------------------------------------------------
describe('getProxyState (F1, F12) from fixtures', () => {
  let dir;
  let plist;
  const fakeUser = { username: 'example', uid: 501, gid: 20, homedir: '/Users/example' };
  before(() => {
    dir = tempDir();
    const sd = join(dir, 'state');
    mkdirSync(sd);
    for (const f of readdirSync(join(FIX, 'state-service'))) copyFileSync(join(FIX, 'state-service', f), join(sd, f));
    writeFileSync(join(sd, 'proxy.pid'), '1\n'); // a root-owned live pid → EPERM → elevated
    plist = join(dir, 'sh.portless.proxy.plist');
    writeFileSync(plist, fixture('sh.portless.proxy.plist').replace('/Users/example/.portless</string>', `${sd}</string>`));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const make = (extra = {}) => createPortless({
    env: { PORTLESS_STATE_DIR: join(dir, 'state'), PATH: '/usr/bin:/bin', HOME: '/Users/example' },
    servicePath: plist, user: fakeUser, portless: null,
    probe: { isProxyResponding: async () => true, isPortListening: async () => true, isServiceLoaded: async () => true }, ...extra,
  });

  test('service-managed, running, root proxy: exact contract shape', async () => {
    const state = await make().getProxyState();
    assert.deepEqual(state, {
      running: true, pid: 1, port: 80, tls: false, lan: true, lanIp: '192.0.2.10', tlds: ['local'], wildcard: false,
      elevated: true, managedBy: 'service', baseUrl: 'http://127.0.0.1:80', serviceLoaded: true,
    });
  });

  test('the service counts only when it owns this state dir', async () => {
    const other = join(dir, 'other.plist');
    writeFileSync(other, fixture('sh.portless.proxy.plist'));
    const p = make({ servicePath: other });
    const state = await p.getProxyState();
    assert.equal(state.managedBy, 'manual');
    assert.equal(state.wildcard, null, 'no service, no saved settings → null');
    assert.equal((await p.getProxyState({ settings: { wildcard: true } })).wildcard, true);
    assert.equal(p.getServiceConfig().stateDir, '/Users/example/.portless');
  });

  test('stopped proxy without a service', async () => {
    const empty = tempDir();
    try {
      const p = createPortless({ env: { PORTLESS_STATE_DIR: empty, HOME: '/Users/example' }, servicePath: null, portless: null, probe: { isProxyResponding: async () => false } });
      assert.deepEqual(await p.getProxyState(), {
        running: false, pid: null, port: 443, tls: true, lan: false, lanIp: null, tlds: ['localhost'], wildcard: null,
        elevated: false, managedBy: null, baseUrl: 'https://127.0.0.1:443', serviceLoaded: false,
      }, 'nothing known → Portless’s default (HTTPS on 443)');
      const withSettings = await p.getProxyState({ settings: { port: 8443, tls: true, wildcard: false } });
      assert.equal(withSettings.baseUrl, 'https://127.0.0.1:8443');
      assert.equal(withSettings.wildcard, false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('stopped service proxy reports the service config', async () => {
    const sd = tempDir();
    try {
      const pl = join(sd, 'svc.plist');
      writeFileSync(pl, fixture('sh.portless.proxy.plist').replace('/Users/example/.portless</string>', `${sd}</string>`));
      const p = createPortless({ env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example' }, servicePath: pl, portless: null, probe: { isProxyResponding: async () => false, isServiceLoaded: async () => false } });
      const s = await p.getProxyState();
      assert.equal(s.running, false);
      assert.equal(s.managedBy, 'service', 'still service-managed while booted out (E12)');
      assert.equal(s.serviceLoaded, false);
      assert.equal(s.lan, true);
      assert.deepEqual(s.tlds, ['local']);
      assert.equal(s.port, 80);
    } finally {
      rmSync(sd, { recursive: true, force: true });
    }
  });

  test('stopProxy on a service-managed proxy → SERVICE_MANAGED; allowService elevates the stop', async () => {
    const calls = [];
    let up = true;
    const fake = createFakePortless();
    try {
      const p = make({
        portless: fake.install,
        elevate: async (argv, env) => { calls.push({ argv, env }); up = false; return { stdout: 'Proxy stopped.\n', stderr: '' }; },
        probe: { isProxyResponding: async () => up, isPortListening: async () => up },
      });
      await rejectsCode(p.stopProxy(), 'SERVICE_MANAGED', /startup service/);
      assert.equal(calls.length, 0);
      await rejectsCode(p.startProxy({ tls: false, port: 80, lan: true }), 'SERVICE_MANAGED');
      await p.stopProxy({ allowService: true });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, [fake.install.launcherPath, 'proxy', 'stop', '-p', '80']);
      assert.equal(fake.calls().length, 0, 'the CLI itself was never executed un-elevated');
    } finally {
      fake.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
describe('elevation (F6) with a fake elevate()', () => {
  let fake;
  let sd;
  const user = { username: 'example', uid: 501, gid: 20, homedir: '/Users/example' };
  before(() => {
    fake = createFakePortless();
    sd = tempDir();
  });
  after(() => {
    fake.cleanup();
    rmSync(sd, { recursive: true, force: true });
  });

  function setup({ running = false, pidFile } = {}) {
    const calls = [];
    let up = running;
    if (pidFile !== undefined) {
      writeFileSync(join(sd, 'proxy.pid'), `${pidFile}\n`);
      writeFileSync(join(sd, 'proxy.port'), '80');
    } else {
      rmSync(join(sd, 'proxy.pid'), { force: true });
      rmSync(join(sd, 'proxy.port'), { force: true });
    }
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, PORTLESS_SYNC_HOSTS: '0', PORTLESS_EMPTY: '', OTHER_SECRET: 'x', PATH: '/usr/bin:/bin', HOME: '/Users/example', FORCE_COLOR: '1' },
      portless: fake.install, servicePath: null, user, platform: 'darwin',
      elevate: async (argv, env, opts) => { calls.push({ argv, env, opts }); up = !up; return { stdout: '\x1b[32mdone\x1b[39m\n', stderr: '' }; },
      probe: { isProxyResponding: async () => up, isPortListening: async () => up },
    });
    return { p, calls };
  }

  const expectedEnv = () => ({
    PORTLESS_STATE_DIR: sd, PORTLESS_SYNC_HOSTS: '0', NO_COLOR: '1', HOME: '/Users/example', SUDO_USER: 'example',
    SUDO_UID: '501', SUDO_GID: '20', PATH: `${dirname(fake.install.nodePath)}:/usr/bin:/bin`,
  });

  test('startProxy on port 80: full explicit argv and exact env', async () => {
    const { p, calls } = setup();
    const state = await p.startProxy({ tls: false, port: 80, lan: true, fixedIp: null, wildcard: false });
    assert.equal(state.running, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, [fake.install.launcherPath, 'proxy', 'start', '--lan', '--no-tls', '-p', '80']);
    assert.deepEqual(calls[0].env, expectedEnv());
    assert.ok(calls[0].opts.timeout >= 60000, 'password dialogs get a long timeout');
    assert.equal(calls[0].opts.prompt, 'Nidum Local needs your password to start network sharing on port 80.');
    assert.equal(fake.calls().length, 0, 'nothing ran un-elevated');
  });

  test('startProxy with HTTPS, fixed IP and wildcard', async () => {
    const { p, calls } = setup();
    await p.startProxy({ tls: true, port: 443, lan: true, fixedIp: '192.0.2.7', wildcard: true });
    assert.equal(calls[0].opts.prompt, 'Nidum Local needs your password to start network sharing on port 443.');
    assert.deepEqual(calls[0].argv, [fake.install.launcherPath, 'proxy', 'start', '--lan', '--https', '-p', '443', '--ip', '192.0.2.7', '--wildcard']);
  });

  test('startArgs: lan false is the isolated test form; bad fixed IPs are refused', async () => {
    const { p, calls } = setup();
    assert.deepEqual(p.startArgs({ tls: false, port: 23456, lan: false }), ['proxy', 'start', '--no-tls', '-p', '23456', '--tld', 'local']);
    assert.deepEqual(p.startArgs({ tls: true, port: 443 }), ['proxy', 'start', '--lan', '--https', '-p', '443']);
    await rejectsCode(p.startProxy({ tls: false, port: 80, lan: false, fixedIp: '192.0.2.7' }), 'UNSUPPORTED');
    await rejectsCode(p.startProxy({ tls: false, port: 80, lan: true, fixedIp: '192.0.2.7; rm -rf /' }), 'UNSUPPORTED');
    assert.throws(() => p.startArgs({ tls: false, port: 70000 }), (e) => e instanceof PortlessError && e.code === 'INVALID_PORT');
    await rejectsCode(p.startProxy({ tls: false, port: 1.5, lan: true }), 'INVALID_PORT');
    assert.equal(calls.length, 0);
  });

  test('startProxy on a high port runs the CLI directly, not elevated', async () => {
    const calls = [];
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, PATH: '/usr/bin:/bin', HOME: '/Users/example', FAKE_RECORD: fake.record },
      portless: fake.install, servicePath: null, user, platform: 'darwin',
      elevate: async (argv) => { calls.push(argv); return { stdout: '', stderr: '' }; },
      probe: { isProxyResponding: async () => fake.calls().some((c) => c.argv[1] === 'start'), isPortListening: async () => false },
    });
    await p.startProxy({ tls: false, port: 23457, lan: true });
    assert.equal(calls.length, 0);
    const started = fake.calls().find((c) => c.argv[1] === 'start');
    assert.deepEqual(started.argv, ['proxy', 'start', '--lan', '--no-tls', '-p', '23457']);
    assert.equal(started.env.NO_COLOR, '1');
  });

  test('another program on the port → PORT_IN_USE, nothing runs', async () => {
    const calls = [];
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example' }, portless: fake.install, servicePath: null, user, platform: 'darwin',
      elevate: async (argv) => { calls.push(argv); return { stdout: '', stderr: '' }; },
      probe: { isProxyResponding: async () => false, isPortListening: async () => true },
    });
    await rejectsCode(p.startProxy({ tls: false, port: 80, lan: true }), 'PORT_IN_USE');
    assert.equal(calls.length, 0);
  });

  test('stopProxy of a root proxy elevates `proxy stop -p <port>`', async () => {
    const { p, calls } = setup({ running: true, pidFile: 1 });
    const before = await p.getProxyState();
    assert.equal(before.elevated, true);
    assert.equal(before.managedBy, 'manual');
    const after = await p.stopProxy();
    assert.equal(after.running, false);
    assert.deepEqual(calls.map((c) => c.argv), [[fake.install.launcherPath, 'proxy', 'stop', '-p', '80']]);
    assert.deepEqual(calls[0].env, expectedEnv());
    assert.equal(calls[0].opts.prompt, 'Nidum Local needs your password to stop network sharing.');
  });

  test('elevated wrappers send the whole command through elevate()', async () => {
    const { p, calls } = setup();
    const ranBefore = fake.calls().length;
    await p.trust();
    await p.hostsSync();
    await p.clean();
    await p.serviceInstall({ tls: false, port: 80, lan: true, wildcard: false });
    await p.serviceUninstall();
    assert.deepEqual(calls.map((c) => c.argv.slice(1)), [
      ['trust'], ['hosts', 'sync'], ['clean'], ['service', 'install', '--lan', '--no-tls', '-p', '80'], ['service', 'uninstall'],
    ]);
    for (const c of calls) assert.deepEqual(c.env, expectedEnv());
    assert.deepEqual(calls.map((c) => c.opts.prompt), [
      'Nidum Local needs your password to trust its local certificate.',
      "Nidum Local needs your password to fix Safari's address list.",
      'Nidum Local needs your password to reset Portless.',
      'Nidum Local needs your password to set up sharing to start automatically.',
      'Nidum Local needs your password to turn off automatic sharing.',
    ]);
    await p.run(['proxy', 'stop', '-p', '80'], { elevate: true });
    assert.equal(calls.at(-1).opts.prompt, 'Nidum Local needs your password to change network sharing.', 'raw elevated run() gets a generic prompt');
    assert.equal(fake.calls().length, ranBefore, 'none of them ran un-elevated');
  });

  test('prune runs un-elevated (fake binary only)', async () => {
    const p = createPortless({ env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example', FAKE_RECORD: fake.record }, portless: fake.install, servicePath: null, user });
    const before = fake.calls().length;
    await p.prune();
    const after = fake.calls();
    assert.equal(after.length, before + 1);
    assert.deepEqual(after.at(-1).argv, ['prune']);
  });

  test('a cancelled dialog → PERMISSION "Password not entered. Nothing changed."', async () => {
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example' }, portless: fake.install, servicePath: null, user, platform: 'darwin',
      elevate: (argv, env, opts) => elevate(argv, env, {
        ...opts, platform: 'darwin',
        execFile: (file, args, o, cb) => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', '0:180: execution error: User canceled. (-128)\n'),
      }),
      probe: { isProxyResponding: async () => false, isPortListening: async () => false },
    });
    await rejectsCode(p.startProxy({ tls: false, port: 80, lan: true }), 'PERMISSION', /^Password not entered\. Nothing changed\.$/);
  });

  test('a failing elevated command is classified from its output', async () => {
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example' }, portless: fake.install, servicePath: null, user, platform: 'darwin',
      elevate: (argv, env, opts) => elevate(argv, env, {
        ...opts, platform: 'darwin',
        execFile: (file, args, o, cb) => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', '0:300: execution error: Error: listen EADDRINUSE: address already in use :::80 (1)\n'),
      }),
    });
    await assert.rejects(p.run(['proxy', 'start', '--lan', '--no-tls', '-p', '80'], { elevate: true }), (err) => {
      assert.equal(err.code, 'PORT_IN_USE');
      assert.match(err.raw, /EADDRINUSE/);
      assert.equal(err.details.exitCode, 1);
      return true;
    });
  });
});

describe('src/elevate.js builders', () => {
  const argv = ['/opt/x/portless', 'proxy', 'start', '--lan', '-p', '80'];
  const env = { PORTLESS_STATE_DIR: '/Users/a b/.portless', HOME: '/Users/a b', SUDO_USER: 'a', NO_COLOR: '1' };

  test('shellQuote round-trips through /bin/sh', async () => {
    const words = ['plain', 'a b', "it's", '"dq"', '$(touch /tmp/nidum-pwn)', '`id`', 'back\\slash', ';', '*', ''];
    const { error, stdout } = await execFileP('/bin/sh', ['-c', `printf '%s\\n' ${words.map(shellQuote).join(' ')}`]);
    assert.equal(error, null);
    assert.deepEqual(stdout.split('\n').slice(0, -1), words);
    assert.equal(existsSync('/tmp/nidum-pwn'), false);
  });

  test('macOS: osascript with administrator privileges, env via /usr/bin/env, compiles', async () => {
    const cmd = buildElevationCommand(argv, env, { platform: 'darwin' });
    assert.equal(cmd.file, '/usr/bin/osascript');
    assert.equal(cmd.args[0], '-e');
    assert.equal(cmd.args.length, 2);
    assert.equal(cmd.command, "'/usr/bin/env' 'PORTLESS_STATE_DIR=/Users/a b/.portless' 'HOME=/Users/a b' 'SUDO_USER=a' 'NO_COLOR=1' '/opt/x/portless' 'proxy' 'start' '--lan' '-p' '80' 2>&1");
    assert.match(cmd.script, /^do shell script ".*" with administrator privileges without altering line endings$/);
    if (process.platform === 'darwin') {
      // Compile only (never run) to prove the AppleScript is well-formed.
      const out = join(tempDir(), 'check.scpt');
      const { error, stderr } = await execFileP('/usr/bin/osacompile', ['-e', cmd.script, '-o', out]);
      assert.equal(error, null, stderr);
      // Every real prompt compiles (compile only, never run) and decompiles to the same text.
      const prompts = [ELEVATION_PROMPTS.start(443), ELEVATION_PROMPTS.stop, ELEVATION_PROMPTS.serviceInstall, ELEVATION_PROMPTS.serviceUninstall,
        ELEVATION_PROMPTS.trust, ELEVATION_PROMPTS.hostsSync, ELEVATION_PROMPTS.clean, ELEVATION_PROMPTS.other, 'Quote " and back\\slash'];
      for (const prompt of prompts) {
        const withPrompt = buildElevationCommand(argv, env, { platform: 'darwin', prompt });
        assert.ok(withPrompt.script.includes(` with prompt ${JSON.stringify(prompt)} with administrator privileges`), prompt);
        const r2 = await execFileP('/usr/bin/osacompile', ['-e', withPrompt.script, '-o', out]);
        assert.equal(r2.error, null, r2.stderr);
        const back = await execFileP('/usr/bin/osadecompile', [out]);
        assert.equal(back.stdout.trim(), withPrompt.script, 'decompiles to the identical source');
      }
      assert.throws(() => buildElevationCommand(argv, env, { platform: 'darwin', prompt: 'two\nlines' }), TypeError);
      rmSync(dirname(out), { recursive: true, force: true });
    }
  });

  test('Linux pkexec and Windows RunAs (experimental) argv', () => {
    assert.deepEqual(buildElevationCommand(argv, { A: '1', B: 'x y' }, { platform: 'linux' }), {
      file: 'pkexec', args: ['/usr/bin/env', 'A=1', 'B=x y', ...argv],
    });
    const win = buildElevationCommand(['C:\\node.exe', 'C:\\p\\cli.js', 'proxy', 'stop'], { A: '1' }, { platform: 'win32' });
    assert.equal(win.file, 'powershell.exe');
    assert.deepEqual(win.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.match(win.args[3], /Start-Process -FilePath 'cmd.exe'.*-Verb RunAs -Wait/);
    assert.equal(win.command, 'set "A=1" && "C:\\node.exe" "C:\\p\\cli.js" "proxy" "stop"');
    assert.throws(() => buildElevationCommand(argv, { 'BAD NAME': '1' }, { platform: 'darwin' }), TypeError);
    assert.throws(() => buildElevationCommand(argv, {}, { platform: 'aix' }), PortlessError);
  });

  test('osascript error parsing and Linux cancel codes', async () => {
    assert.deepEqual(parseOsascriptError('0:180: execution error: User canceled. (-128)'), { cancelled: true, status: -128, text: 'User canceled.' });
    assert.deepEqual(parseOsascriptError('0:9: execution error: boom\nline2 (3)\n'), { cancelled: false, status: 3, text: 'boom\nline2' });
    const pk = (code) => (file, args, o, cb) => cb(Object.assign(new Error('x'), { code }), '', 'Error executing command as another user: Request dismissed');
    await rejectsCode(elevate(argv, {}, { platform: 'linux', execFile: pk(126) }), 'PERMISSION', /Password not entered/);
    await rejectsCode(elevate(argv, {}, { platform: 'linux', execFile: pk(127) }), 'PERMISSION');
    await rejectsCode(elevate(argv, {}, { platform: 'darwin', execFile: (f, a, o, cb) => cb(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }), '', '') }), 'TIMEOUT');
    const ok = await elevate(argv, {}, { platform: 'darwin', execFile: (f, a, o, cb) => { assert.equal(o.timeout, 120000); cb(null, 'out\n', ''); } });
    assert.deepEqual(ok, { stdout: 'out\n', stderr: '' });
  });
});

// ---------------------------------------------------------------------------
describe('safe mode (F3)', () => {
  let fake;
  before(() => { fake = createFakePortless(); });
  after(() => fake.cleanup());

  test('destructive wrappers throw UNSUPPORTED and run nothing', async () => {
    const sd = tempDir();
    const calls = [];
    try {
      const p = createPortless({
        env: { PORTLESS_STATE_DIR: sd, HOME: process.env.HOME, FAKE_RECORD: fake.record }, safeMode: true, portless: fake.install, servicePath: null,
        elevate: async (argv) => { calls.push(argv); return { stdout: '', stderr: '' }; },
      });
      for (const [name, fn] of [['clean', () => p.clean()], ['prune', () => p.prune()], ['trust', () => p.trust()], ['hostsSync', () => p.hostsSync()],
        ['serviceInstall', () => p.serviceInstall({ tls: false, port: 80 })], ['serviceUninstall', () => p.serviceUninstall()]]) {
        await assert.rejects(fn(), (err) => {
          assert.equal(err.code, 'UNSUPPORTED', name);
          assert.equal(err.message, 'disabled in safe mode');
          return true;
        });
      }
      for (const args of [['clean'], ['prune'], ['trust'], ['hosts', 'sync'], ['service', 'install'], ['alias', 'x', '1'], ['proxy', 'start', '--lan', '-p', '23458'],
        ['proxy', 'start', '--no-tls', '-p', '80'], ['proxy', 'stop', '-p', '443'], ['proxy', 'start', '-p', '1355'], ['proxy', 'start', '--ip', '192.0.2.1']]) {
        await rejectsCode(p.run(args), 'UNSUPPORTED');
      }
      await rejectsCode(p.run(['--version'], { elevate: true }), 'UNSUPPORTED');
      await rejectsCode(p.startProxy({ tls: false, port: 23459, lan: true }), 'UNSUPPORTED', /LAN/);
      await rejectsCode(p.startProxy({ tls: false, port: 80, lan: false }), 'UNSUPPORTED', /Port 80/);
      await rejectsCode(p.startProxy({ tls: false, port: 47800, lan: false }), 'UNSUPPORTED');
      assert.equal(calls.length, 0);
      assert.equal(fake.calls().length, 0);
    } finally {
      rmSync(sd, { recursive: true, force: true });
    }
  });

  test('mutations need an isolated PORTLESS_STATE_DIR', async () => {
    const real = createPortless({ env: { HOME: process.env.HOME, PATH: process.env.PATH }, safeMode: true, portless: fake.install });
    await rejectsCode(real.addAlias('n1-never', 9), 'UNSUPPORTED', /isolated/);
    await rejectsCode(real.removeAlias('n1-never'), 'UNSUPPORTED');
    await rejectsCode(real.changePort('n1-never', 9), 'UNSUPPORTED');
    await rejectsCode(real.renameAlias('n1-never', 'n1-never2'), 'UNSUPPORTED');
    if (existsSync('/Library/LaunchDaemons/sh.portless.proxy.plist')) {
      // The real service owns ~/.portless: safe mode refuses even with allowService (read-only HEAD probe only).
      await rejectsCode(real.stopProxy({ allowService: true }), 'SERVICE_MANAGED');
    }
    const explicitReal = createPortless({ env: { HOME: process.env.HOME, PORTLESS_STATE_DIR: join(process.env.HOME, '.portless') }, safeMode: true, portless: fake.install });
    await rejectsCode(explicitReal.addAlias('n1-never', 9), 'UNSUPPORTED');
    await rejectsCode(explicitReal.run(['proxy', 'stop', '-p', '23460']), 'UNSUPPORTED');
  });
});

// ---------------------------------------------------------------------------
describe('run()', () => {
  let fake;
  before(() => { fake = createFakePortless(); });
  after(() => fake.cleanup());
  const mk = (env = {}, extra = {}) => createPortless({ env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, FAKE_RECORD: fake.record, FORCE_COLOR: '1', ...env }, portless: fake.install, servicePath: null, ...extra });

  test('execFile without a shell: args arrive verbatim; NO_COLOR=1; FORCE_COLOR removed; ANSI stripped', async () => {
    const args = ['get', 'a b', "it's", '$(touch /tmp/nidum-run-pwn)', ';', '|', '`id`'];
    const res = await mk({ FAKE_STDOUT: '\x1b[36mhttp://a.local\x1b[39m\n' }).run(args);
    assert.equal(res.stdout, 'http://a.local\n');
    assert.equal(res.output, 'http://a.local');
    assert.equal(res.exitCode, 0);
    const last = fake.calls().at(-1);
    assert.deepEqual(last.argv, args);
    assert.equal(last.env.NO_COLOR, '1');
    assert.equal(last.env.FORCE_COLOR, undefined);
    assert.equal(existsSync('/tmp/nidum-run-pwn'), false);
  });

  test('exit ≠ 0 → PortlessError with raw output and exit code', async () => {
    await assert.rejects(mk({ FAKE_EXIT: '3', FAKE_STDERR: '\x1b[31mError:\x1b[39m boom\n' }).run(['list']), (err) => {
      assert.equal(err.code, 'UNKNOWN');
      assert.equal(err.raw, 'Error: boom');
      assert.deepEqual(err.details, { args: ['list'], exitCode: 3 });
      return true;
    });
    await rejectsCode(mk({ FAKE_EXIT: '1', FAKE_STDERR: 'Error: Port 80 requires elevated privileges and sudo failed.\n' }).run(['proxy', 'start']), 'PERMISSION');
    await rejectsCode(mk({ FAKE_EXIT: '1', FAKE_STDERR: 'Error: "x.local" is already registered by a running process (PID 4).\n' }).run(['get', 'x']), 'NAME_TAKEN_BY_APP');
    await rejectsCode(mk({ FAKE_EXIT: '1', FAKE_STDOUT: 'Proxy failed to start (timed out waiting for it to listen).\n' }).run(['proxy', 'start']), 'PROXY_DOWN');
  });

  test('timeout → TIMEOUT', async () => {
    await rejectsCode(mk({ FAKE_SLEEP_MS: '5000' }).run(['doctor'], { timeout: 300 }), 'TIMEOUT');
  });

  test('missing CLI → CLI_MISSING', async () => {
    await rejectsCode(createPortless({ portless: null }).run(['--version']), 'CLI_MISSING');
    await rejectsCode(createPortless({ portless: { ...fake.install, launcherPath: '/nonexistent/portless' } }).run(['--version']), 'CLI_MISSING');
    await rejectsCode(createPortless({ portless: null }).doctor(), 'CLI_MISSING');
  });

  test('rejects non-string args', async () => {
    await assert.rejects(mk().run(['proxy', 80]), TypeError);
    await assert.rejects(mk().run('doctor'), TypeError);
  });
});

// ---------------------------------------------------------------------------
for (const backend of ['file', 'routestore']) {
  describe(`alias mutations and conflicts (F4, F9) — ${backend === 'file' ? 'async file protocol (default)' : 'RouteStore cross-check'}`, { skip: backend === 'routestore' && !REAL && 'Portless is not installed' }, () => {
    let t;
    let p;
    let routesPath;
    const read = () => JSON.parse(readFileSync(routesPath, 'utf8'));
    before(async () => {
      t = await portlessTestEnv();
      p = createPortless({ env: t.env, safeMode: true, routeBackend: backend });
      routesPath = join(t.stateDir, 'routes.json');
    });
    after(() => t.cleanup());

    test('backend', async () => {
      assert.equal(await p.routeBackend(), backend);
      if (backend === 'file') assert.equal(await createPortless({ env: t.env }).routeBackend(), 'file', 'file protocol is the default (D16)');
    });

    test('add; alias over alias without force → NAME_TAKEN; with force → replaced', async () => {
      const r = await p.addAlias('n1-one', 5001);
      assert.deepEqual(r, { name: 'n1-one', hostname: 'n1-one.local', url: `http://n1-one.local:${t.port}`, port: 5001, kind: 'alias', pid: 0, foreignTld: false });
      await assert.rejects(p.addAlias('n1-one', 5002), (err) => {
        assert.equal(err.code, 'NAME_TAKEN');
        assert.equal(err.message, 'n1-one already points to port 5001.');
        assert.equal(err.details.route.port, 5001);
        return true;
      });
      const replaced = await p.addAlias('n1-one.local', 5002, { force: true });
      assert.equal(replaced.port, 5002);
      assert.deepEqual(read().filter((x) => x.hostname === 'n1-one.local'), [{ hostname: 'n1-one.local', port: 5002, pid: 0 }]);
      assert.equal(statSync(routesPath).mode & 0o777, 0o644);
      assert.equal(existsSync(join(t.stateDir, 'routes.lock')), false, 'lock released');
    });

    test('alias over a live app route → NAME_TAKEN_BY_APP even with force; nothing is killed', async () => {
      const routes = read();
      routes.push({ hostname: 'n1-app.local', port: 5100, pid: process.pid });
      writeFileSync(routesPath, JSON.stringify(routes, null, 2));
      for (const opts of [{}, { force: true }]) {
        await assert.rejects(p.addAlias('n1-app', 5101, opts), (err) => {
          assert.equal(err.code, 'NAME_TAKEN_BY_APP');
          assert.equal(err.details.route.kind, 'app');
          return true;
        });
      }
      assert.equal(pidStatus(process.pid), 'alive');
      assert.deepEqual(read().find((x) => x.hostname === 'n1-app.local'), { hostname: 'n1-app.local', port: 5100, pid: process.pid });
      await rejectsCode(p.removeAlias('n1-app'), 'NAME_TAKEN_BY_APP');
      await rejectsCode(p.changePort('n1-app', 5102), 'NAME_TAKEN_BY_APP');
      await rejectsCode(p.renameAlias('n1-app', 'n1-app2'), 'NAME_TAKEN_BY_APP');
      await rejectsCode(p.renameAlias('n1-one', 'n1-app', { force: true }), 'NAME_TAKEN_BY_APP');
      const listed = (await p.listRoutes()).find((r) => r.hostname === 'n1-app.local');
      assert.equal(listed.kind, 'app');
    });

    test('a dead app route does not block the name', async () => {
      assert.equal(pidStatus(DEAD_PID), 'dead');
      const routes = read();
      routes.push({ hostname: 'n1-dead.local', port: 5200, pid: DEAD_PID });
      writeFileSync(routesPath, JSON.stringify(routes, null, 2));
      assert.equal((await p.listRoutes()).some((r) => r.hostname === 'n1-dead.local'), false);
      const r = await p.addAlias('n1-dead', 5201);
      assert.equal(r.kind, 'alias');
      assert.deepEqual(read().filter((x) => x.hostname === 'n1-dead.local'), [{ hostname: 'n1-dead.local', port: 5201, pid: 0 }]);
    });

    test('changePort, renameAlias (with conflicts) and removeAlias', async () => {
      assert.equal((await p.changePort('n1-one', 5003)).port, 5003);
      await rejectsCode(p.changePort('n1-missing', 5003), 'NOT_FOUND');
      await p.addAlias('n1-two', 5004);
      await rejectsCode(p.renameAlias('n1-one', 'n1-two'), 'NAME_TAKEN');
      const renamed = await p.renameAlias('n1-one', 'n1-three');
      assert.deepEqual([renamed.name, renamed.port], ['n1-three', 5003]);
      const names = (await p.listRoutes()).map((r) => r.name);
      assert.ok(names.includes('n1-three') && !names.includes('n1-one'));
      await p.renameAlias('n1-three', 'n1-two', { force: true });
      assert.equal((await p.listRoutes()).find((r) => r.name === 'n1-two').port, 5003);
      await rejectsCode(p.renameAlias('n1-missing', 'n1-x'), 'NOT_FOUND');
      await rejectsCode(p.renameAlias('n1-two', 'Bad_Name'), 'INVALID_NAME');
      const removed = await p.removeAlias('n1-two');
      assert.equal(removed.port, 5003);
      await rejectsCode(p.removeAlias('n1-two'), 'NOT_FOUND');
      await rejectsCode(p.addAlias('setup', 5005), 'INVALID_NAME');
      for (const bad of [0, 70000, 'abc', 1.5, -1, null]) await rejectsCode(p.addAlias('n1-port', bad), 'INVALID_PORT');
      await p.addAlias('n1-port', '8080');
      await rejectsCode(p.changePort('n1-port', 'abc'), 'INVALID_PORT');
      await p.removeAlias('n1-port');
    });

    test('a foreign-TLD route can be removed by its hostname', async () => {
      const routes = read();
      routes.push({ hostname: 'n1-old.localhost', port: 5300, pid: 0 });
      writeFileSync(routesPath, JSON.stringify(routes, null, 2));
      const listed = (await p.listRoutes()).find((r) => r.hostname === 'n1-old.localhost');
      assert.deepEqual([listed.name, listed.foreignTld], ['n1-old.localhost', true]);
      const removed = await p.removeAlias('n1-old.localhost');
      assert.equal(removed.foreignTld, true);
      assert.equal(read().some((x) => x.hostname === 'n1-old.localhost'), false);
    });

    test('a failed rename changes nothing (one atomic write / step-by-step rollback)', async () => {
      await p.addAlias('n1-rb', 5400);
      const before = readFileSync(routesPath, 'utf8');
      const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      let failNext = true;
      const flaky = createPortless({
        env: t.env, safeMode: true, routeBackend: backend,
        wrapStore: backend === 'file'
          ? (store) => { store.save = async () => { throw eacces(); }; return store; }
          : (prims) => ({ add: prims.add, remove: async (h) => { if (failNext && h === 'n1-rb.local') { failNext = false; throw eacces(); } return prims.remove(h); } }),
      });
      // E13: a refused route write is ROUTES_NOT_WRITABLE (no flag set here), never PERMISSION.
      await assert.rejects(flaky.renameAlias('n1-rb', 'n1-rb2'), (err) => {
        assert.equal(err.code, 'ROUTES_NOT_WRITABLE');
        assert.deepEqual(err.details, { path: routesPath, target: 'file', owner: userInfo().username, ownedByYou: true });
        assert.match(err.raw, /EACCES/);
        return true;
      });
      const hosts = read().map((x) => x.hostname);
      assert.ok(hosts.includes('n1-rb.local'), 'old name kept');
      assert.ok(!hosts.includes('n1-rb2.local'), 'new name rolled back');
      if (backend === 'file') assert.equal(readFileSync(routesPath, 'utf8'), before, 'file untouched');
      assert.equal(existsSync(join(t.stateDir, 'routes.lock')), false, 'lock released');
    });

    test('concurrent adds of one name: exactly one wins (same instance and two instances)', async () => {
      const r1 = await Promise.allSettled([p.addAlias('n1-race', 1111), p.addAlias('n1-race', 2222)]);
      assert.deepEqual(r1.map((r) => r.status), ['fulfilled', 'rejected']);
      assert.equal(r1[1].reason.code, 'NAME_TAKEN');
      const q = createPortless({ env: t.env, safeMode: true, routeBackend: backend });
      const r2 = await Promise.allSettled([p.addAlias('n1-race2', 3333), q.addAlias('n1-race2', 4444)]);
      const won = r2.filter((r) => r.status === 'fulfilled');
      if (backend === 'file') assert.equal(won.length, 1, 'check runs under the route lock across instances');
      const final = read().filter((x) => x.hostname === 'n1-race.local');
      assert.deepEqual(final, [{ hostname: 'n1-race.local', port: 1111, pid: 0 }]);
      await p.removeAlias('n1-race');
      await p.removeAlias('n1-race2');
    });
  });
}

test('FileRouteStore breaks a stale lock and honours a fresh one', async () => {
  await withTempDir('nidum-n1-lock-', async (dir) => {
    const s = new FileRouteStore(dir);
    const add = (h, port) => s.transact(() => ({ ops: [{ op: 'add', hostname: h, port }], result: null }));
    mkdirSync(join(dir, 'routes.lock'));
    const old = new Date(Date.now() - 20000);
    const { utimesSync, rmdirSync } = await import('node:fs');
    utimesSync(join(dir, 'routes.lock'), old, old);
    await add('a.local', 1);
    assert.deepEqual(await s.load(), [{ hostname: 'a.local', port: 1, pid: 0 }]);
    assert.equal(existsSync(join(dir, 'routes.lock')), false);
    const inode = statSync(join(dir, 'routes.json')).ino;

    // A fresh lock is waited for without blocking the event loop, then taken.
    mkdirSync(join(dir, 'routes.lock'));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    setTimeout(() => rmdirSync(join(dir, 'routes.lock')), 300);
    const t0 = Date.now();
    await add('b.local', 2);
    clearInterval(timer);
    assert.ok(Date.now() - t0 >= 250, 'waited for the lock');
    assert.ok(ticks >= 2, `event loop kept running while waiting (${ticks} ticks)`);
    assert.deepEqual((await s.load()).map((r) => r.hostname), ['a.local', 'b.local']);
    assert.equal(statSync(join(dir, 'routes.json')).ino, inode, 'written in place (same inode)');
    assert.equal(statSync(join(dir, 'routes.json')).mode & 0o777, 0o644);
  });
});

// ---------------------------------------------------------------------------
describe('live: isolated Portless proxy (F4, F8)', { skip: !REAL && 'Portless is not installed', timeout: 120000 }, () => {
  let t;
  let p;
  let a;
  let b;
  before(async () => {
    t = await portlessTestEnv();
    assert.ok(t.port >= 20000);
    p = createPortless({ env: t.env, safeMode: true });
    a = await startThrowawayHttp({ title: 'A', body: 'n1-body-A' });
    b = await startThrowawayHttp({ title: 'B', body: 'n1-body-B' });
  });
  after(async () => {
    try {
      await p.run(['proxy', 'stop', '-p', String(t.port)], { timeout: 15000 });
    } catch {
      /* already stopped */
    }
    await a?.close();
    await b?.close();
    const ps = await execFileP('/bin/ps', ['-A', '-o', 'pid=,command=']);
    const leaks = String(ps.stdout).split('\n').filter((l) => l.includes('dns-sd') && l.includes(String(t.port)));
    t.cleanup();
    assert.deepEqual(leaks, [], 'no dns-sd children published for the test proxy');
    assert.equal(existsSync(t.stateDir), false);
  });

  test('version through run()', async () => {
    const res = await p.run(['--version']);
    assert.equal(res.output, REAL.version);
  });

  test('doctor() parses a real run, including exit 1', async () => {
    const d = await p.doctor();
    assert.equal(d.header.stateDir, t.stateDir);
    assert.ok(d.findings.some((f) => f.status === 'warn' && /Proxy is not running/.test(f.message)));
    assert.equal(typeof d.raw, 'string');
    const srv = await startThrowawayHttp();
    try {
      const busy = createPortless({ env: { ...t.env, PORTLESS_PORT: String(srv.port) }, safeMode: true });
      const d2 = await busy.doctor();
      assert.equal(d2.summary.failures, 1);
      assert.ok(d2.findings.some((f) => f.status === 'fail'));
    } finally {
      await srv.close();
    }
  });

  test('state while stopped', async () => {
    assert.deepEqual(await p.getProxyState(), {
      running: false, pid: null, port: t.port, tls: false, lan: false, lanIp: null, tlds: ['localhost'], wildcard: null,
      elevated: false, managedBy: null, baseUrl: `http://127.0.0.1:${t.port}`, serviceLoaded: false,
    });
  });

  test('start → alias → request through the proxy → list → rename → change port → remove', async () => {
    const started = await p.startProxy({ tls: false, port: t.port, lan: false, fixedIp: null, wildcard: false });
    const pid = Number(readFileSync(join(t.stateDir, 'proxy.pid'), 'utf8'));
    assert.deepEqual(started, {
      running: true, pid, port: t.port, tls: false, lan: false, lanIp: null, tlds: ['local'], wildcard: null,
      elevated: false, managedBy: 'manual', baseUrl: `http://127.0.0.1:${t.port}`, serviceLoaded: false,
    });
    const again = await p.startProxy({ tls: false, port: t.port, lan: false });
    assert.equal(again.pid, pid, 'starting twice is a no-op');

    const route = await p.addAlias('n1-live', a.port);
    assert.equal(route.url, `http://n1-live.local:${t.port}`);
    const res = await eventually(t.port, 'n1-live.local', (r) => r.status === 200);
    assert.match(res.body, /n1-body-A/);

    const listed = await p.listRoutes();
    assert.deepEqual(listed, [{ name: 'n1-live', hostname: 'n1-live.local', url: `http://n1-live.local:${t.port}`, port: a.port, kind: 'alias', pid: 0, foreignTld: false }]);
    const cli = await p.run(['list']);
    assert.match(cli.output, new RegExp(`http://n1-live\\.local:${t.port}\\s+->\\s+localhost:${a.port}\\s+\\(alias\\)`), 'portless list cross-check');

    await p.renameAlias('n1-live', 'n1-renamed');
    await eventually(t.port, 'n1-renamed.local', (r) => r.status === 200 && r.body.includes('n1-body-A'));
    await eventually(t.port, 'n1-live.local', (r) => r.status === 404);

    await p.changePort('n1-renamed', b.port);
    await eventually(t.port, 'n1-renamed.local', (r) => r.status === 200 && r.body.includes('n1-body-B'));

    await p.removeAlias('n1-renamed');
    await eventually(t.port, 'n1-renamed.local', (r) => r.status === 404);
    assert.deepEqual(await p.listRoutes(), []);
  });

  test('stop proxy → add alias → start proxy → request succeeds', async () => {
    const stopped = await p.stopProxy();
    assert.equal(stopped.running, false);
    assert.equal(stopped.managedBy, null);
    assert.equal(stopped.pid, null);
    assert.deepEqual(stopped.tlds, ['localhost'], 'Portless deletes proxy.tlds on stop — why `portless alias` would mint .localhost');

    const route = await p.addAlias('n1-paused', a.port);
    assert.equal(route.hostname, 'n1-paused.local');
    assert.deepEqual(JSON.parse(readFileSync(join(t.stateDir, 'routes.json'), 'utf8')), [{ hostname: 'n1-paused.local', port: a.port, pid: 0 }]);

    const started = await p.startProxy({ tls: false, port: t.port, lan: false });
    assert.equal(started.running, true);
    const res = await eventually(t.port, 'n1-paused.local', (r) => r.status === 200);
    assert.match(res.body, /n1-body-A/, 'the app answered, not a Portless error page');

    const final = await p.stopProxy();
    assert.equal(final.running, false);
  });
});

test('isolated proxy port is never a forbidden one', async () => {
  const port = await freePort({ min: 20000 });
  assert.ok(![80, 443, 1355, 47800].includes(port));
});

// ---------------------------------------------------------------------------
// Iteration 2: regression tests for N1 validation 1 findings 1–9, 12 and the
// D16/D17 contract changes. Everything that could reach Portless runs against
// the fake binary only.

describe('safe mode cannot be bypassed (validation 1 findings 2–6)', () => {
  let fake;
  let sd;
  let other;
  before(() => {
    fake = createFakePortless();
    sd = tempDir();
    other = tempDir();
  });
  after(() => {
    fake.cleanup();
    rmSync(sd, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  const mk = (env = {}, extra = {}) => createPortless({
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, PORTLESS_STATE_DIR: sd, PORTLESS_LAN: '0', PORTLESS_HTTPS: '0', FAKE_RECORD: fake.record, ...env },
    safeMode: true, portless: fake.install, servicePath: null, ...extra,
  });

  test('safeArgsProblem: allowlist', () => {
    for (const ok of [['--version'], ['-v'], ['--help'], ['-h'], ['doctor'], ['list'], ['get', 'recipes'], ['get', 'api.v2'], ['service', 'status'],
      ['proxy', 'start', '--no-tls', '-p', '23456'], ['proxy', 'start', '-p', '23456', '--no-tls', '--tld', 'local', '--skip-trust'],
      ['proxy', 'start', '--port', '65535', '--no-tls'], ['proxy', 'stop', '-p', '23456'], ['proxy', 'stop', '--port', '1024']]) {
      assert.equal(safeArgsProblem(ok), null, ok.join(' '));
    }
  });

  test('run(): global flags, app commands, loose ports and TLS starts are refused before anything runs', async () => {
    const p = mk();
    const attacks = [
      ['--ngrok', 'clean'], ['--tailscale', 'trust'], ['--funnel', 'prune'], ['--ngrok', 'hosts', 'sync'], ['--ngrok', 'alias', 'x', '1'],
      ['--lan', 'list'], ['--ip', '192.0.2.1', 'list'], ['--lan-ip-auto', '192.0.2.1', 'proxy', 'start', '--no-tls', '-p', '23456'],
      ['--script', 'dev', 'doctor'], ['--name', 'x', 'true'], ['--force', 'list'], ['--', 'clean'],
      ['clean'], ['prune'], ['trust'], ['hosts', 'sync'], ['hosts', 'clean'], ['service', 'install'], ['service', 'uninstall'], ['alias', 'x', '1'],
      ['run', '--name', 'x', 'true'], ['run', 'true'], ['myapp', 'true'], ['myapp'],
      ['proxy', 'stop'], ['proxy', 'stop', '-p', '80abc'], ['proxy', 'stop', '-p', '80'], ['proxy', 'stop', '-p', '443'], ['proxy', 'stop', '-p', '1355'],
      ['proxy', 'stop', '-p', '47800'], ['proxy', 'stop', '-p', '1023'], ['proxy', 'stop', '-p', '70000'], ['proxy', 'stop', '-p', '23456', '-p', '23457'],
      ['proxy', 'stop', '-p', '-1'], ['proxy', 'stop', '-p', ''], ['proxy', 'stop', '--port=23456'],
      ['proxy', 'start', '-p', '23462'], ['proxy', 'start', '--https', '-p', '23462'], ['proxy', 'start', '--no-tls', '--https', '-p', '23462'],
      ['proxy', 'start', '--no-tls', '-p', '23462', '--foreground'], ['proxy', 'start', '--no-tls', '-p', '23462', '--lan'],
      ['proxy', 'start', '--no-tls', '-p', '23462', '--ip', '192.0.2.1'], ['proxy', 'start', '--no-tls', '-p', '23462', '--tld', 'test'],
      ['proxy', 'start', '--no-tls', '-p', '23462', '--wildcard'], ['proxy', 'start', '--no-tls', '-p', '23462', '--cert', 'a', '--key', 'b'],
      ['proxy', 'restart', '-p', '23462'], ['proxy'],
      ['get', '--help'], ['get', 'a', 'b'], ['get'], ['list', '--lan'], ['doctor', 'x'], ['service', 'status', '--lan'], ['--version', 'clean'],
    ];
    for (const args of attacks) await rejectsCode(p.run(args), 'UNSUPPORTED');
    await rejectsCode(p.run(['--version'], { elevate: true }), 'UNSUPPORTED');
    assert.equal(fake.calls().length, 0, 'the binary never ran');
  });

  test('run(): allowed commands run, with LAN/HTTPS/hosts sync/tunnels forced off in the effective env', async () => {
    const p = mk({ PORTLESS_LAN: '1', PORTLESS_LAN_IP: '192.0.2.9', PORTLESS_INTERNAL_LAN_IP: '192.0.2.9', PORTLESS_HTTPS: '1', PORTLESS_SYNC_HOSTS: '1', PORTLESS_NGROK: '1', PORTLESS_TAILSCALE: '1', PORTLESS_FUNNEL: '1' });
    const n = fake.calls().length;
    await p.run(['--version']);
    await p.run(['proxy', 'start', '--no-tls', '-p', '23462', '--tld', 'local', '--skip-trust']);
    await p.run(['proxy', 'stop', '--port', '23462'], { env: { PORTLESS_LAN: '1', PORTLESS_LAN_IP: '192.0.2.8', PORTLESS_HTTPS: 'true' } });
    const calls = fake.calls().slice(n);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.env.PORTLESS_LAN, '0');
      assert.equal(c.env.PORTLESS_SYNC_HOSTS, '0');
      for (const k of ['PORTLESS_LAN_IP', 'PORTLESS_INTERNAL_LAN_IP', 'PORTLESS_NGROK', 'PORTLESS_TAILSCALE', 'PORTLESS_FUNNEL']) assert.equal(c.env[k], undefined, k);
      assert.equal(c.env.PORTLESS_STATE_DIR, sd);
    }
    assert.equal(calls[1].env.PORTLESS_HTTPS, '0');
    assert.equal(calls[2].env.PORTLESS_HTTPS, '0');
  });

  test('run(): checks the effective (merged) env, not the instance env', async () => {
    const p = mk();
    const n = fake.calls().length;
    for (const env of [{ PORTLESS_STATE_DIR: undefined }, { PORTLESS_STATE_DIR: '' }, { PORTLESS_STATE_DIR: join(homedir(), '.portless') },
      { PORTLESS_STATE_DIR: join(homedir(), '.portless', 'sub') }, { PORTLESS_STATE_DIR: homedir() }]) {
      await rejectsCode(p.run(['proxy', 'stop', '-p', '23456'], { env }), 'UNSUPPORTED');
      await rejectsCode(p.run(['proxy', 'start', '--no-tls', '-p', '23456'], { env }), 'UNSUPPORTED');
    }
    assert.equal(fake.calls().length, n);
    await p.run(['proxy', 'stop', '-p', '23456'], { env: { PORTLESS_STATE_DIR: other } });
    assert.equal(fake.calls().at(-1).env.PORTLESS_STATE_DIR, other, 'a different isolated dir is fine');
  });

  test('real state dir is recognised through case variants, symlinks and an injected user', async () => {
    const realDir = join(homedir(), '.portless');
    const link = join(other, 'link-to-real');
    if (existsSync(realDir)) symlinkSync(realDir, link);
    const variants = [join(homedir(), '.PORTLESS'), join(homedir(), '.Portless', '.'), join(homedir(), 'x', '..', '.portless'), `${realDir}/`, '/tmp/portless'];
    if (existsSync(realDir)) variants.push(link);
    const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
    let wrote = 0;
    const guardStore = (store) => { store.save = async () => { wrote += 1; throw new Error('WOULD WRITE'); }; return store; };
    for (const dir of variants) {
      if (!caseInsensitive && dir.includes('PORTLESS')) continue;
      for (const user of [undefined, { username: 'example', uid: 501, gid: 20, homedir: '/Users/example' }]) {
        const p = createPortless({ env: { HOME: user ? '/Users/example' : process.env.HOME, PORTLESS_STATE_DIR: dir }, safeMode: true, portless: fake.install, servicePath: null, user, wrapStore: guardStore });
        await rejectsCode(p.addAlias('n1-never', 9), 'UNSUPPORTED');
        await rejectsCode(p.startProxy({ tls: false, port: 23463, lan: false }), 'UNSUPPORTED');
        await rejectsCode(p.run(['proxy', 'stop', '-p', '23463']), 'UNSUPPORTED');
      }
    }
    assert.equal(wrote, 0);
    assert.equal(fake.calls().filter((c) => c.argv[2] === '23463' || c.argv.includes('23463')).length, 0);
  });

  test('startProxy: TLS refused, --skip-trust appended, LAN env forced off', async () => {
    const p = mk({ PORTLESS_LAN: '1', PORTLESS_LAN_IP: '192.0.2.9' }, {
      probe: { isProxyResponding: async () => fake.calls().some((c) => c.argv[1] === 'start' && c.argv.includes('23464')), isPortListening: async () => false },
    });
    await rejectsCode(p.startProxy({ tls: true, port: 23464, lan: false }), 'UNSUPPORTED', /HTTPS/);
    await p.startProxy({ tls: false, port: 23464, lan: false });
    const c = fake.calls().find((x) => x.argv[1] === 'start' && x.argv.includes('23464'));
    assert.deepEqual(c.argv, ['proxy', 'start', '--no-tls', '-p', '23464', '--tld', 'local', '--skip-trust']);
    assert.equal(c.env.PORTLESS_LAN, '0');
    assert.equal(c.env.PORTLESS_LAN_IP, undefined);
    assert.equal(c.script, fake.install.launcherPath, 'run() executes the unresolved launcher (D17)');
  });
});

describe('contract additions and remaining findings (8, 9, 12, D16, D17)', () => {
  let fake;
  before(() => { fake = createFakePortless(); });
  after(() => fake.cleanup());

  test('validatePort → INVALID_PORT', () => {
    assert.equal(validatePort(1), 1);
    assert.equal(validatePort('65535'), 65535);
    for (const bad of [0, 65536, -1, 1.5, '1.5', 'abc', '', null, undefined, NaN, '80abc']) {
      assert.throws(() => validatePort(bad), (e) => e instanceof PortlessError && e.code === 'INVALID_PORT', String(bad));
    }
  });

  test('run() executes launcherPath, not the resolved binPath', async () => {
    const p = createPortless({ env: { HOME: process.env.HOME, FAKE_RECORD: fake.record }, portless: fake.install, servicePath: null });
    await p.run(['--version']);
    const last = fake.calls().at(-1);
    assert.equal(last.script, fake.install.launcherPath);
    assert.notEqual(fake.install.launcherPath, fake.install.binPath);
  });

  test('serviceStatus() runs `service status` and parses it', async () => {
    const p = createPortless({ env: { HOME: process.env.HOME, FAKE_RECORD: fake.record, FAKE_STDOUT: fixture('service-status.txt') }, portless: fake.install, servicePath: null, safeMode: true });
    const st = await p.serviceStatus();
    assert.deepEqual(fake.calls().at(-1).argv, ['service', 'status']);
    assert.equal(st.managerState, 'running');
    assert.equal(st.proxyPort, 80);
    assert.equal(st.stateDir, '/Users/example/.portless');
    assert.equal(st.raw, fixture('service-status.txt').trim());
  });

  test('stateDir(): PORTLESS_STATE_DIR, else HOME/.portless (USERPROFILE on Windows)', () => {
    assert.equal(createPortless({ env: { PORTLESS_STATE_DIR: '/x/y', HOME: '/h' } }).stateDir(), '/x/y');
    assert.equal(createPortless({ env: { HOME: '/h' } }).stateDir(), join('/h', '.portless'));
    assert.equal(createPortless({ env: { USERPROFILE: 'C:\\Users\\e', HOME: '/ignored' }, platform: 'win32' }).stateDir(), join('C:\\Users\\e', '.portless'));
    assert.equal(createPortless({ env: {}, user: { username: 'e', uid: 1, gid: 1, homedir: '/home/e' } }).stateDir(), join('/home/e', '.portless'));
  });

  test('getProxyState and route URLs share one TLS fallback', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'routes.json'), JSON.stringify([{ hostname: 'a.local', port: 1, pid: 0 }]));
      for (const [https, port, expectTls, expectPort] of [['1', undefined, true, 443], ['0', undefined, false, 80], [undefined, '23465', true, 23465], ['false', '23465', false, 23465]]) {
        const env = { PORTLESS_STATE_DIR: dir, HOME: '/Users/example' };
        if (https !== undefined) env.PORTLESS_HTTPS = https;
        if (port !== undefined) env.PORTLESS_PORT = port;
        const p = createPortless({ env, servicePath: null, portless: null, probe: { isProxyResponding: async () => false } });
        const st = await p.getProxyState();
        const [route] = await p.listRoutes();
        assert.equal(st.tls, expectTls);
        assert.equal(st.port, expectPort);
        assert.equal(route.url, formatUrl('a.local', expectPort, expectTls));
        assert.ok(st.baseUrl.startsWith(expectTls ? 'https://' : 'http://'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('elevate builder rejects values it cannot pass through faithfully', () => {
    assert.throws(() => buildElevationCommand(['/opt/a=b/portless'], {}, { platform: 'darwin' }), TypeError);
    assert.throws(() => buildElevationCommand(['/opt/a=b/portless'], {}, { platform: 'linux' }), TypeError);
    assert.throws(() => buildElevationCommand(['/x/portless'], { HOME: 'a\rb' }, { platform: 'darwin' }), TypeError);
    assert.throws(() => buildElevationCommand(['/x/portless', 'a\nb'], {}, { platform: 'darwin' }), TypeError);
    assert.throws(() => buildElevationCommand(['C:\\node.exe'], { A: '%PATH%' }, { platform: 'win32' }), TypeError);
    assert.throws(() => buildElevationCommand(['C:\\node.exe', '!x!'], {}, { platform: 'win32' }), TypeError);
    assert.doesNotThrow(() => buildElevationCommand(['/x/portless', "it's $(x) `y` \\ \""], { HOME: '/Users/a b' }, { platform: 'darwin' }));
  });
});

describe('D16: the async file protocol writes exactly what RouteStore writes', { skip: !REAL && 'Portless is not installed' }, () => {
  test('identical routes.json after the same operations', async () => {
    const dirs = {};
    const seed = JSON.stringify([
      { hostname: 'keep.local', port: 1, pid: 0 }, { hostname: 'dead.local', port: 2, pid: DEAD_PID },
      { hostname: 'app.local', port: 3, pid: process.pid }, { hostname: 'old.localhost', port: 4, pid: 0, tailscaleUrl: 'https://x.ts.net' },
    ], null, 2);
    try {
      for (const backend of ['file', 'routestore']) {
        const t = await portlessTestEnv();
        dirs[backend] = t;
        writeFileSync(join(t.stateDir, 'routes.json'), seed);
        const p = createPortless({ env: t.env, safeMode: true, routeBackend: backend });
        assert.equal(await p.routeBackend(), backend);
        await p.addAlias('a', 5001);
        await p.addAlias('b', 5002);
        await p.addAlias('a', 5003, { force: true });
        await p.changePort('b', 5004);
        await p.renameAlias('a', 'c');
        await p.addAlias('dead', 5005);
        await p.removeAlias('old.localhost');
        await p.renameAlias('b', 'keep', { force: true });
        await rejectsCode(p.addAlias('app', 5006, { force: true }), 'NAME_TAKEN_BY_APP');
      }
      const file = readFileSync(join(dirs.file.stateDir, 'routes.json'), 'utf8');
      const rs = readFileSync(join(dirs.routestore.stateDir, 'routes.json'), 'utf8');
      assert.equal(file, rs);
      assert.deepEqual(JSON.parse(file).map((r) => r.hostname), ['app.local', 'c.local', 'dead.local', 'keep.local']);
    } finally {
      for (const t of Object.values(dirs)) t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Iteration 3: N1 validation 2 backlog (D18).

describe('safe-mode hardening (validation 2 findings 1–2)', () => {
  let fake;
  let decoyHome;
  let work;
  const decoyUser = () => ({ username: 'decoy', uid: 501, gid: 20, homedir: decoyHome });
  before(() => {
    fake = createFakePortless();
    decoyHome = tempDir('nidum-n1-decoy-');
    mkdirSync(join(decoyHome, '.portless'));
    work = tempDir();
  });
  after(() => {
    fake.cleanup();
    rmSync(decoyHome, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });
  // A store whose writes would be visible; the state dir must never even be created.
  const mk = (dir) => createPortless({
    env: { HOME: decoyHome, PORTLESS_STATE_DIR: dir, FAKE_RECORD: fake.record }, safeMode: true, portless: fake.install,
    servicePath: null, user: decoyUser(), wrapStore: (store) => { store.save = async () => { throw new Error('WOULD WRITE'); }; return store; },
  });

  async function refusedEverywhere(dir) {
    const p = mk(dir);
    await rejectsCode(p.addAlias('n1-never', 9), 'UNSUPPORTED');
    await rejectsCode(p.startProxy({ tls: false, port: 23471, lan: false }), 'UNSUPPORTED');
    await rejectsCode(p.run(['proxy', 'stop', '-p', '23471']), 'UNSUPPORTED');
  }

  test('relative paths and ".." segments are refused', async () => {
    const before = fake.calls().length;
    for (const dir of ['relative/state', './state', 'state', `${work}/../${work.split('/').pop()}`, `${work}/a/../b`, '..', `${decoyHome}/x/../.portless/sub`]) {
      await refusedEverywhere(dir);
    }
    assert.equal(fake.calls().length, before);
  });

  test('a missing subfolder inside a protected dir is refused through symlinks and firmlinks', async () => {
    const real = join(decoyHome, '.portless');
    const link = join(work, 'link-to-decoy-state');
    symlinkSync(real, link);
    const linkToHome = join(work, 'link-to-decoy-home');
    symlinkSync(decoyHome, linkToHome);
    const dirs = [join(link, 'sub'), join(link, 'sub', 'deeper'), join(linkToHome, '.portless', 'sub'), join(real, 'sub')];
    const firm = join('/System/Volumes/Data', realpathSync(real));
    let firmChecked = false;
    if (process.platform === 'darwin' && existsSync(firm) && statSync(firm).ino === statSync(real).ino) {
      dirs.push(join(firm, 'sub'));
      firmChecked = true;
    }
    for (const dir of dirs) await refusedEverywhere(dir);
    assert.deepEqual(readdirSync(real), [], 'nothing was created inside the protected dir');
    if (process.platform === 'darwin') assert.ok(firmChecked, 'firmlink path exercised');
  });

  test('an existing dir that contains a protected dir is refused, firmlink spelling included', async () => {
    const dirs = [decoyHome];
    const firmHome = join('/System/Volumes/Data', realpathSync(decoyHome));
    if (process.platform === 'darwin' && existsSync(firmHome) && statSync(firmHome).ino === statSync(decoyHome).ino) dirs.push(firmHome);
    for (const dir of dirs) await refusedEverywhere(dir);
    if (process.platform === 'darwin') assert.equal(dirs.length, 2, 'firmlink spelling of the home exercised');
    assert.deepEqual(readdirSync(decoyHome), ['.portless'], 'nothing written into the home');
  });

  test('a fresh isolated dir (existing or not yet created) is still accepted', async () => {
    const fresh = join(work, 'not-yet', 'state');
    const p = createPortless({ env: { HOME: decoyHome, PORTLESS_STATE_DIR: fresh }, safeMode: true, portless: fake.install, servicePath: null, user: decoyUser() });
    const r = await p.addAlias('n1-ok', 5500);
    assert.equal(r.hostname, 'n1-ok.local');
    assert.ok(existsSync(join(fresh, 'routes.json')));
  });

  test('proxy stop is refused when proxy.pid belongs to another user (EPERM → Portless would sudo)', async () => {
    const sd = join(work, 'eperm-state');
    mkdirSync(sd);
    writeFileSync(join(sd, 'proxy.pid'), '1\n');
    assert.equal(pidStatus(1), 'eperm');
    const p = createPortless({ env: { HOME: process.env.HOME, PORTLESS_STATE_DIR: sd, FAKE_RECORD: fake.record }, safeMode: true, portless: fake.install, servicePath: null });
    const before = fake.calls().length;
    await rejectsCode(p.run(['proxy', 'stop', '-p', '23472']), 'UNSUPPORTED', /another user/);
    await rejectsCode(p.run(['proxy', 'stop', '-p', '23472'], { env: { PORTLESS_STATE_DIR: sd } }), 'UNSUPPORTED');
    assert.equal(fake.calls().length, before);
    for (const loose of ['1abc', '1.5', '+1', '1 2', ' 1\n', '01']) {
      // Portless parses with parseInt(text, 10) → 1 (root, EPERM) for all of these.
      writeFileSync(join(sd, 'proxy.pid'), loose);
      await rejectsCode(p.run(['proxy', 'stop', '-p', '23472']), 'UNSUPPORTED', /another user/);
    }
    assert.equal(fake.calls().length, before);
    writeFileSync(join(sd, 'proxy.pid'), `${DEAD_PID}\n`);
    await p.run(['proxy', 'stop', '-p', '23472']);
    writeFileSync(join(sd, 'proxy.pid'), `${process.pid}\n`);
    await p.run(['proxy', 'stop', '-p', '23472']);
    assert.equal(fake.calls().length, before + 2, 'dead or own pids are fine');
  });
});

describe('listRoutes never returns [] for a failed read (validation 2 finding 3)', () => {
  let dir;
  let p;
  const good = JSON.stringify([{ hostname: 'a.local', port: 1, pid: 0 }, { hostname: 'b.local', port: 2, pid: 0 }], null, 2);
  before(() => {
    dir = tempDir();
    p = createPortless({ env: { PORTLESS_STATE_DIR: dir, HOME: '/Users/example', PORTLESS_HTTPS: '0' }, servicePath: null, portless: null });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('missing file → []', async () => {
    assert.deepEqual(await p.listRoutes(), []);
  });

  // Deterministic torn reads: a spy on fs.promises.readFile (passes the real
  // read through) tells the test when the reader has actually seen the torn
  // file; only then is the good content written. No wall-clock races, so it
  // holds under full parallel `npm test` load, and a regression that maps a
  // torn read to [] fails on the first round.
  function spyRoutesReads(onRead) {
    const real = fs.promises.readFile;
    fs.promises.readFile = async function spied(...args) {
      const text = await real.apply(this, args);
      if (String(args[0]).endsWith('routes.json')) onRead(text);
      return text;
    };
    return () => { fs.promises.readFile = real; };
  }

  test('a torn read (empty or half-written) is retried and returns the full list — 20 deterministic rounds', async () => {
    const file = join(dir, 'routes.json');
    const tornStates = ['', '   ', '[\n  {\n    "hostname": "a.lo', good.slice(0, good.length - 1), '[\n  {'];
    let tornSeen = 0;
    for (let round = 0; round < 20; round += 1) {
      const torn = tornStates[round % tornStates.length];
      writeFileSync(file, torn);
      let seen;
      const sawTorn = new Promise((resolve) => { seen = resolve; });
      const restore = spyRoutesReads((text) => { if (text === torn) seen(); });
      try {
        const pending = p.listRoutes();
        await sawTorn; // the reader has read the torn file at least once
        tornSeen += 1;
        writeFileSync(file, good); // the "rest of the write" lands
        const routes = await pending;
        assert.deepEqual(routes.map((r) => r.name), ['a', 'b'], `round ${round} (${JSON.stringify(torn)})`);
      } finally {
        restore();
      }
    }
    assert.equal(tornSeen, 20, 'every round really observed a torn file');
  });

  test('a file that stays empty or unparsable → STATE_UNREADABLE after the retries', async () => {
    for (const bad of ['', '   \n', '{"broken', '{"hostname":"a.local"}']) {
      writeFileSync(join(dir, 'routes.json'), bad);
      const t0 = Date.now();
      await assert.rejects(p.listRoutes(), (err) => {
        assert.equal(err.code, 'STATE_UNREADABLE');
        assert.equal(err.details.attempts, 6);
        return true;
      });
      assert.ok(Date.now() - t0 >= 90, 'retried before giving up');
    }
    writeFileSync(join(dir, 'routes.json'), '[]');
    assert.deepEqual(await p.listRoutes(), [], 'a real empty list is still []');
  });
});

// ---------------------------------------------------------------------------
// Iteration 6: stopping / starting a service-managed proxy (E12, D40–D43).
// Only a fake elevate() ever "runs" launchctl/systemctl/schtasks here; the only
// real command is the read-only `launchctl print` (allowed).

describe('startup-service control (E12)', () => {
  let dir;
  before(() => { dir = tempDir(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function serviceFixture(platform, { label, unitName } = {}) {
    const sd = mkdtempSync(join(dir, `${platform}-state-`));
    const files = { darwin: ['sh.portless.proxy.plist', '/Users/example/.portless</string>', `${sd}</string>`],
      linux: ['portless.service', 'PORTLESS_STATE_DIR="/home/example/.portless"', `PORTLESS_STATE_DIR="${sd}"`],
      win32: ['portless-service.cmd', 'PORTLESS_STATE_DIR=C:\\Users\\example\\.portless', `PORTLESS_STATE_DIR=${sd}`] }[platform];
    let text = fixture(files[0]);
    assert.ok(text.includes(files[1]), `fixture ${files[0]} has the state dir`);
    if (label !== undefined) text = text.replace('<string>sh.portless.proxy</string>', `<string>${label}</string>`);
    const defDir = mkdtempSync(join(dir, `${platform}-def-`));
    const def = join(defDir, unitName || files[0]); // the unit's file name is its systemd name
    writeFileSync(def, text.replace(files[1], files[2]));
    return { sd, def };
  }

  function harness(platform = 'darwin', { loaded = true, up = true, safeMode = false, elevateImpl, label, unitName, serviceWaitMs } = {}) {
    const { sd, def } = serviceFixture(platform, { label, unitName });
    const calls = [];
    const st = { loaded, up, probes: 0 };
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example', USERPROFILE: 'C:\\Users\\example' }, platform, servicePath: def, portless: null, safeMode,
      user: { username: 'example', uid: 501, gid: 20, homedir: '/Users/example' },
      elevate: elevateImpl || (async (argv, env, opts) => { calls.push({ argv, env, opts }); st.loaded = !st.loaded; st.up = st.loaded; return { stdout: '', stderr: '' }; }),
      probe: { isProxyResponding: async () => st.up, isPortListening: async () => st.up, isServiceLoaded: async () => { st.probes += 1; return st.loaded; } },
      serviceWaitMs,
    });
    return { p, calls, st, sd, def };
  }

  test('argv builders and labels for macOS, Linux and Windows', () => {
    assert.equal(serviceLabel(fixture('sh.portless.proxy.plist'), '/x.plist', 'darwin'), 'sh.portless.proxy');
    assert.equal(serviceLabel('<plist></plist>', '/x.plist', 'darwin'), 'sh.portless.proxy');
    assert.equal(serviceLabel('', '/etc/systemd/system/portless.service', 'linux'), 'portless.service');
    assert.equal(serviceLabel('', 'C:\\x.cmd', 'win32'), 'Portless Proxy');
    const mac = { platform: 'darwin', label: 'sh.portless.proxy', path: '/Library/LaunchDaemons/sh.portless.proxy.plist' };
    assert.deepEqual(serviceControlArgv('stop', mac), ['/bin/launchctl', 'bootout', 'system/sh.portless.proxy']);
    assert.deepEqual(serviceControlArgv('start', mac), ['/bin/launchctl', 'bootstrap', 'system', '/Library/LaunchDaemons/sh.portless.proxy.plist']);
    assert.deepEqual(serviceControlArgv('status', mac), ['/bin/launchctl', 'print', 'system/sh.portless.proxy']);
    const lin = { platform: 'linux', label: 'portless.service', path: '/etc/systemd/system/portless.service' };
    assert.deepEqual(serviceControlArgv('stop', lin), ['systemctl', 'stop', 'portless.service']);
    assert.deepEqual(serviceControlArgv('start', lin), ['systemctl', 'start', 'portless.service']);
    assert.deepEqual(serviceControlArgv('status', lin), ['systemctl', 'is-active', '--quiet', 'portless.service']);
    const win = { platform: 'win32', label: 'Portless Proxy', path: 'C:\\ProgramData\\portless\\service\\portless-service.cmd' };
    assert.deepEqual(serviceControlArgv('stop', win), ['schtasks.exe', '/End', '/TN', 'Portless Proxy']);
    assert.deepEqual(serviceControlArgv('start', win), ['schtasks.exe', '/Run', '/TN', 'Portless Proxy']);
    assert.throws(() => serviceControlArgv('stop', { platform: 'aix', label: 'x', path: 'x' }), PortlessError);
    assert.deepEqual(SERVICE_CONTROL_ENV, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  });

  test('isServiceLoaded: read-only status command, exit code → boolean', async () => {
    const seen = [];
    const fakeExec = (code, stdout = '') => (file, args, opts, cb) => { seen.push([file, ...args]); assert.ok(opts.timeout > 0); cb(code ? Object.assign(new Error('x'), { code }) : null, stdout, ''); };
    const mac = { platform: 'darwin', label: 'sh.portless.proxy', path: '/x' };
    assert.equal(await isServiceLoaded(mac, { execFile: fakeExec(0) }), true);
    assert.equal(await isServiceLoaded(mac, { execFile: fakeExec(113) }), false);
    assert.deepEqual(seen[0], ['/bin/launchctl', 'print', 'system/sh.portless.proxy']);
    assert.equal(await isServiceLoaded({ platform: 'linux', label: 'portless.service', path: '/x' }, { execFile: fakeExec(3) }), false);
    const win = { platform: 'win32', label: 'Portless Proxy', path: 'x' };
    assert.equal(await isServiceLoaded(win, { execFile: fakeExec(0, 'TaskName: Portless Proxy\r\nStatus:   Running\r\n') }), true);
    assert.equal(await isServiceLoaded(win, { execFile: fakeExec(0, 'Status: Ready\r\n') }), false);
  });

  test('this Mac (read-only `launchctl print`): the real service is loaded', { skip: !existsSync('/Library/LaunchDaemons/sh.portless.proxy.plist') && 'no real service' }, async () => {
    const real = createPortless();
    const svc = real.getServiceConfig();
    assert.equal(svc.label, 'sh.portless.proxy');
    assert.equal(await isServiceLoaded(svc), true);
    const st = await real.getProxyState();
    assert.equal(st.managedBy, 'service');
    assert.equal(st.serviceLoaded, st.running, 'loaded and answering together');
  });

  test('macOS stopService: elevated `launchctl bootout`, exact argv/env/prompt; state stays service-managed', async () => {
    const { p, calls } = harness('darwin');
    const after = await p.stopService();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['/bin/launchctl', 'bootout', 'system/sh.portless.proxy']);
    assert.deepEqual(calls[0].env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    assert.equal(calls[0].opts.prompt, 'Nidum Local needs your password to stop network sharing.');
    assert.ok(calls[0].opts.timeout >= 60000);
    assert.equal(after.running, false);
    assert.equal(after.serviceLoaded, false);
    assert.equal(after.managedBy, 'service', 'booted out but the plist remains');
    await p.stopService();
    assert.equal(calls.length, 1, 'already stopped → no password dialog');
  });

  test('macOS startService: elevated `launchctl bootstrap system <plist>`', async () => {
    const { p, calls, def } = harness('darwin', { loaded: false, up: false });
    const after = await p.startService();
    assert.deepEqual(calls.map((c) => c.argv), [['/bin/launchctl', 'bootstrap', 'system', def]]);
    assert.deepEqual(calls[0].env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    assert.equal(calls[0].opts.prompt, 'Nidum Local needs your password to start network sharing.');
    assert.equal(after.running, true);
    assert.equal(after.serviceLoaded, true);
    await p.startService();
    assert.equal(calls.length, 1, 'already loaded → nothing to do');
  });

  test('Linux (pkexec systemctl) and Windows (schtasks, experimental) argv', async () => {
    const lin = harness('linux');
    await lin.p.stopService();
    await lin.p.startService();
    assert.deepEqual(lin.calls.map((c) => c.argv), [['systemctl', 'stop', 'portless.service'], ['systemctl', 'start', 'portless.service']]);
    const win = harness('win32');
    await win.p.stopService();
    await win.p.startService();
    assert.deepEqual(win.calls.map((c) => c.argv), [['schtasks.exe', '/End', '/TN', 'Portless Proxy'], ['schtasks.exe', '/Run', '/TN', 'Portless Proxy']]);
  });

  test('refused in safe mode and without an own service; cancel → PERMISSION', async () => {
    const safe = harness('darwin', { safeMode: true });
    await rejectsCode(safe.p.stopService(), 'UNSUPPORTED', /safe mode/);
    await rejectsCode(safe.p.startService(), 'UNSUPPORTED', /safe mode/);
    assert.equal(safe.calls.length, 0);
    const none = createPortless({ env: { PORTLESS_STATE_DIR: dir, HOME: '/Users/example' }, servicePath: null, portless: null, elevate: async () => assert.fail('must not elevate') });
    await rejectsCode(none.stopService(), 'UNSUPPORTED', /No startup service/);
    await rejectsCode(none.startService(), 'UNSUPPORTED');
    const cancelled = harness('darwin', { elevateImpl: async () => { throw new PortlessError('PERMISSION', 'Password not entered. Nothing changed.'); } });
    await rejectsCode(cancelled.p.stopService(), 'PERMISSION', /^Password not entered/);
  });
});

describe('startup-service control hardening (validation 4 F2–F4)', () => {
  let dir;
  before(() => { dir = tempDir(); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function make(platform, { label, unitName, loaded = true, up = true } = {}) {
    const sd = mkdtempSync(join(dir, 'state-'));
    const defDir = mkdtempSync(join(dir, 'def-'));
    const src = { darwin: 'sh.portless.proxy.plist', linux: 'portless.service' }[platform];
    let text = fixture(src).replace('/Users/example/.portless</string>', `${sd}</string>`).replace('PORTLESS_STATE_DIR="/home/example/.portless"', `PORTLESS_STATE_DIR="${sd}"`);
    if (label !== undefined) text = text.replace('<string>sh.portless.proxy</string>', `<string>${label}</string>`);
    const def = join(defDir, unitName || src);
    writeFileSync(def, text);
    const calls = [];
    const st = { loaded, up, probes: 0, execs: 0 };
    const p = createPortless({
      env: { PORTLESS_STATE_DIR: sd, HOME: '/Users/example' }, platform, servicePath: def, portless: null, serviceWaitMs: 200,
      elevate: async (argv, env, opts) => { calls.push({ argv, env, opts }); st.loaded = !st.loaded; st.up = st.loaded; return { stdout: '', stderr: '' }; },
      probe: { isProxyResponding: async () => st.up, isPortListening: async () => st.up, isServiceLoaded: async () => { st.probes += 1; return st.loaded; } },
    });
    return { p, calls, st, def };
  }

  test('F3: a service whose label/unit isn’t Portless’s is never controlled', async () => {
    for (const [platform, opts] of [['darwin', { label: 'com.apple.WindowServer' }], ['darwin', { label: 'sh.portless.proxy ' }], ['darwin', { label: ' sh.portless.proxy' }],
      ['darwin', { label: 'sh.portless.proxy;x' }], ['darwin', { label: '' }], ['linux', { unitName: 'sshd.service' }], ['linux', { unitName: 'portless' }]]) {
      const { p, calls } = make(platform, opts);
      const svc = p.getServiceConfig();
      assert.ok(svc, `${platform} ${JSON.stringify(opts)} parsed`);
      await rejectsCode(p.stopService(), 'UNSUPPORTED', /isn’t Portless’s own/);
      await rejectsCode(p.startService(), 'UNSUPPORTED', /isn’t Portless’s own/);
      assert.equal(calls.length, 0, 'no elevation');
    }
    const tampered = make('darwin', { label: 'com.apple.WindowServer' }).p.getServiceConfig();
    assert.equal(tampered.label, 'com.apple.WindowServer');
    let ran = 0;
    assert.equal(await isServiceLoaded(tampered, { execFile: () => { ran += 1; } }), false);
    assert.equal(ran, 0, 'not even the read-only status command runs for a foreign label');
    for (const ok of ['sh.portless.proxy', 'sh.portless.proxy-2', 'sh.portless.a.b']) assert.equal(isTrustedServiceLabel({ platform: 'darwin', label: ok }), true, ok);
    for (const ok of ['portless.service', 'portless-proxy.service', 'portless@user.service']) assert.equal(isTrustedServiceLabel({ platform: 'linux', label: ok }), true, ok);
    assert.equal(isTrustedServiceLabel({ platform: 'win32', label: 'Portless Proxy' }), true);
    assert.equal(isTrustedServiceLabel({ platform: 'win32', label: 'Other' }), false);
    assert.equal(serviceLabel('<key>Label</key><string> sh.portless.proxy </string>', '/x', 'darwin'), ' sh.portless.proxy ', 'not trimmed');
    const good = make('darwin');
    await good.p.stopService();
    assert.deepEqual(good.calls[0].argv, ['/bin/launchctl', 'bootout', 'system/sh.portless.proxy']);
  });

  test('F2: startService on a loaded service that doesn’t answer → PROXY_DOWN (no elevation)', async () => {
    const { p, calls } = make('darwin', { loaded: true, up: false });
    await rejectsCode(p.startService(), 'PROXY_DOWN', /did not start/);
    assert.equal(calls.length, 0);
  });

  test('F2: stopService on an unloaded service while a proxy still answers → "Sharing is still on."', async () => {
    const { p, calls } = make('darwin', { loaded: false, up: true });
    await rejectsCode(p.stopService(), 'UNKNOWN', /^Sharing is still on\.$/);
    assert.equal(calls.length, 0);
    const done = make('darwin', { loaded: false, up: false });
    assert.equal((await done.p.stopService()).running, false, 'really off → success');
  });

  test('F4: the service status probe is cached ~2 s and refreshed after start/stop', async () => {
    const { p, st, calls } = make('darwin');
    await p.getProxyState();
    await p.getProxyState();
    await p.getProxyState();
    assert.equal(st.probes, 1, 'cached within 2 s');
    const after = await p.stopService();
    assert.equal(calls.length, 1);
    assert.equal(after.serviceLoaded, false, 'fresh after acting');
    assert.ok(st.probes >= 2);
  });
});

// ---------------------------------------------------------------------------
// E13 (D46–D48): a locked or read-only routes.json is explained, never changed.
// Flags are set ONLY on files inside this suite's own temp state dirs
// (`nidum-portless-*` under os.tmpdir()), always cleared with `chflags nouchg`
// in a finally/after that runs before the temp dir is removed. `schg` needs
// root, so it and Linux `lsattr` are stub/fixture-tested only. The real
// ~/.portless is never touched.
// ---------------------------------------------------------------------------

const E13_LOCKED = "Your address list is locked, so Nidum Local can't change it.";
const E13_NOT_WRITABLE = "Nidum Local isn't allowed to change your address list.";
const ME = userInfo().username;
const UNLOCKED_ACCESS = (path) => ({ locked: false, flag: null, target: null, writable: true, path, owner: null, ownedByYou: null });
/** Every E13 test is bounded: a regression (e.g. the stale-lock spin) must fail, not hang the suite (validation 5 F7). */
const E13_T = { timeout: 30000 };

function realFlagsProbe() {
  const calls = [];
  return { calls, probe: { readFileFlags: async (p) => { calls.push(p); return readFileFlags(p); } } };
}

async function rejectsRoutes(promise, code, details) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PortlessError, `expected PortlessError, got ${err && err.stack}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.equal(err.message, code === 'ROUTES_LOCKED' ? E13_LOCKED : E13_NOT_WRITABLE);
    assert.deepEqual(err.details, details);
    assert.equal(typeof err.raw, 'string');
    assert.match(err.raw, /EPERM|EACCES|operation not permitted|permission denied/i, 'raw = the OS error text');
    assert.deepEqual(Object.keys(err.toJSON()), ['code', 'message', 'details', 'raw']);
    return true;
  });
}

describe('E13: flag and owner probes (parsers, fixtures, stubs)', () => {
  test('parseStatFlags: captured macOS `stat -L -f "%f %u %Su"` output; schg wins; other flags ignored', E13_T, () => {
    assert.deepEqual(parseStatFlags(fixture('stat-flags-plain.txt')), { flag: null, owner: 'someone', uid: 501 });
    assert.deepEqual(parseStatFlags(fixture('stat-flags-uchg.txt')), { flag: 'uchg', owner: 'someone', uid: 501 });
    assert.deepEqual(parseStatFlags(fixture('stat-flags-hidden.txt')), { flag: null, owner: 'someone', uid: 501 }, 'UF_HIDDEN is not a lock');
    assert.deepEqual(parseStatFlags(fixture('stat-flags-schg.txt')), { flag: 'schg', owner: 'root', uid: 0 });
    assert.deepEqual(parseStatFlags(`${SF_IMMUTABLE + UF_IMMUTABLE} 0 root`), { flag: 'schg', owner: 'root', uid: 0 });
    assert.deepEqual(parseStatFlags(`${2 ** 31 + UF_IMMUTABLE} 7 a`), { flag: 'uchg', owner: 'a', uid: 7 }, 'high bit set (u_int32)');
    assert.deepEqual(parseStatFlags('2 501'), { flag: 'uchg', owner: null, uid: 501 }, 'no name');
    // F6: a directory-service name with spaces keeps the flag (the numbers come first).
    assert.deepEqual(parseStatFlags(fixture('stat-flags-spaced-owner.txt')), { flag: 'uchg', owner: 'Jane Q. Example', uid: 1234567 });
    assert.deepEqual(parseStatFlags('2 501 first last'), { flag: 'uchg', owner: 'first last', uid: 501 });
    assert.deepEqual(parseStatFlags('2 501 123'), { flag: 'uchg', owner: '123', uid: 501 }, 'an all-digit name stays the name');
    // Validation 7 F4 (M5): trailing blanks are dropped, inner ones kept.
    assert.deepEqual(parseStatFlags('2 501 arjun \t \n'), { flag: 'uchg', owner: 'arjun', uid: 501 }, 'trailing blanks dropped');
    assert.deepEqual(parseStatFlags('0 501 Jane Q \t\r\n'), { flag: null, owner: 'Jane Q', uid: 501 });
    assert.deepEqual(parseStatFlags('2 501  \t '), { flag: 'uchg', owner: null, uid: 501 }, 'a name of blanks only is no name');
    for (const bad of ['', 'x', '2', '-2 0 a', '2a 0 b', '2 x y', '2 first last', '2 0 a\n3 0 b', 'stat: x: No such file or directory', undefined]) assert.equal(parseStatFlags(bad), null, String(bad));
  });

  test('parseLsattr (Linux, experimental): `i` → schg', E13_T, () => {
    assert.equal(parseLsattr(fixture('lsattr-immutable.txt')), 'schg');
    assert.equal(parseLsattr(fixture('lsattr-plain.txt')), null);
    assert.equal(parseLsattr(''), undefined);
    assert.equal(parseLsattr('lsattr: Operation not supported While reading flags on /x'), undefined);
  });

  test('readFileFlags: exact argv (through symlinks), no shell, fixed PATH, timeout ≤ 2 s; failures → null', E13_T, async () => {
    const calls = [];
    const fake = (outputs) => (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      const out = outputs[file];
      if (out instanceof Error) cb(out, '', '');
      else cb(null, out ?? '', '');
    };
    const p = '/Users/someone/.portless/routes.json';
    assert.deepEqual(await readFileFlags(p, { platform: 'darwin', execFile: fake({ '/usr/bin/stat': fixture('stat-flags-uchg.txt') }) }), { flag: 'uchg', owner: 'someone', uid: 501 });
    assert.deepEqual(calls[0].file, '/usr/bin/stat');
    assert.deepEqual(calls[0].args, ['-L', '-f', '%f %u %Su', '--', p], '-L: the link target’s flags (F1)');
    assert.equal(calls[0].opts.timeout, FILE_FLAGS_TIMEOUT_MS);
    assert.ok(FILE_FLAGS_TIMEOUT_MS <= 2000);
    assert.equal(calls[0].opts.shell, false);
    assert.deepEqual(calls[0].opts.env, SERVICE_CONTROL_ENV);

    calls.length = 0;
    await readFileFlags(p, { platform: 'darwin', timeout: 60000, execFile: fake({ '/usr/bin/stat': '0 1 a' }) });
    assert.equal(calls[0].opts.timeout, 2000, 'a longer timeout is clamped to 2 s');

    calls.length = 0;
    const lp = '/home/someone/.portless/routes.json';
    assert.deepEqual(await readFileFlags(lp, { platform: 'linux', execFile: fake({ '/usr/bin/lsattr': fixture('lsattr-immutable.txt'), '/usr/bin/stat': '1000 some one\n' }) }), { flag: 'schg', owner: 'some one', uid: 1000 });
    assert.deepEqual(calls.map((c) => [c.file, c.args]), [['/usr/bin/lsattr', ['-d', '--', lp]], ['/usr/bin/stat', ['-L', '-c', '%u %U', '--', lp]]]);
    assert.ok(calls.every((c) => c.opts.timeout <= 2000 && c.opts.shell === false));
    assert.deepEqual(await readFileFlags(lp, { platform: 'linux', execFile: fake({ '/usr/bin/lsattr': fixture('lsattr-plain.txt'), '/usr/bin/stat': '0 root\n' }) }), { flag: null, owner: 'root', uid: 0 });
    assert.deepEqual(await readFileFlags(lp, { platform: 'linux', execFile: fake({ '/usr/bin/lsattr': new Error('no lsattr'), '/usr/bin/stat': '0 root\n' }) }), { flag: null, owner: 'root', uid: 0 });
    assert.equal(await readFileFlags(lp, { platform: 'linux', execFile: fake({ '/usr/bin/lsattr': new Error('x'), '/usr/bin/stat': new Error('y') }) }), null);

    const timedOut = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    assert.equal(await readFileFlags(p, { platform: 'darwin', execFile: fake({ '/usr/bin/stat': timedOut }) }), null);
    assert.equal(await readFileFlags(p, { platform: 'darwin', execFile: () => { throw new Error('spawn failed'); } }), null);
    calls.length = 0;
    assert.equal(await readFileFlags('relative/routes.json', { platform: 'darwin', execFile: fake({}) }), null);
    assert.equal(await readFileFlags(p, { platform: 'win32', execFile: fake({}) }), null);
    assert.equal(calls.length, 0, 'nothing runs for a relative path or on Windows');
  });

  test('schg (needs root to set, so stubbed): route writes → ROUTES_LOCKED schg; getRoutesAccess too', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      const routesPath = join(t.stateDir, 'routes.json');
      await createPortless({ env: t.env, safeMode: true }).addAlias('n1-schg', 5700);
      const before = readFileSync(routesPath);
      const eperm = () => Object.assign(new Error(`EPERM: operation not permitted, open '${routesPath}'`), { code: 'EPERM', path: routesPath });
      const p = createPortless({
        env: t.env, safeMode: true,
        probe: { readFileFlags: async (x) => (x === routesPath ? { flag: 'schg', owner: 'root', uid: 0 } : { flag: null, owner: ME }) },
        wrapStore: (store) => { store.save = async () => { throw eperm(); }; return store; },
      });
      await rejectsRoutes(p.addAlias('n1-schg2', 5701), 'ROUTES_LOCKED', { path: routesPath, flag: 'schg', target: 'file', owner: 'root', ownedByYou: false });
      await rejectsRoutes(p.changePort('n1-schg', 5702), 'ROUTES_LOCKED', { path: routesPath, flag: 'schg', target: 'file', owner: 'root', ownedByYou: false });
      assert.deepEqual(readFileSync(routesPath), before);
      assert.deepEqual(await p.getRoutesAccess(), { locked: true, flag: 'schg', target: 'file', writable: false, path: routesPath, owner: 'root', ownedByYou: false },
        'owner of the locked path is always reported (D51); root-owned → not yours');

      // A folder with schg (stubbed) wins over the file.
      const q = createPortless({
        env: t.env, safeMode: true,
        probe: { readFileFlags: async (x) => ({ flag: x === t.stateDir ? 'schg' : 'uchg', owner: 'root', uid: 0 }) },
        wrapStore: (store) => { store.save = async () => { throw eperm(); }; return store; },
      });
      await rejectsRoutes(q.removeAlias('n1-schg'), 'ROUTES_LOCKED', { path: t.stateDir, flag: 'schg', target: 'folder', owner: 'root', ownedByYou: false });
      assert.deepEqual((await q.getRoutesAccess()).target, 'folder');
    } finally {
      t.cleanup();
    }
  });

  test('Linux (experimental, fixtures): lsattr `i` → ROUTES_LOCKED schg', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      const routesPath = join(t.stateDir, 'routes.json');
      writeFileSync(routesPath, '[]');
      const lsattrTargets = [];
      const exec = (file, args, opts, cb) => {
        assert.ok(opts.timeout <= 2000);
        const target = args[args.length - 1];
        // lsattr can't follow a symlink itself, so it is given the resolved path (D51).
        if (file === '/usr/bin/lsattr') lsattrTargets.push(target);
        if (file === '/usr/bin/lsattr') return cb(null, target === realpathSync(routesPath) ? fixture('lsattr-immutable.txt') : fixture('lsattr-plain.txt'), '');
        if (file === '/usr/bin/stat') return cb(null, '1000 someone\n', '');
        return cb(new Error(`unexpected ${file}`), '', '');
      };
      const p = createPortless({
        env: t.env, safeMode: true, platform: 'linux', execFile: exec, servicePath: null,
        wrapStore: (store) => { store.save = async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM', path: routesPath }); }; return store; },
      });
      await rejectsRoutes(p.addAlias('n1-linux', 5710), 'ROUTES_LOCKED', { path: routesPath, flag: 'schg', target: 'file', owner: 'someone', ownedByYou: typeof process.getuid === 'function' ? process.getuid() === 1000 : null });
      assert.equal(readFileSync(routesPath, 'utf8'), '[]');
      assert.ok(lsattrTargets.includes(realpathSync(routesPath)), 'lsattr probes the resolved path');
    } finally {
      t.cleanup();
    }
  });

  test('getRoutesAccess never throws; a failing probe means "not locked"; a refused write without flags → ROUTES_NOT_WRITABLE', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      const routesPath = join(t.stateDir, 'routes.json');
      writeFileSync(routesPath, '[]');
      const p = createPortless({
        env: t.env, safeMode: true,
        probe: { readFileFlags: async () => { throw new Error('probe exploded'); } },
        wrapStore: (store) => { store.save = async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS', path: routesPath }); }; return store; },
      });
      assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(routesPath));
      await assert.rejects(p.addAlias('n1-erofs', 5720), (err) => {
        assert.equal(err.code, 'ROUTES_NOT_WRITABLE');
        assert.deepEqual(err.details, { path: routesPath, target: 'file', owner: ME, ownedByYou: true }, 'owner from the file’s uid when the probe fails');
        assert.match(err.raw, /EROFS/);
        return true;
      });
      const weird = createPortless({ env: { ...t.env, PORTLESS_STATE_DIR: `${t.stateDir}/bad\0dir` }, probe: { readFileFlags: async () => ({ flag: 'uchg' }) } });
      const r = await weird.getRoutesAccess();
      assert.equal(r.locked, false);
      assert.equal(r.writable, true);
      assert.deepEqual(Object.keys(r), ['locked', 'flag', 'target', 'writable', 'path', 'owner', 'ownedByYou']);
    } finally {
      t.cleanup();
    }
  });

  test('F2: a forced read ("Check again") is never overwritten by an older plain read that resolves later', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      const routesPath = join(t.stateDir, 'routes.json');
      writeFileSync(routesPath, '[]');
      let lockedNow = false;
      const probe = {
        readFileFlags: async (x) => {
          const seen = lockedNow;
          await sleep(seen ? 0 : 300); // the old read is slow and saw "unlocked"
          return { flag: seen && x === routesPath ? 'uchg' : null, owner: ME };
        },
      };
      const p = createPortless({ env: t.env, safeMode: true, probe });
      const a = p.getRoutesAccess();
      await sleep(20);
      lockedNow = true;
      const r = await p.getRoutesAccess({ refresh: true });
      assert.equal(r.locked, true, 'the forced read sees the lock');
      const joined = p.getRoutesAccess(); // served by the forced read's answer
      assert.equal((await a).locked, false, 'the old read still answers its own caller');
      assert.equal((await joined).locked, true);
      assert.equal((await p.getRoutesAccess()).locked, true, 'the cache keeps the newer, forced answer');
      // Two forced reads: the one started last fills the cache.
      lockedNow = false;
      const slow = p.getRoutesAccess({ refresh: true }); // slow, "unlocked"
      await sleep(20);
      lockedNow = true;
      assert.equal((await p.getRoutesAccess({ refresh: true })).locked, true);
      assert.equal((await slow).locked, false);
      assert.equal((await p.getRoutesAccess()).locked, true, 'the earlier forced read did not overwrite the later one');
    } finally {
      t.cleanup();
    }
  });

  test('F6 + D51: an owner name with spaces keeps the lock; ownedByYou compares the owner’s uid with this account', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      const routesPath = join(t.stateDir, 'routes.json');
      writeFileSync(routesPath, '[]');
      const calls = [];
      const exec = (file, args, opts, cb) => {
        calls.push([file, args]);
        const target = args[args.length - 1];
        cb(null, target === routesPath ? fixture('stat-flags-spaced-owner.txt') : `0 ${process.getuid()} ${ME}\n`, '');
      };
      const eperm = (code) => ({ wrapStore: (store) => { store.save = async () => { throw Object.assign(new Error(`${code}: refused, open '${routesPath}'`), { code, path: routesPath }); }; return store; } });
      const p = createPortless({ env: t.env, safeMode: true, platform: 'darwin', servicePath: null, execFile: exec, ...eperm('EPERM') });
      assert.deepEqual(await p.getRoutesAccess(), { locked: true, flag: 'uchg', target: 'file', writable: false, path: routesPath, owner: 'Jane Q. Example', ownedByYou: false });
      assert.ok(calls.every(([file, args]) => file === '/usr/bin/stat' && args[0] === '-L'), 'every probe reads through symlinks');
      await rejectsRoutes(p.addAlias('n1-spaced', 5740), 'ROUTES_LOCKED', { path: routesPath, flag: 'uchg', target: 'file', owner: 'Jane Q. Example', ownedByYou: false });

      // Not locked, owned by root: not yours.
      const q = createPortless({ env: t.env, safeMode: true, probe: { readFileFlags: async () => ({ flag: null, owner: 'root', uid: 0 }) }, ...eperm('EACCES') });
      await rejectsRoutes(q.addAlias('n1-root', 5741), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: 'root', ownedByYou: false });
      // Owned by this account (uid from fs.stat when the probe has none): yours, with this account's name.
      const r = createPortless({ env: t.env, safeMode: true, probe: { readFileFlags: async () => ({ flag: null, owner: null }) }, ...eperm('EACCES') });
      await rejectsRoutes(r.addAlias('n1-mine', 5742), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: ME, ownedByYou: true });
      // No uid to compare with (e.g. Windows): unknown, never a guess.
      const s = createPortless({ env: t.env, user: { username: 'nobody-here', uid: undefined, gid: 0, homedir: t.stateDir }, probe: { readFileFlags: async () => ({ flag: null, owner: null }) }, ...eperm('EACCES') });
      await rejectsRoutes(s.addAlias('n1-unknown', 5743), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: null, ownedByYou: null });
      // Hostile probe uids are ignored (fs.stat decides).
      for (const uid of [-1, 1.5, '0', 2 ** 53, NaN]) {
        const h = createPortless({ env: t.env, safeMode: true, probe: { readFileFlags: async () => ({ flag: null, owner: 'x', uid }) }, ...eperm('EACCES') });
        await rejectsRoutes(h.addAlias('n1-hostile', 5744), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: 'x', ownedByYou: true });
      }
      assert.equal(readFileSync(routesPath, 'utf8'), '[]');
    } finally {
      t.cleanup();
    }
  });

  test('PERMISSION keeps its meaning: only a cancelled/refused admin dialog (or a CLI that needed root)', E13_T, async () => {
    const t = await portlessTestEnv();
    try {
      for (const code of ['EPERM', 'EACCES', 'EROFS']) {
        const p = createPortless({
          env: t.env, safeMode: true, probe: { readFileFlags: async () => ({ flag: null, owner: ME }) },
          wrapStore: (store) => { store.save = async () => { throw Object.assign(new Error(`${code}: refused`), { code }); }; return store; },
        });
        await assert.rejects(p.addAlias(`n1-perm-${code.toLowerCase()}`, 5730), (err) => err.code === 'ROUTES_NOT_WRITABLE');
      }
    } finally {
      t.cleanup();
    }
  });
});

describe('E13: real `chflags uchg` on temp state dirs (macOS)', { skip: (process.platform !== 'darwin' && 'chflags is macOS only') || (process.getuid?.() === 0 && 'root bypasses permissions') }, () => {
  const envs = [];
  async function freshEnv() {
    const t = await portlessTestEnv();
    envs.push(t);
    return t;
  }
  after(() => {
    unlockAll(); // always first: a flagged file would make the temp dir unremovable
    for (const t of envs) {
      // A test that timed out may have left a 0555 folder behind: make it removable.
      try {
        execFileSync('/bin/chmod', ['-R', 'u+rwX', t.stateDir], { timeout: 5000, stdio: 'ignore' });
      } catch {
        /* already gone */
      }
      t.cleanup();
    }
    assert.equal(e13Flagged.size, 0, 'every flag cleared');
  });

  test('routes.json locked: every route operation → ROUTES_LOCKED (file, uchg); file byte-identical; getRoutesAccess before/during/after + cache', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const { calls, probe } = realFlagsProbe();
    const p = createPortless({ env: t.env, safeMode: true, probe });
    await p.addAlias('n1-locked', 5600);
    await p.addAlias('n1-other', 5601);

    // Before: unlocked and writable.
    assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(routesPath));
    const probesBefore = calls.length;
    assert.ok(probesBefore >= 1);

    const before = readFileSync(routesPath);
    const inode = statSync(routesPath).ino;
    chflagsTemp('uchg', routesPath, t.stateDir);
    try {
      assert.deepEqual(await readFileFlags(routesPath), { flag: 'uchg', owner: ME, uid: process.getuid() }, 'real /usr/bin/stat sees the flag');
      // Cached for 2 s: the lock isn't seen yet without a refresh, and no probe runs.
      assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(routesPath));
      assert.equal(calls.length, probesBefore, 'served from the cache');
      const locked = { locked: true, flag: 'uchg', target: 'file', writable: false, path: routesPath, owner: ME, ownedByYou: true };
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), locked, 'refresh bypasses the cache');

      const details = { path: routesPath, flag: 'uchg', target: 'file', owner: ME, ownedByYou: true };
      const ops = [
        () => p.addAlias('n1-new', 5602),
        () => p.addAlias('n1-locked', 5603, { force: true }),
        () => p.changePort('n1-locked', 5604),
        () => p.renameAlias('n1-locked', 'n1-renamed'),
        () => p.removeAlias('n1-locked'),
      ];
      for (const op of ops) {
        await rejectsRoutes(op(), 'ROUTES_LOCKED', details);
        assert.deepEqual(readFileSync(routesPath), before, 'byte-identical');
        assert.equal(statSync(routesPath).ino, inode);
        assert.equal(existsSync(join(t.stateDir, 'routes.lock')), false, 'lock released');
      }
      // A precondition failure needs no write and still says what it is.
      await rejectsCode(p.addAlias('n1-locked', 5605), 'NAME_TAKEN');
      // A second instance (no cache) agrees; the module never changes flags.
      assert.deepEqual(await createPortless({ env: t.env, safeMode: true }).getRoutesAccess(), locked);
      assert.deepEqual(await readFileFlags(routesPath), { flag: 'uchg', owner: ME, uid: process.getuid() }, 'still locked: nothing cleared it');

      // The failed writes dropped the cache: the next plain call probes again.
      const n = calls.length;
      assert.deepEqual(await p.getRoutesAccess(), locked);
      assert.ok(calls.length > n, 'recomputed after a route write');
    } finally {
      chflagsTemp('nouchg', routesPath, t.stateDir);
    }

    // After: still cached as locked for up to 2 s, then fresh.
    assert.equal((await p.getRoutesAccess()).locked, true, 'cache holds for the TTL');
    await sleep(ROUTES_ACCESS_TTL_MS + 100);
    assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(routesPath), 'TTL expired');
    assert.equal((await p.addAlias('n1-after', 5606)).port, 5606, 'writes work again');
    assert.deepEqual((await p.listRoutes()).map((r) => r.name), ['n1-after', 'n1-locked', 'n1-other']);
  });

  test('state folder locked: ROUTES_LOCKED (folder) from the routes.lock mkdir, even over a stale lock; nothing created', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-folder', 5610);
    const before = readFileSync(routesPath);
    const entries = readdirSync(t.stateDir).sort();
    chflagsTemp('uchg', t.stateDir, t.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), { locked: true, flag: 'uchg', target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true },
        'D51: writable needs the folder too, and a locked folder is not writable');
      const details = { path: t.stateDir, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true };
      for (const op of [() => p.addAlias('n1-new', 5611), () => p.changePort('n1-folder', 5612), () => p.renameAlias('n1-folder', 'n1-f2'), () => p.removeAlias('n1-folder')]) {
        await rejectsRoutes(op(), 'ROUTES_LOCKED', details);
      }
      assert.deepEqual(readFileSync(routesPath), before, 'byte-identical');
      assert.deepEqual(readdirSync(t.stateDir).sort(), entries, 'no routes.lock (or anything else) created');
    } finally {
      chflagsTemp('nouchg', t.stateDir, t.stateDir);
    }

    // A stale routes.lock that can't be removed in a locked folder fails fast
    // instead of spinning (it used to `continue` forever).
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, old, old);
    chflagsTemp('uchg', t.stateDir, t.stateDir);
    try {
      const t0 = Date.now();
      await rejectsRoutes(p.addAlias('n1-stale', 5613), 'ROUTES_LOCKED', { path: t.stateDir, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.ok(Date.now() - t0 < 3000, `failed fast (${Date.now() - t0} ms)`);
      assert.deepEqual(readFileSync(routesPath), before);
    } finally {
      chflagsTemp('nouchg', t.stateDir, t.stateDir);
    }
    assert.equal((await p.addAlias('n1-stale', 5613)).port, 5613, 'stale lock broken once unlocked');
    assert.equal(existsSync(lockPath), false);
  });

  test('routes.json chmod 0444 → ROUTES_NOT_WRITABLE with the owner; read-only folder → path is the folder', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-ro', 5620);
    const before = readFileSync(routesPath);
    fs.chmodSync(routesPath, 0o444);
    try {
      await rejectsRoutes(p.changePort('n1-ro', 5621), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: ME, ownedByYou: true });
      await rejectsRoutes(p.addAlias('n1-ro2', 5622), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', owner: ME, ownedByYou: true });
      assert.deepEqual(readFileSync(routesPath), before, 'byte-identical');
      assert.equal(existsSync(join(t.stateDir, 'routes.lock')), false);
      assert.deepEqual(await p.getRoutesAccess(), { locked: false, flag: null, target: 'file', writable: false, path: routesPath, owner: ME, ownedByYou: true });
    } finally {
      fs.chmodSync(routesPath, 0o644);
    }
    assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath));

    fs.chmodSync(t.stateDir, 0o555);
    try {
      await rejectsRoutes(p.addAlias('n1-ro3', 5623), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', owner: ME, ownedByYou: true });
      assert.deepEqual(readFileSync(routesPath), before);
      // D51: a writable routes.json in a read-only folder is not writable (the routes.lock mkdir needs the folder).
      assert.equal(fs.accessSync(routesPath, fs.constants.W_OK), undefined, 'the file itself is writable');
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), { locked: false, flag: null, target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true });
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
    }
  });

  test('missing routes.json is not locked; access is judged on the folder (or its nearest existing parent)', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const { calls, probe } = realFlagsProbe();
    assert.equal(existsSync(routesPath), false);
    const p = createPortless({ env: t.env, safeMode: true, probe });
    assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(routesPath));
    assert.ok(!calls.includes(routesPath), 'no flag probe on a file that does not exist');

    const sub = join(t.stateDir, 'not', 'yet');
    const q = createPortless({ env: { ...t.env, PORTLESS_STATE_DIR: sub }, safeMode: true });
    assert.deepEqual(await q.getRoutesAccess(), UNLOCKED_ACCESS(join(sub, 'routes.json')), 'a state dir not created yet');

    fs.chmodSync(t.stateDir, 0o555);
    try {
      assert.deepEqual(await createPortless({ env: t.env }).getRoutesAccess(), { locked: false, flag: null, target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true });
      assert.deepEqual(await q.getRoutesAccess({ refresh: true }), { locked: false, flag: null, target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true }, 'nearest existing parent');
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
    }

    // A locked, empty folder: locked even though routes.json doesn't exist.
    chflagsTemp('uchg', t.stateDir, t.stateDir);
    try {
      assert.deepEqual(await createPortless({ env: t.env }).getRoutesAccess(), { locked: true, flag: 'uchg', target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true });
      await rejectsRoutes(p.addAlias('n1-first', 5630), 'ROUTES_LOCKED', { path: t.stateDir, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.equal(existsSync(routesPath), false);
    } finally {
      chflagsTemp('nouchg', t.stateDir, t.stateDir);
    }
  });

  test('F1: a symlinked state folder or routes.json reports the target’s lock (`stat -L`)', E13_T, async () => {
    const target = await freshEnv();
    const holder = await freshEnv();
    await createPortless({ env: target.env, safeMode: true }).addAlias('n1-link', 5650);
    const realRoutes = join(target.stateDir, 'routes.json');
    const before = readFileSync(realRoutes);
    const link = join(holder.stateDir, 'state-link');
    symlinkSync(target.stateDir, link);
    const p = createPortless({ env: { ...target.env, PORTLESS_STATE_DIR: link }, safeMode: true });
    assert.deepEqual(await p.getRoutesAccess(), UNLOCKED_ACCESS(join(link, 'routes.json')));
    chflagsTemp('uchg', target.stateDir, target.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), { locked: true, flag: 'uchg', target: 'folder', writable: false, path: link, owner: ME, ownedByYou: true });
      await rejectsRoutes(p.addAlias('n1-link2', 5651), 'ROUTES_LOCKED', { path: link, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      await rejectsRoutes(p.changePort('n1-link', 5652), 'ROUTES_LOCKED', { path: link, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.deepEqual(readFileSync(realRoutes), before);
    } finally {
      chflagsTemp('nouchg', target.stateDir, target.stateDir);
    }

    // routes.json itself a symlink to a locked file elsewhere.
    const t = await freshEnv();
    const realFile = join(holder.stateDir, 'real-routes.json');
    writeFileSync(realFile, '[]');
    const routesLink = join(t.stateDir, 'routes.json');
    symlinkSync(realFile, routesLink);
    const q = createPortless({ env: t.env, safeMode: true });
    chflagsTemp('uchg', realFile, holder.stateDir);
    try {
      assert.deepEqual(await q.getRoutesAccess(), { locked: true, flag: 'uchg', target: 'file', writable: false, path: routesLink, owner: ME, ownedByYou: true });
      await rejectsRoutes(q.addAlias('n1-flink', 5653), 'ROUTES_LOCKED', { path: routesLink, flag: 'uchg', target: 'file', owner: ME, ownedByYou: true });
      assert.equal(readFileSync(realFile, 'utf8'), '[]');
      assert.ok(fs.lstatSync(routesLink).isSymbolicLink(), 'the link is left alone');
    } finally {
      chflagsTemp('nouchg', realFile, holder.stateDir);
    }
    assert.equal((await q.addAlias('n1-flink', 5653)).port, 5653, 'writes go through the link once unlocked');
    assert.match(readFileSync(realFile, 'utf8'), /n1-flink/);
  });

  test('F3: a dangling, looping or directory-pointing routes.lock symlink is stale at once (no busy-spin); locked folder → ROUTES_LOCKED', E13_T, async () => {
    const t = await freshEnv();
    const lockPath = join(t.stateDir, 'routes.lock');
    const hasLock = () => readdirSync(t.stateDir).includes('routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-dang', 5660);
    const keep = join(t.stateDir, 'keep');
    mkdirSync(keep);
    writeFileSync(join(keep, 'x'), '1');
    const cases = [
      ['dangling', join(t.stateDir, 'nowhere')],
      ['self-looping', 'routes.lock'],
      ['to a real directory', keep],
    ];
    let port = 5661;
    for (const [what, to] of cases) {
      symlinkSync(to, lockPath);
      const t0 = Date.now();
      assert.equal((await p.addAlias(`n1-dang${port}`, port)).port, port, what);
      assert.ok(Date.now() - t0 < 2000, `${what}: no spin (${Date.now() - t0} ms)`);
      assert.equal(hasLock(), false, `${what}: link removed, lock released`);
      port += 1;
    }
    assert.equal(readFileSync(join(keep, 'x'), 'utf8'), '1', 'only the link was removed, never its target');

    const before = readFileSync(join(t.stateDir, 'routes.json'));
    symlinkSync(join(t.stateDir, 'nowhere'), lockPath);
    chflagsTemp('uchg', t.stateDir, t.stateDir);
    try {
      const t0 = Date.now();
      await rejectsRoutes(p.addAlias('n1-dangl', 5670), 'ROUTES_LOCKED', { path: t.stateDir, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.ok(Date.now() - t0 < 2000, `failed fast, not TIMEOUT (${Date.now() - t0} ms)`);
      assert.ok(fs.lstatSync(lockPath).isSymbolicLink(), 'left as found');
    } finally {
      chflagsTemp('nouchg', t.stateDir, t.stateDir);
    }
    fs.chmodSync(t.stateDir, 0o555);
    try {
      const t0 = Date.now();
      await rejectsRoutes(p.addAlias('n1-dangl', 5670), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', owner: ME, ownedByYou: true });
      assert.ok(Date.now() - t0 < 2000, `failed fast (${Date.now() - t0} ms)`);
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
    }
    assert.deepEqual(readFileSync(join(t.stateDir, 'routes.json')), before);
    assert.equal((await p.addAlias('n1-dangl', 5670)).port, 5670);
    assert.equal(hasLock(), false);
  });

  test('F4: a state folder that doesn’t exist yet is judged on its nearest existing parent (flag, writability, owner)', E13_T, async () => {
    const t = await freshEnv();
    const sub = join(t.stateDir, 'not', 'yet');
    const p = createPortless({ env: { ...t.env, PORTLESS_STATE_DIR: sub }, safeMode: true });
    chflagsTemp('uchg', t.stateDir, t.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess(), { locked: true, flag: 'uchg', target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true });
      await rejectsRoutes(p.addAlias('n1-miss', 5675), 'ROUTES_LOCKED', { path: t.stateDir, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.deepEqual(readdirSync(t.stateDir), [], 'nothing created');
    } finally {
      chflagsTemp('nouchg', t.stateDir, t.stateDir);
    }
    fs.chmodSync(t.stateDir, 0o555);
    try {
      await rejectsRoutes(p.addAlias('n1-miss', 5675), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', owner: ME, ownedByYou: true }); // an existing path, never the missing one
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), { locked: false, flag: null, target: 'folder', writable: false, path: t.stateDir, owner: ME, ownedByYou: true });
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
    }
    assert.equal((await p.addAlias('n1-miss', 5675)).port, 5675, 'created once allowed');
    assert.ok(existsSync(join(sub, 'routes.json')));
  });

  test('F5: a stale routes.lock that can’t be removed is reported on routes.lock (or the entry inside it), not on the folder', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-stale', 5680);
    const before = readFileSync(routesPath);
    const old = new Date(Date.now() - 60000);
    const makeStale = () => fs.utimesSync(lockPath, old, old);

    mkdirSync(lockPath);
    makeStale();
    chflagsTemp('uchg', lockPath, t.stateDir);
    try {
      const t0 = Date.now();
      await rejectsRoutes(p.addAlias('n1-s1', 5681), 'ROUTES_LOCKED', { path: lockPath, flag: 'uchg', target: 'folder', owner: ME, ownedByYou: true });
      assert.ok(Date.now() - t0 < 3000, `failed fast (${Date.now() - t0} ms)`);
    } finally {
      chflagsTemp('nouchg', lockPath, t.stateDir);
    }

    const inner = join(lockPath, 'held');
    writeFileSync(inner, 'x');
    makeStale();
    chflagsTemp('uchg', inner, t.stateDir);
    try {
      await rejectsRoutes(p.addAlias('n1-s1', 5681), 'ROUTES_LOCKED', { path: inner, flag: 'uchg', target: 'file', owner: ME, ownedByYou: true });
    } finally {
      chflagsTemp('nouchg', inner, t.stateDir);
    }

    fs.chmodSync(lockPath, 0o555);
    makeStale();
    try {
      await rejectsRoutes(p.addAlias('n1-s1', 5681), 'ROUTES_NOT_WRITABLE', { path: lockPath, target: 'folder', owner: ME, ownedByYou: true });
    } finally {
      fs.chmodSync(lockPath, 0o755);
    }
    assert.deepEqual(readFileSync(routesPath), before);
    makeStale();
    assert.equal((await p.addAlias('n1-s1', 5681)).port, 5681, 'stale lock broken once removable');
    assert.equal(existsSync(lockPath), false);
  });

  /** The `routes-not-writable` / `routes-locked` banner details N3 builds from getRoutesAccess() (D53). */
  function bannerDetails(a) {
    return a.locked
      ? { path: a.path, flag: a.flag, target: a.target, owner: a.owner, ownedByYou: a.ownedByYou }
      : { path: a.path, target: a.target, owner: a.owner, ownedByYou: a.ownedByYou };
  }

  /** A refused write and a forced re-read agree exactly: same code family, same details (D53). */
  async function agrees(p, write, code, details) {
    await rejectsRoutes(write, code, details);
    const a = await p.getRoutesAccess({ refresh: true });
    assert.equal(a.locked, code === 'ROUTES_LOCKED');
    assert.equal(a.writable, false);
    assert.deepEqual(bannerDetails(a), details, 'banner details = error details');
  }

  test('validation 6 F1: `target` for every not-writable path (file, folder, both, missing dir, dangling link); banner details = error details', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-tgt', 5690);
    const mine = { owner: ME, ownedByYou: true };
    try {
      fs.chmodSync(routesPath, 0o444);
      await agrees(p, p.addAlias('n1-tgt2', 5691), 'ROUTES_NOT_WRITABLE', { path: routesPath, target: 'file', ...mine });
      fs.chmodSync(t.stateDir, 0o555);
      await agrees(p, p.changePort('n1-tgt', 5692), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', ...mine });
      fs.chmodSync(routesPath, 0o644);
      await agrees(p, p.removeAlias('n1-tgt'), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', ...mine });
      // A state dir that doesn't exist yet: its nearest existing parent, a folder.
      const q = createPortless({ env: { ...t.env, PORTLESS_STATE_DIR: join(t.stateDir, 'not', 'yet') }, safeMode: true });
      await agrees(q, q.addAlias('n1-tgt3', 5693), 'ROUTES_NOT_WRITABLE', { path: t.stateDir, target: 'folder', ...mine });
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
      fs.chmodSync(routesPath, 0o644);
    }
    // A folder reached through a symlink is still a folder (stat, not lstat).
    const holder = await freshEnv();
    const link = join(holder.stateDir, 'state-link');
    symlinkSync(t.stateDir, link);
    const l = createPortless({ env: { ...t.env, PORTLESS_STATE_DIR: link }, safeMode: true });
    fs.chmodSync(t.stateDir, 0o555);
    try {
      await agrees(l, l.addAlias('n1-tgt4', 5694), 'ROUTES_NOT_WRITABLE', { path: link, target: 'folder', ...mine });
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
    }
    // A dangling routes.json link (stubbed refusal): still a file, never null.
    const d = await freshEnv();
    const dangling = join(d.stateDir, 'routes.json');
    symlinkSync(join(d.stateDir, 'nowhere.json'), dangling);
    const dp = createPortless({
      env: d.env, safeMode: true,
      wrapStore: (store) => { store.save = async () => { throw Object.assign(new Error(`EACCES: permission denied, open '${dangling}'`), { code: 'EACCES', path: dangling }); }; return store; },
    });
    await rejectsRoutes(dp.addAlias('n1-tgt5', 5695), 'ROUTES_NOT_WRITABLE', { path: dangling, target: 'file', owner: null, ownedByYou: null });
  });

  test('validation 6 F2: a stale routes.lock that can’t be removed shows in getRoutesAccess, before and after the refused write', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-sl', 5696);
    const before = readFileSync(routesPath);
    const old = new Date(Date.now() - 60000);
    const makeStale = () => fs.utimesSync(lockPath, old, old);
    const mine = { owner: ME, ownedByYou: true };

    // 1. A locked, empty stale lock dir → locked, folder (the validator's repro).
    mkdirSync(lockPath);
    makeStale();
    chflagsTemp('uchg', lockPath, t.stateDir);
    try {
      const want = { path: lockPath, flag: 'uchg', target: 'folder', ...mine };
      assert.deepEqual(bannerDetails(await p.getRoutesAccess({ refresh: true })), want, 'seen before any write');
      await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_LOCKED', want);
    } finally {
      chflagsTemp('nouchg', lockPath, t.stateDir);
    }

    // 2. A locked file inside it → locked, that file.
    const inner = join(lockPath, 'held');
    writeFileSync(inner, 'x');
    makeStale();
    chflagsTemp('uchg', inner, t.stateDir);
    try {
      await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_LOCKED', { path: inner, flag: 'uchg', target: 'file', ...mine });
    } finally {
      chflagsTemp('nouchg', inner, t.stateDir);
    }

    // 3. Read-only (0555) and not empty → not writable, the lock folder.
    fs.chmodSync(lockPath, 0o555);
    makeStale();
    try {
      await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_NOT_WRITABLE', { path: lockPath, target: 'folder', ...mine });
      // 4. Write order with a flag elsewhere: any flag first (routes.json), then the lock.
      chflagsTemp('uchg', routesPath, t.stateDir);
      try {
        await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_LOCKED', { path: routesPath, flag: 'uchg', target: 'file', ...mine });
      } finally {
        chflagsTemp('nouchg', routesPath, t.stateDir);
      }
      makeStale();
      await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_NOT_WRITABLE', { path: lockPath, target: 'folder', ...mine });
    } finally {
      fs.chmodSync(lockPath, 0o755);
    }
    rmSync(lockPath, { recursive: true, force: true });

    // 5. A stale lock that IS a locked regular file → locked, file.
    writeFileSync(lockPath, '');
    chflagsTemp('uchg', lockPath, t.stateDir);
    try {
      await agrees(p, p.addAlias('n1-sl1', 5697), 'ROUTES_LOCKED', { path: lockPath, flag: 'uchg', target: 'file', ...mine });
    } finally {
      chflagsTemp('nouchg', lockPath, t.stateDir);
    }
    rmSync(lockPath, { force: true });
    assert.deepEqual(readFileSync(routesPath), before, 'nothing changed while blocked');

    // Removable stale locks never block: empty 0555 / 0000 dirs, and a fresh (held) lock is never judged.
    for (const mode of [0o555, 0o000]) {
      mkdirSync(lockPath);
      fs.chmodSync(lockPath, mode);
      makeStale();
      try {
        assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath), `empty ${mode.toString(8)} stale lock is removable`);
      } finally {
        fs.chmodSync(lockPath, 0o755);
      }
      fs.chmodSync(lockPath, mode);
      try {
        assert.equal((await p.addAlias(`n1-sl-${mode}`, 5698 + (mode ? 0 : 1))).hostname, `n1-sl-${mode}.local`, 'and the write removes it');
      } finally {
        if (existsSync(lockPath)) fs.chmodSync(lockPath, 0o755);
      }
      assert.equal(existsSync(lockPath), false);
    }
    // A fresh, empty lock is what a writer holds: never judged, even with a flag on it.
    // (Since validation 7 F1 a lock with entries is stale at any age: see the next test.)
    mkdirSync(lockPath);
    chflagsTemp('uchg', lockPath, t.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath), 'a fresh lock is just held by a writer');
    } finally {
      chflagsTemp('nouchg', lockPath, t.stateDir);
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

  test('validation 6 F3: an owner lookup that throws never hides the blocking path or leaks a raw Error', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    writeFileSync(routesPath, '[]');
    fs.chmodSync(routesPath, 0o444);
    const noName = { readFileFlags: async () => null }; // the probe failed (e.g. a stat timeout): no owner name
    const passwdGone = () => Object.assign(new Error('ENOENT: no such file or directory, uv_os_get_passwd'), { code: 'ENOENT' });
    const want = { path: routesPath, target: 'file', owner: null, ownedByYou: true };
    const realUserInfo = osModule.userInfo;
    try {
      // The injected user's name throws.
      const user = { uid: process.getuid(), gid: process.getgid(), homedir: userInfo().homedir, get username() { throw passwdGone(); } };
      const p = createPortless({ env: t.env, safeMode: true, user, probe: noName });
      assert.deepEqual(await p.getRoutesAccess(), { locked: false, flag: null, target: 'file', writable: false, path: routesPath, owner: null, ownedByYou: true });
      await rejectsRoutes(p.addAlias('n1-pw', 5699), 'ROUTES_NOT_WRITABLE', want);
      // os.userInfo() itself throws (a uid with no passwd entry).
      // (Not in safe mode: its own real-state check fails closed on a throwing lookup, by design.
      // The state dir is still this test's temp dir.)
      osModule.userInfo = () => { throw passwdGone(); };
      const q = createPortless({ env: t.env, probe: noName });
      assert.deepEqual(bannerDetails(await q.getRoutesAccess()), want);
      await rejectsRoutes(q.addAlias('n1-pw', 5699), 'ROUTES_NOT_WRITABLE', want);
    } finally {
      osModule.userInfo = realUserInfo;
      fs.chmodSync(routesPath, 0o644);
    }
    assert.equal(readFileSync(routesPath, 'utf8'), '[]');
  });

  test('validation 6 F4: unlockAll() re-checks each path and never follows a folder swapped for a link', E13_T, async () => {
    const t = await freshEnv();
    const outside = await freshEnv(); // another of our temp dirs, NOT registered with the helper
    const state = join(realpathSync(t.stateDir), 'state');
    mkdirSync(state);
    const f = join(state, 'f'); // resolved, as the helper stores it
    writeFileSync(f, 'mine');
    const victim = join(outside.stateDir, 'f');
    writeFileSync(victim, 'victim');
    const flagOf = async (x) => (await readFileFlags(x)).flag;
    chflagsTemp('uchg', f, t.stateDir);
    // Set directly (own temp dir), so the helper doesn't know it; cleared in finally.
    execFileSync('/usr/bin/chflags', ['uchg', victim], { timeout: 5000 });
    try {
      fs.renameSync(state, join(t.stateDir, 'state-old')); // allowed: the folder itself isn't flagged
      symlinkSync(outside.stateDir, state);
      unlockAll();
      assert.equal(await flagOf(victim), 'uchg', 'the flag behind the swapped link is left alone');
      assert.equal(await flagOf(join(t.stateDir, 'state-old', 'f')), null, 'the moved original is cleared by the recursive pass on our root');
      assert.ok(e13Flagged.has(f), 'the refused path stays listed (the suite’s size check reports it)');
      // Put things back: the stored path is valid again and is cleared normally.
      fs.unlinkSync(state);
      fs.renameSync(join(t.stateDir, 'state-old'), state);
      unlockAll();
      assert.equal(e13Flagged.has(f), false);
    } finally {
      execFileSync('/usr/bin/chflags', ['nouchg', victim], { timeout: 5000 });
    }
    assert.equal(await flagOf(victim), null);
  });

  test('validation 7 F5: a routes.json that can’t be read (0222) is never read as []: listRoutes unreadable, every write refused, bytes unchanged', E13_T, async () => {
    for (const backend of REAL ? ['file', 'routestore'] : ['file']) {
      const t = await freshEnv();
      const routesPath = join(t.stateDir, 'routes.json');
      const p = createPortless({ env: t.env, safeMode: true, routeBackend: backend });
      await p.addAlias('keep1', 5701);
      await p.addAlias('keep2', 5702);
      const before = readFileSync(routesPath);
      const want = { path: routesPath, target: 'file', owner: ME, ownedByYou: true };
      fs.chmodSync(routesPath, 0o222);
      try {
        await rejectsCode(p.listRoutes(), 'STATE_UNREADABLE');
        const a = await p.getRoutesAccess({ refresh: true });
        assert.equal(a.writable, false, `${backend}: not writable before any write`);
        assert.deepEqual(bannerDetails(a), want, `${backend}: seen before any write`);
        const ops = [
          () => p.addAlias('new1', 5703),
          () => p.addAlias('keep1', 5704, { force: true }),
          () => p.changePort('keep1', 5705),
          () => p.renameAlias('keep1', 'keep3'),
          () => p.renameAlias('keep1', 'keep2', { force: true }),
          () => p.removeAlias('keep2'),
        ];
        for (const op of ops) await agrees(p, op(), 'ROUTES_NOT_WRITABLE', want);
      } finally {
        fs.chmodSync(routesPath, 0o644);
      }
      assert.deepEqual(readFileSync(routesPath), before, `${backend}: file byte-identical after 6 refused writes`);
      assert.deepEqual((await p.listRoutes()).map((r) => r.name), ['keep1', 'keep2']);
    }
  });

  test('validation 7 F5: a corrupt routes.json (or a folder in its place) refuses the write with STATE_UNREADABLE; a blank one is []', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const p = createPortless({ env: t.env, safeMode: true });
    for (const bad of ['{"broken', '{"hostname":"a.local","port":1,"pid":0}', '[{"hostname":"a.lo']) {
      writeFileSync(routesPath, bad);
      await assert.rejects(p.addAlias('n1-c1', 5710), (err) => {
        assert.ok(err instanceof PortlessError);
        assert.equal(err.code, 'STATE_UNREADABLE');
        assert.equal(err.details.path, routesPath);
        return true;
      });
      assert.equal(readFileSync(routesPath, 'utf8'), bad, 'never replaced');
    }
    rmSync(routesPath);
    mkdirSync(routesPath);
    await rejectsCode(p.addAlias('n1-c1', 5710), 'STATE_UNREADABLE');
    fs.rmdirSync(routesPath);
    writeFileSync(routesPath, '  \n');
    assert.equal((await p.addAlias('n1-c1', 5710)).port, 5710, 'a blank list has nothing to lose');
    assert.deepEqual((await p.listRoutes()).map((r) => r.name), ['n1-c1']);
    rmSync(routesPath);
    assert.equal((await p.addAlias('n1-c2', 5711)).port, 5711, 'a missing list is []');
  });

  test('validation 7 F1: a refused write’s partial rm doesn’t make the lock look fresh: the banner shows right after the 423, and the next write fails fast', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-pr', 5720);
    const before = readFileSync(routesPath);
    const old = new Date(Date.now() - 60000);
    const mine = { owner: ME, ownedByYou: true };
    const fresh = () => assert.ok(Date.now() - fs.lstatSync(lockPath).mtimeMs < 10000, 'the lock now looks fresh by its mtime');

    // 1. A locked entry plus a removable sibling.
    mkdirSync(lockPath);
    const held = join(lockPath, 'held');
    writeFileSync(held, 'x');
    writeFileSync(join(lockPath, 'sib'), 'y');
    fs.utimesSync(lockPath, old, old);
    chflagsTemp('uchg', held, t.stateDir);
    try {
      const want = { path: held, flag: 'uchg', target: 'file', ...mine };
      assert.deepEqual(bannerDetails(await p.getRoutesAccess({ refresh: true })), want, 'seen before any write');
      await agrees(p, p.addAlias('n1-pr1', 5721), 'ROUTES_LOCKED', want); // the forced re-read right after the 423
      assert.equal(existsSync(join(lockPath, 'sib')), false, 'the refused rm did delete the sibling');
      fresh();
      const t0 = Date.now();
      await agrees(p, p.addAlias('n1-pr1', 5721), 'ROUTES_LOCKED', want);
      assert.ok(Date.now() - t0 < 3000, `the next write didn't wait on a "fresh" lock (${Date.now() - t0} ms)`);
    } finally {
      chflagsTemp('nouchg', held, t.stateDir);
    }
    rmSync(lockPath, { recursive: true, force: true });

    // 2. A read-only subfolder with entries plus a removable file.
    mkdirSync(lockPath);
    const sub = join(lockPath, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'x'), '');
    writeFileSync(join(lockPath, 'sib'), '');
    fs.chmodSync(sub, 0o555);
    fs.utimesSync(lockPath, old, old);
    try {
      const want = { path: sub, target: 'folder', ...mine };
      assert.deepEqual(bannerDetails(await p.getRoutesAccess({ refresh: true })), want, 'seen before any write');
      await agrees(p, p.addAlias('n1-pr2', 5722), 'ROUTES_NOT_WRITABLE', want);
      fs.utimesSync(lockPath, new Date(), new Date()); // whatever the rm did, the lock is fresh by mtime now
      fresh();
      const t0 = Date.now();
      await agrees(p, p.addAlias('n1-pr2', 5722), 'ROUTES_NOT_WRITABLE', want);
      assert.ok(Date.now() - t0 < 3000, `fails fast (${Date.now() - t0} ms)`);
    } finally {
      fs.chmodSync(sub, 0o755);
    }
    assert.deepEqual(readFileSync(routesPath), before, 'nothing changed while blocked');
    assert.equal((await p.addAlias('n1-pr2', 5722)).port, 5722, 'the lock with entries is broken at once once removable');
    assert.equal(existsSync(lockPath), false);
  });

  test('validation 7 F2: a stale lock that a writer removes while getRoutesAccess looks at it is not reported', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-race', 5725);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'x'), '');
    fs.chmodSync(lockPath, 0o555);
    const realAccess = fs.promises.access;
    let broke = 0;
    try {
      assert.equal((await p.getRoutesAccess({ refresh: true })).path, lockPath, 'a blocker while it is there');
      // A concurrent writer breaks the stale lock between readdir and the R/W/X check.
      fs.promises.access = async function racing(target, mode) {
        if (String(target) === lockPath && existsSync(lockPath)) {
          fs.chmodSync(lockPath, 0o755);
          rmSync(lockPath, { recursive: true, force: true });
          broke += 1;
        }
        return realAccess.call(this, target, mode);
      };
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath), 'gone = not blocking');
      assert.equal(broke, 1, 'the race really happened inside the check');
    } finally {
      fs.promises.access = realAccess;
      if (existsSync(lockPath)) {
        fs.chmodSync(lockPath, 0o755);
        rmSync(lockPath, { recursive: true, force: true });
      }
    }
  });

  test('validation 7 F4: stale-lock rules — 0666/0000/0333 locks, the folder first, a symlink lock, and the write’s own failing entry', E13_T, async () => {
    const t = await freshEnv();
    const routesPath = join(t.stateDir, 'routes.json');
    const lockPath = join(t.stateDir, 'routes.lock');
    const p = createPortless({ env: t.env, safeMode: true });
    await p.addAlias('n1-rule', 5730);
    const before = readFileSync(routesPath);
    const old = new Date(Date.now() - 60000);
    const mine = { owner: ME, ownedByYou: true };
    const lockWith = (mode) => {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'x'), '');
      fs.utimesSync(lockPath, old, old);
      fs.chmodSync(lockPath, mode);
    };
    const dropLock = () => {
      if (existsSync(lockPath)) fs.chmodSync(lockPath, 0o755);
      rmSync(lockPath, { recursive: true, force: true });
    };

    // M2 (0666: R and W, no X) and M6 (0000 / 0333: can't be listed; APFS nlink > 2).
    for (const mode of [0o666, 0o000, 0o333]) {
      lockWith(mode);
      try {
        const want = { path: lockPath, target: 'folder', ...mine };
        assert.deepEqual(bannerDetails(await p.getRoutesAccess({ refresh: true })), want, `${mode.toString(8)}: seen before any write`);
        await agrees(p, p.addAlias('n1-r1', 5731), 'ROUTES_NOT_WRITABLE', want);
      } finally {
        dropLock();
      }
    }

    // M3: a read-only state folder AND a read-only stale lock: the folder comes first (write order).
    lockWith(0o555);
    fs.chmodSync(t.stateDir, 0o555);
    try {
      const want = { path: t.stateDir, target: 'folder', ...mine };
      assert.deepEqual(bannerDetails(await p.getRoutesAccess({ refresh: true })), want, 'folder first, before any write');
      await agrees(p, p.addAlias('n1-r1', 5731), 'ROUTES_NOT_WRITABLE', want);
    } finally {
      fs.chmodSync(t.stateDir, 0o700);
      dropLock();
    }

    // M8: the entry the write's rm failed on is beyond the scan cap, so only the write's own hint names it.
    // Every entry holds a locked file, so the partial rm can't shrink the lock back under the cap.
    mkdirSync(lockPath);
    const helds = [];
    for (let i = 0; i < 64; i += 1) {
      const d = join(lockPath, `d${String(i).padStart(2, '0')}`);
      mkdirSync(d);
      writeFileSync(join(d, 'held'), 'x');
      helds.push(join(d, 'held'));
    }
    for (const h of helds) chflagsTemp('uchg', h, t.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath), 'beyond the scan cap: the read can’t see it (documented limit)');
      await assert.rejects(p.addAlias('n1-r1', 5731), (err) => {
        assert.ok(err instanceof PortlessError);
        assert.equal(err.code, 'ROUTES_LOCKED', `the hint names the locked entry, got ${err.code} ${JSON.stringify(err.details)}`);
        assert.ok(helds.includes(err.details.path), err.details.path);
        assert.deepEqual(err.details, { path: err.details.path, flag: 'uchg', target: 'file', ...mine });
        return true;
      });
      assert.equal(readdirSync(lockPath).length, 64, 'the rm removed nothing');
    } finally {
      for (const h of helds) chflagsTemp('nouchg', h, t.stateDir);
    }
    dropLock();
    assert.deepEqual(readFileSync(routesPath), before, 'nothing changed while blocked');

    // M4: a stale routes.lock that is a symlink to a locked folder: the write only unlinks the link.
    const elsewhere = join(t.stateDir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep'), 'k');
    symlinkSync(elsewhere, lockPath);
    chflagsTemp('uchg', elsewhere, t.stateDir);
    try {
      assert.deepEqual(await p.getRoutesAccess({ refresh: true }), UNLOCKED_ACCESS(routesPath), 'the flag behind the link doesn’t block');
      assert.equal((await p.addAlias('n1-r2', 5732)).port, 5732, 'and the write succeeds');
      assert.equal(existsSync(lockPath), false, 'the link was unlinked, its target untouched');
      assert.equal(readFileSync(join(elsewhere, 'keep'), 'utf8'), 'k');
      assert.equal((await readFileFlags(elsewhere)).flag, 'uchg');
    } finally {
      chflagsTemp('nouchg', elsewhere, t.stateDir);
    }
  });

  test('validation 7 F3: temp-flags refuses a hard-linked file, to set and to clear; its recursive pass skips it', E13_T, async () => {
    const t = await freshEnv();
    const outside = await freshEnv(); // another of our temp dirs, NOT registered with the helper: stands in for a file elsewhere
    const root = realpathSync(t.stateDir);
    const victim = join(realpathSync(outside.stateDir), 'routes.json');
    writeFileSync(victim, 'victim');
    const flagOf = async (x) => (await readFileFlags(x)).flag;
    // Set: a hard link to the victim inside our root.
    const link = join(root, 'routes.json');
    fs.linkSync(victim, link);
    assert.throws(() => chflagsTemp('uchg', link, t.stateDir), /hard-linked/);
    assert.equal(await flagOf(victim), null, 'no flag reached the outside inode');
    assert.equal(e13Flagged.has(link), false);
    fs.unlinkSync(link);
    // Clear: validation 6's swap, with a hard link instead of a symlink.
    const state = join(root, 'state');
    mkdirSync(state);
    const f = join(state, 'f');
    writeFileSync(f, 'mine');
    chflagsTemp('uchg', f, t.stateDir);
    try {
      fs.renameSync(state, join(root, 'state-old'));
      mkdirSync(state);
      fs.linkSync(victim, f);
      execFileSync('/usr/bin/chflags', ['uchg', victim], { timeout: 5000 }); // after linking: a uchg file can't be linked
      assert.throws(() => chflagsTemp('nouchg', f, t.stateDir), /hard-linked/);
      unlockAll();
      assert.equal(await flagOf(victim), 'uchg', 'neither the per-path clear nor the recursive pass touched the outside inode');
      assert.equal(await flagOf(join(root, 'state-old', 'f')), null, 'the moved original is cleared by the recursive pass');
      assert.ok(e13Flagged.has(f), 'the refused path stays listed (the suite’s size check reports it)');
      // Put things back: the stored path is the original again and clears normally.
      execFileSync('/usr/bin/chflags', ['nouchg', victim], { timeout: 5000 });
      fs.unlinkSync(f);
      fs.rmdirSync(state);
      fs.renameSync(join(root, 'state-old'), state);
      unlockAll();
      assert.equal(e13Flagged.has(f), false);
    } finally {
      execFileSync('/usr/bin/chflags', ['nouchg', victim], { timeout: 5000 });
    }
    assert.equal(await flagOf(victim), null);
  });

  test('cache: one probe per path per 2 s, shared by concurrent callers, dropped after a successful write', E13_T, async () => {
    const t = await freshEnv();
    const { calls, probe } = realFlagsProbe();
    const p = createPortless({ env: t.env, safeMode: true, probe });
    await p.addAlias('n1-cache', 5640);
    calls.length = 0;
    const [a, b, c] = await Promise.all([p.getRoutesAccess(), p.getRoutesAccess(), p.getRoutesAccess()]);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    const perCall = calls.length;
    assert.equal(perCall, 2, 'file + folder, once');
    await p.getRoutesAccess();
    assert.equal(calls.length, perCall, 'cached');
    a.locked = true; // callers get copies
    assert.equal((await p.getRoutesAccess()).locked, false);
    await p.changePort('n1-cache', 5641);
    await p.getRoutesAccess();
    assert.equal(calls.length, 2 * perCall, 'a route write invalidates the cache');
    await p.getRoutesAccess({ refresh: true });
    assert.equal(calls.length, 3 * perCall);
  });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
