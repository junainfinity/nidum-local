// The only place Nidum Local talks to Portless (node N1).
//
// Interface pinned in docs/Nidum Local/Plan/Contracts.md §1–§2. Behaviour of
// Portless 0.15.6 this relies on is cited in
// docs/Nidum Local/Research/2026-10-15 Portless CLI internals.md.
//
// - Routes are read from `routes.json` directly (torn reads retried, then
//   STATE_UNREADABLE — never a silent []), and mutated by an async,
//   non-blocking implementation of Portless's file protocol (`FileRouteStore`:
//   `mkdir routes.lock`, check under the lock, one in-place write) — never
//   through `portless alias`, so the hostname is always `<name>.local` whatever
//   TLD the proxy has (D16). Portless's own blocking `RouteStore` is only a test
//   cross-check (`routeBackend: 'routestore'`). Mutations are serialised per instance.
// - Every CLI call goes through `run()`: execFile on the unresolved launcher
//   (`launcherPath`, e.g. /opt/homebrew/bin/portless — it carries its own Node
//   shebang and is what a service definition records, D17), never a shell,
//   always a timeout, NO_COLOR=1, instance env merged with the per-call env.
// - A route write the OS refuses (EPERM/EACCES/EROFS on routes.json or the
//   routes.lock mkdir) is explained, never fixed: ROUTES_LOCKED when the file or
//   its folder has the macOS `uchg`/`schg` flag (`/usr/bin/stat -L -f`, read
//   through symlinks, 2 s timeout; Linux `lsattr` experimental), else
//   ROUTES_NOT_WRITABLE with the owner and `ownedByYou` (E13, D51); both name
//   the blocking path's `target` (file/folder, D53). A stale routes.lock the
//   write can't remove counts too.
//   `getRoutesAccess()` reports the same read-only, cached 2 s. PERMISSION
//   stays "admin dialog cancelled/refused".
// - Commands that need root are run whole through `elevate()` (src/elevate.js).
// - `safeMode` (every live test) allowlists `run()` argv, forces LAN/HTTPS/hosts
//   sync off, refuses destructive wrappers, privileged ports, elevation, a
//   `proxy stop` aimed at another user's pid, and any mutation outside an
//   absolute, `..`-free state dir that is not (inside) a real one.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { elevate as defaultElevate } from './elevate.js';

/** Portless version whose `RouteStore` is imported; others use the file protocol. */
export const PINNED_VERSION = '0.15.6';
/** The only TLD Nidum Local creates routes under. */
export const TLD = 'local';
/** Portless's 11 subcommand names plus Nidum's `setup` (device-setup page). */
export const RESERVED_NAMES = Object.freeze([
  'run', 'get', 'alias', 'hosts', 'list', 'doctor', 'trust', 'clean', 'prune', 'proxy', 'service', 'setup',
]);
/**
 * Every `PortlessError.code` (Contracts §2, E13). `PERMISSION` means only an
 * admin dialog that was cancelled or refused (or a CLI that needed root);
 * a route write the OS refuses is `ROUTES_LOCKED` (macOS `uchg`/`schg` flag on
 * routes.json or its folder) or `ROUTES_NOT_WRITABLE` (anything else).
 */
export const ERROR_CODES = Object.freeze([
  'CLI_MISSING', 'NAME_TAKEN', 'NAME_TAKEN_BY_APP', 'INVALID_NAME', 'INVALID_PORT', 'NOT_FOUND', 'PORT_IN_USE',
  'PERMISSION', 'TIMEOUT', 'PROXY_DOWN', 'SERVICE_MANAGED', 'STATE_UNREADABLE', 'ROUTES_LOCKED', 'ROUTES_NOT_WRITABLE',
  'UNSUPPORTED', 'UNKNOWN',
]);
/** Where Portless writes its startup-service definition (cli.js:3751, 3763, 3770-3771). */
export const SERVICE_PATHS = Object.freeze({
  darwin: '/Library/LaunchDaemons/sh.portless.proxy.plist',
  linux: '/etc/systemd/system/portless.service',
});

/**
 * Text of the OS password dialog for each elevated action (graph validation 2
 * F4: without it macOS says "osascript wants to make changes"). Plain words.
 */
export const ELEVATION_PROMPTS = Object.freeze({
  start: (port) => `Nidum Local needs your password to start network sharing on port ${port}.`,
  stop: 'Nidum Local needs your password to stop network sharing.',
  serviceStart: 'Nidum Local needs your password to start network sharing.',
  serviceInstall: 'Nidum Local needs your password to set up sharing to start automatically.',
  serviceUninstall: 'Nidum Local needs your password to turn off automatic sharing.',
  trust: 'Nidum Local needs your password to trust its local certificate.',
  hostsSync: "Nidum Local needs your password to fix Safari's address list.",
  clean: 'Nidum Local needs your password to reset Portless.',
  other: 'Nidum Local needs your password to change network sharing.',
});

const DEFAULT_TIMEOUT_MS = 15000;
const ELEVATED_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 1000;
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** Ports a safe-mode instance never touches (the real proxy, Portless probes, Nidum's server). */
const SAFE_MODE_FORBIDDEN_PORTS = new Set([80, 443, 1355, 47800]);

/**
 * Safe-mode allowlist for `run()` argv. Returns null when allowed, else the
 * reason. Exactly: `--version`, `-v`, `--help`, `-h`, `doctor`, `list`,
 * `get <name>`, `service status`, and `proxy start|stop` with exactly one
 * all-digit `-p`/`--port` ≥ 1024 (not 1355/47800) — `start` additionally only
 * `--no-tls` (required), `--tld local`, `--skip-trust`. Nothing else: no global
 * flags (`--lan`, `--ip`, `--lan-ip-auto`, `--tailscale`, `--funnel`, `--ngrok`,
 * `--script`, `--name`, `--force`, `--`), no app commands.
 * @param {string[]} args
 * @returns {string | null}
 */
export function safeArgsProblem(args) {
  const exact = [['--version'], ['-v'], ['--help'], ['-h'], ['doctor'], ['list'], ['service', 'status']];
  if (exact.some((e) => e.length === args.length && e.every((w, i) => w === args[i]))) return null;
  if (args.length === 2 && args[0] === 'get' && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(args[1])) return null;
  if (args[0] === 'proxy' && (args[1] === 'start' || args[1] === 'stop')) {
    const start = args[1] === 'start';
    let port = null;
    let noTls = false;
    let tld = false;
    let skipTrust = false;
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '-p' || a === '--port') {
        if (port !== null) return 'Safe mode allows exactly one -p.';
        const v = rest[i + 1];
        if (typeof v !== 'string' || !/^\d+$/.test(v)) return 'Safe mode needs a numeric -p.';
        port = Number(v);
        i += 1;
      } else if (start && a === '--no-tls' && !noTls) {
        noTls = true;
      } else if (start && a === '--tld' && !tld && rest[i + 1] === TLD) {
        tld = true;
        i += 1;
      } else if (start && a === '--skip-trust' && !skipTrust) {
        skipTrust = true;
      } else {
        return `Safe mode doesn't allow "${a}" in portless proxy ${args[1]}.`;
      }
    }
    if (port === null) return `Safe mode needs an explicit -p for portless proxy ${args[1]}.`;
    if (port < 1024 || port > 65535 || SAFE_MODE_FORBIDDEN_PORTS.has(port)) return `Port ${port} is disabled in safe mode.`;
    if (start && !noTls) return 'Safe mode needs --no-tls (TLS would trust a CA in the keychain).';
    return null;
  }
  return `portless ${args.join(' ')} is not allowed in safe mode.`;
}

const DEFAULT_MESSAGES = {
  CLI_MISSING: "Portless isn't installed anymore.",
  NAME_TAKEN: 'That name is already in use.',
  NAME_TAKEN_BY_APP: 'That name is used by a running app. Stop that app or pick another name.',
  INVALID_NAME: 'Names can use lowercase letters, numbers, dots and dashes.',
  INVALID_PORT: 'Ports are whole numbers from 1 to 65535.',
  NOT_FOUND: "That address doesn't exist.",
  PORT_IN_USE: 'Another program is using the web port.',
  PERMISSION: 'Portless needs administrator rights for this.',
  TIMEOUT: 'This is taking longer than expected.',
  PROXY_DOWN: 'Sharing is off.',
  SERVICE_MANAGED: 'Sharing is kept on by the startup service. Turn off Keep sharing after restart to pause.',
  STATE_UNREADABLE: 'Couldn’t read Portless’s list of addresses. Try again.',
  ROUTES_LOCKED: "Your address list is locked, so Nidum Local can't change it.",
  ROUTES_NOT_WRITABLE: "Nidum Local isn't allowed to change your address list.",
  UNSUPPORTED: "This isn't supported here.",
  UNKNOWN: 'Something went wrong. Nothing was changed.',
};

/**
 * Error raised by every adapter function. `code` is one of ERROR_CODES;
 * `raw` is the ANSI-stripped CLI output (for the UI's "Details"); `details`
 * is structured extra data (e.g. the conflicting route).
 */
export class PortlessError extends Error {
  /**
   * @param {string} code  one of ERROR_CODES (anything else becomes UNKNOWN)
   * @param {string} [message]  plain-language text; defaults per code
   * @param {{ raw?: string, details?: object, cause?: unknown }} [extra]
   */
  constructor(code, message, { raw, details, cause } = {}) {
    const known = ERROR_CODES.includes(code) ? code : 'UNKNOWN';
    super(message || DEFAULT_MESSAGES[known]);
    this.name = 'PortlessError';
    this.code = known;
    if (raw !== undefined) this.raw = raw;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }

  /** Shape of the API error body (Contracts §7) minus the HTTP status. */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    if (this.raw !== undefined) out.raw = this.raw;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Remove ANSI escape sequences (CSI and OSC).
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '');
}

/**
 * Same as Portless's `formatUrl` (chunk.js:73-77): no port for 80/HTTP or 443/HTTPS.
 * @param {string} hostname
 * @param {number} port
 * @param {boolean} [tls]
 * @returns {string}
 */
export function formatUrl(hostname, port, tls = false) {
  const proto = tls ? 'https' : 'http';
  return port === (tls ? 443 : 80) ? `${proto}://${hostname}` : `${proto}://${hostname}:${port}`;
}

/** @param {string} name @returns {boolean} */
export function isReservedName(name) {
  return RESERVED_NAMES.includes(name);
}

/**
 * Validate a user-facing name (Contracts §1) and return it normalised (a typed
 * trailing `.local` removed). Nothing else is changed: uppercase, spaces and
 * underscores are rejected, not rewritten.
 *
 * @param {string} input
 * @returns {string} the name without TLD
 * @throws {PortlessError} INVALID_NAME with `details.reason` ∈
 *   `empty | uppercase | underscore | characters | label-too-long | too-long | reserved`
 */
export function validateName(input) {
  const fail = (reason, message) => {
    throw new PortlessError('INVALID_NAME', message, { details: { reason, input } });
  };
  if (typeof input !== 'string') fail('empty', 'Enter a name.');
  let name = input;
  if (name.endsWith(`.${TLD}`)) name = name.slice(0, -(TLD.length + 1));
  if (name === '') fail('empty', 'Enter a name.');
  if (!NAME_RE.test(name)) {
    if (/[A-Z]/.test(name)) fail('uppercase', 'Use lowercase letters only.');
    if (name.includes('_')) fail('underscore', 'Underscores aren’t allowed. Use a dash instead.');
    fail('characters', 'Names can use lowercase letters, numbers, dots and dashes, and must start and end with a letter or number.');
  }
  if (name.split('.').some((label) => label.length > 63)) fail('label-too-long', 'Each part of the name must be 63 characters or fewer.');
  if (`${name}.${TLD}`.length > 253) fail('too-long', 'That name is too long.');
  if (isReservedName(name)) fail('reserved', `“${name}” is reserved. Pick another name.`);
  return name;
}

/**
 * Validate a TCP port (integer 1–65535; a string of digits is accepted).
 * @param {unknown} port
 * @returns {number}
 * @throws {PortlessError} INVALID_PORT
 */
export function validatePort(port) {
  const n = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new PortlessError('INVALID_PORT', undefined, { details: { port: typeof port === 'number' || typeof port === 'string' ? port : String(port) } });
  }
  return n;
}

function isValidRoute(v) {
  // Same predicate as RouteStore (chunk.js:923-925).
  return typeof v === 'object' && v !== null && typeof v.hostname === 'string' && typeof v.port === 'number' && typeof v.pid === 'number';
}

/**
 * `process.kill(pid, 0)` status. RouteStore's own alive check treats every
 * error (EPERM included) as dead (chunk.js:1009-1016); Portless's exported
 * `isProcessAlive` treats EPERM as alive (chunk.js:61-68).
 * @param {number} pid
 * @returns {'alive' | 'eperm' | 'dead'}
 */
export function pidStatus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return err && err.code === 'EPERM' ? 'eperm' : 'dead';
  }
}

/**
 * Parse `routes.json` text and alive-filter it exactly like
 * `RouteStore.loadRoutes` (chunk.js:1023-1054): invalid JSON or a non-array →
 * []; entries must be `{hostname: string, port: number, pid: number}`; app
 * routes (pid ≠ 0) survive only while `kill(pid, 0)` succeeds.
 * @param {string | null} text
 * @param {{ isAlive?: (pid: number) => boolean }} [opts]
 * @returns {Array<{ hostname: string, port: number, pid: number }>}
 */
export function parseRoutes(text, { isAlive = (pid) => pidStatus(pid) === 'alive' } = {}) {
  if (text == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidRoute).filter((r) => r.pid === 0 || isAlive(r.pid));
}

/**
 * Strict variant for readers: `null` when the text is empty or not a JSON
 * array (e.g. caught between truncate and write), else the same result as
 * `parseRoutes`.
 * @param {string} text
 * @returns {Array<{ hostname: string, port: number, pid: number }> | null}
 */
export function parseRoutesStrict(text, opts) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    if (!Array.isArray(JSON.parse(text))) return null;
  } catch {
    return null;
  }
  return parseRoutes(text, opts);
}

/** Retries for a torn/empty `routes.json` read before STATE_UNREADABLE. */
export const ROUTES_READ_RETRIES = 5;
export const ROUTES_READ_RETRY_MS = 20;

/**
 * Raw route → contract route (Contracts §2).
 * @param {{ hostname: string, port: number, pid: number }} raw
 * @param {{ port: number, tls: boolean }} proxy
 */
export function toRoute(raw, proxy) {
  const suffix = `.${TLD}`;
  const local = raw.hostname.endsWith(suffix) && raw.hostname.length > suffix.length;
  return {
    name: local ? raw.hostname.slice(0, -suffix.length) : raw.hostname,
    hostname: raw.hostname,
    url: formatUrl(raw.hostname, proxy.port, proxy.tls),
    port: raw.port,
    kind: raw.pid === 0 ? 'alias' : 'app',
    pid: raw.pid,
    foreignTld: !local,
  };
}

/**
 * Parse `portless doctor` output (cli.js:6168-6174, 6274-6280, 6497-6512).
 * @param {string} text
 * @returns {{ header: Record<string, string>, findings: Array<{ status: 'ok'|'warn'|'fail'|'info', message: string, hint?: string }>, summary: { failures: number, warnings: number } | null }}
 */
export function parseDoctor(text) {
  const header = {};
  const findings = [];
  let summary = null;
  const HEADER_KEYS = { 'Version': 'version', 'Node.js': 'node', 'Platform': 'platform', 'State dir': 'stateDir', 'Proxy target': 'proxyTarget', 'Mode': 'mode' };
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const f = /^(ok|warn|fail|info)\s+(\S.*)$/.exec(line);
    if (f) {
      findings.push({ status: f[1], message: f[2].trimEnd() });
      continue;
    }
    const h = /^ {6}(\S.*)$/.exec(line);
    if (h && findings.length) {
      const last = findings[findings.length - 1];
      last.hint = last.hint ? `${last.hint}\n${h[1].trimEnd()}` : h[1].trimEnd();
      continue;
    }
    const s = /^Summary: (\d+) failures?, (\d+) warnings?\./.exec(line);
    if (s) {
      summary = { failures: Number(s[1]), warnings: Number(s[2]) };
      continue;
    }
    const kv = /^([A-Za-z. ]+): (.*)$/.exec(line);
    if (kv && HEADER_KEYS[kv[1]] && !findings.length) header[HEADER_KEYS[kv[1]]] = kv[2].trim();
  }
  return { header, findings, summary };
}

/**
 * Parse `portless service status` output (cli.js:4195-4215).
 * @param {string} text
 */
export function parseServiceStatus(text) {
  const map = {};
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const m = /^ {2}([^:]+): (.*)$/.exec(line);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  const yes = (v) => (v === undefined ? null : v === 'yes');
  const proxyKey = Object.keys(map).find((k) => /^Proxy on \d+$/.test(k));
  return {
    managerState: map['Manager state'] ?? null,
    installed: yes(map['Installed']),
    proxyPort: proxyKey ? Number(proxyKey.slice('Proxy on '.length)) : null,
    proxyResponding: proxyKey ? map[proxyKey] === 'responding' : null,
    tls: yes(map['HTTPS']),
    tlds: map['TLDs'] ? map['TLDs'].split(',').map((t) => t.trim().replace(/^\./, '')).filter(Boolean) : [],
    lan: yes(map['LAN mode']),
    lanIp: map['LAN IP'] ?? null,
    wildcard: yes(map['Wildcard']),
    stateDir: map['State directory'] ?? null,
    serviceEntry: map['Service entry'] ?? null,
  };
}

// --- service definitions (read the file; never shell out in the polling path)

function xmlUnescape(v) {
  return v.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function parseQuotedWords(input, { unescapeBackslash = true } = {}) {
  // Port of Portless's parser (cli.js:3816-3846) for systemd/Windows definitions.
  const words = [];
  let current = '';
  let inQuote = false;
  let inWord = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      inQuote = !inQuote;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || (unescapeBackslash && input[i + 1] === '\\'))) {
      current += input[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch) && !inQuote) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * Parse a Portless service definition into its argv and environment, the way
 * Portless itself reads it back (`readInstalledServiceSnapshot`, cli.js:3861-3929).
 * @param {string} text
 * @param {'darwin' | 'linux' | 'win32'} platform
 * @returns {{ argv: string[], env: Record<string, string> } | null}
 */
export function parseServiceDefinition(text, platform) {
  if (typeof text !== 'string') return null;
  if (platform === 'darwin') {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    if (!args) return null;
    const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
    const argv = [...args[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
    const env = {};
    if (envBlock) {
      for (const m of envBlock[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) env[xmlUnescape(m[1])] = xmlUnescape(m[2]);
    }
    return { argv, env };
  }
  if (platform === 'linux') {
    const env = {};
    let argv = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('Environment=')) {
        const entry = line.slice('Environment='.length);
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = parseQuotedWords(entry.slice(eq + 1))[0] ?? '';
      } else if (line.startsWith('ExecStart=')) {
        argv = parseQuotedWords(line.slice('ExecStart='.length));
      }
    }
    return argv ? { argv, env } : null;
  }
  if (platform === 'win32') {
    const env = {};
    let commandLine = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.toLowerCase() === '@echo off') continue;
      const m = /^set "([^=]+)=(.*)"$/.exec(line);
      if (m) {
        env[m[1]] = m[2].replace(/%%/g, '%');
        continue;
      }
      commandLine = line;
    }
    return commandLine ? { argv: parseQuotedWords(commandLine, { unescapeBackslash: false }), env } : null;
  }
  return null;
}

function parseBool(v) {
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return null;
}

/**
 * Effective proxy config of a service definition, resolved like Portless's
 * `parseServiceInstallConfig` (cli.js:3432-3533): env first, then flags after
 * `proxy start`; LAN forces the `.local` TLD.
 * @param {{ argv: string[], env: Record<string, string> }} def
 * @param {{ home?: string }} [opts]
 * @returns {{ stateDir: string | null, port: number, tls: boolean, lan: boolean, fixedIp: string | null, tlds: string[], wildcard: boolean }}
 */
export function deriveServiceConfig(def, { home } = {}) {
  const { argv, env } = def;
  const c = { stateDir: env.PORTLESS_STATE_DIR || null, port: null, tls: true, lan: false, fixedIp: null, tlds: ['localhost'], wildcard: false };
  const envTls = parseBool(env.PORTLESS_HTTPS);
  if (envTls !== null) c.tls = envTls;
  const envLan = parseBool(env.PORTLESS_LAN);
  if (envLan !== null) c.lan = envLan;
  if (env.PORTLESS_LAN_IP) {
    c.lan = true;
    c.fixedIp = env.PORTLESS_LAN_IP;
  }
  if (env.PORTLESS_TLD) c.tlds = env.PORTLESS_TLD.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const envWildcard = parseBool(env.PORTLESS_WILDCARD);
  if (envWildcard !== null) c.wildcard = envWildcard;
  if (env.PORTLESS_PORT && /^\d+$/.test(env.PORTLESS_PORT)) c.port = Number(env.PORTLESS_PORT);
  const start = argv.findIndex((a, i) => a === 'proxy' && argv[i + 1] === 'start');
  const flags = start === -1 ? [] : argv.slice(start + 2);
  let tldSeen = false;
  for (let i = 0; i < flags.length; i += 1) {
    const f = flags[i];
    const next = flags[i + 1];
    if (f === '-p' || f === '--port') { if (/^\d+$/.test(next ?? '')) c.port = Number(next); i += 1; }
    else if (f === '--https' || f === '--cert' || f === '--key') { c.tls = true; if (f !== '--https') i += 1; }
    else if (f === '--no-tls') c.tls = false;
    else if (f === '--lan') c.lan = true;
    else if (f === '--ip') { c.lan = true; c.fixedIp = next ?? null; i += 1; }
    else if (f === '--tld') { c.tlds = [...(tldSeen ? c.tlds : []), ...String(next ?? '').split(',').map((t) => t.trim()).filter(Boolean)]; tldSeen = true; i += 1; }
    else if (f === '--wildcard') c.wildcard = true;
    else if (f === '--state-dir') { c.stateDir = next ?? null; i += 1; }
    else if (f === '--lan-ip-auto') i += 1;
  }
  if (c.port === null) c.port = c.tls ? 443 : 80;
  if (c.lan) c.tlds = ['local'];
  else c.fixedIp = null;
  if (!c.stateDir) {
    const h = env.HOME || env.USERPROFILE || home || null;
    c.stateDir = h ? path.join(h, '.portless') : null;
  }
  return c;
}

/**
 * Read `proxy.tlds` / `proxy.tld` like `readTldsFromDir` (cli.js:2116-2136).
 * @param {string} dir
 * @returns {string[]}
 */
export function readTlds(dir) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const raw = read('proxy.tlds');
  if (raw !== null) {
    let list = null;
    try {
      list = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).flatMap((l) => l.split(','));
    } catch {
      list = null;
    }
    if (Array.isArray(list)) {
      const tlds = [...new Set(list.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean))];
      return tlds.length ? tlds : ['localhost'];
    }
  }
  const legacy = read('proxy.tld');
  return [legacy || 'localhost'];
}

/**
 * Read the proxy's state files (`proxy.port`, `proxy.pid`, `proxy.tls`,
 * `proxy.lan`, `proxy.tlds`) from a state dir. Never throws.
 * @param {string} dir
 */
export function readStateFiles(dir) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const int = (s) => (s !== null && /^\d+$/.test(s) ? Number(s) : null);
  let tls = false;
  try {
    tls = fs.existsSync(path.join(dir, 'proxy.tls'));
  } catch {
    tls = false;
  }
  return {
    port: int(read('proxy.port')),
    pid: int(read('proxy.pid')),
    tls,
    lanIp: read('proxy.lan') || null,
    tlds: readTlds(dir),
  };
}

/**
 * Canonical form of a path for comparison: the nearest existing ancestor is
 * resolved with `realpathSync.native` (true on-disk case, symlinks resolved),
 * the missing tail is appended; lower-cased on case-insensitive platforms.
 */
function canonicalPath(p) {
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      const full = path.join(real, ...tail.reverse());
      return process.platform === 'darwin' || process.platform === 'win32' ? full.toLowerCase() : full;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Same directory? dev+inode when both exist, else canonical paths. */
function samePath(a, b) {
  if (!a || !b) return false;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.ino && sb.ino) return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    /* fall through to path comparison */
  }
  return canonicalPath(a) === canonicalPath(b);
}

/** `dev:ino` of an existing path (symlinks followed), else null. */
function statId(p) {
  try {
    const st = fs.statSync(p);
    return st.ino ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

/** Is `child` equal to or inside `parent` (canonical paths)? */
function isWithin(child, parent) {
  if (!child || !parent) return false;
  if (samePath(child, parent)) return true;
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function classifyOutput(output) {
  const o = output || '';
  if (/already registered by a running process/i.test(o)) return 'NAME_TAKEN_BY_APP';
  if (/EADDRINUSE|address already in use|is in use, but it is not a portless proxy/i.test(o)) return 'PORT_IN_USE';
  if (/requires elevated privileges|permission denied|EACCES|operation not permitted|a terminal is required|sudo failed|sudo elevation also failed/i.test(o)) return 'PERMISSION';
  if (/Invalid hostname|Hostname cannot be empty/i.test(o)) return 'INVALID_NAME';
  if (/No alias found/i.test(o)) return 'NOT_FOUND';
  if (/Proxy is not running|not responding|failed to start/i.test(o)) return 'PROXY_DOWN';
  return 'UNKNOWN';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * `HEAD http://127.0.0.1:<port>/` answered with `X-Portless: 1` — Portless's
 * own liveness check (cli.js:2355-2379). Works for TLS proxies too: the TLS
 * listener sniffs the first byte and answers plain HTTP with a 302 carrying the
 * header (chunk.js:781-806).
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isProxyResponding(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      finish(res.headers['x-portless'] === '1');
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}

/**
 * Plain TCP connect to 127.0.0.1:<port>.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(v);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

// --- startup-service control (E12, D43)

/** Environment for elevated service-manager commands (nothing user-specific needed). */
export const SERVICE_CONTROL_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });

/**
 * Service identifier: the plist's `Label` (macOS, default sh.portless.proxy),
 * the unit file name (Linux, portless.service), the task name (Windows).
 */
export function serviceLabel(text, file, platform) {
  if (platform === 'darwin') {
    const m = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text || '');
    return m ? xmlUnescape(m[1]) : 'sh.portless.proxy'; // not trimmed: it must match what launchd registered
  }
  if (platform === 'linux') return path.basename(file || 'portless.service');
  return 'Portless Proxy'; // cli.js:3346
}

/**
 * Only Portless's own service may be controlled (validation 4 F3): macOS label
 * `sh.portless.proxy` or `sh.portless.<…>`; Linux unit `portless*.service`;
 * Windows task "Portless Proxy". Anything else (a tampered definition naming
 * e.g. com.apple.WindowServer) is never booted out or started.
 * @param {{ platform: string, label: string }} svc
 * @returns {boolean}
 */
export function isTrustedServiceLabel(svc) {
  const label = svc && svc.label;
  if (typeof label !== 'string') return false;
  if (svc.platform === 'darwin') return /^sh\.portless\.[A-Za-z0-9.-]+$/.test(label);
  if (svc.platform === 'linux') return /^portless[A-Za-z0-9@._-]*\.service$/.test(label);
  if (svc.platform === 'win32') return label === 'Portless Proxy';
  return false;
}

/**
 * The service-manager argv for `stop` / `start` (run elevated) or `status`
 * (read-only).
 * @param {'stop' | 'start' | 'status'} action
 * @param {{ platform: string, label: string, path: string }} svc  from getServiceConfig()
 * @returns {string[]}
 */
export function serviceControlArgv(action, svc) {
  if (svc.platform === 'darwin') {
    if (action === 'stop') return ['/bin/launchctl', 'bootout', `system/${svc.label}`];
    if (action === 'start') return ['/bin/launchctl', 'bootstrap', 'system', svc.path];
    return ['/bin/launchctl', 'print', `system/${svc.label}`];
  }
  if (svc.platform === 'linux') {
    if (action === 'stop') return ['systemctl', 'stop', svc.label];
    if (action === 'start') return ['systemctl', 'start', svc.label];
    return ['systemctl', 'is-active', '--quiet', svc.label];
  }
  if (svc.platform === 'win32') {
    if (action === 'stop') return ['schtasks.exe', '/End', '/TN', svc.label];
    if (action === 'start') return ['schtasks.exe', '/Run', '/TN', svc.label];
    return ['schtasks.exe', '/Query', '/TN', svc.label, '/FO', 'LIST'];
  }
  throw new PortlessError('UNSUPPORTED', `Service control isn't supported on ${svc.platform}.`);
}

/**
 * Is the startup service loaded/active? Read-only: macOS `launchctl print
 * system/<label>` exit 0 (113 = not loaded); Linux `systemctl is-active`;
 * Windows `schtasks /Query` showing "Running" (experimental). 2 s timeout;
 * any failure → false.
 * @returns {Promise<boolean>}
 */
export function isServiceLoaded(svc, { execFile: exec = execFile, timeout = 2000 } = {}) {
  if (!isTrustedServiceLabel(svc)) return Promise.resolve(false);
  let argv;
  try {
    argv = serviceControlArgv('status', svc);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    exec(argv[0], argv.slice(1), { timeout, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) return resolve(false);
      if (svc.platform === 'win32') return resolve(/^\s*Status:\s*Running/im.test(String(stdout || '')));
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Locating Portless
// ---------------------------------------------------------------------------

function isExecutableFile(p, platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(cmd, envPath, platform) {
  const names = platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];
  for (const dir of String(envPath || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (isExecutableFile(p, platform)) return p;
    }
  }
  return null;
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resolveInstallFrom(candidate, env, platform) {
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  let packageRoot = null;
  if (platform === 'win32') {
    const shimRoot = path.join(path.dirname(candidate), 'node_modules', 'portless');
    if (fs.existsSync(path.join(shimRoot, 'dist', 'index.js'))) packageRoot = shimRoot;
  }
  if (!packageRoot) {
    let dir = path.dirname(real);
    for (let i = 0; i < 4; i += 1) {
      const pkg = readPackageJson(dir);
      if (pkg && pkg.name === 'portless' && fs.existsSync(path.join(dir, 'dist', 'index.js'))) {
        packageRoot = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!packageRoot) return null;
  const pkg = readPackageJson(packageRoot);
  let nodePath = null;
  if (platform !== 'win32') {
    try {
      const fd = fs.openSync(real, 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      fs.closeSync(fd);
      const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
      const m = /^#!\s*(\S+)(?:\s+(.*))?$/.exec(first);
      if (m) {
        if (path.basename(m[1]) === 'env') {
          const words = (m[2] || '').split(/\s+/).filter((w) => w && !w.startsWith('-'));
          nodePath = words[0] ? which(words[0], env.PATH, platform) : null;
        } else {
          nodePath = m[1];
        }
      }
    } catch {
      nodePath = null;
    }
  }
  if (!nodePath) {
    const sibling = path.join(path.dirname(candidate), platform === 'win32' ? 'node.exe' : 'node');
    nodePath = isExecutableFile(sibling, platform) ? sibling : which('node', env.PATH, platform);
  }
  return { binPath: real, launcherPath: candidate, packageRoot, version: pkg?.version ?? null, nodePath };
}

/**
 * Locate the Portless CLI: `portless` on PATH, then the usual install
 * directories. `launcherPath` is the unresolved path found (e.g.
 * /opt/homebrew/bin/portless) — what `run()` executes (D17); `binPath` is the
 * resolved CLI file (carries its own `#!node` shebang), used to locate
 * `packageRoot` (contains `dist/index.js`); `nodePath` is the shebang's interpreter.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {{ binPath: string, launcherPath: string, packageRoot: string, version: string | null, nodePath: string | null } | null}
 */
export function findPortless({ env = process.env, platform = process.platform } = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'));
  }
  const names = platform === 'win32' ? ['portless.cmd', 'portless.exe', 'portless'] : ['portless'];
  const seen = new Set();
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!isExecutableFile(candidate, platform)) continue;
      const found = resolveInstallFrom(candidate, env, platform);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locked or read-only routes.json (E13, D47): explain, never change, file flags
// ---------------------------------------------------------------------------

/** BSD `UF_IMMUTABLE` (sys/stat.h): `chflags uchg`, Finder's "Locked"; the owner can clear it. */
export const UF_IMMUTABLE = 0x2;
/** BSD `SF_IMMUTABLE` (sys/stat.h): `chflags schg`; only root can clear it. */
export const SF_IMMUTABLE = 0x20000;
/** Upper bound for one flag/owner probe process (E13: ≤ 2 s). */
export const FILE_FLAGS_TIMEOUT_MS = 2000;
/** How long `getRoutesAccess()` reuses its answer (E13: 2 s; dropped after any route write). */
export const ROUTES_ACCESS_TTL_MS = 2000;
/** errno codes that mean "the OS refused this write". */
const WRITE_REFUSED = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * Parse macOS `/usr/bin/stat -L -f '%f %u %Su' <path>`: the decimal `st_flags`,
 * the numeric owner uid, then the owner's name as the rest of the line (a
 * directory-service name may contain spaces). The two numbers come first, so
 * the name can never shift them. `schg` wins over `uchg` (it has to be cleared first).
 * @param {string} text
 * @returns {{ flag: 'uchg' | 'schg' | null, owner: string | null, uid: number } | null}  null = unparsable
 */
export function parseStatFlags(text) {
  const line = oneStatLine(text);
  const m = line === null ? null : /^[ \t]*(\d+)[ \t]+(\d+)(?:[ \t]+([^]*))?$/.exec(line);
  if (!m) return null;
  const flags = Number(m[1]);
  const uid = Number(m[2]);
  if (!Number.isSafeInteger(flags) || !Number.isSafeInteger(uid)) return null;
  // st_flags is a u_int32; read the bits without JS's signed 32-bit `&`.
  const has = (bit) => Math.floor(flags / bit) % 2 === 1;
  const flag = has(SF_IMMUTABLE) ? 'schg' : has(UF_IMMUTABLE) ? 'uchg' : null;
  return { flag, owner: trimBlanksEnd(m[3]) || null, uid };
}

/**
 * The single line of a `stat` answer: one trailing `\n`, `\r\n` or `\r` is
 * dropped; any other line break → null. Linear time: the owner name is then
 * matched by a regex that can't backtrack (validation 6 note 6: the old lazy
 * `[^\r\n]*?[ \t]*` was quadratic on long runs of spaces).
 * @returns {string | null}
 */
function oneStatLine(text) {
  let s = String(text ?? '');
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n') || s.endsWith('\r')) s = s.slice(0, -1);
  return /[\r\n]/.test(s) ? null : s;
}

/** Drop trailing spaces and tabs (a loop, not a regex: linear on any input). */
function trimBlanksEnd(s) {
  if (typeof s !== 'string') return '';
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1;
  return s.slice(0, end);
}

/**
 * Parse Linux `lsattr -d <path>` (experimental, fixture-tested only): the
 * attribute column contains `i` for an immutable file. Linux has no per-user
 * variant — only root (CAP_LINUX_IMMUTABLE) can clear it — so it reads as `schg`.
 * @param {string} text
 * @returns {'schg' | null | undefined}  undefined = unparsable
 */
export function parseLsattr(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim() !== '');
  const m = line && /^\s*([A-Za-z-]+)\s+\S/.exec(line);
  if (!m) return undefined;
  return m[1].includes('i') ? 'schg' : null;
}

function execText(exec, file, args, timeout) {
  return new Promise((resolve) => {
    try {
      exec(file, args, { timeout, env: SERVICE_CONTROL_ENV, windowsHide: true, shell: false, maxBuffer: 64 * 1024 }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? ''));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read-only probe of a path's immutable flag and owner (E13). Symlinks are
 * followed (D51): a write goes through the link, so the target's flags are the
 * ones that block.
 * macOS: `/usr/bin/stat -L -f '%f %u %Su' -- <path>` (flags, uid, owner in one call).
 * Linux (experimental): `/usr/bin/lsattr -d -- <realpath>` and
 * `/usr/bin/stat -L -c '%u %U' -- <path>`.
 * Elsewhere: no flags. Every process has a `FILE_FLAGS_TIMEOUT_MS` timeout,
 * no shell and a fixed PATH. Never rejects.
 * @param {string} p  absolute path
 * @param {{ platform?: NodeJS.Platform, execFile?: typeof execFile, timeout?: number }} [opts]
 * @returns {Promise<{ flag: 'uchg' | 'schg' | null, owner: string | null, uid: number | null } | null>}  null = couldn't tell
 */
export async function readFileFlags(p, { platform = process.platform, execFile: exec = execFile, timeout = FILE_FLAGS_TIMEOUT_MS } = {}) {
  const t = Math.min(Math.max(1, Number(timeout) || FILE_FLAGS_TIMEOUT_MS), FILE_FLAGS_TIMEOUT_MS);
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  if (platform === 'darwin') {
    const out = await execText(exec, '/usr/bin/stat', ['-L', '-f', '%f %u %Su', '--', p], t);
    return out === null ? null : parseStatFlags(out);
  }
  if (platform === 'linux') {
    // lsattr reads a symlink itself (it has no follow option): give it the target.
    let real = p;
    try {
      real = await fs.promises.realpath(p);
    } catch {
      /* dangling or unreadable: probe the path as given */
    }
    const [attrs, owned] = await Promise.all([
      execText(exec, '/usr/bin/lsattr', ['-d', '--', real], t),
      execText(exec, '/usr/bin/stat', ['-L', '-c', '%u %U', '--', p], t),
    ]);
    const flag = attrs === null ? undefined : parseLsattr(attrs);
    const line = owned === null ? null : oneStatLine(owned);
    const m = line === null ? null : /^[ \t]*(\d+)(?:[ \t]+([^]*))?$/.exec(line);
    const uid = m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : null;
    const name = (m && trimBlanksEnd(m[2])) || null;
    if (flag === undefined) return name || uid !== null ? { flag: null, owner: name, uid } : null;
    return { flag, owner: name, uid };
  }
  return null;
}

function mapStoreError(err) {
  if (err instanceof PortlessError) return err;
  if (err && (err.name === 'RouteConflictError' || /already registered by a running process/.test(err.message || ''))) {
    return new PortlessError('NAME_TAKEN_BY_APP', undefined, { raw: err.message, cause: err });
  }
  if (err && /Failed to acquire route lock/.test(err.message || '')) {
    return new PortlessError('TIMEOUT', 'Portless’s route list is busy. Try again.', { raw: err.message, cause: err });
  }
  // EACCES/EPERM/EROFS are explained by createPortless's explainWriteRefused()
  // (ROUTES_LOCKED / ROUTES_NOT_WRITABLE), never PERMISSION (E13).
  return new PortlessError('UNKNOWN', undefined, { raw: err && err.message ? err.message : String(err), cause: err });
}

/**
 * Apply route operations in memory exactly as RouteStore would: `add` =
 * filter out the hostname then push `{hostname, port, pid: 0}` at the end
 * (chunk.js:1065-1092); `remove` = drop the alias (pid 0) with that hostname,
 * keeping app routes (chunk.js:1196-1209).
 * @param {Array<object>} routes
 * @param {Array<{ op: 'add', hostname: string, port: number } | { op: 'remove', hostname: string }>} ops
 */
export function applyRouteOps(routes, ops) {
  let next = routes.slice();
  for (const o of ops) {
    if (o.op === 'add') {
      next = next.filter((r) => r.hostname !== o.hostname);
      next.push({ hostname: o.hostname, port: o.port, pid: 0 });
    } else if (o.op === 'remove') {
      next = next.filter((r) => r.hostname !== o.hostname || r.pid !== 0);
    } else {
      throw new TypeError(`unknown route op ${o.op}`);
    }
  }
  return next;
}

/** Async lock wait: total budget (Contracts §2: up to 10 s). */
export const ROUTE_LOCK_TIMEOUT_MS = 10000;
/** A lock older than this is stale and removed — same rule as RouteStore (chunk.js:917). */
export const ROUTE_LOCK_STALE_MS = 10000;
/** At most this many paths of a stale routes.lock are probed by getRoutesAccess() (validation 6 F2). */
const STALE_LOCK_SCAN_MAX = 64;

/**
 * `routes.lock` has entries (validation 7 F1). Portless (chunk.js:978) and
 * Nidum only ever create it with `mkdir`, so a lock with entries is never held
 * by a writer. It is stale whatever its mtime, which a refused write's partial
 * `rm` refreshes. A lock that can't be listed counts as having entries when
 * `nlink > 2` (APFS counts entries in a folder's nlink). Never throws.
 * @param {string} lockPath
 * @param {fs.Stats} entry  its lstat
 */
async function lockHasEntries(lockPath, entry) {
  let dir = null;
  try {
    dir = await fs.promises.opendir(lockPath);
    return (await dir.read()) !== null;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    return entry.nlink > 2;
  } finally {
    if (dir) await dir.close().catch(() => {});
  }
}

/**
 * The one staleness rule for `routes.lock`, shared by the write and by
 * `getRoutesAccess()`: not a real directory (a symlink, a stray file), older
 * than ROUTE_LOCK_STALE_MS, or holding entries (validation 7 F1).
 * @param {string} lockPath
 * @param {fs.Stats} entry  its lstat
 */
async function isStaleLock(lockPath, entry) {
  if (!entry.isDirectory()) return true;
  if (Date.now() - entry.mtimeMs > ROUTE_LOCK_STALE_MS) return true;
  return lockHasEntries(lockPath, entry);
}

/**
 * Read `routes.json` for a write, under the lock (validation 7 F5). Only a
 * missing file (ENOENT) is an empty list:
 * - EACCES/EPERM/EROFS are rethrown as they are, so the caller explains them
 *   (ROUTES_NOT_WRITABLE on routes.json, or ROUTES_LOCKED).
 * - Any other read error, or content that stays unparsable after the same
 *   retries as listRoutes, is STATE_UNREADABLE.
 * - A file that stays empty or blank is `[]`: there's nothing in it to lose
 *   (RouteStore reads it the same way).
 * The write never replaces a list it couldn't read.
 * @param {string} file
 * @returns {Promise<Array<{hostname: string, port: number, pid: number}>>}  alive-filtered
 */
export async function readRoutesForWrite(file) {
  let lastProblem = null;
  for (let attempt = 0; attempt <= ROUTES_READ_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(ROUTES_READ_RETRY_MS);
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      if (err && WRITE_REFUSED.has(err.code)) throw err;
      throw new PortlessError('STATE_UNREADABLE', undefined, { raw: err && err.message ? err.message : String(err), cause: err, details: { path: file, attempts: attempt + 1 } });
    }
    if (text.trim() === '') {
      lastProblem = null;
      continue;
    }
    const routes = parseRoutesStrict(text);
    if (routes) return routes;
    lastProblem = 'routes.json is not a JSON array';
  }
  if (lastProblem === null) return [];
  throw new PortlessError('STATE_UNREADABLE', undefined, { raw: lastProblem, details: { path: file, attempts: ROUTES_READ_RETRIES + 1 } });
}

/**
 * The default route writer (Contracts §2, D16): Portless's file protocol,
 * fully async so the server's event loop never blocks.
 * `mkdir routes.lock` (async retry with backoff 10→100 ms, up to 10 s; a lock
 * older than 10 s, or a routes.lock that is not a real directory, e.g. a
 * dangling symlink, is stale and removed) → read → plan and check under the lock
 * → one in-place write (same inode: the proxy fs.watch()es the file) → `rm` the lock.
 */
export class FileRouteStore {
  /** @param {string} dir state directory */
  constructor(dir) {
    this.kind = 'file';
    this.dir = dir;
    this.routesPath = path.join(dir, 'routes.json');
    this.lockPath = path.join(dir, 'routes.lock');
  }

  /** @returns {Promise<Array<{hostname: string, port: number, pid: number}>>} alive-filtered */
  async load() {
    // Only a missing file is empty (validation 7 F5): an unreadable or corrupt
    // list throws, so the write never replaces routes it couldn't read.
    return readRoutesForWrite(this.routesPath);
  }

  /**
   * In-place write (open with truncate keeps the inode), mode 0644 like
   * RouteStore.saveRoutes. Synchronous on purpose: it keeps the window in which
   * a lock-free reader sees a truncated file as short as RouteStore's (only the
   * lock wait has to be async, D16).
   */
  async save(routes) {
    fs.writeFileSync(this.routesPath, JSON.stringify(routes, null, 2), { mode: 0o644 });
    try {
      await fs.promises.chmod(this.routesPath, 0o644);
    } catch {
      /* not ours to fix */
    }
  }

  async withLock(fn) {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o755 });
    const deadline = Date.now() + ROUTE_LOCK_TIMEOUT_MS;
    let delay = 10;
    let breaks = 0;
    for (;;) {
      try {
        await fs.promises.mkdir(this.lockPath);
        break;
      } catch (err) {
        // EPERM/EACCES/EROFS here (a locked or read-only folder) go to the caller,
        // which explains them (E13).
        if (err.code !== 'EEXIST') throw err;
        // lstat, never stat: a dangling or self-looping symlink must not read as
        // "vanished" and retried at once (that busy-spun for 10 s).
        let entry = null;
        try {
          entry = await fs.promises.lstat(this.lockPath);
        } catch {
          /* the lock vanished meanwhile: back off and try again (within the deadline) */
        }
        // Portless only ever creates routes.lock with mkdir, so anything that is
        // not a real directory (a symlink, dangling or not; a stray file) is
        // never a held lock: it is stale at once. A stale lock is removed; in a
        // locked or read-only folder that `rm` throws and the caller explains it
        // (ROUTES_LOCKED / ROUTES_NOT_WRITABLE) instead of retrying.
        // isStaleLock: also a lock with entries (validation 7 F1), which no writer ever holds.
        const stale = entry !== null && (await isStaleLock(this.lockPath, entry));
        if (stale) {
          await fs.promises.rm(this.lockPath, { recursive: true, force: true });
          breaks += 1;
          // Normally the next mkdir wins. If something keeps re-creating it,
          // fall through to the same backoff and deadline as a held lock.
          if (breaks <= 3) continue;
        }
        if (Date.now() >= deadline) throw new Error('Failed to acquire route lock');
        await sleep(delay + Math.floor(Math.random() * delay));
        delay = Math.min(delay * 2, 100);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.promises.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  /**
   * Run `plan(routes)` under the lock. `plan` checks preconditions (throwing
   * leaves the file untouched) and returns `{ ops, result }`; all ops are
   * written in one go, so a multi-step change (rename) is atomic.
   */
  async transact(plan) {
    return this.withLock(async () => {
      const routes = await this.load();
      const { ops, result } = plan(routes);
      if (ops.length) await this.save(applyRouteOps(routes, ops));
      return result;
    });
  }
}

/**
 * Test-only cross-check backend: Portless's own (blocking) RouteStore.
 * `prims` = `{ add(hostname, port), remove(hostname) }` over RouteStore with
 * pid 0 / force false / ownerPid 0, so nothing is ever killed or an app's route
 * removed. Ops are applied one by one and rolled back on failure.
 */
function routeStoreBackend(rs, prims) {
  return {
    kind: 'routestore',
    load: async () => rs.loadRoutes(),
    transact: async (plan) => {
      // RouteStore reads an unreadable or corrupt list as [] and would replace
      // it: refuse first, as the file protocol does (validation 7 F5).
      await readRoutesForWrite(rs.routesPath);
      const { ops, result } = plan(rs.loadRoutes());
      const done = [];
      try {
        for (const o of ops) {
          const prev = rs.loadRoutes().find((r) => r.hostname === o.hostname && r.pid === 0);
          if (o.op === 'add') await prims.add(o.hostname, o.port);
          else await prims.remove(o.hostname);
          done.push({ o, prev });
        }
      } catch (err) {
        for (const { o, prev } of done.reverse()) {
          try {
            if (prev) await prims.add(prev.hostname, prev.port);
            else await prims.remove(o.hostname);
          } catch {
            /* best effort: the original error is what matters */
          }
        }
        throw err;
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProxyState
 * @property {boolean} running   HEAD 127.0.0.1:port answers with X-Portless: 1
 * @property {number | null} pid  from proxy.pid, when that process exists
 * @property {number} port
 * @property {boolean} tls
 * @property {boolean} lan
 * @property {string | null} lanIp  proxy.lan (the LAN IP, not a flag)
 * @property {string[]} tlds
 * @property {boolean | null} wildcard  service definition → saved settings → null
 * @property {boolean} elevated  proxy.pid alive but owned by another user (EPERM)
 * @property {'service' | 'manual' | null} managedBy
 * @property {string} baseUrl  http(s)://127.0.0.1:<port>
 * @property {boolean} serviceLoaded  the startup service is loaded/active in the OS service manager (false without an own service)
 */

/**
 * @typedef {object} Route
 * @property {string} name  hostname without `.local`; the full hostname when foreignTld
 * @property {string} hostname
 * @property {string} url
 * @property {number} port
 * @property {'alias' | 'app'} kind
 * @property {number} pid
 * @property {boolean} foreignTld
 */

/**
 * @typedef {object} RoutesAccess  (E13) can Nidum Local change routes.json?
 * @property {boolean} locked  an immutable flag is set on routes.json, its folder, or a stale routes.lock that a write would have to remove
 * @property {'uchg' | 'schg' | null} flag  uchg = Finder's "Locked" (owner can clear); schg = needs sudo
 * @property {'file' | 'folder' | null} target  the kind of the blocking path, locked or not (D53); null only when nothing blocks
 * @property {boolean} writable  (D51) route writes can succeed: false whenever something blocks (a flag; no W+X on the state folder, or its nearest existing parent when it doesn't exist yet; no R+W on routes.json when it exists, since an unreadable list is never replaced; a stale routes.lock that can't be removed)
 * @property {string} path  the path that blocks, in write order (folder, stale routes.lock, routes.json), any flag before any permission problem; routes.json when nothing blocks
 * @property {string | null} owner  account name owning the blocking path, locked or not (D51); null when unknown or nothing blocks
 * @property {boolean | null} ownedByYou  (D51) that owner is the account running Nidum Local (process.getuid()); null when unknown or nothing blocks
 */

/**
 * Create an adapter instance.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]  base env for every call (tests: portlessTestEnv().env)
 * @param {(argv: string[], env: Record<string,string>, opts: {timeout: number}) => Promise<{stdout: string, stderr: string}>} [options.elevate]
 * @param {boolean} [options.safeMode]  refuse clean/prune/trust/hostsSync/serviceInstall/serviceUninstall, LAN, privileged ports, elevation, and mutations outside an isolated PORTLESS_STATE_DIR
 * @param {NodeJS.Platform} [options.platform]
 * @param {ReturnType<typeof findPortless>} [options.portless]  pre-resolved install; `null` = not installed (tests)
 * @param {string | null} [options.servicePath]  service definition path override (tests); null = none
 * @param {'file' | 'routestore'} [options.routeBackend]  'file' (default, async file protocol); 'routestore' = Portless's blocking RouteStore, tests only (D16)
 * @param {{ isProxyResponding?: (port: number) => Promise<boolean>, isPortListening?: (port: number) => Promise<boolean>, isServiceLoaded?: (svc: object) => Promise<boolean>, readFileFlags?: (path: string) => Promise<{ flag: 'uchg' | 'schg' | null, owner: string | null, uid?: number | null } | null> }} [options.probe]  (tests)
 * @param {typeof execFile} [options.execFile]  process spawner for the read-only service-status and file-flag probes (tests)
 * @param {{ username: string, uid: number, gid: number, homedir: string }} [options.user]  (tests)
 * @param {(store: object) => object} [options.wrapStore]  (tests: fault injection; receives the FileRouteStore, or the RouteStore add/remove primitives)
 */
export function createPortless(options = {}) {
  const {
    env: baseEnv = process.env,
    elevate: elevateFn = defaultElevate,
    safeMode = false,
    platform = process.platform,
    routeBackend = 'file',
    probe = {},
    wrapStore = (s) => s,
  } = options;
  const responding = probe.isProxyResponding || isProxyResponding;
  const listening = probe.isPortListening || isPortListening;
  const rawServiceLoaded = probe.isServiceLoaded || ((svc) => isServiceLoaded(svc, { execFile: options.execFile }));
  const serviceWaitMs = options.serviceWaitMs ?? 10000;
  // validation 4 F4: the status probe is a process spawn; cache it ~2 s per
  // service, and drop the cache whenever stopService/startService act.
  const SERVICE_LOADED_TTL_MS = 2000;
  let loadedCache = null;
  async function serviceLoadedProbe(svc) {
    const key = `${svc.platform}:${svc.label}`;
    if (loadedCache && loadedCache.key === key && Date.now() - loadedCache.at < SERVICE_LOADED_TTL_MS) return loadedCache.value;
    const value = Boolean(await rawServiceLoaded(svc));
    loadedCache = { key, value, at: Date.now() };
    return value;
  }
  let install = options.portless;
  let storePromise = null;

  function userInfo() {
    if (options.user) return options.user;
    const u = os.userInfo();
    return { username: u.username, uid: u.uid, gid: u.gid, homedir: u.homedir };
  }

  function home() {
    return (platform === 'win32' ? baseEnv.USERPROFILE : baseEnv.HOME) || userInfo().homedir || os.homedir();
  }

  /** Portless state directory in use: PORTLESS_STATE_DIR, else ~/.portless. */
  function stateDir() {
    return baseEnv.PORTLESS_STATE_DIR || path.join(home(), '.portless');
  }

  function resolveInstall() {
    if (options.portless !== undefined) return options.portless;
    if (install && fs.existsSync(install.launcherPath || install.binPath)) return install;
    install = findPortless({ env: baseEnv, platform });
    return install;
  }

  function servicePath() {
    if (options.servicePath !== undefined) return options.servicePath;
    if (platform === 'win32') return path.join(baseEnv.ProgramData || 'C:\\ProgramData', 'portless', 'service', 'portless-service.cmd');
    return SERVICE_PATHS[platform] || null;
  }

  /**
   * Parsed startup-service definition (launchd plist / systemd unit / Windows
   * task script), or null when none is installed. Reads the file only.
   * @returns {{ path: string, platform: string, argv: string[], env: Record<string,string>, stateDir: string | null, port: number, tls: boolean, lan: boolean, fixedIp: string | null, tlds: string[], wildcard: boolean } | null}
   */
  function getServiceConfig() {
    const p = servicePath();
    if (!p) return null;
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    const def = parseServiceDefinition(text, platform);
    if (!def) return null;
    return { path: p, platform, label: serviceLabel(text, p, platform), argv: def.argv, env: def.env, ...deriveServiceConfig(def, { home: home() }) };
  }

  function ownService() {
    const svc = getServiceConfig();
    return svc && samePath(svc.stateDir, stateDir()) ? svc : null;
  }

  function envPort() {
    const v = baseEnv.PORTLESS_PORT;
    return v && /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? Number(v) : null;
  }

  /**
   * The one fallback for port/TLS when no proxy state file and no own service
   * says otherwise (shared by getProxyState and route URLs): Nidum's saved
   * settings → PORTLESS_HTTPS / PORTLESS_PORT → Portless's default (HTTPS on 443).
   */
  function fallbackProxy(settings) {
    const envTls = parseBool(baseEnv.PORTLESS_HTTPS);
    const tls = typeof settings?.tls === 'boolean' ? settings.tls : envTls ?? true;
    const port = Number.isInteger(settings?.port) ? settings.port : envPort() ?? (tls ? 443 : 80);
    return { port, tls };
  }

  // Port/TLS of the proxy for this state dir, without probing the network.
  function urlContext(settings) {
    const files = readStateFiles(stateDir());
    if (files.port !== null) return { port: files.port, tls: files.tls };
    const svc = ownService();
    if (svc) return { port: svc.port, tls: svc.tls };
    return fallbackProxy(settings);
  }

  /** Every state dir a safe-mode instance must stay out of (real homes, never only the injected one). */
  function protectedStateDirs(env) {
    const homes = new Set([options.user?.homedir, os.userInfo().homedir, os.homedir(), env.HOME, env.USERPROFILE, baseEnv.HOME, baseEnv.USERPROFILE].filter(Boolean));
    const dirs = [...homes].map((h) => path.join(h, '.portless'));
    if (platform !== 'win32') dirs.push('/tmp/portless'); // Portless's legacy system state dir (cli.js:1770)
    const svc = getServiceConfig();
    if (svc?.stateDir) dirs.push(svc.stateDir);
    return dirs;
  }

  /**
   * Safe mode: the effective PORTLESS_STATE_DIR must be set and must be neither
   * a real state dir (or inside one) nor contain one. Compared by dev+inode /
   * native realpath, so case variants and symlinks don't slip through.
   */
  function assertIsolated(what, env = baseEnv) {
    if (!safeMode) return;
    const dir = env.PORTLESS_STATE_DIR;
    const refuse = (why) => new PortlessError('UNSUPPORTED', `${what} is disabled in safe mode: ${why}`);
    if (!dir) throw refuse('no isolated PORTLESS_STATE_DIR.');
    if (!path.isAbsolute(dir)) throw refuse(`${dir} is not an absolute path.`);
    if (String(dir).split(/[\\/]+/).includes('..')) throw refuse(`${dir} contains "..".`);
    const protectedDirs = protectedStateDirs(env);
    const ids = protectedDirs.map(statId).filter(Boolean);
    // Walk the raw path upwards: an existing ancestor that *is* a protected dir
    // (same dev+inode, whatever its spelling: firmlink, symlink, case) means
    // the state dir would live inside it, even if it doesn't exist yet.
    for (let cur = dir; ; cur = path.dirname(cur)) {
      const id = statId(cur);
      if (id && ids.includes(id)) throw refuse(`${dir} is inside a real Portless state dir.`);
      if (path.dirname(cur) === cur) break;
    }
    // The other direction: an existing candidate that *is* an ancestor of a
    // protected dir (e.g. $HOME spelled through the /System/Volumes/Data firmlink).
    const dirId = statId(dir);
    if (dirId) {
      for (const real of protectedDirs) {
        for (let cur = real; ; cur = path.dirname(cur)) {
          if (statId(cur) === dirId) throw refuse(`${dir} contains a real Portless state dir.`);
          if (path.dirname(cur) === cur) break;
        }
      }
    }
    for (const real of protectedDirs) {
      if (isWithin(dir, real) || isWithin(real, dir)) throw refuse(`${dir} is not an isolated state dir.`);
    }
  }

  /**
   * Safe-mode environment: LAN, hosts sync and tunnels forced off whatever the
   * caller passed; HTTPS forced off for proxy commands.
   */
  function applySafeEnv(env, args) {
    env.PORTLESS_LAN = '0';
    env.PORTLESS_SYNC_HOSTS = '0';
    for (const k of ['PORTLESS_LAN_IP', 'PORTLESS_INTERNAL_LAN_IP', 'PORTLESS_TAILSCALE', 'PORTLESS_FUNNEL', 'PORTLESS_NGROK']) delete env[k];
    if (args[0] === 'proxy') env.PORTLESS_HTTPS = '0';
  }

  // Runs the unresolved launcher (D17): it is what Portless records as its
  // entry script in a service definition, and it survives `brew upgrade`.
  function commandFor(inst, args) {
    if (platform === 'win32') return [inst.nodePath || 'node', path.join(inst.packageRoot, 'dist', 'cli.js'), ...args];
    return [inst.launcherPath || inst.binPath, ...args];
  }

  /**
   * The environment an elevated Portless command gets (F6): every PORTLESS_*
   * of the base env, NO_COLOR, the user's HOME/SUDO_USER/SUDO_UID/SUDO_GID (so
   * root resolves the user's home and chowns files back, chunk.js:17-29,
   * 44-57), the user's PORTLESS_STATE_DIR, and PATH with the Portless node's dir first.
   * @returns {Record<string, string>}
   */
  function elevationEnv(env, inst) {
    const u = userInfo();
    const out = {};
    for (const k of Object.keys(env).sort()) {
      if (k.startsWith('PORTLESS_') && env[k]) out[k] = String(env[k]);
    }
    out.NO_COLOR = '1';
    if (platform === 'win32') {
      out.USERPROFILE = home();
    } else {
      out.HOME = home();
      out.SUDO_USER = u.username;
      out.SUDO_UID = String(u.uid);
      out.SUDO_GID = String(u.gid);
    }
    out.PORTLESS_STATE_DIR = stateDir();
    const sep = platform === 'win32' ? ';' : ':';
    const basePath = env.PATH || (platform === 'win32' ? '' : '/usr/bin:/bin:/usr/sbin:/sbin');
    const parts = [inst.nodePath ? path.dirname(inst.nodePath) : null, ...basePath.split(sep)].filter(Boolean);
    out.PATH = [...new Set(parts)].join(sep);
    return out;
  }

  /**
   * Run `portless <args>`: execFile on the launcher (no `node` prefix, no
   * shell), ANSI stripped, exit ≠ 0 mapped to PortlessError. The effective env
   * is the instance env with the per-call `env` merged over it; in safe mode
   * every check runs on that effective env (allowlisted argv, isolated state
   * dir for proxy commands, LAN/HTTPS/hosts sync forced off, no elevation).
   * @param {string[]} args
   * @param {{ env?: NodeJS.ProcessEnv, timeout?: number, elevate?: boolean, prompt?: string, okExitCodes?: number[] }} [opts]  `prompt` = the password dialog's text when elevated
   * @returns {Promise<{ stdout: string, stderr: string, output: string, exitCode: number }>}
   */
  async function run(args, { env, timeout = DEFAULT_TIMEOUT_MS, elevate = false, prompt = ELEVATION_PROMPTS.other, okExitCodes = [0] } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('args must be an array of strings');
    const callEnv = { ...baseEnv, ...(env || {}) };
    delete callEnv.FORCE_COLOR;
    callEnv.NO_COLOR = '1';
    if (safeMode) {
      if (elevate) throw new PortlessError('UNSUPPORTED', 'Administrator rights are disabled in safe mode.');
      const problem = safeArgsProblem(args);
      if (problem) throw new PortlessError('UNSUPPORTED', problem, { details: { args } });
      applySafeEnv(callEnv, args);
      if (args[0] === 'proxy') assertIsolated('Starting or stopping a proxy', callEnv);
      if (args[0] === 'proxy' && args[1] === 'stop') {
        // Portless answers EPERM on proxy.pid with its own `sudo` (cli.js:4855-4868, 4463-4471).
        // Parse exactly like Portless does (`parseInt(text, 10)`, cli.js:4852), so `1abc` counts as 1.
        let pid = NaN;
        try {
          pid = parseInt(fs.readFileSync(path.join(callEnv.PORTLESS_STATE_DIR, 'proxy.pid'), 'utf8'), 10);
        } catch {
          pid = NaN;
        }
        if (Number.isInteger(pid) && pidStatus(pid) === 'eperm') {
          throw new PortlessError('UNSUPPORTED', `Safe mode won't stop pid ${pid}: it belongs to another user (Portless would ask sudo).`);
        }
      }
    }
    const inst = resolveInstall();
    if (!inst) throw new PortlessError('CLI_MISSING');
    const argv = commandFor(inst, args);

    if (elevate) return runElevated(argv, elevationEnv(callEnv, inst), { timeout, prompt });

    return new Promise((resolve, reject) => {
      execFile(argv[0], argv.slice(1), { env: callEnv, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false }, (error, so, se) => {
        const stdout = stripAnsi(so);
        const stderr = stripAnsi(se);
        const output = (stdout + stderr).trim();
        if (!error) return resolve({ stdout, stderr, output, exitCode: 0 });
        if (error.killed || error.code === 'ETIMEDOUT') {
          return reject(new PortlessError('TIMEOUT', undefined, { raw: output, details: { args, timeout } }));
        }
        if (error.code === 'ENOENT') return reject(new PortlessError('CLI_MISSING', undefined, { raw: error.message }));
        const exitCode = typeof error.code === 'number' ? error.code : null;
        if (exitCode !== null && okExitCodes.includes(exitCode)) return resolve({ stdout, stderr, output, exitCode });
        reject(new PortlessError(classifyOutput(output), undefined, { raw: output, details: { args, exitCode } }));
      });
    });
  }

  /** Run a whole argv through `elevate()`, mapping failures to PortlessError. */
  async function runElevated(argv, env, { timeout, prompt }) {
    let res;
    try {
      res = await elevateFn(argv, env, { timeout, prompt });
    } catch (err) {
      if (err instanceof PortlessError && err.code !== 'UNKNOWN') throw err;
      const raw = stripAnsi(err && err.raw !== undefined ? err.raw : err && err.message);
      throw new PortlessError(classifyOutput(raw), undefined, { raw, details: err?.details, cause: err });
    }
    const stdout = stripAnsi(res?.stdout);
    const stderr = stripAnsi(res?.stderr);
    return { stdout, stderr, output: (stdout + stderr).trim(), exitCode: 0 };
  }

  /**
   * Live proxy state (Contracts §2 / F12). Reads the state files and the
   * service definition; one HEAD probe; never lsof, never the CLI.
   * @param {{ settings?: { port?: number, tls?: boolean, wildcard?: boolean } }} [opts]  Nidum's saved settings (fallbacks)
   * @returns {Promise<ProxyState>}
   */
  async function getProxyState({ settings } = {}) {
    const files = readStateFiles(stateDir());
    const svc = ownService();
    const { port, tls } = urlContext(settings);
    const running = await responding(port);
    const status = files.pid !== null ? pidStatus(files.pid) : 'dead';
    const pid = status === 'dead' ? null : files.pid;
    const lan = running ? files.lanIp !== null || Boolean(svc && svc.lan) : svc ? svc.lan : files.lanIp !== null;
    const tlds = running || !svc ? files.tlds : svc.tlds;
    const wildcard = svc ? svc.wildcard : typeof settings?.wildcard === 'boolean' ? settings.wildcard : null;
    return {
      running,
      pid,
      port,
      tls,
      lan,
      lanIp: files.lanIp,
      tlds,
      wildcard,
      elevated: status === 'eperm',
      managedBy: svc ? 'service' : running ? 'manual' : null,
      baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
      serviceLoaded: svc ? await serviceLoadedProbe(svc) : false,
    };
  }

  function serviceControlTarget(action) {
    if (safeMode) throw new PortlessError('UNSUPPORTED', 'disabled in safe mode', { details: { command: action } });
    const svc = ownService();
    if (!svc) throw new PortlessError('UNSUPPORTED', 'No startup service manages sharing here.', { details: { command: action } });
    if (!isTrustedServiceLabel(svc)) {
      throw new PortlessError('UNSUPPORTED', 'The startup service isn’t Portless’s own, so Nidum Local won’t control it.', { details: { command: action, label: svc.label, path: svc.path } });
    }
    loadedCache = null;
    return svc;
  }

  /**
   * Stop the startup service that owns this proxy (E12, D43), elevated:
   * macOS `launchctl bootout system/<label>` (the plist stays, so it returns at
   * next boot); Linux `systemctl stop <unit>`; Windows `schtasks /End`
   * (experimental). Skips the command when the service isn't loaded, but
   * always verifies the goal: a proxy still answering → UNKNOWN "Sharing is
   * still on." (after up to 10 s when it acted). Refused (UNSUPPORTED) in safe
   * mode, without an own service, or for a label that isn't Portless's.
   * @returns {Promise<ProxyState>}
   */
  function stopService({ timeout = ELEVATED_TIMEOUT_MS } = {}) {
    return serial('proxy', async () => {
      const svc = serviceControlTarget('stopService');
      const state = await getProxyState();
      if (state.serviceLoaded) {
        try {
          await runElevated(serviceControlArgv('stop', svc), SERVICE_CONTROL_ENV, { timeout, prompt: ELEVATION_PROMPTS.stop });
        } finally {
          loadedCache = null;
        }
      }
      // Verify the goal, also on the no-op path (validation 4 F2): a proxy still
      // answering for this state dir means sharing is not off.
      if (!(await waitFor(async () => !(await responding(state.port)), state.serviceLoaded ? serviceWaitMs : 0))) {
        throw new PortlessError('UNKNOWN', 'Sharing is still on.', { details: { port: state.port, serviceLoaded: state.serviceLoaded } });
      }
      return getProxyState();
    });
  }

  /**
   * Start (resume) the startup service (E12, D43), elevated: macOS
   * `launchctl bootstrap system <plist>`; Linux `systemctl start <unit>`;
   * Windows `schtasks /Run` (experimental). Skips the command when it's
   * already loaded, but always waits up to 10 s for the proxy to answer, else
   * PROXY_DOWN. Refused like stopService.
   * @returns {Promise<ProxyState>}
   */
  function startService({ timeout = ELEVATED_TIMEOUT_MS } = {}) {
    return serial('proxy', async () => {
      const svc = serviceControlTarget('startService');
      const state = await getProxyState();
      if (!state.serviceLoaded) {
        try {
          await runElevated(serviceControlArgv('start', svc), SERVICE_CONTROL_ENV, { timeout, prompt: ELEVATION_PROMPTS.serviceStart });
        } finally {
          loadedCache = null;
        }
      }
      // Verify the goal, also when it was already loaded (validation 4 F2: a
      // crash-looping service is loaded but doesn't answer).
      if (!(await waitFor(() => responding(state.port), serviceWaitMs))) {
        throw new PortlessError('PROXY_DOWN', 'Sharing did not start.', { details: { port: state.port, serviceLoaded: state.serviceLoaded } });
      }
      return getProxyState();
    });
  }

  /**
   * Routes from `routes.json`, alive-filtered like RouteStore.loadRoutes,
   * sorted by hostname. A missing file is `[]`; an empty or unparsable file
   * (a write in progress) is re-read up to ROUTES_READ_RETRIES times, 20 ms
   * apart, then STATE_UNREADABLE is thrown — a failed read is never `[]`.
   * @throws {PortlessError} STATE_UNREADABLE
   * @param {{ proxy?: { port: number, tls: boolean } }} [opts]  proxy port/TLS for URLs (default: from state files)
   * @returns {Promise<Route[]>}
   */
  async function listRoutes({ proxy } = {}) {
    const file = path.join(stateDir(), 'routes.json');
    let routes = null;
    let lastProblem = null;
    for (let attempt = 0; attempt <= ROUTES_READ_RETRIES; attempt += 1) {
      if (attempt > 0) await sleep(ROUTES_READ_RETRY_MS);
      let text;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          routes = []; // no file yet = no routes (RouteStore.loadRoutes, chunk.js:1024-1026)
          break;
        }
        lastProblem = err.message;
        continue;
      }
      routes = parseRoutesStrict(text);
      if (routes) break;
      lastProblem = text.trim() === '' ? 'routes.json is empty' : 'routes.json is not a JSON array';
    }
    if (!routes) {
      throw new PortlessError('STATE_UNREADABLE', undefined, { raw: lastProblem ?? undefined, details: { path: file, attempts: ROUTES_READ_RETRIES + 1 } });
    }
    const ctx = proxy && Number.isInteger(proxy.port) ? { port: proxy.port, tls: Boolean(proxy.tls) } : urlContext();
    return routes
      .map((r) => toRoute(r, ctx))
      .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
  }

  async function loadStore() {
    const dir = stateDir();
    if (routeBackend === 'routestore') {
      // Test-only cross-check: Portless's own blocking RouteStore (D16).
      const inst = resolveInstall();
      if (!inst || inst.version !== PINNED_VERSION) throw new PortlessError('UNSUPPORTED', `RouteStore cross-check needs Portless ${PINNED_VERSION}.`);
      const mod = await import(pathToFileURL(path.join(inst.packageRoot, 'dist', 'index.js')).href);
      const rs = new mod.RouteStore(dir);
      const prims = wrapStore({
        add: async (hostname, port) => rs.addRoute(hostname, port, 0, false),
        remove: async (hostname) => rs.removeRoute(hostname, 0),
      });
      return routeStoreBackend(rs, prims);
    }
    return wrapStore(new FileRouteStore(dir));
  }

  function getStore() {
    if (!storePromise) storePromise = loadStore();
    return storePromise;
  }

  /** Which route backend this instance uses: 'file' (default) or 'routestore' (tests). */
  async function routeBackendKind() {
    return (await getStore()).kind;
  }

  // Mutations are serialised per instance (Contracts §2): one queue for routes,
  // one for the proxy (a password dialog must not hold up alias edits).
  let routeChain = Promise.resolve();
  let proxyChain = Promise.resolve();
  function serial(which, fn) {
    const prev = which === 'routes' ? routeChain : proxyChain;
    const next = prev.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    if (which === 'routes') routeChain = settled;
    else proxyChain = settled;
    return next;
  }

  async function transact(plan) {
    const store = await getStore();
    try {
      return await store.transact(plan);
    } catch (err) {
      if (err && !(err instanceof PortlessError) && WRITE_REFUSED.has(err.code)) throw await explainWriteRefused(err);
      throw mapStoreError(err);
    } finally {
      invalidateRoutesAccess(); // E13: any route write (done or refused) drops the cached answer
    }
  }

  // -------------------------------------------------------------------------
  // E13: locked or read-only routes.json
  // -------------------------------------------------------------------------

  const flagProbe = probe.readFileFlags || ((p) => readFileFlags(p, { platform, execFile: options.execFile }));

  /** Flag, owner name and uid of `p` (through symlinks); null when it can't be told (never throws). */
  async function flagsOf(p) {
    try {
      const r = await flagProbe(p);
      if (!r || typeof r !== 'object') return null;
      const flag = r.flag === 'uchg' || r.flag === 'schg' ? r.flag : null;
      const owner = typeof r.owner === 'string' && r.owner ? r.owner : null;
      const uid = Number.isSafeInteger(r.uid) && r.uid >= 0 ? r.uid : null;
      return { flag, owner, uid };
    } catch {
      return null;
    }
  }

  /** `fs.stat` (follows symlinks, like a write does); null when missing or unreadable. */
  async function statOf(p) {
    try {
      return await fs.promises.stat(p);
    } catch {
      return null;
    }
  }

  /**
   * Does `p` refuse `mode` to this account? A path that vanished meanwhile
   * (ENOENT/ENOTDIR: a writer broke a stale lock) blocks nothing (validation 7 F2).
   */
  async function denies(p, mode) {
    try {
      await fs.promises.access(p, mode);
      return false;
    } catch (err) {
      const code = err && err.code;
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    }
  }

  /** The folder Portless would have to write in: the state dir, or its nearest existing ancestor when it doesn't exist yet. */
  async function nearestExistingDir(dir) {
    let d = dir;
    for (let i = 0; i < 64; i += 1) {
      if (await statOf(d)) return d;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return dir;
  }

  /** The account running Nidum Local: `process.getuid()` (the test `user` option overrides); null on Windows. */
  function myUid() {
    if (options.user) return Number.isSafeInteger(options.user.uid) ? options.user.uid : null;
    return typeof process.getuid === 'function' ? process.getuid() : null;
  }

  /**
   * Owner of `p` (D51): the name from the probe, else this account's name when
   * it owns `p`; `ownedByYou` compares the owner's uid (probe, else fs.stat)
   * with this account's. Each is null when unknown.
   * @returns {Promise<{ owner: string | null, ownedByYou: boolean | null }>}
   */
  async function ownerInfo(p, probed) {
    // Never throws (validation 6 F3): an owner lookup that fails (os.userInfo()
    // throws ENOENT for a uid without a passwd entry) only makes the owner
    // unknown; it must not hide the blocking path or turn the error into a raw Error.
    let owner = probed && typeof probed.owner === 'string' && probed.owner ? probed.owner : null;
    let ownedByYou = null;
    try {
      let uid = probed && probed.uid !== null ? probed.uid : null;
      if (uid === null) {
        const st = await statOf(p);
        uid = st && Number.isSafeInteger(st.uid) ? st.uid : null;
      }
      const me = myUid();
      ownedByYou = uid === null || me === null ? null : uid === me;
    } catch {
      ownedByYou = null;
    }
    if (!owner && ownedByYou) {
      try {
        const name = userInfo().username;
        owner = typeof name === 'string' && name ? name : null;
      } catch {
        owner = null;
      }
    }
    return { owner, ownedByYou };
  }

  /** 'folder' or 'file' for a blocking path (D53): through symlinks like a write, else the entry itself, else by its role. Never throws. */
  async function targetOf(p, file) {
    const st = (await statOf(p)) || (await lstatOf(p));
    if (st) return st.isDirectory() ? 'folder' : 'file';
    return p === file ? 'file' : 'folder';
  }

  async function lstatOf(p) {
    try {
      return await fs.promises.lstat(p);
    } catch {
      return null;
    }
  }

  async function canUseDir(p) {
    return !(await denies(p, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK));
  }

  /**
   * What a stale `routes.lock` adds to the blocking chain (validation 6 F2), so
   * `getRoutesAccess()` sees what a write's `rm` of it would hit. Only a lock
   * the write would remove counts (`isStaleLock`, the write's own rule): one that
   * isn't a real directory, one older than ROUTE_LOCK_STALE_MS, or one with
   * entries (validation 7 F1). A fresh empty lock is just held by a writer.
   * - `flagChain`: the lock and, for a directory, what's inside it (breadth
   *   first, parent before child, at most STALE_LOCK_SCAN_MAX paths). A flag on
   *   any of them makes the `rm` fail with EPERM → locked.
   * - `blockers`: directories inside the lock that the `rm` can't empty: one
   *   with entries that this account can't list, write and search (R/W/X), or
   *   one it can't list that has entries (APFS `nlink > 2`). An empty directory
   *   is always removable (rmdir needs only its parent) → not a blocker.
   * Symlinks are never probed: `stat -L` would read the link's target, which the
   * `rm` never touches (a flag on a link itself, `chflags -h`, isn't seen; the
   * write still explains it).
   * @returns {Promise<{ flagChain: string[], blockers: string[] }>}
   */
  async function staleLockParts(dir) {
    const out = { flagChain: [], blockers: [] };
    const lockAbs = path.join(dir, 'routes.lock');
    const entry = await lstatOf(lockAbs);
    // A symlink lock is only unlinked by the write: nothing behind it is probed.
    if (!entry || entry.isSymbolicLink()) return out;
    if (!(await isStaleLock(lockAbs, entry))) return out;
    if (!entry.isDirectory()) {
      out.flagChain.push(lockAbs);
      return out;
    }
    const queue = [lockAbs];
    let seen = 1;
    while (queue.length) {
      const d = queue.shift();
      out.flagChain.push(d);
      let names = null;
      try {
        names = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        names = null;
      }
      if (names === null) {
        const st = await lstatOf(d);
        if (st && st.nlink > 2) out.blockers.push(d);
        continue;
      }
      if (names.length && !(await canUseDir(d))) out.blockers.push(d);
      for (const e of names) {
        if (seen >= STALE_LOCK_SCAN_MAX) break;
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        seen += 1;
        if (e.isDirectory()) queue.push(p);
        else out.flagChain.push(p);
      }
    }
    return out;
  }

  /**
   * The path that blocks route writes under `dir` (shared by getRoutesAccess
   * and explainWriteRefused, so banner and error details agree, D53). Paths are
   * taken in write order: the state folder (or its nearest existing parent),
   * then a stale routes.lock the write must remove, then routes.json. Any flag
   * wins over any permission problem (the flag has to be cleared first either way).
   * @param {string} dir
   * @param {{ errPath: string, entryDir: string } | null} staleHint  a refused write's `rm` of a stale lock: the entry it failed on
   * @returns {Promise<{ lock: { path: string, flag: 'uchg' | 'schg', target: 'file' | 'folder' } | null, blocking: string | null, probed: Map<string, any> }>}
   */
  async function findBlock(dir, staleHint) {
    const found = await findBlockOnce(dir, staleHint);
    // Validation 7 F2: a blocker that is gone by now (a writer removed the stale
    // lock while we looked) is not reported; look once more instead.
    if (found.blocking && !(await lstatOf(found.blocking))) return findBlockOnce(dir, staleHint);
    return found;
  }

  async function findBlockOnce(dir, staleHint) {
    const file = path.join(dir, 'routes.json');
    const folder = await nearestExistingDir(dir);
    const stale = folder === dir ? await staleLockParts(dir) : { flagChain: [], blockers: [] };
    const hint = staleHint ? [staleHint.entryDir, staleHint.errPath] : [];
    const probed = new Map();
    const lock = await firstFlagged([folder, ...stale.flagChain, ...hint, file], probed);
    if (lock) return { lock, blocking: lock.path, probed };
    let blocking = null;
    // W and X: creating routes.lock and opening routes.json both need the folder's
    // search bit too, so a 0666 folder is named itself, not the file inside it.
    if (await denies(folder, fs.constants.W_OK | fs.constants.X_OK)) blocking = folder;
    if (!blocking && stale.blockers.length) blocking = stale.blockers[0];
    if (!blocking && staleHint) blocking = await firstNotWritable(hint);
    // R and W (validation 7 F5): the write reads the list before it replaces it,
    // and an unreadable list is refused, never read as [].
    if (!blocking && (await denies(file, fs.constants.R_OK | fs.constants.W_OK))) blocking = file;
    return { lock: null, blocking, probed };
  }

  /**
   * The first of `chain` (parent first: a flag on a folder blocks every entry
   * in it) that exists and carries an immutable flag. Probes run in parallel;
   * every answer is kept in `probed`.
   * @returns {Promise<{ path: string, flag: 'uchg' | 'schg', target: 'file' | 'folder' } | null>}
   */
  async function firstFlagged(chain, probed) {
    const paths = [...new Set(chain)];
    const stats = await Promise.all(paths.map(statOf));
    const flags = await Promise.all(paths.map((p, i) => (stats[i] ? flagsOf(p) : null)));
    paths.forEach((p, i) => probed.set(p, flags[i]));
    for (let i = 0; i < paths.length; i += 1) {
      if (flags[i] && flags[i].flag) return { path: paths[i], flag: flags[i].flag, target: stats[i].isDirectory() ? 'folder' : 'file' };
    }
    return null;
  }

  /** The first of `chain` that exists and is not writable, else null. */
  async function firstNotWritable(chain) {
    for (const p of [...new Set(chain)]) {
      if (await denies(p, fs.constants.W_OK)) return p;
    }
    return null;
  }

  /**
   * A route write (routes.json, or the `routes.lock` mkdir / stale-lock rm in
   * its folder) failed with EPERM/EACCES/EROFS: ROUTES_LOCKED when the path
   * that blocks carries an immutable flag, else ROUTES_NOT_WRITABLE. `raw` = OS text.
   * Details (D51/D53): `{ path, flag, target, owner, ownedByYou }` when locked,
   * `{ path, target, owner, ownedByYou }` when not writable; the same facts
   * `getRoutesAccess()` reports (shared `findBlock`), so banner details equal these.
   * - A missing state dir is judged on its nearest existing parent (the
   *   `mkdir -p` creates it there).
   * - A stale `routes.lock` that can't be removed is reported on the entry the
   *   `rm` failed on (or its folder), not on the state folder.
   * Never throws, always a PortlessError. Reads flags only; never changes them.
   */
  async function explainWriteRefused(err) {
    const raw = err && err.message ? String(err.message) : String(err);
    const errPath = err && typeof err.path === 'string' && err.path && !err.path.includes('\0') ? path.resolve(err.path) : null;
    let file = errPath;
    try {
      const dir = stateDir();
      file = path.join(dir, 'routes.json');
      const lockAbs = path.resolve(dir, 'routes.lock');
      const staleLock = errPath !== null && ((errPath === lockAbs && err.syscall !== 'mkdir') || errPath.startsWith(lockAbs + path.sep));
      const entryDir = staleLock ? path.dirname(errPath) : null;
      const found = await findBlock(dir, staleLock ? { errPath, entryDir } : null);
      if (found.lock) {
        const { lock } = found;
        // D53: the owner tells N4 whether the user can clear a `uchg` without sudo.
        const { owner, ownedByYou } = await ownerInfo(lock.path, found.probed.get(lock.path));
        return new PortlessError('ROUTES_LOCKED', undefined, { raw, cause: err, details: { path: lock.path, flag: lock.flag, target: lock.target, owner, ownedByYou } });
      }
      const folder = await nearestExistingDir(dir);
      const blocking = found.blocking || (staleLock ? entryDir : errPath === null || errPath === path.resolve(file) ? file : folder);
      const target = await targetOf(blocking, file);
      const { owner, ownedByYou } = await ownerInfo(blocking, found.probed.get(blocking));
      return new PortlessError('ROUTES_NOT_WRITABLE', undefined, { raw, cause: err, details: { path: blocking, target, owner, ownedByYou } });
    } catch {
      // Last resort (nothing above should throw): still the E13 code, never a raw Error.
      const p = file || null;
      return new PortlessError('ROUTES_NOT_WRITABLE', undefined, { raw, cause: err, details: { path: p, target: p ? await targetOf(p, p) : null, owner: null, ownedByYou: null } });
    }
  }

  let accessCache = null; // { at, dir, value }
  let accessInFlight = null; // { gen, dir, promise }
  let accessGen = 0; // bumped by every route write and every forced read: only the newest-started read may fill the cache

  function invalidateRoutesAccess() {
    accessGen += 1;
    accessCache = null;
    accessInFlight = null;
  }

  async function computeRoutesAccess(dir) {
    const file = path.join(dir, 'routes.json');
    const fallback = { locked: false, flag: null, target: null, writable: true, path: file, owner: null, ownedByYou: null };
    try {
      if (typeof dir !== 'string' || !dir || dir.includes('\0')) return fallback;
      // D51: writes need the folder (routes.lock mkdir), a stale routes.lock
      // removed (validation 6 F2) and the file; `writable` is false whenever
      // any of them blocks.
      const { lock, blocking, probed } = await findBlock(dir, null);
      if (!blocking) return fallback;
      const { owner, ownedByYou } = await ownerInfo(blocking, probed.get(blocking));
      if (lock) return { locked: true, flag: lock.flag, target: lock.target, writable: false, path: lock.path, owner, ownedByYou };
      return { locked: false, flag: null, target: await targetOf(blocking, file), writable: false, path: blocking, owner, ownedByYou };
    } catch {
      return fallback;
    }
  }

  /**
   * Read-only (E13 + D51): is routes.json locked or not writable? Cached
   * ROUTES_ACCESS_TTL_MS; dropped after any route write; `{ refresh: true }`
   * bypasses the cache (the dashboard's "Check again"), and an older read still
   * in flight can no longer overwrite its answer. Never throws: on any error →
   * `{ locked: false, flag: null, target: null, writable: true, path, owner: null, ownedByYou: null }`.
   * A missing routes.json is not locked. Nidum Local never changes file flags.
   * @param {{ refresh?: boolean }} [opts]
   * @returns {Promise<RoutesAccess>}
   */
  async function getRoutesAccess({ refresh = false } = {}) {
    let dir;
    try {
      dir = stateDir();
    } catch {
      dir = '';
    }
    const now = Date.now();
    if (!refresh && accessCache && accessCache.dir === dir && now - accessCache.at < ROUTES_ACCESS_TTL_MS) return { ...accessCache.value };
    if (!refresh && accessInFlight && accessInFlight.dir === dir && accessInFlight.gen === accessGen) return { ...(await accessInFlight.promise) };
    if (refresh) accessGen += 1; // supersedes every read started before it
    const gen = accessGen;
    const promise = computeRoutesAccess(dir);
    accessInFlight = { gen, dir, promise };
    const value = await promise;
    if (gen === accessGen) {
      accessCache = { at: Date.now(), dir, value };
      if (accessInFlight && accessInFlight.promise === promise) accessInFlight = null;
    }
    return { ...value };
  }

  function takenByApp(name, existing, ctx) {
    return new PortlessError('NAME_TAKEN_BY_APP', `${name} is used by a running app. Stop that app or pick another name.`, {
      details: { route: toRoute(existing, ctx) },
    });
  }

  function nameTaken(name, existing, ctx) {
    return new PortlessError('NAME_TAKEN', `${name} already points to port ${existing.port}.`, { details: { route: toRoute(existing, ctx) } });
  }

  function aliasIn(routes, name, ctx) {
    const n = validateName(name);
    const hostname = `${n}.${TLD}`;
    const existing = routes.find((r) => r.hostname === hostname);
    if (!existing) throw new PortlessError('NOT_FOUND', `There's no address called ${n}.`);
    if (existing.pid !== 0) throw takenByApp(n, existing, ctx);
    return { n, hostname, existing };
  }

  /**
   * Register `<name>.local → 127.0.0.1:<port>` (alias, pid 0). The check and
   * the write happen under the route lock. An existing alias → NAME_TAKEN
   * unless `force`; a live app route → NAME_TAKEN_BY_APP even with `force`
   * (nothing is ever killed).
   * @param {string} name
   * @param {number} port
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<Route>}
   */
  function addAlias(name, port, { force = false } = {}) {
    return serial('routes', async () => {
      const n = validateName(name);
      const p = validatePort(port);
      assertIsolated('Adding an address');
      const hostname = `${n}.${TLD}`;
      const ctx = urlContext();
      return transact((routes) => {
        const existing = routes.find((r) => r.hostname === hostname);
        if (existing && existing.pid !== 0) throw takenByApp(n, existing, ctx);
        if (existing && !force) throw nameTaken(n, existing, ctx);
        return { ops: [{ op: 'add', hostname, port: p }], result: toRoute({ hostname, port: p, pid: 0 }, ctx) };
      });
    });
  }

  /**
   * Remove an alias. `name` may also be the full hostname of a route under a
   * different TLD (foreignTld). App routes are refused (NAME_TAKEN_BY_APP).
   * @param {string} name
   * @returns {Promise<Route>} the removed route
   */
  function removeAlias(name) {
    return serial('routes', async () => {
      assertIsolated('Removing an address');
      const ctx = urlContext();
      return transact((routes) => {
        let existing = typeof name === 'string' ? routes.find((r) => r.hostname === name) : undefined;
        if (!existing) {
          const hostname = `${validateName(name)}.${TLD}`;
          existing = routes.find((r) => r.hostname === hostname);
        }
        if (!existing) throw new PortlessError('NOT_FOUND', `There's no address called ${name}.`);
        if (existing.pid !== 0) throw takenByApp(name, existing, ctx);
        return { ops: [{ op: 'remove', hostname: existing.hostname }], result: toRoute(existing, ctx) };
      });
    });
  }

  /**
   * Point an existing alias at another port.
   * @param {string} name
   * @param {number} port
   * @returns {Promise<Route>}
   */
  function changePort(name, port) {
    return serial('routes', async () => {
      const p = validatePort(port);
      assertIsolated('Changing an address');
      const ctx = urlContext();
      return transact((routes) => {
        const { hostname } = aliasIn(routes, name, ctx);
        return { ops: [{ op: 'add', hostname, port: p }], result: toRoute({ hostname, port: p, pid: 0 }, ctx) };
      });
    });
  }

  /**
   * Rename an alias: add the new name, remove the old one. With the default
   * file backend both happen in one locked write, so a failure changes
   * nothing; the RouteStore cross-check backend rolls back step by step.
   * @param {string} oldName
   * @param {string} newName
   * @param {{ force?: boolean }} [opts]  replace an existing alias called newName
   * @returns {Promise<Route>}
   */
  function renameAlias(oldName, newName, { force = false } = {}) {
    return serial('routes', async () => {
      const nn = validateName(newName);
      assertIsolated('Renaming an address');
      const ctx = urlContext();
      return transact((routes) => {
        const { hostname: oldHost, existing } = aliasIn(routes, oldName, ctx);
        const newHost = `${nn}.${TLD}`;
        if (newHost === oldHost) return { ops: [], result: toRoute(existing, ctx) };
        const clash = routes.find((r) => r.hostname === newHost);
        if (clash && clash.pid !== 0) throw takenByApp(nn, clash, ctx);
        if (clash && !force) throw nameTaken(nn, clash, ctx);
        return {
          ops: [{ op: 'add', hostname: newHost, port: existing.port }, { op: 'remove', hostname: oldHost }],
          result: toRoute({ hostname: newHost, port: existing.port, pid: 0 }, ctx),
        };
      });
    });
  }

  function buildProxyFlags(settings) {
    const s = settings || {};
    const port = validatePort(s.port ?? (s.tls ? 443 : 80));
    const lan = s.lan !== false;
    const flags = [];
    if (lan) flags.push('--lan');
    flags.push(s.tls ? '--https' : '--no-tls', '-p', String(port));
    if (!lan) flags.push('--tld', TLD);
    if (s.fixedIp) {
      if (!lan) throw new PortlessError('UNSUPPORTED', 'A fixed network address needs network sharing (LAN mode).');
      if (net.isIP(s.fixedIp) !== 4) throw new PortlessError('UNSUPPORTED', `${s.fixedIp} isn't an IPv4 address.`);
      flags.push('--ip', s.fixedIp);
    }
    if (s.wildcard) flags.push('--wildcard');
    return { flags, port, lan };
  }

  /**
   * Argv `startProxy(settings)` passes after the binary (F1): always explicit,
   * `proxy start --lan [--no-tls|--https] -p <port> [--ip X] [--wildcard]`.
   * `lan: false` (tests only) gives `proxy start --no-tls -p <port> --tld local`.
   * @param {{ tls?: boolean, port?: number, lan?: boolean, fixedIp?: string | null, wildcard?: boolean }} settings
   * @returns {string[]}
   */
  function startArgs(settings) {
    return ['proxy', 'start', ...buildProxyFlags(settings).flags];
  }

  function needsRoot(port) {
    return platform !== 'win32' && port < 1024 && process.getuid?.() !== 0;
  }

  /**
   * Start a proxy with the full explicit config. Refuses (SERVICE_MANAGED) when
   * the startup service owns this state dir, unless `allowService`. A Portless
   * proxy already answering on the port → returns its state without running
   * anything and **without comparing settings** (callers changing settings stop
   * first, or reinstall the service); another program on the port →
   * PORT_IN_USE. Ports < 1024 elevate. Safe mode: no LAN, no TLS, no privileged
   * or forbidden port, isolated state dir only, and `--skip-trust` is appended.
   * @param {{ tls: boolean, port: number, lan?: boolean, fixedIp?: string | null, wildcard?: boolean }} settings
   * @param {{ allowService?: boolean, timeout?: number }} [opts]
   * @returns {Promise<ProxyState>}
   */
  function startProxy(settings, opts) {
    return serial('proxy', () => startProxyNow(settings, opts));
  }

  async function startProxyNow(settings, { allowService = false, timeout } = {}) {
    const args = startArgs(settings);
    const { port, lan } = buildProxyFlags(settings);
    if (safeMode) {
      if (lan) throw new PortlessError('UNSUPPORTED', 'LAN mode is disabled in safe mode.');
      if (settings?.tls) throw new PortlessError('UNSUPPORTED', 'HTTPS is disabled in safe mode (it would trust a CA in the keychain).');
      if (port < 1024 || SAFE_MODE_FORBIDDEN_PORTS.has(port)) throw new PortlessError('UNSUPPORTED', `Port ${port} is disabled in safe mode.`);
      assertIsolated('Starting a proxy');
      args.push('--skip-trust');
    }
    const before = await getProxyState();
    if (before.managedBy === 'service' && !allowService) throw new PortlessError('SERVICE_MANAGED');
    if (await responding(port)) return getProxyState();
    if (await listening(port)) throw new PortlessError('PORT_IN_USE', `Another program is using port ${port}.`, { details: { port } });
    const elevated = needsRoot(port);
    await run(args, { elevate: elevated, prompt: ELEVATION_PROMPTS.start(port), timeout: timeout ?? (elevated ? ELEVATED_TIMEOUT_MS : START_TIMEOUT_MS) });
    if (!(await waitFor(() => responding(port), 5000))) {
      throw new PortlessError('PROXY_DOWN', 'Sharing did not start.', { details: { port } });
    }
    return getProxyState();
  }

  /**
   * Stop the proxy for this state dir. Refuses (SERVICE_MANAGED) when the
   * startup service owns it, unless `allowService` (launchd KeepAlive would
   * restart it anyway). Elevates when the proxy runs as root.
   * @param {{ allowService?: boolean, timeout?: number }} [opts]
   * @returns {Promise<ProxyState>}
   */
  function stopProxy(opts) {
    return serial('proxy', () => stopProxyNow(opts));
  }

  async function stopProxyNow({ allowService = false, timeout } = {}) {
    const state = await getProxyState();
    if (state.managedBy === 'service' && (!allowService || safeMode)) throw new PortlessError('SERVICE_MANAGED');
    if (!state.running && state.pid === null) return state;
    if (safeMode) assertIsolated('Stopping a proxy');
    const elevated = state.elevated && platform !== 'win32';
    await run(['proxy', 'stop', '-p', String(state.port)], { elevate: elevated, prompt: ELEVATION_PROMPTS.stop, timeout: timeout ?? (elevated ? ELEVATED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS) });
    if (!(await waitFor(async () => !(await responding(state.port)), 5000))) {
      throw new PortlessError('UNKNOWN', 'Sharing did not stop.', { details: { port: state.port } });
    }
    return getProxyState();
  }

  /**
   * `portless doctor`, parsed (F21). Exit 1 (failures found) is a normal result.
   * @returns {Promise<{ findings: Array<{ status: 'ok'|'warn'|'fail'|'info', message: string, hint?: string }>, header: Record<string,string>, summary: { failures: number, warnings: number } | null, raw: string }>}
   */
  async function doctor() {
    const res = await run(['doctor'], { okExitCodes: [0, 1] });
    return { ...parseDoctor(res.output), raw: res.output };
  }

  /**
   * `portless service status`, parsed (read-only).
   * @returns {Promise<ReturnType<typeof parseServiceStatus> & { raw: string }>}
   */
  async function serviceStatus() {
    const res = await run(['service', 'status']);
    return { ...parseServiceStatus(res.output), raw: res.output };
  }

  function unsafe(name) {
    if (safeMode) throw new PortlessError('UNSUPPORTED', 'disabled in safe mode', { details: { command: name } });
  }

  /** `portless trust` (elevated). Throws UNSUPPORTED in safe mode. */
  async function trust({ timeout = 150000 } = {}) {
    unsafe('trust');
    return run(['trust'], { elevate: true, prompt: ELEVATION_PROMPTS.trust, timeout });
  }

  /** `portless hosts sync` (elevated). Throws UNSUPPORTED in safe mode. */
  async function hostsSync({ timeout = ELEVATED_TIMEOUT_MS } = {}) {
    unsafe('hostsSync');
    return run(['hosts', 'sync'], { elevate: true, prompt: ELEVATION_PROMPTS.hostsSync, timeout });
  }

  /** `portless prune` (kills orphaned dev servers). Throws UNSUPPORTED in safe mode. */
  async function prune({ timeout = DEFAULT_TIMEOUT_MS } = {}) {
    unsafe('prune');
    return run(['prune'], { timeout });
  }

  /** `portless clean` (elevated; reaches outside the state dir). Throws UNSUPPORTED in safe mode. */
  async function clean({ timeout = ELEVATED_TIMEOUT_MS } = {}) {
    unsafe('clean');
    return run(['clean'], { elevate: true, prompt: ELEVATION_PROMPTS.clean, timeout });
  }

  /**
   * `portless service install <full explicit flags>` (elevated).
   * Throws UNSUPPORTED in safe mode.
   * @param {{ tls: boolean, port: number, lan?: boolean, fixedIp?: string | null, wildcard?: boolean }} settings
   */
  async function serviceInstall(settings, { timeout = ELEVATED_TIMEOUT_MS } = {}) {
    unsafe('serviceInstall');
    return run(['service', 'install', ...buildProxyFlags(settings).flags], { elevate: true, prompt: ELEVATION_PROMPTS.serviceInstall, timeout });
  }

  /** `portless service uninstall` (elevated). Throws UNSUPPORTED in safe mode. */
  async function serviceUninstall({ timeout = ELEVATED_TIMEOUT_MS } = {}) {
    unsafe('serviceUninstall');
    return run(['service', 'uninstall'], { elevate: true, prompt: ELEVATION_PROMPTS.serviceUninstall, timeout });
  }

  return {
    safeMode,
    findPortless: () => resolveInstall(),
    stateDir,
    run,
    listRoutes,
    getProxyState,
    getServiceConfig,
    addAlias,
    removeAlias,
    changePort,
    renameAlias,
    startArgs,
    startProxy,
    stopProxy,
    doctor,
    serviceStatus,
    trust,
    hostsSync,
    prune,
    clean,
    serviceInstall,
    serviceUninstall,
    stopService,
    startService,
    validateName,
    getRoutesAccess,
    routeBackend: routeBackendKind,
    elevationEnv: (env = baseEnv) => {
      const inst = resolveInstall();
      if (!inst) throw new PortlessError('CLI_MISSING');
      return elevationEnv({ ...env, NO_COLOR: '1' }, inst);
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level API: a default instance over process.env
// ---------------------------------------------------------------------------

let defaultInstance = null;
function d() {
  if (!defaultInstance) defaultInstance = createPortless();
  return defaultInstance;
}

/** @see createPortless — `run` of the default instance. */
export const run = (args, opts) => d().run(args, opts);
/** @returns {string} Portless state dir of the default instance. */
export const stateDir = () => d().stateDir();
/** @returns {Promise<Route[]>} */
export const listRoutes = (opts) => d().listRoutes(opts);
/** @returns {Promise<ProxyState>} */
export const getProxyState = (opts) => d().getProxyState(opts);
/** Parsed startup-service definition or null. */
export const getServiceConfig = () => d().getServiceConfig();
/** @returns {Promise<Route>} */
export const addAlias = (name, port, opts) => d().addAlias(name, port, opts);
/** @returns {Promise<Route>} */
export const removeAlias = (name) => d().removeAlias(name);
/** @returns {Promise<Route>} */
export const changePort = (name, port) => d().changePort(name, port);
/** @returns {Promise<Route>} */
export const renameAlias = (oldName, newName, opts) => d().renameAlias(oldName, newName, opts);
/** @returns {Promise<ProxyState>} */
export const startProxy = (settings, opts) => d().startProxy(settings, opts);
/** @returns {Promise<ProxyState>} */
export const stopProxy = (opts) => d().stopProxy(opts);
/** Parsed `portless doctor`. */
export const doctor = () => d().doctor();
/** Parsed `portless service status`. */
export const serviceStatus = () => d().serviceStatus();
/** `portless trust`, elevated. */
export const trust = (opts) => d().trust(opts);
/** `portless hosts sync`, elevated. */
export const hostsSync = (opts) => d().hostsSync(opts);
/** `portless prune`. */
export const prune = (opts) => d().prune(opts);
/** `portless clean`, elevated. */
export const clean = (opts) => d().clean(opts);
/** `portless service install …`, elevated. */
export const serviceInstall = (settings, opts) => d().serviceInstall(settings, opts);
/** `portless service uninstall`, elevated. */
export const serviceUninstall = (opts) => d().serviceUninstall(opts);
/** Stop (boot out) the startup service, elevated (E12). */
export const stopService = (opts) => d().stopService(opts);
/** Start (bootstrap) the startup service, elevated (E12). */
export const startService = (opts) => d().startService(opts);
/** Read-only: is routes.json locked or not writable (E13)? Never throws. @returns {Promise<RoutesAccess>} */
export const getRoutesAccess = (opts) => d().getRoutesAccess(opts);
