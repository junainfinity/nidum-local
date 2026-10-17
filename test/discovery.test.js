// N2 — src/discovery.js. Parser tests run everywhere; the live scan runs on macOS/Linux.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  asArray,
  runCommand,
  parseLsof,
  parseSs,
  parseWindowsListeners,
  listListeners,
  getCwd,
  getCommand,
  probeHttp,
  clearProbeCache,
  isHidden,
  suggestName,
  scan,
  _internal,
} from '../src/discovery.js';
import { freePort, startThrowawayHttp, startThrowawayTcp, withTempDir } from './helpers/net.js';
import { fixture, fakeRun } from './helpers/discovery-fixtures.js';

const SERVICE_KEYS = ['addresses', 'command', 'cwd', 'hidden', 'http', 'pid', 'port', 'process', 'reach', 'suggestedName', 'user'];
const HTTP_KEYS = ['framework', 'redirectsTo', 'server', 'status', 'title', 'tls'];
const byPort = (list, port) => list.filter((e) => e.port === port);

/**
 * Records this scan's own probe attempts (via scan's test-only `onAttempt`). Other suites run
 * real scans in parallel under `npm test` and probe our test servers too, so server-side
 * connection or request counts are not evidence of caching (D22).
 */
function attemptLog() {
  const list = [];
  return {
    onAttempt: (a) => list.push(a),
    count: (port, tls) => list.filter((a) => (port == null || a.port === port) && (tls == null || a.tls === tls)).length,
  };
}

/** Starts an HTTP server on 127.0.0.1 (or `host`) with a custom handler. */
async function serve(handler, host = '127.0.0.1') {
  const server = createHttpServer(handler);
  await new Promise((r) => server.listen(0, host, r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

describe('runCommand', () => {
  test('runs a program with an argument array and no shell', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hacked); `id`'], { timeout: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '$(echo hacked); `id`');
  });

  test('reports a non-zero exit without throwing', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], { timeout: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'bad');
    assert.equal(r.timedOut, false);
  });

  test('reports a missing program without throwing', async () => {
    const r = await runCommand('/nonexistent/nidum-no-such-tool', [], { timeout: 1000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  });

  test('kills a program that exceeds its timeout', async () => {
    const started = Date.now();
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.match(r.error, /timed out after 300 ms/);
    assert.ok(Date.now() - started < 5000);
  });
});

describe('parseLsof (macOS lsof -F)', () => {
  test('real capture without type field: one entry per port + pid, IPv4/IPv6 merged', () => {
    const list = parseLsof(fixture('darwin-lsof-listen.txt'));
    assert.equal(list.length, 12);
    const airplay = byPort(list, 7000);
    assert.equal(airplay.length, 1);
    assert.deepEqual(airplay[0], { port: 7000, pid: 701, process: 'ControlCenter', user: 'ada', addresses: ['*'], reach: 'network' });
    assert.deepEqual(byPort(list, 32401)[0], {
      port: 32401, pid: 1182, process: 'Plex Media Server', user: 'ada', addresses: ['127.0.0.1'], reach: 'loopback',
    });
    assert.equal(list.some((e) => e.port === 80), false, 'root-owned :80 is invisible without sudo');
    const ports = list.map((e) => e.port);
    assert.deepEqual(ports, [...ports].sort((a, b) => a - b));
  });

  test('real capture with type field maps * to 0.0.0.0 and ::', () => {
    const list = parseLsof(fixture('darwin-lsof-listen-typed.txt'));
    assert.deepEqual(byPort(list, 5000)[0].addresses, ['0.0.0.0', '::']);
    assert.deepEqual(byPort(list, 32400)[0].addresses, ['::']);
  });

  test('IPv6 loopback, wildcard, link-local, specific bind and missing process info', () => {
    const list = parseLsof(fixture('darwin-lsof-ipv6-noproc.txt'));
    assert.deepEqual(byPort(list, 57935)[0], { port: 57935, pid: 36434, process: 'node', user: 'ada', addresses: ['::1'], reach: 'loopback' });
    assert.deepEqual(byPort(list, 57936)[0].addresses, ['0.0.0.0', '::']);
    assert.equal(byPort(list, 57936)[0].reach, 'network');
    assert.deepEqual(byPort(list, 8443)[0], { port: 8443, pid: 4120, process: null, user: 'root', addresses: ['0.0.0.0', '::'], reach: 'network' });
    assert.deepEqual(byPort(list, 9229)[0], { port: 9229, pid: 4121, process: null, user: null, addresses: ['fe80::1%lo0'], reach: 'loopback' });
    assert.deepEqual(byPort(list, 8000)[0], {
      port: 8000, pid: 4122, process: 'python3.12', user: 'ada', addresses: ['192.168.68.119'], reach: 'network',
    });
  });

  test('empty and garbage input', () => {
    assert.deepEqual(parseLsof(''), []);
    assert.deepEqual(parseLsof(undefined), []);
    assert.deepEqual(parseLsof('n*:80\nxyz\np\nnfoo'), []);
  });
});

describe('parseSs (Linux ss -ltnpH)', () => {
  test('with process info', () => {
    const list = parseSs(fixture('linux-ss-with-p.txt'));
    assert.deepEqual(byPort(list, 5173)[0], { port: 5173, pid: 48213, process: 'node', user: null, addresses: ['127.0.0.1'], reach: 'loopback' });
    assert.deepEqual(byPort(list, 8888), [
      { port: 8888, pid: 50110, process: 'jupyter-lab', user: null, addresses: ['0.0.0.0', '::'], reach: 'network' },
    ]);
    assert.deepEqual(byPort(list, 8080).map((e) => e.pid), [1200, 1201], 'one entry per pid on a shared socket');
    assert.deepEqual(byPort(list, 3000)[0].addresses, ['*']);
    assert.deepEqual(byPort(list, 53)[0], { port: 53, pid: null, process: null, user: null, addresses: ['127.0.0.53%lo'], reach: 'loopback' });
    assert.deepEqual(byPort(list, 22)[0], { port: 22, pid: null, process: null, user: null, addresses: ['0.0.0.0', '::'], reach: 'network' });
    assert.deepEqual(byPort(list, 631)[0].reach, 'loopback');
    assert.deepEqual(byPort(list, 6006)[0], {
      port: 6006, pid: 52001, process: 'storybook dev', user: null, addresses: ['::ffff:127.0.0.1'], reach: 'loopback',
    });
  });

  test('without process info (sockets of other users): port visible, process null', () => {
    const list = parseSs(fixture('linux-ss-without-p.txt'));
    assert.equal(list.length, 6);
    for (const e of list) {
      assert.equal(e.pid, null);
      assert.equal(e.process, null);
    }
    assert.deepEqual(byPort(list, 5432)[0].reach, 'loopback');
    assert.deepEqual(byPort(list, 3000)[0].reach, 'network');
  });

  test('tolerates a header line and empty input', () => {
    assert.deepEqual(parseSs(''), []);
    const list = parseSs('State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 127.0.0.1:4000 0.0.0.0:*\n');
    assert.deepEqual(list.map((e) => e.port), [4000]);
  });
});

describe('parseWindowsListeners (PowerShell JSON)', () => {
  test('merges IPv4/IPv6 and names processes', () => {
    const list = parseWindowsListeners(fixture('windows-listeners.json'));
    assert.deepEqual(byPort(list, 5173)[0], { port: 5173, pid: 9216, process: 'node', user: null, addresses: ['127.0.0.1', '::1'], reach: 'loopback' });
    assert.deepEqual(byPort(list, 3000)[0], { port: 3000, pid: 10440, process: 'node', user: null, addresses: ['0.0.0.0', '::'], reach: 'network' });
    assert.equal(byPort(list, 445)[0].process, 'System');
    assert.equal(byPort(list, 135)[0].process, 'svchost');
    assert.equal(byPort(list, 6463)[0].process, null, 'process that exited between the two queries');
  });

  test('accepts a single object instead of an array, and parsed input', () => {
    const list = parseWindowsListeners(fixture('windows-listeners-single.json'));
    assert.deepEqual(list, [{ port: 3000, pid: 10440, process: 'node', user: null, addresses: ['0.0.0.0'], reach: 'network' }]);
    assert.deepEqual(parseWindowsListeners(JSON.parse(fixture('windows-listeners-single.json'))), list);
    assert.deepEqual(parseWindowsListeners(''), []);
  });
});

describe('listListeners', () => {
  test('macOS: runs /usr/sbin/lsof with the LISTEN filter and a timeout', async () => {
    const run = fakeRun({ 'lsof -nP -iTCP -sTCP:LISTEN': fixture('darwin-lsof-listen-typed.txt') });
    const list = await listListeners({ platform: 'darwin', run });
    assert.equal(run.calls[0].file, '/usr/sbin/lsof');
    assert.deepEqual(run.calls[0].args, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcuLnt']);
    assert.ok(run.calls[0].timeout > 0);
    assert.equal(list.length, 12);
  });

  test('macOS: lsof exit 1 with no output means no listeners', async () => {
    const run = fakeRun({ lsof: { code: 1, stdout: '' } });
    assert.deepEqual(await listListeners({ platform: 'darwin', run }), []);
  });

  test('macOS: lsof missing or timing out throws (scan reports it)', async () => {
    await assert.rejects(listListeners({ platform: 'darwin', run: fakeRun({}) }), /lsof failed/);
    await assert.rejects(listListeners({ platform: 'darwin', run: fakeRun({ lsof: { code: 1, timedOut: true, error: 'lsof timed out' } }) }), /timed out/);
  });

  test('Linux: ss first, user from /proc ownership', async () => {
    await withTempDir('nidum-n2-proc-', async (procRoot) => {
      mkdirSync(join(procRoot, '48213'));
      const run = fakeRun({ 'ss -ltnpH': fixture('linux-ss-with-p.txt') });
      const list = await listListeners({ platform: 'linux', run, procRoot });
      assert.deepEqual(run.calls.map((c) => c.file), ['ss']);
      assert.ok(byPort(list, 5173)[0].user, 'own process gets a user name');
      assert.equal(byPort(list, 8888)[0].user, null, 'unknown pid keeps user null');
    });
  });

  test('Linux: falls back to lsof when ss fails, throws when both fail', async () => {
    const run = fakeRun({ ss: { code: 1, stderr: 'ss: command not found' }, lsof: fixture('darwin-lsof-listen.txt') });
    const list = await listListeners({ platform: 'linux', run, procRoot: '/nonexistent' });
    assert.deepEqual(run.calls.map((c) => c.file), ['ss', 'lsof']);
    assert.equal(list.length, 12);
    await assert.rejects(listListeners({ platform: 'linux', run: fakeRun({}) }), /ss and lsof both failed/);
  });

  test('Windows: PowerShell with -NoProfile and JSON out', async () => {
    const run = fakeRun({ 'powershell.exe': fixture('windows-listeners.json') });
    const list = await listListeners({ platform: 'win32', run });
    assert.equal(run.calls[0].file, 'powershell.exe');
    assert.equal(run.calls[0].args[0], '-NoProfile');
    assert.match(run.calls[0].args.at(-1), /Get-NetTCPConnection -State Listen/);
    assert.match(run.calls[0].args.at(-1), /ConvertTo-Json/);
    assert.ok(run.calls[0].timeout > 0);
    assert.ok(byPort(list, 3000).length === 1);
    await assert.rejects(listListeners({ platform: 'win32', run: fakeRun({}) }), /Get-NetTCPConnection failed/);
  });
});

describe('getCwd / getCommand', () => {
  test('macOS: parses lsof cwd and ps output; not permitted → null', async () => {
    const run = fakeRun({ 'lsof -a -d cwd': { code: 1, stdout: fixture('darwin-lsof-cwd.txt') }, ps: fixture('darwin-ps-command.txt') });
    assert.equal(await getCwd(36434, { platform: 'darwin', run }), '/Users/ada/code/My_App');
    assert.equal(await getCwd(1, { platform: 'darwin', run }), null, 'root launchd: lsof shows nothing');
    assert.deepEqual(run.calls[0].args, ['-a', '-d', 'cwd', '-Fn', '-p', '36434']);
    assert.equal(await getCommand(36434, { platform: 'darwin', run }), 'node /Users/ada/code/My_App/node_modules/.bin/vite --port 5173 --host');
    assert.equal(await getCommand(99999, { platform: 'darwin', run }), null);
    const psCall = run.calls.find((c) => c.file === '/bin/ps');
    assert.deepEqual(psCall.args.slice(0, 3), ['-ww', '-o', 'pid=,command=']);
  });

  test('invalid pids and failing commands → null', async () => {
    const run = fakeRun({});
    for (const pid of [null, 0, -1, 1.5, '12']) {
      assert.equal(await getCwd(pid, { platform: 'darwin', run }), null);
      assert.equal(await getCommand(pid, { platform: 'darwin', run }), null);
    }
    assert.equal(run.calls.length, 0);
    assert.equal(await getCwd(123, { platform: 'darwin', run }), null);
    assert.equal(await getCommand(123, { platform: 'darwin', run: async () => { throw new Error('boom'); } }), null);
  });

  test('Linux: reads /proc/<pid>/cwd and cmdline; missing → null', async () => {
    await withTempDir('nidum-n2-proc-', async (procRoot) => {
      mkdirSync(join(procRoot, '42'));
      symlinkSync('/home/ada/code/recipes', join(procRoot, '42', 'cwd'));
      writeFileSync(join(procRoot, '42', 'cmdline'), 'node\0server.js\0--port\x003000\0');
      assert.equal(await getCwd(42, { platform: 'linux', procRoot }), '/home/ada/code/recipes');
      assert.equal(await getCommand(42, { platform: 'linux', procRoot }), 'node server.js --port 3000');
      assert.equal(await getCwd(43, { platform: 'linux', procRoot }), null);
      assert.equal(await getCommand(43, { platform: 'linux', procRoot }), null);
    });
  });

  test('Windows: cwd unsupported, command via Win32_Process', async () => {
    const run = fakeRun({ 'powershell.exe': '[{"ProcessId":9216,"CommandLine":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" server.js"}]' });
    assert.equal(await getCwd(9216, { platform: 'win32', run }), null);
    assert.equal(await getCommand(9216, { platform: 'win32', run }), '"C:\\Program Files\\nodejs\\node.exe" server.js');
    assert.match(run.calls[0].args.at(-1), /ProcessId=9216/);
  });

  test('live: this process', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    assert.equal(realpathSync(await getCwd(process.pid)), realpathSync(process.cwd()));
    assert.match(await getCommand(process.pid), /node/);
  });
});

describe('probeHttp', () => {
  test('HTML page: status, title, server header', async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'TestServer/1.0' });
      res.end('<html><head><TITLE>\n  Recipes &amp; More &#8212; Home \n</TITLE></head></html>');
    });
    try {
      assert.deepEqual(await probeHttp(s.port), { status: 200, title: 'Recipes & More — Home', server: 'TestServer/1.0', framework: null, redirectsTo: null, tls: false });
    } finally {
      await s.close();
    }
  });

  test('framework hints: Vite, Next.js, Jupyter, Storybook, Django', async () => {
    const pages = {
      '/vite': [{ 'content-type': 'text/html' }, '<script type="module" src="/@vite/client"></script><title>Vite + React</title>', 'Vite'],
      '/next': [{ 'content-type': 'text/html', 'x-powered-by': 'Next.js' }, '<title>Create Next App</title>', 'Next.js'],
      '/jupyter': [{ 'content-type': 'text/html', server: 'TornadoServer/6.4' }, '<title>Home - Jupyter Server</title>', 'Jupyter'],
      '/storybook': [{ 'content-type': 'text/html' }, '<title>Storybook</title><div id="storybook-root"></div>', 'Storybook'],
      '/django': [{ 'content-type': 'text/html', server: 'WSGIServer/0.2 CPython/3.12.4' }, '<title>The install worked successfully! Congratulations!</title><a href="https://docs.djangoproject.com/">Django</a> <input name="csrfmiddlewaretoken">', 'Django'],
      '/plain': [{ 'content-type': 'text/html' }, '<title>Hi</title>', null],
    };
    let current = '/vite';
    const s = await serve((req, res) => {
      const [headers, body] = pages[current];
      res.writeHead(200, headers);
      res.end(body);
    });
    try {
      for (const [path, [, , expected]] of Object.entries(pages)) {
        current = path;
        const r = await probeHttp(s.port);
        assert.equal(r.framework, expected, path);
      }
    } finally {
      await s.close();
    }
  });

  test('redirect: Location resolved against the probed origin; non-HTML has no title', async () => {
    const s = await serve((req, res) => {
      res.writeHead(302, { location: '/lab?token=abc', 'content-type': 'application/json' });
      res.end('{"title":"<title>nope</title>"}');
    });
    try {
      const r = await probeHttp(s.port);
      assert.equal(r.status, 302);
      assert.equal(r.redirectsTo, `http://127.0.0.1:${s.port}/lab?token=abc`);
      assert.equal(r.title, null);
    } finally {
      await s.close();
    }
  });

  test('raw TCP (non-HTTP) → null', async () => {
    const tcp = await startThrowawayTcp();
    try {
      assert.equal(await probeHttp(tcp.port), null);
    } finally {
      await tcp.close();
    }
  });

  test('closed port and out-of-range port → null', async () => {
    assert.equal(await probeHttp(await freePort()), null);
    assert.equal(await probeHttp(70000), null);
  });

  test('silent server → null within the timeout', async () => {
    const sockets = new Set();
    const server = createTcpServer((sock) => sockets.add(sock));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const started = Date.now();
      assert.equal(await probeHttp(server.address().port, { timeout: 300 }), null);
      assert.ok(Date.now() - started < 2500);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  });

  test('reads at most 64 KB of an endless body', async () => {
    let sent = 0;
    const s = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<title>Endless</title>');
      const timer = setInterval(() => {
        sent += 16384;
        if (!res.write('x'.repeat(16384)) && sent > 10 * 1024 * 1024) clearInterval(timer);
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    try {
      const started = Date.now();
      const r = await probeHttp(s.port, { timeout: 8000 });
      assert.equal(r.title, 'Endless');
      assert.ok(Date.now() - started < 6000, 'returns once 64 KB arrived, well before the deadline');
    } finally {
      await s.close();
    }
  });

  test('IPv6 loopback host', async (t) => {
    let s;
    try {
      s = await serve((req, res) => res.end('<title>Six</title>'), '::1');
    } catch {
      t.skip('no IPv6 loopback');
      return;
    }
    try {
      assert.equal((await probeHttp(s.port, { host: '::1' })).title, 'Six');
      assert.equal(_internal.probeHostFor(['::1']), '::1');
      assert.equal(_internal.probeHostFor(['0.0.0.0', '::']), '127.0.0.1');
      assert.equal(_internal.probeHostFor(['::']), '::1');
      assert.equal(_internal.probeHostFor(['192.168.68.119']), '192.168.68.119');
      assert.equal(_internal.probeHostFor(['*']), '127.0.0.1');
    } finally {
      await s.close();
    }
  });
});

describe('isHidden', () => {
  const ports = { proxyPort: 80, dashboardPort: 47800 };
  test('proxy by port (not by process name) and the dashboard', () => {
    assert.equal(isHidden({ port: 80, process: 'node', user: 'root' }, ports), 'portless-proxy');
    assert.equal(isHidden({ port: 1355, process: 'portless', user: 'ada' }, ports), null, 'a process called portless on another port is not hidden');
    assert.equal(isHidden({ port: 47800, process: 'node', user: 'ada' }, ports), 'nidum-dashboard');
    assert.equal(isHidden({ port: 47800, process: 'node', user: 'ada' }, {}), null);
  });
  test('privileged ports owned by root, SYSTEM or an unknown user', () => {
    assert.equal(isHidden({ port: 631, process: 'cupsd', user: 'root' }), 'os-service');
    assert.equal(isHidden({ port: 22, process: null, user: null }), 'privileged-port');
    assert.equal(isHidden({ port: 443, process: 'nginx', user: 'root' }), 'privileged-port');
    assert.equal(isHidden({ port: 445, process: 'System', user: null }), 'os-service');
    assert.equal(isHidden({ port: 80, process: 'httpd', user: 'ada' }), null, 'own process on a low port stays visible');
    assert.equal(isHidden({ port: 5432, process: null, user: null }), null, 'another user above 1024 stays visible');
  });
  test('known OS services', () => {
    for (const p of ['ControlCenter', 'rapportd', 'mDNSResponder', 'launchd', 'sharingd', 'lsass']) {
      assert.equal(isHidden({ port: 5000, process: p, user: 'ada' }), 'os-service', p);
    }
    assert.equal(isHidden({ port: 135, process: 'svchost', user: null }), 'os-service');
    assert.equal(isHidden({ port: 5040, process: 'svchost', user: null }), null);
    assert.equal(isHidden({ port: 5173, process: 'node', user: 'ada' }), null);
    assert.equal(isHidden(null), null);
  });
});

describe('suggestName', () => {
  test('folder name first: ~/code/My_App → my-app', () => {
    assert.equal(suggestName({ cwd: join(homedir(), 'code', 'My_App'), process: 'node' }), 'my-app');
    assert.equal(suggestName({ cwd: '/Users/ada/code/My_App/', process: 'node' }), 'my-app');
    assert.equal(suggestName({ cwd: 'C:\\Users\\ada\\code\\My_App', process: 'node.exe' }), 'my-app');
    assert.equal(suggestName({ cwd: '/home/ada/code/recipes/src', process: 'node' }), 'recipes', 'generic folder → parent');
    assert.equal(suggestName({ cwd: '/home/ada/Café Démo', process: 'node' }), 'cafe-demo');
  });

  test('useless folders fall through to the title, then the process', () => {
    const http = { status: 200, title: '🚀 Rocket — Dashboard!!' };
    for (const cwd of ['/', homedir(), '/Users/ada', '/Applications/Plex Media Server.app/Contents/MacOS', '/usr/libexec', '/opt', '/Users/ada/Library/Application Support/Plex', null]) {
      assert.equal(suggestName({ cwd, http, process: 'node' }), 'rocket-dashboard', String(cwd));
    }
  });

  test('emoji/punctuation titles, error pages and process names', () => {
    assert.equal(suggestName({ http: { status: 200, title: 'Vite + React' } }), 'vite-react');
    assert.equal(suggestName({ http: { status: 200, title: '🎉🎉🎉' }, process: 'Plex Media Server' }), 'plex-media-server');
    assert.equal(suggestName({ http: { status: 200, title: '...' }, process: 'python3.12' }), 'python3-12');
    assert.equal(suggestName({ http: { status: 404, title: '404 Not Found' }, process: 'nginx' }), 'nginx');
    assert.equal(suggestName({ process: 'C:\\tools\\caddy.exe' }), 'caddy');
  });

  test('empty input and limits', () => {
    assert.equal(suggestName({}), 'app');
    assert.equal(suggestName(undefined), 'app');
    assert.equal(suggestName({ port: 3000, process: '' , http: { status: 200, title: '' } }), 'app-3000');
    const long = suggestName({ http: { status: 200, title: `${'a'.repeat(62)} b c` } });
    assert.ok(long.length <= 63);
    assert.match(long, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    assert.equal(suggestName({ http: { status: 200, title: 'list' } }), 'list', 'reserved names are left to N3');
    for (const t of ['Ünïcödé — Tëst', '---', '<b>x</b>', 'a__b  c', '日本語 app']) {
      assert.match(suggestName({ http: { status: 200, title: t } }), /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, t);
    }
  });
});

describe('scan', () => {
  test('returns the Contracts §3 shape exactly and marks hidden services', async () => {
    const run = fakeRun({ 'lsof -a -d cwd': { code: 1, stdout: fixture('darwin-lsof-cwd.txt') }, ps: fixture('darwin-ps-command.txt') });
    const listeners = async () => parseLsof(fixture('darwin-lsof-ipv6-noproc.txt'));
    clearProbeCache();
    const r = await scan({ proxyPort: 8443, dashboardPort: 47800, platform: 'darwin', run, listeners, probeTimeout: 300 });
    assert.deepEqual(Object.keys(r).sort(), ['errors', 'scannedAt', 'services']);
    assert.ok(!Number.isNaN(Date.parse(r.scannedAt)));
    assert.deepEqual(r.errors, []);
    for (const s of r.services) {
      assert.deepEqual(Object.keys(s).sort(), SERVICE_KEYS);
      assert.ok(Array.isArray(s.addresses));
      assert.ok(['loopback', 'network'].includes(s.reach));
      assert.equal(typeof s.suggestedName, 'string');
      if (s.http) assert.deepEqual(Object.keys(s.http).sort(), HTTP_KEYS);
    }
    const node = r.services.find((s) => s.port === 57935);
    assert.equal(node.cwd, '/Users/ada/code/My_App');
    assert.equal(node.suggestedName, 'my-app');
    assert.match(node.command, /vite --port 5173/);
    assert.equal(r.services.find((s) => s.port === 8443).hidden, 'portless-proxy');
    assert.equal(r.services.find((s) => s.port === 8000).command, '/opt/homebrew/bin/python3.12 -m http.server 8000');
  });

  test('never throws: listener failure and broken runners become errors', async () => {
    const r1 = await scan({ listeners: async () => { throw new Error('lsof exploded'); } });
    assert.deepEqual(r1.services, []);
    assert.match(r1.errors[0], /Couldn't read open ports: lsof exploded/);

    const run = async () => { throw new Error('spawn blew up'); };
    const r2 = await scan({ platform: 'darwin', run, listeners: async () => [{ port: 1, pid: 5, process: 'x', user: 'ada', addresses: ['127.0.0.1'] }], probeTimeout: 200 });
    assert.equal(r2.services.length, 1);
    assert.equal(r2.services[0].reach, 'loopback');
    assert.ok(r2.errors.length >= 1);

    const r3 = await scan({ platform: 'darwin', run: fakeRun({}), probeTimeout: 200 });
    assert.match(r3.errors[0], /Couldn't read open ports/);
    const r4 = await scan(null);
    assert.ok(Array.isArray(r4.services));
  });

  test('probe results are cached per port + pid', async () => {
    const s = await serve((req, res) => res.end('<title>Cached</title>'));
    try {
      clearProbeCache();
      const log = attemptLog();
      const listeners = async () => [{ port: s.port, pid: 777777, process: 'node', user: 'ada', addresses: ['127.0.0.1'], reach: 'loopback' }];
      const opts = { platform: 'darwin', run: fakeRun({}), listeners, onAttempt: log.onAttempt };
      assert.equal((await scan(opts)).services[0].http.title, 'Cached');
      assert.equal((await scan(opts)).services[0].http.title, 'Cached');
      assert.equal(log.count(s.port), 1);
      await scan({ ...opts, now: () => Date.now() + 31_000 }); // past the 30 s TTL
      assert.equal(log.count(s.port), 2);
      await scan({ ...opts, listeners: async () => [{ ...(await listeners())[0], pid: 777778 }] });
      assert.equal(log.count(s.port), 3, 'another pid on the same port is probed afresh');
      clearProbeCache();
      await scan(opts);
      assert.equal(log.count(s.port), 4);
    } finally {
      await s.close();
    }
  });

  test('live: finds an HTTP server with its title and a raw TCP server', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    const http = await startThrowawayHttp({ title: 'Nidum N2 Live Check' });
    const tcp = await startThrowawayTcp();
    try {
      clearProbeCache();
      const started = Date.now();
      const r = await scan({ proxyPort: 80, dashboardPort: 47800 });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `scan took ${elapsed} ms`);
      const h = r.services.find((x) => x.port === http.port);
      const t = r.services.find((x) => x.port === tcp.port);
      assert.ok(h, 'HTTP server found');
      assert.ok(t, 'TCP server found');
      assert.equal(h.process, 'node');
      assert.equal(h.pid, process.pid);
      assert.equal(h.http.title, 'Nidum N2 Live Check');
      assert.equal(h.http.status, 200);
      assert.equal(h.reach, 'loopback');
      assert.equal(h.hidden, null);
      assert.equal(realpathSync(h.cwd), realpathSync(process.cwd()));
      assert.match(h.command, /node/);
      assert.equal(t.process, 'node');
      assert.equal(t.http, null);
      assert.deepEqual(Object.keys(h).sort(), SERVICE_KEYS);
      if (process.platform === 'darwin' && process.getuid() !== 0) {
        assert.equal(r.services.some((x) => x.port === 80), false, 'root-owned proxy on :80 is not visible without sudo');
      }
    } finally {
      await http.close();
      await tcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Iteration 2 (validation 1 findings)

/** Self-signed cert/key made with openssl in `dir`, or null when openssl is unavailable. */
async function makeCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const r = await runCommand('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { timeout: 20000 });
  if (!r.ok) return null;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** A TCP server that accepts and never answers. */
async function silentServer() {
  const sockets = new Set();
  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

const listenerFor = (port, pid = 900000 + (port % 1000)) => ({ port, pid, process: 'node', user: 'ada', addresses: ['127.0.0.1'], reach: 'loopback' });

describe('runCommand: overflow vs timeout', () => {
  test('output larger than maxBuffer is reported as overflow, not a timeout', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeout: 5000, maxBuffer: 100 });
    assert.equal(r.ok, false);
    assert.equal(r.overflow, true);
    assert.equal(r.timedOut, false);
    assert.match(r.error, /exceeded 100 bytes/);
    const t = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
    assert.deepEqual([t.timedOut, t.overflow], [true, false]);
  });
});

describe('asArray / PowerShell 5.1 wrapped arrays', () => {
  test('unwraps { value, Count }, wraps single objects, empties null', () => {
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray(undefined), []);
    assert.deepEqual(asArray([1, 2]), [1, 2]);
    assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
    assert.deepEqual(asArray({ value: [1, 2], Count: 2 }), [1, 2]);
    assert.deepEqual(asArray({ value: 'x' }), [{ value: 'x' }], 'only the wrapper shape is unwrapped');
  });

  test('parseWindowsListeners reads the 5.1 fixture', () => {
    const list = parseWindowsListeners(fixture('windows-listeners-ps51.json'));
    assert.deepEqual(list, [
      { port: 3000, pid: 10440, process: 'node', user: null, addresses: ['0.0.0.0', '::'], reach: 'network' },
      { port: 5173, pid: 9216, process: 'node', user: null, addresses: ['127.0.0.1'], reach: 'loopback' },
    ]);
  });

  test('both PowerShell scripts drop the System.Array type data', async () => {
    const run = fakeRun({ 'powershell.exe': fixture('windows-listeners-ps51.json') });
    await listListeners({ platform: 'win32', run });
    assert.match(run.calls[0].args.at(-1), /Remove-TypeData System\.Array/);
  });
});

describe('probeHttp: HTTPS, streaming, entities', () => {
  test('HTTPS-only server (openssl self-signed): retried over TLS, tls: true, cached', async (t) => {
    await withTempDir('nidum-n2-tls-', async (dir) => {
      const pair = await makeCert(dir);
      if (!pair) {
        t.skip('openssl not available');
        return;
      }
      const server = createHttpsServer(pair, (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', server: 'SecureDev/2' });
        res.end('<title>Secure Shop</title>');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        assert.deepEqual(await probeHttp(port), { status: 200, title: 'Secure Shop', server: 'SecureDev/2', framework: null, redirectsTo: null, tls: true });
        clearProbeCache();
        const log = attemptLog();
        const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(port)], onAttempt: log.onAttempt };
        const a = await scan(opts);
        assert.equal(a.services[0].http.tls, true);
        assert.equal(a.services[0].http.title, 'Secure Shop');
        assert.deepEqual([log.count(port, false), log.count(port, true)], [1, 1], 'plain attempt, then TLS');
        const b = await scan(opts);
        assert.equal(b.services[0].http.title, 'Secure Shop');
        assert.equal(log.count(port), 2, 'second scan served from the cache');
      } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
      }
    });
  });

  test('plain 400 "HTTP request to an HTTPS server" → TLS retry on the same port', async (t) => {
    await withTempDir('nidum-n2-tls-', async (dir) => {
      const pair = await makeCert(dir);
      if (!pair) {
        t.skip('openssl not available');
        return;
      }
      // One port, both protocols, like Go's TLS listener: sniff the first byte.
      const tlsSide = createHttpsServer(pair, (req, res) => res.end('<title>Go Admin</title>'));
      const plainSide = createHttpServer((req, res) => {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        res.end('Client sent an HTTP request to an HTTPS server.\n');
      });
      // TLSSocket reads the raw handle, so already-read bytes must be replayed through a Duplex.
      const front = createTcpServer((sock) => {
        sock.on('error', () => {});
        sock.once('data', (buf) => {
          const d = new Duplex({
            read() {},
            write(chunk, enc, cb) {
              sock.write(chunk, cb);
            },
            final(cb) {
              sock.end();
              cb();
            },
            destroy(err, cb) {
              sock.destroy();
              cb(err);
            },
          });
          d.push(buf);
          sock.on('data', (c) => d.push(c));
          sock.on('end', () => d.push(null));
          sock.on('close', () => d.destroy());
          (buf[0] === 0x16 ? tlsSide : plainSide).emit('connection', d);
        });
      });
      await new Promise((r) => front.listen(0, '127.0.0.1', r));
      try {
        const r = await probeHttp(front.address().port);
        assert.equal(r.tls, true);
        assert.equal(r.status, 200);
        assert.equal(r.title, 'Go Admin');
      } finally {
        tlsSide.closeAllConnections?.();
        plainSide.closeAllConnections?.();
        await new Promise((r) => front.close(r));
      }
    });
  });

  test('plain 400 hint but TLS fails → the 400 itself, tls: false', async () => {
    const s = await serve((req, res) => {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<title>400 The plain HTTP request was sent to HTTPS port</title>');
    });
    try {
      const r = await probeHttp(s.port);
      assert.deepEqual([r.status, r.tls], [400, false]);
    } finally {
      await s.close();
    }
  });

  test('streaming HTML and SSE: summarised at the deadline instead of null', async () => {
    const open = new Set();
    const s = await serve((req, res) => {
      open.add(res);
      if (req.headers.host && serveMode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', server: 'Streamer' });
        res.write('data: hello\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<!doctype html><title>Streaming SSR</title><body>');
      }
    });
    let serveMode = 'html';
    try {
      const started = Date.now();
      const html = await probeHttp(s.port, { timeout: 300 });
      assert.ok(Date.now() - started < 2500);
      assert.deepEqual(html, { status: 200, title: 'Streaming SSR', server: null, framework: null, redirectsTo: null, tls: false });
      serveMode = 'sse';
      const sse = await probeHttp(s.port, { timeout: 300 });
      assert.deepEqual(sse, { status: 200, title: null, server: 'Streamer', framework: null, redirectsTo: null, tls: false });
    } finally {
      for (const r of open) r.destroy();
      await s.close();
    }
  });

  test('titles decode common named and numeric entities', async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>&lt;Shop&gt; &amp; Co &#x1F680; &hellip; &copy; 2026&nbsp;&mdash; &ndash; &rsquo;s &lsquo;x&rsquo; &ldquo;y&rdquo; &trade; &reg; &#169; &euro;&unknown;</title>');
    });
    try {
      assert.equal((await probeHttp(s.port)).title, '<Shop> & Co 🚀 … © 2026 — – ’s ‘x’ “y” ™ ® © €&unknown;');
    } finally {
      await s.close();
    }
  });
});

describe('probe cache: TTLs, copies, scan deadline', () => {
  test('definite answers 30 s; callers get copies (mutation does not poison the cache)', async () => {
    const s = await serve((req, res) => res.end('<title>Original</title>'));
    try {
      clearProbeCache();
      let clock = 1_000_000;
      const log = attemptLog();
      const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(s.port)], now: () => clock, onAttempt: log.onAttempt };
      const a = await scan(opts);
      a.services[0].http.title = 'MUTATED BY CALLER';
      clock += 29_999;
      const b = await scan(opts);
      assert.equal(b.services[0].http.title, 'Original');
      assert.equal(log.count(s.port), 1, 'cached just before 30 s');
      assert.equal(Object.isFrozen(b.services[0].http), false, 'callers may decorate their copy');
      clock += 2; // just past 30 s
      await scan(opts);
      assert.equal(log.count(s.port), 2);
    } finally {
      await s.close();
    }
  });

  test('timeouts cached 15 s', async () => {
    const silent = await silentServer();
    try {
      clearProbeCache();
      let clock = 2_000_000;
      // Injected clock for the TTL and our own attempt log (not server-side counts, which other
      // suites' parallel scans inflate); a generous probe timeout and deadline (D22).
      const log = attemptLog();
      const opts = {
        platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(silent.port)],
        now: () => clock, probeTimeout: 800, scanDeadline: 10_000, onAttempt: log.onAttempt,
      };
      const started = Date.now();
      assert.equal((await scan(opts)).services[0].http, null);
      assert.ok(Date.now() - started >= 790, 'it really was a timeout');
      assert.deepEqual([log.count(silent.port, false), log.count(silent.port, true)], [1, 0], 'no TLS retry after a timeout');
      clock += 14_999;
      assert.equal((await scan(opts)).services[0].http, null);
      assert.equal(log.count(silent.port), 1, 'still cached just before 15 s');
      clock += 2;
      await scan(opts);
      assert.equal(log.count(silent.port), 2, 're-probed after 15 s');
    } finally {
      await silent.close();
    }
  });

  test('reset on both plain and TLS counts as a timeout (15 s)', async () => {
    const server = createTcpServer((sock) => {
      sock.on('error', () => {});
      if (sock.resetAndDestroy) sock.resetAndDestroy();
      else sock.destroy();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      clearProbeCache();
      let clock = 3_000_000;
      const port = server.address().port;
      const log = attemptLog();
      const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(port)], now: () => clock, onAttempt: log.onAttempt };
      assert.equal((await scan(opts)).services[0].http, null);
      assert.deepEqual([log.count(port, false), log.count(port, true)], [1, 1], 'plain attempt, then TLS attempt');
      clock += 14_999;
      await scan(opts);
      assert.equal(log.count(port), 2, 'cached like a timeout');
      clock += 2;
      await scan(opts);
      assert.equal(log.count(port), 4, 'and only for 15 s');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('raw TCP banner (not HTTP, not TLS) is definitive: cached 30 s', async () => {
    const server = createTcpServer((sock) => {
      sock.on('error', () => {});
      sock.resume(); // consume the request so the socket can close
      sock.end('SSH-2.0-OpenSSH_9.8\r\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      clearProbeCache();
      let clock = 4_000_000;
      const port = server.address().port;
      const log = attemptLog();
      const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(port)], now: () => clock, onAttempt: log.onAttempt };
      assert.equal((await scan(opts)).services[0].http, null);
      assert.deepEqual([log.count(port, false), log.count(port, true)], [1, 1], 'not HTTP → TLS tried too');
      clock += 29_999;
      await scan(opts);
      assert.equal(log.count(port), 2, 'cached for 30 s');
      clock += 2;
      await scan(opts);
      assert.equal(log.count(port), 4);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('refused connections are not cached', async () => {
    const port = await freePort();
    clearProbeCache();
    const log = attemptLog();
    const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(port)], onAttempt: log.onAttempt };
    assert.equal((await scan(opts)).services[0].http, null);
    await scan(opts);
    assert.equal(log.count(port), 2, 'refused is not cached');
    const server = createHttpServer((req, res) => res.end('<title>Now Up</title>'));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      assert.equal((await scan(opts)).services[0].http.title, 'Now Up');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  test('scan deadline 2.5 s: 20 silent ports finish in time; aborted probes are not cached', async () => {
    const servers = await Promise.all(Array.from({ length: 20 }, () => silentServer()));
    try {
      clearProbeCache();
      const log = attemptLog();
      const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => servers.map((s, i) => listenerFor(s.port, 800000 + i)), onAttempt: log.onAttempt };
      const started = Date.now();
      const r = await scan(opts);
      const elapsed = Date.now() - started;
      // 2.5 s deadline; ≤ 2.9 s leaves room for a loaded event loop and stays under criterion 4's 3 s.
      assert.ok(elapsed <= 2900, `scan took ${elapsed} ms`);
      assert.ok(elapsed >= 2400, `the deadline, not the probes, ended the scan (${elapsed} ms)`);
      assert.equal(r.services.length, 20);
      assert.ok(r.services.every((x) => x.http === null));
      const first = servers.map((s) => log.count(s.port));
      assert.ok(first.slice(0, 8).every((n) => n === 1), 'first round of 8 probed');
      assert.ok(first.every((n) => n <= 1), 'no TLS retries for silent ports');
      await scan(opts);
      const reprobed = servers.map((s, i) => log.count(s.port) - first[i]);
      assert.ok(reprobed.slice(0, 8).every((n) => n === 0), 'first-round timeouts are cached (15 s)');
      const again = reprobed.filter((n) => n > 0).length;
      // Normally exactly 4 (round 3 is cut off at 2.5 s); a loaded machine can shift the rounds.
      assert.ok(again >= 1 && again <= 12, `aborted probes are not cached and run again (${again} re-probed)`);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  test('a probe aborted at the deadline reports the last cached value, and the abort is not cached', async () => {
    let mode = 'answer';
    const held = new Set();
    const s = await serve((req, res) => {
      if (mode === 'answer') res.end('<title>Last Known</title>');
      else held.add(res); // hang
    });
    try {
      clearProbeCache();
      let clock = 5_000_000;
      const log = attemptLog();
      const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listenerFor(s.port)], now: () => clock, onAttempt: log.onAttempt };
      assert.equal((await scan(opts)).services[0].http.title, 'Last Known');
      clock += 31_000; // expired
      mode = 'hang';
      const r = await scan({ ...opts, scanDeadline: 150 });
      assert.equal(r.services[0].http.title, 'Last Known');
      for (const res of held) res.destroy();
      mode = 'answer';
      assert.equal(log.count(s.port), 2);
      await scan(opts);
      assert.equal(log.count(s.port), 3, 'aborted result was not cached');
    } finally {
      for (const res of held) res.destroy();
      await s.close();
    }
  });
});

describe('scan deadline: last known value for unknown processes', () => {
  test('cached entries older than 10 min are ignored when the process is unknown', async () => {
    let mode = 'answer';
    const held = new Set();
    const s = await serve((req, res) => {
      if (mode === 'answer') res.end('<title>Old Owner</title>');
      else held.add(res);
    });
    try {
      for (const [listener, label] of [
        [{ port: s.port, pid: null, process: null, user: null, addresses: ['127.0.0.1'], reach: 'loopback' }, 'no pid'],
        [{ port: s.port, pid: 912345, process: null, user: null, addresses: ['127.0.0.1'], reach: 'loopback' }, 'no process name'],
        [{ port: s.port, pid: 912346, process: 'node', user: 'ada', addresses: ['127.0.0.1'], reach: 'loopback' }, 'known process'],
      ]) {
        clearProbeCache();
        mode = 'answer';
        let clock = 6_000_000;
        const opts = { platform: 'darwin', run: fakeRun({}), listeners: async () => [listener], now: () => clock };
        assert.equal((await scan(opts)).services[0].http.title, 'Old Owner', label);
        mode = 'hang';
        clock += 9 * 60_000; // 9 min: still used
        assert.equal((await scan({ ...opts, scanDeadline: 150 })).services[0].http.title, 'Old Owner', label);
        clock += 2 * 60_000; // 11 min
        const late = (await scan({ ...opts, scanDeadline: 150 })).services[0].http;
        if (label === 'known process') assert.equal(late.title, 'Old Owner', label);
        else assert.equal(late, null, label);
        for (const res of held) res.destroy();
        held.clear();
      }
    } finally {
      for (const res of held) res.destroy();
      await s.close();
    }
  });
});

describe('suggestName: transliteration', () => {
  test('common Latin letters', () => {
    assert.equal(suggestName({ http: { status: 200, title: 'Straße App' } }), 'strasse-app');
    assert.equal(suggestName({ http: { status: 200, title: 'Ærøskøbing Łódź' } }), 'aeroskobing-lodz');
    assert.equal(suggestName({ http: { status: 200, title: 'Mädchen Café Œuvre Þing' } }), 'madchen-cafe-oeuvre-thing');
    assert.equal(suggestName({ cwd: '/home/ada/Đorđe', process: 'node' }), 'dorde');
  });
});

describe('error pages titled with their status phrase (graph validation 2 F5)', () => {
  test('Plex 401 "Unauthorized" → title null; the service falls back to the process name', async () => {
    const s = await serve((req, res) => {
      res.writeHead(401, { 'content-type': 'text/html', 'x-plex-protocol': '1.0' });
      res.end(fixture('http-plex-401.html'));
    });
    try {
      assert.deepEqual(await probeHttp(s.port), { status: 401, title: null, server: null, framework: null, redirectsTo: null, tls: false });
      clearProbeCache();
      const r = await scan({
        platform: 'darwin',
        run: fakeRun({}),
        listeners: async () => [{ port: s.port, pid: 1182, process: 'Plex Media Server', user: 'ada', addresses: ['0.0.0.0', '::'], reach: 'network' }],
      });
      assert.equal(r.services[0].http.status, 401);
      assert.equal(r.services[0].http.title, null);
      assert.equal(r.services[0].suggestedName, 'plex-media-server');
    } finally {
      await s.close();
    }
  });

  test('status/title table: phrases (with or without code, any case) → null; real titles kept', async () => {
    const cases = JSON.parse(fixture('http-error-pages.json'));
    let current = cases[0];
    const s = await serve((req, res) => {
      res.writeHead(current.status, { 'content-type': 'text/html' });
      res.end(`<html><head><title>${current.title}</title></head><body></body></html>`);
    });
    try {
      for (const c of cases) {
        current = c;
        const r = await probeHttp(s.port);
        assert.equal(r.status, c.status, c.title);
        assert.equal(r.title, c.expect, `${c.status} "${c.title}"`);
      }
    } finally {
      await s.close();
    }
  });

  test('nginx default 404 page', async () => {
    const s = await serve((req, res) => {
      res.writeHead(404, { 'content-type': 'text/html', server: 'nginx/1.27.2' });
      res.end(fixture('http-nginx-404.html'));
    });
    try {
      const r = await probeHttp(s.port);
      assert.deepEqual([r.status, r.title, r.server], [404, null, 'nginx/1.27.2']);
    } finally {
      await s.close();
    }
  });

  test('isStatusPhraseTitle', () => {
    for (const t of ['Unauthorized', 'unauthorized', '401', '401 Unauthorized', 'Error', 'Bad Request', 'Service Unavailable', '503 Service Unavailable']) {
      assert.equal(_internal.isStatusPhraseTitle(t), true, t);
    }
    for (const t of ['Plex', 'Recipes – Not Found', 'Admin Login', 'Error Tracker']) {
      assert.equal(_internal.isStatusPhraseTitle(t), false, t);
    }
  });
});
