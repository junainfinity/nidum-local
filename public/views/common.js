// Shared view pieces: address chip, inline notice, error notice, section head, switch.
import { AddrPieces, AddrSpan, CommandText, PathText, shellQuote, withAddr } from '../addr.js';
import { T } from '../strings.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { ROUTES_CODES, S, routesBlocked } from '../store.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';
import { displayAddress } from '../util.js';

/** Address chip: address link + Copy / Open / QR (design spec §7.4). */
export function AddressChip(url, { where = 'x' } = {}) {
  const shown = displayAddress(url);
  const host = shown.split(':')[0];
  const key = `${where}:${url}`;
  const copied = S.copied[key] > Date.now();
  const copyErr = S.copyErr[key];
  return h('div', { class: 'chip-wrap' }, h('div', { class: 'chip' },
    // aria-label: assistive tech gets the whole address, not the visual break pieces.
    h('a', { href: url, class: 'mono chip-addr', target: '_blank', rel: 'noopener noreferrer', title: `Open ${url}`, 'aria-label': shown }, AddrPieces(shown)),
    // The three buttons wrap as one unit below a long address (never split between lines).
    h('span', { class: 'chip-btns' },
    h('button', { type: 'button', class: 'btn btn-i', 'aria-label': `Copy ${url}`, title: copied ? 'Copied' : 'Copy', 'data-copy': host, onclick: () => A.copyUrl(url, key), 'aria-describedby': copyErr ? `cperr-${where}-${host}` : null },
      icon(copied ? 'check' : 'copy', { cls: copied ? 'ok' : '' })),
    h('button', { type: 'button', class: 'btn btn-i', 'aria-label': `Open ${url}`, title: 'Open', onclick: () => A.openUrl(url) }, icon('open')),
    h('button', { type: 'button', class: 'btn btn-i', 'aria-label': `Show QR code for ${url}`, title: 'QR code', 'aria-haspopup': 'dialog', 'data-qr': url, onclick: (e) => A.openQr(url, e.currentTarget) }, icon('qr')))),
  copyErr ? h('p', { class: 'ferr chip-err', id: `cperr-${where}-${host}`, role: 'alert' }, copyErr) : null);
}

/**
 * Inline notice (design spec §7.13): glyph, one-line cause, optional fix, actions.
 * @param {{ kind?: 'warning'|'error'|'info'|'ok', title: any, fix?: string, fixLabel?: any, actions?: any[], raw?: string, role?: string, key?: string }} o
 */
export function Notice(o) {
  const kind = o.kind || 'warning';
  const ic = kind === 'error' ? 'alert' : kind === 'info' ? 'info' : kind === 'ok' ? 'check' : 'triangle';
  return h('div', { class: `notice n-${kind}`, role: o.role || (kind === 'error' ? 'alert' : null), key: o.key || null },
    icon(ic),
    h('div', { class: 'notice-body' },
      h('p', { class: 'notice-title' }, o.title),
      o.text ? h('p', { class: 'notice-fix' }, o.text) : null,
      o.fix ? h('div', { class: 'notice-fix' }, o.fixLabel || null,
        h('code', { class: 'mono' }, o.fix),
        h('button', { type: 'button', class: 'btn btn-g', onclick: () => A.copyUrl(o.fix, `fix:${o.fix}`) }, 'Copy')) : null,
      o.extra || null,
      o.raw ? h('details', null, h('summary', null, 'Details'), h('pre', null, o.raw)) : null,
      o.actions && o.actions.length ? h('div', { class: 'notice-actions' }, o.actions) : null,
    ));
}

/** Notice for an ApiError, with Details for `raw`. */
export function ErrorNotice(err, { title, actions = [], key } = {}) {
  if (!err) return null;
  return Notice({ kind: 'error', title: title ? [title, ' ', errorText(err)] : errorText(err), raw: err.raw, actions, key, extra: routesErrorFix(err) });
}

// ---------------------------------------------------------------- E13: locked address list

function splitPath(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? { dir: '/', base: s.replace(/^\//, '') } : { dir: s.slice(0, i), base: s.slice(i + 1) };
}

/** One copyable Terminal command: the command in a code block and a Copy button (copies it exactly). */
function commandRow(cmd, where) {
  const key = `cmd:${where}:${cmd}`;
  const copied = S.copied[key] > Date.now();
  const err = S.copyErr[key];
  const errId = `cmderr-${where}`;
  return h('div', { class: 'fix-cmd' },
    CommandText(cmd, { 'data-cmd': cmd }),
    h('button', { type: 'button', class: 'btn btn-s btn-sm', 'aria-label': T.copyCommandLabel(cmd), 'data-copy-cmd': cmd, 'aria-describedby': err ? errId : null, onclick: () => A.copyCommand(cmd, key) },
      icon(copied ? 'check' : 'copy', { cls: copied ? 'ok' : '' }), T.copyCommand),
    err ? h('p', { class: 'ferr', id: errId, role: 'alert' }, err) : null);
}

/**
 * The plain-words fix for a locked (`kind: 'locked'`, details `{ path, flag, target, owner, ownedByYou }`)
 * or not-writable (`kind: 'not-writable'`, details `{ path, target, owner, ownedByYou }`) address list
 * (E13, D51, D53, D59). Paths are text; the copied command quotes the path for the shell.
 *
 * - File or folder comes only from `details.target`. Without it the copy names the item itself
 *   ("routes.json belongs to …"), which fits both, and `chmod` uses `u+rwX` (x only for a folder).
 * - D59(b): every command ends its options with `--` before its operands. macOS's chflags, chmod and
 *   chown stop reading options at their first operand (the flags, the mode or the owner), so `--`
 *   goes right after the command name: a `--` after the flags would be taken as a file named "--".
 */
export function RoutesFix(kind, details, { where = 'banner' } = {}) {
  const d = details || {};
  const path = d.path || '';
  if (!path) return null;
  const q = shellQuote(path);
  const target = d.target === 'folder' || d.target === 'file' ? d.target : null; // never guessed from the path
  const what = target === 'folder' ? T.folder : target === 'file' ? T.file : null;
  const { dir, base } = splitPath(path);
  const item = PathText(base);
  const sudoNote = () => h('p', { class: 'fix-note' }, T.fixSudoNote);
  const parts = [];
  if (kind === 'locked') {
    if (d.flag === 'schg') {
      parts.push(h('p', null, T.fixSchgIntro), commandRow(`sudo chflags -- noschg ${q}`, where), sudoNote());
    } else if (d.ownedByYou === false) {
      // D59(a): another account's lock needs an administrator: Terminal with sudo.
      parts.push(h('p', null, T.lockedNotYours(what, item, d.owner || null), ' ', T.fixInTerminal),
        commandRow(`sudo chflags -- nouchg ${q}`, where), sudoNote());
    } else {
      // Finder hides dot-folders: show hidden items before selecting one (Command-Shift-Period).
      parts.push(h('p', null, T.fixFinder(PathText(dir), PathText(base), (t) => h('strong', null, t), base.startsWith('.'))),
        h('p', null, T.fixOrTerminal));
      if (d.ownedByYou === true) parts.push(commandRow(`chflags -- nouchg ${q}`, where));
      else parts.push(commandRow(`sudo chflags -- nouchg ${q}`, where), sudoNote()); // D59(a): owner unknown
    }
  } else if (d.ownedByYou === true) {
    const mode = target === 'folder' ? 'u+rwx' : target === 'file' ? 'u+rw' : 'u+rwX';
    parts.push(h('p', null, what ? T.notWritableYours(what) : T.notWritableYoursItem(item), ' ', T.fixInTerminal), commandRow(`chmod -- ${mode} ${q}`, where));
  } else {
    let text;
    if (d.owner) text = what ? T.notWritableOwner(what, d.owner) : T.notWritableOwnerItem(item, d.owner);
    else text = what ? T.notWritableUnknown(what) : T.notWritableUnknownItem(item);
    parts.push(h('p', null, text, ' ', T.fixInTerminal),
      commandRow(`sudo chown -- "$USER" ${q}`, where), sudoNote());
  }
  return h('div', { class: 'routes-fix', 'data-routes-fix': kind, 'data-target': target || 'unknown' }, parts);
}

/**
 * "Replace it" next to a "taken" name. It overwrites an address, so it is disabled while the list
 * is locked or not writable (D59(c)), pointing at the section's visible reason line.
 */
export function ReplaceBtn(onclick, reasonId) {
  const blocked = Boolean(routesBlocked());
  return h('button', { type: 'button', class: 'btn btn-g btn-d', 'data-replace': '', disabled: blocked, 'aria-describedby': blocked ? reasonId : null, onclick }, T.replaceIt);
}

/** The same fix under an inline mutation error with either E13 code (the page's state may be stale). */
export function routesErrorFix(err, where = 'inline') {
  if (!err || !ROUTES_CODES.includes(err.code)) return null;
  return RoutesFix(err.code === 'ROUTES_LOCKED' ? 'locked' : 'not-writable', err.details, { where });
}

/** The visible reason under a section whose route-changing buttons are disabled (E13). */
export function RoutesReason(id, reason) {
  if (!reason) return null;
  return h('p', { id, key: id, class: 'set-desc reason-line routes-reason', role: 'note' }, icon('lock'), reason);
}

export function SectionHead(id, title, desc, right = null, { end = false } = {}) {
  return h('div', { class: `sec-head${end ? ' end' : ''}` },
    h('div', { class: 'sec-titles' },
      h('h2', { id: 'panel-h', tabindex: '-1', 'data-section': id }, title),
      h('p', null, desc)),
    right);
}

export function Switch({ checked, label, labelledby, disabled, busy, onchange, title, describedby }) {
  return h('button', {
    type: 'button', class: `sw${busy ? ' busy' : ''}`, role: 'switch', 'aria-checked': String(Boolean(checked)),
    'aria-label': label || null, 'aria-labelledby': labelledby || null, 'aria-describedby': describedby || null,
    'aria-busy': busy ? 'true' : null, disabled: Boolean(disabled || busy), title: title || null,
    onclick: () => onchange(!checked),
  }, h('span', null));
}

/**
 * A button that keeps its label and width while busy (design spec §7.3): a spinner replaces the
 * icon; a button without an icon shows the spinner over its (still present) label. `busyLabel` is
 * only for the spec's one exception, "Waiting for your password…" (§7.16).
 */
export function Btn(label, { cls = 'btn btn-s', busy = false, busyLabel, disabled = false, onclick, iconName, attrs = {} } = {}) {
  const shown = busy && busyLabel ? busyLabel : label;
  const overlay = busy && !iconName && !busyLabel;
  return h('button', { type: 'button', class: `${cls}${busy ? ' busy' : ''}${overlay ? ' spin-over' : ''}`, disabled: Boolean(disabled || busy), 'aria-busy': busy ? 'true' : null, onclick, ...attrs },
    busy && !overlay ? icon('spinner') : iconName ? icon(iconName) : null,
    h('span', { class: 'btn-label' }, shown),
    overlay ? h('span', { class: 'btn-spin', 'aria-hidden': 'true' }, icon('spinner')) : null);
}

export function hostCheckNotice(route) {
  const c = route.hostCheck;
  if (!c || c.ok) return null;
  const busy = S.rowBusy[route.hostname] === 'check';
  const fix = c.fix || null;
  let fixLabel = null;
  if (fix && /vite\.config\.js/.test(fix)) fixLabel = ['Add this to ', h('span', { class: 'mono' }, 'vite.config.js'), ':'];
  const vite = c.result === 'host-blocked' && c.framework === 'Vite';
  return Notice({
    kind: 'warning',
    key: `hc-${route.hostname}`,
    title: vite ? [AddrSpan(route.hostname), ' works, but Vite blocked the name.'] : withAddr(c.message, route.hostname),
    fix: vite ? "server: { allowedHosts: ['.local'] }" : null,
    fixLabel,
    text: vite ? null : withAddr(fix, route.hostname),
    actions: [Btn('Check again', { cls: 'btn btn-s btn-sm', busy, onclick: () => A.checkRoute(route) })],
  });
}
