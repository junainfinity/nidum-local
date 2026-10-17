// Port discovery: finds the TCP ports something on this computer listens on,
// works out what each one is and suggests a name for it.
//
// macOS is verified end to end. Linux and Windows code paths are tested
// against fixtures only (experimental).
//
// Root-owned listeners are invisible to a non-root `lsof` on macOS, so the
// Portless proxy on :80 is not listed there. The Discover list is therefore
// "services you can see". Ports visible without process info (Linux `ss`
// without `-p` data) come back with `process: null` ("Another user").
//
// Every external command goes through `runCommand()`: `execFile` with an
// argument array (never a shell string) and an explicit timeout.

import { execFile } from 'node:child_process';
import { STATUS_CODES, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readlink, readFile, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

/** Directories added to PATH so system tools resolve even from a GUI launch. */
const SYSTEM_PATH = ['/usr/sbin', '/sbin', '/usr/bin', '/bin'];

/** Absolute tool paths on macOS (PATH may lack /usr/sbin when launched from Finder). */
const DARWIN_BIN = { lsof: '/usr/sbin/lsof', ps: '/bin/ps' };

const LISTEN_TIMEOUT = 5000;
const DETAIL_TIMEOUT = 4000;
const POWERSHELL_TIMEOUT = 10000;
const PROBE_MAX_BYTES = 64 * 1024;
const PROBE_CACHE_TTL = 30000;
const PROBE_TIMEOUT_CACHE_TTL = 15000;
const SCAN_DEADLINE = 2500;
const SCAN_CONCURRENCY = 8;
const MAX_COMMAND_LENGTH = 2000;

/**
 * Runs a program with an argument array and a timeout. Never rejects.
 *
 * @param {string} file Program name or absolute path.
 * @param {string[]} args Arguments (no shell is involved).
 * @param {{ timeout?: number, maxBuffer?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string,
 *   error: string | null, timedOut: boolean, overflow: boolean }>} `ok` is true when the exit
 *   code is 0; `timedOut` when killed by the timeout; `overflow` when output exceeded `maxBuffer`.
 */
export function runCommand(file, args, { timeout = 5000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (process.platform !== 'win32') env.PATH = [process.env.PATH || '', ...SYSTEM_PATH].filter(Boolean).join(':');
    let child;
    try {
      child = execFile(
        file,
        args,
        { timeout, maxBuffer, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', env },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, code: 0, stdout, stderr, error: null, timedOut: false, overflow: false });
          const overflow = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const timedOut = !overflow && Boolean(err.killed && err.signal);
          let error;
          if (overflow) error = `${file} output exceeded ${maxBuffer} bytes`;
          else if (timedOut) error = `${file} timed out after ${timeout} ms`;
          else if (typeof err.code === 'string') error = `${file}: ${err.code}`;
          else error = String(err.message);
          resolve({
            ok: false,
            code: typeof err.code === 'number' ? err.code : null,
            stdout: stdout || '',
            stderr: stderr || '',
            error,
            timedOut,
            overflow,
          });
        },
      );
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: `${file}: ${err.message}`, timedOut: false, overflow: false });
      return;
    }
    child.on('error', () => {}); // reported through the callback
  });
}

// ---------------------------------------------------------------------------
// Addresses

/** Normalises a bind address: strips IPv6 brackets, maps lsof's `*` by socket type. */
function normaliseAddress(host, type) {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '*') {
    if (type === 'IPv4') return '0.0.0.0';
    if (type === 'IPv6') return '::';
    return '*';
  }
  return h;
}

/** Splits `host:port` (host may be `[v6]`, `*`, or carry a `%scope`). */
function splitHostPort(text) {
  const i = text.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: text.slice(0, i), port };
}

/** True when the address only accepts connections from this computer. */
function isLoopbackAddress(addr) {
  const a = String(addr).toLowerCase();
  if (a.startsWith('127.') || a === '::1' || a === 'localhost' || a.startsWith('::ffff:127.')) return true;
  const scope = a.indexOf('%');
  if (scope !== -1) {
    const ifname = a.slice(scope + 1);
    if (ifname === 'lo' || ifname === 'lo0' || ifname === '1') return true;
  }
  return false;
}

/** `loopback` when every address is a loopback address, else `network`. */
function reachOf(addresses) {
  return addresses.length > 0 && addresses.every(isLoopbackAddress) ? 'loopback' : 'network';
}

/** Address to probe a listener on: 127.0.0.1, ::1 when bound only to IPv6, or the specific bind address. */
function probeHostFor(addresses) {
  const list = addresses && addresses.length ? addresses : ['127.0.0.1'];
  if (list.some((a) => a === '*' || a === '0.0.0.0' || a.startsWith('127.') || a.startsWith('::ffff:127.'))) return '127.0.0.1';
  if (list.some((a) => a === '::' || a === '::1')) return '::1';
  const first = list[0];
  if (first.includes(':')) return first; // specific IPv6 (scope kept)
  return first.split('%')[0];
}

/** Merges raw socket rows into one entry per port + pid. */
function mergeListeners(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.port}:${r.pid ?? '-'}`;
    let e = byKey.get(key);
    if (!e) {
      e = { port: r.port, pid: r.pid ?? null, process: r.process ?? null, user: r.user ?? null, addresses: [] };
      byKey.set(key, e);
    }
    if (!e.process && r.process) e.process = r.process;
    if (!e.user && r.user) e.user = r.user;
    if (r.address && !e.addresses.includes(r.address)) e.addresses.push(r.address);
  }
  return [...byKey.values()]
    .map((e) => ({ ...e, reach: reachOf(e.addresses) }))
    .sort((a, b) => a.port - b.port || (a.pid ?? -1) - (b.pid ?? -1));
}

// ---------------------------------------------------------------------------
// Parsers

/**
 * Normalises PowerShell JSON collections: `null` → [], a bare object → [object], and the
 * Windows PowerShell 5.1 wrapper `{ value: [...], Count: n }` → the inner array.
 * @param {unknown} v
 * @returns {Array<any>}
 */
export function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && Array.isArray(v.value) && 'Count' in v) return v.value;
  return [v];
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcuLn[t]` output.
 *
 * @param {string} text Raw lsof field output (one field per line).
 * @returns {Array<{ port: number, pid: number | null, process: string | null, user: string | null,
 *   addresses: string[], reach: 'loopback' | 'network' }>} One entry per port + pid, sorted.
 */
export function parseLsof(text) {
  const rows = [];
  let proc = null;
  let type = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    switch (tag) {
      case 'p':
        proc = { pid: Number(value) || null, process: null, uid: null, login: null };
        type = null;
        break;
      case 'c':
        if (proc) proc.process = value || null;
        break;
      case 'u':
        if (proc) proc.uid = value;
        break;
      case 'L':
        if (proc) proc.login = value || null;
        break;
      case 'f':
        type = null;
        break;
      case 't':
        type = value;
        break;
      case 'n': {
        if (!proc) break;
        const local = value.split('->')[0];
        const hp = splitHostPort(local);
        if (!hp) break;
        rows.push({
          port: hp.port,
          pid: proc.pid,
          process: proc.process,
          user: proc.login ?? (proc.uid != null ? (proc.uid === '0' ? 'root' : proc.uid) : null),
          address: normaliseAddress(hp.host, type),
        });
        break;
      }
      default:
        break;
    }
  }
  return mergeListeners(rows);
}

/**
 * Parses `ss -ltnpH` (or `ss -ltnH`) output. Lines without `users:(...)` data
 * yield `pid: null, process: null` (a socket owned by another user).
 *
 * @param {string} text Raw ss output without a header line.
 * @returns {Array<{ port: number, pid: number | null, process: string | null, user: string | null,
 *   addresses: string[], reach: 'loopback' | 'network' }>} One entry per port + pid, sorted.
 */
export function parseSs(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^State\s/i.test(line) || /^Netid\s/i.test(line)) continue;
    const usersAt = line.indexOf('users:(');
    const head = usersAt === -1 ? line : line.slice(0, usersAt);
    const cols = head.trim().split(/\s+/);
    // State Recv-Q Send-Q Local Peer  (State may be absent with some filters)
    const local = /^\d+$/.test(cols[0]) ? cols[2] : cols[3];
    if (!local) continue;
    const hp = splitHostPort(local);
    if (!hp) continue;
    const address = normaliseAddress(hp.host, null);
    const owners = [];
    if (usersAt !== -1) {
      const re = /\("((?:[^"\\]|\\.)*)",pid=(\d+)/g;
      const users = line.slice(usersAt);
      let m;
      while ((m = re.exec(users))) owners.push({ process: m[1], pid: Number(m[2]) });
    }
    if (owners.length === 0) rows.push({ port: hp.port, pid: null, process: null, user: null, address });
    for (const o of owners) rows.push({ port: hp.port, pid: o.pid, process: o.process, user: null, address });
  }
  return mergeListeners(rows);
}

/**
 * Parses the JSON printed by the Windows listener script
 * (`{ connections: [{ LocalAddress, LocalPort, OwningProcess }], processes: [{ Id, ProcessName }] }`).
 * Tolerates PowerShell's habit of emitting a single object instead of a one-element array.
 *
 * @param {string | object} json Raw JSON text or an already-parsed object.
 * @returns {Array<{ port: number, pid: number | null, process: string | null, user: string | null,
 *   addresses: string[], reach: 'loopback' | 'network' }>} One entry per port + pid, sorted.
 */
export function parseWindowsListeners(json) {
  const data = typeof json === 'string' ? JSON.parse(json.trim() || '{}') : json || {};
  const names = new Map(asArray(data.processes).map((p) => [Number(p.Id), p.ProcessName || null]));
  const rows = [];
  for (const c of asArray(data.connections)) {
    const port = Number(c.LocalPort);
    if (!Number.isInteger(port) || port < 1) continue;
    const pid = c.OwningProcess == null ? null : Number(c.OwningProcess);
    rows.push({
      port,
      pid,
      process: pid == null ? null : names.get(pid) ?? (pid === 4 ? 'System' : null),
      user: null,
      address: normaliseAddress(String(c.LocalAddress ?? ''), null),
    });
  }
  return mergeListeners(rows);
}

// ---------------------------------------------------------------------------
// Listeners

const WINDOWS_LISTENERS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'Remove-TypeData System.Array -ErrorAction SilentlyContinue',
  '$c = @(Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess)',
  '$ids = @($c | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)',
  '$p = @(Get-Process -Id $ids | Select-Object Id, ProcessName)',
  '[pscustomobject]@{ connections = $c; processes = $p } | ConvertTo-Json -Compress -Depth 3',
].join('; ');

/** Fills `user` for Linux rows from /proc/<pid> ownership (own user name, `root`, or the uid). */
async function fillLinuxUsers(list, procRoot) {
  let me = null;
  try {
    me = userInfo();
  } catch {
    /* no passwd entry */
  }
  await Promise.all(
    list.map(async (e) => {
      if (e.pid == null || e.user) return;
      try {
        const st = await stat(`${procRoot}/${e.pid}`);
        e.user = me && st.uid === me.uid ? me.username : st.uid === 0 ? 'root' : String(st.uid);
      } catch {
        /* process gone or not permitted */
      }
    }),
  );
  return list;
}

/**
 * Lists TCP listeners, one entry per port + pid with IPv4/IPv6 merged.
 * macOS: `lsof`; Linux: `ss -ltnpH`, falling back to `lsof`; Windows: PowerShell
 * `Get-NetTCPConnection` + `Get-Process` as JSON. Throws when no method works.
 *
 * @param {{ platform?: string, run?: typeof runCommand, procRoot?: string }} [options]
 *   `run` and `procRoot` are injectable for tests.
 * @returns {Promise<Array<{ port: number, pid: number | null, process: string | null,
 *   user: string | null, addresses: string[], reach: 'loopback' | 'network' }>>}
 */
export async function listListeners({ platform = process.platform, run = runCommand, procRoot = '/proc' } = {}) {
  const lsofArgs = ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcuLnt'];
  if (platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LISTENERS_SCRIPT], {
      timeout: POWERSHELL_TIMEOUT,
    });
    if (!r.stdout.trim()) throw new Error(`Get-NetTCPConnection failed: ${r.error || r.stderr.trim() || 'no output'}`);
    return parseWindowsListeners(r.stdout);
  }
  if (platform === 'linux') {
    const ss = await run('ss', ['-ltnpH'], { timeout: LISTEN_TIMEOUT });
    if (ss.ok) return fillLinuxUsers(parseSs(ss.stdout), procRoot);
    const lsof = await run('lsof', lsofArgs, { timeout: LISTEN_TIMEOUT });
    // lsof exits 1 when nothing matches; that is "no listeners", not a failure.
    if (lsof.ok || (lsof.code === 1 && !lsof.timedOut)) return parseLsof(lsof.stdout);
    throw new Error(`ss and lsof both failed: ${ss.error || ss.stderr.trim()}; ${lsof.error || lsof.stderr.trim()}`);
  }
  const bin = platform === 'darwin' ? DARWIN_BIN.lsof : 'lsof';
  const r = await run(bin, lsofArgs, { timeout: LISTEN_TIMEOUT });
  if (r.ok || (r.code === 1 && !r.timedOut)) return parseLsof(r.stdout);
  throw new Error(`lsof failed: ${r.error || r.stderr.trim() || `exit ${r.code}`}`);
}

// ---------------------------------------------------------------------------
// Process details (cwd, command line)

const validPid = (pid) => Number.isInteger(pid) && pid > 0;

/** Parses `lsof -a -d cwd -Fn -p <pids>` into Map<pid, cwd>. */
function parseLsofCwd(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (line.startsWith('n') && pid != null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** Parses `ps -ww -o pid=,command= -p <pids>` into Map<pid, command>. */
function parsePsCommands(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[2].replace(/\\012/g, ' ').trim();
    if (cmd) out.set(Number(m[1]), cmd.slice(0, MAX_COMMAND_LENGTH));
  }
  return out;
}

/** Working directories for many pids at once. Unknown or not permitted → absent from the map. */
async function getCwds(pids, { platform = process.platform, run = runCommand, procRoot = '/proc' } = {}) {
  const list = [...new Set(pids)].filter(validPid);
  if (list.length === 0 || platform === 'win32') return new Map();
  if (platform === 'linux') {
    const out = new Map();
    await Promise.all(
      list.map(async (pid) => {
        try {
          out.set(pid, await readlink(`${procRoot}/${pid}/cwd`));
        } catch {
          /* EACCES / ENOENT → unknown */
        }
      }),
    );
    return out;
  }
  const bin = platform === 'darwin' ? DARWIN_BIN.lsof : 'lsof';
  // Exit 1 is normal when some pids are not permitted; parse whatever came back.
  const r = await run(bin, ['-a', '-d', 'cwd', '-Fn', '-p', list.join(',')], { timeout: DETAIL_TIMEOUT });
  return parseLsofCwd(r.stdout);
}

/** Command lines for many pids at once. Unknown or not permitted → absent from the map. */
async function getCommands(pids, { platform = process.platform, run = runCommand, procRoot = '/proc' } = {}) {
  const list = [...new Set(pids)].filter(validPid);
  if (list.length === 0) return new Map();
  if (platform === 'linux') {
    const out = new Map();
    await Promise.all(
      list.map(async (pid) => {
        try {
          const raw = await readFile(`${procRoot}/${pid}/cmdline`, 'utf8');
          const cmd = raw.split('\0').filter(Boolean).join(' ').trim();
          if (cmd) out.set(pid, cmd.slice(0, MAX_COMMAND_LENGTH));
        } catch {
          /* not permitted */
        }
      }),
    );
    return out;
  }
  if (platform === 'win32') {
    const filter = list.map((p) => `ProcessId=${p}`).join(' OR ');
    const script =
      "$ErrorActionPreference = 'SilentlyContinue'; " +
      `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: POWERSHELL_TIMEOUT });
    const out = new Map();
    try {
      const data = JSON.parse(r.stdout.trim() || '[]');
      for (const p of asArray(data)) {
        if (p && p.CommandLine) out.set(Number(p.ProcessId), String(p.CommandLine).slice(0, MAX_COMMAND_LENGTH));
      }
    } catch {
      /* unparsable → unknown */
    }
    return out;
  }
  const bin = platform === 'darwin' ? DARWIN_BIN.ps : 'ps';
  const r = await run(bin, ['-ww', '-o', 'pid=,command=', '-p', list.join(',')], { timeout: DETAIL_TIMEOUT });
  return parsePsCommands(r.stdout);
}

/**
 * Working directory of a process.
 *
 * @param {number} pid
 * @param {{ platform?: string, run?: typeof runCommand, procRoot?: string }} [options] Injectable for tests.
 * @returns {Promise<string | null>} `null` when unknown, not permitted, or unsupported (Windows).
 */
export async function getCwd(pid, options = {}) {
  if (!validPid(pid)) return null;
  try {
    return (await getCwds([pid], options)).get(pid) ?? null;
  } catch {
    return null;
  }
}

/**
 * Full command line of a process.
 *
 * @param {number} pid
 * @param {{ platform?: string, run?: typeof runCommand, procRoot?: string }} [options] Injectable for tests.
 * @returns {Promise<string | null>} `null` when unknown or not permitted.
 */
export async function getCommand(pid, options = {}) {
  if (!validPid(pid)) return null;
  try {
    return (await getCommands([pid], options)).get(pid) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP probe

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', times: '×', euro: '€', pound: '£',
  yen: '¥', cent: '¢', deg: '°', para: '¶', sect: '§', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return safeChar(parseInt(k.slice(2), 16), m);
    if (k.startsWith('#')) return safeChar(parseInt(k.slice(1), 10), m);
    return ENTITIES[k] ?? m;
  });
}

function safeChar(code, fallback) {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : null;
}

/** Lowercase status phrases ("unauthorized", "not found", …) plus generic error titles. */
const STATUS_PHRASES = new Set([
  ...Object.values(STATUS_CODES).map((p) => String(p).toLowerCase().replace(/[^a-z]+/g, ' ').trim()),
  '',
  'error',
  'page not found',
]);

/**
 * True when a title is only an HTTP status phrase ("Unauthorized", "401 Unauthorized",
 * "Error 404 (Not Found)!!1", "HTTP 502 Bad Gateway", "Error"), case-insensitive, with or
 * without the code. Such titles say nothing about the service.
 */
function isStatusPhraseTitle(title) {
  const words = String(title || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (STATUS_PHRASES.has(words)) return true;
  const stripped = words.replace(/\b(http|error)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return STATUS_PHRASES.has(stripped);
}

function header(headers, name) {
  const v = headers[name];
  if (v == null) return null;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/** Cheap framework hints from headers and the first 64 KB of the body. */
function detectFramework(headers, body, title) {
  const powered = (header(headers, 'x-powered-by') || '').toLowerCase();
  const server = (header(headers, 'server') || '').toLowerCase();
  const cookie = (header(headers, 'set-cookie') || '').toLowerCase();
  const b = body.slice(0, PROBE_MAX_BYTES);
  const t = (title || '').toLowerCase();
  if (powered.includes('next.js') || b.includes('__NEXT_DATA__') || b.includes('/_next/static')) return 'Next.js';
  if (b.includes('/@vite/client') || b.includes('/@react-refresh')) return 'Vite';
  if (t.includes('storybook') || /storybook/i.test(b.slice(0, 4096)) || b.includes('sb-show-main')) return 'Storybook';
  if (t.includes('jupyter') || b.includes('jupyter-config-data') || (cookie.includes('_xsrf') && server.includes('tornado')))
    return 'Jupyter';
  if (b.includes('csrfmiddlewaretoken') || cookie.includes('csrftoken=') || /\bdjango\b/i.test(t) || /<title>[^<]*django/i.test(b))
    return 'Django';
  if (b.includes('__NUXT__') || b.includes('/_nuxt/')) return 'Nuxt';
  if (b.includes('__sveltekit')) return 'SvelteKit';
  if (/<meta[^>]+name="generator"[^>]+content="Astro/i.test(b)) return 'Astro';
  if (powered.includes('express')) return 'Express';
  if (server.includes('werkzeug')) return 'Flask';
  return null;
}

/**
 * @typedef {{ status: number, title: string | null, server: string | null, framework: string | null,
 *   redirectsTo: string | null, tls: boolean }} HttpInfo
 */

/** Plain-HTTP 400 bodies that mean "this port speaks HTTPS" (Go, nginx, others). */
const HTTPS_HINT = /http request to an https server|plain http request was sent to https port|speaks? (only )?https|use https/i;

/**
 * Sends `GET /` to a local port and summarises the answer. Reads at most 64 KB. `title` is
 * `null` when the status is ≥ 400 and the title is only a status phrase (e.g. Plex's 401
 * "Unauthorized"), so the UI falls back to the process name. When the
 * plain-HTTP attempt is reset, isn't HTTP, or gets a 400 saying the port expects HTTPS, it
 * retries over TLS (`rejectUnauthorized: false`, no SNI) within the same deadline. A response
 * whose body is still streaming at the deadline is summarised from what arrived.
 *
 * @param {number} port
 * @param {{ timeout?: number, host?: string }} [options] `host` defaults to `127.0.0.1`
 *   (pass `::1` for listeners bound only there). `timeout` is the whole-probe deadline in ms
 *   (both attempts together).
 * @returns {Promise<HttpInfo | null>} `tls` says whether the answer came over HTTPS. `null`
 *   when the port doesn't speak HTTP(S), refuses, or doesn't answer in time.
 */
export async function probeHttp(port, options = {}) {
  try {
    return (await probeHttpDetailed(port, options)).result;
  } catch {
    return null; // e.g. a port out of range
  }
}

/**
 * One request over plain HTTP or TLS. Resolves `{ type, result?, hint? }` where type is
 * `response` | `reset` (connection reset / hang-up) | `garbage` (bytes that aren't HTTP or a
 * TLS handshake failure) | `timeout` | `refused` | `aborted` | `error`.
 */
function attempt({ tls, host, port, timeout, signal }) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    let onDeadline = () => finish({ type: 'timeout' });
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try {
        req?.destroy();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const onAbort = () => finish({ type: 'aborted' });
    const timer = setTimeout(() => onDeadline(), Math.max(1, timeout));
    if (signal) {
      if (signal.aborted) return finish({ type: 'aborted' });
      signal.addEventListener('abort', onAbort);
    }
    const hostHeader = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    const options = {
      host,
      port,
      path: '/',
      method: 'GET',
      agent: false,
      insecureHTTPParser: true,
      headers: { Host: hostHeader, 'User-Agent': 'nidum-local-discovery', Accept: 'text/html,*/*;q=0.8', Connection: 'close' },
    };
    if (tls) {
      options.rejectUnauthorized = false;
      options.servername = ''; // no SNI: we connect by IP
    }
    try {
      req = (tls ? httpsRequest : httpRequest)(options);
    } catch (err) {
      finish({ type: 'error', error: err });
      return;
    }
    req.on('error', (err) => {
      const code = err && err.code ? String(err.code) : '';
      if (code === 'ECONNREFUSED') return finish({ type: 'refused' });
      if (code === 'ECONNRESET' || code === 'EPIPE') return finish({ type: 'reset' });
      if (code.startsWith('HPE_') || code.startsWith('ERR_SSL') || code === 'EPROTO' || /ssl|tls|handshake/i.test(err.message || ''))
        return finish({ type: 'garbage' });
      finish({ type: 'error', error: err });
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      const complete = () => {
        const body = Buffer.concat(chunks).subarray(0, PROBE_MAX_BYTES).toString('utf8');
        const contentType = (header(res.headers, 'content-type') || '').toLowerCase();
        let title = contentType && !contentType.includes('html') && !contentType.includes('xml') ? null : extractTitle(body);
        // An error page titled with its status phrase ("Unauthorized") → null, so the UI shows the process name.
        if (title && res.statusCode >= 400 && isStatusPhraseTitle(title)) title = null;
        let redirectsTo = null;
        const location = header(res.headers, 'location');
        if (location && res.statusCode >= 300 && res.statusCode < 400) {
          try {
            redirectsTo = new URL(location, `${tls ? 'https' : 'http'}://${hostHeader}/`).href;
          } catch {
            redirectsTo = location;
          }
        }
        finish({
          type: 'response',
          hint: res.statusCode === 400 && HTTPS_HINT.test(body),
          result: {
            status: res.statusCode,
            title,
            server: header(res.headers, 'server'),
            framework: detectFramework(res.headers, body, title),
            redirectsTo,
            tls,
          },
        });
      };
      onDeadline = complete; // streaming body: summarise what arrived
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= PROBE_MAX_BYTES) complete();
      });
      res.on('end', complete);
      res.on('error', complete);
      res.on('aborted', complete);
    });
    req.end();
  });
}

/**
 * probeHttp plus how to cache the outcome: `definitive` (an answer, or bytes that aren't
 * HTTP(S)), `timeout` (no answer in time, or reset on both plain and TLS), `refused`,
 * `aborted` (scan deadline) or `error`.
 */
async function probeHttpDetailed(port, { timeout = 1000, host = '127.0.0.1', signal, onAttempt } = {}) {
  const deadline = Date.now() + timeout;
  onAttempt?.({ port, host, tls: false });
  const plain = await attempt({ tls: false, host, port, timeout, signal });
  if (plain.type === 'response' && !plain.hint) return { result: plain.result, outcome: 'definitive' };
  if (plain.type === 'timeout' || plain.type === 'refused' || plain.type === 'aborted' || plain.type === 'error') {
    return { result: null, outcome: plain.type };
  }
  // reset, garbage, or a 400 saying "use HTTPS" → try TLS with the time left.
  const left = deadline - Date.now();
  if (left <= 0) {
    if (plain.type === 'response') return { result: plain.result, outcome: 'definitive' };
    return { result: null, outcome: 'timeout' };
  }
  onAttempt?.({ port, host, tls: true });
  const secure = await attempt({ tls: true, host, port, timeout: left, signal });
  if (secure.type === 'response') return { result: secure.result, outcome: 'definitive' };
  if (secure.type === 'aborted') return { result: null, outcome: 'aborted' };
  if (plain.type === 'response') return { result: plain.result, outcome: 'definitive' }; // the 400 itself
  if (secure.type === 'timeout') return { result: null, outcome: 'timeout' };
  if (plain.type === 'reset' && secure.type === 'reset') return { result: null, outcome: 'timeout' };
  if (secure.type === 'refused') return { result: null, outcome: 'refused' };
  return { result: null, outcome: 'definitive' }; // not HTTP, not HTTPS
}

/** host|port|pid → { at, ttl, result (frozen or null) }. Expired entries are kept as "last known". */
const probeCache = new Map();
const LAST_KNOWN_MAX_AGE = 10 * 60 * 1000;

/**
 * Empties the HTTP probe cache used by `scan()`.
 * @returns {void}
 */
export function clearProbeCache() {
  probeCache.clear();
}

const copyResult = (r) => (r ? { ...r } : null);
const cacheKey = (host, port, pid) => `${host}|${port}|${pid ?? '-'}`;

/**
 * Last cached value for a probe, even if expired (used at the scan deadline). When the
 * process is unknown (no pid or no name) the port may have changed hands, so entries older
 * than 10 min are ignored.
 */
function lastKnown(port, pid, host, { now = Date.now, unknownProcess = pid == null } = {}) {
  const hit = probeCache.get(cacheKey(host, port, pid));
  if (!hit) return null;
  if (unknownProcess && now() - hit.at > LAST_KNOWN_MAX_AGE) return null;
  return copyResult(hit.result);
}

async function cachedProbe(port, pid, host, { timeout, cacheTtl, timeoutCacheTtl, now, signal, unknownProcess, onAttempt }) {
  const key = cacheKey(host, port, pid);
  const hit = probeCache.get(key);
  if (hit && now() - hit.at < hit.ttl) return copyResult(hit.result);
  const r = await probeHttpDetailed(port, { timeout, host, signal, onAttempt });
  if (r.outcome === 'aborted') return lastKnown(port, pid, host, { now, unknownProcess });
  const ttl = r.outcome === 'definitive' ? cacheTtl : r.outcome === 'timeout' ? timeoutCacheTtl : 0;
  const at = now();
  if (ttl > 0) probeCache.set(key, { at, ttl, result: r.result ? Object.freeze({ ...r.result }) : null });
  if (probeCache.size > 2000) {
    for (const [k, v] of probeCache) if (at - v.at >= LAST_KNOWN_MAX_AGE) probeCache.delete(k);
  }
  return copyResult(r.result);
}

// ---------------------------------------------------------------------------
// Hidden services and names

/** Known OS services by process name (lowercase). */
const OS_SERVICES = new Set([
  // macOS
  'controlcenter', // AirPlay receiver, 5000/7000
  'rapportd',
  'mdnsresponder',
  'launchd',
  'sharingd',
  'mediasharingd',
  'airplayxpchelper',
  'remoted',
  'identityservicesd',
  // Windows
  'system',
  'lsass',
  'wininit',
  'services',
  'spoolsv',
  // Linux
  'systemd',
  'systemd-resolve',
  'systemd-resolved',
  'cupsd',
  'rpcbind',
  'avahi-daemon',
]);

/**
 * Says why a service should be hidden from the default Discover list, or `null`.
 * Reasons: `portless-proxy` (matched by port, F13), `nidum-dashboard`, `privileged-port`
 * (port < 1024 owned by root/SYSTEM or by an unknown user), `os-service` (known OS daemons,
 * Windows `svchost` RPC on 135).
 *
 * @param {{ port: number, process?: string | null, user?: string | null }} service
 * @param {{ proxyPort?: number | null, dashboardPort?: number | null }} [ports]
 * @returns {'portless-proxy' | 'nidum-dashboard' | 'privileged-port' | 'os-service' | null}
 */
export function isHidden(service, { proxyPort = null, dashboardPort = null } = {}) {
  if (!service) return null;
  const port = Number(service.port);
  if (proxyPort != null && port === Number(proxyPort)) return 'portless-proxy';
  if (dashboardPort != null && port === Number(dashboardPort)) return 'nidum-dashboard';
  const proc = (service.process || '').toLowerCase().replace(/\.exe$/, '');
  const user = (service.user || '').toLowerCase();
  if (OS_SERVICES.has(proc)) return 'os-service';
  if (proc === 'svchost' && port === 135) return 'os-service';
  if (port < 1024 && (user === 'root' || user === '0' || user === 'system' || user === 'nt authority\\system' || !service.process))
    return 'privileged-port';
  return null;
}

/** Latin letters that NFKD does not decompose into ASCII. */
const TRANSLITERATE = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ħ: 'h', ŧ: 't', ŋ: 'ng',
  ĸ: 'k', ſ: 's', ŀ: 'l', ĳ: 'ij',
};

/**
 * Turns text into a name: lowercase ASCII letters, digits and single dashes, ≤ 63 chars.
 * Accents are stripped (é → e) and common Latin letters transliterated (ß → ss).
 * @param {string} text
 * @returns {string} possibly empty
 */
function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþıħŧŋĸſŀĳ]/g, (c) => TRANSLITERATE[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

const GENERIC_DIRS = new Set(['src', 'dist', 'build', 'out', 'public', 'bin', 'www', 'tmp', 'temp']);
const SYSTEM_DIR_PREFIXES = ['/system/', '/usr/', '/bin/', '/sbin/', '/private/var/', '/private/etc/', '/var/', '/library/', '/opt/homebrew/', '/proc/', '/etc/', '/dev/'];

/** Folder name worth suggesting, or null for `/`, the home folder, system and app-bundle paths. */
function folderName(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const isWin = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.includes('\\');
  const p = isWin ? win32 : posix;
  const dir = cwd.replace(/[\\/]+$/, '');
  if (!dir || dir === '/' || /^[a-zA-Z]:$/.test(dir)) return null;
  const lower = `${dir.toLowerCase()}/`;
  let home = '';
  try {
    home = homedir().replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    /* no home */
  }
  if (home && lower === `${home}/`) return null;
  if ((home && lower.startsWith(`${home}/library/`)) || /^\/users\/[^/]+\/library\//.test(lower)) return null; // app data, not a project
  if (/^\/users\/[^/]+\/$|^\/home\/[^/]+\/$|^[a-z]:\\users\\[^\\]+\/$/i.test(lower)) return null;
  if (lower.includes('.app/') || SYSTEM_DIR_PREFIXES.some((pre) => lower.startsWith(pre))) return null;
  if (/^[a-z]:\\(windows|program files)/i.test(dir)) return null;
  const parent = p.dirname(dir);
  if (!parent || parent === dir || parent === '/' || /^[a-zA-Z]:\\?$/.test(parent)) return null; // top-level folder
  const name = p.basename(dir);
  if (GENERIC_DIRS.has(name.toLowerCase())) return folderName(parent);
  return name || null;
}

/**
 * Suggests an address name for a service: slug of the folder name, else the page
 * title, else the process name, else `app-<port>` (or `app`). Lowercase, dashes, ≤ 63.
 * Does **not** check Portless's reserved names (N3 runs `validateName` and appends `-app`).
 *
 * @param {{ cwd?: string | null, http?: { title?: string | null, status?: number } | null,
 *   process?: string | null, port?: number }} service
 * @returns {string}
 */
export function suggestName(service) {
  const s = service || {};
  const fromFolder = slugify(folderName(s.cwd));
  if (fromFolder) return fromFolder;
  if (s.http && s.http.title && !(s.http.status >= 400)) {
    const fromTitle = slugify(s.http.title);
    if (fromTitle) return fromTitle;
  }
  const proc = s.process ? String(s.process) : '';
  const fromProcess = slugify((proc.includes('\\') ? win32.basename(proc) : posix.basename(proc)).replace(/\.exe$/i, ''));
  if (fromProcess) return fromProcess;
  return Number.isInteger(s.port) ? `app-${s.port}` : 'app';
}

// ---------------------------------------------------------------------------
// Scan

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Scans this computer: lists listeners, reads cwd and command line, probes HTTP(S)
 * (concurrency 8), marks hidden services and suggests names. Never throws; problems are
 * reported in `errors`.
 *
 * Probe cache per host + port + pid: answers (and "not HTTP") 30 s, timeouts 15 s,
 * refused connections not cached. The whole scan has a 2.5 s deadline: probes still running
 * then are aborted, report their last cached `http` value (or `null`; for ports with an unknown
 * process, cached values older than 10 min are ignored), and are not cached.
 * Meant for N3's background loop only, never a request path.
 *
 * @param {{ proxyPort?: number | null, dashboardPort?: number | null, platform?: string,
 *   run?: typeof runCommand, procRoot?: string, probeTimeout?: number, cacheTtl?: number,
 *   timeoutCacheTtl?: number, scanDeadline?: number, now?: () => number,
 *   onAttempt?: (attempt: { port: number, host: string, tls: boolean }) => void,
 *   listeners?: () => Promise<Array<object>> }} [options] Everything after `dashboardPort`
 *   is for tests.
 * @returns {Promise<{ services: Array<{ port: number, pid: number | null, process: string | null,
 *   user: string | null, addresses: string[], reach: 'loopback' | 'network', cwd: string | null,
 *   command: string | null, http: HttpInfo | null,
 *   hidden: 'portless-proxy' | 'nidum-dashboard' | 'privileged-port' | 'os-service' | null,
 *   suggestedName: string }>, scannedAt: string, errors: string[] }>}
 */
export async function scan(options = {}) {
  const errors = [];
  let services = [];
  let deadlineTimer = null;
  try {
    const {
      proxyPort = null,
      dashboardPort = null,
      platform = process.platform,
      run = runCommand,
      procRoot = '/proc',
      probeTimeout = 1000,
      cacheTtl = PROBE_CACHE_TTL,
      timeoutCacheTtl = PROBE_TIMEOUT_CACHE_TTL,
      scanDeadline = SCAN_DEADLINE,
      now = Date.now,
      onAttempt = null,
    } = options;
    const controller = new AbortController();
    deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, scanDeadline));
    const sys = { platform, run, procRoot };
    let listeners = [];
    try {
      listeners = options.listeners ? await options.listeners() : await listListeners(sys);
    } catch (err) {
      errors.push(`Couldn't read open ports: ${err && err.message ? err.message : String(err)}`);
    }
    const pids = listeners.map((l) => l.pid).filter(validPid);
    const [cwds, commands] = await Promise.all([
      getCwds(pids, sys).catch((err) => {
        errors.push(`Couldn't read folders: ${err.message}`);
        return new Map();
      }),
      getCommands(pids, sys).catch((err) => {
        errors.push(`Couldn't read command lines: ${err.message}`);
        return new Map();
      }),
    ]);
    const probeOptions = { timeout: probeTimeout, cacheTtl, timeoutCacheTtl, now, signal: controller.signal, onAttempt };
    const probes = await mapLimit(listeners, SCAN_CONCURRENCY, async (l) => {
      const host = probeHostFor(l.addresses);
      const unknownProcess = l.pid == null || !l.process;
      try {
        return await cachedProbe(l.port, l.pid, host, { ...probeOptions, unknownProcess });
      } catch (err) {
        errors.push(`Probe of port ${l.port} failed: ${err.message}`);
        return lastKnown(l.port, l.pid, host, { now, unknownProcess });
      }
    });
    services = listeners.map((l, i) => {
      const addresses = Array.isArray(l.addresses) ? [...l.addresses] : [];
      const service = {
        port: l.port,
        pid: l.pid ?? null,
        process: l.process ?? null,
        user: l.user ?? null,
        addresses,
        reach: l.reach === 'loopback' || l.reach === 'network' ? l.reach : reachOf(addresses),
        cwd: (l.pid != null && cwds.get(l.pid)) || null,
        command: (l.pid != null && commands.get(l.pid)) || null,
        http: probes[i] ?? null,
        hidden: null,
        suggestedName: '',
      };
      service.hidden = isHidden(service, { proxyPort, dashboardPort });
      service.suggestedName = suggestName(service);
      return service;
    });
    services.sort((a, b) => a.port - b.port || (a.pid ?? -1) - (b.pid ?? -1));
  } catch (err) {
    errors.push(`Scan failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(deadlineTimer);
  }
  return { services, scannedAt: new Date().toISOString(), errors };
}

/**
 * Internal helpers exposed for tests only; not part of the public contract and may change.
 * @type {{ parseLsofCwd: Function, parsePsCommands: Function, probeHostFor: (addresses: string[]) => string,
 *   reachOf: (addresses: string[]) => 'loopback' | 'network', slugify: (text: string) => string,
 *   folderName: (cwd: string | null) => string | null, isStatusPhraseTitle: (title: string) => boolean }}
 */
export const _internal = { parseLsofCwd, parsePsCommands, probeHostFor, reachOf, slugify, folderName, isStatusPhraseTitle };
