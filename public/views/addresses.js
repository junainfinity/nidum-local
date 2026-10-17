// Your addresses panel (design: "Your addresses"; spec §7.12, §8.3; D30 table/card switch).
import { Addr, AddrSpan, addrWidth } from '../addr.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { S, caps, isPaused, jobRunning, proxy, routes, routesBlocked, routesUnavailable, serviceForPort, takenBy, urlFor, rerender } from '../store.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';
import { checkName, displayAddress, normalizeNameInput } from '../util.js';
import { AddressChip, Btn, ErrorNotice, Notice, ReplaceBtn, RoutesReason, SectionHead, hostCheckNotice, routesErrorFix } from './common.js';
import { T } from '../strings.js';

const SOURCE = { nidum: 'Nidum', cli: 'Command line', app: 'App' };
const SOURCE_TIP = {
  nidum: 'Created in Nidum Local.',
  cli: 'Created with portless alias somewhere else.',
  app: 'Started with portless run. It goes away when that app stops.',
};

function statusCell(r) {
  if (r.status === 'live') {
    const d = r.statusDetail || {};
    const tip = `${d.slow ? `Connected at :${r.port}, but slow to answer` : `Responding at :${r.port}`}${d.host === '::1' ? ' (IPv6 only)' : ''}`;
    return h('span', { class: 'status', title: tip }, icon('dotSmall', { cls: 'live' }), 'Live');
  }
  if (r.status === 'waiting') {
    const old = r.createdAt && Date.now() - Date.parse(r.createdAt) > 10 * 60 * 1000;
    return h('span', { class: 'status', title: `Nothing is running on :${r.port} yet.${old ? ' Remove it if you don’t need it anymore.' : ''}` }, icon('waiting', { cls: 'waiting' }), 'Waiting');
  }
  if (r.status === 'error') {
    return h('span', { class: 'status', title: errorCause(r) }, icon('alert', { cls: 'error' }), 'Error');
  }
  return h('span', { class: 'status', title: 'Checking…' }, icon('waiting', { cls: 'unknown' }), 'Checking…');
}

function errorCause(r) {
  const code = r.statusDetail?.httpStatus;
  if (code) return `:${r.port} answered with error ${code}.`;
  if (r.statusDetail?.reason === 'probe-failed') return `:${r.port} couldn’t be checked.`;
  return `:${r.port} answered, but not like a web service.`;
}

/** The Rename / Change port editor, in a full-width row under the address (D35: ≥ 240 px). */
function editor(r) {
  const e = S.edit;
  const isPort = e.kind === 'port';
  const chk = isPort ? null : checkName(e.value);
  const taken = !isPort && chk.name && chk.name !== e.name ? takenBy(chk.name, r.hostname) : null;
  const err = e.error;
  const shownErr = err ? errorText(err) : taken ? taken.message : null;
  const offerReplace = (err && err.code === 'NAME_TAKEN') || (!err && taken && !taken.app);
  return h('div', { class: 'edit-box' },
    h('form', { class: 'edit-inline', novalidate: true,
      onsubmit: (ev) => { ev.preventDefault(); A.saveEdit(false); },
      onkeydown: (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); A.cancelEdit(); } } },
      h('label', { for: 'edit-input', class: 'flabel' }, isPort ? T.newPortFor(r.hostname) : T.newNameFor(r.hostname)),
      h('div', { class: `field mono${isPort ? '' : ' name'}${shownErr ? ' invalid' : ''}` },
        isPort ? h('span', { class: 'prefix' }, ':') : null,
        h('input', { id: 'edit-input', value: e.value, inputmode: isPort ? 'numeric' : null, autocomplete: 'off', spellcheck: 'false', disabled: e.busy,
          'aria-invalid': shownErr ? 'true' : null, 'aria-describedby': [shownErr ? 'edit-err' : null, isPort ? null : 'edit-preview'].filter(Boolean).join(' ') || null,
          oninput: (ev) => { let v = ev.target.value; v = isPort ? v.replace(/[^\d]/g, '').slice(0, 5) : normalizeNameInput(v); if (v !== ev.target.value) ev.target.value = v; e.value = v; e.error = null; rerender(); } }),
        isPort ? null : h('span', { class: 'suffix' }, '.local')),
      h('button', { type: 'button', class: 'btn btn-g', onclick: A.cancelEdit, disabled: e.busy }, T.cancel),
      isPort ? null : h('div', { id: 'edit-preview', class: `preview${chk.name ? ' ok' : ''}` },
        chk.name ? icon('check') : null,
        h('span', { class: 'mono addr' }, chk.name ? Addr(urlFor(chk.name)) : '')),
      Btn(T.save, { cls: 'btn btn-p btn-sm', busy: e.busy, disabled: Boolean(taken && taken.app) || Boolean(routesBlocked()), attrs: { type: 'submit', 'aria-describedby': routesBlocked() ? 'routes-reason-a' : null } })),
    shownErr ? h('p', { class: 'ferr edit-err', id: 'edit-err', role: err ? 'alert' : null },
      shownErr,
      offerReplace ? ReplaceBtn(() => A.saveEdit(true), 'routes-reason-a') : null,
      err && err.raw ? h('details', null, h('summary', null, 'Details'), h('pre', null, err.raw)) : null) : null,
    routesErrorFix(err, 'edit'));
}

function actionsCell(r) {
  if (r.source === 'app' || r.pid !== 0) {
    return h('td', { class: 'c-act' }, h('div', { class: 'managed', tabindex: '0', title: SOURCE_TIP.app, 'aria-label': `Managed by its app. ${SOURCE_TIP.app}` }, 'Managed by its app ', icon('info')));
  }
  const busy = S.rowBusy[r.hostname] === 'remove';
  const blocked = Boolean(routesBlocked()); // E13: the reason is shown once, above the list
  const why = blocked ? 'routes-reason-a' : null;
  const removeBtn = Btn('Remove', { cls: 'btn btn-g btn-d', busy, disabled: Boolean(S.edit) || blocked, onclick: () => A.askRemove(r), attrs: { 'aria-label': `Remove ${r.hostname}`, 'aria-describedby': why } });
  if (r.foreignTld) {
    return h('td', { class: 'c-act' }, h('div', { class: 'acts' }, removeBtn));
  }
  return h('td', { class: 'c-act' }, h('div', { class: 'acts' },
    h('button', { type: 'button', class: 'btn btn-g', 'data-edit': `${r.hostname}-port`, disabled: Boolean(S.edit) || busy || blocked, 'aria-describedby': why, 'aria-label': `Change port of ${r.hostname}`, onclick: () => A.startEdit(r, 'port') }, 'Change port'),
    h('button', { type: 'button', class: 'btn btn-g', 'data-edit': `${r.hostname}-name`, disabled: Boolean(S.edit) || busy || blocked, 'aria-describedby': why, 'aria-label': `Rename ${r.hostname}`, onclick: () => A.startEdit(r, 'name') }, 'Rename'),
    removeBtn));
}

function addressCell(r) {
  if (r.foreignTld) {
    return h('td', { class: 'first' }, h('div', { class: 'chip' },
      h('span', { class: 'mono chip-addr', title: r.url }, Addr(r.hostname)),
      h('span', { class: 'badge', title: 'This address uses a different suffix than .local, so other devices may not find it. You can only remove it.' }, 'different suffix')));
  }
  return h('td', { class: 'first' }, AddressChip(r.url, { where: 'a' }));
}

/** Spec §8.3 "Row error": an inline notice with the cause and Retry. */
function errorRowNotice(r) {
  if (r.status !== 'error') return null;
  const busy = S.rowBusy[r.hostname] === 'check';
  return Notice({
    kind: 'error',
    key: `st-${r.hostname}`,
    role: 'status',
    title: [AddrSpan(r.hostname), `${T.rowBroken}${errorCause(r)}`],
    text: T.rowRetryHint(r.port),
    actions: [Btn(T.retry, { cls: 'btn btn-s btn-sm', busy, onclick: () => A.retryRoute(r) })],
  });
}

function rows(list) {
  const out = [];
  for (const r of list) {
    const svc = serviceForPort(r.port);
    const hl = S.highlight[r.hostname] > Date.now();
    const rowErr = S.rowError[r.hostname];
    const extra = (rowErr ? ErrorNotice(rowErr, { key: `re-${r.hostname}`, actions: [h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: () => { S.rowError[r.hostname] = null; rerender(); } }, 'Dismiss')] }) : null)
      || hostCheckNotice(r) || errorRowNotice(r);
    const portText = `:${r.port}${svc?.process ? ` ${svc.process}` : ''}`;
    out.push(h('tr', { key: r.hostname, class: `${hl ? 'highlight' : ''}${extra || (S.edit && S.edit.hostname === r.hostname) ? ' has-notice' : ''}`, 'data-row-url': r.foreignTld ? null : r.url },
      addressCell(r),
      h('td', { class: 'c-port', title: portText.length > 16 ? portText : null }, h('span', { class: 'mono', style: 'font-size:13px' }, `:${r.port}`), svc?.process ? [' ', h('span', { class: 'proc' }, svc.process)] : null),
      h('td', { class: 'hide-md c-src' }, h('span', { class: 'badge', title: SOURCE_TIP[r.source] || null }, SOURCE[r.source] || r.source)),
      h('td', { class: 'c-status' }, statusCell(r)),
      actionsCell(r)));
    const editing = S.edit && S.edit.hostname === r.hostname;
    if (editing) out.push(h('tr', { key: `${r.hostname}-edit`, class: `edit-row${extra ? ' has-notice' : ''}` }, h('td', { class: 'edit-cell', colspan: '5' }, editor(r))));
    if (extra) out.push(h('tr', { key: `${r.hostname}-notice`, class: 'notice-row' }, h('td', { class: 'notice-cell', colspan: '5' }, extra)));
  }
  return out;
}

// ---------------------------------------------------------------- table or cards (D35, iteration 4)

const OTHER_COLUMNS = 762; // Port 134 + Source 130 + Status 120 + Actions 250 + 4 × 32 padding
const CARD_BORDER = 2;
const MIN_ADDRESS_COLUMN = 280;
let observer = null;
let observed = null;

function watchWidth(el) {
  if (observed === el || typeof ResizeObserver === 'undefined') return;
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width;
      if (Math.abs(w - (S.addrWidth || 0)) > 0.5) {
        S.addrWidth = w;
        rerender();
      }
    });
  }
  if (observed) observer.unobserve(observed);
  observer.observe(el);
  observed = el;
  // Measure now (still inside this render's task), so the first painted frame already has the right layout.
  const w = el.getBoundingClientRect().width;
  if (w && Math.abs(w - (S.addrWidth || 0)) > 0.5) {
    S.addrWidth = w;
    rerender();
  }
}

/** Width the Address column needs: the widest address on one line, chip buttons and padding included. */
export function addressColumnNeed(list) {
  let widest = 0;
  for (const r of list) {
    const shown = r.foreignTld ? r.hostname : displayAddress(r.url);
    const chip = addrWidth(shown) + 6 + (r.foreignTld ? 120 : 3 * 32 + 3 * 2);
    widest = Math.max(widest, chip + 20 + 16);
  }
  return Math.max(MIN_ADDRESS_COLUMN, Math.ceil(widest));
}

/** The panel's current content width (read at render time, so the first frame is already right). */
function contentWidth() {
  const wrap = document.querySelector('main#panel .nl-wrap');
  if (!wrap) return S.addrWidth || 0;
  const cs = getComputedStyle(wrap);
  return wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

function useCards(list) {
  const w = contentWidth() || S.addrWidth;
  if (!w) return false;
  return w < addressColumnNeed(list) + OTHER_COLUMNS + CARD_BORDER;
}

export function Addresses() {
  const list = routes();
  const counts = { live: 0, waiting: 0, error: 0 };
  for (const r of list) if (counts[r.status] !== undefined) counts[r.status] += 1;
  const p = proxy();
  const paused = Boolean(S.data && p && !p.running);
  const parts = [];
  if (paused) parts.push(isPaused() ? T.counterPaused : T.counterOff);
  else {
    if (counts.live || (!counts.waiting && !counts.error)) parts.push(`${counts.live} live`);
    if (counts.waiting) parts.push(`${counts.waiting} waiting`);
    if (counts.error) parts.push(`${counts.error} ${counts.error === 1 ? 'error' : 'errors'}`);
  }
  const metaNodes = [];
  parts.forEach((x, i) => {
    if (i) metaNodes.push(' ', h('span', { 'aria-hidden': 'true' }, '·'), ' ');
    metaNodes.push(x);
  });
  let body;
  if (!S.data || routesUnavailable()) {
    body = h('div', { class: 'card clip', 'aria-busy': 'true', 'aria-label': 'Reading your addresses' },
      S.data ? h('p', { class: 'caption', style: 'padding:14px 20px 0' }, 'Reading your addresses…') : null, h('div', { class: 'row-list' }, [0, 1, 2].map((i) => h('div', { class: 'skel', key: `sk${i}` }, h('span'), h('span'), h('span')))));
  } else if (!list.length) {
    body = h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('link'), h('h3', null, T.noAddresses), h('p', null, T.noAddressesText),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-s', onclick: () => A.selectTab('discover', { focus: '#search' }) }, T.goToDiscover),
        h('button', { type: 'button', class: 'btn btn-s', onclick: () => A.selectTab('add', { focus: '#add-port' }) }, T.addTitle))));
  } else {
    body = h('div', { class: `card scroll-x${paused ? ' dim' : ''}` },
      h('table', { class: 'tbl addr-tbl' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'first' }, 'Address'),
          h('th', { scope: 'col', class: 'c-port' }, 'Port'),
          h('th', { scope: 'col', class: 'hide-md c-src' }, 'Source'),
          h('th', { scope: 'col', class: 'c-status' }, 'Status'),
          h('th', { scope: 'col', class: 'c-act' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', null, rows(list))));
  }
  const pauseBlocked = caps().pause && caps().pause.supported === false;
  const undo = S.undoErr;
  const cards = useCards(list);
  return h('section', { class: `section addr-section${cards ? ' cards' : ''}`, 'aria-labelledby': 'panel-h', key: 'addresses', 'data-layout': cards ? 'cards' : 'table', ref: watchWidth },
    SectionHead('addresses', T.addressesTitle, T.addressesDesc,
      S.data && !routesUnavailable() && list.length ? h('span', { class: 'sec-meta' }, metaNodes) : null, { end: true }),
    // Shown above the list, and above a failed Undo (its Try again is disabled too, D59(c)).
    RoutesReason('routes-reason-a', S.data && !routesUnavailable() && (list.length || undo) ? routesBlocked() : null),
    undo ? ErrorNotice(undo.error, {
      key: 'undo-err', title: T.undoFailed(AddrSpan(undo.removed.hostname)),
      actions: [
        h('button', { type: 'button', class: 'btn btn-s btn-sm', 'data-undo-retry': '', disabled: Boolean(routesBlocked()), 'aria-describedby': routesBlocked() ? 'routes-reason-a' : null, onclick: () => A.undoRemove(undo.removed, { retry: true }) }, T.tryAgain),
        h('button', { type: 'button', class: 'btn btn-g', onclick: () => { S.undoErr = null; rerender(); } }, T.dismiss),
      ],
    }) : null,
    paused ? h('div', { class: 'paused-strip', role: 'status' },
      icon('wifiPaused'),
      h('p', null, isPaused() ? T.pausedStrip : T.offStrip),
      pauseBlocked ? null : Btn(isPaused() ? T.resumeSharing : T.startAgain, { cls: 'btn btn-p btn-sm', busy: Boolean(S.proxyAct) || jobRunning(), onclick: () => A.proxyAction('start'), attrs: { 'data-fk': 'strip-start' } })) : null,
    body);
}
