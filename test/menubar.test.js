// Node N7: the macOS menu bar app. Builds it into a temp dir with
// scripts/build-menubar.sh, then runs --dump-menu, --dump-icon and every --self-test
// scenario of the node note against test/helpers/mock-api.js (in-memory fakes, a free
// port, a temp NIDUM_HOME, and a temp HOME so even the default ~/.nidum-local is a temp
// dir). Never starts the app's UI, never touches the real proxy or ~/.nidum-local.
// Skipped when swiftc is missing (or not on macOS).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeAdapter, startMockApi } from './helpers/mock-api.js';
import { PortlessError } from '../src/portless.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'scripts', 'build-menubar.sh');
const MENU = ['Open Dashboard', 'Stop All Services', 'Quit'];

function hasSwiftc() {
  if (process.platform !== 'darwin') return false;
  const r = spawnSync('swiftc', ['--version'], { timeout: 30_000, stdio: 'ignore' });
  return r.status === 0;
}
const SKIP = hasSwiftc() ? false : 'swiftc is not available (macOS with the Xcode Command Line Tools only)';

/** Async (the mock runs in this process, so the event loop must stay free). */
function run(cmd, args, { env = {}, timeout = 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout, cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, signal: err?.signal ?? null, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const lines = (s) => s.split('\n').filter(Boolean);
const alertsOf = (s) => lines(s).filter((l) => l.startsWith('alert:'));
const TOKEN = 'a'.repeat(64);

/**
 * A scripted fake Nidum server on a free port: health answers app "nidum-local" with
 * `pid` (default this process, which is alive); every request is recorded. `handle(req,
 * body)` returns `{ status, json?, headers? }` or null for the default (health only).
 */
async function fakeServer({ home, pid = process.pid, handle = () => null } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, token: req.headers['x-nidum-token'] || null });
      let r = req.url === '/api/health' ? { status: 200, json: { ok: true, app: 'nidum-local', version: '1.0.0', pid } } : null;
      r = handle(req, body) || r || { status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found.' } } };
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  if (home) writeFileSync(join(home, 'session.json'), JSON.stringify({ port, token: TOKEN, pid, startedAt: new Date().toISOString(), version: '1.0.0' }));
  return { port, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** `/api/state` body with sharing `running` and `job` (or null). */
const stateBody = (running, job = null) => ({ proxy: { running, job }, banners: [] });
const jobOf = (id, phase, finished = false, action = 'stop') => ({ id, action, phase, error: null, startedAt: new Date().toISOString(), finishedAt: finished ? new Date().toISOString() : null });

/**
 * Minimal PNG decoder (8-bit RGBA, non-interlaced): returns { width, height, alpha[] }.
 */
async function decodePng(file) {
  const { inflateSync } = await import('node:zlib');
  const b = readFileSync(file);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + n);
    if (type === 'IHDR') {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      assert.equal(d[8], 8, '8 bits per sample');
      assert.equal(d[9], 6, 'RGBA');
    }
    if (type === 'IDAT') idat.push(d);
    o += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = raw[y * (stride + 1) + 1 + x];
      const l = x >= 4 ? px[y * stride + x - 4] : 0;
      const u = y ? px[(y - 1) * stride + x] : 0;
      const ul = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let pr;
      if (f === 0) pr = 0;
      else if (f === 1) pr = l;
      else if (f === 2) pr = u;
      else if (f === 3) pr = (l + u) >> 1;
      else {
        const pp = l + u - ul;
        const pa = Math.abs(pp - l);
        const pb = Math.abs(pp - u);
        const pc = Math.abs(pp - ul);
        pr = pa <= pb && pa <= pc ? l : pb <= pc ? u : ul;
      }
      px[y * stride + x] = (a + pr) & 255;
    }
  }
  const alpha = [];
  for (let i = 3; i < px.length; i += 4) alpha.push(px[i]);
  return { width, height, alpha };
}

async function healthOf(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

async function stateOf(mock) {
  const r = await fetch(`${mock.url}api/state`, { headers: { 'x-nidum-token': mock.token }, signal: AbortSignal.timeout(5000) });
  return r.json();
}

describe('menu bar app (N7)', { skip: SKIP }, () => {
  let work;
  let appPath;
  let bin;
  let buildOutput = '';
  let userHome; // a temp HOME for every app run: the default ~/.nidum-local is never real
  const homes = [];
  const mocks = [];
  const strayPids = [];

  function newHome() {
    const h = mkdtempSync(join(work, 'home-'));
    homes.push(h);
    return h;
  }

  async function mock(o = {}) {
    const home = o.home || newHome();
    let quitResolve;
    const quit = new Promise((r) => {
      quitResolve = r;
    });
    const m = await startMockApi({ scenario: 'manual-https', ...o, home, onQuit: () => quitResolve(true) });
    m.quitCalled = quit;
    mocks.push(m);
    return m;
  }

  /** Runs the app headlessly. NIDUM_HOME and HOME are always temp dirs. */
  function app(args, home, extraEnv = {}) {
    assert.ok(home === '' || (home && home.startsWith(work)), 'tests must use a temp NIDUM_HOME');
    const env = { HOME: userHome, NIDUM_NODE: '', NIDUM_HOME: home, ...extraEnv };
    assert.ok(env.HOME.startsWith(work), 'tests must use a temp HOME');
    return run(bin, args, { env, timeout: 60_000 });
  }

  /** A stub app root whose src/server.js is `code` (an ES module). */
  function stubRoot(code) {
    const root = mkdtempSync(join(work, 'root-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'src', 'server.js'), code);
    return root;
  }

  /** A stub app root whose server is the mock (fakes only), in its own process. */
  function mockServerRoot() {
    const mockUrl = pathToFileURL(join(ROOT, 'test', 'helpers', 'mock-api.js')).href;
    return stubRoot(`import { startMockApi } from ${JSON.stringify(mockUrl)};
const mock = await startMockApi({ scenario: 'manual-https', home: process.env.NIDUM_HOME, onQuit: () => process.exit(0) });
process.on('SIGTERM', () => mock.close().then(() => process.exit(0)));
setTimeout(() => mock.close().then(() => process.exit(0)), 120000);
console.log('stub server up on ' + mock.port + ' cwd ' + process.cwd());
`);
  }

  /** A stub server that never answers: writes its pid to `marker` and sleeps. */
  function silentServerRoot(marker) {
    return stubRoot(`import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setTimeout(() => process.exit(0), 60000);
`);
  }

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };

  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'nidum-menubar-test-'));
    userHome = mkdtempSync(join(work, 'user-home-'));
    appPath = join(work, 'out', 'Nidum Local Menu.app');
    const r = await run('/bin/bash', [BUILD, appPath], { timeout: 900_000 });
    buildOutput = r.stdout + r.stderr;
    assert.equal(r.code, 0, `build failed:\n${buildOutput}`);
    bin = join(appPath, 'Contents', 'MacOS', 'NidumLocalMenu');
    assert.ok(existsSync(bin), 'the bundle has its executable');
  });

  after(async () => {
    for (const m of mocks) await m.close().catch(() => {});
    for (const pid of strayPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // ---- criterion 1: build ------------------------------------------------------------
  test('builds without warnings into an LSUIElement, ad-hoc signed bundle', async () => {
    assert.doesNotMatch(buildOutput, /warning:/i);
    assert.doesNotMatch(buildOutput, /error:/i);
    const plist = join(appPath, 'Contents', 'Info.plist');
    const ui = await run('plutil', ['-extract', 'LSUIElement', 'raw', '-o', '-', plist], { timeout: 20_000 });
    assert.equal(ui.stdout.trim(), 'true');
    const exe = await run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { timeout: 20_000 });
    assert.equal(exe.stdout.trim(), 'NidumLocalMenu');
    const min = await run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', plist], { timeout: 20_000 });
    assert.equal(min.stdout.trim(), '13.0');
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const v = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { timeout: 20_000 });
    assert.equal(v.stdout.trim(), version);
    const sig = await run('codesign', ['-dv', appPath], { timeout: 30_000 });
    assert.match(sig.stderr, /Signature=adhoc/);
    const verify = await run('codesign', ['--verify', '--strict', appPath], { timeout: 30_000 });
    assert.equal(verify.code, 0, verify.stderr);
    const archs = await run('lipo', ['-archs', bin], { timeout: 20_000 });
    assert.match(archs.stdout, /arm64/);
    assert.match(archs.stdout, /x86_64/);
    const otool = await run('otool', ['-L', bin], { timeout: 20_000 });
    assert.match(otool.stdout, /AppKit\.framework/);
  });

  test('the build script refuses an output that is not an .app', async () => {
    const r = await run('/bin/bash', [BUILD, join(work, 'not-an-app')], { timeout: 30_000 });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /must end in \.app/);
    const file = join(work, 'file.app');
    writeFileSync(file, 'x');
    const r2 = await run('/bin/bash', [BUILD, file], { timeout: 30_000 });
    assert.notEqual(r2.code, 0);
    assert.match(r2.stderr, /isn't an app bundle/);
    assert.equal(readFileSync(file, 'utf8'), 'x', 'nothing replaced');
  });

  // ---- criterion 4: exactly three items -------------------------------------------------
  test('--dump-menu prints exactly the three items in order', async () => {
    const r = await app(['--dump-menu'], newHome());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), MENU);
  });

  /** The "N" mark: 1 = filled, 0 = outlined. */
  const MARK = [
    [1, 0, 0, 0, 0, 1],
    [1, 1, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 1, 1],
    [1, 0, 0, 0, 0, 1],
  ];

  /** Margins of the inked area (alpha > 0): [left, top, right, bottom]. */
  function inkMargins({ width, height, alpha }) {
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (alpha[y * width + x] > 0) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    return [x0, y0, width - 1 - x1, height - 1 - y1];
  }

  test('--dump-icon at 2x: 17 pt (34 px), the mark centred, 4 px squares on a 6 px pitch', async () => {
    const png = join(work, 'icon.png');
    const r = await app(['--dump-icon', png], newHome());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /17x17 pt @2x template=true/);
    const data = readFileSync(png);
    assert.equal(data.subarray(1, 4).toString(), 'PNG');
    const img = await decodePng(png);
    assert.deepEqual([img.width, img.height], [34, 34]);
    const m = inkMargins(img);
    assert.deepEqual(m, [0, 0, 0, 0], `centred: margins L,T,R,B = ${m}`);
    const at = (x, y) => img.alpha[y * 34 + x];
    for (let r0 = 0; r0 < 6; r0++) {
      for (let c0 = 0; c0 < 6; c0++) {
        const x = 6 * c0;
        const y = 6 * r0;
        // The middle 2×2 of a 4 px square: solid when filled, clear inside an outline.
        for (const [dy, dx] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
          assert.equal(at(x + dx, y + dy), MARK[r0][c0] ? 255 : 0, `cell ${r0},${c0} centre`);
        }
        // The edge midpoints: solid when filled, the outline's alpha otherwise.
        for (const [dy, dx] of [[0, 1], [1, 0], [3, 2], [2, 3]]) {
          const a = at(x + dx, y + dy);
          if (MARK[r0][c0]) assert.equal(a, 255, `cell ${r0},${c0} edge`);
          else assert.ok(a > 60 && a < 255, `cell ${r0},${c0} outline (${a})`);
        }
        // The 2 px gap to the right and below is clear.
        if (c0 < 5) for (let k = 0; k < 4; k++) assert.equal(at(x + 4, y + k) + at(x + 5, y + k), 0, `gap right of ${r0},${c0}`);
        if (r0 < 5) for (let k = 0; k < 4; k++) assert.equal(at(x + k, y + 4) + at(x + k, y + 5), 0, `gap below ${r0},${c0}`);
      }
    }
  });

  test('--dump-icon at 1x: 17 px, centred, whole pixels only (no blurred edges), same 6×6 mark', async () => {
    const png = join(work, 'icon1x.png');
    const r = await app(['--dump-icon', png, '--icon-scale', '1'], newHome());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /17x17 pt @1x template=true/);
    const img = await decodePng(png);
    const { width, height, alpha } = img;
    assert.deepEqual([width, height], [17, 17]);
    const m = inkMargins(img);
    assert.deepEqual(m, [0, 0, 0, 0], `centred: margins L,T,R,B = ${m}`);
    const values = [...new Set(alpha)].sort((a, b) => a - b);
    assert.equal(values.length, 3, `only clear, outline and solid pixels: ${values}`);
    assert.equal(values[0], 0);
    assert.equal(values[2], 255);
    // Each cell (2 px square on a 3 px pitch, from the top left corner) is uniform:
    // filled = the "N" mark.
    for (let r0 = 0; r0 < 6; r0++) {
      for (let c0 = 0; c0 < 6; c0++) {
        for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
          const a = alpha[(3 * r0 + dy) * 17 + 3 * c0 + dx];
          assert.equal(a, MARK[r0][c0] ? 255 : values[1], `cell ${r0},${c0}`);
        }
      }
    }
    for (let i = 0; i < 17; i++) {
      for (const g of [2, 5, 8, 11, 14]) {
        assert.equal(alpha[g * 17 + i], 0, `gap row ${g} clear`);
        assert.equal(alpha[i * 17 + g], 0, `gap column ${g} clear`);
      }
    }
  });

  test('unknown arguments and scenarios are refused', async () => {
    const r = await app(['--bogus'], newHome());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument/);
    const s = await app(['--self-test', 'nope'], newHome());
    assert.equal(s.code, 2);
    assert.match(s.stdout, /unknown scenario/);
    const w = await app(['--job-wait', '2'], newHome());
    assert.equal(w.code, 2, 'timing flags are for --self-test only');
  });

  // ---- finding 1: --self-test never reaches real state ---------------------------------
  test('self-test without --home or NIDUM_HOME: exit 2, the default ~/.nidum-local is never read', async () => {
    // A temp HOME whose ~/.nidum-local/session.json points at a live fake server.
    const fakeUser = mkdtempSync(join(work, 'user-'));
    const defaultHome = join(fakeUser, '.nidum-local');
    mkdirSync(defaultHome);
    const real = await fakeServer({ home: defaultHome, handle: (req) => (req.url === '/api/state' ? { status: 200, json: stateBody(true) } : null) });
    try {
      for (const scenario of ['open', 'stop', 'quit', 'menu-state', 'lock']) {
        const r = await app(['--self-test', scenario], '', { HOME: fakeUser });
        assert.equal(r.code, 2, `${scenario}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /--self-test needs --home <dir> or NIDUM_HOME; it never uses ~\/\.nidum-local/);
        assert.doesNotMatch(r.stdout, /self-test:|open-url|alert:/);
      }
      assert.deepEqual(real.requests, [], 'the server in the default home was never contacted');
      assert.deepEqual(readdirSync(defaultHome), ['session.json'], 'nothing written there (no menubar.lock, no server.log)');
      // With an explicit (empty) home, the default one is still untouched.
      const r = await app(['--self-test', 'stop'], newHome(), { HOME: fakeUser });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Nidum Local's files weren't found\./);
      assert.deepEqual(real.requests, []);
      assert.deepEqual(readdirSync(defaultHome), ['session.json']);
    } finally {
      await real.close();
    }
  });

  // ---- validation 2 finding 1: "~" is never expanded (the server's rule) --------------
  test('a "~" or relative home is refused (exit 2) and never resolved, even to a temp HOME', async () => {
    // A temp HOME and a temp cwd that each hold a live fake server at x/session.json:
    // neither may be reached through "~/x" or "x".
    const fakeUser = mkdtempSync(join(work, 'user-tilde-'));
    const cwd = mkdtempSync(join(work, 'cwd-'));
    mkdirSync(join(fakeUser, 'x'));
    mkdirSync(join(cwd, 'x'));
    const handle = (req) => (req.url === '/api/state' ? { status: 200, json: stateBody(true) } : null);
    const viaHome = await fakeServer({ home: join(fakeUser, 'x'), handle });
    const viaCwd = await fakeServer({ home: join(cwd, 'x'), handle });
    try {
      const cases = [
        [{ NIDUM_HOME: '~/x' }, [], /NIDUM_HOME must be a full path that starts with "\/" \(it is "~\/x"; "~" is not expanded\)\./],
        [{ NIDUM_HOME: '~' }, [], /NIDUM_HOME must be a full path/],
        [{ NIDUM_HOME: 'x' }, [], /NIDUM_HOME must be a full path .*"x"/],
        [{ NIDUM_HOME: '' }, ['--home', '~/x'], /--home must be a full path that starts with "\/" \(it is "~\/x"/],
        [{ NIDUM_HOME: join(cwd, 'x') }, ['--home', 'x'], /--home must be a full path .*"x"/],
        [{ NIDUM_HOME: '~/x' }, ['--home', './x'], /--home must be a full path/],
      ];
      for (const scenario of ['open', 'stop', 'quit', 'menu-state', 'lock']) {
        for (const [env, extra, message] of cases) {
          const r = await run(bin, ['--self-test', scenario, ...extra, '--node', process.execPath], { env: { HOME: fakeUser, NIDUM_NODE: '', ...env }, cwd, timeout: 60_000 });
          assert.equal(r.code, 2, `${scenario} ${JSON.stringify(env)} ${extra}: ${r.stdout}${r.stderr}`);
          assert.match(r.stderr, message);
          assert.doesNotMatch(r.stdout, /self-test:|home:|open-url|alert:/);
        }
      }
      assert.deepEqual(viaHome.requests, [], 'nothing reached $HOME/x');
      assert.deepEqual(viaCwd.requests, [], 'nothing reached <cwd>/x');
      assert.deepEqual(readdirSync(join(fakeUser, 'x')), ['session.json'], 'nothing written in $HOME/x');
      assert.deepEqual(readdirSync(cwd).sort(), ['x'], 'no "~" folder made in the cwd');
      assert.deepEqual(readdirSync(join(cwd, 'x')), ['session.json']);
      // An absolute home with ".." in it is fine (it is a full path).
      const ok = await run(bin, ['--self-test', 'menu-state', '--home', join(cwd, 'x', '..', 'x')], { env: { HOME: fakeUser, NIDUM_HOME: '', NIDUM_NODE: '' }, cwd, timeout: 60_000 });
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /sharing: on/);
    } finally {
      await viaHome.close();
      await viaCwd.close();
    }
  });

  test('a "~" or relative --app-root is never used: nothing is started', async () => {
    const cwd = mkdtempSync(join(work, 'cwd-root-'));
    const marker = join(cwd, 'started');
    mkdirSync(join(cwd, 'app', 'src'), { recursive: true });
    writeFileSync(join(cwd, 'app', 'src', 'server.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    for (const root of ['app', './app', '~/app']) {
      const home = newHome();
      const r = await run(bin, ['--self-test', 'open', '--app-root', root, '--node', process.execPath], { env: { HOME: cwd, NIDUM_HOME: home, NIDUM_NODE: '' }, cwd, timeout: 60_000 });
      assert.equal(r.code, 1, `${root}: ${r.stdout}`);
      assert.match(r.stdout, /alert: Couldn't open Nidum Local\. \| Nidum Local's files weren't found\./);
      assert.doesNotMatch(r.stdout, /server: starting/);
      assert.ok(!existsSync(marker), `${root}: nothing started`);
    }
  });

  test('packaged layout, empty home, no --app-root: nothing is started (Stop, Quit, Open)', async () => {
    // <pkg>/macos/Nidum Local Menu.app next to a stub src/server.js that leaves a marker.
    const pkg = mkdtempSync(join(work, 'pkg-'));
    mkdirSync(join(pkg, 'macos'));
    cpSync(appPath, join(pkg, 'macos', 'Nidum Local Menu.app'), { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(pkg, 'src'));
    const marker = join(pkg, 'started');
    writeFileSync(join(pkg, 'src', 'server.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    const pkgBin = join(pkg, 'macos', 'Nidum Local Menu.app', 'Contents', 'MacOS', 'NidumLocalMenu');
    for (const [scenario, title] of [['stop', "Couldn't stop sharing."], ['open', "Couldn't open Nidum Local."], ['quit', 'Sharing may still be on.']]) {
      const home = newHome();
      const r = await run(pkgBin, ['--self-test', scenario, '--node', process.execPath], { env: { HOME: userHome, NIDUM_HOME: home, NIDUM_NODE: '' }, timeout: 60_000 });
      assert.equal(r.code, 1, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.ok(alertsOf(r.stdout)[0].startsWith(`alert: ${title} | `), r.stdout);
      assert.match(r.stdout, /Nidum Local's files weren't found\./);
      assert.doesNotMatch(r.stdout, /server: starting|server: started/);
      assert.ok(!existsSync(marker), `${scenario}: no server started from the bundle's folder`);
      assert.ok(!existsSync(join(home, 'server.log')));
    }
  });

  // ---- criterion 2: self-tests ------------------------------------------------------------
  test('Open: health (pid match), then the URL with the token', async () => {
    const m = await mock();
    const r = await app(['--self-test', 'open'], m.home);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = lines(r.stdout);
    assert.ok(out.includes(`note: health: ok (pid ${process.pid})`), r.stdout);
    assert.ok(out.includes(`open-url: http://127.0.0.1:${m.port}/?t=${m.token}`), r.stdout);
    assert.equal(m.tokenUrl, `http://127.0.0.1:${m.port}/?t=${m.token}`);
    assert.ok(!out.some((l) => l.startsWith('alert:')));
    assert.ok(!m.adapter.calls.some((c) => c.method === 'stopProxy'), 'Open changes nothing');
  });

  test('--home overrides NIDUM_HOME', async () => {
    const m = await mock();
    const r = await app(['--self-test', 'open', '--home', m.home], newHome());
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`open-url: http://127\\.0\\.0\\.1:${m.port}/\\?t=${m.token}`));
  });

  test('Stop: job done, password phase shown, sharing-paused', async () => {
    const m = await mock({ onElevate: () => new Promise((r) => setTimeout(r, 1200)) });
    const r = await app(['--self-test', 'stop'], m.home);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = lines(r.stdout);
    assert.ok(out.includes('menu: Stop All Services -> Stopping… (disabled)'), r.stdout);
    assert.ok(out.includes('menu: Quit -> Quit (disabled)'), r.stdout);
    assert.ok(out.includes('note: job: phase waitingForPassword'), r.stdout);
    assert.ok(out.includes('menu: Stop All Services -> Waiting for your password… (disabled)'), r.stdout);
    assert.ok(out.includes('note: job: phase done'), r.stdout);
    assert.ok(out.some((l) => /^note: banners: .*sharing-paused/.test(l)), r.stdout);
    assert.ok(out.includes('note: sharing: off'), r.stdout);
    assert.ok(out.includes('menu: Stop All Services -> Stop All Services (disabled)'), 'disabled afterwards: sharing is off');
    assert.ok(out.includes('menu: Quit -> Quit'), 'Quit enabled again');
    assert.ok(!out.some((l) => l.startsWith('alert:')));
    const st = await stateOf(m);
    assert.equal(st.proxy.running, false);
    assert.equal(st.proxy.pausedByUser, true);
    assert.ok(st.banners.some((b) => b.id === 'sharing-paused'));
    assert.equal(st.proxy.job.action, 'stop');
    assert.equal(st.proxy.job.phase, 'done');
    assert.equal(m.adapter.calls.filter((c) => c.method === 'stopProxy').length, 1);
  });

  test('Stop when sharing is already off: no job, nothing to do', async () => {
    const m = await mock({ scenario: 'stopped' });
    const r = await app(['--self-test', 'stop'], m.home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /note: sharing: already off/);
    assert.ok(!m.adapter.calls.some((c) => c.method === 'stopProxy'));
  });

  test('Stop failure: one alert with the server message', async () => {
    const m = await mock();
    const message = 'The administrator password dialog was cancelled.';
    m.adapter.failNext('stopProxy', new PortlessError('PERMISSION', message));
    const r = await app(['--self-test', 'stop'], m.home);
    assert.equal(r.code, 1, r.stdout);
    const alerts = lines(r.stdout).filter((l) => l.startsWith('alert:'));
    assert.deepEqual(alerts, [`alert: Couldn't stop sharing. | ${message} | buttons: OK -> OK`]);
    assert.match(r.stdout, /note: job: failed \(PERMISSION\)/);
    assert.equal((await stateOf(m)).proxy.running, true);
  });

  test('Stop refused by the server (409 BUSY): the alert carries its message', async () => {
    const m = await mock({ onElevate: () => new Promise((r) => setTimeout(r, 3000)) });
    const busy = await fetch(`${m.url}api/proxy/restart`, { method: 'POST', headers: { 'x-nidum-token': m.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(busy.status, 202);
    const r = await app(['--self-test', 'stop'], m.home);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Another sharing change is still running\. Try again when it finishes\. \| buttons: OK -> OK/);
  });

  test('Quit: stop, then POST /api/quit, server gone', async () => {
    const m = await mock();
    const r = await app(['--self-test', 'quit'], m.home);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = lines(r.stdout);
    const iDone = out.indexOf('note: job: phase done');
    const iQuit = out.findIndex((l) => l === 'note: quit: HTTP 202');
    assert.ok(iDone >= 0 && iQuit > iDone, `stop finished before quit:\n${r.stdout}`);
    assert.ok(out.includes('note: server: stopped'), r.stdout);
    assert.ok(out.includes('exit: menu app quits'), r.stdout);
    assert.ok(out.includes('menu: Quit -> Quitting… (disabled)'), r.stdout);
    assert.equal(await m.quitCalled, true);
    assert.equal(await healthOf(m.port), null, 'server gone');
    assert.ok(!existsSync(join(m.home, 'session.json')), 'session.json removed');
    assert.equal(m.adapter.calls.filter((c) => c.method === 'stopProxy').length, 1);
  });

  test('Quit when sharing is already off: no stop job, quits', async () => {
    const m = await mock({ scenario: 'stopped' });
    const r = await app(['--self-test', 'quit'], m.home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /note: sharing: already off/);
    assert.equal(await m.quitCalled, true);
    assert.ok(!m.adapter.calls.some((c) => c.method === 'stopProxy'));
  });

  test('Quit with a failed stop: "Sharing is still on." → Quit Anyway quits', async () => {
    const m = await mock();
    const message = 'You cancelled the password dialog.';
    m.adapter.failNext('stopProxy', new PortlessError('PERMISSION', message));
    const r = await app(['--self-test', 'quit', '--alert-response', 'Quit Anyway'], m.home);
    assert.equal(r.code, 0, r.stdout);
    const alerts = lines(r.stdout).filter((l) => l.startsWith('alert:'));
    assert.deepEqual(alerts, [`alert: Sharing is still on. | ${message} | buttons: Cancel, Quit Anyway -> Quit Anyway`]);
    assert.match(r.stdout, /note: server: stopped/);
    assert.equal(await m.quitCalled, true);
    assert.equal(await healthOf(m.port), null);
  });

  test('Quit with a failed stop → Cancel keeps everything running', async () => {
    const m = await mock();
    m.adapter.failNext('stopProxy', new PortlessError('PERMISSION', 'You cancelled the password dialog.'));
    // No --alert-response: Cancel, which Return and Escape pick in the real alert (D55).
    const r = await app(['--self-test', 'quit'], m.home);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Sharing is still on\. \| .* \| buttons: Cancel, Quit Anyway -> Cancel/);
    assert.match(r.stdout, /note: quit: cancelled/);
    assert.doesNotMatch(r.stdout, /exit: menu app quits/);
    assert.ok(r.stdout.includes('menu: Quit -> Quit\n'), 'Quit restored');
    const h = await healthOf(m.port);
    assert.equal(h?.pid, process.pid, 'server still running');
    assert.ok(existsSync(join(m.home, 'session.json')));
  });

  test('server not running (stale session.json) → started like the launcher, then opened', async () => {
    // A stub app root whose src/server.js is the mock (fakes only) in its own process.
    const root = mockServerRoot();
    // Stale session: a live Nidum server's port, but another pid and token → not reused.
    const other = await mock();
    const home = newHome();
    writeFileSync(join(home, 'session.json'), JSON.stringify({ port: other.port, token: 'f'.repeat(64), pid: 999999, startedAt: new Date().toISOString(), version: '1.0.0' }));
    const r = await app(['--self-test', 'open', '--app-root', root, '--node', process.execPath], home);
    const session = existsSync(join(home, 'session.json')) ? JSON.parse(readFileSync(join(home, 'session.json'), 'utf8')) : null;
    if (session?.pid && session.pid !== process.pid) strayPids.push(session.pid);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = lines(r.stdout);
    assert.ok(out.includes('note: server: not running; starting it'), r.stdout);
    assert.ok(out.includes(`server: starting ${join(root, 'src', 'server.js')} with ${process.execPath}`), r.stdout);
    assert.ok(out.includes('menu: Open Dashboard -> Starting Nidum Local… (disabled)'), r.stdout);
    assert.ok(out.some((l) => /^note: server: started \(pid \d+\)$/.test(l)), r.stdout);
    assert.ok(session && session.port !== other.port && session.pid !== 999999, 'a new server wrote session.json');
    assert.ok(out.includes(`open-url: http://127.0.0.1:${session.port}/?t=${session.token}`), r.stdout);
    const h = await healthOf(session.port);
    assert.equal(h?.pid, session.pid, 'the started server answers with its own pid');
    assert.notEqual(session.pid, process.pid);
    const log = readFileSync(join(home, 'server.log'), 'utf8');
    assert.match(log, /stub server up/, 'output appended to NIDUM_HOME/server.log');
    assert.ok(log.includes(`cwd ${root}`) || log.includes('cwd /private' + root), 'cwd is the app root');
    assert.ok(!log.includes(session.token), 'the token is never logged');
    assert.ok(!other.adapter.calls.length || !r.stdout.includes(String(other.port) + '/?t='), 'stale session not used');
    // Clean up through the API (the stub exits on /api/quit).
    await fetch(`http://127.0.0.1:${session.port}/api/quit`, { method: 'POST', headers: { 'x-nidum-token': session.token, 'content-type': 'application/json' }, body: '{}' });
  });

  test('server not running and no app root → alert, nothing started', async () => {
    const home = newHome();
    const r = await app(['--self-test', 'open', '--app-root', join(work, 'missing-root')], home);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Couldn't open Nidum Local\. \| Nidum Local's files weren't found\./);
    assert.ok(!existsSync(join(home, 'session.json')));
  });

  test('menu state: Stop disabled while sharing is off, enabled while on', async () => {
    const off = await mock({ scenario: 'stopped' });
    const a = await app(['--self-test', 'menu-state'], off.home);
    assert.equal(a.code, 0, a.stdout);
    assert.match(a.stdout, /sharing: off/);
    assert.match(a.stdout, /item: Stop All Services enabled=false/);
    assert.match(a.stdout, /item: Quit enabled=true/);
    const on = await mock();
    const b = await app(['--self-test', 'menu-state'], on.home);
    assert.match(b.stdout, /sharing: on/);
    assert.match(b.stdout, /item: Stop All Services enabled=true/);
  });

  test('menu state: Stop disabled while a sharing job runs', async () => {
    const m = await mock({ onElevate: () => new Promise((r) => setTimeout(r, 3000)) });
    const res = await fetch(`${m.url}api/proxy/restart`, { method: 'POST', headers: { 'x-nidum-token': m.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 202);
    const r = await app(['--self-test', 'menu-state'], m.home);
    assert.match(r.stdout, /item: Stop All Services enabled=false/);
  });

  test('menubar.lock: a symlink or a hard link is refused and its target left alone (finding 7)', async () => {
    const home = newHome();
    const victim = join(work, 'victim.txt');
    writeFileSync(victim, 'important user data\n');
    symlinkSync(victim, join(home, 'menubar.lock'));
    const r = await app(['--self-test', 'lock'], home);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /lock: first instance unusable: menubar\.lock is a symbolic link/);
    assert.equal(readFileSync(victim, 'utf8'), 'important user data\n');
    // A hard link to a file of this user's is refused, and the file is left alone
    // (validation 2 finding 3).
    const home3 = newHome();
    const victim2 = join(work, 'victim-hardlink.txt');
    writeFileSync(victim2, 'precious hard-linked data\n');
    linkSync(victim2, join(home3, 'menubar.lock'));
    const r3 = await app(['--self-test', 'lock'], home3);
    assert.equal(r3.code, 1, r3.stdout);
    assert.match(r3.stdout, /lock: first instance unusable: menubar\.lock is a hard link \(2 links\)/);
    assert.equal(readFileSync(victim2, 'utf8'), 'precious hard-linked data\n');
    // A directory in its place is refused too.
    const home2 = newHome();
    mkdirSync(join(home2, 'menubar.lock'));
    const r2 = await app(['--self-test', 'lock'], home2);
    assert.equal(r2.code, 1, r2.stdout);
    assert.match(r2.stdout, /unusable: menubar\.lock /);
  });

  test('single instance: a second lock holder is refused', async () => {
    const home = newHome();
    const r = await app(['--self-test', 'lock'], home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /lock: first instance holds the lock/);
    assert.match(r.stdout, /lock: second instance refused/);
    assert.match(r.stdout, /lock: after release acquired/);
  });

  // E12: service-managed proxies stop through the same endpoint (job `service-stop`).
  const e12 = typeof createFakeAdapter().stopService === 'function';
  test('Stop with a service-managed proxy (E12): service-stop job, password phase, sharing-paused', { skip: e12 ? false : 'the mock has no E12 stopService yet' }, async () => {
    const m = await mock({ scenario: 'mac-service', onElevate: () => new Promise((r) => setTimeout(r, 1200)) });
    const r = await app(['--self-test', 'stop'], m.home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /note: job: \S+ service-stop/);
    assert.match(r.stdout, /note: job: phase waitingForPassword/);
    assert.match(r.stdout, /menu: Stop All Services -> Waiting for your password… \(disabled\)/);
    assert.match(r.stdout, /note: banners: .*sharing-paused/);
    assert.ok(m.adapter.calls.some((c) => c.method === 'stopService'));
    const st = await stateOf(m);
    assert.equal(st.proxy.running, false);
    assert.ok(st.banners.some((b) => b.id === 'sharing-paused'));
  });

  // ---- P2: a dead pid is never trusted -----------------------------------------------
  test('session with a dead pid: not running, no request at all (not even health)', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise((r) => child.on('exit', r));
    assert.ok(!alive(deadPid));
    const home = newHome();
    const forged = await fakeServer({ home, pid: deadPid, handle: (req) => (req.url === '/api/state' ? { status: 200, json: stateBody(true) } : null) });
    try {
      const r = await app(['--self-test', 'menu-state'], home);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /sharing: unknown/);
      const s = await app(['--self-test', 'stop'], home);
      assert.equal(s.code, 1, s.stdout);
      assert.match(s.stdout, /Nidum Local's files weren't found/);
      assert.deepEqual(forged.requests, [], 'the forged server got nothing');
    } finally {
      await forged.close();
    }
  });

  // ---- validation 2 finding 2: another user's pid is never trusted --------------------
  test('session whose pid belongs to another user (EPERM): not ours, no request at all', async () => {
    // pid 1 is launchd (root): kill(1, 0) gives EPERM. The forger echoes that pid.
    assert.throws(() => process.kill(1, 0), (e) => e.code === 'EPERM');
    const home = newHome();
    const forged = await fakeServer({ home, pid: 1, handle: (req) => (req.url === '/api/state' ? { status: 200, json: stateBody(true) } : null) });
    try {
      const r = await app(['--self-test', 'menu-state'], home);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /sharing: unknown/);
      const o = await app(['--self-test', 'open'], home);
      assert.equal(o.code, 1, o.stdout);
      assert.doesNotMatch(o.stdout, /open-url/);
      assert.match(o.stdout, /Nidum Local's files weren't found/);
      const q = await app(['--self-test', 'quit'], home);
      assert.equal(q.code, 1, q.stdout);
      assert.deepEqual(forged.requests, [], 'the forged server got nothing, not even health');
    } finally {
      await forged.close();
    }
  });

  // ---- finding 3: no redirects with the token ----------------------------------------
  test('a 3xx answer is a failed request: the token never follows a redirect', async () => {
    const sink = await fakeServer();
    const home = newHome();
    const redirect = { status: 302, headers: { location: `http://127.0.0.1:${sink.port}/api/state` }, json: {} };
    const s = await fakeServer({ home, handle: (req) => (req.url === '/api/health' ? null : redirect) });
    try {
      const r = await app(['--self-test', 'stop'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Nidum Local answered with a redirect \(HTTP 302\)\./);
      const m = await app(['--self-test', 'menu-state'], home);
      assert.match(m.stdout, /sharing: unknown/);
      assert.ok(s.requests.some((q) => q.token === TOKEN), 'the pid-checked server did get the token');
      assert.deepEqual(sink.requests, [], 'nothing followed the redirect');
    } finally {
      await s.close();
      await sink.close();
    }
  });

  // ---- finding 2: the job poller always ends ----------------------------------------
  /** A server whose stop job is scripted by `polls` (one entry per GET /api/state after the POST). */
  async function scriptedStop(home, polls) {
    let posted = false;
    let n = 0;
    const server = await fakeServer({
      home,
      handle: (req) => {
        if (req.url === '/api/proxy/stop' && req.method === 'POST') {
          posted = true;
          return { status: 202, json: { job: jobOf('j1', 'stopping'), reused: false } };
        }
        if (req.url === '/api/state') {
          if (!posted) return { status: 200, json: stateBody(true) };
          const p = polls[Math.min(n++, polls.length - 1)];
          return typeof p === 'function' ? p() : p;
        }
        if (req.url === '/api/quit' && req.method === 'POST') return { status: 202, json: { ok: true } };
        return null;
      },
    });
    server.statePolls = () => n;
    return server;
  }

  test('job replaced by another job: stops polling with an alert, items restored', async () => {
    const home = newHome();
    const s = await scriptedStop(home, [
      { status: 200, json: stateBody(true, jobOf('j1', 'stopping')) },
      { status: 200, json: stateBody(true, jobOf('j2', 'done', true, 'start')) },
    ]);
    try {
      const t0 = Date.now();
      const r = await app(['--self-test', 'stop'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.ok(Date.now() - t0 < 10_000, 'ends quickly');
      assert.match(r.stdout, /note: job: replaced by j2 start/);
      assert.deepEqual(alertsOf(r.stdout), ["alert: Couldn't stop sharing. | Another sharing change started before this one finished. Open the dashboard to see whether sharing is on. | buttons: OK -> OK"]);
      assert.ok(r.stdout.includes('menu: Quit -> Quit\n'), 'Quit enabled again');
      assert.ok(r.stdout.includes('menu: Stop All Services -> Stop All Services\n'), 'Stop restored');
    } finally {
      await s.close();
    }
  });

  test('/api/state answers 401 during the job: alert at once', async () => {
    const home = newHome();
    const s = await scriptedStop(home, [{ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Not signed in.' } } }]);
    try {
      const r = await app(['--self-test', 'stop'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Nidum Local was restarted while this was running\./);
      assert.equal(s.statePolls(), 1);
    } finally {
      await s.close();
    }
  });

  test('/api/state answers 500 during the job: retried once after 1 s, then an alert', async () => {
    const home = newHome();
    const s = await scriptedStop(home, [{ status: 500, json: { error: { code: 'INTERNAL', message: 'Something broke.' } } }]);
    try {
      const r = await app(['--self-test', 'stop'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /note: job: \/api\/state answered HTTP 500; retrying once/);
      assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Something broke\. \| buttons: OK -> OK/);
      assert.equal(s.statePolls(), 2);
    } finally {
      await s.close();
    }
  });

  test('a job that never ends: overall deadline, alert, Quit enabled again', async () => {
    const home = newHome();
    const s = await scriptedStop(home, [{ status: 200, json: stateBody(true, jobOf('j1', 'stopping')) }]);
    try {
      const t0 = Date.now();
      const r = await app(['--self-test', 'stop', '--job-wait', '1.5'], home);
      const took = Date.now() - t0;
      assert.equal(r.code, 1, r.stdout);
      assert.ok(took >= 1400 && took < 8000, `gave up after about 1.5 s (${took} ms)`);
      assert.match(r.stdout, /note: job: no result within 1 s; giving up/);
      assert.match(r.stdout, /alert: Couldn't stop sharing\. \| This is taking longer than expected\./);
      assert.ok(r.stdout.includes('menu: Quit -> Quit\n'), 'Quit enabled again');
    } finally {
      await s.close();
    }
  });

  test('the password phase extends the deadline (by --password-wait), then the job finishes', async () => {
    const home = newHome();
    const t0 = Date.now();
    const s = await scriptedStop(home, [
      () => (Date.now() - t0 < 2500
        ? { status: 200, json: stateBody(true, jobOf('j1', 'waitingForPassword')) }
        : { status: 200, json: stateBody(false, jobOf('j1', 'done', true)) }),
    ]);
    try {
      const r = await app(['--self-test', 'stop', '--job-wait', '1', '--password-wait', '6'], home);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /menu: Stop All Services -> Waiting for your password… \(disabled\)/);
      assert.match(r.stdout, /note: job: phase done/);
      assert.ok(Date.now() - t0 >= 2400);
    } finally {
      await s.close();
    }
  });

  // ---- finding 4: Quit reports a server that didn't quit -----------------------------
  test('Quit: /api/quit refused (500) → "Nidum Local didn\'t quit.", non-zero exit either way', async () => {
    const home = newHome();
    const s = await fakeServer({
      home,
      handle: (req) => {
        if (req.url === '/api/state') return { status: 200, json: stateBody(false) };
        if (req.url === '/api/quit') return { status: 500, json: { error: { code: 'INTERNAL', message: 'Could not quit.' } } };
        return null;
      },
    });
    try {
      const r = await app(['--self-test', 'quit'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.deepEqual(alertsOf(r.stdout), ["alert: Nidum Local didn't quit. | Could not quit. | buttons: Cancel, Quit Anyway -> Cancel"]);
      assert.doesNotMatch(r.stdout, /exit: menu app quits/);
      const a = await app(['--self-test', 'quit', '--alert-response', 'Quit Anyway'], home);
      assert.equal(a.code, 1, a.stdout);
      assert.match(a.stdout, /exit: menu app quits/);
      assert.match(a.stdout, /result: failed/);
    } finally {
      await s.close();
    }
  });

  test('Quit: server still answers after the quit wait → alert, exit 1', async () => {
    const home = newHome();
    const s = await fakeServer({
      home,
      handle: (req) => {
        if (req.url === '/api/state') return { status: 200, json: stateBody(false) };
        if (req.url === '/api/quit') return { status: 202, json: { ok: true } };
        return null;
      },
    });
    try {
      const r = await app(['--self-test', 'quit', '--quit-wait', '1'], home);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /note: server: still answering after 1 s/);
      assert.match(r.stdout, /alert: Nidum Local didn't quit\. \| Nidum Local is still running after it was asked to quit\./);
    } finally {
      await s.close();
    }
  });

  // ---- P3: a late server started for Stop or Quit is stopped -------------------------
  test('Stop: a started server that misses the start deadline gets SIGTERM before the alert', async () => {
    const home = newHome();
    const marker = join(work, `silent-${Date.now()}.pid`);
    const root = silentServerRoot(marker);
    const r = await app(['--self-test', 'stop', '--app-root', root, '--node', process.execPath, '--start-wait', '1.5'], home);
    const pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    if (pid) strayPids.push(pid);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(pid > 0, 'the stub server ran');
    assert.match(r.stdout, new RegExp(`note: server: no answer within 1 s; sent SIGTERM to pid ${pid}`));
    assert.match(r.stdout, /alert: Couldn't stop sharing\. \| Nidum Local didn't start within 10 seconds\./);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(!alive(pid), 'the late server was stopped');
  });

  // ---- finding 5: Node 18 or newer only ------------------------------------------------
  test('Node lookup skips a Node older than 18; an explicit old --node is refused', async () => {
    const old = mkdtempSync(join(work, 'old-node-'));
    writeFileSync(join(old, 'node'), '#!/bin/sh\necho v16.20.2\nexit 0\n');
    chmodSync(join(old, 'node'), 0o755);
    const r = await app(['--self-test', 'open', '--app-root', mockServerRoot(), '--node', join(old, 'node')], newHome());
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Couldn't open Nidum Local\. \| Nidum Local needs Node\.js 18 or newer/);
    assert.ok(r.stdout.includes(`Checked: ${join(old, 'node')} is v16.20.2.`), r.stdout);
    assert.doesNotMatch(r.stdout, /server: starting/);
    // PATH lookup: the old one comes first and is skipped for the next one.
    const good = mkdtempSync(join(work, 'good-node-'));
    symlinkSync(process.execPath, join(good, 'node'));
    const home = newHome();
    const p = await app(['--self-test', 'open', '--app-root', mockServerRoot()], home, { PATH: `${old}:${good}:/usr/bin:/bin` });
    const session = existsSync(join(home, 'session.json')) ? JSON.parse(readFileSync(join(home, 'session.json'), 'utf8')) : null;
    if (session?.pid) strayPids.push(session.pid);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, new RegExp(`server: starting .* with ${join(good, 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    if (session) await fetch(`http://127.0.0.1:${session.port}/api/quit`, { method: 'POST', headers: { 'x-nidum-token': session.token, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  });

  // ---- finding 6: concurrent builds -----------------------------------------------------
  test('two concurrent builds into one output: one valid bundle, both exit 0, nothing left over', async () => {
    const out = join(work, 'concurrent', 'Nidum Local Menu.app');
    const env = { NIDUM_MENUBAR_ARCHS: 'native' };
    const [a, b] = await Promise.all([
      run('/bin/bash', [BUILD, out], { env, timeout: 900_000 }),
      run('/bin/bash', [BUILD, out], { env, timeout: 900_000 }),
    ]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    const both = a.stdout + b.stdout;
    assert.match(both, /build-menubar\.sh: built /);
    // Whichever waited took the other's new bundle (or built again if it got there first).
    assert.ok(/another build put a valid bundle of version .* while this one waited; nothing to do/.test(both) || (both.match(/built /g) ?? []).length === 2, both);
    assert.deepEqual(readdirSync(out), ['Contents'], 'nothing stray at the bundle root');
    const verify = await run('codesign', ['--verify', '--strict', out], { timeout: 30_000 });
    assert.equal(verify.code, 0, verify.stderr);
    assert.deepEqual(readdirSync(dirname(out)), ['Nidum Local Menu.app'], 'no build dirs or lock files left');
  });

  // ---- validation 2 finding 4 / D55: Return and Escape pick Cancel -------------------
  /** Whether this run has a GUI (Aqua) session, so a window server to talk to. */
  const guiSession = () => spawnSync('launchctl', ['managername'], { timeout: 10_000, encoding: 'utf8' }).stdout?.trim() === 'Aqua';

  test('the quit alert (D55): Cancel has Return and is the default, Escape picks Cancel, odd responses are Cancel', async (t) => {
    const r = await app(['--self-test', 'alert-keys'], newHome());
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = lines(r.stdout);
    const skipped = out.find((l) => l.startsWith('skipped: '));
    if (skipped) {
      // Only without a window server (ssh, CI); in a GUI session a skip is a failure.
      assert.ok(!guiSession(), `skipped in a GUI session: ${skipped}`);
      assert.match(skipped, /window-server connection/);
      t.skip(skipped);
      return;
    }
    assert.ok(out.includes('button: Cancel key=return default=true destructive=false'), r.stdout);
    assert.ok(out.includes('button: Quit Anyway key=none default=false destructive=true'), r.stdout);
    for (const k of ['return', 'enter', 'escape', 'command-.']) assert.ok(out.includes(`key: ${k} -> Cancel`), `${k}:\n${r.stdout}`);
    assert.ok(out.includes('key: q -> none'), r.stdout);
    for (const resp of ['abort', 'stop', 'cancel', 'OK', 'fourth button']) assert.ok(out.includes(`response: ${resp} -> Cancel`), `${resp}:\n${r.stdout}`);
    assert.ok(out.includes('response: second button -> Quit Anyway'), r.stdout);
    // The real key monitor (validation 3 finding 3), driven with synthesized key-downs:
    // it clicks Cancel only for keys sent to the alert's own window, keeps those keys,
    // passes everything else on, and is gone once removed.
    const monitor = out.filter((l) => l.startsWith('monitor: '));
    assert.deepEqual(monitor, [
      'monitor: windows alert=true other=true distinct=true',
      'monitor: return in alert -> Cancel (held back)',
      'monitor: enter in alert -> Cancel (held back)',
      'monitor: escape in alert -> Cancel (held back)',
      'monitor: command-. in alert -> Cancel (held back)',
      'monitor: q in alert -> none (passed on)',
      'monitor: return in other window -> none (passed on)',
      'monitor: escape in other window -> none (passed on)',
      'monitor: escape after removal -> none (not seen)',
    ], r.stdout);
    assert.ok(out.includes('result: ok'), r.stdout);
  });

  test('self-test alerts: an unknown --alert-response counts as Cancel, never Quit Anyway', async () => {
    const m = await mock();
    m.adapter.failNext('stopProxy', new PortlessError('PERMISSION', 'You cancelled the password dialog.'));
    const r = await app(['--self-test', 'quit', '--alert-response', 'Something Else'], m.home);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Sharing is still on\. \| .* \| buttons: Cancel, Quit Anyway -> Cancel/);
    assert.doesNotMatch(r.stdout, /exit: menu app quits/);
    assert.equal((await healthOf(m.port))?.pid, process.pid, 'server still running');
  });

  // ---- validation 2 finding 5: Node lookup is bounded --------------------------------
  /** A `node` that never answers, ignores SIGTERM and starts a child that does too; it logs "<pid> <child pid>" to `marker`. */
  function hangingNode(marker) {
    const dir = mkdtempSync(join(work, 'hang-node-'));
    writeFileSync(join(dir, 'node'), `#!/bin/sh\ntrap '' TERM\nsleep 41 &\necho "$$ $!" >> '${marker}'\nwait\n`);
    chmodSync(join(dir, 'node'), 0o755);
    return dir;
  }
  const pidsIn = (marker) => (existsSync(marker) ? readFileSync(marker, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);

  test('Node lookup: a hanging --node is killed (with its child), asked once more, and reported as no answer, not "older"', async () => {
    const marker = join(work, `hang-${Date.now()}-a.pids`);
    const dir = hangingNode(marker);
    const t0 = Date.now();
    const r = await app(['--self-test', 'open', '--app-root', mockServerRoot(), '--node', join(dir, 'node')], newHome());
    const took = Date.now() - t0;
    const pids = pidsIn(marker);
    strayPids.push(...pids);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /alert: Couldn't open Nidum Local\. \| Node\.js didn't answer in time when Nidum Local checked its version\. Checked: .*\/node didn't answer within 4\.0 s, nor within 0\.\d s when asked again\. Open Nidum Local/);
    assert.doesNotMatch(r.stdout, /older version/);
    assert.ok(took >= 4500 && took < 9000, `4 s, the kill, then a second try with the rest of the 5 s budget (${took} ms)`);
    assert.equal(pids.length, 4, `the stub and its child ran twice: ${pids}`);
    for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(pids.filter(alive), [], 'nothing left running');
  });

  test('Node lookup: a hanging candidate in PATH costs ≤ 4 s and the lookup ≈ 5 s in all; Quit comes back', async () => {
    const good = mkdtempSync(join(work, 'good-node-'));
    symlinkSync(process.execPath, join(good, 'node'));
    // One hanging, then a good one: the good one is used with what is left of the budget.
    const m1 = join(work, `hang-${Date.now()}-b.pids`);
    const home = newHome();
    let t0 = Date.now();
    const p = await app(['--self-test', 'open', '--app-root', mockServerRoot()], home, { PATH: `${hangingNode(m1)}:${good}:/usr/bin:/bin` });
    let took = Date.now() - t0;
    const session = existsSync(join(home, 'session.json')) ? JSON.parse(readFileSync(join(home, 'session.json'), 'utf8')) : null;
    if (session?.pid) strayPids.push(session.pid);
    strayPids.push(...pidsIn(m1));
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, new RegExp(`server: starting .* with ${join(good, 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.ok(took >= 4000 && took < 12000, `one hang costs about 4.3 s (${took} ms)`);
    if (session) await fetch(`http://127.0.0.1:${session.port}/api/quit`, { method: 'POST', headers: { 'x-nidum-token': session.token, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    const pids1 = pidsIn(m1);
    assert.equal(pids1.length, 2, `the hanging candidate and its child ran: ${pids1}`);
    for (let i = 0; i < 40 && pids1.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(pids1.filter(alive), [], 'nothing left running');
    // Four hanging first: the lookup stops at its 5 s budget and says Node didn't answer.
    // Quit (the action that stays disabled meanwhile) is enabled again at the end.
    const m2 = join(work, `hang-${Date.now()}-c.pids`);
    const hangs = [1, 2, 3, 4].map(() => hangingNode(m2));
    t0 = Date.now();
    const q = await app(['--self-test', 'stop', '--app-root', mockServerRoot()], newHome(), { PATH: `${hangs.join(':')}:${good}:/usr/bin:/bin` });
    took = Date.now() - t0;
    const pids = pidsIn(m2);
    strayPids.push(...pids);
    assert.equal(q.code, 1, q.stdout);
    assert.match(q.stdout, /alert: Couldn't stop sharing\. \| Node\.js didn't answer in time when Nidum Local checked its version\. Checked: .*\/node didn't answer within 4\.0 s; .*\/node didn't answer within 0\.\d s; the search stopped at its 5 s limit\./);
    assert.doesNotMatch(q.stdout, /server: starting/);
    assert.ok(took >= 4500 && took < 9000, `stopped at the 5 s budget (${took} ms)`);
    assert.ok(q.stdout.includes('menu: Quit -> Quit\n'), 'Quit enabled again');
    assert.ok(pids.length >= 4 && pids.length <= 6, `two or three candidates ran: ${pids}`);
    for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(pids.filter(alive), [], 'nothing left running');
  });

  // ---- validation 3 finding 2: a working Node is never refused ------------------------
  /** Runs Open with `--node <shim>` against the mock server and stops the server after. */
  async function openWithNode(node) {
    const home = newHome();
    const t0 = Date.now();
    const r = await app(['--self-test', 'open', '--app-root', mockServerRoot(), '--node', node], home);
    const took = Date.now() - t0;
    const session = existsSync(join(home, 'session.json')) ? JSON.parse(readFileSync(join(home, 'session.json'), 'utf8')) : null;
    if (session?.pid) strayPids.push(session.pid);
    if (session) await fetch(`http://127.0.0.1:${session.port}/api/quit`, { method: 'POST', headers: { 'x-nidum-token': session.token, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    return { ...r, took };
  }
  /** A `node` shim: `body` (sh) runs first, then the real Node. */
  function nodeShim(name, body) {
    const dir = mkdtempSync(join(work, `${name}-node-`));
    writeFileSync(join(dir, 'node'), `#!/bin/sh\n${body}\nexec '${process.execPath}' "$@"\n`);
    chmodSync(join(dir, 'node'), 0o755);
    return join(dir, 'node');
  }
  const startedWith = (node) => new RegExp(`server: starting .* with ${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');

  test('Node lookup: a --node whose first run is slow (about 1.2 s, a cold start after an install) is used', async () => {
    const mark = join(work, `slow-${Date.now()}.mark`);
    const node = nodeShim('slow', `if [ ! -e '${mark}' ]; then : > '${mark}'; sleep 1.2; fi`);
    const r = await openWithNode(node);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, startedWith(node));
    assert.ok(existsSync(mark), 'the slow first run happened');
    assert.ok(r.took >= 1200, `${r.took} ms`);
  });

  test('Node lookup: a --node that times out once is asked again, and its second answer is used', async () => {
    const mark = join(work, `retry-${Date.now()}.mark`);
    const marker = join(work, `retry-${Date.now()}.pids`);
    const node = nodeShim('retry', `if [ ! -e '${mark}' ]; then : > '${mark}'; trap '' TERM; sleep 41 & echo "$$ $!" >> '${marker}'; wait; fi`);
    const r = await openWithNode(node);
    const pids = pidsIn(marker);
    strayPids.push(...pids);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, startedWith(node));
    assert.ok(r.took >= 4000, `the first try ran into its 4 s limit (${r.took} ms)`);
    assert.equal(pids.length, 2, `the hanging first run and its child: ${pids}`);
    for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(pids.filter(alive), [], 'the first run was killed with its child');
  });

  test('Node lookup: a shim that leaves a child holding stdout still has its version read', async () => {
    const marker = join(work, `hold-${Date.now()}.pids`);
    // Every run leaves a `sleep` behind with the shim's stdout (the version pipe) open.
    const node = nodeShim('hold', `sleep 41 & echo $! >> '${marker}'`);
    const r = await openWithNode(node);
    const pids = pidsIn(marker);
    strayPids.push(...pids);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, startedWith(node));
    assert.doesNotMatch(r.stdout, /wasn't found|didn't answer/);
    assert.ok(pids.length >= 1, 'the shim left a child behind');
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  test('Node lookup: each failure of the launcher\'s --node is reported precisely', async () => {
    const dir = mkdtempSync(join(work, 'bad-nodes-'));
    const stub = (name, body) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
      return join(dir, name);
    };
    const notExec = join(dir, 'not-exec');
    writeFileSync(notExec, 'v22.0.0\n');
    const cases = [
      [stub('hello', 'echo hello'), /The Node\.js that Nidum Local was set up with didn't work\. Checked: .*\/hello printed "hello", not a Node\.js version\./],
      [stub('exit3', 'echo v22.1.0; exit 3'), /The Node\.js that Nidum Local was set up with didn't work\. Checked: .*\/exit3 exited with status 3 after printing "v22\.1\.0"\./],
      [stub('silent', 'exit 4'), /Checked: .*\/silent exited with status 4 without printing a version\./],
      [stub('killed', 'kill -9 $$'), /Checked: .*\/killed was stopped by signal 9\./],
      [notExec, /The Node\.js that Nidum Local was set up with wasn't found\. Checked: .*\/not-exec isn't a file that can be run\./],
      [join(dir, 'missing'), /wasn't found\. Checked: .*\/missing isn't a file that can be run\./],
    ];
    for (const [node, want] of cases) {
      const r = await app(['--self-test', 'open', '--app-root', mockServerRoot(), '--node', node], newHome());
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, want);
      assert.match(r.stdout, /Open Nidum Local from its folder once, then try again\. \| buttons: OK/);
      assert.doesNotMatch(r.stdout, /server: starting/);
    }
  });

  // ---- validation 2 finding 6: the build lock is per output --------------------------
  test('builds of two outputs in one folder run side by side; a waiter builds unless a new bundle appeared', async () => {
    const dir = join(work, 'two-outputs');
    const env = { NIDUM_MENUBAR_ARCHS: 'native' };
    const [a, b] = await Promise.all([
      run('/bin/bash', [BUILD, join(dir, 'A.app')], { env, timeout: 900_000 }),
      run('/bin/bash', [BUILD, join(dir, 'B.app')], { env, timeout: 900_000 }),
    ]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(a.stdout, /build-menubar\.sh: built .*A\.app/);
    assert.match(b.stdout, /build-menubar\.sh: built .*B\.app/);
    assert.doesNotMatch(a.stdout + b.stdout, /waiting/);
    assert.deepEqual(readdirSync(dir).sort(), ['A.app', 'B.app'], 'no lock or work folders left');
    // Someone else holds B.app's lock and puts nothing new in place: the waiter builds.
    const lockDir = join(dir, '.B.app.lock');
    mkdirSync(lockDir);
    const holder = spawn('perl', ['-MFcntl=:flock', '-e', '$| = 1; open(my $f, "<", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; sleep 2', lockDir], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((res) => holder.stdout.once('data', res));
    const inode = statSync(join(dir, 'B.app')).ino;
    const w = await run('/bin/bash', [BUILD, join(dir, 'B.app')], { env, timeout: 900_000 });
    assert.equal(w.code, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /another build of B\.app is running; waiting for it/);
    assert.match(w.stdout, /build-menubar\.sh: built .*B\.app/, 'the existing bundle was not taken as just built');
    assert.notEqual(statSync(join(dir, 'B.app')).ino, inode, 'a new bundle');
    assert.deepEqual(readdirSync(dir).sort(), ['A.app', 'B.app']);
  });

  test('a build killed with SIGKILL: the next build waits for its tools, sweeps its work folder, builds', async () => {
    const dir = join(work, 'killed');
    const out = join(dir, 'Nidum Local Menu.app');
    const env = { ...process.env, NIDUM_MENUBAR_ARCHS: 'native' };
    const victim = spawn('/bin/bash', [BUILD, out], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => victim.stdout.on('data', (d) => String(d).includes('compiling') && res()));
    process.kill(victim.pid, 'SIGKILL'); // the script only: its swiftc carries on, holding the lock
    await new Promise((res) => victim.on('exit', res));
    const left = readdirSync(dir).sort();
    assert.ok(left.some((f) => /^\.Nidum Local Menu\.app\.build\.\w{6}$/.test(f)), `work folder left: ${left}`);
    assert.ok(left.includes('.Nidum Local Menu.app.lock'), `lock folder left: ${left}`);
    const r = await run('/bin/bash', [BUILD, out], { env: { NIDUM_MENUBAR_ARCHS: 'native' }, timeout: 900_000 });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /build-menubar\.sh: built /);
    assert.doesNotMatch(r.stdout, /nothing to do/);
    assert.deepEqual(readdirSync(dir), ['Nidum Local Menu.app'], 'work and lock folders gone');
    const verify = await run('codesign', ['--verify', '--strict', out], { timeout: 30_000 });
    assert.equal(verify.code, 0, verify.stderr);
  });

  // ---- validation 3 finding 1: a build that arrives as another one finishes -----------
  test('a build that arrives as another build of the same output removes its lock folder retries, never fails', async () => {
    // A fake swiftc ends each build right after the lock stage ("compiling" = got the lock).
    const bin = mkdtempSync(join(work, 'fake-swiftc-'));
    writeFileSync(join(bin, 'swiftc'), '#!/bin/sh\necho "fake swiftc" >&2\nexit 7\n');
    chmodSync(join(bin, 'swiftc'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, NIDUM_MENUBAR_ARCHS: 'native' };
    const runs = 120;
    const outcomes = {};
    const one = async () => {
      const dir = mkdtempSync(join(work, 'race-'));
      const lock = join(dir, '.X.app.lock');
      // The other build: makes the folder, locks it, works 0–80 ms, removes it while it
      // still holds it, and exits (as build-menubar.sh does).
      const holder = run('perl', ['-MFcntl=:flock', '-MTime::HiRes=sleep', '-e',
        'mkdir $ARGV[0], 0700 or die "mkdir: $!"; open(my $f, "<", $ARGV[0]) or die; flock($f, LOCK_EX) or die; sleep($ARGV[1] / 1000); rmdir $ARGV[0] or die "rmdir: $!"',
        lock, String(Math.floor(Math.random() * 81))], { timeout: 30_000 });
      await new Promise((res) => setTimeout(res, 10));
      const b = await run('/bin/bash', [BUILD, join(dir, 'X.app')], { env, timeout: 60_000 });
      const h = await holder;
      const out = b.stdout + b.stderr;
      const k = h.code !== 0 ? `holder failed: ${h.stderr.trim()}` : /compiling/.test(out) && /fake swiftc/.test(out) ? 'locked' : `exit ${b.code}: ${out.trim().split('\n').pop()}`;
      outcomes[k] = (outcomes[k] ?? 0) + 1;
      rmSync(dir, { recursive: true, force: true });
    };
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next++ < runs) await one();
    }));
    assert.deepEqual(outcomes, { locked: runs });
  });

  test('the build lock still refuses a symlink, a file, or a folder it can\'t create', async () => {
    const env = { NIDUM_MENUBAR_ARCHS: 'native' };
    const link = mkdtempSync(join(work, 'lock-link-'));
    symlinkSync(work, join(link, '.X.app.lock'));
    let r = await run('/bin/bash', [BUILD, join(link, 'X.app')], { env, timeout: 60_000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.X\.app\.lock is a symlink, not a folder; remove it and try again/);
    const file = mkdtempSync(join(work, 'lock-file-'));
    writeFileSync(join(file, '.X.app.lock'), '');
    r = await run('/bin/bash', [BUILD, join(file, 'X.app')], { env, timeout: 60_000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.X\.app\.lock isn't a folder; remove it and try again/);
    const ro = mkdtempSync(join(work, 'lock-ro-'));
    chmodSync(ro, 0o555);
    r = await run('/bin/bash', [BUILD, join(ro, 'X.app')], { env, timeout: 60_000 });
    chmodSync(ro, 0o755);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /can't create .*\.X\.app\.lock: Permission denied/);
    assert.doesNotMatch(r.stderr, /kept disappearing/);
  });
});
