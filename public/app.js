// Nidum Local dashboard — entry point: live data (GET /api/state + SSE
// /api/events), rendering, routing (#tab) and keyboard shortcuts.

import { T } from './strings.js';
import { h, patch } from './dom.js';
import { MARK_SVG } from './icons.js';
import { api } from './client.js';
import { S, TABS, needsAttention, rerender, setRenderer } from './store.js';
import * as A from './actions.js';
import { storageGet } from './util.js';
import { Banners, Header, Sidebar } from './views/shell.js';
import { Discover } from './views/discover.js';
import { AddManually } from './views/add.js';
import { Addresses } from './views/addresses.js';
import { Sharing } from './views/sharing.js';
import { Advanced, Tools } from './views/tools.js';
import { Dialog, QrPopover, Toasts } from './views/overlays.js';

const PANELS = { discover: Discover, add: AddManually, addresses: Addresses, sharing: Sharing, tools: Tools, advanced: Advanced };
const root = document.getElementById('app');

// ---------------------------------------------------------------- render

function FullPage(title, text, actions) {
  return h('div', { class: 'fullpage', key: 'full' },
    h('div', { class: 'fullpage-card', role: 'alert' },
      h('svg', { width: 40, height: 40, viewBox: '0 0 100 100', 'aria-hidden': 'true', html: MARK_SVG }),
      h('h1', null, title),
      h('p', null, text),
      actions || null));
}

function App() {
  if (S.conn === 'closed') return FullPage('Nidum Local is closed.', 'Open the launcher to start it again. Your addresses keep working.');
  if (S.conn === 'unauthorized') return FullPage('Open Nidum Local from its launcher again.', 'This page lost its sign-in, for example because Nidum Local restarted.');
  if (S.conn === 'lost') {
    return FullPage('Lost contact with Nidum Local.', 'Your addresses keep working. Reconnect, or open the launcher again.',
      h('button', { type: 'button', class: 'btn btn-p', id: 'reconnect', onclick: () => connect(true) }, 'Reconnect'));
  }
  const Panel = PANELS[S.tab] || Discover;
  return [
    h('div', { class: 'app', key: 'app', 'data-collapsed': String(S.collapsed) },
      Sidebar(),
      h('div', { class: 'main-col' },
        Header(),
        // A stable slot: banners come and go inside it, so <main> (and focus in it) never moves.
        h('div', { class: 'banners', key: 'banners' }, Banners()),
        h('main', { id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${S.tab}`, tabindex: '-1' },
          h('div', { class: 'nl-wrap', key: `wrap-${S.tab}` }, Panel())))),
    QrPopover(),
    Dialog(),
    Toasts(),
    h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'announcer', key: 'announcer' }, S.announce),
  ];
}

/** Keep toasts clear of the form being worked on: bottom-right by default, top-right if that covers it. */
function placeToasts() {
  const t = root.querySelector('.toasts');
  if (!t || !t.children.length) return;
  const form = root.querySelector('.expanded, .edit-box, .add-card, .assign');
  t.classList.remove('top');
  t.style.top = '';
  if (!form) return;
  const hits = () => {
    const a = t.getBoundingClientRect();
    const b = form.getBoundingClientRect();
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  };
  if (!hits()) return;
  // Move up, but below the header and the page banner (never over "Got it" or the pill).
  const above = root.querySelector('.banners') || root.querySelector('header.top');
  t.classList.add('top');
  t.style.top = `${Math.round((above ? above.getBoundingClientRect().bottom : 0) + 12)}px`;
  if (hits()) {
    t.classList.remove('top');
    t.style.top = '';
  }
}

setRenderer(() => {
  patch(root, App());
  placeToasts();
  document.title = needsAttention() && S.conn !== 'closed' ? '(!) Nidum Local' : 'Nidum Local';
  const app = root.querySelector('.app');
  if (app) app.inert = Boolean(S.dialog);
});

// ---------------------------------------------------------------- live data

let es = null;
let lastId = null;
let pollTimer = null;
let failures = 0;

// Polite announcements of new services, at most once per 10 s (spec §13).
let knownPorts = null;
let pendingPorts = [];
let lastAnnounce = 0;
let announceTimer = null;

function noteServices(list) {
  const ports = new Set((list || []).filter((x) => !x.hidden).map((x) => x.port));
  if (knownPorts) for (const p of ports) if (!knownPorts.has(p) && !pendingPorts.includes(p)) pendingPorts.push(p);
  knownPorts = ports;
  if (pendingPorts.length) flushAnnounce();
}

function flushAnnounce() {
  const wait = lastAnnounce + 10000 - Date.now();
  if (wait > 0) {
    if (!announceTimer) announceTimer = setTimeout(() => { announceTimer = null; flushAnnounce(); }, wait);
    return;
  }
  const ports = pendingPorts.splice(0).filter((p) => knownPorts?.has(p));
  if (!ports.length) return;
  lastAnnounce = Date.now();
  S.announce = ports.length === 1 ? T.newService(ports[0]) : T.newServices(ports);
  rerender();
}

function applyState(state) {
  S.data = state;
  if (!S.firstDataAt) S.firstDataAt = Date.now();
  S.lastMsgAt = Date.now();
  if (state.scannedAt) S.scannedAt = Date.parse(state.scannedAt);
  noteServices(state.services);
  A.checkJobs();
  if (S.assign && !state.services.some((s) => s.port === S.assign.port) && !S.assign.busy) S.assign = null;
  if (S.edit && !state.routes.some((r) => r.hostname === S.edit.hostname) && !S.edit.busy) S.edit = null;
  rerender();
}

async function fetchState() {
  try {
    const state = await api('GET', '/api/state', undefined, { timeout: 10000 });
    failures = 0;
    applyState(state);
    return true;
  } catch (e) {
    if (e.code === 'UNAUTHORIZED') {
      S.conn = 'unauthorized';
      closeEvents();
      rerender();
      return false;
    }
    failures += 1;
    if (e.code === 'OFFLINE' || e.code === 'TIMEOUT') {
      if (failures >= 2 && S.conn !== 'closed') {
        S.conn = 'lost';
        rerender();
      }
    }
    return false;
  }
}

function closeEvents() {
  if (es) {
    es.close();
    es = null;
  }
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (S.conn === 'live' || S.conn === 'closed' || S.conn === 'unauthorized') {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    fetchState();
  }, 5000);
}

function onEvent(type, e) {
  const id = e.lastEventId !== '' ? Number(e.lastEventId) : null;
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  if (S.conn !== 'live') {
    S.conn = 'live';
    failures = 0;
  }
  if (type === 'state') {
    lastId = id;
    applyState(data);
    return;
  }
  const gap = id !== null && lastId !== null && id !== lastId + 1;
  if (id !== null) lastId = id;
  S.lastMsgAt = Date.now();
  if (gap) {
    fetchState();
    return;
  }
  if (type === 'heartbeat') {
    // E10: the heartbeat carries the last scan time.
    if (data && data.scannedAt) S.scannedAt = Date.parse(data.scannedAt);
    rerender();
    return;
  }
  if (!S.data) {
    rerender();
    return;
  }
  S.data[type] = data;
  if (type === 'routes') S.data.routesUnavailable = false; // E1: any routes event means the list was read
  if (type === 'services') {
    S.scannedAt = Date.now(); // a services event follows a completed scan
    noteServices(data);
  }
  if (type === 'proxy') A.checkJobs();
  rerender();
}

function openEvents() {
  closeEvents();
  lastId = null;
  es = new EventSource('/api/events');
  for (const type of ['state', 'routes', 'services', 'proxy', 'network', 'settings', 'banners', 'capabilities', 'heartbeat']) {
    es.addEventListener(type, (e) => onEvent(type, e));
  }
  es.onopen = () => {
    failures = 0;
  };
  es.onerror = () => {
    if (S.conn === 'closed' || S.conn === 'unauthorized') return;
    if (es && es.readyState === EventSource.CLOSED) {
      // The server refused the stream (e.g. 401 after a restart): poll to find out.
      fetchState().then((ok) => {
        if (ok && S.conn !== 'unauthorized') setTimeout(openEvents, 2000);
      });
    }
    if (S.conn === 'live' || S.conn === 'loading') {
      S.conn = 'reconnecting';
      rerender();
    }
    startPolling();
  };
}

async function connect(manual = false) {
  if (manual) {
    S.conn = 'reconnecting';
    failures = 0;
    rerender();
  }
  const ok = await fetchState();
  if (ok) {
    openEvents();
  } else if (S.conn !== 'unauthorized') {
    if (manual) {
      S.conn = 'lost';
      rerender();
    } else {
      S.conn = 'reconnecting';
      rerender();
      startPolling();
      openEvents();
    }
  }
}

A.setQuitHandler(() => {
  S.conn = 'closed';
  closeEvents();
  S.dialog = null;
  rerender();
});

// ---------------------------------------------------------------- keyboard

let pendingG = 0;

function isTyping(el) {
  if (!el) return false;
  const tag = el.localName;
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function trapFocus(e) {
  const dlg = document.querySelector('.dialog');
  if (!dlg) return;
  const items = Array.from(dlg.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && el.getClientRects().length);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!dlg.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (S.dialog) {
    if (e.key === 'Tab') trapFocus(e);
    else if (e.key === 'Escape' && !S.dialog.busy) {
      e.preventDefault();
      A.closeDialog();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (S.popover) {
      e.preventDefault();
      A.closePopover();
      return;
    }
    if (S.assign && !S.assign.busy) {
      e.preventDefault();
      A.cancelAssign();
      return;
    }
    if (S.edit && !S.edit.busy) {
      e.preventDefault();
      A.cancelEdit();
      return;
    }
    if (S.toasts.length) {
      A.dismissToast(S.toasts[S.toasts.length - 1].id);
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || S.conn !== 'live' && !S.data) return;
  const now = Date.now();
  if (pendingG && now - pendingG < 1000 && e.key === 'a') {
    pendingG = 0;
    e.preventDefault();
    A.selectTab('addresses', { focus: '#panel-h' });
    return;
  }
  pendingG = 0;
  switch (e.key) {
    case '/':
      e.preventDefault();
      A.selectTab('discover', { focus: '#search' });
      break;
    case 'n':
      e.preventDefault();
      A.selectTab('add', { focus: '#add-port' });
      break;
    case 'g':
      pendingG = now;
      break;
    case '?':
      e.preventDefault();
      A.openDialog({ type: 'shortcuts' });
      break;
    case 'c': {
      const row = e.target.closest && e.target.closest('[data-row-url]');
      if (row) {
        e.preventDefault();
        A.copyUrl(row.getAttribute('data-row-url'), `kbd:${row.getAttribute('data-row-url')}`);
      }
      break;
    }
    default:
      break;
  }
});

// Close the QR popover on outside click or scroll (spec §7.11).
document.addEventListener('mousedown', (e) => {
  if (S.popover && !e.target.closest('.popover') && !e.target.closest('[data-qr]')) A.closePopover({ restore: false });
});
document.addEventListener('scroll', () => placeToasts(), true);
window.addEventListener('resize', () => placeToasts());
document.addEventListener('scroll', (e) => {
  if (S.popover && !(e.target instanceof Element && e.target.closest('.popover'))) A.closePopover({ restore: false });
}, true);
document.addEventListener('focusin', (e) => {
  if (S.popover && !e.target.closest('.popover') && !e.target.closest('[data-qr]')) A.closePopover({ restore: false });
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (TABS.some((t) => t.id === id) && id !== S.tab) A.selectTab(id, { keepHash: true });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (S.theme === 'system') A.applyTheme('system');
});

// Keep "Updated N seconds ago" and countdowns fresh.
setInterval(() => {
  if (S.tab === 'discover' || S.dialog?.type === 'setup') rerender();
}, 1000);

// ---------------------------------------------------------------- boot

{
  const t = storageGet('nidum-theme');
  A.applyTheme(t === 'light' || t === 'dark' ? t : 'system');
  S.collapsed = storageGet('nidum-sidebar') === 'collapsed';
  const hash = location.hash.slice(1);
  if (TABS.some((x) => x.id === hash)) S.tab = hash;
  rerender();
  connect(false);
}
