// HTTP handler for Nidum Local's dashboard and JSON API (node N3).
//
// Contracts §4–§8: session cookie / token, /api/health, /api/state, SSE,
// errors, mutations. Everything external (adapter, discovery, network,
// probes) is injected so tests run against fakes.
//
// Request pipeline: ready gate → security headers → Host check (403) →
// Origin / Sec-Fetch-Site check (403) → auth (401: JSON for /api, HTML
// otherwise) → mutations need application/json (415) → NIDUM_READ_ONLY (403)
// → handler. Static files only from public/, no traversal.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES as ADAPTER_CODES, PortlessError, TLD, validateName as defaultValidateName, validatePort } from './portless.js';
import {
  APP_ID,
  DEADLINES,
  StateStore,
  VERSION,
  createLiveState,
  hostCheck as defaultHostCheck,
  isListedLanIp,
  isUnicastIPv4,
  SERVICE_PAUSE_PLATFORMS,
  nidumHome,
  seedSettings,
  withDeadline,
} from './state.js';
import { createDeviceSetup } from './setup-device.js';

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Content-Security-Policy for every response (N3 note). */
export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
export const COOKIE_NAME = 'nidum_session';
const MAX_BODY = 64 * 1024;

/** HTTP status per API error code (Contracts §7). Every adapter code maps to exactly one status. */
export const ERROR_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  INVALID_NAME: 400,
  INVALID_PORT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NAME_TAKEN: 409,
  NAME_TAKEN_BY_APP: 409,
  SERVICE_MANAGED: 409,
  PORT_IN_USE: 409,
  BUSY: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNSUPPORTED: 422,
  PERMISSION: 423,
  ROUTES_LOCKED: 423,
  ROUTES_NOT_WRITABLE: 423,
  INTERNAL: 500,
  PROXY_DOWN: 502,
  CLI_MISSING: 502,
  STATE_UNREADABLE: 503,
  TIMEOUT: 504,
});

/** Adapter code → API code (only UNKNOWN is renamed). */
export function apiCodeFor(adapterCode) {
  if (adapterCode === 'UNKNOWN') return 'INTERNAL';
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, adapterCode) ? adapterCode : 'INTERNAL';
}

const DEFAULT_MESSAGES = {
  BAD_REQUEST: 'That request isn’t valid.',
  UNAUTHORIZED: 'Open Nidum Local from its launcher again.',
  FORBIDDEN: 'This request isn’t allowed.',
  NOT_FOUND: 'Not found.',
  UNSUPPORTED_MEDIA_TYPE: 'Send JSON (Content-Type: application/json).',
  INTERNAL: 'Something went wrong. Nothing was changed.',
  STATE_UNREADABLE: 'Couldn’t read the address list just now. Try again.',
  BUSY: 'Another sharing change is still running. Try again when it finishes.',
  TIMEOUT: 'This is taking longer than expected.',
};

/** Error with an API code; `status` comes from ERROR_STATUS. */
export class ApiError extends Error {
  constructor(code, message, { details, raw } = {}) {
    super(message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.INTERNAL);
    this.code = Object.prototype.hasOwnProperty.call(ERROR_STATUS, code) ? code : 'INTERNAL';
    this.status = ERROR_STATUS[this.code];
    if (details !== undefined) this.details = details;
    if (raw !== undefined) this.raw = raw;
  }
}

/**
 * Anything thrown → `{ status, body: { error: { code, message, details?, raw? } } }`.
 * @param {unknown} err
 */
export function toErrorResponse(err) {
  let code = 'INTERNAL';
  let message;
  let details;
  let raw;
  if (err instanceof ApiError) {
    ({ code, message, details, raw } = err);
  } else if (err instanceof PortlessError || (err && typeof err.code === 'string' && ADAPTER_CODES.includes(err.code))) {
    code = apiCodeFor(err.code);
    message = code === 'STATE_UNREADABLE' ? DEFAULT_MESSAGES.STATE_UNREADABLE : err.message;
    details = err.details;
    raw = err.raw;
    if (code === 'INTERNAL' && raw === undefined && err.code !== 'UNKNOWN') raw = err.message;
  } else {
    message = DEFAULT_MESSAGES.INTERNAL;
    raw = err && err.message ? String(err.message) : String(err);
  }
  const error = { code, message: message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.INTERNAL };
  if (details !== undefined) error.details = details;
  if (raw !== undefined && raw !== '') error.raw = raw;
  return { status: ERROR_STATUS[code] ?? 500, body: { error } };
}

/** Doctor status → output-panel glyph (F21). */
export const DOCTOR_GLYPHS = Object.freeze({ ok: '✓', warn: '!', fail: '✗', info: '·' });

/** What `portless clean` removes (Portless 0.15.6 `clean --help`, cli.js:5766–5770), in plain words. */
export const CLEAN_REMOVES = Object.freeze([
  'Stops sharing (the Portless proxy) if it is running.',
  'Removes the startup service, so sharing no longer starts with this computer.',
  'Removes the Portless certificate from this computer’s trusted certificates, if Portless added it.',
  'Deletes Portless’s files: every address, settings and certificates in ~/.portless, the system state folder and PORTLESS_STATE_DIR.',
  'Removes the Portless block from /etc/hosts.',
]);

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function htmlPage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1a1a1a;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}}main{max-width:28rem;padding:1rem}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

const UNAUTHORIZED_HTML = htmlPage('Nidum Local', 'Open Nidum Local from its launcher again.');
const PLACEHOLDER_HTML = htmlPage('Nidum Local', 'The dashboard page isn’t installed. Your addresses keep working.');

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

function sendError(res, err) {
  const { status, body } = toErrorResponse(err);
  sendJson(res, status, body, err && err.closeConnection ? { connection: 'close' } : {});
}

function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html), ...extra });
  res.end(html);
}

/** Every value of cookie `name` (a planted duplicate must not shadow the real one). */
function cookieValues(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Bytes of an oversized body we keep draining (so the 400 reaches the client) before cutting the connection. */
const DRAIN_LIMIT = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    const declared = Number(req.headers['content-length']);
    const fail = () => {
      tooLarge = true;
      reject(Object.assign(new ApiError('BAD_REQUEST', 'That request is too large.', { details: { limit: MAX_BODY } }), { closeConnection: true }));
    };
    if (Number.isFinite(declared) && declared > MAX_BODY) fail();
    req.on('data', (c) => {
      size += c.length;
      if (tooLarge) {
        if (size > DRAIN_LIMIT) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        chunks.length = 0;
        fail();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

async function jsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('BAD_REQUEST', 'That request isn’t valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError('BAD_REQUEST', 'Send a JSON object.');
  return parsed;
}

function isJson(req) {
  return /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''));
}

/** Find a route by user-facing name, `<name>.local` or full hostname. */
function findRoute(routes, key) {
  const k = String(key || '').toLowerCase();
  return (
    routes.find((r) => !r.foreignTld && r.name === k) ||
    routes.find((r) => r.hostname === k) ||
    (k.endsWith(`.${TLD}`) ? routes.find((r) => !r.foreignTld && r.name === k.slice(0, -(TLD.length + 1))) : undefined)
  );
}

function takenByApp(name, route) {
  return new ApiError('NAME_TAKEN_BY_APP', `${name} is used by a running app. Stop that app or pick another name.`, { details: { route } });
}

function nameTaken(name, route) {
  return new ApiError('NAME_TAKEN', `${name} already points to port ${route.port}.`, { details: { route } });
}

/**
 * Create the app (handler + live model). Call `await app.init()` before serving.
 *
 * @param {object} options
 * @param {object} options.adapter  N1 adapter (createPortless) or a fake with the same surface
 * @param {{ scan: Function }} options.discovery  N2 discovery (or fake)
 * @param {{ getNetwork: Function }} options.network  N2 network (or fake)
 * @param {string} [options.home]  NIDUM_HOME (default from env)
 * @param {string} [options.token]  session token (default: 32 random bytes, hex)
 * @param {string} [options.publicDir]
 * @param {boolean} [options.readOnly]  NIDUM_READ_ONLY: every mutation → 403
 * @param {boolean} [options.lanMode]  start the proxy with --lan (default true; tests pass false)
 * @param {object} [options.intervals]  { core, services, probes, network, heartbeat } in ms
 * @param {object} [options.deadlines]  overrides for state.js DEADLINES (tests)
 * @param {number} [options.hostCheckBudgetMs]  cap for one host check, retries included (default 5000)
 * @param {number} [options.notRoutedRetryMs]  how long a `not-routed` host check is retried (default 2000)
 * @param {NodeJS.Platform} [options.platform]  (tests) decides whether a service-managed proxy can be paused (E12)
 * @param {number} [options.forcedScanMinMs]  `?refresh=1` reuses a scan finished less than this ago (default 2000)
 * @param {(port: number) => Promise<object>} [options.probeRoute]
 * @param {(input: object) => Promise<object>} [options.hostCheck]
 * @param {(lanIp: string) => string} [options.setupBindAddress]  bind address for the device-setup page (tests: () => '127.0.0.1')
 * @param {(caPath: string) => string} [options.readCa]  (tests)
 * @param {() => void} [options.onQuit]  called after POST /api/quit has answered
 * @param {(msg: string) => void} [options.log]
 */
export function createApp(options) {
  const adapter = options.adapter;
  const discovery = options.discovery;
  const network = options.network;
  const home = options.home || nidumHome();
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
  const readOnly = Boolean(options.readOnly);
  const lanMode = options.lanMode !== false;
  const heartbeatMs = options.intervals?.heartbeat ?? 15000;
  const log = options.log || (() => {});
  const onQuit = options.onQuit || (() => {});
  const validateName = adapter.validateName || defaultValidateName;
  const deadlines = { ...DEADLINES, ...(options.deadlines || {}) };
  const forcedScanMinMs = options.forcedScanMinMs ?? 2000;
  const platform = options.platform || process.platform;
  const notRoutedRetryMs = options.notRoutedRetryMs ?? 2000;
  const hostCheckBudgetMs = options.hostCheckBudgetMs ?? 5000;
  const store = new StateStore(home);
  let port = null;
  let readyResolve;
  const ready = new Promise((r) => {
    readyResolve = r;
  });

  const live = createLiveState({
    adapter,
    store,
    scan: (o) => discovery.scan(o),
    getNetwork: (o) => network.getNetwork(o),
    probeRoute: options.probeRoute,
    dashboardPort: () => port,
    intervals: options.intervals,
    deadlines,
    platform,
    log,
  });
  const runHostCheck = options.hostCheck || defaultHostCheck;

  // ---- SSE hub (Contracts §6) ------------------------------------------------
  const clients = new Set();
  let eventId = 0;
  let heartbeat = null;

  function frame(event, data, id) {
    return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function broadcast(event, data) {
    eventId += 1;
    const text = frame(event, data, eventId);
    for (const res of clients) {
      try {
        res.write(text);
      } catch {
        /* closed */
      }
    }
  }

  live.subscribe((key, data) => broadcast(key, data));

  function closeClients() {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
    clients.clear();
  }

  /** Heartbeat payload (§6 + E10): `at`, plus when proxy/routes and services were last read. */
  function heartbeatData() {
    return { at: new Date().toISOString(), updatedAt: live.cache.updatedAt || null, scannedAt: live.cache.scannedAt || null };
  }

  function events(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.socket?.setNoDelay?.(true);
    res.write(`retry: 2000\n${frame('state', live.snapshot(), eventId)}`);
    clients.add(res);
    live.retain();
    if (!heartbeat) {
      heartbeat = setInterval(() => broadcast('heartbeat', heartbeatData()), heartbeatMs);
      heartbeat.unref?.();
    }
    const done = () => {
      if (!clients.delete(res)) return;
      live.release();
      if (clients.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    res.on('close', done);
    live.refreshCore().then(() => live.refreshStale(), () => {});
  }

  // ---- proxy jobs (Contracts §8) ---------------------------------------------
  let jobSeq = 0;
  let current = null;

  function jobView(job) {
    return job ? { ...job, error: job.error ? { ...job.error } : null } : null;
  }

  /**
   * One job at a time. The same action while it runs → that job (`reused: true`);
   * a different action → 409 BUSY with the running job in `details.job`.
   */
  function startJob(action, fn) {
    if (current && !current.finishedAt) {
      if (current.action === action) return { job: jobView(current), reused: true };
      throw new ApiError('BUSY', undefined, { details: { job: jobView(current) } });
    }
    const job = {
      id: `job-${Date.now().toString(36)}-${++jobSeq}`,
      action,
      phase: action === 'stop' || action === 'service-stop' ? 'stopping' : 'starting',
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    current = job;
    live.setJob(jobView(job));
    (async () => {
      try {
        await fn(job);
        job.phase = 'done';
      } catch (err) {
        job.phase = 'failed';
        job.error = toErrorResponse(err).body.error;
        log(`${action} failed: ${job.error.code} ${job.error.message}`);
      } finally {
        job.finishedAt = new Date().toISOString();
        await live.refreshCore().catch(() => {});
        live.setJob(jobView(job));
      }
    })();
    return { job: jobView(job), reused: false };
  }

  /** Called by the server's elevate wrapper while the OS password dialog is up. */
  function elevationStarted() {
    if (current && !current.finishedAt) {
      current.phase = 'waitingForPassword';
      live.setJob(jobView(current));
    }
  }

  function elevationEnded() {
    if (current && !current.finishedAt && current.phase === 'waitingForPassword') {
      current.phase = current.action === 'stop' || current.action === 'service-stop' ? 'stopping' : 'starting';
      live.setJob(jobView(current));
    }
  }

  /**
   * D27: the saved `fixedIp` is used only while this computer lists it (checked
   * now); otherwise it stays in state.json and the flags go without `--ip`.
   */
  async function usableFixedIp() {
    const saved = store.settings.fixedIp;
    if (!saved) return null;
    const n = await currentNetwork();
    if (isListedLanIp(saved, n)) return saved;
    log(`fixedIp ${saved} not used: this computer doesn't list that address right now`);
    return null;
  }

  /** Proxy start flags from the saved settings. */
  async function startSettings() {
    const s = store.settings;
    return { tls: s.tls, port: s.port, lan: lanMode, fixedIp: lanMode ? await usableFixedIp() : null, wildcard: s.wildcard };
  }

  /** Request-path deadline: a hung dependency answers 504 TIMEOUT instead of never. */
  async function bounded(promise, ms, what) {
    try {
      return await withDeadline(promise, ms, what);
    } catch (err) {
      if (err && err.code === 'TIMEOUT' && !(err instanceof PortlessError)) throw new PortlessError('TIMEOUT', undefined, { raw: err.message });
      throw err;
    }
  }

  async function freshProxy() {
    const s = store.settings;
    return bounded(adapter.getProxyState({ settings: { tls: s.tls, port: s.port, wildcard: s.wildcard } }), deadlines.proxy, 'getProxyState');
  }

  async function freshRoutes() {
    const proxy = live.cache.proxy;
    return bounded(adapter.listRoutes(proxy ? { proxy: { port: proxy.port, tls: proxy.tls } } : {}), deadlines.routes, 'listRoutes');
  }

  function notOwnPort(p) {
    if (port !== null && p === port) {
      throw new ApiError('BAD_REQUEST', 'That’s Nidum Local’s own port. It can’t get an address.', { details: { port: p } });
    }
  }

  // ---- device setup ------------------------------------------------------------
  /** LAN IP for the device-setup page (D21): running LAN proxy → saved fixed IP → network. */
  /** The network as this computer lists it right now (fresh, bounded; falls back to the cache). */
  async function currentNetwork() {
    try {
      return await withDeadline(network.getNetwork({ proxyLanIp: null }), deadlines.network, 'getNetwork');
    } catch {
      return live.cache.network;
    }
  }

  /**
   * LAN IP for the device-setup page (D21, D27): the first of running LAN
   * proxy `lanIp` → saved `fixedIp` → `network.ip` that is a unicast IPv4
   * this computer currently lists; else null (→ 422 no-network).
   */
  async function getLanIp() {
    const proxy = await freshProxy().catch(() => live.cache.proxy);
    const n = await currentNetwork();
    const candidates = [proxy?.running && proxy.lan ? proxy.lanIp : null, store.settings.fixedIp, n?.kind === 'none' ? null : n?.ip];
    return candidates.find((ip) => isListedLanIp(ip, n)) || null;
  }

  const deviceSetup = createDeviceSetup({
    adapter,
    getProxy: freshProxy,
    getLanIp,
    bindAddress: options.setupBindAddress,
    readCa: options.readCa,
    durationMs: options.setupDurationMs,
    onChange: (info, reason) => log(`device setup ${info ? `started on port ${info.port}` : `stopped (${reason})`}`),
  });

  // ---- handlers ----------------------------------------------------------------
  async function afterRouteChange(route) {
    await withDeadline(live.refreshCore(), deadlines.afterMutation, 'refresh').catch(() => {});
    if (route) live.probeRoute(route).catch(() => {});
    // E13: a write that worked proves the list is writable again; don't wait for the next scan
    // (a forced read never joins one already in flight, which may predate the unlock)
    const a = live.cache.routesAccess;
    if (a && (a.locked || !a.writable)) live.refreshRoutesAccess({ refresh: true }).catch(() => {});
  }

  /** Codes for a route write the OS refused (E13); never PERMISSION. */
  const REFUSED_WRITE = new Set(['ROUTES_LOCKED', 'ROUTES_NOT_WRITABLE']);

  /**
   * Run a route mutation. When the OS refuses the write (E13), re-read
   * routesAccess (bypassing the adapter's cache) before answering, bounded by
   * `deadlines.accessAfterRefused`; a slower read reports later with a `state` event.
   * The re-read is forced, so it comes from a read started after the refusal was seen
   * (its own, or the follow-up it shares with other callers): a read already in flight
   * then (even one started during this write's precondition read or its wait for
   * routes.lock) may have read the list before it was locked (validation 6 F2,
   * validation 7 F1, validation 8 F1).
   * The adapter's error (code, message, details, raw) is answered unchanged.
   */
  async function routeWrite(fn) {
    try {
      return await live.mutate(fn);
    } catch (err) {
      if (err && REFUSED_WRITE.has(err.code)) {
        await Promise.race([live.refreshRoutesAccess({ refresh: true }), new Promise((r) => setTimeout(r, deadlines.accessAfterRefused).unref?.())]);
      }
      throw err;
    }
  }

  async function createRoute(body) {
    const name = validateName(body.name);
    const p = validatePort(body.port);
    notOwnPort(p);
    const force = body.force === true;
    return routeWrite(async () => {
      const routes = await freshRoutes();
      const existing = routes.find((r) => r.hostname === `${name}.${TLD}`);
      if (existing && existing.pid !== 0) throw takenByApp(name, existing);
      if (existing && !force) throw nameTaken(name, existing);
      const route = await adapter.addAlias(name, p, { force });
      live.clearHostCheck(route.hostname);
      live.updateNames((names) => [...names, route.name]);
      live.markCreated(route.name);
      await afterRouteChange(route);
      return live.decorate(route);
    });
  }

  async function patchRoute(key, body) {
    const hasPort = body.port !== undefined;
    const hasName = body.newName !== undefined;
    if (hasPort === hasName) throw new ApiError('BAD_REQUEST', 'Send either a new port or a new name.');
    const newPort = hasPort ? validatePort(body.port) : null;
    if (hasPort) notOwnPort(newPort);
    const newName = hasName ? validateName(body.newName) : null;
    const force = body.force === true;
    return routeWrite(async () => {
      const routes = await freshRoutes();
      const route = findRoute(routes, key);
      if (!route) throw new ApiError('NOT_FOUND', `There's no address called ${key}.`);
      if (route.foreignTld) throw new ApiError('UNSUPPORTED', 'Addresses with a different suffix can only be removed.');
      if (route.pid !== 0) throw takenByApp(route.name, route);
      if (hasPort) {
        const updated = await adapter.changePort(route.name, newPort);
        live.clearHostCheck(updated.hostname);
        await afterRouteChange(updated);
        return live.decorate(updated);
      }
      if (newName !== route.name) {
        const clash = routes.find((r) => r.hostname === `${newName}.${TLD}`);
        if (clash && clash.pid !== 0) throw takenByApp(newName, clash);
        if (clash && !force) throw nameTaken(newName, clash);
      }
      const renamed = await adapter.renameAlias(route.name, newName, { force });
      live.clearHostCheck(route.hostname);
      live.clearHostCheck(renamed.hostname);
      const wasOurs = store.names.includes(route.name);
      live.updateNames((names) => {
        const next = names.filter((n) => n !== route.name);
        if (wasOurs) next.push(renamed.name);
        return next;
      });
      if (wasOurs) live.markCreated(renamed.name);
      live.forgetCreated(route.name);
      await afterRouteChange(renamed);
      return live.decorate(renamed);
    });
  }

  async function deleteRoute(key) {
    return routeWrite(async () => {
      const routes = await freshRoutes();
      const route = findRoute(routes, key);
      if (!route) throw new ApiError('NOT_FOUND', `There's no address called ${key}.`);
      if (route.pid !== 0) throw takenByApp(route.name, route);
      const before = live.decorate(route);
      const removed = await adapter.removeAlias(route.foreignTld ? route.hostname : route.name);
      live.clearHostCheck(route.hostname);
      live.updateNames((names) => names.filter((n) => n !== route.name || route.foreignTld));
      live.forgetCreated(route.name);
      await afterRouteChange(null);
      return { ...before, ...removed, source: before.source, status: before.status, statusDetail: before.statusDetail, hostCheck: before.hostCheck, createdAt: before.createdAt };
    });
  }

  /**
   * Host check through the proxy. Portless reloads routes on a file watch about
   * 100 ms after a change, so a `not-routed` answer is retried for up to
   * NOT_ROUTED_RETRY_MS before it is reported (N6 validation 1).
   */
  async function checkRoute(key) {
    const routes = await freshRoutes();
    const route = findRoute(routes, key);
    if (!route) throw new ApiError('NOT_FOUND', `There's no address called ${key}.`);
    const service = live.cache.services.find((s) => s.port === route.port);
    const start = Date.now();
    const overall = start + hostCheckBudgetMs; // the whole check, retries included (E5: ~5 s)
    const retryUntil = Math.min(start + notRoutedRetryMs, overall - 300);
    let check;
    for (;;) {
      const proxy = await freshProxy();
      check = await runHostCheck({ route, proxy: proxy.running ? proxy : null, framework: service?.http?.framework ?? null, deadline: overall });
      if (check.result !== 'not-routed' || Date.now() >= retryUntil) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    live.setHostCheck(route, check);
    return check;
  }

  async function proxyAction(action) {
    const proxy = await freshProxy();
    if (proxy.managedBy === 'service') return serviceProxyAction(action);
    return startJob(action, async (job) => {
      if (action === 'stop' || (action === 'restart' && (proxy.running || proxy.pid !== null))) {
        if (action === 'restart') job.phase = 'stopping';
        live.setJob(jobView(job));
        await adapter.stopProxy();
      }
      if (action === 'start' || action === 'restart') {
        job.phase = 'starting';
        live.setJob(jobView(job));
        const settings = await startSettings();
        const started = await adapter.startProxy(settings);
        // a start that found a proxy already answering doesn't apply settings (N1 contract)
        if (!(action === 'start' && proxy.running)) live.noteStarted(started, settings.wildcard);
        live.setPausedByUser(false);
      } else {
        live.setPausedByUser(true); // E11: a stop through the API is a user pause
      }
    });
  }

  /**
   * E12 (D43): a service-managed proxy is paused/resumed by stopping/starting the
   * startup service (the plist stays, so it returns at the next boot). Restart
   * stays 409 SERVICE_MANAGED; so does everything on platforms without support.
   */
  function serviceProxyAction(action) {
    if (action === 'restart' || !SERVICE_PAUSE_PLATFORMS.includes(platform)) {
      throw new ApiError('SERVICE_MANAGED', 'Sharing is kept on by the startup service. Turn off Keep sharing after restart to change this.');
    }
    const fn = action === 'stop' ? adapter.stopService : adapter.startService;
    if (typeof fn !== 'function') throw new ApiError('UNSUPPORTED', 'This version can’t stop the startup service yet.');
    return startJob(`service-${action}`, async () => {
      await fn.call(adapter);
      live.setPausedByUser(action === 'stop'); // stop = a user pause (E11, D33); start clears it
    });
  }

  async function serviceAction(body) {
    const action = body.action ?? 'apply';
    if (!['apply', 'install', 'uninstall'].includes(action)) throw new ApiError('BAD_REQUEST', 'action must be apply, install or uninstall.');
    const install = action === 'install' || (action === 'apply' && store.settings.keepAfterRestart);
    const s0 = store.settings;
    const settings = { tls: s0.tls, port: s0.port, lan: true, fixedIp: await usableFixedIp(), wildcard: s0.wildcard };
    return startJob(install ? 'service-install' : 'service-uninstall', async (job) => {
      if (install) {
        await adapter.serviceInstall(settings);
        return;
      }
      const wasPaused = store.paused;
      await adapter.serviceUninstall();
      // D45: a deliberate pause stays a pause — remove the service, start nothing.
      if (wasPaused) return;
      // Graph validation 2 F1: removing the startup service stops its proxy (launchctl
      // bootout). Keep sharing on: start the manual proxy from the saved settings in the
      // same job. These are two separate elevated commands, so the OS may ask twice; each
      // dialog shows as `waitingForPassword`.
      job.phase = 'starting';
      live.setJob(jobView(job));
      const startWith = await startSettings();
      try {
        const started = await adapter.startProxy(startWith);
        live.noteStarted(started, startWith.wildcard);
        live.setPausedByUser(false);
      } catch (err) {
        // Not a crash: show the paused info banner (with Resume), not sharing-off.
        live.setPausedByUser(true);
        const why = err && err.message ? err.message : 'Something went wrong.';
        throw new PortlessError(err?.code && err.code !== 'UNKNOWN' ? err.code : 'UNKNOWN', `Keep sharing after restart is off. Sharing didn’t start again: ${why} Use Resume sharing to try again.`, { raw: err?.raw, details: { step: 'start-after-uninstall' } });
      }
    });
  }

  async function patchSettings(body) {
    const allowed = ['tls', 'port', 'fixedIp', 'wildcard', 'keepAfterRestart'];
    const keys = Object.keys(body);
    if (!keys.length) throw new ApiError('BAD_REQUEST', 'Nothing to change.');
    const bad = keys.filter((k) => !allowed.includes(k));
    if (bad.length) throw new ApiError('BAD_REQUEST', `Unknown setting: ${bad.join(', ')}.`, { details: { keys: bad } });
    const next = {};
    for (const k of ['tls', 'wildcard', 'keepAfterRestart']) {
      if (k in body) {
        if (typeof body[k] !== 'boolean') throw new ApiError('BAD_REQUEST', `${k} must be true or false.`);
        next[k] = body[k];
      }
    }
    if ('port' in body) next.port = validatePort(body.port);
    if ('fixedIp' in body) {
      if (body.fixedIp !== null) {
        if (!isUnicastIPv4(body.fixedIp)) {
          throw new ApiError('BAD_REQUEST', `${body.fixedIp} isn’t a usable network address.`, { details: { fixedIp: body.fixedIp, reason: 'not-unicast' } });
        }
        const n = await currentNetwork();
        if (n) live.cache.network = n;
        if (!isListedLanIp(body.fixedIp, n)) {
          throw new ApiError('BAD_REQUEST', `${body.fixedIp} isn’t an address of this computer right now.`, { details: { fixedIp: body.fixedIp, reason: 'not-listed' } });
        }
      }
      next.fixedIp = body.fixedIp;
    }
    const wildcardChanged = 'wildcard' in next && next.wildcard !== store.settings.wildcard;
    store.update((d) => {
      d.settings = { ...d.settings, ...next };
    });
    if (wildcardChanged) live.noteWildcardRequested();
    live.emitChanges();
    return live.part('settings');
  }

  async function runTool(tool, body) {
    switch (tool) {
      case 'doctor': {
        const res = await adapter.doctor();
        return {
          tool,
          findings: (res.findings || []).map((f) => ({ ...f, glyph: DOCTOR_GLYPHS[f.status] || '·' })),
          summary: res.summary ?? null,
          header: res.header || {},
          raw: res.raw ?? '',
        };
      }
      case 'trust': {
        const res = await adapter.trust();
        return { tool, ok: true, raw: res?.output ?? '' };
      }
      case 'hosts-sync': {
        const res = await adapter.hostsSync();
        return { tool, ok: true, raw: res?.output ?? '' };
      }
      case 'prune': {
        const res = await adapter.prune();
        const raw = res?.output ?? '';
        const stopped = raw.split('\n').filter((l) => /killed PID/i.test(l)).map((l) => l.trim());
        return { tool, ok: true, count: stopped.length, stopped, raw };
      }
      case 'clean': {
        if (body.confirm !== 'reset') {
          throw new ApiError('BAD_REQUEST', 'Type reset to confirm.', { details: { confirm: 'reset', removes: [...CLEAN_REMOVES] } });
        }
        const res = await adapter.clean();
        await live.refreshCore().catch(() => {});
        return { tool, ok: true, removed: [...CLEAN_REMOVES], raw: res?.output ?? '' };
      }
      default:
        throw new ApiError('NOT_FOUND', `There's no tool called ${tool}.`);
    }
  }

  function patchUi(body) {
    const id = body.dismiss;
    if (typeof id !== 'string') throw new ApiError('BAD_REQUEST', 'Send { "dismiss": "<banner id>" }.');
    let entry;
    if (id === 'first-run') entry = 'first-run';
    else if (id === 'public-network') {
      const ssid = typeof body.ssid === 'string' && body.ssid ? body.ssid : live.cache.network?.ssid;
      if (!ssid) throw new ApiError('BAD_REQUEST', 'No network name to dismiss this for.');
      entry = `public-network:${ssid}`;
    } else throw new ApiError('BAD_REQUEST', `The ${id} notice can't be dismissed.`);
    store.update((d) => {
      d.dismissed = [...d.dismissed, entry];
    });
    live.emitChanges();
    return { banners: live.part('banners'), dismissed: [...store.dismissed] };
  }

  // ---- routing ---------------------------------------------------------------------
  /** Read-only mode still allows these (they change nothing in Portless or state.json). */
  const READ_ONLY_ALLOWED = [/^POST \/api\/quit$/, /^POST \/api\/routes\/[^/]+\/check$/, /^POST \/api\/tools\/doctor$/];

  async function api(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    let seg;
    try {
      seg = p.split('/').slice(2).map((x) => decodeURIComponent(x)); // after /api
    } catch {
      throw new ApiError('BAD_REQUEST', 'That address isn’t valid.');
    }
    const mutation = method !== 'GET' && method !== 'HEAD';
    let body = {};
    if (mutation) {
      if (readOnly && !READ_ONLY_ALLOWED.some((re) => re.test(`${method} ${p}`))) {
        throw new ApiError('FORBIDDEN', 'Read-only mode: nothing can be changed.');
      }
      if (!isJson(req)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
      body = await jsonBody(req);
    }
    const route = `${method} /${seg[0] ?? ''}`;
    if (method === 'GET' && seg.length === 1) {
      switch (seg[0]) {
        case 'state': {
          // E13: ?refresh=1 ("Check again") re-reads routesAccess without the adapter's cache,
          // in parallel with the core refresh and inside the same 3 s wait. Its answer comes from
          // a read started after this request arrived (its own, or a shared follow-up): an older
          // one in flight may have read the list before the user locked or unlocked it
          // (validation 7 F1, validation 8 F1).
          const forced = url.searchParams.get('refresh') === '1' ? live.refreshRoutesAccess({ refresh: true }) : null;
          await Promise.race([Promise.all([live.refreshCore(), forced]), new Promise((r) => setTimeout(r, 3000).unref?.())]);
          live.refreshStale();
          return sendJson(res, 200, live.snapshot());
        }
        case 'routes':
          await Promise.race([live.refreshCore(), new Promise((r) => setTimeout(r, 3000).unref?.())]);
          live.refreshStale();
          if (!live.cache.routesOk) throw new ApiError('STATE_UNREADABLE');
          return sendJson(res, 200, live.part('routes'));
        case 'proxy':
        case 'network':
        case 'settings':
        case 'banners':
          await Promise.race([live.refreshCore(), new Promise((r) => setTimeout(r, 3000).unref?.())]);
          live.refreshStale();
          return sendJson(res, 200, live.part(seg[0]));
        case 'services':
          // E10: ?refresh=1 forces a scan now (bounded by the scan deadline); else serve the cache.
          // A scan that finished less than forcedScanMinMs ago answers instead of a new one.
          if (url.searchParams.get('refresh') === '1' && Date.now() - live.cache.lastScanDoneAt >= forcedScanMinMs) await live.refreshServices().catch(() => {});
          else live.refreshStale();
          return sendJson(res, 200, live.part('services'));
        case 'events':
          return events(req, res);
        case 'setup-device':
          return sendJson(res, 200, { setup: deviceSetup.info() });
        default:
          break;
      }
    }
    if (method === 'GET' && p === '/api/tools/clean') return sendJson(res, 200, { tool: 'clean', confirm: 'reset', removes: [...CLEAN_REMOVES] });
    if (route === 'POST /routes' && seg.length === 1) return sendJson(res, 201, await createRoute(body));
    if (seg[0] === 'routes' && seg.length === 2 && method === 'PATCH') return sendJson(res, 200, await patchRoute(seg[1], body));
    if (seg[0] === 'routes' && seg.length === 2 && method === 'DELETE') return sendJson(res, 200, { removed: await deleteRoute(seg[1]) });
    if (seg[0] === 'routes' && seg.length === 3 && seg[2] === 'check' && method === 'POST') return sendJson(res, 200, await checkRoute(seg[1]));
    if (seg[0] === 'proxy' && seg.length === 2 && method === 'POST' && ['start', 'stop', 'restart'].includes(seg[1])) {
      const { job, reused } = await proxyAction(seg[1]);
      return sendJson(res, 202, { job, reused });
    }
    if (route === 'PATCH /settings' && seg.length === 1) return sendJson(res, 200, await patchSettings(body));
    if (route === 'POST /service' && seg.length === 1) {
      const { job, reused } = await serviceAction(body);
      return sendJson(res, 202, { job, reused });
    }
    if (seg[0] === 'tools' && seg.length === 2 && method === 'POST') return sendJson(res, 200, await runTool(seg[1], body));
    if (route === 'POST /setup-device' && seg.length === 1) return sendJson(res, 201, { setup: await deviceSetup.start() });
    if (route === 'DELETE /setup-device' && seg.length === 1) return sendJson(res, 200, { stopped: await deviceSetup.stop('cancelled') });
    if (route === 'PATCH /ui' && seg.length === 1) return sendJson(res, 200, patchUi(body));
    if (route === 'POST /quit' && seg.length === 1) {
      sendJson(res, 202, { ok: true });
      const quit = () => setImmediate(() => onQuit());
      if (res.writableFinished) quit();
      else res.once('finish', quit);
      return undefined;
    }
    throw new ApiError('NOT_FOUND');
  }

  function staticFile(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendHtml(res, 404, htmlPage('Not found', 'There is nothing here.'));
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendHtml(res, 404, htmlPage('Not found', 'There is nothing here.'));
    }
    if (rel.includes('\0') || rel.split(/[\\/]/).some((s) => s === '..' || (s.startsWith('.') && s.length > 1))) {
      return sendHtml(res, 404, htmlPage('Not found', 'There is nothing here.'));
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(publicDir, `.${rel}`);
    const inside = (f, root) => f === root || f.startsWith(root + path.sep);
    let real = null;
    try {
      real = fs.realpathSync(file);
      const realRoot = fs.realpathSync(publicDir);
      if (!inside(real, realRoot) || !fs.statSync(real).isFile()) real = null;
    } catch {
      real = null;
    }
    if (!inside(file, publicDir) || !real) {
      if (rel === '/index.html') return sendHtml(res, 200, PLACEHOLDER_HTML);
      return sendHtml(res, 404, htmlPage('Not found', 'There is nothing here.'));
    }
    const data = fs.readFileSync(real);
    const type = CONTENT_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': type,
      'content-length': data.length,
      'cache-control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  function allowedHosts() {
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  }

  function authed(req) {
    return cookieValues(req.headers.cookie, COOKIE_NAME).some((v) => safeEqual(v, token)) || safeEqual(req.headers['x-nidum-token'], token);
  }

  /** The request handler for http.createServer. */
  async function handle(req, res) {
    await ready;
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return sendError(res, new ApiError('BAD_REQUEST'));
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const deny = (code, message) => (isApi ? sendError(res, new ApiError(code, message)) : sendHtml(res, code === 'UNAUTHORIZED' ? 401 : 403, code === 'UNAUTHORIZED' ? UNAUTHORIZED_HTML : htmlPage('Not allowed', message)));
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts().includes(host)) return deny('FORBIDDEN', 'Open Nidum Local at 127.0.0.1 from its launcher.');
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHosts().map((h) => `http://${h}`).includes(String(origin).toLowerCase())) {
        return deny('FORBIDDEN', 'Requests from other sites aren’t allowed.');
      }
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (site === 'cross-site' || site === 'same-site') return deny('FORBIDDEN', 'Requests from other sites aren’t allowed.');

      if (isApi) {
        if (url.pathname === '/api/health' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, app: APP_ID, version: VERSION, pid: process.pid });
        }
        if (!authed(req)) return deny('UNAUTHORIZED');
        return await api(req, res, url);
      }
      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!safeEqual(url.searchParams.get('t'), token)) return sendHtml(res, 401, UNAUTHORIZED_HTML);
        res.writeHead(302, {
          ...SECURITY_HEADERS,
          location: '/',
          'cache-control': 'no-store',
          'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'content-length': 0,
        });
        return res.end();
      }
      if (!authed(req)) return sendHtml(res, 401, UNAUTHORIZED_HTML);
      return staticFile(req, res, url);
    } catch (err) {
      if (!(err instanceof ApiError) && !(err instanceof PortlessError)) log(`request failed: ${err?.stack || err}`);
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      return isApi ? sendError(res, err) : sendHtml(res, 500, htmlPage('Nidum Local', 'Something went wrong. Nothing was changed.'));
    }
  }

  /**
   * Load or seed state.json (F1) and read proxy + routes once. The server calls `live.warm()` after listen().
   */
  async function init() {
    await store.load(async () => {
      const proxy = await adapter.getProxyState();
      let service = null;
      try {
        service = proxy.managedBy === 'service' ? adapter.getServiceConfig() : null;
      } catch {
        service = null;
      }
      return seedSettings(proxy, service);
    });
    for (const note of store.notes) log(note);
    // D27: a saved fixedIp this computer doesn't list right now stays in state.json; it is
    // reported as unavailable (settings.fixedIp reads null) and used only once it is listed.
    const fixed = store.settings.fixedIp;
    if (fixed) {
      const n = await withDeadline(network.getNetwork({ proxyLanIp: null }), deadlines.network, 'getNetwork').catch(() => null);
      if (n) live.cache.network = n;
      if (n && !isListedLanIp(fixed, n)) log(`state.json fixedIp ${fixed} kept but not used: this computer doesn't list that address right now`);
    }
    // E13: the first routesAccess read overlaps the first core refresh. It is bounded by
    // deadlines.routesAccess; this timer is ref'd because nothing listens yet to keep the process up.
    let timer;
    const bound = new Promise((r) => {
      timer = setTimeout(r, deadlines.routesAccess + 50);
    });
    await Promise.all([live.refreshCore().catch(() => {}), Promise.race([live.refreshRoutesAccess(), bound])]);
    clearTimeout(timer);
  }

  return {
    handle,
    init,
    token,
    home,
    store,
    live,
    deviceSetup,
    readOnly,
    elevationStarted,
    elevationEnded,
    /** Set the listening port (for Host/Origin checks) and open the gate. */
    setPort(p) {
      port = p;
    },
    markReady() {
      readyResolve();
    },
    get port() {
      return port;
    },
    get clientCount() {
      return clients.size;
    },
    async close() {
      closeClients();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      live.close();
      await deviceSetup.stop('shutdown').catch(() => {});
    },
  };
}
