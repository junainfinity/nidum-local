// Nidum Local dashboard — addresses that only break at "." or before ":" (spec §1: the address is the product).
//
// "dashboard.local:46703" renders as [dashboard.]<wbr>[local]<wbr>[:46703]: each piece is an
// inline-block capped at 100 % of the line, so a line ends only between pieces; a single label wider
// than the whole line is the one case that may still break inside itself. Selecting or copying the
// text gives the same characters.
import { h } from './dom.js';

/** Pieces of an address: each label with its trailing ".", and the ":port". */
export function addrPieces(text) {
  let s = String(text || '');
  let tail = '';
  const slash = /\/[^/]*$/.exec(s.replace(/^[a-z]+:\/\//i, (m) => '#'.repeat(m.length)));
  if (slash) {
    tail = s.slice(slash.index);
    s = s.slice(0, slash.index);
  }
  const colon = s.lastIndexOf(':');
  const host = colon > 0 && /^\d+$/.test(s.slice(colon + 1)) ? s.slice(0, colon) : s;
  const port = host === s ? '' : s.slice(colon);
  const labels = host.split('.');
  const pieces = labels.map((l, i) => (i < labels.length - 1 ? `${l}.` : l)).filter(Boolean);
  if (port) pieces.push(port);
  if (tail) pieces[pieces.length - 1] += tail;
  return pieces;
}

/** The visual pieces only, hidden from assistive tech (use with an aria-label or `Addr`). */
export function AddrPieces(text) {
  const out = [];
  addrPieces(text).forEach((p, i) => {
    if (i) out.push(h('wbr'));
    out.push(h('span', { class: 'ap' }, p));
  });
  return h('span', { class: 'addr-vis', 'aria-hidden': 'true' }, out);
}

/**
 * An address for any text context: screen readers and braille get the whole address as one string
 * (visually hidden, not selectable, so copying a selection doesn't double it); sighted users get the
 * pieces that only break after "." or before ":".
 */
export function Addr(text) {
  return [h('span', { class: 'sr-only addr-sr' }, String(text || '')), AddrPieces(text)];
}

/** A mono address span, for sentences (toasts, dialog titles, notices). */
export function AddrSpan(text) {
  return h('span', { class: 'mono addr' }, Addr(text));
}

/** Same, in the surrounding font (dialog titles, as on the popovers board). */
export function AddrText(text) {
  return h('span', { class: 'addr' }, Addr(text));
}

/** Text with every occurrence of `host` (optionally with :port) rendered as an address. */
export function withAddr(text, host) {
  const s = String(text || '');
  if (!host || !s.includes(host)) return s;
  const out = [];
  const re = new RegExp(`${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:\\d+)?`, 'g');
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(AddrSpan(m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const widths = new Map();
let probe = null;
/** Width in px of an address on one line in the chip font (mono 15/500), measured in the DOM. */
export function addrWidth(text) {
  const t = String(text || '');
  if (widths.has(t)) return widths.get(t);
  if (!probe) {
    probe = document.createElement('span');
    probe.className = 'mono addr-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;margin:0';
    document.body.appendChild(probe);
  }
  probe.textContent = t;
  const w = probe.getBoundingClientRect().width;
  if (w > 0) widths.set(t, w);
  return w || t.length * 9.1;
}

// ---------------------------------------------------------------- file paths and commands (E13)
//
// Paths follow the same rule as addresses: a line ends only after "/" (or at a space between the
// words of a command), never inside a folder name unless that one name is wider than the line.
// Everything is text nodes (no HTML), and assistive tech gets the whole string once.

/** Pieces of one word of a path or command: each ends after "/". */
export function pathPieces(text) {
  return String(text || '').match(/[^/]*(?:\/|$)/g).filter(Boolean);
}

/** Words as inline-block pieces (break only after "/"), joined by ordinary breakable spaces. */
function pieces(text) {
  const out = [];
  String(text || '').split(/(\s+)/).forEach((word) => {
    if (!word) return;
    if (/^\s+$/.test(word)) {
      out.push(word);
      return;
    }
    pathPieces(word).forEach((p, i) => {
      if (i) out.push(h('wbr'));
      out.push(h('span', { class: 'ap' }, p));
    });
  });
  return out;
}

/** A path inside a sentence (mono). */
export function PathText(path) {
  return h('span', { class: 'mono path' }, h('span', { class: 'sr-only addr-sr' }, String(path || '')), h('span', { class: 'addr-vis', 'aria-hidden': 'true' }, pieces(path)));
}

/** A Terminal command as one code block (mono), breaking only after "/" or between words. */
export function CommandText(cmd, attrs = {}) {
  return h('code', { class: 'mono cmd', ...attrs }, h('span', { class: 'sr-only addr-sr' }, String(cmd || '')), h('span', { class: 'addr-vis', 'aria-hidden': 'true' }, pieces(cmd)));
}

/** Quote a path for a POSIX shell (single quotes unless it only has plainly safe characters). */
export function shellQuote(path) {
  const s = String(path || '');
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
