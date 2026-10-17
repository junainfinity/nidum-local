// Nidum Local dashboard — pure helpers (names, URLs, text).

export const TLD = 'local';
/** Contracts §1 reserved names. */
export const RESERVED = ['run', 'get', 'alias', 'hosts', 'list', 'doctor', 'trust', 'clean', 'prune', 'proxy', 'service', 'setup'];
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** As the user types: lowercase, spaces/underscores → dashes (design spec §7.7). */
export function normalizeNameInput(s) {
  return String(s).toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Validate a name (Contracts §1). Returns `{ name }` or `{ error, kind }`.
 * A typed trailing `.local` is stripped.
 */
export function checkName(raw) {
  let name = String(raw ?? '').trim().toLowerCase();
  if (name.endsWith(`.${TLD}`)) name = name.slice(0, -(TLD.length + 1));
  if (!name) return { kind: 'empty', error: 'Give it a name.' };
  const labels = name.split('.');
  if (labels.some((l) => l.length > 63)) return { kind: 'long', error: 'Keep each part under 64 characters.' };
  if (`${name}.${TLD}`.length > 253) return { kind: 'long', error: 'That name is too long.' };
  if (!labels.every((l) => LABEL.test(l))) return { kind: 'chars', error: 'Use lowercase letters, numbers and dashes.' };
  if (RESERVED.includes(name)) return { kind: 'reserved', error: `${name} is reserved by Portless. Try ${name}-app.`, suggestion: `${name}-app` };
  return { name };
}

/** Validate a port string. Returns `{ port }` or `{ error }`. */
export function checkPort(raw, proxyPort) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'empty', error: 'Enter a port.' };
  if (!/^\d+$/.test(s)) return { kind: 'range', error: 'Ports go from 1 to 65535.' };
  const port = Number(s);
  if (port < 1 || port > 65535) return { kind: 'range', error: 'Ports go from 1 to 65535.' };
  if (proxyPort && port === proxyPort) return { kind: 'proxy', error: `Port ${port} is used by Nidum Local's network sharing.` };
  return { port };
}

/** Contracts §1 formatUrl. */
export function formatUrl(hostname, port, tls) {
  const scheme = tls ? 'https' : 'http';
  const def = tls ? 443 : 80;
  return !port || port === def ? `${scheme}://${hostname}` : `${scheme}://${hostname}:${port}`;
}

/** What the UI shows for an address: hostname[:port] (Contracts §1). */
export function displayAddress(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** "…/code/recipes" from "/Users/me/code/recipes" (design spec §10). */
export function shortFolder(cwd) {
  if (!cwd || cwd === '/') return null;
  let rest = cwd.replace(/^\/(Users|home)\/[^/]+/, '').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '');
  const parts = rest.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return '~';
  return `…/${parts.slice(-2).join('/')}`;
}

/** "~/code/recipes" (tooltip). */
export function homeFolder(cwd) {
  if (!cwd) return '';
  return cwd.replace(/^\/(Users|home)\/[^/]+/, '~');
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 seconds ago" up to 1 hour, then local time (design spec §10). */
export function relTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 1) return 'a moment ago';
  if (s < 60) return s === 1 ? '1 second ago' : `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const d = new Date(ms);
  return `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function countdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Copy text; true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}
