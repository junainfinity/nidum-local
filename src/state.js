// Nidum Local's own state (node N3).
//
// - `NIDUM_HOME` (default ~/.nidum-local) holds session.json, state.json and
//   the launcher/server logs (Contracts §4).
// - session.json: one line, fixed key order, mode 600, written atomically.
// - state.json: { version, names, settings, dismissed } — names created here,
//   saved proxy settings (seeded from reality on first run, F1) and dismissed
//   banners. Written atomically; never pruned on a failed route read.
// - The live model (`createLiveState`) caches proxy, routes, services, network
//   and route probes, decorates them into the /api/state body (Contracts §5)
//   and reports which sub-objects changed (for SSE, Contracts §6).

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Value of `app` in /api/health. */
export const APP_ID = 'nidum-local';

/** Nidum Local's version, from package.json. */
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Fixed text for `capabilities.internetSharing` (F11, D9). */
export const INTERNET_SHARING_REASON = "Sharing outside your network isn't available for addresses added here yet.";
/** Fixed text for `capabilities.pause` when a startup service owns the proxy (F1, D10). */
export const PAUSE_SERVICE_REASON = 'Sharing is kept on by the startup service. Turn off Keep sharing after restart to pause.';

/** SSIDs that look like public or guest networks (design spec §12). */
const PUBLIC_SSID = /guest|free|public|airport|hotel/i;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Nidum Local's home folder: `NIDUM_HOME`, else ~/.nidum-local.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function nidumHome(env = process.env) {
  return env.NIDUM_HOME ? path.resolve(env.NIDUM_HOME) : path.join(os.homedir(), '.nidum-local');
}

/**
 * Write a file atomically (temp file in the same folder, then rename).
 * @param {string} file
 * @param {string} data
 * @param {number} [mode]
 */
export function writeFileAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * The exact session.json line (Contracts §4): fixed key order, single line.
 * @param {{ port: number, token: string, pid: number, startedAt: string, version: string }} s
 * @returns {string}
 */
export function sessionLine(s) {
  return `${JSON.stringify({ port: s.port, token: s.token, pid: s.pid, startedAt: s.startedAt, version: s.version })}\n`;
}

/**
 * Write `<home>/session.json` atomically with mode 600.
 * @param {string} home
 * @param {{ port: number, token: string, pid: number, startedAt: string, version: string }} session
 * @returns {string} the file path
 */
export function writeSession(home, session) {
  const file = path.join(home, 'session.json');
  writeFileAtomic(file, sessionLine(session), 0o600);
  return file;
}

/**
 * Read session.json, or null.
 * @param {string} home
 */
export function readSession(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Delete session.json if it still belongs to `pid` (a newer server may own it).
 * @param {string} home
 * @param {number} pid
 * @returns {boolean} true when removed
 */
export function removeSession(home, pid) {
  const s = readSession(home);
  if (s && s.pid !== pid) return false;
  try {
    fs.rmSync(path.join(home, 'session.json'), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

/** Settings shape (Contracts §4 / §5 minus restartNeeded). */
export const DEFAULT_SETTINGS = Object.freeze({ tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false });

function isIPv4(v) {
  return typeof v === 'string' && net.isIP(v) === 4;
}

/**
 * A unicast IPv4 address a server may bind (D27): not 0.0.0.0/8, loopback
 * (127/8), multicast (224/4), reserved/broadcast (240/4 incl. 255.255.255.255).
 * Whether this computer currently lists it is checked separately.
 * @param {unknown} ip
 * @returns {boolean}
 */
export function isUnicastIPv4(ip) {
  if (!isIPv4(ip)) return false;
  const a = Number(ip.split('.')[0]);
  return a !== 0 && a !== 127 && a < 224;
}

/**
 * Is `ip` a unicast IPv4 that `network.interfaces` currently lists (D27)?
 * @param {unknown} ip
 * @param {{ interfaces?: Array<{ ip: string }> } | null} network
 */
export function isListedLanIp(ip, network) {
  return isUnicastIPv4(ip) && Array.isArray(network?.interfaces) && network.interfaces.some((i) => i && i.ip === ip);
}

/**
 * Coerce anything into a valid settings object (unknown keys dropped).
 * @param {any} s
 * @param {object} [base]
 */
export function normalizeSettings(s, base = DEFAULT_SETTINGS) {
  const src = s && typeof s === 'object' ? s : {};
  const tls = typeof src.tls === 'boolean' ? src.tls : base.tls;
  const port = Number.isInteger(src.port) && src.port >= 1 && src.port <= 65535 ? src.port : Number.isInteger(base.port) ? base.port : tls ? 443 : 80;
  return {
    tls,
    port,
    fixedIp: isUnicastIPv4(src.fixedIp) ? src.fixedIp : src.fixedIp === null || src.fixedIp !== undefined ? null : isUnicastIPv4(base.fixedIp) ? base.fixedIp : null,
    wildcard: typeof src.wildcard === 'boolean' ? src.wildcard : Boolean(base.wildcard),
    keepAfterRestart: typeof src.keepAfterRestart === 'boolean' ? src.keepAfterRestart : Boolean(base.keepAfterRestart),
  };
}

/**
 * First-run settings from reality (F1): TLS and port from the proxy, fixed IP
 * and wildcard from the startup service, keepAfterRestart = service-managed.
 * @param {{ tls: boolean, port: number, wildcard?: boolean | null, managedBy?: string | null }} proxy
 * @param {{ fixedIp?: string | null, wildcard?: boolean, tls?: boolean, port?: number } | null} service  own service config, or null
 */
export function seedSettings(proxy, service) {
  const managed = proxy && proxy.managedBy === 'service' && service;
  return normalizeSettings({
    tls: Boolean(proxy?.tls),
    port: proxy?.port,
    fixedIp: managed && isUnicastIPv4(service.fixedIp) ? service.fixedIp : null,
    wildcard: managed ? Boolean(service.wildcard) : typeof proxy?.wildcard === 'boolean' ? proxy.wildcard : false,
    keepAfterRestart: proxy?.managedBy === 'service',
  });
}

/**
 * state.json in `home`. Keeps the parsed data in memory; every change is
 * written atomically. Shape (Contracts §4): `{ version: 1, names, settings, dismissed }`,
 * plus `paused: true` while the user has paused sharing (D33; absent otherwise).
 */
export class StateStore {
  /** @param {string} home */
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'state.json');
    this.data = null;
    this.firstRun = false;
    this.recoveredFrom = null;
    /** Problems found while loading (for the server log). */
    this.notes = [];
  }

  /**
   * Load state.json. Missing → first run (`seed()` is called with no
   * argument and must return settings). Unparsable → moved aside to
   * `state.json.corrupt-<ms>` and treated as a first run.
   * @param {() => Promise<object> | object} seed  first-run settings
   */
  async load(seed) {
    let text = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let parsed = null;
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      } catch {
        const aside = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, aside);
          this.recoveredFrom = aside;
        } catch {
          /* leave it */
        }
        parsed = null;
      }
    }
    if (parsed && parsed.settings && typeof parsed.settings === 'object') {
      const raw = parsed.settings.fixedIp;
      if (raw !== undefined && raw !== null && !isUnicastIPv4(raw)) {
        this.notes.push(`state.json fixedIp ${JSON.stringify(raw)} ignored: not a unicast IPv4 address`);
      }
      this.data = {
        version: 1,
        names: uniqueStrings(parsed.names),
        settings: normalizeSettings(parsed.settings),
        dismissed: uniqueStrings(parsed.dismissed),
        paused: parsed.paused === true,
      };
      this.firstRun = false;
      return this.data;
    }
    this.firstRun = true;
    const settings = normalizeSettings(await seed());
    this.data = {
      version: 1,
      names: parsed ? uniqueStrings(parsed.names) : [],
      settings,
      dismissed: parsed ? uniqueStrings(parsed.dismissed) : [],
      paused: Boolean(parsed && parsed.paused === true),
    };
    this.save();
    return this.data;
  }

  get settings() {
    return this.data.settings;
  }

  get names() {
    return this.data.names;
  }

  get dismissed() {
    return this.data.dismissed;
  }

  /** D33: the user paused sharing (survives a server restart). */
  get paused() {
    return Boolean(this.data && this.data.paused === true);
  }

  save() {
    const d = this.data;
    const out = { version: 1, names: d.names, settings: d.settings, dismissed: d.dismissed };
    if (d.paused === true) out.paused = true;
    writeFileAtomic(this.file, `${JSON.stringify(out)}\n`, 0o600);
  }

  /** @param {(data: object) => boolean | void} fn  return false to skip the write */
  update(fn) {
    const before = JSON.stringify(this.data);
    fn(this.data);
    this.data.names = uniqueStrings(this.data.names);
    this.data.dismissed = uniqueStrings(this.data.dismissed);
    this.data.settings = normalizeSettings(this.data.settings);
    this.data.paused = this.data.paused === true;
    if (JSON.stringify(this.data) !== before) this.save();
    return this.data;
  }
}

function uniqueStrings(v) {
  return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : [];
}

// ---------------------------------------------------------------------------
// Pure model helpers (Contracts §5)
// ---------------------------------------------------------------------------

/**
 * `source` of a route: nidum (name in state.json), app (pid ≠ 0), else cli.
 * @param {{ name: string, pid: number, foreignTld?: boolean }} route
 * @param {string[]} names
 */
export function routeSource(route, names) {
  if (!route.foreignTld && names.includes(route.name)) return 'nidum';
  if (route.pid !== 0) return 'app';
  return 'cli';
}

const STATUS_ORDER = { error: 0, live: 1, waiting: 2, unknown: 3 };

/** Sort: error, live, waiting, unknown; alphabetical (hostname) within. */
export function sortRoutes(routes) {
  return routes.slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
}

/**
 * Settings as /api/state shows them, with `restartNeeded` (a running manual
 * proxy whose live config differs from the saved one) and
 * `serviceReinstallNeeded` (the startup service differs from the saved
 * settings, or keepAfterRestart doesn't match whether one is installed).
 * Portless doesn't persist `wildcard`, so N1's `proxy.wildcard` for a manual
 * proxy is only the saved setting echoed back. The live model passes
 * `opts.wildcardDiffers` instead (what Nidum started the proxy with, see
 * `createLiveState`); without it the old proxy.wildcard comparison is used.
 * @param {object} saved
 * @param {object | null} proxy
 * @param {object | null} service  own service config
 * @param {{ wildcardDiffers?: boolean }} [opts]
 */
export function settingsView(saved, proxy, service, opts = {}) {
  const s = normalizeSettings(saved);
  const managed = proxy?.managedBy === 'service' && service;
  let restartNeeded = false;
  let serviceReinstallNeeded = false;
  if (managed) {
    serviceReinstallNeeded =
      !s.keepAfterRestart ||
      s.tls !== service.tls ||
      s.port !== service.port ||
      (s.fixedIp || null) !== (service.fixedIp || null) ||
      s.wildcard !== Boolean(service.wildcard);
  } else {
    serviceReinstallNeeded = s.keepAfterRestart;
    if (proxy?.running) {
      restartNeeded =
        s.tls !== proxy.tls ||
        s.port !== proxy.port ||
        (typeof opts.wildcardDiffers === 'boolean' ? opts.wildcardDiffers : typeof proxy.wildcard === 'boolean' && proxy.wildcard !== s.wildcard) ||
        Boolean(s.fixedIp && proxy.lanIp && s.fixedIp !== proxy.lanIp);
    }
  }
  return { ...s, restartNeeded, serviceReinstallNeeded };
}

/** Platforms where a service-managed proxy can be stopped and started (D43, E12). */
export const SERVICE_PAUSE_PLATFORMS = Object.freeze(['darwin', 'linux']);

/**
 * Capabilities (F11, F15, F1; D43). Pause works for a service-managed proxy on
 * macOS and Linux (stop/start the service, E12); elsewhere it stays unsupported.
 * @param {object | null} proxy
 * @param {NodeJS.Platform} [platform]
 */
export function capabilitiesView(proxy, platform = process.platform) {
  const tls = Boolean(proxy?.tls);
  const service = proxy?.managedBy === 'service' && !SERVICE_PAUSE_PLATFORMS.includes(platform);
  return {
    internetSharing: { supported: false, reason: INTERNET_SHARING_REASON },
    deviceSetup: tls
      ? { supported: true, reason: null }
      : { supported: false, reason: 'Other devices only need setup for secure (HTTPS) addresses, and HTTPS is off.' },
    pause: service ? { supported: false, reason: PAUSE_SERVICE_REASON } : { supported: true, reason: null },
  };
}

/** Is this SSID a likely public/guest network? */
export function isPublicSsid(ssid) {
  return typeof ssid === 'string' && PUBLIC_SSID.test(ssid);
}

/** E13 banner messages. */
export const ROUTES_LOCKED_MESSAGE = "Your address list is locked, so addresses can't be added, changed or removed.";
export const ROUTES_NOT_WRITABLE_MESSAGE = "Nidum Local isn't allowed to change your address list.";

/**
 * Normalise an adapter `getRoutesAccess()` answer (E13, D51): exactly
 * `{ locked, flag, target, writable, path, owner, ownedByYou }`; null for anything unusable.
 * `flag` is kept only when locked. `target` ('file' | 'folder') is kept whenever the
 * adapter names it (D53: the blocking path's kind, locked or not). `owner` is the owner of
 * the blocking path, locked or not; `ownedByYou` is `true`/`false`, else `null` (unknown,
 * or an adapter from before D51).
 * @param {any} a
 */
export function normalizeRoutesAccess(a) {
  if (!a || typeof a !== 'object') return null;
  const locked = a.locked === true;
  return {
    locked,
    flag: locked && (a.flag === 'uchg' || a.flag === 'schg') ? a.flag : null,
    target: a.target === 'file' || a.target === 'folder' ? a.target : null,
    writable: a.writable !== false,
    path: typeof a.path === 'string' ? a.path : null,
    owner: typeof a.owner === 'string' && a.owner ? a.owner : null,
    ownedByYou: a.ownedByYou === true ? true : a.ownedByYou === false ? false : null,
  };
}

/**
 * E13 banner for a locked or not-writable address list, or null.
 * D53: `details` carry the full blocking-path facts, the same as the matching
 * ROUTES_LOCKED / ROUTES_NOT_WRITABLE error `details`:
 * `routes-locked` → `{ path, flag, target, owner, ownedByYou }`;
 * `routes-not-writable` → `{ path, target, owner, ownedByYou }`.
 * @param {object | null} access  normalised routesAccess
 */
export function routesAccessBanner(access) {
  if (!access) return null;
  const facts = { target: access.target ?? null, owner: access.owner ?? null, ownedByYou: access.ownedByYou ?? null };
  if (access.locked) {
    return { id: 'routes-locked', kind: 'error', message: ROUTES_LOCKED_MESSAGE, details: { path: access.path, flag: access.flag, ...facts } };
  }
  if (access.writable === false) {
    return { id: 'routes-not-writable', kind: 'error', message: ROUTES_NOT_WRITABLE_MESSAGE, details: { path: access.path, ...facts } };
  }
  return null;
}

/**
 * Banners (design spec §11–§12). Dismissible: `first-run`, `public-network`
 * (per SSID: stored as `public-network:<ssid>`).
 * A stopped proxy shows `sharing-paused` (info) after a user pause
 * (`POST /api/proxy/stop`), else `sharing-off` (error) (E11).
 * While a startup-service job runs (`changing`), a stopped proxy is expected and no
 * stop banner shows (graph validation 2 F1).
 * E13: `routes-locked` / `routes-not-writable` (error, not dismissible) come right
 * after the sharing banner (`sharing-paused` / `sharing-off`), or where it would be,
 * so a lock never hides whether sharing is on (D59d). Full order: `portless-missing`,
 * `first-run`, `sharing-paused` | `sharing-off`, `routes-*`, `network-off`, `public-network`.
 * @param {{ proxy: object | null, network: object | null, dismissed: string[], portlessInstalled: boolean, pausedByUser?: boolean, changing?: boolean, routesAccess?: object | null }} input
 */
export function bannersView({ proxy, network, dismissed, portlessInstalled, pausedByUser = false, changing = false, routesAccess = null }) {
  const out = [];
  if (!portlessInstalled) out.push({ id: 'portless-missing', kind: 'error', message: "Portless isn't installed anymore. Open the launcher again." });
  if (!dismissed.includes('first-run')) {
    out.push({ id: 'first-run', kind: 'info', message: 'Addresses you create here can be opened by any device on your network.' });
  }
  if (proxy && !proxy.running && !changing) {
    out.push(
      pausedByUser
        ? { id: 'sharing-paused', kind: 'info', message: 'Sharing is paused. Your addresses are offline until you resume.' }
        : { id: 'sharing-off', kind: 'error', message: 'Sharing is off. Your addresses are offline.' },
    );
  }
  const access = routesAccessBanner(routesAccess);
  if (access) out.push(access);
  if (proxy && proxy.running && !proxy.lan) {
    out.push({ id: 'network-off', kind: 'warning', message: "Sharing is on for this computer only. Other devices can't open your addresses." });
  }
  const ssid = network?.ssid;
  if (isPublicSsid(ssid) && !dismissed.includes(`public-network:${ssid}`)) {
    out.push({ id: 'public-network', kind: 'warning', ssid, message: `${ssid} looks like a public network. Anyone on it can open your addresses.` });
  }
  return out;
}

/**
 * A name for a discovered service: N2's suggestion run through `validateName`
 * (F11); reserved → `<name>-app`; anything invalid → `app-<port>`.
 * @param {string} suggestion
 * @param {number} port
 * @param {(n: string) => string} validateName
 */
export function safeSuggestedName(suggestion, port, validateName) {
  const fallback = Number.isInteger(port) ? `app-${port}` : 'app';
  try {
    return validateName(suggestion);
  } catch (err) {
    if (err?.details?.reason === 'reserved') {
      try {
        return validateName(`${suggestion}-app`);
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Probes (bypass the proxy) and host checks (through the proxy)
// ---------------------------------------------------------------------------

const HTTPS_HINT = /http request to an https server|plain http request was sent to https port|speaks? (only )?https|use https/i;

/**
 * One HTTP(S) request to 127.0.0.1:port. Resolves
 * `{ type: 'response', status, headers, body }` or `{ type }` with type ∈
 * refused | connect-timeout | no-response | protocol.
 */
function requestOnce({ port, host = '127.0.0.1', path: reqPath = '/', tls = false, timeout = 2000, headers = {}, servername, readBody = 0, method = 'GET', stopWhen = null }) {
  return new Promise((resolve) => {
    let connected = false;
    let done = false;
    let timer = null;
    let req = null;
    let partial = null; // set once response headers arrived: a timeout then reports what was read
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        req?.destroy();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    const mod = tls ? https : http;
    const opts = { host, port, path: reqPath, method, headers, agent: false };
    if (tls) {
      opts.rejectUnauthorized = false;
      if (servername && net.isIP(servername) === 0) opts.servername = servername;
    }
    try {
      req = mod.request(opts, (res) => {
        const chunks = [];
        let size = 0;
        let ended = false;
        let truncated = false;
        let found = false;
        let tail = '';
        const result = () => ({ type: 'response', status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), complete: ended, truncated, found });
        partial = result;
        if (!readBody) {
          res.resume();
          return finish(result());
        }
        res.on('data', (c) => {
          if (size < readBody) {
            chunks.push(c);
            size += c.length;
          }
          if (stopWhen) {
            // stream search: the marker may sit anywhere (Portless's 404 page puts it after ~150 KB)
            const text = tail + c.toString('latin1');
            if (stopWhen.test(text)) {
              found = true;
              return finish(result());
            }
            tail = text.slice(-256);
          }
          if (size >= readBody) {
            truncated = true;
            finish(result());
          }
          return undefined;
        });
        res.on('end', () => {
          ended = true;
          finish(result());
        });
        res.on('error', () => finish(result()));
      });
    } catch {
      return finish({ type: 'protocol' });
    }
    req.on('socket', (sock) => {
      const onConnect = () => {
        connected = true;
      };
      sock.once(tls ? 'secureConnect' : 'connect', onConnect);
      if (tls) sock.once('connect', () => {});
    });
    req.on('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') return finish({ type: 'refused' });
      finish({ type: connected || (err && /EPROTO|ECONNRESET|HPE_|socket hang up|SSL|TLS|wrong version/i.test(`${err.code} ${err.message}`)) ? 'protocol' : 'refused', error: err?.code || err?.message });
    });
    timer = setTimeout(() => finish(partial ? partial() : { type: connected ? 'no-response' : 'connect-timeout' }), Math.max(1, timeout));
    req.end();
  });
}

/**
 * Route status probe (Contracts §5): bypasses the proxy. Connects to
 * 127.0.0.1, then ::1 when that is refused (Vite's default `localhost` binds
 * ::1 only on macOS; Portless itself tries both).
 * live = connect ok and (if HTTP) status < 500 (a connected server that sends
 * no headers in time counts as live, `statusDetail.slow`); error = HTTP ≥ 500
 * or a TLS/protocol error; waiting = refused (both) or connect timeout.
 * `statusDetail.host` is set to '::1' when only the IPv6 loopback answered.
 * @param {number} port
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ status: 'live' | 'error' | 'waiting', statusDetail: object }>}
 */
export async function probeRoutePort(port, { timeout = 2000 } = {}) {
  let host = '127.0.0.1';
  const hostHeader = () => (host === '::1' ? `[::1]:${port}` : `127.0.0.1:${port}`);
  const extra = () => (host === '::1' ? { host: '::1' } : {});
  const classify = (r, tls) => {
    if (r.status >= 500) return { status: 'error', statusDetail: { httpStatus: r.status, tls, ...extra() } };
    return { status: 'live', statusDetail: { httpStatus: r.status, tls, ...extra() } };
  };
  const plainOn = (h) => requestOnce({ port, host: h, timeout, headers: { host: h === '::1' ? `[::1]:${port}` : `127.0.0.1:${port}`, 'user-agent': 'NidumLocal-Probe' }, readBody: 2048 });
  let plain = await plainOn(host);
  if (plain.type === 'refused') {
    const v6 = await plainOn('::1');
    if (v6.type !== 'refused') {
      host = '::1';
      plain = v6;
    }
  }
  if (plain.type === 'refused' || plain.type === 'connect-timeout') return { status: 'waiting', statusDetail: { reason: plain.type === 'refused' ? 'refused' : 'timeout' } };
  if (plain.type === 'no-response') return { status: 'live', statusDetail: { httpStatus: null, tls: false, slow: true, ...extra() } };
  if (plain.type === 'response' && !(plain.status === 400 && HTTPS_HINT.test(plain.body || ''))) return classify(plain, false);
  const secure = await requestOnce({ port, host, tls: true, timeout, headers: { host: hostHeader(), 'user-agent': 'NidumLocal-Probe' } });
  if (secure.type === 'response') return classify(secure, true);
  if (secure.type === 'no-response') return { status: 'live', statusDetail: { httpStatus: null, slow: true, tls: true, ...extra() } };
  if (plain.type === 'response') return classify(plain, false);
  return { status: 'error', statusDetail: { reason: 'protocol', ...extra() } };
}

function frameworkOf(headers = {}, body = '', fallback = null) {
  const powered = String(headers['x-powered-by'] || '').toLowerCase();
  const server = String(headers.server || '').toLowerCase();
  if (powered.includes('next.js') || /__next|_next\/static/.test(body)) return 'Next.js';
  if (/vite|@vite\/client/i.test(body) && /blocked request|allowedhosts|@vite/i.test(body)) return 'Vite';
  if (/DisallowedHost|ALLOWED_HOSTS|Invalid HTTP_HOST header/.test(body) || server.includes('wsgiserver')) return 'Django';
  return fallback;
}

/**
 * Host check (N3 note, Contracts §2): a request through the proxy with
 * `Host: hostname`, judged by status and body (not X-Portless, which is on
 * every proxy response). Portless's 404 page = not routed; 502 = app down.
 * @param {{ route: object, proxy: object, framework?: string | null, timeout?: number }} input
 * @returns {Promise<{ result: string, ok: boolean, httpStatus: number | null, framework: string | null, message: string, fix: string | null, location?: string, checkedAt: string }>}
 */
/** Portless's "unknown host" page marker (chunk-SLEZT6EJ.js:457–463). */
const PORTLESS_404_MARKER = /No app registered for/;
/** How much of a host-check answer is read at most. */
const HOST_CHECK_MAX_BODY = 512 * 1024;

export async function hostCheck({ route, proxy, framework = null, timeout = 5000, deadline }) {
  const checkedAt = new Date().toISOString();
  const end = Number.isFinite(deadline) ? deadline : Date.now() + timeout;
  const remaining = () => end - Date.now();
  const out = (result, ok, extra) => ({ result, ok, httpStatus: null, framework, fix: null, checkedAt, ...extra });
  if (!proxy || !Number.isInteger(proxy.port)) return out('proxy-down', false, { message: 'Sharing is off, so this address can’t be checked.' });
  const defaultPort = proxy.tls ? 443 : 80;
  const host = proxy.port === defaultPort ? route.hostname : `${route.hostname}:${proxy.port}`;
  const r = await requestOnce({
    port: proxy.port,
    tls: Boolean(proxy.tls),
    servername: route.hostname,
    timeout: Math.max(1, remaining()),
    headers: { host, 'user-agent': 'NidumLocal-HostCheck', accept: 'text/html,*/*' },
    readBody: HOST_CHECK_MAX_BODY,
    stopWhen: PORTLESS_404_MARKER,
  });
  if (r.type === 'refused' || r.type === 'connect-timeout') return out('proxy-down', false, { message: 'Sharing is off, so this address can’t be checked.' });
  if (r.type === 'no-response') return out('slow', false, { message: `${route.hostname} didn’t answer within ${Math.max(1, Math.round((end - Date.parse(checkedAt)) / 1000))} seconds.` });
  if (r.type !== 'response') return out('error', false, { message: 'The check couldn’t reach this address.' });
  const body = r.body || '';
  const fw = frameworkOf(r.headers, body, framework);
  const base = { httpStatus: r.status, framework: fw };
  let appOwn404 = false;
  if (r.status === 404) {
    // Portless's own 404 page always carries the marker (~153 KB in; the body is
    // stream-searched up to 512 KB) → not-routed. A 404 without it, read in full, to
    // 512 KB or until the deadline, is the app's own answer (E5, N3 validation 4). A
    // direct probe only sharpens the message, within the time left.
    if (r.found) return out('not-routed', false, { ...base, message: `Portless doesn’t know ${route.hostname} yet. Try again in a moment.` });
    appOwn404 = true;
    if (remaining() > 300) {
      const direct = await probeRoutePort(route.port, { timeout: Math.max(100, Math.floor((remaining() - 100) / 2)) }).catch(() => null);
      const ds = direct?.statusDetail?.httpStatus;
      if (Number.isInteger(ds) && ds < 400) {
        return out('host-blocked', false, {
          ...base,
          message: `The app answers ${route.hostname} with “not found” but works at 127.0.0.1:${route.port}. It doesn’t serve that name.`,
          fix: `Let the app answer requests for ${route.hostname} (its allowed host names or virtual hosts).`,
        });
      }
    }
  }
  if (r.status === 502 && /Bad Gateway|target app/i.test(body)) {
    return out('app-down', false, { ...base, message: `Nothing answers on port ${route.port}. Start the app, then check again.` });
  }
  if (r.status === 508) return out('loop', false, { ...base, message: 'This app sends requests back through Portless in a loop. Set changeOrigin: true in its proxy settings.' });
  if (/Blocked request\. This host|server\.allowedHosts|allowedHosts/i.test(body) && r.status >= 400) {
    return out('host-blocked', false, {
      ...base,
      framework: 'Vite',
      message: `Vite blocks requests for ${route.hostname}.`,
      fix: "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.",
    });
  }
  if (/DisallowedHost|Invalid HTTP_HOST header/i.test(body)) {
    return out('host-blocked', false, {
      ...base,
      framework: 'Django',
      message: `Django blocks requests for ${route.hostname}.`,
      fix: `Add '${route.hostname}' (or '.local') to ALLOWED_HOSTS in settings.py.`,
    });
  }
  if (fw === 'Next.js' && (r.status === 403 || /allowedDevOrigins/.test(body))) {
    return out('host-blocked', false, {
      ...base,
      message: `Next.js blocks development requests from ${route.hostname}.`,
      fix: `Add allowedDevOrigins: ['${route.hostname}'] to next.config.js, then restart the dev server.`,
    });
  }
  if (r.status >= 300 && r.status < 400 && r.headers.location) {
    let target = null;
    try {
      target = new URL(r.headers.location, `http://${route.hostname}`).hostname;
    } catch {
      target = null;
    }
    if (target && /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i.test(target)) {
      return out('redirect-localhost', false, {
        ...base,
        location: r.headers.location,
        message: `This app redirects to ${target}, which other devices can’t open.`,
        fix: `Set the app’s public or base URL to ${route.url}.`,
      });
    }
  }
  if (r.status >= 500) return out('app-error', false, { ...base, message: `The app answered with an error (${r.status}).` });
  const ok = out('ok', true, { ...base, message: appOwn404 ? `${route.hostname} works through Portless. The app answers “not found” at its home page.` : `${route.hostname} works through Portless.` });
  if (fw === 'Next.js') ok.fix = `If pages don’t update on other devices, add allowedDevOrigins: ['${route.hostname}'] to next.config.js.`;
  return ok;
}

// ---------------------------------------------------------------------------
// Live model
// ---------------------------------------------------------------------------

const KEYS = ['proxy', 'routes', 'services', 'network', 'settings', 'capabilities', 'banners'];
const EMPTY_NETWORK = Object.freeze({ ip: null, interface: null, kind: 'none', ssid: null, interfaces: [] });

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Default deadlines for background refresh steps (ms). */
export const DEADLINES = Object.freeze({ proxy: 5000, routes: 5000, scan: 4000, network: 6000, probe: 6000, afterMutation: 3000, routesAccess: 3000, accessAfterRefused: 1500 });

/**
 * Race `promise` against a deadline; rejects with a TIMEOUT-coded error.
 * The late result of `promise` is ignored (and its rejection swallowed).
 */
export function withDeadline(promise, ms, what = 'operation') {
  let timer;
  const p = Promise.resolve(promise);
  p.catch(() => {});
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what} took longer than ${ms} ms`), { code: 'TIMEOUT' })), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function singleFlight(fn) {
  let running = null;
  return () => {
    if (!running) running = Promise.resolve().then(fn).finally(() => { running = null; });
    return running;
  };
}

/**
 * The live model behind /api/state and /api/events.
 *
 * @param {object} deps
 * @param {object} deps.adapter  N1 adapter (or a fake with the same surface)
 * @param {StateStore} deps.store
 * @param {(opts: object) => Promise<{ services: object[], scannedAt: string, errors: string[] }>} deps.scan
 * @param {(opts: object) => Promise<object>} deps.getNetwork
 * @param {(port: number) => Promise<{ status: string, statusDetail: object }>} [deps.probeRoute]
 * @param {() => number | null} [deps.dashboardPort]
 * @param {{ core?: number, services?: number, probes?: number, network?: number }} [deps.intervals]
 * @param {(key: string, data: any) => void} [deps.onChange]  called for every changed sub-object
 * @param {(msg: string) => void} [deps.log]
 */
export function createLiveState(deps) {
  const { adapter, store } = deps;
  const scan = deps.scan;
  const getNetwork = deps.getNetwork;
  const probeRoute = deps.probeRoute || ((port) => probeRoutePort(port));
  const dashboardPort = deps.dashboardPort || (() => null);
  const intervals = { core: 2000, services: 5000, probes: 10000, network: 10000, ...(deps.intervals || {}) };
  const platform = deps.platform || process.platform;
  const log = deps.log || (() => {});
  const deadlines = { ...DEADLINES, ...(deps.deadlines || {}) };
  const listeners = new Set();
  const failing = new Map(); // step → last logged failure text
  /** Log a lasting failure once (and its recovery once), not on every refresh. */
  function failed(step, err) {
    const text = `${err?.code || 'ERROR'}: ${err?.message || err}`;
    if (failing.get(step) === text) return;
    failing.set(step, text);
    log(`${step} failed (${text}); keeping the last good value`);
  }
  function recovered(step) {
    if (!failing.has(step)) return;
    failing.delete(step);
    log(`${step} works again`);
  }
  if (deps.onChange) listeners.add(deps.onChange);

  const cache = {
    proxy: null,
    service: null,
    routes: [],
    routesOk: false,
    routesError: null,
    statuses: new Map(), // hostname → { port, status, statusDetail, at }
    hostChecks: new Map(), // hostname → { port, check }
    createdAt: new Map(), // name → iso (this process only)
    services: [],
    scanErrors: [],
    scannedAt: null,
    lastScanDoneAt: 0, // last scan that completed (for ?refresh=1 reuse)
    dashboards: new Map(), // port → { pid, nidum: boolean } (other Nidum Local dashboards, F3)
    wildcardApplied: null, // see trackProxy()
    network: null,
    updatedAt: null,
    job: null,
    routesAccess: null, // E13: adapter.getRoutesAccess(), null until the first answer
    lastAt: { core: 0, services: 0, probes: 0, network: 0 },
  };
  const sent = new Map(); // key → JSON last reported
  let namesVersion = 0;
  let pendingMutations = 0;
  let timers = [];
  let holders = 0;
  let closed = false;

  function portlessInstalled() {
    try {
      return Boolean(adapter.findPortless());
    } catch {
      return false;
    }
  }

  function proxyView() {
    if (!cache.proxy) return null;
    const p = cache.proxy;
    // E12: N1 reports whether the startup service is loaded; until it does, a service-managed
    // proxy counts as loaded while it runs.
    const serviceLoaded = typeof p.serviceLoaded === 'boolean' ? p.serviceLoaded : p.managedBy === 'service' ? Boolean(p.running) : false;
    return { ...p, serviceLoaded, pausedByUser: store.paused, job: cache.job ? { ...cache.job } : null };
  }

  function decorate(route) {
    const names = store.names;
    const st = cache.statuses.get(route.hostname);
    const hc = cache.hostChecks.get(route.hostname);
    const fresh = st && st.port === route.port;
    return {
      ...route,
      source: routeSource(route, names),
      status: fresh ? st.status : 'unknown',
      statusDetail: fresh ? st.statusDetail : null,
      hostCheck: hc && hc.port === route.port ? hc.check : null,
      createdAt: cache.createdAt.get(route.name) || null,
    };
  }

  function routesView() {
    return sortRoutes(cache.routes.map(decorate));
  }

  function servicesView() {
    const byPort = new Map();
    for (const r of cache.routes) {
      const prev = byPort.get(r.port);
      if (!prev || (prev.foreignTld && !r.foreignTld)) byPort.set(r.port, r);
    }
    const validate = adapter.validateName || ((n) => n);
    return cache.services.map((s) => ({
      ...s,
      hidden: s.hidden ?? (isOtherDashboard(s) ? 'nidum-dashboard' : null),
      addresses: Array.isArray(s.addresses) ? [...s.addresses] : [],
      http: s.http ? { ...s.http } : null,
      suggestedName: safeSuggestedName(s.suggestedName, s.port, validate),
      routeName: byPort.get(s.port)?.name ?? null,
    }));
  }

  // --- other Nidum Local dashboards (graph validation 2 F3) ------------------
  function isOtherDashboard(s) {
    if (s.hidden) return false;
    if (s.http && s.http.title === 'Nidum Local') return true; // its 401 page / placeholder title
    const d = cache.dashboards.get(s.port);
    return Boolean(d && d.pid === (s.pid ?? null) && d.nidum);
  }

  let identifying = null;
  /** One identification pass at a time; a call while one runs joins it. */
  function identifyDashboardsOnce(services) {
    if (!identifying) identifying = identifyDashboards(services).catch(() => {}).finally(() => { identifying = null; });
    return identifying;
  }

  /** Ask each new HTTP port (per port + pid, cached) for /api/health: `app: 'nidum-local'`. */
  async function identifyDashboards(services) {
    const live = new Set(services.map((s) => s.port));
    for (const port of cache.dashboards.keys()) if (!live.has(port)) cache.dashboards.delete(port);
    const todo = services.filter((s) => s.http && !s.hidden && s.port !== dashboardPort() && cache.dashboards.get(s.port)?.pid !== (s.pid ?? null));
    await mapLimit(todo, 8, async (s) => {
      const r = await requestOnce({ port: s.port, host: '127.0.0.1', path: '/api/health', timeout: 1000, headers: { host: `127.0.0.1:${s.port}`, accept: 'application/json', 'user-agent': 'NidumLocal-Discover' }, readBody: 4096 });
      let nidum = false;
      if (r.type === 'response' && r.status === 200) {
        try {
          nidum = JSON.parse(r.body).app === APP_ID;
        } catch {
          nidum = false;
        }
      }
      cache.dashboards.set(s.port, { pid: s.pid ?? null, nidum });
    });
  }

  function networkView() {
    if (!cache.network) return { ...EMPTY_NETWORK, interfaces: [] };
    const n = { ...cache.network, interfaces: (cache.network.interfaces || []).map((i) => ({ ...i })) };
    // N2 falls back to { ip: proxyLanIp, kind: 'none' } when it can't read the network: no network means no IP.
    if (n.kind === 'none') n.ip = null;
    return n;
  }

  function settingsNow() {
    // D27: a saved fixedIp this computer doesn't list (yet) reads null; state.json keeps it.
    const saved = store.settings;
    const fixedIp = saved.fixedIp && isListedLanIp(saved.fixedIp, cache.network) ? saved.fixedIp : null;
    return settingsView({ ...saved, fixedIp }, cache.proxy, cache.service, { wildcardDiffers: wildcardDiffers(saved.wildcard) });
  }

  // --- wildcard of the running manual proxy (iteration 5) -------------------
  // `applied` = { key, value: boolean | null, requested }: the wildcard Nidum
  // started this proxy with, or null (unknown: started outside Nidum, e.g. by the
  // launcher with flags from the same state.json, or before this server ran).
  // Unknown counts as different once the user has requested a value since the
  // proxy was first seen; until then no restart is suggested.
  function proxyKey(p) {
    return p ? `${p.pid ?? '-'}:${p.port}` : null;
  }

  function trackProxy() {
    const p = cache.proxy;
    if (!p || !p.running || p.managedBy === 'service') {
      cache.wildcardApplied = null;
      return;
    }
    const key = proxyKey(p);
    if (cache.wildcardApplied?.key !== key) cache.wildcardApplied = { key, value: null, requested: false };
  }

  function wildcardDiffers(requested) {
    const a = cache.wildcardApplied;
    const p = cache.proxy;
    if (!a || !p || !p.running || a.key !== proxyKey(p)) return false;
    if (typeof a.value === 'boolean') return a.value !== Boolean(requested);
    return a.requested;
  }

  function bannersNow() {
    const changing = Boolean(cache.job && !cache.job.finishedAt && String(cache.job.action).startsWith('service-'));
    return bannersView({ proxy: cache.proxy, network: cache.network, dismissed: store.dismissed, portlessInstalled: portlessInstalled(), pausedByUser: store.paused, changing, routesAccess: cache.routesAccess });
  }

  function part(key) {
    switch (key) {
      case 'proxy':
        return proxyView();
      case 'routes':
        return routesView();
      case 'services':
        return servicesView();
      case 'network':
        return networkView();
      case 'settings':
        return settingsNow();
      case 'banners':
        return bannersNow();
      case 'capabilities':
        return capabilitiesView(cache.proxy, platform);
      default:
        throw new Error(`unknown part ${key}`);
    }
  }

  function versions() {
    let portless = null;
    try {
      portless = adapter.findPortless()?.version ?? null;
    } catch {
      portless = null;
    }
    return { nidum: VERSION, portless, node: process.versions.node };
  }

  /** The full /api/state body (Contracts §5). */
  function snapshot() {
    return {
      proxy: proxyView(),
      routes: routesView(),
      routesUnavailable: !cache.routesOk,
      routesAccess: cache.routesAccess ? { ...cache.routesAccess } : null,
      services: servicesView(),
      scannedAt: cache.scannedAt,
      network: networkView(),
      settings: settingsNow(),
      capabilities: capabilitiesView(cache.proxy, platform),
      versions: versions(),
      banners: bannersNow(),
      updatedAt: cache.updatedAt || new Date().toISOString(),
    };
  }

  /**
   * Report every sub-object whose JSON changed since the last report. A change of
   * `routesAccess` (E13) is reported as one full `state` event instead, which
   * carries every sub-object (so no partial events follow for the same change).
   */
  function emitChanges() {
    const accessJson = JSON.stringify(cache.routesAccess);
    const accessFirst = !sent.has('routesAccess');
    if (sent.get('routesAccess') !== accessJson) {
      sent.set('routesAccess', accessJson);
      if (!accessFirst) {
        const full = snapshot();
        for (const key of KEYS) sent.set(key, key === 'routes' ? `${cache.routesOk ? 1 : 0}${JSON.stringify(full[key])}` : JSON.stringify(full[key]));
        for (const l of listeners) {
          try {
            l('state', full);
          } catch (err) {
            log(`listener failed: ${err.message}`);
          }
        }
        return;
      }
    }
    for (const key of KEYS) {
      const data = part(key);
      // routesUnavailable flipping must produce a `routes` event even when the list stays [].
      const json = key === 'routes' ? `${cache.routesOk ? 1 : 0}${JSON.stringify(data)}` : JSON.stringify(data);
      if (sent.get(key) === json) continue;
      const first = !sent.has(key);
      sent.set(key, json);
      if (first) continue;
      for (const l of listeners) {
        try {
          l(key, data);
        } catch (err) {
          log(`listener failed: ${err.message}`);
        }
      }
    }
  }

  function pruneNames(routes) {
    const live = new Set(routes.filter((r) => !r.foreignTld).map((r) => r.name));
    const stale = store.names.filter((n) => !live.has(n));
    if (!stale.length) return;
    store.update((d) => {
      d.names = d.names.filter((n) => live.has(n));
    });
    for (const n of stale) cache.createdAt.delete(n);
    namesVersion += 1;
  }

  async function refreshCoreNow() {
    const settings = store.settings;
    try {
      cache.proxy = await withDeadline(adapter.getProxyState({ settings: { tls: settings.tls, port: settings.port, wildcard: settings.wildcard } }), deadlines.proxy, 'getProxyState');
      recovered('getProxyState');
      if (cache.proxy?.running && store.paused) store.update((d) => { d.paused = false; }); // any successful start ends a pause (D33)
      trackProxy();
    } catch (err) {
      failed('getProxyState', err);
    }
    try {
      cache.service = cache.proxy?.managedBy === 'service' ? adapter.getServiceConfig() : null;
    } catch {
      cache.service = null;
    }
    const versionAtRead = namesVersion;
    const mutationsAtRead = pendingMutations;
    try {
      const proxy = cache.proxy ? { port: cache.proxy.port, tls: cache.proxy.tls } : undefined;
      const routes = await withDeadline(adapter.listRoutes(proxy ? { proxy } : {}), deadlines.routes, 'listRoutes');
      if (!Array.isArray(routes)) throw new Error('listRoutes returned no list');
      recovered('listRoutes');
      cache.routes = routes;
      cache.routesOk = true;
      cache.routesError = null;
      // Contracts §2 N3 rule: prune only after a successful read, and never
      // when a mutation or a names change raced with this read.
      if (versionAtRead === namesVersion && mutationsAtRead === 0 && pendingMutations === 0) pruneNames(routes);
    } catch (err) {
      cache.routesError = { code: err?.code || 'INTERNAL', message: err?.message || String(err) };
      failed('listRoutes', err);
    }
    cache.updatedAt = new Date().toISOString();
    cache.lastAt.core = Date.now();
    emitChanges();
  }

  // --- E13: is routes.json locked or not writable? ---------------------------
  // Read-only adapter call (never throws in N1; a `stat` that hangs takes ~2 s).
  // Refreshed with every scan (in parallel, within the scan budget), forced after a
  // refused route write and on GET /api/state?refresh=1. A change emits `state`.
  //
  // Sharing (validation 8 F1): a plain (scan) read joins any read in flight. A forced read
  // never joins a read in flight, since that one may predate a lock flip (validation 6 F2,
  // validation 7 F1). Instead: while fewer than FORCED_ACCESS_READS forced reads run, a forced
  // caller starts its own; after that, every forced caller shares one follow-up read, started
  // when a running forced read ends. So each answer comes from a read that started after the
  // caller asked, forced reads in flight are capped at 2, and a burst of N costs ≤ 3 reads.
  // The second slot keeps a hung older read from delaying "Check again" or a refused write.
  const FORCED_ACCESS_READS = 2;
  let accessSeq = 0;
  let accessApplied = 0; // seq of the newest read that settled (answered, failed or unusable)
  let accessPlain = null; // in-flight non-forced read: { seq, p }
  const accessForced = []; // forced reads in flight, oldest first: { seq, p }
  let accessFollowUp = null; // the shared follow-up forced read, not started yet: { p, start }

  async function readRoutesAccess(refresh, seq) {
    try {
      const value = await withDeadline(adapter.getRoutesAccess({ refresh }), deadlines.routesAccess, 'getRoutesAccess');
      recovered('getRoutesAccess');
      const v = normalizeRoutesAccess(value);
      // a newer read that already settled wins; a failed or unusable read keeps the last good
      // value but still outdates older reads in flight, so their late answers are dropped
      // (validation 7 F3)
      if (seq > accessApplied) {
        accessApplied = seq;
        if (v) {
          cache.routesAccess = v;
          emitChanges();
        }
      }
    } catch (err) {
      if (seq > accessApplied) accessApplied = seq;
      failed('getRoutesAccess', err);
    }
    return cache.routesAccess;
  }

  function startAccessRead(refresh) {
    const seq = ++accessSeq;
    const entry = { seq, p: null };
    entry.p = readRoutesAccess(refresh, seq).finally(() => {
      if (!refresh) {
        if (accessPlain === entry) accessPlain = null;
        return;
      }
      accessForced.splice(accessForced.indexOf(entry), 1);
      // a slot is free: start the follow-up read every waiting forced caller shares
      if (accessFollowUp) {
        const next = accessFollowUp;
        accessFollowUp = null;
        next.start();
      }
    });
    if (refresh) accessForced.push(entry);
    else accessPlain = entry;
    return entry.p;
  }

  /**
   * @param {{ refresh?: boolean }} [opts]  refresh: a forced read (bypasses the adapter's 2 s
   *   cache); used after a refused route write, after a write that worked while the list was
   *   marked blocked, and for `?refresh=1`. A forced read always comes from a read started after
   *   this call (its own, or the shared follow-up); a plain read joins whatever runs.
   * @returns {Promise<object | null>} the current routesAccess (never rejects)
   */
  function refreshRoutesAccess({ refresh = false } = {}) {
    if (typeof adapter.getRoutesAccess !== 'function') return Promise.resolve(cache.routesAccess);
    if (!refresh) {
      const joinable = accessForced.at(-1)?.p || accessPlain?.p;
      return joinable || startAccessRead(false);
    }
    if (accessForced.length < FORCED_ACCESS_READS) return startAccessRead(true);
    if (!accessFollowUp) {
      let start;
      const p = new Promise((resolve) => {
        start = () => resolve(startAccessRead(true));
      });
      accessFollowUp = { p, start };
    }
    return accessFollowUp.p;
  }

  async function refreshServicesNow() {
    let res;
    const scanStarted = Date.now();
    const access = refreshRoutesAccess(); // E13: with every scan, in parallel
    try {
      res = await withDeadline(scan({ proxyPort: cache.proxy?.port ?? null, dashboardPort: dashboardPort() }), deadlines.scan, 'scan');
      recovered('scan');
    } catch (err) {
      failed('scan', err);
      cache.lastAt.services = Date.now();
      return;
    }
    cache.services = Array.isArray(res?.services) ? res.services : [];
    cache.scanErrors = Array.isArray(res?.errors) ? res.errors : [];
    cache.scannedAt = res?.scannedAt || new Date().toISOString();
    // F3 dashboard detection runs within what is left of the scan budget; anything
    // still running finishes in the background and reports a `services` event.
    const left = deadlines.scan - (Date.now() - scanStarted);
    const ident = identifyDashboardsOnce(cache.services);
    if (left > 0) await Promise.race([ident, new Promise((r) => setTimeout(r, left).unref?.())]);
    ident.then(() => emitChanges(), () => {});
    // the access read gets what is left of the scan budget; a slower one reports on its own
    const leftForAccess = deadlines.scan - (Date.now() - scanStarted);
    if (leftForAccess > 0) await Promise.race([access, new Promise((r) => setTimeout(r, leftForAccess).unref?.())]);
    cache.lastAt.services = Date.now();
    cache.lastScanDoneAt = Date.now();
    emitChanges();
  }

  async function refreshNetworkNow() {
    const lanIp = cache.proxy?.running && cache.proxy?.lan ? cache.proxy.lanIp : null;
    try {
      cache.network = await withDeadline(getNetwork({ proxyLanIp: lanIp || null }), deadlines.network, 'getNetwork');
      recovered('getNetwork');
    } catch (err) {
      failed('getNetwork', err);
      if (!cache.network) cache.network = { ...EMPTY_NETWORK, interfaces: [] };
    }
    cache.lastAt.network = Date.now();
    emitChanges();
  }

  async function probeOne(route) {
    let res;
    try {
      res = await withDeadline(probeRoute(route.port, route), deadlines.probe, 'probe');
    } catch {
      res = { status: 'error', statusDetail: { reason: 'probe-failed' } };
    }
    cache.statuses.set(route.hostname, { port: route.port, status: res.status, statusDetail: res.statusDetail ?? null, at: Date.now() });
  }

  async function probeAllNow() {
    const routes = cache.routes.slice();
    await mapLimit(routes, 8, probeOne);
    const known = new Set(cache.routes.map((r) => r.hostname));
    for (const h of cache.statuses.keys()) if (!known.has(h)) cache.statuses.delete(h);
    for (const h of cache.hostChecks.keys()) if (!known.has(h)) cache.hostChecks.delete(h);
    cache.lastAt.probes = Date.now();
    emitChanges();
  }

  const refreshCore = singleFlight(refreshCoreNow);
  const refreshServices = singleFlight(refreshServicesNow);
  const refreshNetwork = singleFlight(refreshNetworkNow);
  const probeAll = singleFlight(probeAllNow);

  function guard(p, what) {
    return p.catch((err) => log(`${what} failed: ${err?.message || err}`));
  }

  /** Kick off whatever is older than its interval (never awaited on a request path). */
  function refreshStale() {
    const now = Date.now();
    if (now - cache.lastAt.services >= intervals.services) guard(refreshServices(), 'scan');
    if (now - cache.lastAt.network >= intervals.network) guard(refreshNetwork(), 'network');
    if (now - cache.lastAt.probes >= intervals.probes) guard(probeAll(), 'probes');
  }

  function startLoop() {
    if (timers.length || closed) return;
    const every = (ms, fn, what) => {
      const t = setInterval(() => guard(fn(), what), ms);
      t.unref?.();
      timers.push(t);
    };
    every(intervals.core, refreshCore, 'core refresh');
    every(intervals.services, refreshServices, 'scan');
    every(intervals.probes, probeAll, 'probes');
    every(intervals.network, refreshNetwork, 'network');
  }

  function stopLoop() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  return {
    cache,
    snapshot,
    part,
    emitChanges,
    refreshCore,
    refreshServices,
    refreshNetwork,
    probeAll,
    refreshStale,
    refreshRoutesAccess,
    /** Probe one route now (after a create or port change), then report. */
    async probeRoute(route) {
      await probeOne(route);
      emitChanges();
    },
    /** Warm every cache once (startup). */
    async warm() {
      await guard(refreshCore(), 'core refresh');
      await Promise.all([guard(refreshNetwork(), 'network'), guard(refreshServices(), 'scan'), guard(probeAll(), 'probes')]);
    },
    /** The background loop runs while at least one holder (SSE client) exists. */
    retain() {
      holders += 1;
      if (holders === 1) startLoop();
    },
    release() {
      holders = Math.max(0, holders - 1);
      if (holders === 0) stopLoop();
    },
    get holders() {
      return holders;
    },
    get looping() {
      return timers.length > 0;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Wrap a route mutation: no name pruning while it runs. */
    async mutate(fn) {
      pendingMutations += 1;
      try {
        return await fn();
      } finally {
        pendingMutations -= 1;
      }
    },
    /** Change state.json names (bumps the version so a racing refresh doesn't prune). */
    updateNames(fn) {
      namesVersion += 1;
      store.update((d) => {
        d.names = fn(d.names.slice());
      });
    },
    markCreated(name) {
      cache.createdAt.set(name, new Date().toISOString());
    },
    forgetCreated(name) {
      cache.createdAt.delete(name);
    },
    setHostCheck(route, check) {
      cache.hostChecks.set(route.hostname, { port: route.port, check });
      emitChanges();
    },
    /** Forget a stored host check (the route was created, changed or removed). */
    clearHostCheck(hostname) {
      if (cache.hostChecks.delete(hostname)) emitChanges();
    },
    setJob(job) {
      cache.job = job;
      emitChanges();
    },
    /** Nidum just started the proxy (`state` from the adapter) with this wildcard value. */
    noteStarted(state, wildcard) {
      if (state && state.running && state.managedBy !== 'service') {
        cache.proxy = { ...state };
        cache.wildcardApplied = { key: proxyKey(state), value: Boolean(wildcard), requested: false };
      }
      emitChanges();
    },
    /** The user requested a wildcard value (PATCH /api/settings). */
    noteWildcardRequested() {
      trackProxy();
      if (cache.wildcardApplied) cache.wildcardApplied.requested = true;
    },
    /** E11: mark (or clear) a user pause. */
    setPausedByUser(on) {
      store.update((d) => {
        d.paused = Boolean(on);
      });
      emitChanges();
    },
    decorate,
    close() {
      closed = true;
      stopLoop();
      listeners.clear();
    },
  };
}
