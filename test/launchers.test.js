// N5 launcher harness. Runs the macOS and Linux launchers under /bin/bash (3.2 on macOS) with a
// fake PATH: stub node/portless/curl/brew/npm/open/xdg-open/sudo plus a short allowlist of
// harmless system tools. HOME, NIDUM_HOME, PORTLESS_STATE_DIR, the service plist/unit and TMPDIR
// all point into a temp folder, and the environment is built from scratch (nothing inherited),
// so no test can install software, start a proxy or server, open a browser, or touch real state.
// The guard snapshot is compared before and after the whole file.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
  copyFileSync, chmodSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, compare } from './helpers/guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures', 'launchers');
const STUBS = join(FIX, 'stubs');
const MAC = join(ROOT, 'launchers', 'macos', 'Nidum Local.command');
const LINUX = join(ROOT, 'launchers', 'linux', 'nidum-local.sh');
const CORE = join(ROOT, 'launchers', 'lib', 'nidum-launcher.sh');
const SHIM = join(ROOT, 'Nidum Local.command');
const PS1 = join(ROOT, 'launchers', 'windows', 'nidum-local.ps1');
const CMD = join(ROOT, 'launchers', 'windows', 'Nidum Local.cmd');
const DESKTOP = join(ROOT, 'launchers', 'linux', 'nidum-local.desktop');
const PACKAGE = join(ROOT, 'scripts', 'package.sh');
const TOKEN = 'ab'.repeat(32);
const SERVER_TOKEN = 'cd'.repeat(32);
const BASH = '/bin/bash';
const UID = process.getuid();

// Harmless tools the launcher and stubs may use. open, curl, sudo, launchctl, osascript,
// brew, npm, node and portless are deliberately absent: only stubs answer to those names.
const SYS_TOOLS = [
  'basename', 'cat', 'chmod', 'cp', 'date', 'dirname', 'grep', 'head', 'mkdir', 'mktemp', 'mv',
  'readlink', 'rm', 'sed', 'sleep', 'tail', 'tee', 'touch', 'tr', 'wc',
  'perl', // the launcher's millisecond clock (Time::HiRes) for the service-wait deadline
  'id', // the menu app check takes the uid from id -u, never from an inherited $UID
];
const DEFAULT_STUBS = ['node', 'portless', 'curl', 'open', 'brew', 'npm', 'launchctl'];
const BUILD_STUB = join(FIX, 'build-menubar.sh');

const sandboxes = [];
let guardBefore;

before(() => { guardBefore = snapshot(); });
after(() => {
  for (const sb of sandboxes) rmSync(sb.dir, { recursive: true, force: true });
  assert.deepEqual(compare(guardBefore, snapshot()), [], 'real Portless / Nidum state changed');
});

function whichSystem(tool) {
  for (const d of ['/bin', '/usr/bin']) if (existsSync(join(d, tool))) return join(d, tool);
  throw new Error(`system tool not found: ${tool}`);
}

/**
 * Builds an isolated sandbox. Options:
 *   platform 'macos' | 'linux'; stubs: names copied into the stub bin; service: { port } writes a
 *   fake service file; stateFromService: leave PORTLESS_STATE_DIR unset so it comes from the plist;
 *   defaultHome: leave NIDUM_HOME unset; appRoot: false to leave NIDUM_APP_ROOT unset; env: extras.
 */
function sandbox(opts = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nidum-n5-')));
  sandboxes.push({ dir });
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const sysbin = join(dir, 'sysbin');
  const state = join(dir, 'stub-state');
  const tmp = join(dir, 'tmp');
  const app = join(dir, 'app');
  const portlessState = join(dir, 'portless-state');
  for (const d of [home, bin, sysbin, state, tmp, join(app, 'src'), portlessState]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'src', 'server.js'), '// placeholder: the stub node never runs it\n');
  for (const s of opts.stubs ?? DEFAULT_STUBS) {
    copyFileSync(join(STUBS, s), join(bin, s));
    chmodSync(join(bin, s), 0o755);
  }
  for (const t of SYS_TOOLS) symlinkSync(whichSystem(t), join(sysbin, t));

  const platform = opts.platform ?? 'macos';
  const servicePath = join(dir, platform === 'linux' ? 'portless.service' : 'sh.portless.proxy.plist');
  if (opts.service) {
    const tpl = readFileSync(join(FIX, platform === 'linux' ? 'portless.service.template' : 'sh.portless.proxy.plist.template'), 'utf8');
    writeFileSync(servicePath, tpl.replaceAll('__PORT__', String(opts.service.port)).replaceAll('__STATE_DIR__', portlessState));
  }
  const nidumHome = join(home, '.nidum-local');
  const env = {
    PATH: `${bin}:${sysbin}`,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    NIDUM_EXTRA_PATH: '',
    NIDUM_SERVICE_PLIST: platform === 'macos' ? servicePath : join(dir, 'unused.plist'),
    NIDUM_SERVICE_UNIT: platform === 'linux' ? servicePath : join(dir, 'unused.service'),
    STUB_LOG: join(dir, 'calls.log'),
    STUB_STATE: state,
    STUB_BIN: bin,
    STUB_SRC: STUBS,
    // The launcher's own `node -e` helpers (state.json reader, own-session spawn) run on this
    // test runner's Node; the only process they ever start is the stub server.
    STUB_REAL_NODE: process.execPath,
    NIDUM_SERVICE_WAIT: '1',
    NIDUM_NO_MENUBAR: '1', // menu bar tests turn it back on
  };
  if (!opts.defaultHome) env.NIDUM_HOME = nidumHome;
  if (opts.appRoot !== false) env.NIDUM_APP_ROOT = app;
  if (!opts.stateFromService) env.PORTLESS_STATE_DIR = portlessState;
  Object.assign(env, opts.env ?? {});
  writeFileSync(env.STUB_LOG, '');

  return {
    dir, home, bin, app, state, nidumHome, portlessState, env,
    script: platform === 'linux' ? LINUX : MAC,
    /** A Portless proxy answering on `port` (HEAD / has X-Portless: 1). */
    proxyUp(port, { lan = true, tls = false } = {}) {
      writeFileSync(join(state, `proxy-${port}`), tls ? 'https' : 'http');
      writeFileSync(join(portlessState, 'proxy.port'), `${port}\n`);
      if (lan) writeFileSync(join(portlessState, 'proxy.lan'), '192.168.1.42\n');
      if (tls) writeFileSync(join(portlessState, 'proxy.tls'), '');
    },
    /** A running dashboard: session.json + /api/health answering for `port`. */
    dashboardUp(port = 47811, app = 'nidum-local') {
      mkdirSync(nidumHome, { recursive: true });
      writeFileSync(join(nidumHome, 'session.json'),
        `{"port":${port},"token":"${TOKEN}","pid":4321,"startedAt":"2026-10-15T07:00:00.000Z","version":"1.0.0"}\n`);
      writeFileSync(join(state, `health-${port}`), `{"ok":true,"app":"${app}","version":"1.0.0","pid":4321}`);
    },
    /** Writes $NIDUM_HOME/state.json (a string is written as-is). */
    stateJson(content) {
      mkdirSync(nidumHome, { recursive: true });
      writeFileSync(join(nidumHome, 'state.json'), typeof content === 'string' ? content : JSON.stringify(content));
    },
    calls() { return readFileSync(env.STUB_LOG, 'utf8').split('\n').filter(Boolean); },
    log() {
      const f = join(env.NIDUM_HOME ?? nidumHome, 'launcher.log');
      return existsSync(f) ? readFileSync(f, 'utf8') : '';
    },
  };
}

/** Runs a launcher under /bin/bash, feeding `input` on stdin. */
function run(sb, { script = sb.script, input = '', timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(BASH, [script], { env: sb.env, cwd: sb.home });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`launcher timed out\n${out}\n${err}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const MENU_ID = 'io.nidum.local.menu'; // CFBundleIdentifier in macos/menubar/Info.plist (D58)

/** A minimal .app bundle: Info.plist with an executable name, a bundle id and a version (no executable file). */
function fakeBundle(app, { version, exec = 'NidumLocalMenu', id = MENU_ID }) {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>${exec}</string>
\t<key>CFBundleIdentifier</key>
\t<string>${id}</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
</dict>
</plist>
`);
}

const promptLines = (out) => out.split('\n').filter((l) => /^ {2}\? /.test(l));
const has = (calls, re) => calls.some((c) => re.test(c));

// ------------------------------------------------------------------ static checks

describe('syntax and portability', () => {
  test('/bin/bash is 3.2 here, and -n passes for every bash file (criterion 1)', () => {
    const v = execFileSync(BASH, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.match(v, /^3\.2\./, `expected /bin/bash 3.2, got ${v}`);
    for (const f of [SHIM, MAC, LINUX, CORE, PACKAGE, join(FIX, 'build-menubar.sh'), ...readdirSync(STUBS).map((s) => join(STUBS, s))]) {
      execFileSync(BASH, ['-n', f], { timeout: 5000 });
    }
  });

  test('no bash 4+ constructs and no apostrophe inside "${var:-...}" (bash 3.2 parse trap)', () => {
    for (const f of [SHIM, MAC, LINUX, CORE, PACKAGE]) {
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      for (const re of [/declare -A/, /local -A/, /\bmapfile\b/, /\breadarray\b/, /\$\{\w+,,\}/, /\$\{\w+\^\^\}/, /\|&/, /&>>/, /\bcoproc\b/, /\[\[ -v/]) {
        assert.doesNotMatch(src, re, `${f} uses ${re}`);
      }
      assert.doesNotMatch(src, /\$\{\w+:-[^}]*'/, `${f}: apostrophe inside \${var:-...}`);
    }
  });

  test('entry scripts are executable and use #!/bin/bash', () => {
    for (const f of [SHIM, MAC, LINUX, PACKAGE]) {
      assert.ok(statSync(f).mode & 0o111, `${f} not executable`);
      assert.ok(readFileSync(f, 'utf8').startsWith('#!/bin/bash\n'), `${f} shebang`);
    }
  });

  test('README.txt has at most 10 lines and labels Windows/Linux experimental', () => {
    const lines = readFileSync(join(ROOT, 'README.txt'), 'utf8').replace(/\n$/, '').split('\n');
    assert.ok(lines.length <= 10, `${lines.length} lines`);
    assert.match(lines.join('\n'), /Windows \(experimental\)/);
    assert.match(lines.join('\n'), /Linux \(experimental\)/);
  });

  test('Windows files (unverified: no pwsh here): .cmd uses CRLF, .ps1 is ASCII and follows the contract', () => {
    const cmd = readFileSync(CMD, 'latin1');
    assert.ok(cmd.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), '.cmd must use CRLF');
    assert.match(cmd, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0nidum-local\.ps1"/);
    assert.match(cmd, /if not "%NIDUM_EXIT%"=="0" if not "%NIDUM_EXIT%"=="3" \(\r\n[\s\S]*?pause\r\n\)/, 'pauses when PowerShell itself fails');
    assert.match(cmd, /where powershell\.exe[\s\S]*?pause/, 'explains a missing PowerShell');
    const ps = readFileSync(PS1, 'latin1');
    assert.doesNotMatch(ps, /[^\x09\x0a\x0d\x20-\x7e]/, '.ps1 must be ASCII for Windows PowerShell 5.1');
    for (const needle of ['X-Portless', '/api/health', "'nidum-local'", 'http://127.0.0.1:', '/?t=', 'Portless Proxy',
      "@('proxy', 'start') + $Start.Flags", "@('--lan')", "'--https'", "'--no-tls'", "'--ip'", "'--wildcard'", 'function Get-ProxyStart', 'Get-ProxyStart $tls $port',
      'portless-service.cmd', 'Test-SessionOk', "Get-JsonProp $j 'pid'", '<redacted>', 'exit 3', 'NIDUM_SERVICE_WAIT',
      'Press any key to close.', 'What happened:', 'NIDUM_DRY_RUN', '[0-9a-f]{64}']) {
      assert.ok(ps.includes(needle), `.ps1 missing ${needle}`);
    }
    assert.doesNotMatch(ps, /localhost/, 'never localhost');
    // Balanced braces/parens as a cheap parse sanity check (strings stripped).
    const code = ps.replace(/@'[\s\S]*?'@/g, '').replace(/'[^'\n]*'/g, "''").replace(/"(?:`.|[^"`\n])*"/g, '""').replace(/#.*$/gm, '');
    for (const [o, c] of [['{', '}'], ['(', ')']]) {
      assert.equal(code.split(o).length, code.split(c).length, `unbalanced ${o}${c} in .ps1`);
    }
  });

  test('Linux .desktop entry matches the spec', () => {
    const d = readFileSync(DESKTOP, 'utf8');
    for (const l of ['[Desktop Entry]', 'Name=Nidum Local', 'Icon=nidum-local', 'Terminal=true', 'Type=Application']) {
      assert.ok(d.split('\n').includes(l), `missing ${l}`);
    }
    assert.match(d, /^Exec=.*nidum-local\.sh.* %k$/m);
    assert.ok(statSync(DESKTOP).mode & 0o111, '.desktop is executable');
  });

  test('Linux .desktop Exec decodes to a shell command that finds nidum-local.sh from %k (path or file:// URI)', () => {
    const raw = /^Exec=(.*)$/m.exec(readFileSync(DESKTOP, 'utf8'))[1];
    const value = raw.replace(/\\(.)/g, (m, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' }[c] ?? m));
    // Desktop Entry Exec quoting: arguments in double quotes, with \" \` \$ \\ escaped.
    const args = [];
    const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
    for (let m; (m = re.exec(value));) args.push(m[1] !== undefined ? m[1].replace(/\\(["`$\\])/g, '$1') : m[2]);
    args[2] = args[2].replaceAll('%%', '%'); // field-code escaping of a literal %
    assert.deepEqual([args[0], args[1], args[3]], ['bash', '-c', '%k']);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nidum-n5-desktop-')));
    sandboxes.push({ dir });
    const folder = join(dir, 'Nidum Local', 'launchers', 'linux');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'nidum-local.sh'), '#!/bin/bash\necho "launcher ran from $(pwd -P >/dev/null; dirname "$0")"\n');
    chmodSync(join(folder, 'nidum-local.sh'), 0o755);
    const desktopPath = join(folder, 'nidum-local.desktop');
    for (const k of [desktopPath, `file://${desktopPath}`, `file://${encodeURI(desktopPath)}`]) {
      if (k.includes('%')) assert.match(k, /Nidum%20Local/);
      const out = execFileSync(BASH, ['-c', args[2], k], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
      assert.equal(out.trim(), `launcher ran from ${folder}`, k);
    }
    const missing = execFileSync(BASH, ['-c', args[2]], { encoding: 'utf8', timeout: 5000, input: 'x', env: { PATH: '/usr/bin:/bin' } });
    assert.match(missing, /Open launchers\/linux\/nidum-local\.sh from the Nidum Local folder in a terminal\./);
  });
});

// ------------------------------------------------------------------ macOS flows (criterion 2)

describe('macOS launcher flows', () => {
  test('(a) everything present + server alive: reuse, no prompts, browser opened with the token URL', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true });
    sb.proxyUp(80);
    sb.dashboardUp(47811);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(promptLines(r.out), []);
    assert.match(r.out, /✓ Node\.js 22\.22\.3 found/);
    assert.match(r.out, /✓ Portless 0\.15\.6 found/);
    assert.match(r.out, /✓ Network sharing is on \(kept on by the startup service\) — this computer is 192\.168\.1\.42/);
    assert.match(r.out, /✓ Dashboard is already running/);
    assert.match(r.out, /→ Opening http:\/\/127\.0\.0\.1:47811 in your browser/);
    assert.match(r.out, /You can close this window\. Nidum Local keeps running\./);
    const calls = sb.calls();
    assert.ok(calls.includes(`open http://127.0.0.1:47811/?t=${TOKEN}`), calls.join('\n'));
    assert.ok(!has(calls, /^(brew|npm) /), 'nothing installed');
    assert.ok(!has(calls, /^portless proxy (start|stop)/), 'no proxy start/stop');
    assert.ok(!has(calls, /server\.js/), 'no server start');
    assert.ok(has(calls, /^curl -sI .*http:\/\/127\.0\.0\.1:80\/$/), 'port 80 read from the plist, probed via HEAD');
    assert.doesNotMatch(r.out, /\x1b\[/, 'NO_COLOR honoured');
    assert.doesNotMatch(r.out + sb.log(), new RegExp(TOKEN), 'token never printed or logged');
    assert.ok(r.ms < 3000, `took ${r.ms} ms (target ≤ 3 s)`);
  });

  test('(b) Portless missing: consent prompt, Enter accepts, brew install portless', async () => {
    const sb = sandbox({ stubs: ['node', 'curl', 'open', 'brew', 'npm'] });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /\? Nidum Local uses Portless to give your services addresses\. It isn't installed\.\n {4}Install it now with Homebrew\? \[Y\/n\]/);
    assert.ok(sb.calls().includes('brew install portless'));
    assert.match(r.out, /✓ Portless 0\.15\.6 installed/);
    assert.ok(!has(sb.calls(), /^npm /));
  });

  test('(b) Portless missing, user answers n: nothing installed, failure screen', async () => {
    const sb = sandbox({ stubs: ['node', 'curl', 'open', 'brew', 'npm'] });
    const r = await run(sb, { input: 'n\nx' });
    assert.equal(r.code, 1);
    assert.ok(!has(sb.calls(), /^brew install/));
    assert.match(r.out, /✗ Nidum Local can't start without Portless\./);
    assert.match(r.out, /Press any key to close\./);
  });

  test('(b) Portless missing, no brew, Node 22: explains the Node 24 need, no npm install', async () => {
    const sb = sandbox({ stubs: ['node', 'curl', 'open', 'npm'] });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /Installing Portless with npm needs Node\.js 24 or newer\. You have 22\.22\.3\./);
    assert.ok(!has(sb.calls(), /^npm /));
  });

  test('(b) Portless missing, no brew, Node 24: npm install -g portless after consent', async () => {
    const sb = sandbox({ stubs: ['node', 'curl', 'open', 'npm'], env: { STUB_NODE_VERSION: 'v24.4.0' } });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: 'y\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Install it now with npm\? \[Y\/n\]/);
    assert.ok(sb.calls().includes('npm install -g portless'));
  });

  test('Portless older than 0.15.6: offers an upgrade with Homebrew', async () => {
    const sb = sandbox({ env: { STUB_PORTLESS_VERSION: '0.14.2' } });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    // The stub lives outside a Homebrew Cellar, so the upgrade goes through npm.
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\? Nidum Local works best with Portless 0\.15\.6 or newer\. You have 0\.14\.2\./);
    assert.ok(sb.calls().includes('npm install -g portless@latest'));
    assert.match(r.out, /✓ Portless 0\.16\.0 found/);
  });

  test('Portless older and installed by Homebrew (Cellar symlink): brew upgrade portless', async () => {
    const sb = sandbox({ env: { STUB_PORTLESS_VERSION: '0.15.0' } });
    const cellar = join(sb.dir, 'homebrew', 'Cellar', 'portless', '0.15.0', 'bin');
    mkdirSync(cellar, { recursive: true });
    rmSync(join(sb.bin, 'portless'));
    copyFileSync(join(STUBS, 'portless'), join(cellar, 'portless'));
    chmodSync(join(cellar, 'portless'), 0o755);
    symlinkSync(join(cellar, 'portless'), join(sb.bin, 'portless'));
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: 'y\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Update it now with Homebrew\? \[Y\/n\]/);
    assert.ok(sb.calls().includes('brew upgrade portless'));
    assert.ok(!has(sb.calls(), /^npm /));
  });

  test('Portless present but broken: failure screen suggesting a reinstall', async () => {
    const sb = sandbox({ env: { STUB_PORTLESS_BROKEN: '1' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Portless is installed but doesn't run\.\n\n {4}What happened: "portless --version" failed: dyld: Library not loaded\n {4}What to try: {3}Run: brew reinstall portless/);
    assert.ok(!has(sb.calls(), /^brew /), 'nothing run without asking');
  });

  test('Portless older, user declines: warning, continues', async () => {
    const sb = sandbox({ env: { STUB_PORTLESS_VERSION: '0.14.2' } });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: 'n\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! Continuing with Portless 0\.14\.2\. Some features may not work\./);
    assert.ok(!has(sb.calls(), /^(npm|brew) /));
  });

  test('(c) no service, proxy stopped: password + firewall notes, proxy start --lan with explicit flags', async () => {
    const sb = sandbox();
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(promptLines(r.out), []);
    assert.match(r.out, /Your computer will ask for your password so Nidum Local can use the standard web port \(443\) and trust its local certificate\. You may be asked twice\./);
    assert.match(r.out, /Your computer may ask whether to allow incoming connections\. Choose Allow, or other devices won't be able to connect\./);
    assert.match(r.out, /… Starting network sharing \(you may be asked for your password\)/);
    assert.ok(sb.calls().includes('portless proxy start --lan --https -p 443'), sb.calls().join('\n'));
    assert.match(r.out, /✓ Network sharing is on — this computer is 192\.168\.1\.42/);
  });

  test('(c) no service, proxy start fails: failure screen with Portless output', async () => {
    const sb = sandbox({ env: { STUB_PROXY_START: 'fail' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Couldn't start network sharing\.\n\n {4}What happened: Error: Port 443 is already used by another program \(httpd, PID 812\)\.\n {4}What to try: {3}Open Nidum Local again\. If it keeps failing, run: portless doctor\n {4}Details: {7}~\/\.nidum-local\/launcher\.log\n\n {2}Press any key to close\./);
  });

  test('no service, proxy running with LAN: ✓, never restarted', async () => {
    const sb = sandbox();
    sb.proxyUp(1355);
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Network sharing is on — this computer is 192\.168\.1\.42/);
    assert.ok(!has(sb.calls(), /^portless proxy/));
  });

  test('no service, HTTPS proxy on 8443 without LAN, no state.json: asks, restarts keeping its TLS and port (D20)', async () => {
    const sb = sandbox();
    sb.proxyUp(8443, { lan: false, tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\? Network sharing is already on, but only for this computer\.\n {4}Restart it so other devices can connect\? Open addresses will drop for a second\. \[Y\/n\]/);
    const calls = sb.calls().filter((c) => c.startsWith('portless proxy'));
    assert.deepEqual(calls, ['portless proxy stop -p 8443', 'portless proxy start --lan --https -p 8443']);
  });

  test('D20: HTTP proxy on 8080 without LAN + no state.json: restart keeps --no-tls -p 8080', async () => {
    const sb = sandbox();
    sb.proxyUp(8080, { lan: false, tls: false });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    const calls = sb.calls().filter((c) => c.startsWith('portless proxy'));
    assert.deepEqual(calls, ['portless proxy stop -p 8080', 'portless proxy start --lan --no-tls -p 8080']);
    assert.doesNotMatch(r.out, /Your computer (will|may) ask for your password|couldn't be read/);
    assert.match(sb.log(), /proxy flags: --lan --no-tls -p 8080 \(running proxy's TLS and port: no state\.json\)/);
  });

  test('D20: HTTP proxy on 8080 without LAN + partial or invalid state.json: field-level fallback to the running proxy', async () => {
    const cases = [
      [{ settings: { wildcard: true } }, '--lan --no-tls -p 8080 --wildcard', false],
      [{ settings: { tls: true } }, '--lan --https -p 8080', false],
      [{ settings: { port: 9090 } }, '--lan --no-tls -p 9090', false],
      [{ settings: { fixedIp: '192.168.1.60' } }, '--lan --no-tls -p 8080 --ip 192.168.1.60', false],
      [{ settings: { tls: false, port: 80, wildcard: false } }, '--lan --no-tls -p 80', false],
      [{ settings: { port: 'eighty', wildcard: true } }, '--lan --no-tls -p 8080', true],
      ['garbage {', '--lan --no-tls -p 8080', true],
    ];
    for (const [state, flags, warns] of cases) {
      const sb = sandbox();
      sb.proxyUp(8080, { lan: false, tls: false });
      sb.dashboardUp();
      sb.stateJson(state);
      const r = await run(sb, { input: '\n' });
      assert.equal(r.code, 0, r.out);
      const calls = sb.calls().filter((c) => c.startsWith('portless proxy'));
      assert.deepEqual(calls, ['portless proxy stop -p 8080', `portless proxy start ${flags}`], JSON.stringify(state));
      if (warns) assert.match(r.out, /! Your saved sharing settings couldn't be read, so Nidum Local keeps the current setup \(port 8080\)\./);
      else assert.doesNotMatch(r.out, /couldn't be read/);
    }
  });

  test('no service, proxy running without LAN, state.json present: restart uses the saved settings', async () => {
    const sb = sandbox();
    sb.proxyUp(8443, { lan: false, tls: true });
    sb.dashboardUp();
    sb.stateJson({ version: 1, settings: { tls: true, port: 8443, fixedIp: null, wildcard: true, keepAfterRestart: false } });
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    const calls = sb.calls().filter((c) => c.startsWith('portless proxy'));
    assert.deepEqual(calls, ['portless proxy stop -p 8443', 'portless proxy start --lan --https -p 8443 --wildcard']);
    assert.match(r.out, /Your computer may ask for your password so Nidum Local can trust its local certificate\./);
    assert.doesNotMatch(r.out, /standard web port/, 'no port note for a high port');
  });

  test('no service, proxy running without LAN, user declines: warning, no restart', async () => {
    const sb = sandbox();
    sb.proxyUp(8080, { lan: false });
    sb.dashboardUp();
    const r = await run(sb, { input: 'n\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! Network sharing stays on for this computer only\./);
    assert.ok(!has(sb.calls(), /^portless proxy/));
  });

  test('(d) service installed but not responding: failure screen, kickstart hint, no proxy start', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true });
    sb.dashboardUp();
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ The startup service isn't responding\./);
    assert.match(r.out, /What happened: Network sharing is set to start with your computer, but nothing answers on port 80\./);
    assert.match(r.out, /What to try: {3}sudo launchctl kickstart -k system\/sh\.portless\.proxy \(or, if it isn't loaded: sudo launchctl bootstrap system .*sh\.portless\.proxy\.plist\)/);
    assert.match(r.out, /… Waiting for network sharing to answer/);
    assert.match(r.out, /Press any key to close\./);
    assert.ok(!has(sb.calls(), /^portless proxy/), 'never starts or stops a proxy');
    assert.ok(!has(sb.calls(), /^open /), 'browser not opened');
  });

  test('(e) server not running: started detached from the app root, health polled, browser opened', async () => {
    const sb = sandbox();
    sb.proxyUp(443, { tls: true });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /… Starting the dashboard\n {2}✓ Dashboard started/);
    const calls = sb.calls();
    assert.ok(calls.includes('node src/server.js'), calls.join('\n'));
    assert.ok(calls.includes(`node -e <helper> -- ${sb.bin}/node ${sb.nidumHome}/server.log ${sb.app}`), 'started through the own-session helper');
    assert.ok(calls.includes(`node-cwd ${sb.app}`));
    assert.ok(calls.includes(`node-nidum-home ${sb.nidumHome}`));
    const polls = calls.filter((c) => /\/api\/health$/.test(c)).length;
    assert.ok(polls >= 2, `health polled ${polls} times`);
    assert.ok(calls.includes(`open http://127.0.0.1:47800/?t=${SERVER_TOKEN}`), calls.join('\n'));
    assert.match(readFileSync(join(sb.nidumHome, 'server.log'), 'utf8'), /listening on http:\/\/127\.0\.0\.1:47800/);
  });

  test('(e) stale session (another app on the port): starts a new dashboard', async () => {
    const sb = sandbox();
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp(47800, 'something-else');
    rmSync(join(sb.state, 'health-47800'));
    writeFileSync(join(sb.state, 'health-47800'), '{"ok":true,"app":"other"}');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('node src/server.js'));
  });

  test('(e) server crashes: failure screen with the server log line', async () => {
    const sb = sandbox({ env: { STUB_SERVER_MODE: 'fail' } });
    sb.proxyUp(443, { tls: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Couldn't start the dashboard\.\n\n {4}What happened: Error: listen EADDRINUSE/);
    assert.match(r.out, /see ~\/\.nidum-local\/server\.log/);
  });

  test('(e) server never answers: gives up after NIDUM_START_TIMEOUT', async () => {
    const sb = sandbox({ env: { STUB_SERVER_MODE: 'silent', NIDUM_START_TIMEOUT: '1' } });
    sb.proxyUp(443, { tls: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /What happened: It didn't answer within 1 seconds\./);
  });

  test('Node missing: asks, brew install node', async () => {
    const sb = sandbox({ stubs: ['portless', 'curl', 'open', 'brew'] });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\? Nidum Local needs Node\.js 18 or newer\. You have none installed\.\n {4}Install it now with Homebrew\? \[Y\/n\]/);
    assert.ok(sb.calls().includes('brew install node'));
    assert.match(r.out, /✓ Node\.js 22\.22\.3 installed/);
  });

  test('Node too old and no brew: failure screen pointing at nodejs.org', async () => {
    const sb = sandbox({ stubs: ['node', 'portless', 'curl', 'open'], env: { STUB_NODE_VERSION: 'v16.20.0' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Nidum Local needs Node\.js 18 or newer\.\n\n {4}What happened: You have 16\.20\.0\.\n {4}What to try: {3}Install Node\.js from https:\/\/nodejs\.org/);
  });

  test('old node on PATH, newer one in a Homebrew folder (NIDUM_EXTRA_PATH): uses the newer one', async () => {
    const sb = sandbox({ env: { STUB_NODE_VERSION: 'v16.0.0' } });
    const brewNode = join(sb.dir, 'homebrew-node-bin');
    mkdirSync(brewNode);
    writeFileSync(join(brewNode, 'node'), `#!/bin/bash\nif [ "$1" = --version ]; then echo v26.10.0; exit 0; fi\nexec "${join(sb.bin, 'node')}" "$@"\n`);
    chmodSync(join(brewNode, 'node'), 0o755);
    sb.env.NIDUM_EXTRA_PATH = `${brewNode}:/nonexistent-folder`;
    sb.proxyUp(443, { tls: true });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Node\.js 26\.10\.0 found/);
  });

  test('NO_COLOR wins over NIDUM_COLOR=1; colour otherwise', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_COLOR: '1', NO_COLOR: '' } });
    sb.proxyUp(80);
    sb.dashboardUp();
    const coloured = await run(sb);
    assert.match(coloured.out, /\x1b\[32m✓\x1b\[0m Node\.js/);
    sb.env.NO_COLOR = '1';
    const plain = await run(sb);
    assert.doesNotMatch(plain.out, /\x1b\[/);
  });

  test('launcher.log is written under NIDUM_HOME, defaulting to ~/.nidum-local', async () => {
    const sb = sandbox({ defaultHome: true, service: { port: 80 }, stateFromService: true });
    sb.proxyUp(80);
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    const log = readFileSync(join(sb.home, '.nidum-local', 'launcher.log'), 'utf8');
    assert.match(log, /launcher start: platform=macos/);
    assert.match(log, /✓ Dashboard is already running/);
    assert.match(log, /open http:\/\/127\.0\.0\.1:47811\/\?t=<redacted>/);
    assert.doesNotMatch(log, new RegExp(TOKEN));
  });

  test('NIDUM_DRY_RUN=1: prints every action, does none, creates no NIDUM_HOME', async () => {
    const sb = sandbox({ stubs: ['node', 'curl', 'open', 'brew'] });
    // Control run without dry run: closed stdin counts as No, so nothing is installed.
    const r = await run(sb);
    assert.equal(r.code, 1, r.out);
    assert.ok(!has(sb.calls(), /^brew install/));
    rmSync(sb.nidumHome, { recursive: true, force: true });
    writeFileSync(sb.env.STUB_LOG, '');
    sb.env.NIDUM_DRY_RUN = '1';
    const d = await run(sb);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /dry run: nothing will be installed, started or opened/);
    assert.match(d.out, /\[dry run\] would run: brew install portless/);
    assert.match(d.out, /\[dry run\] would run: portless proxy start --lan --https -p 443/);
    assert.match(d.out, /\[dry run\] would run: cd \S+ && \S+\/node src\/server\.js \(in its own session, output to \S+server\.log\)/);
    assert.match(d.out, /\[dry run\] would run: open http:\/\/127\.0\.0\.1:47800\/\?t=<token>/);
    const calls = sb.calls();
    assert.ok(!has(calls, /^(brew|npm|open|portless proxy)/), calls.join('\n'));
    assert.ok(!has(calls, /server\.js/));
    assert.ok(!existsSync(sb.nidumHome), 'dry run must not create NIDUM_HOME');
  });
});

// ------------------------------------------------------------------ iteration 2 (validation 1 findings)

const lingering = [];
after(() => { for (const pid of lingering) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionPid = (sb) => Number(/"pid":(\d+)/.exec(readFileSync(join(sb.nidumHome, 'session.json'), 'utf8'))[1]);

/** Runs `argv` under script(1), so it is the session leader of a fresh pty, like a terminal tab. */
function runOnPty(sb, argv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // stdin must not be a socket (script's tcgetattr fails on one); /dev/null is fine.
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', ...argv], { env: sb.env, cwd: sb.home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty run timed out\n${out}`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

describe('proxy flags from state.json (finding 1, Contracts §4)', () => {
  test('full settings: --lan --no-tls -p 80 --ip <fixedIp> --wildcard, password-once note', async () => {
    const sb = sandbox();
    sb.dashboardUp();
    sb.stateJson({ version: 1, names: ['recipes'], settings: { tls: false, port: 80, fixedIp: '192.168.1.50', wildcard: true, keepAfterRestart: false }, dismissed: [] });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(sb.calls().includes('portless proxy start --lan --no-tls -p 80 --ip 192.168.1.50 --wildcard'), sb.calls().join('\n'));
    assert.match(r.out, /Your computer will ask for your password once, so Nidum Local can use the standard web port \(80\)\./);
    assert.doesNotMatch(r.out, /trust its local certificate|couldn't be read/);
    assert.match(sb.log(), /proxy flags: --lan --no-tls -p 80 --ip 192\.168\.1\.50 --wildcard \(from state\.json, cold\)/);
  });

  test('partial settings: absent fields take defaults', async () => {
    const cases = [
      [{ settings: { tls: false } }, '--lan --no-tls -p 80'],
      [{ settings: { port: 8443 } }, '--lan --https -p 8443'],
      [{ settings: { fixedIp: 'fe80::1', wildcard: false } }, '--lan --https -p 443 --ip fe80::1'],
      [{ settings: {} }, '--lan --https -p 443'],
    ];
    for (const [state, flags] of cases) {
      const sb = sandbox();
      sb.dashboardUp();
      sb.stateJson(state);
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.ok(sb.calls().includes(`portless proxy start ${flags}`), `${JSON.stringify(state)}\n${sb.calls().join('\n')}`);
      assert.doesNotMatch(r.out, /couldn't be read/);
    }
  });

  test('garbage or invalid settings: default --https -p 443 with a warning, never a crash', async () => {
    const cases = [
      'not json {', '[]', '"settings"', '{"settings":[1]}', '{"settings":null}',
      { settings: { port: '80' } }, { settings: { port: 0 } }, { settings: { port: 70000 } }, { settings: { port: 80.5 } },
      { settings: { tls: 'yes' } }, { settings: { wildcard: 1 } },
      { settings: { fixedIp: 'not-an-ip' } }, { settings: { fixedIp: '1.2.3.4; touch /tmp/nidum-pwned' } }, { settings: { fixedIp: 42 } },
    ];
    for (const state of cases) {
      const sb = sandbox();
      sb.dashboardUp();
      sb.stateJson(state);
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      const starts = sb.calls().filter((c) => c.startsWith('portless proxy start'));
      assert.deepEqual(starts, ['portless proxy start --lan --https -p 443'], JSON.stringify(state));
      assert.match(r.out, /! Your saved sharing settings couldn't be read, so Nidum Local uses the standard setup \(port 443\)\./);
      assert.match(sb.log(), /proxy flags: --lan --https -p 443 \(default: /);
    }
    assert.ok(!existsSync('/tmp/nidum-pwned'));
  });

  test('missing state.json: default flags, no warning', async () => {
    const sb = sandbox();
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('portless proxy start --lan --https -p 443'));
    assert.doesNotMatch(r.out, /couldn't be read/);
    assert.match(sb.log(), /\(default: no state\.json\)/);
  });

  test('dry run reads state.json (read only) and prints the flags it would use', async () => {
    const sb = sandbox({ env: { NIDUM_DRY_RUN: '1' } });
    sb.stateJson({ settings: { tls: false, port: 8080 } });
    const before = readFileSync(join(sb.nidumHome, 'state.json'), 'utf8');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[dry run\] would run: portless proxy start --lan --no-tls -p 8080/);
    assert.ok(!has(sb.calls(), /^portless proxy/));
    assert.equal(readFileSync(join(sb.nidumHome, 'state.json'), 'utf8'), before, 'state.json untouched');
  });
});

describe('dashboard sessions (findings 2, 3, 8)', () => {
  test('control: a nohup-started server with default SIGHUP dies when its pty session ends', async () => {
    const sb = sandbox({ env: { STUB_SERVER_MODE: 'linger' } });
    mkdirSync(sb.nidumHome, { recursive: true });
    const r = await runOnPty(sb, [BASH, '-c', '/usr/bin/nohup "$STUB_BIN/node" src/server.js >/dev/null 2>&1 & sleep 1.6']);
    assert.equal(r.code, 0, r.out);
    const pid = sessionPid(sb);
    lingering.push(pid);
    await sleepMs(800);
    assert.equal(alive(pid), false, 'the harness must be able to tell a nohup start from a real detach');
  });

  test('the launcher starts the server in its own session: it survives the launcher leaving the pty', async () => {
    const sb = sandbox({ env: { STUB_SERVER_MODE: 'linger' } });
    sb.proxyUp(443, { tls: true });
    const r = await runOnPty(sb, [BASH, MAC]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Dashboard started/);
    const pid = sessionPid(sb);
    lingering.push(pid);
    await sleepMs(800);
    assert.equal(alive(pid), true, 'dashboard server died with the launcher');
    const sid = execFileSync('/bin/ps', ['-o', 'sess=,pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.ok(sid.length > 0, 'ps sees the server');
    process.kill(pid, 'SIGKILL');
  });

  test('stale session.json while the new server answers health first: opens the new token', async () => {
    const sb = sandbox({ env: { STUB_ORDER: 'health-first' } });
    sb.proxyUp(443, { tls: true });
    mkdirSync(sb.nidumHome, { recursive: true });
    const stale = 'ee'.repeat(32);
    writeFileSync(join(sb.nidumHome, 'session.json'), `{"port":47800,"token":"${stale}","pid":1111,"startedAt":"2026-10-15T06:00:00.000Z","version":"1.0.0"}\n`);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    const opens = sb.calls().filter((c) => c.startsWith('open '));
    assert.deepEqual(opens, [`open http://127.0.0.1:47800/?t=${SERVER_TOKEN}`]);
    assert.match(sb.log(), /answers for pid \d+, session\.json says 1111: not this session/);
  });

  test('session pid differs from the health pid: not reused, a new server starts', async () => {
    const sb = sandbox();
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp(47811);
    writeFileSync(join(sb.state, 'health-47811'), '{"ok":true,"app":"nidum-local","version":"1.0.0","pid":9999}');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('node src/server.js'));
    assert.ok(!sb.calls().includes(`open http://127.0.0.1:47811/?t=${TOKEN}`));
  });

  test('session ports outside 1-65535 (or with leading zeros) are never used', async () => {
    for (const port of ['0', '0047811', '99999', '999999999999']) {
      const sb = sandbox();
      sb.proxyUp(443, { tls: true });
      mkdirSync(sb.nidumHome, { recursive: true });
      writeFileSync(join(sb.nidumHome, 'session.json'), `{"port":${port},"token":"${TOKEN}","pid":4321}\n`);
      writeFileSync(join(sb.state, `health-${port}`), '{"ok":true,"app":"nidum-local","pid":4321}');
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.ok(!has(sb.calls(), new RegExp(`127\\.0\\.0\\.1:${port}/`)), `probed port ${port}`);
      assert.ok(sb.calls().includes('node src/server.js'), port);
    }
  });

  test('NIDUM_START_TIMEOUT is validated: 0 is raised to 1 second', async () => {
    const sb = sandbox({ env: { STUB_SERVER_MODE: 'silent', NIDUM_START_TIMEOUT: '0' } });
    sb.proxyUp(443, { tls: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /It didn't answer within 1 seconds\./);
  });
});

describe('token, service wait, orphans, details (findings 4, 6, 7, 8)', () => {
  test('browser cannot be opened: full address on screen only, redacted in launcher.log', async () => {
    const sb = sandbox({ stubs: ['node', 'portless', 'curl', 'brew', 'npm'], service: { port: 80 }, stateFromService: true });
    sb.proxyUp(80);
    sb.dashboardUp(47811);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`! Couldn't open your browser. Open this address: http://127.0.0.1:47811/?t=${TOKEN}`), r.out);
    const log = sb.log();
    assert.doesNotMatch(log, new RegExp(TOKEN));
    assert.match(log, /Open this address: http:\/\/127\.0\.0\.1:47811\/\?t=<redacted>/);
  });

  test('startup service that answers during the wait: no failure screen', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_SERVICE_WAIT: '5' } });
    sb.dashboardUp();
    setTimeout(() => writeFileSync(join(sb.state, 'proxy-80'), 'http'), 1500);
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /… Waiting for network sharing to answer\n {2}✓ Network sharing is on \(kept on by the startup service\)/);
    assert.ok(r.ms >= 1400, `${r.ms} ms`);
    assert.ok(!has(sb.calls(), /^portless proxy/));
  });

  test('startup service that never answers: fails after about NIDUM_SERVICE_WAIT seconds', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_SERVICE_WAIT: '2' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.ok(r.ms >= 1500 && r.ms < 6000, `${r.ms} ms`);
    assert.match(r.out, /The startup service isn't responding\./);
  });

  test('no sleep outlives the launcher (watchdog kills its own sleep)', async () => {
    // --version takes 0.3 s, so each watchdog's sleep is surely running (and recorded) before it is stopped.
    const sb = sandbox({ stubs: [...DEFAULT_STUBS, 'sleep'], service: { port: 80 }, stateFromService: true, env: { STUB_VERSION_DELAY: '0.3' } });
    sb.proxyUp(80);
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    const pids = readFileSync(join(sb.state, 'sleep-pids'), 'utf8').split('\n').filter(Boolean).map(Number);
    assert.ok(pids.length >= 2, `watchdog sleeps recorded: ${pids.length}`);
    for (let i = 0; i < 20 && pids.some(alive); i++) await sleepMs(50);
    assert.deepEqual(pids.filter(alive), [], 'orphaned sleep processes');
  });
});

// ------------------------------------------------------------------ iteration 3 (validation 2 hardening)

describe('iteration 3 hardening', () => {
  test('session.json is read once: a rename landing between the token and pid parses never pairs a stale token with a fresh pid', async () => {
    const sb = sandbox();
    sb.proxyUp(443, { tls: true });
    copyFileSync(join(STUBS, 'sed-swap'), join(sb.bin, 'sed'));
    chmodSync(join(sb.bin, 'sed'), 0o755);
    mkdirSync(sb.nidumHome, { recursive: true });
    const stale = 'ee'.repeat(32);
    // On disk: an old session. A newer one (pid 5555, which /api/health reports) is renamed over it
    // right after the launcher's first token parse. Reading the file three times would combine the
    // old token with the new pid, pass the pid check and open the dead token.
    writeFileSync(join(sb.nidumHome, 'session.json'), `{"port":47800,"token":"${stale}","pid":1111,"startedAt":"x","version":"1.0.0"}\n`);
    writeFileSync(join(sb.state, 'session.next'), `{"port":47800,"token":"${'ab'.repeat(32)}","pid":5555,"startedAt":"y","version":"1.0.0"}\n`);
    writeFileSync(join(sb.state, 'health-47800'), '{"ok":true,"app":"nidum-local","version":"1.0.0","pid":5555}');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    const calls = sb.calls();
    assert.ok(calls.includes('sed-swap: session.json replaced'), 'the swap happened');
    assert.ok(!has(calls, new RegExp(`\\?t=${stale}`)), `opened the stale token:\n${calls.join('\n')}`);
    assert.equal(calls.filter((c) => c.startsWith('open ')).length, 1);
    assert.match(sb.log(), /session\.json says 1111: not this session/);
  });

  test('restarting a root-owned proxy (port 80): the password note comes before the stop, once', async () => {
    const sb = sandbox();
    sb.proxyUp(80, { lan: false, tls: false });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    const note = r.out.indexOf('Your computer will ask for your password so Nidum Local can restart network sharing on the standard web port.');
    const stop = r.out.indexOf('… Stopping network sharing');
    assert.ok(note > 0 && stop > note, r.out);
    assert.equal((r.out.match(/Your computer (will|may) ask for your password/g) ?? []).length, 1, 'note printed once');
    const calls = sb.calls().filter((c) => c.startsWith('portless proxy'));
    assert.deepEqual(calls, ['portless proxy stop -p 80', 'portless proxy start --lan --no-tls -p 80']);
  });

  test('restarting a high-port proxy: no note before the stop, D19 note before the start', async () => {
    const sb = sandbox();
    sb.proxyUp(8443, { lan: false, tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    const note = r.out.indexOf('Your computer may ask for your password so Nidum Local can trust its local certificate.');
    assert.ok(note > r.out.indexOf('… Stopping network sharing'), r.out);
  });

  test('startup service that accepts but never answers: hard deadline of about NIDUM_SERVICE_WAIT + 1 s', async (t) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_SERVICE_WAIT: '5', STUB_CURL_HANG: '1' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The startup service isn't responding\./);
    // D22: the clock starts before the first probe, which counts as the first try, and the
    // paused check (launchctl print) runs inside the same budget.
    const waited = Number((sb.log().match(/service wait: gave up after (\d+) ms/) ?? [])[1]);
    t.diagnostic(`launcher ${r.ms} ms, service wait ${waited} ms`);
    // Hard deadline 5 + 1 s; 0.5 s of slack for process start-up under the parallel suite.
    assert.ok(waited >= 4500 && waited <= 6500, `service wait ${waited} ms`);
    assert.ok(r.ms >= 4500 && r.ms <= 8000, `${r.ms} ms`);
    assert.ok(sb.calls().includes('launchctl print system/sh.portless.proxy'));
    const probes = sb.calls().filter((c) => c.startsWith('curl '));
    assert.ok(probes.every((c) => / -m (1|1\.000|0\.\d{3}) --connect-timeout (1|1\.000|0\.\d{3}) /.test(c) && /http:\/\/127\.0\.0\.1:80\/$/.test(c)), probes.join('\n'));
  });

  test('hanging launchctl print: limited to 2 s and counted inside the same deadline', async (t) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_SERVICE_WAIT: '2', STUB_CURL_HANG: '1', STUB_LAUNCHCTL_HANG: '1' } });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The startup service isn't responding\./);
    assert.doesNotMatch(r.out, /paused/);
    const waited = Number((sb.log().match(/service wait: gave up after (\d+) ms/) ?? [])[1]);
    t.diagnostic(`launcher ${r.ms} ms, service wait ${waited} ms`);
    assert.ok(waited >= 1500 && waited <= 3500, `service wait ${waited} ms`);
    assert.match(sb.log(), /service loaded check: exit 143/);
    assert.doesNotMatch(r.out + r.err, /Terminated/, 'no bash job report when the limit kills launchctl');
    const total = sandbox({ service: { port: 80 }, stateFromService: true, env: { NIDUM_SERVICE_WAIT: '5', STUB_CURL_HANG: '1', STUB_LAUNCHCTL_HANG: '1' } });
    const r5 = await run(total, { input: 'x' });
    const waited5 = Number((total.log().match(/service wait: gave up after (\d+) ms/) ?? [])[1]);
    t.diagnostic(`NIDUM_SERVICE_WAIT=5: launcher ${r5.ms} ms, service wait ${waited5} ms`);
    assert.ok(waited5 >= 4500 && waited5 <= 6500, `service wait ${waited5} ms`);
  });

  test('NIDUM_HOME that cannot be created: early failure screen, nothing else runs', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true });
    writeFileSync(join(sb.dir, 'a-file'), '');
    sb.env.NIDUM_HOME = join(sb.dir, 'a-file', 'nidum');
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Nidum Local can't save its files\.\n\n {4}What happened: The folder .*a-file\/nidum can't be created or written\.\n {4}What to try: {3}Check that folder's permissions/);
    assert.ok(r.out.includes(`Details:       (no log: ${sb.env.NIDUM_HOME} could not be written)`), r.out);
    assert.doesNotMatch(r.out, /Node\.js v\d|dry run/);
    assert.deepEqual(sb.calls(), [], 'stops before any probe');
  });

  test('server.log that cannot be written: clear failure before spawning', async () => {
    const sb = sandbox();
    sb.proxyUp(443, { tls: true });
    mkdirSync(join(sb.nidumHome, 'server.log'), { recursive: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Couldn't start the dashboard\.\n\n {4}What happened: Its log file ~\/\.nidum-local\/server\.log can't be written\./);
    assert.doesNotMatch(r.out, /Node\.js v\d/);
    assert.ok(!has(sb.calls(), /server\.js/));
  });

  test('relative NIDUM_HOME starting with a dash is made absolute and works end to end', async () => {
    const sb = sandbox();
    sb.proxyUp(8080, { lan: false, tls: false });
    sb.env.NIDUM_HOME = '-nh';
    const home = join(sb.home, '-nh');
    mkdirSync(home);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ settings: { wildcard: true } }));
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(sb.calls().includes('portless proxy start --lan --no-tls -p 8080 --wildcard'), sb.calls().join('\n'));
    assert.ok(existsSync(join(home, 'session.json')) && existsSync(join(home, 'launcher.log')));
  });

  test('node -e helpers get "--", so dash-leading arguments arrive as arguments, not Node options', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nidum-n5-dash-')));
    sandboxes.push({ dir });
    mkdirSync(join(dir, '-d'));
    writeFileSync(join(dir, '-d', 'state.json'), JSON.stringify({ settings: { tls: false, port: 8081 } }));
    mkdirSync(join(dir, '-l'));
    const script = `. "${CORE}"
NIDUM_LOG_FILE=''; NIDUM_PLATFORM=macos; nidum_init_colors
NODE_BIN="$REAL_NODE"; NIDUM_STATE_FILE=-d/state.json
nidum_proxy_flags; echo "flags: \${PROXY_FLAGS[*]}"
nidum_capture 10 "$REAL_NODE" -e "$NIDUM_SPAWN_JS" -- /usr/bin/true -l/server.log "$PWD"; echo "spawn: $NIDUM_CAPTURE"`;
    const out = execFileSync(BASH, ['-c', script], { cwd: dir, encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', TMPDIR: dir, REAL_NODE: process.execPath } });
    assert.match(out, /^flags: --lan --no-tls -p 8081$/m);
    assert.match(out, /^spawn: pid \d+$/m);
    assert.ok(existsSync(join(dir, '-l', 'server.log')), 'log opened at the dash-leading path');
    assert.match(readFileSync(CORE, 'utf8'), /-e "\$NIDUM_SETTINGS_JS" -- /);
    assert.match(readFileSync(CORE, 'utf8'), /-e "\$NIDUM_SPAWN_JS" -- /);
  });
});

// ------------------------------------------------------------------ iteration 4 (D40-D43: paused service, menu bar app)

describe('paused startup service (D43)', () => {
  const paused = (opts = {}) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, stubs: [...DEFAULT_STUBS, 'sudo'], ...opts });
    writeFileSync(join(sb.state, 'service-unloaded'), '');
    sb.dashboardUp();
    return sb;
  };

  test('Yes: explains the password, sudo launchctl bootstrap system <plist>, waits, continues', async () => {
    const sb = paused();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /\? Network sharing is paused\.\n {4}Start sharing again\? \[Y\/n\] {5}Your computer will ask for your password so Nidum Local can start network sharing again\.\n {2}… Starting network sharing/);
    assert.match(r.out, /✓ Network sharing is on \(kept on by the startup service\)/);
    const calls = sb.calls();
    assert.ok(calls.includes('launchctl print system/sh.portless.proxy'));
    assert.ok(calls.includes(`sudo launchctl bootstrap system ${sb.env.NIDUM_SERVICE_PLIST}`), calls.join('\n'));
    assert.ok(!has(calls, /^portless proxy/), 'never starts a proxy itself');
    assert.ok(calls.includes(`open http://127.0.0.1:47811/?t=${TOKEN}`));
    assert.doesNotMatch(r.out, /isn't responding/);
  });

  test('No: sharing stays paused, the dashboard still opens', async () => {
    const sb = paused();
    const r = await run(sb, { input: 'n\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! Network sharing stays paused, so other devices can't reach your addresses\. You can start it from the dashboard\./);
    assert.ok(!has(sb.calls(), /^sudo |bootstrap/));
    assert.ok(sb.calls().includes(`open http://127.0.0.1:47811/?t=${TOKEN}`));
  });

  test('bootstrap fails: failure screen with the launchctl message and both hints', async () => {
    const sb = paused({ env: { STUB_BOOTSTRAP: 'fail' } });
    const r = await run(sb, { input: '\nx' });
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Couldn't start network sharing again\.\n\n {4}What happened: Bootstrap failed: 5: Input\/output error\n {4}What to try: {3}sudo launchctl kickstart -k system\/sh\.portless\.proxy \(or, if it isn't loaded: sudo launchctl bootstrap system /);
  });

  test('loaded but not answering still gets the wait and the "isn\'t responding" screen', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /The startup service isn't responding\./);
    assert.doesNotMatch(r.out, /paused/);
  });

  test('dry run: prompt auto-answered, bootstrap printed, nothing run', async () => {
    const sb = paused({ env: { NIDUM_DRY_RUN: '1' } });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`[dry run] would run: sudo launchctl bootstrap system ${sb.env.NIDUM_SERVICE_PLIST}`), r.out);
    assert.ok(!has(sb.calls(), /^sudo |bootstrap/));
  });

  test('Linux (experimental): inactive unit → asks, sudo systemctl start portless.service', async () => {
    const sb = sandbox({ platform: 'linux', stubs: ['node', 'portless', 'curl', 'xdg-open', 'avahi-publish-address', 'systemctl', 'sudo'], service: { port: 80 }, stateFromService: true });
    writeFileSync(join(sb.state, 'service-unloaded'), '');
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('sudo systemctl start portless.service'), sb.calls().join('\n'));
    assert.match(r.out, /✓ Network sharing is on \(kept on by the startup service\)/);
  });
});

describe('menu bar app (D40, N7 placement)', () => {
  const menu = (opts = {}) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, ...opts, env: { NIDUM_NO_MENUBAR: '', ...(opts.env ?? {}) } });
    sb.proxyUp(80);
    sb.dashboardUp();
    return sb;
  };
  const openApp = (calls) => calls.filter((c) => c.startsWith('open -g -a '));

  test('prebuilt app next to the app root: started once with --app-root and NIDUM_HOME', async () => {
    const sb = menu();
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000 });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Menu bar app started/);
    assert.deepEqual(openApp(sb.calls()), [`open -g -a ${sb.app}/macos/Nidum Local Menu.app --env NIDUM_HOME=${sb.nidumHome} --args --app-root ${sb.app} --node ${sb.bin}/node`]);
    assert.ok(r.out.indexOf('Opening http://127.0.0.1') < r.out.indexOf('Menu bar app started'), 'after the dashboard');
  });

  test('already running (single instance), same version: not started again', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps'] });
    const prebuilt = join(sb.app, 'macos', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, prebuilt], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '1.0.0', STUB_LOG: '' } });
    writeFileSync(join(sb.state, 'processes'), `${UID} NidumLocalMenu 777001\n`);
    writeFileSync(join(sb.state, 'ps-777001'), `${prebuilt}/Contents/MacOS/NidumLocalMenu\n`);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Menu bar app is already running/);
    assert.ok(sb.calls().includes(`pgrep -U ${UID} -x -- NidumLocalMenu`), sb.calls().join('\n'));
    assert.deepEqual(openApp(sb.calls()), []);
  });

  test('running, but its bundle can\'t be told: the current one is started (open -a and the app\'s lock keep one)', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps'] });
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000 });
    writeFileSync(join(sb.state, 'processes'), `${UID} NidumLocalMenu 777002\n${UID} NidumLocalMenu\n`);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Menu bar app started/);
    assert.doesNotMatch(r.out, /Restarting/);
    assert.match(sb.log(), /menu bar app running: pid 777002, bundle unknown, version unknown/);
    assert.equal(openApp(sb.calls()).length, 1);
  });

  test('decoys never count as running: another user\'s menu app, or a process that only mentions the bundle path', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep'] });
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000 });
    writeFileSync(join(sb.state, 'processes'), [
      `${UID + 1} NidumLocalMenu`,
      `${UID} perl -e sleep /tmp/x/Nidum Local Menu.app/Contents/MacOS/NidumLocalMenu`,
      `${UID} NidumLocalMenuX`,
    ].join('\n') + '\n');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Menu bar app started/);
    assert.equal(openApp(sb.calls()).length, 1);
  });

  test('real pgrep: a decoy whose arguments name the bundle and the executable is ignored; a process with that name is found', async () => {
    // Read-only use of the real /usr/bin/pgrep. The launcher looks for a unique executable name
    // here (NIDUM_MENU_EXEC), so menu apps from other tests or the user can't interfere.
    const pgrep = '/usr/bin/pgrep';
    const name = `NLMtest${process.pid}`.slice(0, 15);
    const sb = menu({ env: { NIDUM_MENU_EXEC: name } });
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000 });
    symlinkSync(pgrep, join(sb.bin, 'pgrep'));
    const decoy = spawn('/usr/bin/perl', ['-e', 'sleep 30', `${sb.dir}/Nidum Local Menu.app/Contents/MacOS/${name}`, name], { stdio: 'ignore' });
    try {
      await sleepMs(200);
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Menu bar app started/);
      assert.equal(openApp(sb.calls()).length, 1);
    } finally { decoy.kill('SIGKILL'); }
    // A process really named <name>: /bin/sleep run through a symlink of that name (macOS kills
    // a copied platform binary, but names the process after the symlink), inside a bundle of
    // the same version as the prebuilt one. The real ps tells the launcher which bundle it is.
    symlinkSync('/bin/ps', join(sb.bin, 'ps'));
    const running = join(sb.dir, 'running', 'Nidum Local Menu.app');
    fakeBundle(running, { version: '0.0.0', exec: name });
    const fake = join(running, 'Contents', 'MacOS', name);
    symlinkSync('/bin/sleep', fake);
    const proc = spawn(fake, ['30'], { stdio: 'ignore' });
    try {
      let seen = false;
      for (let i = 0; i < 40 && !seen; i++) {
        seen = spawnSync(pgrep, ['-U', String(UID), '-x', name], { timeout: 5000 }).status === 0;
        if (!seen) await sleepMs(50);
      }
      assert.ok(seen, 'the stand-in process is running');
      writeFileSync(sb.env.STUB_LOG, '');
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Menu bar app is already running/);
      assert.deepEqual(openApp(sb.calls()), []);
    } finally { proc.kill('SIGKILL'); }
  });

  test('real pgrep and ps: an older version of the menu app (own process, exact name) gets SIGTERM, then the current one starts (D52)', async () => {
    const pgrep = '/usr/bin/pgrep';
    const name = `NLMold${process.pid}`.slice(0, 15);
    const sb = menu({ env: { NIDUM_MENU_EXEC: name } });
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '1.0.0', STUB_LOG: '' } });
    symlinkSync(pgrep, join(sb.bin, 'pgrep'));
    symlinkSync('/bin/ps', join(sb.bin, 'ps'));
    const old = join(sb.dir, 'old copy', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0', exec: name });
    symlinkSync('/bin/sleep', join(old, 'Contents', 'MacOS', name));
    const proc = spawn(join(old, 'Contents', 'MacOS', name), ['30'], { stdio: 'ignore' });
    const exited = new Promise((res) => proc.on('exit', (code, signal) => res(signal)));
    try {
      let seen = false;
      for (let i = 0; i < 40 && !seen; i++) {
        seen = spawnSync(pgrep, ['-U', String(UID), '-x', name], { timeout: 5000 }).status === 0;
        if (!seen) await sleepMs(50);
      }
      assert.ok(seen, 'the stand-in process is running');
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /… Restarting the menu bar app for version 1\.0\.0\n {2}✓ Menu bar app started/);
      assert.equal(await exited, 'SIGTERM');
      assert.ok(sb.log().includes(`menu bar app running: pid ${proc.pid}, bundle ${old}, version 0.9.0`), sb.log());
      assert.match(sb.log(), /older one quit after \d+ ms/);
      assert.equal(openApp(sb.calls()).length, 1);
    } finally { proc.kill('SIGKILL'); }
  });

  test('no prebuilt app, swiftc present: builds once into NIDUM_HOME/app, then reuses it', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'swiftc'] });
    mkdirSync(join(sb.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
    writeFileSync(join(sb.app, 'package.json'), '{\n  "name": "nidum-local",\n  "version": "1.2.3"\n}\n');
    const built = join(sb.nidumHome, 'app', 'Nidum Local Menu.app');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /… Building the menu bar app \(first run only\)\n {2}✓ Menu bar app started/);
    assert.ok(sb.calls().includes(`build-menubar ${built}`), sb.calls().join('\n'));
    assert.ok(sb.calls().includes('build-menubar archs=native'), 'this Mac\'s architecture only');
    assert.match(readFileSync(join(built, 'Contents', 'Info.plist'), 'utf8'), /<string>1\.2\.3<\/string>/);
    assert.ok(existsSync(join(built, 'Contents', 'Info.plist')));
    assert.deepEqual(openApp(sb.calls()), [`open -g -a ${built} --env NIDUM_HOME=${sb.nidumHome} --args --app-root ${sb.app} --node ${sb.bin}/node`]);
    writeFileSync(sb.env.STUB_LOG, '');
    const again = await run(sb);
    assert.equal(again.code, 0, again.out);
    assert.ok(!has(sb.calls(), /^build-menubar /), 'built only once');
    assert.equal(openApp(sb.calls()).length, 1);
  });

  test('a build in NIDUM_HOME/app from an older version is rebuilt once, then reused', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'swiftc'] });
    mkdirSync(join(sb.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
    writeFileSync(join(sb.app, 'package.json'), '{\n  "name": "nidum-local",\n  "version": "1.0.0"\n}\n');
    const built = join(sb.nidumHome, 'app', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, built], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '0.9.0', STUB_LOG: '' } });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /… Updating the menu bar app\n {2}✓ Menu bar app started/);
    assert.ok(sb.calls().includes(`build-menubar ${built}`), sb.calls().join('\n'));
    assert.ok(sb.calls().includes('build-menubar archs=native'));
    assert.match(sb.log(), /menu bar app in .* is version 0\.9\.0, Nidum Local is 1\.0\.0: rebuilding/);
    assert.match(readFileSync(join(built, 'Contents', 'Info.plist'), 'utf8'), /<string>1\.0\.0<\/string>/);
    writeFileSync(sb.env.STUB_LOG, '');
    const again = await run(sb);
    assert.equal(again.code, 0, again.out);
    assert.ok(!has(sb.calls(), /^build-menubar /), 'rebuilt only once');
    assert.equal(openApp(sb.calls()).length, 1);
  });

  test('an older build that cannot be rebuilt (no swiftc) is not started: one ! line', async () => {
    const sb = menu();
    writeFileSync(join(sb.app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    const built = join(sb.nidumHome, 'app', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, built], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '0.9.0', STUB_LOG: '' } });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! The menu bar app is from an earlier version and can't be rebuilt here\. The dashboard works without it\./);
    assert.deepEqual(openApp(sb.calls()), []);
  });

  test('build limit outlasts build-menubar.sh\'s own worst case for one architecture', () => {
    const core = readFileSync(CORE, 'utf8');
    const limit = Number(core.match(/^NIDUM_MENU_BUILD_LIMIT=(\d+)$/m)[1]);
    const script = readFileSync(join(ROOT, 'scripts', 'build-menubar.sh'), 'utf8');
    // One architecture: every deadline except lipo -create (used only for two or more).
    const steps = [...script.matchAll(/deadline (\d+) (\S+)(?: (\S+))?/g)]
      .filter((m) => !(m[2] === 'lipo' && m[3] === '-create'))
      .map((m) => Number(m[1]));
    const worst = steps.reduce((a, b) => a + b, 0);
    assert.ok(steps.length >= 5, `deadlines found: ${steps}`);
    assert.ok(limit > worst, `launcher limit ${limit} s vs build script worst case ${worst} s`);
    assert.match(core, /NIDUM_MENUBAR_ARCHS=native nidum_capture \$NIDUM_MENU_BUILD_LIMIT /);
    assert.match(script, /-module-name NidumLocalMenu /);
    const plist = readFileSync(join(ROOT, 'macos', 'menubar', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>NidumLocalMenu<\/string>/);
    // D58: the launcher's bundle id is N7's, and the fake build script writes the same one.
    assert.ok(plist.includes(`<key>CFBundleIdentifier</key>\n\t<string>${MENU_ID}</string>`), 'N7 bundle id');
    assert.match(core, new RegExp(`^NIDUM_MENU_ID=${MENU_ID.replaceAll('.', '\\.')}$`, 'm'));
    assert.ok(readFileSync(BUILD_STUB, 'utf8').includes(`<string>${MENU_ID}</string>`));
  });

  test('no prebuilt app and no swiftc: one ! line, launcher still succeeds', async () => {
    const sb = menu();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.equal((r.out.match(/^ {2}! /gm) ?? []).length, 1, r.out);
    assert.match(r.out, /! The menu bar app isn't included and can't be built here \(no Swift compiler\)\./);
    assert.deepEqual(openApp(sb.calls()), []);
  });

  test('swiftc present but no build script yet (N7 pending): one ! line', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'swiftc'] });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! The menu bar app isn't included in this copy of Nidum Local\./);
    assert.ok(!has(sb.calls(), /^swiftc /), 'swiftc never invoked by the launcher');
  });

  test('build fails: one ! line, details in the log, launcher still succeeds', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'swiftc'], env: { STUB_BUILD_FAIL: '1' } });
    mkdirSync(join(sb.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /! Couldn't build the menu bar app\. The dashboard works without it\. Details are in the log\./);
    assert.match(sb.log(), /menu bar build failed: error: build failed/);
    assert.deepEqual(openApp(sb.calls()), []);
  });

  test('NIDUM_NO_MENUBAR=1 and Linux: no menu bar app at all', async () => {
    const sb = menu({ env: { NIDUM_NO_MENUBAR: '1' } });
    execFileSync(BASH, [BUILD_STUB, join(sb.app, 'macos', 'Nidum Local Menu.app')], { timeout: 10000 });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Menu bar/);
    assert.deepEqual(openApp(sb.calls()), []);
    const lx = sandbox({ platform: 'linux', stubs: ['node', 'portless', 'curl', 'xdg-open', 'avahi-publish-address'], service: { port: 80 }, stateFromService: true, env: { NIDUM_NO_MENUBAR: '' } });
    lx.proxyUp(80);
    lx.dashboardUp();
    const l = await run(lx);
    assert.equal(l.code, 0, l.out);
    assert.doesNotMatch(l.out, /[Mm]enu bar/);
  });
});

// ------------------------------------------------------------------ iteration 6 (validation 5 findings, D52)

describe('menu app update flow (D52) and validation 5 findings', () => {
  const menu = (opts = {}) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, stubs: [...DEFAULT_STUBS, 'pgrep', 'ps'], ...opts, env: { NIDUM_NO_MENUBAR: '', ...(opts.env ?? {}) } });
    sb.proxyUp(80);
    sb.dashboardUp();
    return sb;
  };
  const openApp = (calls) => calls.filter((c) => c.startsWith('open -g -a '));
  const prebuilt = (sb, version) => {
    const app = join(sb.app, 'macos', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, app], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: version, STUB_LOG: '' } });
    return app;
  };
  /** A real process of ours (a sleep) that the stub pgrep reports as NidumLocalMenu, running from `bundle`. */
  const standIn = (sb, bundle, { ignoreTerm = false } = {}) => {
    const proc = ignoreTerm
      ? spawn('/usr/bin/perl', ['-e', '$SIG{TERM} = "IGNORE"; sleep 30'], { stdio: 'ignore' })
      : spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((res) => proc.on('exit', (code, signal) => res(signal)));
    writeFileSync(join(sb.state, 'processes'), `${UID} NidumLocalMenu ${proc.pid}\n`);
    if (bundle) writeFileSync(join(sb.state, `ps-${proc.pid}`), `${bundle}/Contents/MacOS/NidumLocalMenu\n`);
    return { proc, exited };
  };

  test('an older menu app from another folder: SIGTERM, it quits, the current bundle starts with --node and --app-root', async () => {
    const sb = menu();
    const app = prebuilt(sb, '1.0.0');
    const old = join(sb.dir, 'old', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0' });
    const { proc, exited } = standIn(sb, old);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /… Restarting the menu bar app for version 1\.0\.0\n {2}✓ Menu bar app started/);
      assert.equal(await exited, 'SIGTERM');
      assert.match(sb.log(), new RegExp(`SIGTERM to pid ${proc.pid} \\(another version than 1\\.0\\.0\\)`));
      assert.deepEqual(openApp(sb.calls()), [`open -g -a ${app} --env NIDUM_HOME=${sb.nidumHome} --args --app-root ${sb.app} --node ${sb.bin}/node`]);
      assert.equal(r.err, '');
    } finally { proc.kill('SIGKILL'); }
  });

  test('same version already running: left alone, nothing built or started', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps', 'swiftc'] });
    mkdirSync(join(sb.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
    writeFileSync(join(sb.app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    // Running from another copy of the same version; NIDUM_HOME/app has no build yet.
    const other = join(sb.dir, 'other', 'Nidum Local Menu.app');
    fakeBundle(other, { version: '1.0.0' });
    const { proc } = standIn(sb, other);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Menu bar app is already running/);
      assert.ok(alive(proc.pid), 'not signalled');
      assert.ok(!has(sb.calls(), /^build-menubar /), 'no build');
      assert.deepEqual(openApp(sb.calls()), []);
    } finally { proc.kill('SIGKILL'); }
  });

  test('rebuild in place: the running version is read before the build replaces its bundle', async () => {
    const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps', 'swiftc'] });
    mkdirSync(join(sb.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
    writeFileSync(join(sb.app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    const built = join(sb.nidumHome, 'app', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, built], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '0.9.0', STUB_LOG: '' } });
    const { proc, exited } = standIn(sb, built);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /… Updating the menu bar app\n {2}… Restarting the menu bar app for version 1\.0\.0\n {2}✓ Menu bar app started/);
      assert.equal(await exited, 'SIGTERM');
      const calls = sb.calls();
      assert.ok(calls.indexOf(`ps -o comm= -p ${proc.pid}`) < calls.findIndex((c) => c.startsWith('build-menubar ')), calls.join('\n'));
      assert.equal(openApp(calls).length, 1);
    } finally { proc.kill('SIGKILL'); }
  });

  test('unknown bundle: a path outside a bundle, or a bundle naming another executable, is never signalled', async () => {
    for (const where of ['plain', 'other-exec', 'other-id']) {
      const sb = menu();
      prebuilt(sb, '1.0.0');
      let path;
      if (where === 'plain') {
        path = join(sb.dir, 'bin-dir');
        mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
      } else if (where === 'other-exec') {
        path = join(sb.dir, 'x', 'Other.app');
        fakeBundle(path, { version: '0.9.0', exec: 'SomethingElse' });
      } else {
        // D58: right executable name and an older version, but another app's bundle id.
        path = join(sb.dir, 'x', 'Nidum Local Menu.app');
        fakeBundle(path, { version: '0.9.0', id: 'com.example.notnidum' });
      }
      const { proc } = standIn(sb, path);
      try {
        const r = await run(sb);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /✓ Menu bar app started/);
        assert.doesNotMatch(r.out, /Restarting/);
        assert.ok(alive(proc.pid), `${where}: not signalled`);
        assert.equal(openApp(sb.calls()).length, 1);
      } finally { proc.kill('SIGKILL'); }
    }
  });

  test('an older menu app that ignores SIGTERM: waits at most 3 s, then starts the current one anyway', async (t) => {
    const sb = menu();
    prebuilt(sb, '1.0.0');
    const old = join(sb.dir, 'old', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0' });
    const { proc } = standIn(sb, old, { ignoreTerm: true });
    try {
      await sleepMs(200); // perl has set its handler
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Menu bar app started/);
      const m = sb.log().match(/pid (\d+) still running after (\d+) ms; starting this version anyway/);
      assert.ok(m, sb.log());
      t.diagnostic(`gave up waiting after ${m[2]} ms; launcher ${r.ms} ms`);
      assert.ok(Number(m[2]) >= 3000 && Number(m[2]) <= 3600, `${m[2]} ms`);
      assert.ok(alive(proc.pid));
      assert.equal(openApp(sb.calls()).length, 1);
    } finally { proc.kill('SIGKILL'); }
  });

  test('dry run: prints the SIGTERM it would send, sends nothing', async () => {
    const sb = menu({ env: { NIDUM_DRY_RUN: '1' } });
    prebuilt(sb, '1.0.0');
    const old = join(sb.dir, 'old', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0' });
    const { proc } = standIn(sb, old);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.includes(`[dry run] would run: kill -TERM ${proc.pid}`), r.out);
      assert.match(r.out, /\[dry run\] would run: open -g -a .* --args --app-root .* --node /);
      assert.ok(alive(proc.pid), 'not signalled');
      assert.deepEqual(openApp(sb.calls()), []);
    } finally { proc.kill('SIGKILL'); }
  });

  test('NIDUM_MENU_EXEC "-v" or ".*" never reaches pgrep as an option or a regex; an inherited UID is ignored', async () => {
    for (const value of ['-v', '.*', '-U0']) {
      const sb = menu({ env: { NIDUM_MENU_EXEC: value, UID: '0' } });
      prebuilt(sb, '1.0.0');
      writeFileSync(join(sb.state, 'processes'), `0 ${value}\n${UID} ${value}\n`);
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Menu bar app started/, value);
      assert.deepEqual(sb.calls().filter((c) => c.startsWith('pgrep ')), [`pgrep -U ${UID} -x -- NidumLocalMenu`], value);
    }
  });

  /** Our own process with a unique name: /bin/sleep through a symlink of that name in `folder`. */
  const ownNamed = async (folder, name) => {
    mkdirSync(folder, { recursive: true });
    const exe = join(folder, name);
    symlinkSync('/bin/sleep', exe);
    const proc = spawn(exe, ['30'], { stdio: 'ignore' });
    const exited = new Promise((res) => proc.on('exit', (code, signal) => res(signal)));
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = spawnSync('/usr/bin/pgrep', ['-U', String(UID), '-x', '--', name], { timeout: 5000 }).status === 0;
      if (!seen) await sleepMs(50);
    }
    assert.ok(seen, `the stand-in ${name} is running`);
    return { proc, exited, exe };
  };
  const realTools = (sb) => {
    symlinkSync('/usr/bin/pgrep', join(sb.bin, 'pgrep'));
    symlinkSync('/bin/ps', join(sb.bin, 'ps'));
  };

  test('real pgrep and ps: our own process with the exact name but outside any bundle is found, not signalled, and the app is started', async () => {
    // Deterministic: the name is unique to this run and the process is ours, so pgrep finds
    // exactly it, whatever else runs on the machine (macOS pgrep leaves out its own ancestors,
    // so the launcher's own shell is never a candidate).
    const name = `NLMplain${process.pid}`.slice(0, 15);
    const sb = menu({ stubs: DEFAULT_STUBS, env: { NIDUM_MENU_EXEC: name } });
    prebuilt(sb, '1.0.0');
    realTools(sb);
    const { proc } = await ownNamed(join(sb.dir, 'plain folder'), name);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      const found = sb.log().match(/menu bar app running: .*/g) ?? [];
      assert.deepEqual(found, [`menu bar app running: pid ${proc.pid}, bundle unknown, version unknown`], sb.log());
      assert.match(r.out, /✓ Menu bar app started/);
      assert.doesNotMatch(r.out + sb.log(), /SIGTERM|Restarting/);
      assert.ok(alive(proc.pid), 'not signalled');
      assert.equal(openApp(sb.calls()).length, 1);
    } finally { proc.kill('SIGKILL'); }
  });

  test('real pgrep and ps (D58): a decoy app with the exact executable name and an older version but another bundle id is never signalled', async () => {
    const name = `NLMfoo${process.pid}`.slice(0, 15);
    const sb = menu({ stubs: DEFAULT_STUBS, env: { NIDUM_MENU_EXEC: name } });
    prebuilt(sb, '1.0.0');
    realTools(sb);
    const decoy = join(sb.dir, 'apps', 'Foo Editor.app');
    fakeBundle(decoy, { version: '5.2.1', exec: name, id: 'com.example.fooeditor' });
    const { proc } = await ownNamed(join(decoy, 'Contents', 'MacOS'), name);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      assert.ok(sb.log().includes(`menu bar app running: pid ${proc.pid}, bundle unknown, version unknown`), sb.log());
      assert.match(r.out, /✓ Menu bar app started/);
      assert.doesNotMatch(r.out + sb.log(), /SIGTERM|Restarting/);
      await sleepMs(300);
      assert.ok(alive(proc.pid), 'the decoy was never signalled');
      assert.equal(openApp(sb.calls()).length, 1);
    } finally { proc.kill('SIGKILL'); }
  });

  test('dry run with an older build in NIDUM_HOME/app: reports the rebuild and the restart for the current version, like a real run', async () => {
    for (const running of ['0.9.0', '0.8.0']) {
      const sb = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps', 'swiftc'], env: { NIDUM_DRY_RUN: '1' } });
      mkdirSync(join(sb.app, 'scripts'));
      copyFileSync(BUILD_STUB, join(sb.app, 'scripts', 'build-menubar.sh'));
      writeFileSync(join(sb.app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
      const built = join(sb.nidumHome, 'app', 'Nidum Local Menu.app');
      execFileSync(BASH, [BUILD_STUB, built], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '0.9.0', STUB_LOG: '' } });
      // 0.9.0: running from that very build. 0.8.0: running from another folder.
      let from = built;
      if (running !== '0.9.0') {
        from = join(sb.dir, 'older', 'Nidum Local Menu.app');
        fakeBundle(from, { version: running });
      }
      const { proc } = standIn(sb, from);
      try {
        const r = await run(sb);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /… Updating the menu bar app\n {4}\[dry run\] would run: NIDUM_MENUBAR_ARCHS=native \/bin\/bash /, `${running}\n${r.out}`);
        assert.match(r.out, /… Restarting the menu bar app for version 1\.0\.0\n/, `${running}\n${r.out}`);
        assert.ok(r.out.includes(`[dry run] would run: kill -TERM ${proc.pid}`), r.out);
        assert.match(r.out, /\[dry run\] would run: open -g -a .*Nidum\\ Local\\ Menu\.app --env /);
        assert.doesNotMatch(r.out, /Menu bar app is already running|version 0\.9\.0/);
        assert.ok(alive(proc.pid), 'not signalled');
        assert.ok(!has(sb.calls(), /^build-menubar /), 'nothing built');
        assert.deepEqual(openApp(sb.calls()), []);
        assert.match(readFileSync(join(built, 'Contents', 'Info.plist'), 'utf8'), /<string>0\.9\.0<\/string>/);
      } finally { proc.kill('SIGKILL'); }
    }
  });

  test('D58: the current app fails to open after the older one got SIGTERM: the older bundle is reopened with the same arguments, one ! line', async () => {
    const sb = menu();
    const app = prebuilt(sb, '1.0.0');
    sb.env.STUB_OPEN_FAIL_APP = app;
    const old = join(sb.dir, 'old copy', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0' });
    const { proc, exited } = standIn(sb, old);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out + r.err);
      assert.equal(await exited, 'SIGTERM');
      const tail = `--env NIDUM_HOME=${sb.nidumHome} --args --app-root ${sb.app} --node ${sb.bin}/node`;
      assert.deepEqual(openApp(sb.calls()), [`open -g -a ${app} ${tail}`, `open -g -a ${old} ${tail}`]);
      const warns = r.out.match(/^ {2}! .*/gm) ?? [];
      assert.deepEqual(warns, ['  ! Couldn\'t start the new menu bar app, so the earlier version was started again. Details are in the log.'], r.out);
      assert.doesNotMatch(r.out, /Menu bar app started/);
      assert.ok(sb.log().includes(`didn't start; reopening the earlier one: ${old}`), sb.log());
      assert.equal(r.err, '');
    } finally { proc.kill('SIGKILL'); }
  });

  test('D58: if reopening the older bundle fails too, one ! line; a rebuild in place is not reopened (same bundle)', async () => {
    // Both opens fail.
    const sb = menu({ env: { STUB_OPEN_FAIL: '1' } });
    const app = prebuilt(sb, '1.0.0');
    const old = join(sb.dir, 'old', 'Nidum Local Menu.app');
    fakeBundle(old, { version: '0.9.0' });
    const a = standIn(sb, old);
    try {
      const r = await run(sb);
      assert.equal(r.code, 0, r.out);
      assert.equal(await a.exited, 'SIGTERM');
      assert.deepEqual(openApp(sb.calls()).map((c) => c.split(' --env ')[0]), [`open -g -a ${app}`, `open -g -a ${old}`]);
      assert.deepEqual(r.out.match(/^ {2}! .*/gm), ['  ! Couldn\'t start the menu bar app. The dashboard works without it.'], r.out);
      assert.match(sb.log(), /reopening .* failed too/);
    } finally { a.proc.kill('SIGKILL'); }
    // Rebuilt in place: the older app ran from the bundle that was just replaced and failed.
    const sb2 = menu({ stubs: [...DEFAULT_STUBS, 'pgrep', 'ps', 'swiftc'] });
    mkdirSync(join(sb2.app, 'scripts'));
    copyFileSync(BUILD_STUB, join(sb2.app, 'scripts', 'build-menubar.sh'));
    writeFileSync(join(sb2.app, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    const built = join(sb2.nidumHome, 'app', 'Nidum Local Menu.app');
    execFileSync(BASH, [BUILD_STUB, built], { timeout: 10000, env: { ...process.env, STUB_BUILD_VERSION: '0.9.0', STUB_LOG: '' } });
    sb2.env.STUB_OPEN_FAIL_APP = built;
    const b = standIn(sb2, built);
    try {
      const r = await run(sb2);
      assert.equal(r.code, 0, r.out);
      assert.equal(await b.exited, 'SIGTERM');
      assert.equal(openApp(sb2.calls()).length, 1, sb2.calls().join('\n'));
      assert.deepEqual(r.out.match(/^ {2}! .*/gm), ['  ! Couldn\'t start the menu bar app. The dashboard works without it.'], r.out);
    } finally { b.proc.kill('SIGKILL'); }
  });

  test('relative NIDUM_APP_ROOT: --app-root is made absolute for the menu app', async () => {
    const sb = menu({ stubs: DEFAULT_STUBS });
    prebuilt(sb, '1.0.0');
    sb.env.NIDUM_APP_ROOT = '../app'; // run() starts in sb.home, next to sb.app
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(openApp(sb.calls()), [`open -g -a ${sb.home}/../app/macos/Nidum Local Menu.app --env NIDUM_HOME=${sb.nidumHome} --args --app-root ${sb.home}/../app --node ${sb.bin}/node`]);
  });

  test('resume after Yes has a hard deadline: never past NIDUM_RESUME_WAIT against a hanging probe', async (t) => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true, stubs: [...DEFAULT_STUBS, 'sudo'], env: { STUB_CURL_HANG: '1', NIDUM_SERVICE_WAIT: '5', NIDUM_RESUME_WAIT: '3' } });
    writeFileSync(join(sb.state, 'service-unloaded'), '');
    const r = await run(sb, { input: '\nx' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ Couldn't start network sharing again\.\n\n {4}What happened: The startup service started, but nothing answers on port 80\./);
    const waited = Number((sb.log().match(/resume wait: gave up after (\d+) ms/) ?? [])[1]);
    t.diagnostic(`launcher ${r.ms} ms, resume wait ${waited} ms`);
    assert.ok(waited >= 2000 && waited <= 3500, `resume wait ${waited} ms`);
    const probes = sb.calls().filter((c) => c.startsWith('curl '));
    assert.ok(probes.every((c) => / -m (1|1\.000|0\.\d{3}) /.test(c)), probes.join('\n'));
    assert.equal(r.err, '');
  });

  test('a command killed by its time limit leaves no "Terminated: 15" line, and still exits 143', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nidum-n5-term-')));
    sandboxes.push({ dir });
    const script = `. "${CORE}"
NIDUM_LOG_FILE=''
nidum_capture 0.3 /bin/sleep 5; echo "rc=$?"`;
    const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', TMPDIR: dir } });
    assert.match(r.stdout, /^rc=143$/m);
    assert.equal(r.stderr, '', 'no job report on the window');
  });
});

// ------------------------------------------------------------------ failure screen waits (criterion 4)

describe('failure screen', () => {
  test('stays open until a key is pressed', async () => {
    const sb = sandbox({ service: { port: 80 }, stateFromService: true });
    const child = spawn(BASH, [MAC], { env: sb.env, cwd: sb.home });
    let out = '';
    let exited = false;
    child.stdout.on('data', (d) => { out += d; });
    const closed = new Promise((r) => child.on('close', (code) => { exited = true; r(code); }));
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    while (!out.includes('Press any key to close.') && !exited) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(exited, false, 'launcher exited without waiting for a key');
    child.stdin.write('q');
    const code = await closed;
    clearTimeout(killer);
    assert.equal(code, 1);
    assert.match(out, /What happened: .*\n {4}What to try: .*\n {4}Details: /);
  });
});

// ------------------------------------------------------------------ Linux (experimental)

describe('Linux launcher (experimental, stubbed)', () => {
  const linuxStubs = ['node', 'portless', 'curl', 'xdg-open', 'npm', 'avahi-publish-address'];

  test('(a) everything present + server alive: reuse, xdg-open with the token URL', async () => {
    const sb = sandbox({ platform: 'linux', stubs: linuxStubs, service: { port: 80 }, stateFromService: true });
    sb.proxyUp(80);
    sb.dashboardUp(47811);
    const r = await run(sb);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(promptLines(r.out), []);
    assert.match(r.out, /✓ Avahi found/);
    assert.ok(sb.calls().includes(`xdg-open http://127.0.0.1:47811/?t=${TOKEN}`));
    assert.ok(!has(sb.calls(), /^portless proxy/));
  });

  test('(b) Portless missing, Node 24, no brew: npm install -g portless', async () => {
    const sb = sandbox({ platform: 'linux', stubs: ['node', 'curl', 'xdg-open', 'npm', 'avahi-publish-address'], env: { STUB_NODE_VERSION: 'v24.1.0' } });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('npm install -g portless'));
  });

  test('(c) no service, proxy stopped: proxy start --lan with explicit flags, no firewall note', async () => {
    const sb = sandbox({ platform: 'linux', stubs: linuxStubs });
    sb.dashboardUp();
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('portless proxy start --lan --https -p 443'));
    assert.doesNotMatch(r.out, /allow incoming connections/);
  });

  test('(d) systemd unit installed but not responding: failure screen, systemctl hint', async () => {
    const sb = sandbox({ platform: 'linux', stubs: linuxStubs, service: { port: 80 }, stateFromService: true });
    const r = await run(sb, { input: 'x' });
    assert.equal(r.code, 1);
    assert.match(r.out, /What to try: {3}sudo systemctl restart portless\.service/);
    assert.ok(!has(sb.calls(), /^portless proxy/));
  });

  test('(e) server not running: started, polled, xdg-open', async () => {
    const sb = sandbox({ platform: 'linux', stubs: linuxStubs });
    sb.proxyUp(443, { tls: true });
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(sb.calls().includes('node src/server.js'));
    assert.ok(sb.calls().includes(`xdg-open http://127.0.0.1:47800/?t=${SERVER_TOKEN}`));
  });

  test('Avahi missing: asks, installs avahi-utils through (stub) sudo apt-get', async () => {
    const sb = sandbox({ platform: 'linux', stubs: ['node', 'portless', 'curl', 'xdg-open', 'sudo', 'apt-get'] });
    sb.proxyUp(443, { tls: true });
    sb.dashboardUp();
    const r = await run(sb, { input: '\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\? Other devices find your addresses through Avahi, which isn't installed\./);
    assert.ok(sb.calls().includes('sudo apt-get install -y avahi-utils'));
  });
});

// ------------------------------------------------------------------ shim + packaging (criterion 5)

describe('shim and package', () => {
  test('root shim resolves its real path through a symlink and hands over to the macOS launcher', async () => {
    const sb = sandbox({ appRoot: false, service: { port: 80 }, stateFromService: true, env: { NIDUM_DRY_RUN: '1' } });
    sb.proxyUp(80);
    const link = join(sb.dir, 'Desktop', 'Nidum Local.command');
    mkdirSync(dirname(link));
    symlinkSync(SHIM, link);
    const r = await run(sb, { script: link });
    // The repo has no src/server.js until N3 lands; either way the shim must reach the launcher
    // with the repo as app root.
    if (existsSync(join(ROOT, 'src', 'server.js'))) {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.includes(`would run: cd ${ROOT.replaceAll(' ', '\\ ')} &&`), r.out);
    } else {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /src\/server\.js is missing from /);
      assert.match(r.out, /dry run: not waiting/);
    }
    assert.match(r.out, /✓ Network sharing is on \(kept on by the startup service\)/);
  });

  test('package.sh builds nidum-local-<version>.zip under one top-level folder, with the menu app; the unzipped shim runs in dry-run mode', async () => {
    const sb = sandbox({ appRoot: false, service: { port: 80 }, stateFromService: true, env: { NIDUM_DRY_RUN: '1', NIDUM_NO_MENUBAR: '' } });
    sb.proxyUp(80);
    const outDir = join(sb.dir, 'dist');
    // The menu app is built by a fake build script (never swiftc) straight into the staging folder.
    const zipPath = execFileSync(BASH, [PACKAGE, outDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: sb.env.TMPDIR, NIDUM_MENUBAR_BUILD: BUILD_STUB, STUB_LOG: sb.env.STUB_LOG }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const top = `nidum-local-${version}`;
    assert.equal(zipPath, join(outDir, `${top}.zip`));
    const listing = execFileSync('/usr/bin/zipinfo', [zipPath], { encoding: 'utf8', timeout: 10000 });
    const names = execFileSync('/usr/bin/zipinfo', ['-1', zipPath], { encoding: 'utf8', timeout: 10000 }).split('\n').filter(Boolean);
    assert.ok(names.every((n) => n.startsWith(`${top}/`)), `everything under ${top}/:\n${names.join('\n')}`);
    for (const want of ['Nidum Local.command', 'README.txt', 'launchers/macos/Nidum Local.command', 'launchers/lib/nidum-launcher.sh',
      'package.json', 'macos/Nidum Local Menu.app/Contents/Info.plist', 'macos/Nidum Local Menu.app/Contents/MacOS/NidumLocalMenu']) {
      assert.ok(names.includes(`${top}/${want}`), `missing ${want}\n${names.join('\n')}`);
    }
    assert.ok(sb.calls().some((c) => c.startsWith('build-menubar ') && c.endsWith(`${top}/macos/Nidum Local Menu.app`)), 'built into staging');
    for (const n of names) assert.doesNotMatch(n.slice(top.length + 1), /^(test|docs|design|scripts|\.git|\.obsidian|node_modules)\/|\.DS_Store|\.log$/, n);
    assert.match(listing, new RegExp(`^-rwxr-xr-x .* ${top}/Nidum Local\\.command$`, 'm'), 'shim keeps its executable bit');
    assert.match(listing, new RegExp(`^-rwxr-xr-x .* ${top}/launchers/linux/nidum-local\\.desktop$`, 'm'), '.desktop ships executable');

    const unzipped = join(sb.dir, 'unzipped');
    execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', unzipped], { timeout: 30000 });
    const folder = join(unzipped, top);
    // N3 may not have built src/server.js yet; add a placeholder only when the zip lacks one.
    if (!existsSync(join(folder, 'src', 'server.js'))) {
      mkdirSync(join(folder, 'src'), { recursive: true });
      writeFileSync(join(folder, 'src', 'server.js'), '// placeholder until N3\n');
    }
    writeFileSync(sb.env.STUB_LOG, '');
    const r = await run(sb, { script: join(folder, 'Nidum Local.command') });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /✓ Network sharing is on \(kept on by the startup service\)/);
    assert.ok(r.out.includes(`would run: cd ${folder}`), r.out);
    assert.match(r.out, /\[dry run\] would run: open http:\/\/127\.0\.0\.1:47800\/\?t=<token>/);
    assert.ok(r.out.includes(`[dry run] would run: open -g -a ${join(folder, 'macos', 'Nidum\\ Local\\ Menu.app')} --env NIDUM_HOME=`), r.out);
    const calls = sb.calls();
    assert.ok(!has(calls, /^(brew|npm|open|portless proxy|build-menubar)|server\.js/), calls.join('\n'));
  });

  test('package.sh without a build script ships no menu app; a failing build fails the package', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nidum-n5-pkg-')));
    sandboxes.push({ dir });
    const env = { ...process.env, TMPDIR: dir, NIDUM_MENUBAR_BUILD: join(dir, 'no-such-build.sh') };
    const zipPath = execFileSync(BASH, [PACKAGE, join(dir, 'out')], { encoding: 'utf8', timeout: 60000, env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const names = execFileSync('/usr/bin/zipinfo', ['-1', zipPath], { encoding: 'utf8', timeout: 10000 });
    assert.doesNotMatch(names, /^nidum-local-[^/]+\/macos\//m);
    assert.match(names, /^nidum-local-[^/]+\/launchers\/macos\/Nidum Local\.command$/m);
    assert.throws(() => execFileSync(BASH, [PACKAGE, join(dir, 'out2')], {
      timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: dir, NIDUM_MENUBAR_BUILD: BUILD_STUB, STUB_BUILD_FAIL: '1' },
    }), /building the menu bar app failed/);
  });
});
