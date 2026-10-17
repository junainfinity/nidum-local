// N2 — src/network.js. Parser and platform tests use fixtures; the live test runs on macOS.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseRouteGetDefault,
  parseIpconfigSummary,
  parseAirportNetwork,
  parseHardwarePorts,
  parseIpRouteGet,
  parseNmcliWifi,
  parseNetshWlan,
  parseWindowsNetwork,
  getNetwork,
} from '../src/network.js';
import { withTempDir } from './helpers/net.js';
import { fixture, fakeRun, fakeNics } from './helpers/discovery-fixtures.js';

const NETWORK_KEYS = ['interface', 'interfaces', 'ip', 'kind', 'ssid'];

function assertShape(n) {
  assert.deepEqual(Object.keys(n).sort(), NETWORK_KEYS);
  assert.ok(['wifi', 'ethernet', 'other', 'none'].includes(n.kind));
  assert.ok(n.ssid === null || typeof n.ssid === 'string');
  assert.ok(Array.isArray(n.interfaces));
  for (const i of n.interfaces) {
    assert.deepEqual(Object.keys(i).sort(), ['ip', 'kind', 'name']);
    assert.ok(['wifi', 'ethernet', 'other'].includes(i.kind));
    assert.match(i.ip, /^\d+\.\d+\.\d+\.\d+$/);
  }
}

describe('macOS parsers', () => {
  test('route -n get default: wired en11, and "not in table"', () => {
    assert.deepEqual(parseRouteGetDefault(fixture('darwin-route-default.txt')), { interface: 'en11', gateway: '192.168.68.1' });
    assert.equal(parseRouteGetDefault(fixture('darwin-route-none.txt')), null);
    assert.equal(parseRouteGetDefault(''), null);
  });

  test('ipconfig getsummary: Ethernet, Wi-Fi off, Wi-Fi on, redacted SSID', () => {
    assert.deepEqual(parseIpconfigSummary(fixture('darwin-ipconfig-summary-ethernet.txt')), {
      interfaceType: 'Ethernet', kind: 'ethernet', ssid: null, active: true, addresses: ['192.168.68.119'],
    });
    assert.deepEqual(parseIpconfigSummary(fixture('darwin-ipconfig-summary-wifi-off.txt')), {
      interfaceType: 'WiFi', kind: 'wifi', ssid: null, active: false, addresses: [],
    });
    const on = parseIpconfigSummary(fixture('darwin-ipconfig-summary-wifi-on.txt'));
    assert.equal(on.ssid, 'Home WiFi 5G', 'SSID, not BSSID');
    assert.equal(on.kind, 'wifi');
    assert.deepEqual(on.addresses, ['192.168.1.42']);
    assert.equal(parseIpconfigSummary(fixture('darwin-ipconfig-summary-wifi-redacted.txt')).ssid, null);
    assert.deepEqual(parseIpconfigSummary(''), { interfaceType: null, kind: null, ssid: null, active: true, addresses: [] });
  });

  test('networksetup -getairportnetwork', () => {
    assert.deepEqual(parseAirportNetwork(fixture('darwin-networksetup-airport-off.txt')), { ssid: null, wifiOff: true });
    assert.deepEqual(parseAirportNetwork(fixture('darwin-networksetup-airport-on.txt')), { ssid: 'Home WiFi 5G', wifiOff: false });
    assert.deepEqual(parseAirportNetwork(fixture('darwin-networksetup-airport-not-associated.txt')), { ssid: null, wifiOff: false });
  });

  test('networksetup -listallhardwareports', () => {
    const ports = parseHardwarePorts(fixture('darwin-networksetup-hardwareports.txt'));
    assert.equal(ports.length, 8);
    assert.deepEqual(ports.find((p) => p.device === 'en0'), { port: 'Wi-Fi', device: 'en0', kind: 'wifi' });
    assert.deepEqual(ports.find((p) => p.device === 'en11'), { port: 'AX88179B', device: 'en11', kind: 'ethernet' });
    assert.equal(parseHardwarePorts('Hardware Port: Thunderbolt Bridge\nDevice: bridge0\n')[0].kind, 'other');
  });
});

describe('Linux parsers', () => {
  test('ip route get 1.1.1.1', () => {
    assert.deepEqual(parseIpRouteGet(fixture('linux-ip-route-get.txt')), { interface: 'wlp2s0', ip: '192.168.1.57', gateway: '192.168.1.1' });
    assert.deepEqual(parseIpRouteGet(fixture('linux-ip-route-get-ethernet.txt')), { interface: 'enp3s0', ip: '10.0.0.23', gateway: '10.0.0.1' });
    assert.equal(parseIpRouteGet(fixture('linux-ip-route-get-none.txt')), null);
  });

  test('nmcli: active SSID with escaped colons; radio off → null', () => {
    assert.equal(parseNmcliWifi(fixture('linux-nmcli-wifi.txt')), 'Home WiFi 5G');
    assert.equal(parseNmcliWifi('no:x\nyes:Cafe\\:Guest\n'), 'Cafe:Guest');
    assert.equal(parseNmcliWifi(fixture('linux-nmcli-wifi-off.txt')), null);
  });
});

describe('Windows parsers', () => {
  test('netsh wlan show interfaces: connected, radio off, no wireless interface', () => {
    assert.deepEqual(parseNetshWlan(fixture('windows-netsh-wlan-connected.txt')), { ssid: 'Home WiFi 5G', state: 'connected', name: 'Wi-Fi' });
    assert.deepEqual(parseNetshWlan(fixture('windows-netsh-wlan-disconnected.txt')), { ssid: null, state: 'disconnected', name: 'Wi-Fi' });
    assert.deepEqual(parseNetshWlan(fixture('windows-netsh-wlan-none.txt')), { ssid: null, state: null, name: null });
  });

  test('network JSON: default route, adapter kinds, single-object arrays', () => {
    const w = parseWindowsNetwork(fixture('windows-network-wifi.json'));
    assert.deepEqual(w.route, { interface: 'Wi-Fi', gateway: '192.168.1.1' });
    assert.equal(w.kinds.get('Wi-Fi'), 'wifi');
    assert.equal(w.kinds.get('Ethernet'), 'ethernet');
    assert.equal(w.kinds.get('vEthernet (WSL)'), 'other');
    const none = parseWindowsNetwork(fixture('windows-network-none.json'));
    assert.equal(none.route, null);
    assert.deepEqual(none.addresses, [{ name: 'Loopback Pseudo-Interface 1', ip: '127.0.0.1' }]);
  });
});

describe('getNetwork (fixtures)', () => {
  const darwinRoutes = (overrides = {}) => ({
    'route -n get default': fixture('darwin-route-default.txt'),
    'networksetup -listallhardwareports': fixture('darwin-networksetup-hardwareports.txt'),
    'ipconfig getsummary en11': fixture('darwin-ipconfig-summary-ethernet.txt'),
    'ipconfig getsummary en0': fixture('darwin-ipconfig-summary-wifi-on.txt'),
    'networksetup -getairportnetwork': fixture('darwin-networksetup-airport-off.txt'),
    ...overrides,
  });

  test('macOS wired, Wi-Fi off (this Mac): ethernet, no SSID', async () => {
    const run = fakeRun(darwinRoutes());
    const n = await getNetwork({ platform: 'darwin', run, nics: fakeNics([['en11', '192.168.68.119'], ['utun4', '100.64.0.1']]) });
    assertShape(n);
    assert.deepEqual(n, {
      ip: '192.168.68.119',
      interface: 'en11',
      kind: 'ethernet',
      ssid: null,
      interfaces: [
        { name: 'en11', ip: '192.168.68.119', kind: 'ethernet' },
        { name: 'utun4', ip: '100.64.0.1', kind: 'other' },
      ],
    });
    assert.equal(run.calls.find((c) => c.args[0] === 'getsummary').file, '/usr/sbin/ipconfig');
    assert.ok(run.calls.every((c) => c.timeout > 0));
    assert.equal(run.calls.some((c) => c.args[0] === '-getairportnetwork'), false, 'no SSID lookup on Ethernet');
  });

  test('macOS Wi-Fi: SSID from ipconfig; redacted → networksetup; not associated → null', async () => {
    const wifiRoute = { 'route -n get default': fixture('darwin-route-default.txt').replace('en11', 'en0') };
    const nics = fakeNics([['en0', '192.168.1.42']]);
    const a = await getNetwork({ platform: 'darwin', run: fakeRun(darwinRoutes(wifiRoute)), nics });
    assert.deepEqual([a.kind, a.ssid, a.interface, a.ip], ['wifi', 'Home WiFi 5G', 'en0', '192.168.1.42']);

    const redacted = { ...wifiRoute, 'ipconfig getsummary en0': fixture('darwin-ipconfig-summary-wifi-redacted.txt') };
    const b = await getNetwork({ platform: 'darwin', run: fakeRun(darwinRoutes({ ...redacted, 'networksetup -getairportnetwork': fixture('darwin-networksetup-airport-on.txt') })), nics });
    assert.deepEqual([b.kind, b.ssid], ['wifi', 'Home WiFi 5G']);

    const c = await getNetwork({ platform: 'darwin', run: fakeRun(darwinRoutes({ ...redacted, 'networksetup -getairportnetwork': fixture('darwin-networksetup-airport-not-associated.txt') })), nics });
    assert.deepEqual([c.kind, c.ssid], ['wifi', null]);
  });

  test('macOS no network: kind none, ip null', async () => {
    const run = fakeRun(darwinRoutes({ 'route -n get default': { code: 0, stdout: '', stderr: fixture('darwin-route-none.txt') } }));
    const n = await getNetwork({ platform: 'darwin', run, nics: fakeNics([]) });
    assertShape(n);
    assert.deepEqual(n, { ip: null, interface: null, kind: 'none', ssid: null, interfaces: [] });
  });

  test('macOS: interface without an address in nics falls back to ipconfig getifaddr', async () => {
    const run = fakeRun(darwinRoutes({ 'ipconfig getifaddr en11': '192.168.68.119\n' }));
    const n = await getNetwork({ platform: 'darwin', run, nics: fakeNics([]) });
    assert.equal(n.ip, '192.168.68.119');
    assert.equal(n.kind, 'ethernet');
  });

  test('proxyLanIp is authoritative and picks its interface', async () => {
    const nics = fakeNics([['en11', '192.168.68.119'], ['en0', '10.0.0.5']]);
    const n = await getNetwork({ proxyLanIp: '10.0.0.5', platform: 'darwin', run: fakeRun(darwinRoutes()), nics });
    assert.deepEqual([n.ip, n.interface, n.kind, n.ssid], ['10.0.0.5', 'en0', 'wifi', 'Home WiFi 5G']);
    assert.equal(n.interfaces[0].name, 'en0', 'active interface first');

    const stale = await getNetwork({ proxyLanIp: '172.16.0.9', platform: 'darwin', run: fakeRun(darwinRoutes()), nics });
    assert.deepEqual([stale.ip, stale.interface, stale.kind], ['172.16.0.9', 'en11', 'ethernet']);

    const offline = await getNetwork({ proxyLanIp: '172.16.0.9', platform: 'darwin', run: fakeRun({}), nics: fakeNics([]) });
    assert.deepEqual([offline.ip, offline.interface, offline.kind], ['172.16.0.9', null, 'other']);
  });

  test('Linux: Wi-Fi via sysfs + nmcli, Ethernet, unreachable', async () => {
    await withTempDir('nidum-n2-sys-', async (sys) => {
      mkdirSync(join(sys, 'wlp2s0', 'wireless'), { recursive: true });
      mkdirSync(join(sys, 'enp3s0', 'device'), { recursive: true });
      mkdirSync(join(sys, 'docker0'), { recursive: true });
      const nics = fakeNics([['wlp2s0', '192.168.1.57'], ['docker0', '172.17.0.1']]);
      const run = fakeRun({ 'ip route get 1.1.1.1': fixture('linux-ip-route-get.txt'), 'nmcli -t -f ACTIVE,SSID dev wifi list --rescan no': fixture('linux-nmcli-wifi.txt') });
      const w = await getNetwork({ platform: 'linux', run, nics, sysClassNet: sys });
      assertShape(w);
      assert.deepEqual(w, {
        ip: '192.168.1.57', interface: 'wlp2s0', kind: 'wifi', ssid: 'Home WiFi 5G',
        interfaces: [{ name: 'wlp2s0', ip: '192.168.1.57', kind: 'wifi' }, { name: 'docker0', ip: '172.17.0.1', kind: 'other' }],
      });

      const e = await getNetwork({ platform: 'linux', run: fakeRun({ 'ip route get': fixture('linux-ip-route-get-ethernet.txt') }), nics: fakeNics([['enp3s0', '10.0.0.23']]), sysClassNet: sys });
      assert.deepEqual([e.kind, e.ip, e.ssid], ['ethernet', '10.0.0.23', null]);

      const none = await getNetwork({ platform: 'linux', run: fakeRun({ 'ip route get': { code: 2, stderr: fixture('linux-ip-route-get-none.txt') } }), nics: fakeNics([]), sysClassNet: sys });
      assert.deepEqual(none, { ip: null, interface: null, kind: 'none', ssid: null, interfaces: [] });
    });
  });

  test('Windows: Wi-Fi with netsh SSID; no default route', async () => {
    const nics = fakeNics([['Wi-Fi', '192.168.1.57'], ['vEthernet (WSL)', '172.29.80.1']]);
    const run = fakeRun({ 'powershell.exe': fixture('windows-network-wifi.json'), 'netsh wlan show interfaces': fixture('windows-netsh-wlan-connected.txt') });
    const w = await getNetwork({ platform: 'win32', run, nics });
    assertShape(w);
    assert.deepEqual([w.ip, w.interface, w.kind, w.ssid], ['192.168.1.57', 'Wi-Fi', 'wifi', 'Home WiFi 5G']);
    assert.equal(w.interfaces.find((i) => i.name === 'vEthernet (WSL)').kind, 'other');
    assert.equal(run.calls[0].args[0], '-NoProfile');

    const none = await getNetwork({ platform: 'win32', run: fakeRun({ 'powershell.exe': fixture('windows-network-none.json') }), nics: fakeNics([]) });
    assert.deepEqual(none, { ip: null, interface: null, kind: 'none', ssid: null, interfaces: [] });
  });

  test('never throws, even when every command fails or throws', async () => {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
      const n = await getNetwork({ platform, run: async () => { throw new Error('boom'); }, nics: fakeNics([['en0', '10.1.1.1']]) });
      assertShape(n);
      const m = await getNetwork({ platform, run: fakeRun({}), nics: {} });
      assertShape(m);
      assert.equal(m.kind, 'none');
    }
  });
});

describe('getNetwork: default route through a VPN tunnel (Contracts §5)', () => {
  const routes = (overrides = {}) => ({
    'route -n get default': fixture('darwin-route-default-utun.txt'),
    'networksetup -listallhardwareports': fixture('darwin-networksetup-hardwareports.txt'),
    'ipconfig getsummary en0': fixture('darwin-ipconfig-summary-wifi-on.txt'),
    'ipconfig getsummary en11': fixture('darwin-ipconfig-summary-ethernet.txt'),
    'ipconfig getsummary utun4': '',
    'networksetup -getairportnetwork': fixture('darwin-networksetup-airport-on.txt'),
    ...overrides,
  });

  test('fixture parses as a tunnel route without a gateway', () => {
    assert.deepEqual(parseRouteGetDefault(fixture('darwin-route-default-utun.txt')), { interface: 'utun4', gateway: null });
  });

  test('macOS: utun default route + en0 private address → en0, Wi-Fi', async () => {
    const nics = fakeNics([['utun4', '100.64.0.1'], ['en0', '192.168.1.42']]);
    const n = await getNetwork({ platform: 'darwin', run: fakeRun(routes()), nics });
    assertShape(n);
    assert.deepEqual([n.ip, n.interface, n.kind, n.ssid], ['192.168.1.42', 'en0', 'wifi', 'Home WiFi 5G']);
    assert.deepEqual(n.interfaces.map((i) => [i.name, i.kind]), [['en0', 'wifi'], ['utun4', 'other']], 'tunnel stays listed');
  });

  test('macOS: utun default route + wired en11 → en11, Ethernet', async () => {
    const nics = fakeNics([['utun4', '100.64.0.1'], ['en11', '192.168.68.119']]);
    const n = await getNetwork({ platform: 'darwin', run: fakeRun(routes()), nics });
    assert.deepEqual([n.ip, n.interface, n.kind, n.ssid], ['192.168.68.119', 'en11', 'ethernet', null]);
  });

  test('CGNAT (100.64/10) and public addresses are not private: tunnel kept', async () => {
    const nics = fakeNics([['utun4', '100.64.0.1'], ['en0', '100.70.3.4'], ['en11', '203.0.113.9']]);
    const n = await getNetwork({ platform: 'darwin', run: fakeRun(routes()), nics });
    assert.deepEqual([n.ip, n.interface, n.kind], ['100.64.0.1', 'utun4', 'other']);
  });

  test('172.16/12 counts, a private address on another tunnel does not', async () => {
    const nics = fakeNics([['utun4', '100.64.0.1'], ['utun5', '10.8.0.2'], ['en11', '172.20.1.5']]);
    const n = await getNetwork({ platform: 'darwin', run: fakeRun(routes()), nics });
    assert.deepEqual([n.ip, n.interface, n.kind], ['172.20.1.5', 'en11', 'ethernet']);
  });

  test('a proxy LAN IP still wins over the tunnel rule', async () => {
    const nics = fakeNics([['utun4', '100.64.0.1'], ['en0', '192.168.1.42'], ['en11', '192.168.68.119']]);
    const n = await getNetwork({ proxyLanIp: '192.168.68.119', platform: 'darwin', run: fakeRun(routes()), nics });
    assert.deepEqual([n.ip, n.interface, n.kind], ['192.168.68.119', 'en11', 'ethernet']);
  });

  test('Linux: wg0 default route → the Wi-Fi interface', async () => {
    await withTempDir('nidum-n2-sys-', async (sys) => {
      mkdirSync(join(sys, 'wlp2s0', 'wireless'), { recursive: true });
      mkdirSync(join(sys, 'wg0'), { recursive: true });
      const run = fakeRun({
        'ip route get 1.1.1.1': '1.1.1.1 dev wg0 table 51820 src 10.66.0.2 uid 1000 \n    cache \n',
        nmcli: fixture('linux-nmcli-wifi.txt'),
      });
      const n = await getNetwork({ platform: 'linux', run, nics: fakeNics([['wg0', '10.66.0.2'], ['wlp2s0', '192.168.1.57']]), sysClassNet: sys });
      assert.deepEqual([n.ip, n.interface, n.kind, n.ssid], ['192.168.1.57', 'wlp2s0', 'wifi', 'Home WiFi 5G']);
    });
  });
});

describe('getNetwork: other tunnels (tailscale*, kind other)', () => {
  const cases = [
    ['windows-network-wireguard.json', [['wg-office', '10.13.13.2'], ['Wi-Fi', '192.168.1.57']], ['192.168.1.57', 'Wi-Fi', 'wifi']],
    ['windows-network-tailscale.json', [['Tailscale', '100.101.102.103'], ['Ethernet', '10.0.0.23']], ['10.0.0.23', 'Ethernet', 'ethernet']],
    ['windows-network-anyconnect.json', [['Ethernet 3', '10.250.14.77'], ['Wi-Fi', '172.16.4.20']], ['172.16.4.20', 'Wi-Fi', 'wifi']],
  ];
  for (const [file, pairs, expected] of cases) {
    test(`Windows: ${file}`, async () => {
      const run = fakeRun({ 'powershell.exe': fixture(file), 'netsh wlan show interfaces': fixture('windows-netsh-wlan-connected.txt') });
      const n = await getNetwork({ platform: 'win32', run, nics: fakeNics(pairs) });
      assertShape(n);
      assert.deepEqual([n.ip, n.interface, n.kind], expected);
      assert.ok(n.interfaces.some((i) => i.ip === pairs[0][1] && i.kind === 'other'), 'tunnel stays listed as other');
      if (expected[2] === 'wifi') assert.equal(n.ssid, 'Home WiFi 5G');
    });
  }

  test('Windows: AnyConnect adapter reporting 802.3 is classified other', () => {
    assert.equal(parseWindowsNetwork(fixture('windows-network-anyconnect.json')).kinds.get('Ethernet 3'), 'other');
  });

  test('Linux: tailscale0 exit node → the Ethernet interface', async () => {
    await withTempDir('nidum-n2-sys-', async (sys) => {
      mkdirSync(join(sys, 'enp3s0', 'device'), { recursive: true });
      mkdirSync(join(sys, 'tailscale0'), { recursive: true });
      const run = fakeRun({ 'ip route get 1.1.1.1': '1.1.1.1 dev tailscale0 table 52 src 100.101.102.103 uid 1000 \n    cache \n' });
      const n = await getNetwork({ platform: 'linux', run, nics: fakeNics([['tailscale0', '100.101.102.103'], ['enp3s0', '10.0.0.23']]), sysClassNet: sys });
      assert.deepEqual([n.ip, n.interface, n.kind, n.ssid], ['10.0.0.23', 'enp3s0', 'ethernet', null]);
    });
  });

  test('Linux: default route on a virtual interface of kind other (not a tunnel name) → LAN', async () => {
    await withTempDir('nidum-n2-sys-', async (sys) => {
      mkdirSync(join(sys, 'wlan0', 'wireless'), { recursive: true });
      mkdirSync(join(sys, 'vpn0'), { recursive: true });
      const run = fakeRun({ 'ip route get 1.1.1.1': '1.1.1.1 dev vpn0 src 10.9.0.4 uid 1000 \n', nmcli: fixture('linux-nmcli-wifi.txt') });
      const n = await getNetwork({ platform: 'linux', run, nics: fakeNics([['vpn0', '10.9.0.4'], ['wlan0', '192.168.1.57']]), sysClassNet: sys });
      assert.deepEqual([n.ip, n.interface, n.kind], ['192.168.1.57', 'wlan0', 'wifi']);
    });
  });

  test('no Wi-Fi/Ethernet alternative: the kind-other route is kept', async () => {
    const run = fakeRun({ 'powershell.exe': fixture('windows-network-tailscale.json') });
    const n = await getNetwork({ platform: 'win32', run, nics: fakeNics([['Tailscale', '100.101.102.103']]) });
    assert.deepEqual([n.ip, n.interface, n.kind], ['100.101.102.103', 'Tailscale', 'other']);
  });
});

describe('Windows PowerShell 5.1 wrapped arrays', () => {
  test('parseWindowsNetwork and getNetwork read { value, Count }', async () => {
    const w = parseWindowsNetwork(fixture('windows-network-ps51.json'));
    assert.equal(w.kinds.get('Ethernet'), 'ethernet');
    assert.equal(w.addresses.length, 2);
    const run = fakeRun({ 'powershell.exe': fixture('windows-network-ps51.json') });
    const n = await getNetwork({ platform: 'win32', run, nics: {} });
    assert.deepEqual([n.ip, n.interface, n.kind], ['10.0.0.23', 'Ethernet', 'ethernet']);
    assert.match(run.calls[0].args.at(-1), /Remove-TypeData System\.Array/);
  });
});

describe('getNetwork (live)', () => {
  test('this Mac: shape, and kind matches the default interface\'s hardware port', { skip: process.platform !== 'darwin' }, async () => {
    const started = Date.now();
    const n = await getNetwork();
    assert.ok(Date.now() - started < 5000);
    assertShape(n);
    let routeOut = '';
    try {
      routeOut = execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      /* no default route */
    }
    const iface = /interface:\s*(\S+)/.exec(routeOut)?.[1] ?? null;
    if (!iface) {
      assert.equal(n.kind, 'none');
      return;
    }
    const ports = execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 5000 });
    const isWifi = new RegExp(`Hardware Port: Wi-Fi\\nDevice: ${iface}\\n`).test(ports);
    assert.equal(n.interface, iface);
    assert.equal(n.kind, isWifi ? 'wifi' : 'ethernet', 'this Mac is wired on en11 with Wi-Fi off → ethernet');
    assert.ok(n.interfaces.some((i) => i.ip === n.ip));
    if (!isWifi) assert.equal(n.ssid, null);
  });
});
