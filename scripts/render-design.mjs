#!/usr/bin/env node
// Renders the raw design templates in design/*.html into static reference
// screenshots and a geometry file for N4's validator.
//
//   node scripts/render-design.mjs
//
// Output (all inside design/reference/):
//   light-<tab>.png, dark-<tab>.png   one per sidebar tab, 1440x900
//   tokens.png, popovers.png          board sizes (1440x1040, 1440x1060)
//   geometry.json                     CDP measurements of the light renders
//   README.md                         file list and self-check results
//
// Zero dependencies. Uses headless Chrome (CHROME_PATH overrides the default
// macOS location) and Node's global WebSocket (Node >= 22) for CDP.
// Everything temporary lives in one mkdtemp dir that is removed at the end.
// Every Chrome is stopped (CDP Browser.close, SIGKILL fallback) and the temp dir
// removed on success, error, watchdog (90 s, NIDUM_RENDER_WATCHDOG_MS) and
// SIGINT/SIGTERM/SIGHUP/SIGQUIT/SIGALRM (e.g. `perl -e 'alarm N; exec @ARGV'`);
// each Chrome is its own process group and is killed as one. SIGKILL (`kill -9`)
// cannot be caught: it leaves the Chromes (own process groups) and the temp dir
// behind. To stop a run, send SIGTERM/SIGINT/SIGHUP, not SIGKILL.
// NIDUM_RENDER_FAULT=screenshot|in-cdp|after-cdp|hang-screenshot|hang-after-cdp|
// signal-at-screenshot-exit injects a failure to prove it (see README).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');
const OUT = path.join(DESIGN, 'reference');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TABS = ['discover', 'add', 'addresses', 'sharing', 'tools', 'advanced'];
const TAB_TITLES = {
  discover: 'Discover', add: 'Add manually', addresses: 'Your addresses',
  sharing: 'Network sharing', tools: 'Tools', advanced: 'Advanced',
};
const SCREENSHOT_TIMEOUT_MS = 60_000;
const WATCHDOG_MS = Number(process.env.NIDUM_RENDER_WATCHDOG_MS) || 90_000; // a clean run takes ~8 s
const TOKEN_NAMES = [
  'bg', 'surface', 'surface-2', 'border', 'border-strong', 'border-input', 'text', 'text-2', 'text-3',
  'accent', 'on-accent', 'link', 'amber', 'accent-weak', 'focus', 'nav-icon', 'live', 'waiting', 'error',
  'on-error', 'neutral', 'knob-on', 'knob-off', 'shadow-1', 'shadow-2',
];

// ---------------------------------------------------------------------------
// Template -> static HTML
// ---------------------------------------------------------------------------

function lookup(expr, ctx) {
  const e = expr.trim();
  if (e === 'true') return true;
  if (e === 'false') return false;
  let v = ctx;
  for (const part of e.split('.')) {
    if (v == null || !(part in Object(v))) throw new Error(`unresolved placeholder {{${e}}}`);
    v = v[part];
  }
  if (typeof v === 'function') throw new Error(`placeholder {{${e}}} is a handler, not a value`);
  return v;
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function placeholderExpr(value) {
  const m = /^\s*\{\{([^}]*)\}\}\s*$/.exec(value || '');
  if (!m) throw new Error(`expected a {{placeholder}}, got ${JSON.stringify(value)}`);
  return m[1];
}

// Replace every outermost <tag ...>inner</tag> block, honouring nesting.
function replaceBlocks(html, tag, fn) {
  const re = new RegExp(`<(/?)${tag}\\b([^>]*)>`, 'g');
  let out = '', last = 0, depth = 0, openStart = 0, openEnd = 0, openAttrs = '';
  for (let m; (m = re.exec(html));) {
    if (!m[1]) {
      if (depth === 0) { openStart = m.index; openEnd = re.lastIndex; openAttrs = m[2]; }
      depth++;
    } else {
      if (depth === 0) throw new Error(`stray </${tag}>`);
      depth--;
      if (depth === 0) {
        out += html.slice(last, openStart) + fn(openAttrs, html.slice(openEnd, m.index));
        last = re.lastIndex;
      }
    }
  }
  if (depth !== 0) throw new Error(`unclosed <${tag}>`);
  return out + html.slice(last);
}

function expand(html, ctx) {
  // <sc-for list="{{x}}" as="m">tpl</sc-for> -> tpl repeated per item
  html = replaceBlocks(html, 'sc-for', (attrs, inner) => {
    const list = lookup(placeholderExpr(attr(attrs, 'list')), ctx);
    const as = attr(attrs, 'as');
    if (!Array.isArray(list) || !as) throw new Error('bad <sc-for>');
    return list.map((item) => expand(inner, { ...ctx, [as]: item })).join('');
  });
  // <sc-if value="{{x}}">inner</sc-if> -> inner when truthy, nothing otherwise (no wrapper)
  html = replaceBlocks(html, 'sc-if', (attrs, inner) =>
    lookup(placeholderExpr(attr(attrs, 'value')), ctx) ? expand(inner, ctx) : '');
  // Event handlers have no static meaning.
  html = html.replace(/\s+sc-camel-on-[a-z-]+="[^"]*"/g, '');
  // Remaining placeholders are plain values.
  return html.replace(/\{\{([^}]*)\}\}/g, (_, e) => String(lookup(e, ctx)));
}

function parseTemplate(file) {
  const src = fs.readFileSync(file, 'utf8');
  const script = /<script type="text\/x-dc"([^>]*)>([\s\S]*?)<\/script>/.exec(src);
  let width = 1440, height = 900;
  if (script) {
    const props = attr(script[1], 'data-props');
    if (props) {
      const p = JSON.parse(props.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      if (p.$preview) ({ width, height } = p.$preview);
    }
  }
  return { src, width, height };
}

function toStatic(src, ctx) {
  let html = src
    .replace(/<script src="[0-9a-f-]{36}"><\/script>\s*/, '') // design runtime
    .replace(/<script type="text\/x-dc"[\s\S]*?<\/script>\s*/, ''); // DCLogic class
  const helmet = /<helmet>([\s\S]*?)<\/helmet>\s*/.exec(html);
  if (!helmet) throw new Error('no <helmet> block');
  html = html.replace(helmet[0], '').replace('</head>', `${helmet[1].trim()}\n</head>`);
  html = html.replace(/<\/?x-dc>\s*/g, '');
  html = expand(html, ctx);
  html = html
    .replace(/<(\/?)sc-raw-([a-z]+)\b/g, '<$1$2')
    .replace(/\bsc-camel-([a-z-]+)=/g, (_, n) => `${n.replace(/-([a-z])/g, (__, c) => c.toUpperCase())}=`);
  const leftover = /<\/?sc-[a-z-]+|sc-camel-|\{\{|<\/?helmet|<\/?x-dc|text\/x-dc/.exec(html);
  if (leftover) throw new Error(`runtime syntax left after rewrite: ${leftover[0]}`);
  const svgs = (html.match(/<svg\b[^>]*>/g) || []);
  const bare = svgs.filter((s) => !/\bviewBox="/.test(s)).length;
  if (bare) throw new Error(`${bare} <svg> without viewBox`);
  return html;
}

function dashboardCtx(tab) {
  const sel = {}, show = {};
  for (const id of TABS) { sel[id] = id === tab; show[id] = id === tab; }
  return {
    sel, show, activeTabId: `tab-${tab}`,
    collapsed: false, expanded: true, collapsedAttr: 'false', collapseLabel: 'Collapse sidebar',
  };
}

// Verbatim port of the popovers board's DCLogic.renderVals (fake QR pattern),
// same float arithmetic, so the board matches what the design runtime showed.
function fakeQr() {
  var N = 25, s = 20261015, qr = [];
  function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
  var finders = [[0, 0], [0, 18], [18, 0]];
  for (var r = 0; r < N; r++) {
    for (var c = 0; c < N; c++) {
      var d = null;
      for (var i = 0; i < 3; i++) {
        var R = finders[i][0], C = finders[i][1];
        if (r >= R && r < R + 7 && c >= C && c < C + 7) {
          var rr = r - R, cc = c - C;
          d = rr === 0 || rr === 6 || cc === 0 || cc === 6 || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
        }
      }
      if (d === null) {
        if ((r < 8 && c < 8) || (r < 8 && c >= 17) || (r >= 17 && c < 8)) d = false;
        else if (Math.abs(r - 18) <= 2 && Math.abs(c - 18) <= 2) d = Math.max(Math.abs(r - 18), Math.abs(c - 18)) !== 1;
        else if (r === 6) d = c % 2 === 0;
        else if (c === 6) d = r % 2 === 0;
        else d = rnd() < 0.5;
      }
      qr.push({ c: d ? '#000000' : '#FFFFFF' });
    }
  }
  return qr;
}

// ---------------------------------------------------------------------------
// PNG reading (for self-checks)
// ---------------------------------------------------------------------------

function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type];
  if (depth !== 8 || !bpp || interlace) return { width, height, pixel: null };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y ? px[dst - stride + x] : 0;
      const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 0xff;
    }
  }
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return {
    width, height,
    pixel(x, y) { const i = Math.round(y) * stride + Math.round(x) * bpp; return `#${hex(px[i])}${hex(px[i + 1])}${hex(px[i + 2])}`; },
  };
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

// Chrome lifecycle. Invariants:
// - Each Chrome runs in its own process group (detached), so helpers die with it.
// - A Chrome stays in `liveChromes` until its whole group is confirmed gone.
// - `shuttingDown` is set synchronously when cleanup starts; from then on
//   `launchChrome` throws and `main` stops at its next checkpoint, so no Chrome
//   can be started after cleanup has begun. cleanup() loops until the set is
//   empty (bounded by CLEANUP_DEADLINE_MS) and only then removes the temp dir.
const liveChromes = new Set();
const CLEANUP_DEADLINE_MS = 30_000;
let shuttingDown = false;
let shutdownExitCode = null;
let tmpDir = null;
let cleanupPromise = null;

class ShutdownError extends Error {
  constructor(where) { super(`shutdown in progress; refused to continue at ${where}`); this.name = 'ShutdownError'; }
}
function checkpoint(where) {
  if (!shuttingDown) return;
  const err = new ShutdownError(where);
  console.error(`render-design: ${err.message}`); // logged here: the shutdown handler may exit before main() reports
  throw err;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exited(proc) { return proc.exitCode !== null || proc.signalCode !== null || !!proc.spawnError; }

function waitExit(proc, ms) {
  return new Promise((res) => {
    if (exited(proc)) return res(true);
    const t = setTimeout(() => res(false), ms);
    const done = () => { clearTimeout(t); res(true); };
    proc.once('exit', done);
    proc.once('error', done);
  });
}

function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// SIGKILL the Chrome's whole process group and wait until it is gone. Only then
// is the Chrome dropped from `liveChromes` (the pgid cannot be reused while the
// group exists, so this never signals an unrelated group).
async function killGroup(proc, ms = 5_000) {
  if (!proc.pid) { liveChromes.delete(proc); return true; }
  const end = Date.now() + ms;
  while (groupAlive(proc.pid)) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    if (Date.now() > end) { console.error(`render-design: Chrome process group ${proc.pid} still alive after ${ms} ms`); return false; }
    await sleep(25);
  }
  liveChromes.delete(proc);
  return true;
}

// Chrome keeps its singleton socket in $TMPDIR/com.google.Chrome.XXXXXX and links
// it from the profile (SingletonSocket/SingletonCookie). A Chrome that is killed,
// even mid-shutdown after it removed the links, leaves that dir behind. So each
// Chrome's dir is recorded while it runs, and cleanup() removes recorded dirs.
const singletonDirs = new Set();

// The singleton dir a profile link names, or null unless it is a
// com.google.Chrome.<alnum> dir directly inside the system temp dir.
function singletonDirOf(linkPath) {
  let target, sysTmp, parent;
  try { target = fs.readlinkSync(linkPath); } catch { return null; }
  const dir = path.dirname(path.resolve(path.dirname(linkPath), target)); // relative targets resolve against the profile
  if (!/^com\.google\.Chrome\.[A-Za-z0-9]+$/.test(path.basename(dir))) return null;
  try { sysTmp = fs.realpathSync(os.tmpdir()); parent = fs.realpathSync(path.dirname(dir)); } catch { return null; }
  return parent === sysTmp ? dir : null;
}

function recordSingleton(profileDir) {
  for (const link of ['SingletonSocket', 'SingletonCookie']) {
    const dir = singletonDirOf(path.join(profileDir, link));
    if (dir) { singletonDirs.add(dir); return true; }
  }
  return false;
}

function launchChrome(args, { profileDir, pngFile } = {}) {
  checkpoint('launchChrome');
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  proc.pngFile = pngFile;
  proc.stderrText = '';
  proc.stderr.on('data', (d) => { if (proc.stderrText.length < 4000) proc.stderrText += d; });
  proc.once('error', (e) => { proc.spawnError = e; });
  if (profileDir) {
    // Chrome creates its singleton links within ~100 ms of starting; poll until seen.
    const poll = setInterval(() => { if (recordSingleton(profileDir)) clearInterval(poll); }, 20);
    poll.unref();
    proc.once('exit', () => clearInterval(poll));
  }
  liveChromes.add(proc);
  return proc;
}

// Last sweep for links still present at cleanup time, then every recorded dir.
// Only called once every Chrome group is gone.
function removeSingletonDirs(tmp) {
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('profile-')) recordSingleton(path.join(tmp, entry.name));
  }
  for (const dir of singletonDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

// Idempotent and never throws. Stops every Chrome (re-snapshotting until none
// is left), then removes the temp dir. Errors are logged so the original error
// stays the one reported.
function cleanup() {
  shuttingDown = true; // synchronously, before anything can await
  cleanupPromise ??= (async () => {
    const deadline = Date.now() + CLEANUP_DEADLINE_MS;
    while (liveChromes.size && Date.now() < deadline) {
      for (const proc of [...liveChromes]) {
        // A screenshot Chrome that already wrote its PNG is about to exit; let it
        // (and so remove its own singleton dir) rather than kill it mid-shutdown.
        if (proc.pngFile && !exited(proc) && fs.existsSync(proc.pngFile)) await waitExit(proc, 300);
        try { if (proc.gracefulClose && !exited(proc)) await proc.gracefulClose(); }
        catch (e) { console.error(`render-design: closing Chrome pid ${proc.pid}: ${e.message}`); }
        await killGroup(proc);
      }
    }
    if (liveChromes.size) console.error(`render-design: Chrome groups still alive after ${CLEANUP_DEADLINE_MS} ms: ${[...liveChromes].map((p) => p.pid).join(', ')}`);
    if (!tmpDir) return;
    try { removeSingletonDirs(tmpDir); } catch (e) { console.error(`render-design: Chrome singleton cleanup: ${e.message}`); }
    for (let attempt = 1; ; attempt++) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); break; }
      catch (e) {
        if (attempt >= 2) { console.error(`render-design: could not remove ${tmpDir}: ${e.message}`); break; }
        await sleep(500);
      }
    }
  })();
  return cleanupPromise;
}

// Signal handlers and the watchdog: first reason wins the exit code.
function shutdown(reason, code) {
  if (shutdownExitCode === null) shutdownExitCode = code;
  console.error(`render-design: ${reason}; stopping Chrome and removing the temp dir`);
  cleanup().then(() => process.exit(shutdownExitCode));
}

const FAULT = process.env.NIDUM_RENDER_FAULT || '';
const FAULT_SHOT = Number(process.env.NIDUM_RENDER_FAULT_SHOT) || 14;
const FAULTS = ['screenshot', 'in-cdp', 'after-cdp', 'hang-screenshot', 'hang-after-cdp', 'signal-at-screenshot-exit'];
async function fault(point) {
  if (FAULT === point) throw new Error(`injected fault "${point}" (NIDUM_RENDER_FAULT)`);
  if (FAULT === `hang-${point}`) { console.error(`render-design: injected hang "${FAULT}", waiting for the watchdog or a signal`); await new Promise(() => {}); }
}

let shotCount = 0;
async function screenshot(htmlFile, pngFile, width, height, profileDir) {
  const proc = launchChrome([
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`, `--screenshot=${pngFile}`, pathToFileURL(htmlFile).href,
  ], { profileDir, pngFile });
  shotCount++;
  await fault('screenshot'); // a Chrome is running here; cleanup() must stop it
  if (FAULT === 'signal-at-screenshot-exit' && shotCount === FAULT_SHOT) {
    // Deterministic race: Chrome has written the PNG but not exited yet (the
    // ~50 ms window). The SIGTERM handler runs now, so cleanup() starts while
    // this Chrome is alive; we then carry on and return normally, exactly as
    // when a real signal lands there. main() must not start another Chrome.
    while (!fs.existsSync(pngFile) && !exited(proc)) await sleep(5);
    console.error(`render-design: injected SIGTERM after screenshot ${shotCount} wrote its PNG (NIDUM_RENDER_FAULT)`);
    process.emit('SIGTERM', 'SIGTERM');
  }
  const ok = await waitExit(proc, SCREENSHOT_TIMEOUT_MS);
  await killGroup(proc); // reap lingering helpers before the next step
  if (!ok) throw new Error(`screenshot of ${path.basename(htmlFile)} timed out after ${SCREENSHOT_TIMEOUT_MS / 1000} s`);
  if (proc.spawnError || !fs.existsSync(pngFile)) {
    throw new Error(`screenshot failed for ${path.basename(htmlFile)}: ${proc.spawnError?.message || `exit ${proc.exitCode}: ${proc.stderrText}`}`);
  }
}

async function openSocket(url, ms) {
  const ws = new WebSocket(url);
  try {
    await withTimeout(new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`CDP websocket ${url} failed`));
    }), ms, 'CDP websocket open');
  } catch (e) { try { ws.close(); } catch {} throw e; }
  return ws;
}

async function startCdp(profileDir) {
  const proc = launchChrome([
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { profileDir });
  let ws = null;
  try {
    await fault('in-cdp');
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    let lines;
    for (;;) {
      checkpoint('CDP startup');
      if (exited(proc)) throw new Error(`CDP Chrome exited early: ${proc.spawnError?.message || proc.stderrText}`);
      lines = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : [];
      if (lines.length >= 2 && lines[1].trim()) break;
      if (Date.now() > deadline) throw new Error('Chrome did not write DevToolsActivePort within 20 s');
      await sleep(100);
    }
    const port = lines[0].trim();
    const browserWsUrl = `ws://127.0.0.1:${port}${lines[1].trim()}`;
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
    const page = (await res.json()).find((t) => t.type === 'page');
    if (!page) throw new Error('CDP: no page target');
    ws = await openSocket(page.webSocketDebuggerUrl, 10_000);
    let nextId = 1;
    const pending = new Map(), waiters = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      } else if (msg.method) {
        for (const w of waiters.splice(0)) {
          if (w.method === msg.method) { clearTimeout(w.timer); w.res(); } else waiters.push(w);
        }
      }
    };
    const send = (method, params = {}) => new Promise((ok, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP ${method} timed out`)); }, 20_000);
      pending.set(id, { res: ok, rej, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const waitFor = (method) => new Promise((ok, rej) => {
      const w = { method, res: ok };
      w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`timeout waiting for ${method}`)); } }, 20_000);
      waiters.push(w);
    });
    // Browser.close (not a signal) lets Chrome remove its $TMPDIR singleton dir.
    // cleanup() and close() follow it with killGroup() for anything left.
    proc.gracefulClose = async () => {
      try { ws.close(); } catch {}
      if (exited(proc)) return;
      try {
        const bws = await openSocket(browserWsUrl, 5_000);
        bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch (e) { console.error(`render-design: Browser.close failed (${e.message}); killing Chrome`); }
      await waitExit(proc, 5_000);
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return {
      async open(file, width, height) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        const loaded = waitFor('Page.loadEventFired');
        await send('Page.navigate', { url: pathToFileURL(file).href });
        await loaded;
      },
      async evaluate(fn, arg) {
        const r = await send('Runtime.evaluate', {
          expression: `(${fn})(${JSON.stringify(arg)})`, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
      async close() { await proc.gracefulClose(); await killGroup(proc); },
    };
  } catch (err) {
    try { ws?.close(); } catch {}
    await killGroup(proc);
    throw err;
  }
}

// Runs in the page. Checks every page; measures the shell on dashboard pages.
async function inspectPage(opts) {
  await document.fonts.ready;
  const px = (v) => (v.endsWith('px') ? Number(v.slice(0, -2)) : v);
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const style = (el, props) => { const s = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, px(s.getPropertyValue(p).trim())])); };
  const box = (sel, props = []) => { const el = document.querySelector(sel); return el ? { selector: sel, ...rect(el), ...style(el, props) } : null; };
  const svgs = [...document.querySelectorAll('svg')];
  const report = {
    svgCount: svgs.length,
    svgMissingViewBox: svgs.filter((s) => !s.getAttribute('viewBox')).length,
    // Visible svgs (laid out: has client rects) must have a non-zero box and drawn content.
    svgZeroSize: svgs.filter((s) => s.getClientRects().length > 0 && (s.getBoundingClientRect().width === 0 || s.getBBox().width === 0)).length,
    svgHidden: svgs.filter((s) => s.getClientRects().length === 0).length,
    unknownElements: [...document.querySelectorAll('*')].filter((e) => e instanceof HTMLUnknownElement).map((e) => e.localName),
  };
  if (!opts.dashboard) return report;
  report.panels = [...document.querySelectorAll('main section')].map((s) => s.querySelector('h2')?.textContent.trim());
  report.selectedTabs = [...document.querySelectorAll('[role=tab][aria-selected=true]')].map((t) => t.id);
  report.navRects = Object.fromEntries([...document.querySelectorAll('[role=tab]')].map((t) => [t.id, rect(t)]));
  const root = document.querySelector('.nl');
  const rs = getComputedStyle(root);
  report.tokens = Object.fromEntries(opts.tokens.map((n) => [`--${n}`, rs.getPropertyValue(`--${n}`).trim()]));
  if (!opts.measure) return report;
  const shape = ['height', 'border-radius', 'padding-left', 'padding-right', 'border-top-width', 'font-weight', 'background-color', 'color'];
  report.geometry = {
    viewport: { width: innerWidth, height: innerHeight },
    sidebar: box('aside.side', ['width', 'padding-top', 'padding-left', 'background-color', 'border-right-width', 'border-right-color']),
    brandMark: box('aside .brand svg'),
    brandTitle: box('aside .brand h1', ['font-size', 'line-height', 'font-weight']),
    collapseButton: box('aside .collapse-toggle', ['border-radius']),
    header: box('header', ['background-color', 'border-bottom-width']),
    headerInner: box('header .nl-wrap', ['min-height', 'padding-left', 'padding-right']),
    banner: box('[role=status]', ['background-color']),
    navRow: box('#tab-discover', ['height', 'border-radius', 'padding-left', 'column-gap', 'font-weight', 'background-color', 'color']),
    navRowUnselected: box('#tab-add', ['background-color', 'color']),
    navIcon: box('#tab-discover svg', ['color']),
    navGap: box('nav[role=tablist]', ['row-gap']),
    mainWrap: box('main .nl-wrap', ['max-width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
    sectionTitle: box('main h2', ['font-size', 'line-height', 'font-weight']),
    sectionDescription: box('main h2 + p', ['color', 'font-size', 'line-height']),
    btnSecondary: box('main .btn.btn-s', shape),
    btnPrimary: box('main .btn.btn-p', shape),
    btnIcon: box('main .btn.btn-i', ['width', 'height', 'border-radius']),
    input: box('main .field', ['height', 'border-radius', 'border-top-width', 'border-top-color', 'padding-left', 'background-color']),
    inputName: box('main .field.mono', ['width', 'height', 'border-radius']),
    row: box('main .row', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'column-gap']),
    port: box('main .row .mono', ['font-size', 'font-weight']),
    body: style(root, ['font-family', 'font-size', 'line-height', 'color', 'background-color']),
  };
  // Collapsed sidebar: flip the state the runtime toggle would set, measure, restore.
  const app = document.querySelector('.app'), side = document.querySelector('aside.side');
  side.style.transition = 'none';
  app.dataset.collapsed = 'true';
  report.geometry.sidebarCollapsed = { selector: '.app[data-collapsed=true] aside.side', ...rect(side) };
  app.dataset.collapsed = 'false';
  side.style.transition = '';
  return report;
}

async function inspectSharing() {
  const px = (v) => (v.endsWith('px') ? Number(v.slice(0, -2)) : v);
  const s = (el, props) => { const c = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, px(c.getPropertyValue(p).trim())])); };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const on = document.querySelector('.sw[aria-checked=true]');
  const off = document.querySelector('.sw[aria-checked=false]');
  return {
    switchOn: { selector: '.sw[aria-checked=true]', ...r(on), ...s(on, ['border-radius', 'background-color']) },
    switchOnKnob: { ...r(on.firstElementChild), ...s(on.firstElementChild, ['border-radius', 'left', 'top', 'background-color']) },
    switchOff: { selector: '.sw[aria-checked=false]', ...r(off), ...s(off, ['background-color']) },
    switchOffKnob: { ...r(off.firstElementChild), ...s(off.firstElementChild, ['left', 'background-color']) },
    select: { selector: 'main select', ...r(document.querySelector('main select')), ...s(document.querySelector('main select'), ['height', 'border-radius']) },
  };
}

async function inspectGhost() {
  const px = (v) => (v.endsWith('px') ? Number(v.slice(0, -2)) : v);
  const el = document.querySelector('main .btn.btn-g');
  const b = el.getBoundingClientRect(), c = getComputedStyle(el);
  const props = ['height', 'border-radius', 'padding-left', 'padding-right', 'border-top-width', 'font-weight', 'background-color', 'color'];
  return { selector: 'main .btn.btn-g', text: el.textContent.trim(), x: b.x, y: b.y, width: b.width, height: b.height,
    ...Object.fromEntries(props.map((p) => [p, px(c.getPropertyValue(p).trim())])) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const hexOf = (v) => v.toUpperCase();

function chromeVersion() {
  const r = spawnSync(CHROME, ['--version'], { timeout: 15_000, encoding: 'utf8' });
  return (r.stdout || '').trim() || `unknown (${r.error?.message || r.stderr})`;
}

async function main() {
  // Preconditions first: nothing is launched until they hold.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22 || typeof WebSocket !== 'function') {
    throw new Error(`Node ${process.versions.node} has no global WebSocket; run this script with Node >= 22`);
  }
  if (FAULT && !FAULTS.includes(FAULT)) throw new Error(`unknown NIDUM_RENDER_FAULT "${FAULT}" (one of ${FAULTS.join(', ')})`);
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  const versions = { chrome: chromeVersion(), node: process.version };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nidum-render-design-'));
  const tmp = tmpDir;
  const watchdog = setTimeout(() => shutdown(`watchdog fired after ${WATCHDOG_MS / 1000} s`, 1), WATCHDOG_MS);
  try {
    fs.mkdirSync(OUT, { recursive: true });

    // 1. Build static pages.
    const jobs = [];
    for (const theme of ['light', 'dark']) {
      const t = parseTemplate(path.join(DESIGN, `dashboard-${theme}.html`));
      for (const tab of TABS) {
        jobs.push({ name: `${theme}-${tab}`, theme, tab, width: t.width, height: t.height, html: toStatic(t.src, dashboardCtx(tab)),
          desc: `Dashboard · ${theme === 'light' ? 'Light' : 'Dark'}, ${TAB_TITLES[tab]} panel` });
      }
    }
    const tok = parseTemplate(path.join(DESIGN, 'theme-tokens.html'));
    jobs.push({ name: 'tokens', width: tok.width, height: tok.height, html: toStatic(tok.src, {}), desc: 'Theme tokens · Light vs Dark, logo lockup' });
    const pop = parseTemplate(path.join(DESIGN, 'popovers-dialogs-notices.html'));
    jobs.push({ name: 'popovers', width: pop.width, height: pop.height, html: toStatic(pop.src, { qr: fakeQr() }), desc: 'Error banner, QR popover, confirm dialog, inline notice, toasts' });
    for (const j of jobs) { j.file = path.join(tmp, `${j.name}.html`); fs.writeFileSync(j.file, j.html); }

    // 2. Screenshots (headless Chrome CLI, one fresh profile each; async so the watchdog can fire).
    for (const j of jobs) {
      checkpoint(`screenshot of ${j.name}`);
      j.png = path.join(OUT, `${j.name}.png`);
      fs.rmSync(j.png, { force: true });
      await screenshot(j.file, j.png, j.width, j.height, path.join(tmp, `profile-${j.name}`));
      process.stdout.write(`rendered ${path.relative(ROOT, j.png)}\n`);
    }

    // 3. CDP: inspect every page, measure the light Discover shell.
    checkpoint('CDP start');
    const cdp = await startCdp(path.join(tmp, 'profile-cdp'));
    await fault('after-cdp');
    for (const j of jobs) {
      checkpoint(`CDP inspection of ${j.name}`);
      await cdp.open(j.file, j.width, j.height);
      j.report = await cdp.evaluate(inspectPage, { dashboard: !!j.tab, measure: j.name === 'light-discover', tokens: TOKEN_NAMES });
      if (j.name === 'light-sharing') j.sharing = await cdp.evaluate(inspectSharing);
      if (j.name === 'light-addresses') j.ghost = await cdp.evaluate(inspectGhost);
    }
    checkpoint('CDP close');
    await cdp.close();

    // 4. Self-checks on the PNGs.
    const failures = [];
    const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };
    for (const j of jobs) {
      const img = readPng(j.png);
      j.size = `${img.width}×${img.height}`;
      check(img.width === 1440, `${j.name}: width ${img.width}`);
      check(img.height === j.height, `${j.name}: height ${img.height}, expected ${j.height}`);
      const r = j.report;
      const broken = r.svgMissingViewBox + r.svgZeroSize;
      check(broken === 0, `${j.name}: ${r.svgMissingViewBox} svg without viewBox, ${r.svgZeroSize} zero-size`);
      check(r.unknownElements.length === 0, `${j.name}: unknown elements ${r.unknownElements.join(',')}`);
      j.icons = `${r.svgCount} svg, ${broken} broken`;
      if (!j.tab) { j.samples = ''; continue; }
      check(r.panels.length === 1 && r.panels[0] === TAB_TITLES[j.tab], `${j.name}: panels shown ${JSON.stringify(r.panels)}`);
      check(r.selectedTabs.length === 1 && r.selectedTabs[0] === `tab-${j.tab}`, `${j.name}: selected tabs ${r.selectedTabs}`);
      if (!img.pixel) { failures.push(`${j.name}: PNG format not decodable for spot checks`); continue; }
      const t = r.tokens, nav = r.navRects[`tab-${j.tab}`];
      const samples = {
        '--bg (main, x1430 y890)': [img.pixel(1430, 890), t['--bg']],
        '--surface (sidebar, x4 y450)': [img.pixel(4, 450), t['--surface']],
        '--surface (header, x1430 y4)': [img.pixel(1430, 4), t['--surface']],
        '--accent-weak (selected nav)': [img.pixel(nav.x + 3, nav.y + nav.height / 2), t['--accent-weak']],
      };
      j.samples = Object.entries(samples).map(([k, [got, want]]) => {
        check(hexOf(got) === hexOf(want), `${j.name}: ${k} is ${got}, token ${want}`);
        return `${k.split(' ')[0]} ${got}`;
      }).join(', ');
    }

    // 5. geometry.json
    const ld = jobs.find((j) => j.name === 'light-discover');
    const ls = jobs.find((j) => j.name === 'light-sharing');
    const la = jobs.find((j) => j.name === 'light-addresses');
    const geometry = {
      source: 'design/dashboard-light.html rendered by scripts/render-design.mjs (static rewrite, headless Chrome, CDP)',
      versions,
      page: 'light-discover',
      units: 'CSS px; x/y/width/height from getBoundingClientRect, other keys are computed styles',
      ...ld.report.geometry,
      btnGhost: { page: 'light-addresses', ...la.ghost },
      switch: { page: 'light-sharing', ...ls.sharing },
      tokens: {
        light: ld.report.tokens,
        dark: jobs.find((j) => j.name === 'dark-discover').report.tokens,
      },
      expected: {
        note: 'Values from Screens and components / Design tokens; N4 compares its own build against the measured values above.',
        sidebarWidth: 232, sidebarCollapsedWidth: 64, headerHeight: 64, headerBorderBottom: 1, navRowHeight: 40, navIcon: 20,
        btnHeight: 36, btnRadius: 10, btnGhostHeight: 32, btnGhostRadius: 10, btnGhostPadding: 10, btnIcon: 32, btnIconRadius: 8,
        switch: [36, 20], switchKnob: 16,
        inputHeight: 36, inputRadius: 6, focusRing: '2px var(--focus), offset 2', mainMaxWidth: 1120, mainPadding: [32, 32, 48, 32],
      },
    };
    const g = geometry;
    const measured = {
      sidebarWidth: g.sidebar.width, sidebarCollapsedWidth: g.sidebarCollapsed.width, headerHeight: g.headerInner.height, headerBorderBottom: g.header['border-bottom-width'], navRowHeight: g.navRow.height, navIcon: g.navIcon.width,
      btnHeight: g.btnSecondary.height, btnRadius: g.btnSecondary['border-radius'],
      btnGhostHeight: g.btnGhost.height, btnGhostRadius: g.btnGhost['border-radius'], btnGhostPadding: g.btnGhost['padding-left'],
      btnIcon: g.btnIcon.width, btnIconRadius: g.btnIcon['border-radius'],
      switch: [g.switch.switchOn.width, g.switch.switchOn.height], switchKnob: g.switch.switchOnKnob.width,
      inputHeight: g.input.height, inputRadius: g.input['border-radius'], mainMaxWidth: g.mainWrap['max-width'],
      mainPadding: [g.mainWrap['padding-top'], g.mainWrap['padding-right'], g.mainWrap['padding-bottom'], g.mainWrap['padding-left']],
    };
    geometry.comparison = Object.fromEntries(Object.entries(measured).map(([k, v]) => {
      const ok = JSON.stringify(v) === JSON.stringify(g.expected[k]);
      check(ok, `geometry ${k}: measured ${JSON.stringify(v)}, expected ${JSON.stringify(g.expected[k])}`);
      return [k, { measured: v, expected: g.expected[k], ok }];
    }));
    fs.writeFileSync(path.join(OUT, 'geometry.json'), `${JSON.stringify(geometry, null, 2)}\n`);

    // 6. README
    const rows = jobs.map((j) => `| \`${j.name}.png\` | ${j.desc} | ${j.size} | ${j.icons} | ${j.samples || '—'} |`);
    fs.writeFileSync(path.join(OUT, 'README.md'), [
      '# Design reference renders',
      '',
      'Generated by `node scripts/render-design.mjs` from the templates in `design/` (re-runnable; overwrites this folder).',
      'Each template is rewritten to static HTML (`sc-camel-view-box` → `viewBox`, `<sc-raw-*>` → plain table elements,',
      'one `<sc-if>` branch kept, `<sc-for>` expanded, design runtime dropped, `<helmet><style>` moved into `<head>`), then',
      'screenshotted with headless Chrome at device scale 1. Sidebar expanded in every dashboard render.',
      '',
      `Rendered with ${versions.chrome} and Node ${versions.node} on ${os.platform()} ${os.release()}. PNG bytes depend on the Chrome build and system fonts.`,
      '',
      '| File | Board | Size | Icons | Pixel spot checks (= token) |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '| `geometry.json` | CDP bounding boxes and computed styles of the light Discover shell (ghost button from light Addresses, switch from light Sharing), both token sets, versions, and a measured-vs-expected comparison | — | — | — |',
      '',
      `Self-check: ${failures.length ? `FAILED (${failures.length})` : 'all passed'} — widths, heights, one panel and one selected tab per dashboard render, no \`<svg>\` without \`viewBox\` or with zero size, no unknown elements, \`--bg\`/\`--surface\`/\`--accent-weak\` pixels equal the theme's tokens, geometry equals the expected values.`,
      '',
      'Fault injection (for validators): `NIDUM_RENDER_FAULT=<point>` with `screenshot`, `in-cdp`, `after-cdp` (throw while a Chrome is running) or `hang-screenshot`, `hang-after-cdp` (hang until the watchdog, shortened with `NIDUM_RENDER_WATCHDOG_MS`) exit 1 with the original error; `signal-at-screenshot-exit` (SIGTERM handler runs once screenshot `NIDUM_RENDER_FAULT_SHOT`, default 14, has written its PNG but before its Chrome exits; the run must refuse to start the next Chrome) exits 143. SIGHUP/SIGINT/SIGQUIT/SIGALRM/SIGTERM exit 129/130/131/142/143 after the same cleanup; the watchdog (default 90 s) exits 1. Every case must leave no Chrome running, no temp dir and no `com.google.Chrome.*` singleton dir of its own. `kill -9` cannot be cleaned up. A fault run may leave this folder partly rewritten; a normal run restores it.',
      '',
    ].join('\n'));

    if (failures.length) {
      console.error(`render-design: ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`render-design: ${jobs.length} PNGs, geometry.json and README.md written to ${path.relative(ROOT, OUT)}/; all checks passed`);
    }
  } finally {
    clearTimeout(watchdog);
    await cleanup(); // never throws, so an error from the try block is what propagates
  }
}

// Every catchable terminating signal goes through the same shutdown path
// (exit 128 + signal number). SIGKILL cannot be caught; see the header.
for (const [sig, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGQUIT', 131], ['SIGALRM', 142], ['SIGTERM', 143]]) {
  process.on(sig, () => shutdown(sig, code));
}
// A closed reader (`| head`) must not kill Node before cleanup: ignore write
// errors on our own output, and send anything uncaught through shutdown().
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
process.on('uncaughtException', (err) => shutdown(`uncaught exception: ${err && err.message}`, 1));
process.on('unhandledRejection', (err) => shutdown(`unhandled rejection: ${err && err.message}`, 1));

main().catch(async (err) => {
  if (!(err instanceof ShutdownError)) console.error(`render-design: ${err.stack || err.message}`);
  await cleanup(); // already done by main's finally; awaited so the exit code below is final
  process.exit(shutdownExitCode ?? 1);
});
