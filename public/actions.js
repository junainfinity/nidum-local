// Nidum Local dashboard — user actions. Every mutation waits for the server
// (no optimistic UI); results arrive as the response and as SSE updates.

import { AddrSpan, AddrText, withAddr } from './addr.js';
import { T } from './strings.js';
import { ApiError, api, enc } from './client.js';
import { S, TABS, isPaused, network, proxy, rerender, riskFor, routes, routesBlocked, routesProblemKey, serviceForPort, settings, urlFor, nextId } from './store.js';
import { checkName, checkPort, copyText, displayAddress, storageSet } from './util.js';
import { h } from './dom.js';

const mono = (t) => AddrSpan(t);

// ---------------------------------------------------------------- focus helpers

/** Focus the first element matching `selector` after the next render. */
export function focusLater(selector, fallback) {
  rerender(() => {
    const el = document.querySelector(selector) || (fallback && document.querySelector(fallback));
    if (el) el.focus();
  });
}

/**
 * Focus `selector` once it exists (it may arrive with the next SSE update), else `fallback` after
 * `ms`. Doesn't steal focus if the user has moved it somewhere meaningful meanwhile.
 */
export function focusWhenReady(selector, fallback, ms = 3000) {
  const end = Date.now() + ms;
  const idle = () => {
    const a = document.activeElement;
    return !a || a === document.body || a.id === 'panel' || a.id === 'panel-h' || !a.isConnected;
  };
  const attempt = () => {
    const el = document.querySelector(selector);
    if (el) {
      if (idle() || document.activeElement === el) el.focus();
      return;
    }
    if (Date.now() > end) {
      if (idle() && fallback) document.querySelector(fallback)?.focus();
      return;
    }
    setTimeout(attempt, 100);
  };
  rerender(attempt);
}

// ---------------------------------------------------------------- navigation

export function selectTab(id, { focus = null, keepHash = false } = {}) {
  if (!TABS.some((t) => t.id === id)) id = 'discover';
  const changed = S.tab !== id;
  S.tab = id;
  S.popover = null;
  if (!keepHash && location.hash !== `#${id}`) {
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {
      /* file:// or sandbox */
    }
  }
  if (changed) {
    const main = document.getElementById('panel');
    if (main) main.scrollTop = 0;
  }
  if (focus) focusLater(focus);
  else rerender();
}

// ---------------------------------------------------------------- toasts

const toastTimers = new Map();

export function toast(text, { action = null, ms = action ? 6000 : 4000, icon = 'check' } = {}) {
  const id = nextId();
  S.toasts = [...S.toasts.slice(-2), { id, text, action, icon, ms }];
  startToastTimer(id, ms);
  rerender();
  return id;
}

export function startToastTimer(id, ms) {
  clearTimeout(toastTimers.get(id));
  const t = S.toasts.find((x) => x.id === id);
  toastTimers.set(id, setTimeout(() => dismissToast(id), ms ?? t?.ms ?? 4000));
}

export function holdToast(id) {
  clearTimeout(toastTimers.get(id));
}

export function dismissToast(id) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  S.toasts = S.toasts.filter((t) => t.id !== id);
  rerender();
}

// ---------------------------------------------------------------- copy / open / QR

export async function copyUrl(url, key = url) {
  const ok = await copyText(url);
  delete S.copyErr[key];
  if (ok) {
    S.copied[key] = Date.now() + 1500;
    setTimeout(() => {
      if (S.copied[key] && S.copied[key] <= Date.now()) delete S.copied[key];
      rerender();
    }, 1600);
    toast(T.copied(AddrSpan(url)));
  } else {
    // Errors stay where they happened (spec §11), never in a toast.
    S.copyErr[key] = T.copyFailed;
    rerender();
  }
}

/** E13: copy a Terminal command exactly (the string, not the rendered pieces). */
export async function copyCommand(cmd, key = `cmd:${cmd}`) {
  const ok = await copyText(cmd);
  delete S.copyErr[key];
  if (ok) {
    S.copied[key] = Date.now() + 1500;
    setTimeout(() => {
      if (S.copied[key] && S.copied[key] <= Date.now()) delete S.copied[key];
      rerender();
    }, 1600);
    toast(T.commandCopied);
  } else {
    S.copyErr[key] = T.commandCopyFailed;
    rerender();
  }
}

/**
 * E13 "Check again": `GET /api/state?refresh=1` re-reads the address list's lock now. The banner
 * clears when it is unlocked; otherwise it says nothing has changed yet.
 */
export async function checkRoutesAccess() {
  if (S.routesCheck?.busy) return;
  const triggered = document.activeElement && document.activeElement !== document.body;
  const before = routesProblemKey();
  S.routesCheck = { busy: true, unchanged: false };
  S.bannerErr = null;
  rerender();
  try {
    const state = await api('GET', '/api/state?refresh=1');
    if (S.data && state) Object.assign(S.data, state);
    const still = Boolean(routesBlocked());
    const key = routesProblemKey();
    // Same problem: "Nothing has changed yet." A different one (say locked → not writable, or another
    // path): the banner's steps changed with it, and the note says so instead.
    S.routesCheck = { busy: false, unchanged: still && key === before, changed: still && key !== before, key };
    if (!still) toast(T.routesUnblocked);
  } catch (e) {
    S.routesCheck = null;
    const b = (S.data?.banners || []).find((x) => x.id === 'routes-locked' || x.id === 'routes-not-writable');
    S.bannerErr = { id: b ? b.id : 'routes-locked', error: e };
  }
  if (triggered) restoreFocus('routes-check', []);
  else rerender();
}

export function openUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function openQr(url, button) {
  const r = button.getBoundingClientRect();
  S.popover = { url, anchor: { x: r.left, y: r.top, w: r.width, h: r.height }, opener: button };
  focusLater('.popover .qr-btns .btn');
}

export function closePopover({ restore = true } = {}) {
  if (!S.popover) return;
  const opener = S.popover.opener;
  S.popover = null;
  rerender(() => {
    if (restore && opener && opener.isConnected) opener.focus();
  });
}

/** Download the QR code as a PNG (black on white). */
export function downloadQr(qr, url, moduleSize) {
  const quiet = 4;
  const n = qr.size + quiet * 2;
  const scale = Math.max(moduleSize, 8);
  const canvas = document.createElement('canvas');
  canvas.width = n * scale;
  canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${displayAddress(url).replace(/[^a-z0-9.-]+/gi, '-')}-qr.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }, 'image/png');
}

// ---------------------------------------------------------------- dialogs

export function openDialog(dialog) {
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  S.dialog = { ...dialog, opener };
  S.popover = null;
  focusLater(dialog.focus || '.dialog [data-autofocus]', '.dialog button');
}

export function closeDialog() {
  if (!S.dialog) return;
  const { opener, onClose } = S.dialog;
  S.dialog = null;
  if (onClose) onClose();
  rerender(() => {
    if (opener && opener.isConnected) opener.focus();
    else document.getElementById('panel-h')?.focus();
  });
}

// ---------------------------------------------------------------- jobs (proxy / service)

const jobWaiters = new Map(); // job id → (job) => void

/** Wait for a proxy/service job (Contracts §8) to finish; progress arrives as proxy events. */
function watchJob(job, onDone) {
  if (!job) return;
  if (job.finishedAt) {
    onDone(job);
    return;
  }
  jobWaiters.set(job.id, onDone);
  checkJobs();
}

/** Called whenever proxy data changes. */
export function checkJobs() {
  const job = proxy()?.job;
  if (!job || !job.finishedAt) return;
  const fn = jobWaiters.get(job.id);
  if (fn) {
    jobWaiters.delete(job.id);
    fn(job);
  }
}

export function jobFor(jobId) {
  const job = proxy()?.job;
  return job && job.id === jobId ? job : null;
}

const jobError = (job) => new ApiError(job.error?.code || 'INTERNAL', job.error?.message || 'Something went wrong. Nothing was changed.', { raw: job.error?.raw });

/** Where focus goes after a sharing job when its own control is gone (in this order), else the heading. */
const SHARING_FOCUS_FALLBACK = ['card-pause', 'hdr-pause', 'strip-start'];

/**
 * A control that starts a job is disabled while it runs, so the browser drops focus to <body>.
 * When the job ends, put focus back on that control (`data-fk`), or on its replacement if it
 * re-rendered or went away, else the panel heading. Never steals focus the user has moved meanwhile.
 */
function restoreFocus(key, fallbacks = SHARING_FOCUS_FALLBACK) {
  rerender(() => {
    const a = document.activeElement;
    if (S.dialog || (a && a !== document.body && a.isConnected)) return;
    const usable = (el) => el && !el.disabled && el.getClientRects().length > 0;
    for (const k of [key, ...fallbacks]) {
      const el = k ? document.querySelector(`[data-fk="${k}"]`) : null;
      if (usable(el)) {
        el.focus();
        return;
      }
    }
    document.getElementById('panel-h')?.focus();
  });
}

/**
 * Pause / resume / restart sharing. `from` is the control that asked for it (the dialog's opener
 * for a confirmed pause); keyboard focus returns there when the job ends.
 */
export async function proxyAction(action, { from = document.activeElement } = {}) {
  if (S.proxyAct) return;
  const resume = action === 'start' && isPaused();
  const triggered = Boolean(from && from !== document.body);
  const focusKey = triggered ? from.getAttribute?.('data-fk') || null : null;
  const settle = () => {
    if (triggered) restoreFocus(focusKey);
    else rerender();
  };
  S.proxyAct = { action, jobId: null, resume };
  S.proxyErr = null;
  rerender();
  try {
    const { job } = await api('POST', `/api/proxy/${action}`, {});
    S.proxyAct = { action, jobId: job.id, resume };
    rerender();
    watchJob(job, (done) => {
      S.proxyAct = null;
      if (done.phase === 'failed') S.proxyErr = { action, resume, error: jobError(done) };
      else if (action === 'stop') toast(T.sharingPausedToast, { icon: 'info' });
      else toast(action === 'start' ? T.sharingOnToast : T.sharingRestartedToast);
      settle();
    });
  } catch (e) {
    S.proxyAct = null;
    S.proxyErr = { action, resume, error: e };
    settle();
  }
}

export function proxyErrorTitle() {
  if (!S.proxyErr) return '';
  return T.couldnt(T.actionWords[S.proxyErr.resume ? 'resume' : S.proxyErr.action]);
}

export function askPause() {
  const live = routes().filter((r) => r.status === 'live').length;
  const managed = proxy()?.managedBy === 'service';
  const from = document.activeElement;
  if (live > 0 || managed) {
    openDialog({
      type: 'confirm',
      title: T.pauseTitle,
      body: managed ? T.pauseServiceBody : T.pauseBody(live),
      confirm: T.pauseSharing,
      danger: false,
      run: () => proxyAction('stop', { from }),
    });
  } else {
    proxyAction('stop', { from });
  }
}

/** D50: installing the startup service while paused turns sharing back on, so Apply asks first. */
export function askApply() {
  if (isPaused() && settings()?.keepAfterRestart) {
    openDialog({
      type: 'confirm',
      title: T.applyResumeTitle,
      body: T.applyResumeBody,
      confirm: T.apply,
      danger: false,
      run: () => applyService('service'),
    });
  } else {
    applyService('service');
  }
}

/** Apply saved settings to the startup service (needs a password). */
export async function applyService(key = 'service', { onFail } = {}) {
  S.setBusy[key] = true;
  S.setError[key] = null;
  rerender();
  try {
    const { job } = await api('POST', '/api/service', { action: 'apply' });
    S.setBusy[key] = job.id;
    rerender();
    watchJob(job, (done) => {
      S.setBusy[key] = false;
      if (done.phase === 'failed') {
        S.setError[key] = jobError(done);
        if (onFail) onFail();
      } else {
        toast(done.action === 'service-uninstall' ? T.serviceRemoved : T.serviceApplied);
      }
      rerender();
    });
  } catch (e) {
    S.setBusy[key] = false;
    S.setError[key] = e;
    if (onFail) onFail();
    rerender();
  }
}

// ---------------------------------------------------------------- settings

export async function patchSettings(key, body) {
  S.setBusy[key] = true;
  S.setError[key] = null;
  rerender();
  try {
    const next = await api('PATCH', '/api/settings', body);
    if (S.data) S.data.settings = next;
    S.setBusy[key] = false;
    rerender();
    return next;
  } catch (e) {
    S.setBusy[key] = false;
    S.setError[key] = e;
    rerender();
    return null;
  }
}

export async function toggleSetting(key, value, confirmed = false) {
  // Turning keep-after-restart off removes the startup service: ask first (graph validation 2 F1).
  // While paused (D45) the pause stays and only one password is asked.
  if (key === 'keepAfterRestart' && !value && !confirmed && proxy()?.managedBy === 'service') {
    openDialog({
      type: 'confirm',
      title: T.keepOffTitle,
      body: isPaused() ? T.keepOffBodyPaused : T.keepOffBody,
      confirm: T.turnOff,
      danger: false,
      run: () => toggleSetting(key, value, true),
    });
    return;
  }
  // Turning it on installs the startup service, which turns a paused sharing back on (D50's rule).
  if (key === 'keepAfterRestart' && value && !confirmed && isPaused()) {
    openDialog({
      type: 'confirm',
      title: T.keepOnResumeTitle,
      body: T.keepOnResumeBody,
      confirm: T.turnOn,
      danger: false,
      run: () => toggleSetting(key, value, true),
    });
    return;
  }
  const prev = settings()?.[key];
  const next = await patchSettings(key, { [key]: value });
  if (!next) return;
  if (key === 'tls') {
    S.setNote.tls = value ? null : T.httpsOffNote;
    rerender(); // the note shows now, not with the next server event
  }
  if (key === 'keepAfterRestart') {
    await applyService('keepAfterRestart', {
      onFail: () => {
        api('PATCH', '/api/settings', { keepAfterRestart: prev }).then((s) => {
          if (S.data) S.data.settings = s;
          rerender();
        }, () => {});
      },
    });
  }
}

export function setFixedIp(on, ip) {
  const value = on ? ip || S.data?.settings?.fixedIp || network()?.ip || null : null;
  if (on && !value) {
    S.setError.fixedIp = new ApiError('BAD_REQUEST', 'There’s no network address to fix. Connect to a network first.');
    rerender();
    return;
  }
  patchSettings('fixedIp', { fixedIp: value });
}

// ---------------------------------------------------------------- routes

function readyToast(hostname) {
  const ssid = network()?.ssid;
  return [mono(hostname), T.ready(ssid)];
}

function highlight(hostname) {
  S.highlight[hostname] = Date.now() + 2000;
  setTimeout(() => {
    delete S.highlight[hostname];
    rerender();
  }, 2100);
}

/** Run a host check in the background after a create (shows a notice if the app blocks the name). */
function backgroundCheck(name) {
  api('POST', `/api/routes/${enc(name)}/check`, {}).then(
    (check) => setHostCheck(name, check),
    () => {},
  );
}

function setHostCheck(name, check) {
  const r = routes().find((x) => x.name === name);
  if (r) r.hostCheck = check;
  rerender();
}

export function openAssign(service) {
  S.assign = { port: service.port, name: service.suggestedName || '', touched: false, busy: false, error: null };
  focusLater('#assign-name');
}

export function cancelAssign() {
  const port = S.assign?.port;
  S.assign = null;
  focusLater(`[data-assign-port="${port}"]`);
}

/** Spec §12: confirm before giving a risky service (Docker API, admin pages) an address. */
function confirmRisk(port, name, then) {
  const svc = serviceForPort(port);
  const risk = riskFor(port, svc?.http?.title || null);
  if (!risk) return false;
  openDialog({
    type: 'confirm',
    title: T.riskTitle(AddrText(`${name}.local`)),
    body: `${risk} ${T.riskTail}`,
    confirm: T.createAddress,
    danger: true,
    run: then,
  });
  return true;
}

export async function createFromAssign(force = false, riskOk = false) {
  const a = S.assign;
  if (!a || a.busy || routesBlocked()) return; // E13/D59(c): the buttons are disabled too
  const chk = checkName(a.name);
  a.touched = true;
  if (chk.error) {
    a.error = new ApiError('INVALID_NAME', chk.error);
    rerender();
    return;
  }
  if (!riskOk && confirmRisk(a.port, chk.name, () => createFromAssign(force, true))) return;
  a.busy = true;
  a.error = null;
  rerender();
  try {
    const route = await api('POST', '/api/routes', { name: chk.name, port: a.port, force });
    S.assign = null;
    highlight(route.hostname);
    toast(readyToast(route.hostname));
    focusWhenReady(`main [data-copy="${route.hostname}"]`, '#panel-h');
    backgroundCheck(route.name);
  } catch (e) {
    a.busy = false;
    a.error = e;
    rerender();
  }
}

export function addInput(field, value) {
  const f = S.add;
  if (field === 'port') {
    f.port = value.replace(/[^\d]/g, '').slice(0, 5);
    f.portTouched = true;
    const svc = /^\d+$/.test(f.port) ? serviceForPort(Number(f.port)) : null;
    if (f.nameAuto) f.name = svc && svc.http ? svc.suggestedName : '';
  } else {
    f.name = value;
    f.nameAuto = value === '';
  }
  f.error = null;
  rerender();
}

export async function addSubmit(force = false, riskOk = false) {
  const f = S.add;
  if (f.busy || routesBlocked()) return;
  f.submitted = true;
  const p = checkPort(f.port, proxy()?.port);
  const n = checkName(f.name);
  if (p.error || n.error) {
    rerender();
    focusLater(p.error ? '#add-port' : '#add-name');
    return;
  }
  if (!riskOk && confirmRisk(p.port, n.name, () => addSubmit(force, true))) return;
  f.busy = true;
  f.error = null;
  rerender();
  try {
    const route = await api('POST', '/api/routes', { name: n.name, port: p.port, force });
    S.add = { port: '', name: '', nameAuto: true, portTouched: false, nameTouched: false, busy: false, error: null, submitted: false };
    highlight(route.hostname);
    toast(readyToast(route.hostname), { action: { label: 'View', run: () => selectTab('addresses') } });
    focusLater('#add-port');
    backgroundCheck(route.name);
  } catch (e) {
    f.busy = false;
    f.error = e;
    rerender();
  }
}

export function startEdit(route, kind) {
  S.edit = { hostname: route.hostname, name: route.name, kind, value: kind === 'port' ? String(route.port) : route.name, busy: false, error: null };
  focusLater('#edit-input');
}

export function cancelEdit() {
  const e = S.edit;
  S.edit = null;
  if (e) focusLater(`[data-edit="${e.hostname}-${e.kind}"]`);
}

export async function saveEdit(force = false) {
  const e = S.edit;
  if (!e || e.busy || routesBlocked()) return;
  let body;
  if (e.kind === 'port') {
    const p = checkPort(e.value, proxy()?.port);
    if (p.error) {
      e.error = new ApiError('INVALID_PORT', p.error);
      rerender();
      return;
    }
    body = { port: p.port };
  } else {
    const n = checkName(e.value);
    if (n.error) {
      e.error = new ApiError('INVALID_NAME', n.error);
      rerender();
      return;
    }
    if (n.name === e.name) {
      cancelEdit();
      return;
    }
    body = { newName: n.name, ...(force ? { force: true } : {}) };
  }
  e.busy = true;
  e.error = null;
  rerender();
  try {
    const route = await api('PATCH', `/api/routes/${enc(e.name)}`, body);
    S.edit = null;
    highlight(route.hostname);
    toast(e.kind === 'port' ? T.nowPointsTo(AddrSpan(route.hostname), route.port) : T.renamedTo(AddrSpan(route.hostname)));
    focusWhenReady(`main [data-copy="${route.hostname}"]`, '#panel-h');
  } catch (err) {
    e.busy = false;
    e.error = err;
    rerender();
  }
}

export function askRemove(route) {
  openDialog({
    type: 'confirm',
    title: ['Remove ', AddrText(route.hostname), '?'],
    body: T.removeBody,
    confirm: T.removeConfirm,
    danger: true,
    run: () => removeRoute(route),
  });
}

export async function removeRoute(route) {
  const list = routes();
  const idx = list.findIndex((r) => r.hostname === route.hostname);
  S.rowBusy[route.hostname] = 'remove';
  S.rowError[route.hostname] = null;
  rerender();
  try {
    const res = await api('DELETE', `/api/routes/${enc(route.foreignTld ? route.hostname : route.name)}`, {});
    delete S.rowBusy[route.hostname];
    const removed = res.removed || route;
    const undo = route.foreignTld ? null : { label: 'Undo', run: () => undoRemove(removed) };
    toast(['Removed ', mono(removed.hostname), '.'], { action: undo, icon: null });
    // Focus the next row, or the empty state's first button (design spec §9).
    rerender(() => {
      const rows = Array.from(document.querySelectorAll('main [data-row-url] [data-copy]'));
      const target = rows[Math.min(idx, rows.length - 1)] || document.querySelector('main .empty .btn');
      (target || document.getElementById('panel-h'))?.focus();
    });
  } catch (e) {
    delete S.rowBusy[route.hostname];
    S.rowError[route.hostname] = e;
    rerender();
  }
}

export async function undoRemove(removed, { retry = false } = {}) {
  if (retry && routesBlocked()) return; // D59(c): the failed-Undo Try again waits for the list
  S.undoErr = null;
  try {
    const route = await api('POST', '/api/routes', { name: removed.name, port: removed.port });
    highlight(route.hostname);
    toast([mono(route.hostname), ' is back.']);
  } catch (e) {
    // Shown inline above the table, where the row was (spec §11).
    S.undoErr = { removed, error: e };
    if (S.tab !== 'addresses') selectTab('addresses');
    rerender();
  }
}

/** Retry for a route in Error (spec §8.3): run the host check and re-read the state. */
export async function retryRoute(route) {
  S.rowBusy[route.hostname] = 'check';
  rerender();
  try {
    const check = await api('POST', `/api/routes/${enc(route.foreignTld ? route.hostname : route.name)}/check`, {});
    setHostCheck(route.name, check);
    const state = await api('GET', '/api/state');
    if (S.data) Object.assign(S.data, state);
  } catch (e) {
    S.rowError[route.hostname] = e;
  } finally {
    delete S.rowBusy[route.hostname];
    rerender();
  }
}

export async function checkRoute(route) {
  S.rowBusy[route.hostname] = 'check';
  rerender();
  try {
    const check = await api('POST', `/api/routes/${enc(route.foreignTld ? route.hostname : route.name)}/check`, {});
    setHostCheck(route.name, check);
    if (check.ok) toast(withAddr(check.message || `${route.hostname} works.`, route.hostname));
  } catch (e) {
    S.rowError[route.hostname] = e;
  } finally {
    delete S.rowBusy[route.hostname];
    rerender();
  }
}

// ---------------------------------------------------------------- discover

export async function refreshServices({ from = document.activeElement } = {}) {
  if (S.refreshing) return;
  const focusKey = from && from !== document.body ? from.getAttribute?.('data-fk') || null : null;
  S.refreshing = true;
  rerender();
  try {
    const list = await api('GET', '/api/services?refresh=1'); // E10: forces a scan now
    if (S.data && Array.isArray(list)) S.data.services = list;
    S.scanError = null;
    if (Array.isArray(list) && list.length) {
      S.scannedAt = Date.now();
    } else if (!S.scannedAt) {
      // An empty answer before any scan finished may be the cached list of a scan that failed
      // (E10 answers 200 either way): ask when the last scan completed.
      const state = await api('GET', '/api/state');
      if (state?.scannedAt) {
        S.scannedAt = Date.parse(state.scannedAt);
        if (S.data && Array.isArray(state.services)) S.data.services = state.services;
        S.scanGaveUp = false;
      } else {
        S.scanGaveUp = true; // Discover shows that scanning isn't working, with Try again
      }
    } else {
      S.scannedAt = Date.now();
    }
  } catch (e) {
    S.scanError = e;
  } finally {
    S.refreshing = false;
    // Keep keyboard focus on the button that asked (it is disabled while busy).
    if (focusKey) restoreFocus(focusKey, ['scan-refresh']);
    else rerender();
  }
}

// ---------------------------------------------------------------- tools

export async function runTool(tool, body = {}) {
  const t = (S.tools[tool] = { busy: true, result: null, error: null });
  rerender();
  try {
    t.result = await api('POST', `/api/tools/${tool}`, body, { timeout: 120000 });
    if (tool === 'prune') {
      const n = t.result.count || 0;
      toast(n ? `Stopped ${n === 1 ? '1 stray server' : `${n} stray servers`}.` : 'No stray servers found.');
    }
  } catch (e) {
    t.error = e;
  } finally {
    t.busy = false;
    rerender();
  }
}

export function closeOutput(tool) {
  delete S.tools[tool];
  focusLater(`[data-tool="${tool}"]`);
}

export function openReset() {
  if (routesBlocked()) return; // D59(c)
  // Open at once; the server's plain-language list of what gets removed fills in when it arrives.
  // Until then the dialog says it is checking (never a partial list), and Reset stays disabled.
  openDialog({ type: 'reset', typed: '', busy: false, error: null, removes: null, removesFailed: false, focus: '#reset-confirm' });
  loadResetList(S.dialog);
}

export function loadResetList(d = S.dialog) {
  if (!d || d.type !== 'reset') return;
  d.removesFailed = false;
  rerender();
  api('GET', '/api/tools/clean').then(
    (res) => {
      if (S.dialog !== d) return;
      if (Array.isArray(res.removes) && res.removes.length) d.removes = res.removes;
      else d.removesFailed = true;
      rerender();
    },
    () => {
      if (S.dialog !== d) return;
      d.removesFailed = true;
      rerender();
    },
  );
}

export async function doReset() {
  const d = S.dialog;
  if (!d || d.type !== 'reset' || d.typed.trim() !== 'reset' || d.busy || !d.removes || routesBlocked()) return;
  d.busy = true;
  d.error = null;
  rerender();
  try {
    await api('POST', '/api/tools/clean', { confirm: 'reset' }, { timeout: 120000 });
    closeDialog();
    toast('Portless was reset. Your services keep running.');
  } catch (e) {
    d.busy = false;
    d.error = e;
    rerender();
  }
}

// ---------------------------------------------------------------- device setup

let setupTimer = null;

export async function openSetup() {
  let setup = null;
  try {
    setup = (await api('GET', '/api/setup-device')).setup;
  } catch {
    setup = null;
  }
  openDialog({ type: 'setup', setup, busy: false, error: null, os: 'ios', focus: '.dialog [data-autofocus]', onClose: stopSetupOnClose });
  tickSetup();
}

function tickSetup() {
  clearInterval(setupTimer);
  setupTimer = setInterval(() => {
    if (!S.dialog || S.dialog.type !== 'setup') {
      clearInterval(setupTimer);
      return;
    }
    const s = S.dialog.setup;
    if (s && Date.parse(s.expiresAt) <= Date.now()) {
      S.dialog.setup = null;
      toast('Device setup closed.', { icon: 'info' });
    }
    rerender();
  }, 1000);
}

export async function startSetup() {
  const d = S.dialog;
  if (!d || d.busy) return;
  d.busy = true;
  d.error = null;
  rerender();
  try {
    const { setup } = await api('POST', '/api/setup-device', {});
    if (S.dialog === d) {
      d.setup = setup;
      d.busy = false;
      focusLater('.dialog .setup-tabs [aria-selected="true"]');
    }
  } catch (e) {
    d.busy = false;
    d.error = e;
    rerender();
  }
}

function stopSetupOnClose() {
  clearInterval(setupTimer);
  api('DELETE', '/api/setup-device', {}).then(
    (r) => {
      if (r && r.stopped) toast('Device setup closed. The setup page is offline again.', { icon: 'info' });
    },
    () => {},
  );
}

// ---------------------------------------------------------------- banners, quit, theme

export async function dismissBanner(b) {
  S.bannerBusy = b.id;
  S.bannerErr = null;
  rerender();
  try {
    const res = await api('PATCH', '/api/ui', b.id === 'public-network' ? { dismiss: b.id, ssid: b.ssid } : { dismiss: b.id });
    if (S.data && res.banners) S.data.banners = res.banners;
  } catch (e) {
    S.bannerErr = { id: b.id, error: e }; // shown inside the banner (spec §11)
  } finally {
    S.bannerBusy = null;
    rerender();
  }
}

export function askQuit() {
  openDialog({
    type: 'confirm',
    title: T.quitTitle,
    body: T.quitBody,
    confirm: T.quit,
    danger: false,
    run: quit,
  });
}

let onQuit = () => {};
export function setQuitHandler(fn) {
  onQuit = fn;
}

async function quit() {
  try {
    await api('POST', '/api/quit', {});
  } catch {
    /* already gone */
  }
  onQuit();
}

export function applyTheme(choice) {
  S.theme = choice;
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-choice', choice);
}

export function setTheme(choice) {
  storageSet('nidum-theme', choice);
  applyTheme(choice);
  rerender();
}

export function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  setTheme(order[(order.indexOf(S.theme) + 1) % order.length]);
}

export function toggleCollapse() {
  S.collapsed = !S.collapsed;
  storageSet('nidum-sidebar', S.collapsed ? 'collapsed' : 'expanded');
  focusLater('.collapse-toggle');
}

export { urlFor };
