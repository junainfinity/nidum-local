// Nidum Local dashboard — UI state and derived values. Server data lives in
// S.data (the /api/state body, kept current by SSE); everything else is
// local UI state. Never optimistic: mutations wait for the server.

import { T } from './strings.js';
import { formatUrl } from './util.js';

export const TABS = [
  { id: 'discover', label: 'Discover', icon: 'discover' },
  { id: 'add', label: 'Add manually', icon: 'add' },
  { id: 'addresses', label: 'Your addresses', icon: 'link' },
  { id: 'sharing', label: 'Network sharing', icon: 'wifi' },
  { id: 'tools', label: 'Tools', icon: 'tools' },
  { id: 'advanced', label: 'Advanced', icon: 'advanced' },
];

export const S = {
  data: null,
  conn: 'loading', // loading | live | reconnecting | lost | closed | unauthorized
  lastMsgAt: 0,
  tab: 'discover',
  collapsed: false,
  theme: 'system',
  search: '',
  showSystem: false,
  refreshing: false,
  scanError: null,
  assign: null, // { port, name, touched, busy, error }
  highlight: {}, // hostname → until (ms)
  add: { port: '', name: '', nameAuto: true, portTouched: false, nameTouched: false, busy: false, error: null, submitted: false },
  edit: null, // { hostname, kind: 'port' | 'name', value, busy, error }
  rowBusy: {}, // hostname → 'remove' | 'check'
  rowError: {}, // hostname → ApiError
  copied: {}, // key → until
  setBusy: {}, // settings key → true
  setError: {}, // settings key → ApiError
  setNote: {}, // settings key → text
  proxyAct: null, // { action, jobId }
  proxyErr: null, // { action, error }
  bannerBusy: null,
  tools: {}, // tool → { busy, result, error }
  popover: null, // { url, hostname, anchor: {x, y, w, h}, openerId }
  dialog: null, // { type, … }
  toasts: [],
  seq: 0,
  scannedAt: 0, // E10: last completed port scan (ms)
  announce: '', // polite live-region text (new services, spec §13)
  bannerErr: null, // banner dismiss error (shown in the banner)
  undoErr: null, // { hostname, error } failed Undo (shown above the table)
  copyErr: {}, // key → text (shown next to the chip)
  routesCheck: null, // E13 Check again: { busy, unchanged, changed, key }
  firstDataAt: 0, // when the page first got /api/state (Discover's first-scan wait)
  scanGaveUp: false, // a forced scan answered without a completed scan
};

let renderFn = () => {};
let scheduled = false;
const after = [];

export function setRenderer(fn) {
  renderFn = fn;
}

/** Re-render on the next microtask (batched). `then` runs after the DOM is patched. */
export function rerender(then) {
  if (then) after.push(then);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    renderFn();
    for (const fn of after.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.warn(e);
      }
    }
  });
}

// ---------------------------------------------------------------- derived

export const proxy = () => S.data?.proxy || null;
export const routes = () => S.data?.routes || [];
export const services = () => S.data?.services || [];
export const network = () => S.data?.network || null;
export const settings = () => S.data?.settings || null;
export const caps = () => S.data?.capabilities || {};
export const tlsOn = () => Boolean(proxy()?.tls);
/** E1: true until N3 has read the address list once (never show "No addresses yet" then). */
export const routesUnavailable = () => Boolean(S.data?.routesUnavailable);

/** URL for a new name, given the current proxy (Contracts §1). */
export function urlFor(name) {
  const p = proxy();
  return formatUrl(`${name}.local`, p ? p.port : 443, p ? p.tls : true);
}

export function liveCount() {
  return routes().filter((r) => r.status === 'live').length;
}

/**
 * Before the first port scan finishes (E10 `scannedAt` still null) an empty list means "not looked
 * yet", never "nothing is running". A failed Refresh ends the wait (its error shows instead).
 */
export function scanPending() {
  return Boolean(S.data) && !S.scannedAt && !services().length && !S.scanError && !scanStuck();
}

/** How long Discover waits for the first scan before it says scanning isn't working (3 × E10's 4 s deadline + a 5 s cycle). */
export const SCAN_WAIT_MS = 17000;

/**
 * Scans keep failing: no first scan long after the page got its data, or a forced scan came back
 * without one. Discover then shows an error with Try again instead of "Looking for services…".
 */
export function scanStuck() {
  if (!S.data || S.scannedAt || services().length || S.scanError) return false;
  return S.scanGaveUp || Boolean(S.firstDataAt && Date.now() - S.firstDataAt > SCAN_WAIT_MS);
}

export function visibleServices() {
  return services().filter((s) => S.showSystem || !s.hidden);
}

export function jobRunning() {
  const j = proxy()?.job;
  return Boolean(j && !j.finishedAt);
}

export function serviceManaged() {
  return proxy()?.managedBy === 'service';
}

export function routeByName(name) {
  return routes().find((r) => r.name === name) || null;
}

export function serviceForPort(port) {
  return services().find((s) => s.port === port) || null;
}

export const PAUSED_MESSAGE = T.pausedBanner;

/**
 * A deliberate pause (E11/D29): `proxy.pausedByUser`, the `sharing-paused` banner, or, with a server
 * that doesn't send those yet, a finished user `stop` job on a stopped proxy.
 */
export function isPaused() {
  const p = proxy();
  if (!p || p.running) return false;
  if (p.pausedByUser) return true;
  if ((S.data?.banners || []).some((b) => b.id === 'sharing-paused')) return true;
  return Boolean(p.job && (p.job.action === 'stop' || p.job.action === 'service-stop') && p.job.phase === 'done');
}

/** E13: `routesAccess` from /api/state; null = not known yet (nothing is disabled then). */
export const routesAccess = () => S.data?.routesAccess || null;

/** E13: the visible reason route changes are disabled, or null when they are allowed (or unknown). */
export function routesBlocked() {
  const a = routesAccess();
  if (!a) return null;
  if (a.locked) return T.routesLockedReason;
  if (a.writable === false) return T.routesNotWritableReason;
  return null;
}

/** E13: the two refused-write codes (never mapped to friendlier text in client.js). */
export const ROUTES_CODES = ['ROUTES_LOCKED', 'ROUTES_NOT_WRITABLE'];

/**
 * Banners in priority order (design spec §7.14, D26, D59(d)): sharing state comes before a locked
 * address list, so a lock never hides whether sharing is on. The UI sorts by this list itself and
 * never relies on the order the server sends.
 */
const BANNER_ORDER = ['portless-missing', 'sharing-off', 'sharing-paused', 'routes-locked', 'routes-not-writable', 'network-off', 'public-network', 'first-run'];
export const ROUTES_BANNERS = ['routes-locked', 'routes-not-writable'];
export const isRoutesBanner = (b) => Boolean(b && ROUTES_BANNERS.includes(b.id));

/** Every current banner, in the UI's priority order. */
export function sortedBanners() {
  let list = (S.data?.banners || []).slice();
  // A startup-service job stops and restarts sharing on purpose: no crash banner while it runs.
  const job = proxy()?.job;
  if (job && !job.finishedAt && /^service-/.test(job.action || '')) list = list.filter((b) => b.id !== 'sharing-off');
  if (isPaused()) {
    list = list.filter((b) => b.id !== 'sharing-off');
    if (!list.some((b) => b.id === 'sharing-paused')) list.push({ id: 'sharing-paused', kind: 'info', message: PAUSED_MESSAGE });
  }
  const rank = (b) => {
    const i = BANNER_ORDER.indexOf(b.id);
    return i < 0 ? BANNER_ORDER.length : i;
  };
  return list.sort((a, b) => rank(a) - rank(b));
}

export function topBanner() {
  return sortedBanners()[0] || null;
}

/** The address-list banner (E13), wherever it sorts. The page always shows it, under the top one. */
export function routesBanner() {
  return sortedBanners().find(isRoutesBanner) || null;
}

/**
 * The page banners shown, at most two: the top one, plus the E13 address-list banner when another
 * banner (paused, sharing off, Portless missing, or a failed sharing action) is above it.
 */
export function shownBanners() {
  const top = S.proxyErr ? null : topBanner();
  const rb = routesBanner();
  return [top, rb && rb !== top ? rb : null].filter(Boolean);
}

export function needsAttention() {
  return shownBanners().some((b) => b.kind === 'error' || b.id === 'sharing-off') || Boolean(S.proxyErr) || routes().some((r) => r.status === 'error');
}

/**
 * E13 Check again: what the address-list problem is now (kind, flag, file or folder, path, owner).
 * "Nothing has changed yet." is only said when this is the same before and after.
 */
export function routesProblemKey() {
  const a = routesAccess();
  if (!a || (!a.locked && a.writable !== false)) return null;
  return JSON.stringify([a.locked ? 'locked' : 'not-writable', a.flag || null, a.target || null, a.path || null, a.owner || null, a.ownedByYou ?? null]);
}

/** Is `name` already an address? (live "taken" check, spec §7.7) */
export function takenBy(name, exceptHostname = null) {
  if (!name) return null;
  const r = routes().find((x) => x.hostname === `${name}.local` && x.hostname !== exceptHostname);
  if (!r) return null;
  return r.pid !== 0
    ? { route: r, app: true, message: T.takenApp(name) }
    : { route: r, app: false, message: T.takenAlias(name, r.port) };
}

/** Spec §12 risky services: Docker's API (2375/2376) or anything with "admin" in its title. */
export function riskFor(port, title) {
  if (port === 2375 || port === 2376) return T.riskDocker;
  if (title && /admin/i.test(title)) return T.riskAdmin(title);
  return null;
}

export function nextId() {
  S.seq += 1;
  return S.seq;
}
