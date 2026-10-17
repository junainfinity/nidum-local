// Mock Nidum Local API for N4 (and N3's own tests).
//
// The real server (src/server.js + src/api.js) running on in-memory fakes of
// the Portless adapter, discovery and network, so the UI sees exactly the
// contract shapes (Contracts §4) without touching Portless.
//
//   node test/helpers/mock-api.js [--scenario mac-service|manual-https|stopped|empty|routes-locked|routes-locked-schg] [--port N]
//
// prints the URL with the token. Programmatic use:
//
//   const mock = await startMockApi({ scenario: 'manual-https' });
//   mock.url, mock.tokenUrl, mock.token, mock.adapter (fake: .proxy, .routes, .failNext(), .calls)
//   await mock.close();
//
// E13 (locked address list): scenarios `routes-locked` (uchg on routes.json) and
// `routes-locked-schg` (schg on routes.json) are `mac-service` with a locked list:
// every route write throws the real PortlessError('ROUTES_LOCKED', …, { raw, details })
// and getRoutesAccess() matches. In every scenario the lock can be flipped at runtime:
//   mock.adapter.unlockRoutes()                     // the user unlocked it; "Check again" sees it
//   mock.adapter.lockRoutes({ flag: 'uchg', target: 'file' | 'folder', owner: 'me', ownedByYou: true })
//   mock.adapter.setRoutesWritable(false, { owner: 'root', ownedByYou: false, target: 'file' })   // ROUTES_NOT_WRITABLE
// D51/D53: answers and errors carry the blocking path's `owner` and `ownedByYou`.
// A lock defaults to `owner: 'me', ownedByYou: true` (the user's own file, as on this
// Mac); for not writable `ownedByYou` defaults to `owner === 'me'` (null without an owner).
// Both error kinds carry `details: { path, flag?, target, owner, ownedByYou }`, equal to
// the banner `details`.
//
// Every fake is also exported for unit tests.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PortlessError, TLD, formatUrl, parseDoctor, toRoute, validateName, validatePort } from '../../src/portless.js';
import { startServer } from '../../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR_TEXT = (() => {
  try {
    return readFileSync(join(HERE, '..', 'fixtures', 'portless', 'doctor-service.txt'), 'utf8');
  } catch {
    return 'ok      Proxy is running\nSummary: 0 failures, 0 warnings.\n';
  }
})();

/** Discovery fixture (Contracts §3 service objects). */
export const FIXTURE_SERVICES = Object.freeze([
  { port: 3000, pid: 4101, process: 'node', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: '/Users/me/code/dashboard', command: 'node server.js', http: { status: 200, title: 'Dashboard', server: null, framework: 'Express', redirectsTo: null, tls: false }, hidden: null, suggestedName: 'dashboard' },
  { port: 5173, pid: 4821, process: 'node', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: '/Users/me/code/recipes', command: 'node vite', http: { status: 200, title: 'Recipes', server: null, framework: 'Vite', redirectsTo: null, tls: false }, hidden: null, suggestedName: 'recipes' },
  { port: 8888, pid: 913, process: 'python3', user: 'me', addresses: ['0.0.0.0'], reach: 'network', cwd: '/Users/me/notebooks', command: 'jupyter lab', http: { status: 302, title: 'Jupyter Server', server: 'TornadoServer/6.4', framework: 'Jupyter', redirectsTo: '/lab', tls: false }, hidden: null, suggestedName: 'notebooks' },
  { port: 4000, pid: 777, process: 'node', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: '/Users/me/code/list', command: 'node index.js', http: { status: 200, title: 'List', server: null, framework: null, redirectsTo: null, tls: false }, hidden: null, suggestedName: 'list' },
  { port: 5432, pid: 201, process: 'postgres', user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd: null, command: 'postgres -D /usr/local/var/postgres', http: null, hidden: null, suggestedName: 'postgres' },
  { port: 6000, pid: null, process: null, user: null, addresses: ['0.0.0.0'], reach: 'network', cwd: null, command: null, http: { status: 404, title: null, server: null, framework: null, redirectsTo: null, tls: false }, hidden: null, suggestedName: 'app-6000' },
  { port: 5000, pid: 701, process: 'ControlCenter', user: 'me', addresses: ['0.0.0.0', '::'], reach: 'network', cwd: '/', command: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter', http: { status: 403, title: null, server: 'AirTunes/980.77.5', framework: null, redirectsTo: null, tls: false }, hidden: 'os-service', suggestedName: 'controlcenter' },
]);

/** Network fixtures. */
export const FIXTURE_NETWORKS = Object.freeze({
  ethernet: { ip: '192.168.68.119', interface: 'en11', kind: 'ethernet', ssid: null, interfaces: [{ name: 'en11', ip: '192.168.68.119', kind: 'ethernet' }, { name: 'utun4', ip: '100.64.0.1', kind: 'other' }] },
  wifi: { ip: '192.168.1.42', interface: 'en0', kind: 'wifi', ssid: 'HomeWiFi', interfaces: [{ name: 'en0', ip: '192.168.1.42', kind: 'wifi' }] },
  guest: { ip: '10.0.0.23', interface: 'en0', kind: 'wifi', ssid: 'Hotel Guest', interfaces: [{ name: 'en0', ip: '10.0.0.23', kind: 'wifi' }] },
  none: { ip: null, interface: null, kind: 'none', ssid: null, interfaces: [] },
});

const SCENARIOS = {
  // This Mac: root launchd service, :80, HTTP, LAN (Contracts §5 example).
  'mac-service': {
    proxy: { running: true, pid: 12825, port: 80, tls: false, lan: true, lanIp: '192.168.68.119', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'service' },
    service: { stateDir: '/Users/me/.portless', port: 80, tls: false, lan: true, fixedIp: null, tlds: ['local'], wildcard: false },
    routes: [
      { hostname: 'plex.local', port: 32400, pid: 0 },
      { hostname: 'jupyter.local', port: 8888, pid: 0 },
      { hostname: 'shop.local', port: 4312, pid: 4312 },
      { hostname: 'old.localhost', port: 9000, pid: 0 },
    ],
    network: 'ethernet',
  },
  'manual-https': {
    proxy: { running: true, pid: 3333, port: 443, tls: true, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'manual' },
    service: null,
    routes: [
      { hostname: 'recipes.local', port: 5173, pid: 0 },
      { hostname: 'dashboard.local', port: 3000, pid: 0 },
    ],
    names: ['recipes'],
    network: 'wifi',
  },
  stopped: {
    proxy: { running: false, pid: null, port: 443, tls: true, lan: false, lanIp: null, tlds: ['local'], wildcard: null, elevated: false, managedBy: null },
    service: null,
    routes: [{ hostname: 'recipes.local', port: 5173, pid: 0 }],
    network: 'wifi',
  },
  empty: {
    proxy: { running: true, pid: 3333, port: 80, tls: false, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'manual' },
    service: null,
    routes: [],
    network: 'guest',
    services: [],
  },
};
// This Mac before D46: the service setup with routes.json locked (Finder "Locked" = uchg).
SCENARIOS['routes-locked'] = { ...SCENARIOS['mac-service'], stateDir: '/Users/me/.portless', routesLock: { flag: 'uchg', target: 'file' } };
// The same with the system immutable flag (only root can clear it).
SCENARIOS['routes-locked-schg'] = { ...SCENARIOS['mac-service'], stateDir: '/Users/me/.portless', routesLock: { flag: 'schg', target: 'file' } };
for (const name of ['mac-service', 'routes-locked', 'routes-locked-schg']) SCENARIOS[name].passwordDelayMs = 250;

/** Names of the built-in scenarios. */
export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

const HANG = Symbol('hang');

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * In-memory fake of N1's adapter (same surface as createPortless()).
 * Conflict rules match N1: alias → NAME_TAKEN unless force; app → NAME_TAKEN_BY_APP even with force.
 *
 * @param {object} [o]
 * @param {object} [o.proxy]  ProxyState minus baseUrl
 * @param {object | null} [o.service]  own service config (getServiceConfig) or null
 * @param {Array<{hostname: string, port: number, pid: number}>} [o.routes]
 * @param {object | null} [o.portless]  findPortless() result; null = not installed
 * @param {string} [o.stateDir]
 * @param {number} [o.delayMs]  delay every async call
 * @param {(what: string) => Promise<void> | void} [o.onElevate]  called where the real adapter would show a password dialog
 * @param {{ flag?: 'uchg' | 'schg', target?: 'file' | 'folder', owner?: string | null, ownedByYou?: boolean | null } | null} [o.routesLock]  E13: routes.json (or its folder) is locked; owner defaults to 'me' (ownedByYou true)
 * @param {boolean} [o.routesWritable]  E13: false = not writable for another reason (ROUTES_NOT_WRITABLE); default true
 * @param {string | null} [o.routesOwner]  E13: owner reported when not writable
 * @param {boolean | null} [o.routesOwnedByYou]  D51: defaults to `routesOwner === 'me'` (null without an owner)
 * @param {'file' | 'folder'} [o.routesTarget]  D53: which path is not writable (default 'file')
 * @param {number} [o.routesAccessDelayMs]  E13: extra delay of getRoutesAccess() (a slow `stat`)
 */
/** D51: `ownedByYou` when not given: the mock user is 'me'; unknown without an owner. */
function ownedDefault(owner, ownedByYou) {
  if (ownedByYou === true || ownedByYou === false) return ownedByYou;
  if (ownedByYou === null) return null;
  return owner ? owner === 'me' : null;
}

/** E13/D51: a lock record; the locked path is the user's own unless said otherwise. */
function makeLock({ flag = 'uchg', target = 'file', owner = 'me', ownedByYou } = {}) {
  return { flag: flag === 'schg' ? 'schg' : 'uchg', target: target === 'folder' ? 'folder' : 'file', owner: owner ?? null, ownedByYou: ownedDefault(owner ?? null, ownedByYou) };
}

export function createFakeAdapter(o = {}) {
  const calls = [];
  const failures = new Map(); // method → [errors]
  const fake = {
    safeMode: false,
    proxy: clone(o.proxy) || clone(SCENARIOS['manual-https'].proxy),
    service: o.service === undefined ? null : clone(o.service),
    routes: clone(o.routes) || [],
    portless: o.portless === undefined ? { binPath: '/fake/portless/dist/cli.js', launcherPath: '/fake/bin/portless', packageRoot: '/fake/portless', version: '0.15.6', nodePath: process.execPath } : o.portless,
    calls,
    delayMs: o.delayMs ?? 0,
    onElevate: o.onElevate || null,
    /** How long each fake password dialog stays up (the job shows waitingForPassword meanwhile). */
    passwordDelayMs: o.passwordDelayMs ?? 0,
    /** Set by startMockApi: the app whose elevationStarted/Ended the fake calls. */
    app: null,
    doctorText: o.doctorText ?? DOCTOR_TEXT,
    /** Make the next call of `method` reject with `err` (queue). */
    failNext(method, err) {
      if (!failures.has(method)) failures.set(method, []);
      failures.get(method).push(err);
      return fake;
    },
    /** Make the next call of `method` never settle (a hung dependency). */
    hangNext(method) {
      return fake.failNext(method, HANG);
    },
    /** E13: the lock on routes.json (`{ flag, target }`) or null. */
    routesLock: o.routesLock ? makeLock(o.routesLock) : null,
    /** E13: false = the list can't be written for another reason (wrong owner, read-only mode bits). */
    routesWritable: o.routesWritable !== false,
    routesOwner: o.routesWritable === false ? (o.routesOwner ?? null) : null,
    routesOwnedByYou: o.routesWritable === false ? ownedDefault(o.routesOwner ?? null, o.routesOwnedByYou) : null,
    routesTarget: o.routesTarget === 'folder' ? 'folder' : 'file',
    routesAccessDelayMs: o.routesAccessDelayMs ?? 0,
    /** E13: lock the address list at runtime (default: uchg on the file, owned by you). */
    lockRoutes(lock = {}) {
      fake.routesLock = makeLock(lock);
      return fake;
    },
    /** E13: the user cleared the flag (and the list is writable again). */
    unlockRoutes() {
      fake.routesLock = null;
      fake.routesWritable = true;
      fake.routesOwner = null;
      fake.routesOwnedByYou = null;
      return fake;
    },
    /**
     * E13: not writable without a flag (ROUTES_NOT_WRITABLE). `owner` = the account that owns
     * the blocking path; `ownedByYou` (D51) defaults to `owner === 'me'`, null without an owner;
     * `target` (D53) = which path blocks, 'file' (default) or 'folder'.
     */
    setRoutesWritable(writable, { owner = null, ownedByYou, target = 'file' } = {}) {
      fake.routesWritable = Boolean(writable);
      fake.routesOwner = writable ? null : owner;
      fake.routesOwnedByYou = writable ? null : ownedDefault(owner, ownedByYou);
      fake.routesTarget = target === 'folder' ? 'folder' : 'file';
      return fake;
    },
  };

  async function step(method, args) {
    calls.push({ method, args: clone(args) });
    if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
    const q = failures.get(method);
    if (q && q.length) {
      const e = q.shift();
      if (e === HANG) await new Promise(() => {});
      throw e;
    }
  }

  // Where the real adapter shows the OS password dialog: tell the app (startMockApi
  // sets `fake.app`) so jobs pass through `waitingForPassword`, then run `onElevate`.
  async function elevated(what) {
    fake.app?.elevationStarted?.();
    try {
      if (fake.onElevate) await fake.onElevate(what);
      // the fake password dialog stays up this long (waitingForPassword lasts it)
      if (fake.passwordDelayMs) await new Promise((r) => setTimeout(r, fake.passwordDelayMs));
    } finally {
      fake.app?.elevationEnded?.();
    }
  }

  const ctx = () => ({ port: fake.proxy.port, tls: fake.proxy.tls });
  const find = (hostname) => fake.routes.find((r) => r.hostname === hostname);
  const routesDir = () => fake.stateDir();
  const routesFile = () => `${routesDir()}/routes.json`;

  /** E13 (D51): the same answer shape as N1's getRoutesAccess(), key order included. */
  function routesAccessNow() {
    const lock = fake.routesLock;
    if (lock) return { locked: true, flag: lock.flag, target: lock.target, writable: false, path: lock.target === 'folder' ? routesDir() : routesFile(), owner: lock.owner, ownedByYou: lock.ownedByYou };
    if (!fake.routesWritable) {
      const target = fake.routesTarget;
      return { locked: false, flag: null, target, writable: false, path: target === 'folder' ? routesDir() : routesFile(), owner: fake.routesOwner ?? null, ownedByYou: fake.routesOwnedByYou ?? null };
    }
    return { locked: false, flag: null, target: null, writable: true, path: routesFile(), owner: null, ownedByYou: null };
  }

  /**
   * E13: a route write the OS refuses, as N1 raises it (after the precondition checks).
   * D53: `details` are `{ path, flag?, target, owner, ownedByYou }`, equal to the banner's.
   */
  function refuseWriteIfBlocked() {
    const a = routesAccessNow();
    if (a.locked) {
      const raw = a.target === 'folder' ? `EPERM: operation not permitted, mkdir '${routesDir()}/routes.lock'` : `EPERM: operation not permitted, open '${routesFile()}'`;
      throw new PortlessError('ROUTES_LOCKED', undefined, { raw, details: { path: a.path, flag: a.flag, target: a.target, owner: a.owner, ownedByYou: a.ownedByYou } });
    }
    if (!a.writable) {
      const raw = a.target === 'folder' ? `EACCES: permission denied, mkdir '${routesDir()}/routes.lock'` : `EACCES: permission denied, open '${routesFile()}'`;
      throw new PortlessError('ROUTES_NOT_WRITABLE', undefined, { raw, details: { path: a.path, target: a.target, owner: a.owner, ownedByYou: a.ownedByYou } });
    }
  }

  Object.assign(fake, {
    stateDir: () => o.stateDir || '/fake/.portless',
    findPortless: () => fake.portless,
    validateName,
    getServiceConfig: () => clone(fake.service),
    async getProxyState() {
      await step('getProxyState', []);
      const p = clone(fake.proxy);
      if (fake.service && p.managedBy !== 'service') p.managedBy = 'service';
      // E12: managedBy stays 'service' while the service file exists, even when stopped
      p.serviceLoaded = fake.service ? (typeof p.serviceLoaded === 'boolean' ? p.serviceLoaded : Boolean(p.running)) : false;
      return { ...p, baseUrl: `${p.tls ? 'https' : 'http'}://127.0.0.1:${p.port}` };
    },
    async listRoutes({ proxy } = {}) {
      await step('listRoutes', []);
      const c = proxy && Number.isInteger(proxy.port) ? proxy : ctx();
      return fake.routes.map((r) => toRoute(r, c)).sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
    },
    async addAlias(name, port, { force = false } = {}) {
      await step('addAlias', [name, port, { force }]);
      const n = validateName(name);
      const p = validatePort(port);
      const hostname = `${n}.${TLD}`;
      const existing = find(hostname);
      if (existing && existing.pid !== 0) throw new PortlessError('NAME_TAKEN_BY_APP', `${n} is used by a running app. Stop that app or pick another name.`, { details: { route: toRoute(existing, ctx()) } });
      if (existing && !force) throw new PortlessError('NAME_TAKEN', `${n} already points to port ${existing.port}.`, { details: { route: toRoute(existing, ctx()) } });
      refuseWriteIfBlocked();
      fake.routes = fake.routes.filter((r) => r.hostname !== hostname);
      fake.routes.push({ hostname, port: p, pid: 0 });
      return toRoute({ hostname, port: p, pid: 0 }, ctx());
    },
    async removeAlias(name) {
      await step('removeAlias', [name]);
      let existing = find(name);
      if (!existing) existing = find(`${validateName(name)}.${TLD}`);
      if (!existing) throw new PortlessError('NOT_FOUND', `There's no address called ${name}.`);
      if (existing.pid !== 0) throw new PortlessError('NAME_TAKEN_BY_APP', `${name} is used by a running app. Stop that app or pick another name.`);
      refuseWriteIfBlocked();
      fake.routes = fake.routes.filter((r) => r !== existing);
      return toRoute(existing, ctx());
    },
    async changePort(name, port) {
      await step('changePort', [name, port]);
      const p = validatePort(port);
      const hostname = `${validateName(name)}.${TLD}`;
      const existing = find(hostname);
      if (!existing) throw new PortlessError('NOT_FOUND', `There's no address called ${name}.`);
      if (existing.pid !== 0) throw new PortlessError('NAME_TAKEN_BY_APP');
      refuseWriteIfBlocked();
      existing.port = p;
      return toRoute(existing, ctx());
    },
    async renameAlias(oldName, newName, { force = false } = {}) {
      await step('renameAlias', [oldName, newName, { force }]);
      const nn = validateName(newName);
      const oldHost = `${validateName(oldName)}.${TLD}`;
      const existing = find(oldHost);
      if (!existing) throw new PortlessError('NOT_FOUND', `There's no address called ${oldName}.`);
      if (existing.pid !== 0) throw new PortlessError('NAME_TAKEN_BY_APP');
      const newHost = `${nn}.${TLD}`;
      if (newHost === oldHost) return toRoute(existing, ctx());
      const clash = find(newHost);
      if (clash && clash.pid !== 0) throw new PortlessError('NAME_TAKEN_BY_APP');
      if (clash && !force) throw new PortlessError('NAME_TAKEN', `${nn} already points to port ${clash.port}.`);
      refuseWriteIfBlocked();
      fake.routes = fake.routes.filter((r) => r.hostname !== newHost && r !== existing);
      fake.routes.push({ hostname: newHost, port: existing.port, pid: 0 });
      return toRoute({ hostname: newHost, port: existing.port, pid: 0 }, ctx());
    },
    /** E13: read-only; `refresh` is recorded (the fake has no cache, so every read is fresh). */
    async getRoutesAccess({ refresh = false } = {}) {
      await step('getRoutesAccess', [{ refresh: Boolean(refresh) }]);
      if (fake.routesAccessDelayMs) await new Promise((r) => setTimeout(r, fake.routesAccessDelayMs));
      return routesAccessNow();
    },
    async startProxy(settings, { allowService = false } = {}) {
      await step('startProxy', [settings]);
      if (fake.service && !allowService) throw new PortlessError('SERVICE_MANAGED');
      if (fake.proxy.running) return fake.getProxyState();
      const port = validatePort(settings.port);
      if (port < 1024) await elevated('startProxy');
      Object.assign(fake.proxy, { running: true, pid: 4242, port, tls: Boolean(settings.tls), lan: settings.lan !== false, lanIp: settings.lan !== false ? settings.fixedIp || '192.168.1.42' : null, wildcard: Boolean(settings.wildcard), elevated: port < 1024, managedBy: 'manual' });
      return fake.getProxyState();
    },
    async stopProxy({ allowService = false } = {}) {
      await step('stopProxy', []);
      if (fake.service && !allowService) throw new PortlessError('SERVICE_MANAGED');
      if (fake.proxy.elevated) await elevated('stopProxy');
      Object.assign(fake.proxy, { running: false, pid: null, lanIp: null, elevated: false, managedBy: null });
      return fake.getProxyState();
    },
    async doctor() {
      await step('doctor', []);
      return { ...parseDoctor(fake.doctorText), raw: fake.doctorText };
    },
    async serviceStatus() {
      await step('serviceStatus', []);
      return { installed: Boolean(fake.service), raw: '' };
    },
    async trust() {
      await step('trust', []);
      await elevated('trust');
      return { stdout: 'Trusted.', stderr: '', output: 'Trusted.', exitCode: 0 };
    },
    async hostsSync() {
      await step('hostsSync', []);
      await elevated('hostsSync');
      return { stdout: 'Synced.', stderr: '', output: 'Synced.', exitCode: 0 };
    },
    async prune() {
      await step('prune', []);
      const output = '  old.local :4555 - killed PID 999 (SIGTERM)\n  gone.local :4556 - route removed (port already free)';
      return { stdout: output, stderr: '', output, exitCode: 0 };
    },
    async clean() {
      await step('clean', []);
      await elevated('clean');
      fake.routes = [];
      return { stdout: 'Cleaned.', stderr: '', output: 'Cleaned.', exitCode: 0 };
    },
    async serviceInstall(settings) {
      await step('serviceInstall', [settings]);
      await elevated('serviceInstall');
      fake.service = { stateDir: fake.stateDir(), port: settings.port, tls: Boolean(settings.tls), lan: true, fixedIp: settings.fixedIp || null, tlds: ['local'], wildcard: Boolean(settings.wildcard) };
      Object.assign(fake.proxy, { running: true, port: settings.port, tls: Boolean(settings.tls), lan: true, managedBy: 'service', elevated: true, serviceLoaded: true });
      return { stdout: '', stderr: '', output: 'Installed.', exitCode: 0 };
    },
    /** E12: stop the startup service (the definition stays; it returns at the next boot). */
    async stopService() {
      await step('stopService', []);
      if (!fake.service) throw new PortlessError('UNSUPPORTED', 'There is no startup service to stop.');
      await elevated('stopService');
      Object.assign(fake.proxy, { running: false, pid: null, serviceLoaded: false });
      return fake.getProxyState();
    },
    /** E12: start (bootstrap) the startup service again. */
    async startService() {
      await step('startService', []);
      if (!fake.service) throw new PortlessError('UNSUPPORTED', 'There is no startup service to start.');
      await elevated('startService');
      Object.assign(fake.proxy, { running: true, pid: 12825, serviceLoaded: true, managedBy: 'service' });
      return fake.getProxyState();
    },
    async serviceUninstall() {
      await step('serviceUninstall', []);
      await elevated('serviceUninstall');
      fake.service = null;
      Object.assign(fake.proxy, { running: false, pid: null, managedBy: null, elevated: false, serviceLoaded: false });
      return { stdout: '', stderr: '', output: 'Uninstalled.', exitCode: 0 };
    },
  });
  return fake;
}

/**
 * Fake discovery: `scan()` returns copies of `services` (default FIXTURE_SERVICES).
 * Set `.services`, `.errors` to change what the next scan returns.
 */
export function createFakeDiscovery(services = FIXTURE_SERVICES, errors = []) {
  const d = {
    services: clone(services),
    errors: [...errors],
    scans: 0,
    lastOptions: null,
    /** Number of upcoming scans that never settle. */
    hang: 0,
    async scan(opts = {}) {
      d.scans += 1;
      d.lastOptions = { ...opts };
      if (d.hang > 0) {
        d.hang -= 1;
        await new Promise(() => {});
      }
      return { services: clone(d.services), scannedAt: new Date().toISOString(), errors: [...d.errors] };
    },
  };
  return d;
}

/** Fake network: `getNetwork()` returns a copy of `.value`; `ip` follows `proxyLanIp` like N2. */
export function createFakeNetwork(value = FIXTURE_NETWORKS.wifi) {
  const n = {
    value: clone(value),
    calls: [],
    async getNetwork(opts = {}) {
      n.calls.push({ ...opts });
      const v = clone(n.value);
      // like N2: a LAN proxy's IP wins, but never invent an IP when there's no network
      if (opts.proxyLanIp && v.kind !== 'none') v.ip = opts.proxyLanIp;
      return v;
    },
  };
  return n;
}

/**
 * Fake route probe: a port in `statuses` gets that status; else `live` when
 * a fixture service with HTTP < 500 listens on it, else `waiting`. Answers
 * always carry `statusDetail.tls` like the real probe (Contracts E1).
 */
export function createFakeProbe(services = FIXTURE_SERVICES, statuses = {}) {
  const probe = async (port) => {
    if (statuses[port]) return clone(statuses[port]);
    const s = services.find((x) => x.port === port);
    if (s?.http) {
      const detail = { httpStatus: s.http.status, tls: Boolean(s.http.tls) };
      return s.http.status >= 500 ? { status: 'error', statusDetail: detail } : { status: 'live', statusDetail: detail };
    }
    if (s) return { status: 'error', statusDetail: { reason: 'protocol' } };
    return { status: 'waiting', statusDetail: { reason: 'refused' } };
  };
  probe.statuses = statuses;
  return probe;
}

/** Fake host check: `ok` unless `results[hostname]` says otherwise. */
export function createFakeHostCheck(results = {}) {
  return async ({ route, proxy }) => {
    if (results[route.hostname]) return { ...clone(results[route.hostname]), checkedAt: new Date().toISOString() };
    if (!proxy) return { result: 'proxy-down', ok: false, httpStatus: null, framework: null, message: 'Sharing is off, so this address can’t be checked.', fix: null, checkedAt: new Date().toISOString() };
    return { result: 'ok', ok: true, httpStatus: 200, framework: null, message: `${route.hostname} works through Portless.`, fix: null, checkedAt: new Date().toISOString() };
  };
}

/**
 * Start the real server on fakes.
 * @param {object} [o]
 * @param {string} [o.scenario]  one of SCENARIO_NAMES (default 'manual-https')
 * @param {number} [o.port]  0 = any free port (default)
 * @param {string} [o.home]  NIDUM_HOME (default: a fresh temp dir, removed on close)
 * @param {boolean} [o.readOnly]
 * @param {object} [o.adapter]  override the fake adapter
 * @param {object} [o.app]  extra createApp options (intervals, …)
 * @param {object | false} [o.state]  state.json to pre-seed; false = first run
 */
export async function startMockApi(o = {}) {
  const sc = SCENARIOS[o.scenario || 'manual-https'];
  if (!sc) throw new Error(`unknown scenario ${o.scenario}; use one of ${SCENARIO_NAMES.join(', ')}`);
  const ownHome = !o.home;
  const home = o.home || mkdtempSync(join(tmpdir(), 'nidum-mock-'));
  if (o.state !== false && (sc.names || o.state)) {
    const { writeFileAtomic } = await import('../../src/state.js');
    const state = o.state || {
      version: 1,
      names: sc.names || [],
      settings: { tls: sc.proxy.tls, port: sc.proxy.port, fixedIp: null, wildcard: false, keepAfterRestart: sc.proxy.managedBy === 'service' },
      dismissed: [],
    };
    writeFileAtomic(join(home, 'state.json'), JSON.stringify(state));
  }
  const services = sc.services ?? FIXTURE_SERVICES;
  const adapter =
    o.adapter ||
    createFakeAdapter({
      proxy: sc.proxy,
      service: sc.service,
      routes: sc.routes,
      stateDir: sc.stateDir,
      routesLock: sc.routesLock ?? null,
      delayMs: o.delayMs ?? 0,
      onElevate: o.onElevate,
      passwordDelayMs: o.passwordDelayMs ?? sc.passwordDelayMs ?? 0,
      routesAccessDelayMs: o.routesAccessDelayMs ?? 0,
    });
  const discovery = o.discovery || createFakeDiscovery(services);
  const network = o.network || createFakeNetwork(FIXTURE_NETWORKS[sc.network] || FIXTURE_NETWORKS.wifi);
  // Samples of every E1 statusDetail variant: plain answer, ::1-only app, slow app.
  const probe = createFakeProbe(services, {
    32400: { status: 'live', statusDetail: { httpStatus: 200, tls: false } },
    8888: { status: 'live', statusDetail: { httpStatus: 302, tls: false, host: '::1' } },
    4312: { status: 'live', statusDetail: { httpStatus: null, tls: false, slow: true } },
  });
  const server = await startServer({
    env: { ...process.env, NIDUM_HOME: home },
    home,
    port: o.port ?? 0,
    readOnly: Boolean(o.readOnly),
    adapter,
    discovery,
    network,
    log: o.log || (() => {}),
    onQuit: o.onQuit || (() => {}),
    app: {
      probeRoute: probe,
      hostCheck: createFakeHostCheck(),
      setupBindAddress: () => '127.0.0.1', // the page is reachable at 127.0.0.1:<port>; its URL shows the fake LAN IP
      readCa: () => '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----\n',
      ...(o.app || {}),
    },
  });
  if (adapter && typeof adapter.failNext === 'function') adapter.app = server.app;
  return {
    ...server,
    adapter,
    discovery,
    network,
    probe,
    home,
    url: server.url,
    tokenUrl: server.tokenUrl,
    async close() {
      await server.close();
      if (ownHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

/** formatUrl re-exported for UI tests that build expected URLs. */
export { formatUrl };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mock = await startMockApi({ scenario: opt('scenario') || 'manual-https', port: opt('port') ? Number(opt('port')) : 0, onQuit: () => mock.close().then(() => process.exit(0)) });
  console.log(`Mock Nidum Local API (${opt('scenario') || 'manual-https'}) at ${mock.tokenUrl}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
