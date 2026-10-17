// QR popover, dialogs and toasts (design: popovers-dialogs-notices.html).
import { Addr } from '../addr.js';
import { T } from '../strings.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { encode, toSvg } from '../qr.js';
import { S, caps, rerender, routesBlocked, tlsOn } from '../store.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';
import { countdown } from '../util.js';
import { Btn, ErrorNotice, RoutesReason } from './common.js';

const qrCache = new Map();

/** QR for `text`: 7 px modules for ≤ 25 modules; larger symbols shrink to stay ≤ 232 px, never below 3 px. */
export function qrFor(text) {
  if (qrCache.has(text)) return qrCache.get(text);
  const qr = encode(text);
  const moduleSize = Math.max(3, Math.min(7, Math.floor(232 / (qr.size + 8))));
  const entry = { qr, moduleSize, svg: toSvg(qr, { moduleSize, quietZone: 4 }) };
  qrCache.set(text, entry);
  return entry;
}

function popoverPosition(anchor) {
  const w = 272;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.x + anchor.w - w;
  left = Math.max(12, Math.min(left, vw - w - 12));
  const estH = 440;
  let top = anchor.y + anchor.h + 8;
  if (top + estH > vh - 12) top = Math.max(12, anchor.y - estH - 8);
  if (top + estH > vh - 12) top = Math.max(12, vh - estH - 12);
  return `left:${Math.round(left)}px; top:${Math.round(top)}px`;
}

export function QrPopover() {
  const p = S.popover;
  if (!p) return null;
  let entry;
  try {
    entry = qrFor(p.url);
  } catch {
    entry = null;
  }
  const setup = caps().deviceSetup;
  const showFoot = tlsOn() && setup && setup.supported !== false;
  return h('div', { class: 'popover', role: 'dialog', 'aria-label': `QR code for ${p.url}`, key: 'qr', style: popoverPosition(p.anchor),
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); A.closePopover(); } } },
  entry ? h('div', { class: 'qr-box', role: 'img', 'aria-label': `QR code for ${p.url}`, html: entry.svg }) : h('p', null, 'This address is too long for a QR code.'),
  h('div', { class: 'qr-text' },
    h('span', { class: 'mono qr-url' }, Addr(p.url)),
    h('span', { class: 'qr-sub' }, 'Scan with your phone’s camera.')),
  h('div', { class: 'qr-btns' },
    h('button', { type: 'button', class: 'btn btn-s', onclick: () => A.copyUrl(p.url, `qr:${p.url}`) }, S.copied[`qr:${p.url}`] > Date.now() ? 'Copied' : 'Copy link'),
    h('button', { type: 'button', class: 'btn btn-s', disabled: !entry, onclick: () => A.downloadQr(entry.qr, p.url, entry.moduleSize) }, 'Download')),
  showFoot ? h('p', { class: 'qr-foot' }, 'First time on this phone? ',
    h('button', { type: 'button', class: 'linkish', onclick: () => { A.closePopover({ restore: false }); A.openSetup(); } }, 'Set up this device')) : null);
}

function confirmDialog(d) {
  return [
    h('h3', { id: 'dlg-title' }, d.title),
    h('p', { id: 'dlg-body' }, d.body),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn btn-s', 'data-autofocus': '', onclick: A.closeDialog }, 'Cancel'),
      h('button', { type: 'button', class: `btn ${d.danger ? 'btn-x' : 'btn-p'}`, 'data-confirm': '', onclick: () => { const run = d.run; A.closeDialog(); run(); } }, d.confirm)),
  ];
}

function resetDialog(d) {
  const ok = d.typed.trim() === 'reset';
  return [
    h('h3', { id: 'dlg-title' }, 'Reset Portless?'),
    h('div', { class: 'dbody', id: 'dlg-body' },
      h('p', null, 'This removes:'),
      // The server's list, or a neutral line until it arrives (never a partial list to confirm against).
      d.removes
        ? h('ul', null, d.removes.map((t, i) => h('li', { key: `r${i}` }, t)))
        : d.removesFailed
          ? h('p', { class: 'ferr reset-list', role: 'alert' }, T.resetListFailed, ' ',
            h('button', { type: 'button', class: 'btn btn-g', onclick: () => A.loadResetList() }, T.tryAgain))
          : h('p', { class: 'set-desc reset-list', role: 'status', 'aria-busy': 'true' }, icon('spinner'), ' ', T.resetLoading),
      h('p', { style: 'margin-top:8px' }, 'Your services keep running.')),
    h('form', { class: 'fgroup', novalidate: true, onsubmit: (e) => { e.preventDefault(); A.doReset(); } },
      h('label', { for: 'reset-confirm', class: 'flabel' }, ['Type ', h('span', { class: 'mono' }, 'reset'), ' to confirm']),
      h('div', { class: 'field mono' }, h('input', { id: 'reset-confirm', value: d.typed, autocomplete: 'off', spellcheck: 'false', disabled: d.busy, oninput: (e) => { d.typed = e.target.value; rerender(); } }))),
    d.error ? ErrorNotice(d.error) : null,
    // D59(c): a lock that arrives while the dialog is open blocks Reset too, with the same reason.
    d.busy ? null : RoutesReason('routes-reason-dlg', routesBlocked()),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn btn-s', onclick: A.closeDialog, disabled: d.busy }, 'Cancel'),
      Btn('Reset Portless', { cls: 'btn btn-x', busy: d.busy, disabled: !ok || !d.removes || (!d.busy && Boolean(routesBlocked())), onclick: A.doReset, attrs: { 'aria-describedby': !d.busy && routesBlocked() ? 'routes-reason-dlg' : null } })),
  ];
}

function setupDialog(d) {
  const s = d.setup;
  if (!s) {
    return [
      h('h3', { id: 'dlg-title' }, 'Set up another device'),
      h('p', { id: 'dlg-body' }, 'Nidum Local will open a setup page on your network for 10 minutes. You open it on the phone or laptop you want to set up, and it shows how to trust your addresses.'),
      d.error ? ErrorNotice(d.error) : null,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn btn-s', onclick: A.closeDialog }, 'Cancel'),
        Btn('Start', { cls: 'btn btn-p', busy: d.busy, onclick: A.startSetup, attrs: { 'data-autofocus': '' } })),
    ];
  }
  const left = Date.parse(s.expiresAt) - Date.now();
  const entry = qrFor(s.url);
  const os = s.steps.find((x) => x.id === d.os) || s.steps[0];
  return [
    h('h3', { id: 'dlg-title' }, 'Set up another device'),
    h('div', { class: 'setup-qr' },
      h('div', { class: 'qr-box', role: 'img', 'aria-label': `QR code for ${s.url}`, html: entry.svg }),
      h('div', { class: 'qr-text' },
        h('span', { class: 'mono qr-url' }, Addr(s.url)),
        h('span', { class: 'qr-sub' }, 'Scan this on the device, or type the address in its browser.'),
        h('span', { class: 'qr-sub', 'aria-live': 'off' }, `${countdown(left)} left`))),
    h('div', { class: 'setup-tabs', role: 'tablist', 'aria-label': T.deviceType, onkeydown: (e) => onOsKey(e, d, s.steps) },
      s.steps.map((x) => h('button', {
        type: 'button', role: 'tab', key: x.id, id: `os-tab-${x.id}`, 'aria-controls': 'os-panel',
        'aria-selected': String(x.id === os.id), tabindex: x.id === os.id ? '0' : '-1', onclick: () => { d.os = x.id; rerender(); },
      }, x.title))),
    h('ol', { role: 'tabpanel', id: 'os-panel', tabindex: '0', 'aria-labelledby': `os-tab-${os.id}` }, os.steps.map((t, i) => h('li', { key: `s${os.id}${i}` }, t))),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn btn-s', 'data-autofocus': '', onclick: A.closeDialog }, 'Done')),
  ];
}

/** Roving tablist for the OS tabs (same keys as the sidebar tabs). */
function onOsKey(e, d, steps) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const i = Math.max(0, steps.findIndex((x) => x.id === d.os));
  let n = i;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % steps.length;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + steps.length) % steps.length;
  if (e.key === 'Home') n = 0;
  if (e.key === 'End') n = steps.length - 1;
  d.os = steps[n].id;
  rerender(() => document.getElementById(`os-tab-${d.os}`)?.focus());
}

function shortcutsDialog() {
  const rows = [['/', 'Search services'], ['n', 'Add an address by port'], ['g a', 'Go to Your addresses'], ['c', 'Copy the focused address'], ['Esc', 'Close a form, popover or dialog'], ['?', 'Show these shortcuts']];
  return [
    h('h3', { id: 'dlg-title' }, 'Keyboard shortcuts'),
    h('div', { class: 'keys' }, rows.map(([k, t]) => [h('kbd', { key: `k${k}` }, k), h('span', { key: `t${k}` }, t)])),
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-s', 'data-autofocus': '', onclick: A.closeDialog }, 'Close')),
  ];
}

export function Dialog() {
  const d = S.dialog;
  if (!d) return null;
  let body;
  if (d.type === 'confirm') body = confirmDialog(d);
  else if (d.type === 'reset') body = resetDialog(d);
  else if (d.type === 'setup') body = setupDialog(d);
  else body = shortcutsDialog();
  const wide = d.type === 'setup' || d.type === 'reset' || d.type === 'shortcuts';
  // A stray click outside must not end device setup or a half-typed reset (only Esc / buttons close those).
  const outsideCloses = d.type === 'confirm' || d.type === 'shortcuts';
  return h('div', { class: 'scrim', key: `dlg-${d.type}`, onmousedown: (e) => { if (outsideCloses && e.target === e.currentTarget && !d.busy) A.closeDialog(); } },
    h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', 'aria-describedby': d.type === 'confirm' || d.type === 'reset' ? 'dlg-body' : null },
      body));
}

export function Toasts() {
  return h('div', { class: 'toasts', 'aria-live': 'polite' },
    S.toasts.map((t) => h('div', {
      class: `toast${t.action ? ' has-action' : ''}`, role: 'status', key: `t${t.id}`,
      onmouseenter: () => A.holdToast(t.id), onmouseleave: () => A.startToastTimer(t.id),
      onfocusin: () => A.holdToast(t.id), onfocusout: () => A.startToastTimer(t.id),
    },
    t.icon && !t.action ? icon(t.icon) : null,
    h('p', null, t.text),
    t.action ? h('button', { type: 'button', class: 'btn btn-g btn-link', onclick: () => { A.dismissToast(t.id); t.action.run(); } }, t.action.label) : null)));
}

export { errorText };
