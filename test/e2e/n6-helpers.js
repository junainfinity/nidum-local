// Shared helpers for the N6 end-to-end scenarios (scenario-a/b/c.test.js).
// Not a test file itself (the e2e glob only picks *.test.js).
//
// Safety (docs/Nidum Local/Plan/Engineering graph.md, "Ground rules"):
// - every server gets a temp NIDUM_HOME; real-state runs add NIDUM_READ_ONLY=1;
// - every child process has a timeout and is killed in cleanup, also on failure;
// - the launcher only ever runs with a PATH whose `open`/`xdg-open` is a recording stub and
//   whose `portless` is a recording passthrough that refuses anything but read-only commands.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Vault folder for evidence; written only with NIDUM_E2E_SAVE_ASSETS=1 (N6 validation 1 F3). */
export const VAULT_ASSET_DIR = join(ROOT, 'docs', 'Nidum Local', 'Reports', 'assets', 'N6');
export const SAVE_ASSETS = process.env.NIDUM_E2E_SAVE_ASSETS === '1';
export const E2E = process.env.NIDUM_E2E === '1';
export const REAL = process.env.NIDUM_E2E_REAL === '1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- guard

/** `npm run guard:check` equivalent. Resolves { ok, output }. */
export function guardCheck() {
  return new Promise((resolve) => {
    execFile(process.execPath, ['test/helpers/guard.js', 'check', 'docs/guard-baseline.json'], { cwd: ROOT, timeout: 30_000 }, (err, so, se) => {
      resolve({ ok: !err, output: `${so}${se}`.trim() });
    });
  });
}

export async function assertGuard(label) {
  const g = await guardCheck();
  assert.ok(g.ok, `guard ${label}: ${g.output}`);
  return g.output;
}

// ---------------------------------------------------------------- env

/** process.env without any PORTLESS_* / NIDUM_* variable (so nothing leaks into a scenario). */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('PORTLESS_') || k.startsWith('NIDUM_')) continue;
    env[k] = v;
  }
  return { ...env, NO_COLOR: '1', ...extra };
}

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

// ---------------------------------------------------------------- HTTP

/**
 * Small http.request wrapper (no fetch: full control over headers, no Sec-Fetch-*).
 * @returns {Promise<{ status: number, headers: object, body: string, json: any }>}
 */
export function request(url, { method = 'GET', headers = {}, body, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method,
      headers: { ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
      timeout,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request ${method} ${url} timed out`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** Authenticated /api call with X-Nidum-Token. Mutations always send JSON (E8). */
export function api(server, method, path, body) {
  const mutation = method !== 'GET' && method !== 'HEAD';
  return request(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { 'x-nidum-token': server.token },
    body: mutation ? body ?? {} : undefined,
  });
}

export async function health(port) {
  try {
    const r = await request(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 });
    return r.status === 200 ? r.json : null;
  } catch {
    return null;
  }
}

export async function waitUntil(fn, { timeout = 15_000, interval = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(interval);
  }
}

export function readSession(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- server

/**
 * Start `node src/server.js` as a child with `env` (must carry NIDUM_HOME).
 * Resolves once session.json names this child's pid and /api/health answers for it.
 */
export async function startServerProcess(env, { timeout = 20_000 } = {}) {
  assert.ok(env.NIDUM_HOME, 'NIDUM_HOME is required');
  const proc = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => { if (output.length < 20_000) output += d; });
  proc.stderr.on('data', (d) => { if (output.length < 20_000) output += d; });
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), 15 * 60_000);
  killTimer.unref();
  exited.then(() => clearTimeout(killTimer));
  let session;
  try {
    session = await waitUntil(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited early: ${output}`);
      const s = readSession(env.NIDUM_HOME);
      if (!s || s.pid !== proc.pid) return null;
      const h = await health(s.port);
      return h && h.pid === proc.pid ? s : null;
    }, { timeout, what: 'server session' });
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`${err.message}\n${output}`);
  }
  return {
    proc,
    pid: proc.pid,
    port: session.port,
    token: session.token,
    home: env.NIDUM_HOME,
    url: `http://127.0.0.1:${session.port}/`,
    tokenUrl: `http://127.0.0.1:${session.port}/?t=${session.token}`,
    exited,
    output: () => output,
    /** SIGTERM, then SIGKILL after 5 s. Never throws. */
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) proc.kill('SIGKILL');
    },
  };
}

/** Wait for `/api/state` to have a proxy and a good route read (E1). */
export function waitForState(server, pred = () => true, { timeout = 20_000, what = 'state' } = {}) {
  return waitUntil(async () => {
    const r = await api(server, 'GET', '/api/state');
    if (r.status !== 200 || !r.json || !r.json.proxy || r.json.routesUnavailable) return null;
    return pred(r.json) ? r.json : null;
  }, { timeout, what });
}

// ---------------------------------------------------------------- launcher stubs

/** Absolute path of a command on the current PATH (skipping `skipDir`). */
export function which(cmd, skipDir) {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir || dir === skipDir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * A stub bin dir (mode 700) put first on PATH for the launcher:
 * - `open` / `xdg-open`: append their arguments to rec/open.log (mode 600), exit 0; `open` also
 *   keeps each call's exact argv (`openedArgv()`), so nothing is ever really opened or launched;
 * - `sudo` / `osascript`: append to rec/<name>.log, exit 1 (never elevate);
 * - `portless`: append argv to rec/portless.log; passes through to the real Portless only for
 *   --version, -v, --help, -h, list, doctor, get <name>; anything else is recorded in
 *   rec/portless-refused.log and refused with exit 97.
 * With `menu: true` also `pgrep` / `ps` (record, find nothing, exit 1) and `swiftc` (records,
 * exit 1), for the launcher's menu bar step. With `node: <path>`, a `node` symlink comes first.
 */
export function makeStubBin({ menu = false, node = null } = {}) {
  const dir = tempDir('nidum-n6-bin-');
  const rec = join(dir, 'rec');
  mkdirSync(rec, { mode: 0o700 });
  const realPortless = which('portless', dir);
  assert.ok(realPortless, 'portless is on PATH');
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const write = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  };
  const recorder = (name, code) => `umask 077\nprintf '%s\\n' "$*" >> ${q(join(rec, `${name}.log`))}\nexit ${code}`;
  // `open` also keeps each call's exact argv (unit separator between arguments, record separator
  // after each call), so arguments with spaces can be compared one by one.
  const argvRecorder = `printf '%s\\037' "$@" >> ${q(join(rec, 'open-argv.log'))}\nprintf '\\036' >> ${q(join(rec, 'open-argv.log'))}`;
  write('open', `umask 077\n${argvRecorder}\n${recorder('open', 0)}`);
  write('xdg-open', recorder('open', 0));
  if (menu) {
    // The launcher's menu bar step (N5 iteration 4–7): nothing of this user is running (pgrep finds
    // nothing), ps never answers, and no Swift compiler may run (a build must never happen here).
    write('pgrep', recorder('pgrep', 1));
    write('ps', recorder('ps', 1));
    write('swiftc', recorder('swiftc', 1));
  }
  // A fixed `node` first on PATH, so the launcher's choice (passed on as --node) is known exactly.
  if (node) symlinkSync(node, join(dir, 'node'));
  write('sudo', recorder('sudo', 1));
  write('osascript', recorder('osascript', 1));
  write('portless', [
    'umask 077',
    `printf '%s\\n' "$*" >> ${q(join(rec, 'portless.log'))}`,
    'case "$1" in',
    `  --version|-v|--help|-h|list|doctor) exec ${q(realPortless)} "$@" ;;`,
    `  get) [ $# -eq 2 ] && exec ${q(realPortless)} "$@" ;;`,
    'esac',
    `printf '%s\\n' "$*" >> ${q(join(rec, 'portless-refused.log'))}`,
    'echo "N6 stub: refused portless $*" >&2',
    'exit 97',
  ].join('\n'));
  const read = (name) => {
    try {
      return readFileSync(join(rec, `${name}.log`), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    dir,
    realPortless,
    path: `${dir}${delimiter}${process.env.PATH}`,
    opened: () => read('open'),
    /** Every `open` call as its exact argv array. */
    openedArgv: () => {
      let raw = '';
      try {
        raw = readFileSync(join(rec, 'open-argv.log'), 'utf8');
      } catch {
        return [];
      }
      return raw.split('\x1e').filter((c) => c !== '').map((c) => c.split('\x1f').slice(0, -1));
    },
    pgrep: () => read('pgrep'),
    ps: () => read('ps'),
    swiftc: () => read('swiftc'),
    portless: () => read('portless'),
    refused: () => read('portless-refused'),
    sudo: () => read('sudo'),
    osascript: () => read('osascript'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run `Nidum Local.command` with /bin/bash, stdin closed (every consent prompt answers No).
 * @returns {Promise<{ code: number | null, signal: string | null, output: string }>}
 */
export function runLauncher(env, { timeout = 90_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', [join(ROOT, 'Nidum Local.command')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
    let output = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });
    proc.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

export const TOKEN_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})$/;

// ---------------------------------------------------------------- page helpers (chrome.js pages)

export async function openDashboard(browser, tokenUrl, { width = 1440, height = 900, colorScheme = 'light', theme = null } = {}) {
  const page = await browser.newPage({ width, height });
  await page.emulate({ colorScheme, reducedMotion: 'reduce' });
  await page.goto(tokenUrl);
  if (theme) {
    await page.evaluate((t) => localStorage.setItem('nidum-theme', t), theme);
    await page.reload();
  }
  await page.waitFor(() => document.querySelector('[data-section]') && document.querySelector('#tab-addresses .nav-count'), { what: 'dashboard loaded', timeout: 20_000 });
  await page.waitFor(() => !document.querySelector('.pill .spin'), { what: 'live connection', timeout: 20_000 });
  return page;
}

export async function goTab(page, tab) {
  await page.evaluate((t) => { location.hash = t; }, tab);
  await page.waitFor((t) => document.querySelector(`[data-section="${t}"]`), { args: [tab], what: `tab ${tab}` });
}

/**
 * Visible text only. Since N4 iteration 5 every address in text has a visually hidden full copy
 * for screen readers (`.addr-sr`), so innerText would show it twice: hide those copies while
 * reading (same approach as N4's ui.test.js), then restore the page.
 */
const READ_VISIBLE = `(sel, all) => {
  const st = document.createElement('style');
  st.textContent = '.addr-sr{display:none!important}';
  document.head.appendChild(st);
  try {
    const norm = (e) => e.innerText.replace(/\\s+/g, ' ').trim();
    if (all) return [...document.querySelectorAll(sel)].map(norm);
    const el = document.querySelector(sel);
    return el ? norm(el) : null;
  } finally {
    st.remove();
  }
}`;
export const visibleTexts = (page, sel) => page.evaluate(`(${READ_VISIBLE})(${JSON.stringify(sel)}, true)`);
export const text = (page, sel) => page.evaluate(`(${READ_VISIBLE})(${JSON.stringify(sel)}, false)`);
export const exists = (page, sel) => page.evaluate((s) => Boolean(document.querySelector(s)), sel);
export const waitSel = (page, sel, timeout = 15_000) => page.waitFor((s) => document.querySelector(s), { args: [sel], timeout, what: sel });
export const waitGone = (page, sel, timeout = 15_000) => page.waitFor((s) => !document.querySelector(s), { args: [sel], timeout, what: `no ${sel}` });
export const waitText = (page, sel, needle, timeout = 15_000) =>
  page.waitFor(`(${READ_VISIBLE})(${JSON.stringify(sel)}, true).some((t) => t.includes(${JSON.stringify(needle)}))`, { timeout, what: `${sel} ~ ${needle}` });
export const toastText = (page, needle, timeout = 15_000) => waitText(page, '.toast', needle, timeout);

/** Click the first element matching `sel` whose text includes `label`. */
export async function clickText(page, sel, label) {
  const texts = await visibleTexts(page, sel);
  const idx = texts.findIndex((t) => t.includes(label));
  const ok = idx >= 0 && await page.evaluate((s, i) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return false;
    el.setAttribute('data-n6-click', '1');
    return true;
  }, sel, idx);
  assert.ok(ok, `no ${sel} with text ${label}`);
  await page.click('[data-n6-click="1"]');
  await page.evaluate(() => document.querySelector('[data-n6-click]')?.removeAttribute('data-n6-click'));
}

export async function fill(page, sel, value) {
  await page.evaluate((s) => { const el = document.querySelector(s); el.focus(); el.select?.(); }, sel);
  await page.key('Backspace');
  if (value) await page.insertText(value);
}

/** Address row in Your addresses (table or card layout: same element, D30/D35). */
export const addrRow = (url) => `.addr-section [data-row-url="${url}"]`;

let assetTmp = null;
/** Per-process temp folder for screenshots and other evidence (removed when the process exits). */
export function assetDir() {
  if (!assetTmp) {
    assetTmp = tempDir('nidum-n6-assets-');
    const dir = assetTmp;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return assetTmp;
}

/**
 * Write an evidence file (PNG, text) to the temp asset folder; with NIDUM_E2E_SAVE_ASSETS=1 also
 * copy it into docs/Nidum Local/Reports/assets/N6/, so ordinary runs never rewrite vault evidence.
 * @returns {string} the path written in the temp folder
 */
export function saveAsset(name, data) {
  const file = join(assetDir(), name);
  writeFileSync(file, data);
  if (SAVE_ASSETS) {
    mkdirSync(VAULT_ASSET_DIR, { recursive: true });
    copyFileSync(file, join(VAULT_ASSET_DIR, name));
  }
  return file;
}

export const saveShot = saveAsset;

/** Console errors other than deliberate 4xx answers from /api (read-only probes). */
export function unexpectedErrors(page, { allowApi = false } = {}) {
  return page.errors.filter((e) => !(allowApi && /^log\[network\]: Failed to load resource/.test(e) && /\/api\//.test(e)));
}

export function offOrigin(page, base) {
  const origin = base.replace(/\/$/, '');
  return page.requests.filter((u) => u && !u.startsWith(`${origin}/`) && u !== origin && !u.startsWith('data:') && !u.startsWith('blob:') && u !== 'about:blank');
}
