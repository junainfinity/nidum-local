// Network info: which address this computer has on the local network, what kind
// of link it is (Wi-Fi, Ethernet, other, none) and the Wi-Fi name when there is one.
//
// macOS is verified end to end (this Mac is wired on en11 with Wi-Fi off).
// Linux and Windows code paths are tested against fixtures only (experimental).
// Every command runs through `runCommand()` (execFile, argument arrays, timeouts).

import { access } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { asArray, runCommand } from './discovery.js';

const DARWIN_BIN = {
  route: '/sbin/route',
  ipconfig: '/usr/sbin/ipconfig',
  networksetup: '/usr/sbin/networksetup',
};
const SHORT_TIMEOUT = 3000;
const NETWORKSETUP_TIMEOUT = 5000;
const POWERSHELL_TIMEOUT = 10000;

/** @typedef {'wifi' | 'ethernet' | 'other' | 'none'} NetworkKind */

// ---------------------------------------------------------------------------
// Parsers

/**
 * Parses `route -n get default` (macOS). macOS prints
 * "route: writing to routing socket: not in table" (and may still exit 0) when
 * there is no default route.
 *
 * @param {string} text Combined stdout/stderr.
 * @returns {{ interface: string, gateway: string | null } | null} `null` when there is no default route.
 */
export function parseRouteGetDefault(text) {
  const s = String(text || '');
  const iface = /^\s*interface:\s*(\S+)/m.exec(s);
  if (!iface) return null;
  const gw = /^\s*gateway:\s*(\S+)/m.exec(s);
  return { interface: iface[1], gateway: gw ? gw[1] : null };
}

/**
 * Parses `ipconfig getsummary <if>` (macOS). Reads the top-level `InterfaceType`,
 * `SSID` (macOS 14.4+ prints `<redacted>` without location permission → `null`),
 * `Active` and `LinkStatusActive`.
 *
 * @param {string} text
 * @returns {{ interfaceType: string | null, kind: 'wifi' | 'ethernet' | 'other' | null,
 *   ssid: string | null, active: boolean, addresses: string[] }}
 */
export function parseIpconfigSummary(text) {
  const s = String(text || '');
  // Only lines at the top level of the dictionary (two-space indent) matter.
  const top = new Map();
  for (const line of s.split('\n')) {
    const m = /^ {2}([A-Za-z]+) : (.*)$/.exec(line.replace(/\r$/, ''));
    if (m) top.set(m[1], m[2].trim());
  }
  const interfaceType = top.get('InterfaceType') || null;
  const kind = interfaceType == null ? null : /^wi-?fi$|^airport$/i.test(interfaceType) ? 'wifi' : /^ethernet$/i.test(interfaceType) ? 'ethernet' : 'other';
  let ssid = top.get('SSID') ?? null;
  if (ssid != null && (ssid === '' || /^<redacted>$/i.test(ssid))) ssid = null;
  const activeFalse = top.get('Active') === 'FALSE' || top.get('LinkStatusActive') === 'FALSE';
  const addresses = [];
  const block = /Addresses : <array> \{([\s\S]*?)\}/.exec(s);
  if (block) for (const m of block[1].matchAll(/^\s*\d+ : (\d+\.\d+\.\d+\.\d+)\s*$/gm)) addresses.push(m[1]);
  return { interfaceType, kind, ssid, active: !activeFalse, addresses };
}

/**
 * Parses `networksetup -getairportnetwork <if>` (macOS).
 * Connected: "Current Wi-Fi Network: <ssid>". Off: "…Wi-Fi power is currently off."
 * Note: on recent macOS this may say "not associated" even while connected (privacy).
 *
 * @param {string} text
 * @returns {{ ssid: string | null, wifiOff: boolean }}
 */
export function parseAirportNetwork(text) {
  const s = String(text || '');
  const m = /^Current (?:Wi-Fi|AirPort) Network:\s*(.+?)\s*$/m.exec(s);
  return { ssid: m && m[1] ? m[1] : null, wifiOff: /power is currently off/i.test(s) };
}

/**
 * Parses `networksetup -listallhardwareports` (macOS).
 *
 * @param {string} text
 * @returns {Array<{ port: string, device: string, kind: 'wifi' | 'ethernet' | 'other' }>}
 */
export function parseHardwarePorts(text) {
  const out = [];
  let port = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const p = /^Hardware Port:\s*(.+)$/.exec(line);
    if (p) {
      port = p[1];
      continue;
    }
    const d = /^Device:\s*(\S+)$/.exec(line);
    if (d && port) {
      out.push({ port, device: d[1], kind: hardwarePortKind(port) });
      port = null;
    }
  }
  return out;
}

function hardwarePortKind(port) {
  if (/wi-?fi|airport/i.test(port)) return 'wifi';
  if (/bridge|bluetooth|iphone|ipad|usb gadget|vpn|modem|firewire/i.test(port)) return 'other';
  return 'ethernet';
}

/**
 * Parses `ip route get 1.1.1.1` (Linux).
 *
 * @param {string} text
 * @returns {{ interface: string, ip: string | null, gateway: string | null } | null}
 *   `null` when unreachable ("RTNETLINK answers: Network is unreachable").
 */
export function parseIpRouteGet(text) {
  const s = String(text || '');
  const dev = /\bdev\s+(\S+)/.exec(s);
  if (!dev) return null;
  const src = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(s);
  const via = /\bvia\s+(\S+)/.exec(s);
  return { interface: dev[1], ip: src ? src[1] : null, gateway: via ? via[1] : null };
}

/**
 * Parses `nmcli -t -f ACTIVE,SSID dev wifi list --rescan no` (Linux) and returns the
 * active SSID. `nmcli -t` escapes `:` inside values as `\:`.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseNmcliWifi(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^(yes|no):(.*)$/.exec(line);
    if (m && m[1] === 'yes') {
      const ssid = m[2].replace(/\\(.)/g, '$1').trim();
      return ssid || null;
    }
  }
  return null;
}

/**
 * Parses `netsh wlan show interfaces` (Windows, English output).
 *
 * @param {string} text
 * @param {string | null} [interfaceName] Prefer the block with this `Name`.
 * @returns {{ ssid: string | null, state: string | null, name: string | null }}
 */
export function parseNetshWlan(text, interfaceName = null) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*([^:]+?)\s*:\s?(.*?)\s*$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'name') {
      cur = { name: m[2], ssid: null, state: null };
      blocks.push(cur);
    } else if (cur && key === 'ssid') cur.ssid = m[2] || null;
    else if (cur && key === 'state') cur.state = m[2] || null;
  }
  const pick =
    (interfaceName && blocks.find((b) => b.name === interfaceName)) ||
    blocks.find((b) => b.state && /^connected$/i.test(b.state)) ||
    blocks[0];
  if (!pick) return { ssid: null, state: null, name: null };
  const connected = pick.state ? /^connected$/i.test(pick.state) : Boolean(pick.ssid);
  return { ssid: connected ? pick.ssid : null, state: pick.state, name: pick.name };
}

/**
 * Parses the JSON printed by the Windows network script
 * (`{ route: { InterfaceAlias, InterfaceIndex, NextHop } | null, adapters: [...], addresses: [...] }`).
 *
 * @param {string | object} json
 * @returns {{ route: { interface: string, gateway: string | null } | null,
 *   kinds: Map<string, 'wifi' | 'ethernet' | 'other'>, addresses: Array<{ name: string, ip: string }> }}
 */
export function parseWindowsNetwork(json) {
  const data = typeof json === 'string' ? JSON.parse(json.trim() || '{}') : json || {};
  const kinds = new Map();
  for (const a of asArray(data.adapters)) {
    const media = String(a.PhysicalMediaType || '');
    const desc = String(a.InterfaceDescription || '');
    let kind = 'other';
    if (/802\.11|wireless|wi-?fi/i.test(media) || /wi-?fi|wireless/i.test(desc)) kind = 'wifi';
    else if (/802\.3/.test(media) && !/virtual|hyper-v|vpn|tap|tunnel|wireguard|tailscale|anyconnect|vmware|virtualbox/i.test(desc))
      kind = 'ethernet';
    if (a.Name) kinds.set(String(a.Name), kind);
  }
  const route = asArray(data.route)[0];
  const addresses = asArray(data.addresses)
    .filter((a) => a && a.IPAddress && a.InterfaceAlias)
    .map((a) => ({ name: String(a.InterfaceAlias), ip: String(a.IPAddress) }));
  return {
    route: route && route.InterfaceAlias ? { interface: String(route.InterfaceAlias), gateway: route.NextHop || null } : null,
    kinds,
    addresses,
  };
}

// ---------------------------------------------------------------------------
// Interfaces

/** Non-internal, non-link-local IPv4 addresses from an `os.networkInterfaces()`-shaped object. */
function ipv4Addresses(nics) {
  const out = [];
  for (const [name, list] of Object.entries(nics || {})) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !a.address || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      out.push({ name, ip: a.address });
    }
  }
  return out;
}

const WINDOWS_NETWORK_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'Remove-TypeData System.Array -ErrorAction SilentlyContinue',
  "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1 InterfaceAlias, InterfaceIndex, NextHop",
  '$a = @(Get-NetAdapter | Select-Object Name, InterfaceIndex, InterfaceDescription, PhysicalMediaType, Status)',
  '$i = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, InterfaceIndex, IPAddress)',
  '[pscustomobject]@{ route = $r; adapters = $a; addresses = $i } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Linux link kind from sysfs, falling back to the interface name. */
async function linuxKind(name, sysClassNet) {
  if ((await exists(`${sysClassNet}/${name}/wireless`)) || (await exists(`${sysClassNet}/${name}/phy80211`))) return 'wifi';
  if (await exists(`${sysClassNet}/${name}/device`)) return 'ethernet';
  if (/^wl/.test(name)) return 'wifi';
  if (/^(en|eth)/.test(name)) return 'ethernet';
  return 'other';
}

// ---------------------------------------------------------------------------
// getNetwork

/**
 * Reports the network this computer is on. Never throws.
 *
 * `ip` is `proxyLanIp` when given (the running LAN proxy is authoritative), else the
 * address of the default-route interface. When the default route goes through a tunnel
 * (`utun*`, `tun*`, `ppp*`, `wg*`, `ipsec*`, `tailscale*`, or any interface of kind `other`), the first Wi-Fi/Ethernet interface with a private
 * RFC 1918 address is used instead and `kind` describes it. `kind` is `none` when there is no
 * default route and no proxy LAN IP. `interfaces` lists every non-internal IPv4 address
 * (link-local 169.254.x excluded), the active interface first.
 *
 * @param {{ proxyLanIp?: string | null, platform?: string, run?: typeof runCommand,
 *   nics?: ReturnType<typeof networkInterfaces>, sysClassNet?: string }} [options]
 *   Everything after `proxyLanIp` is injectable for tests.
 * @returns {Promise<{ ip: string | null, interface: string | null, kind: NetworkKind,
 *   ssid: string | null, interfaces: Array<{ name: string, ip: string, kind: 'wifi' | 'ethernet' | 'other' }> }>}
 */
export async function getNetwork(options = {}) {
  const { proxyLanIp = null, platform = process.platform, run = runCommand, sysClassNet = '/sys/class/net' } = options;
  let nics = options.nics;
  if (!nics) {
    try {
      nics = networkInterfaces();
    } catch {
      nics = {};
    }
  }
  const empty = { ip: proxyLanIp || null, interface: null, kind: 'none', ssid: null, interfaces: [] };
  try {
    if (platform === 'darwin') return await darwinNetwork({ proxyLanIp, run, nics });
    if (platform === 'linux') return await linuxNetwork({ proxyLanIp, run, nics, sysClassNet });
    if (platform === 'win32') return await windowsNetwork({ proxyLanIp, run, nics });
    return await genericNetwork({ proxyLanIp, nics });
  } catch {
    return empty;
  }
}

/** Tunnel interfaces (VPNs): a default route through one of these isn't reachable from the LAN. */
const TUNNEL = /^(utun|tun|ppp|wg|ipsec|tailscale)/i;

/** RFC 1918 private IPv4 (10/8, 172.16/12, 192.168/16); CGNAT 100.64/10 is not included. */
function isPrivateIPv4(ip) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip || '');
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * When the default route goes through a tunnel (a tunnel name, or any interface of kind
 * `other`), prefer the first Wi-Fi/Ethernet interface with a private address (Contracts §5).
 * Returns `{ interface, ip }` or the route unchanged.
 */
function preferLan(def, addrs, kindOf) {
  if (!def || !(TUNNEL.test(def.interface) || kindOf(def.interface) === 'other')) return def;
  const alt = addrs.find((a) => (kindOf(a.name) === 'wifi' || kindOf(a.name) === 'ethernet') && isPrivateIPv4(a.ip));
  return alt ? { interface: alt.name, ip: alt.ip, gateway: null } : def;
}

/** Assembles the result once the default interface, kinds and SSID are known. */
function assemble({ proxyLanIp, defaultIf, defaultIp, addrs, kindOf, primaryKind, ssid }) {
  const owner = proxyLanIp ? addrs.find((a) => a.ip === proxyLanIp) : null;
  const iface = owner ? owner.name : defaultIf || null;
  let ip = proxyLanIp || defaultIp || (iface ? addrs.find((a) => a.name === iface)?.ip : null) || null;
  if (!iface && !proxyLanIp) ip = null;
  let kind = 'none';
  if (iface) kind = primaryKind || kindOf(iface) || 'other';
  else if (proxyLanIp) kind = 'other';
  const interfaces = addrs.map((a) => ({ name: a.name, ip: a.ip, kind: a.name === iface && primaryKind ? primaryKind : kindOf(a.name) || 'other' }));
  interfaces.sort((a, b) => (b.name === iface) - (a.name === iface));
  return { ip, interface: iface, kind, ssid: kind === 'wifi' ? ssid || null : null, interfaces };
}

async function darwinNetwork({ proxyLanIp, run, nics }) {
  const [route, ports] = await Promise.all([
    run(DARWIN_BIN.route, ['-n', 'get', 'default'], { timeout: SHORT_TIMEOUT }),
    run(DARWIN_BIN.networksetup, ['-listallhardwareports'], { timeout: NETWORKSETUP_TIMEOUT }),
  ]);
  const hw = new Map(parseHardwarePorts(ports.stdout).map((p) => [p.device, p.kind]));
  const kindOf = (name) => hw.get(name) || (/^en\d+$/.test(name) && hw.size === 0 ? 'ethernet' : 'other');
  const addrs = ipv4Addresses(nics);
  const def = preferLan(parseRouteGetDefault(`${route.stdout}\n${route.stderr}`), addrs, kindOf);
  const owner = proxyLanIp ? addrs.find((a) => a.ip === proxyLanIp) : null;
  const primary = owner ? owner.name : def ? def.interface : null;

  let defaultIp = null;
  if (def) {
    defaultIp = def.ip || addrs.find((a) => a.name === def.interface)?.ip || null;
    if (!defaultIp) {
      const r = await run(DARWIN_BIN.ipconfig, ['getifaddr', def.interface], { timeout: SHORT_TIMEOUT });
      const m = /(\d+\.\d+\.\d+\.\d+)/.exec(r.stdout);
      defaultIp = m ? m[1] : null;
    }
  }

  let primaryKind = null;
  let ssid = null;
  if (primary) {
    const summary = parseIpconfigSummary((await run(DARWIN_BIN.ipconfig, ['getsummary', primary], { timeout: SHORT_TIMEOUT })).stdout);
    primaryKind = summary.kind || kindOf(primary);
    ssid = summary.ssid;
    if (primaryKind === 'wifi' && !ssid) {
      const air = await run(DARWIN_BIN.networksetup, ['-getairportnetwork', primary], { timeout: NETWORKSETUP_TIMEOUT });
      ssid = parseAirportNetwork(air.stdout).ssid;
    }
  }
  return assemble({ proxyLanIp, defaultIf: def ? def.interface : null, defaultIp, addrs, kindOf, primaryKind, ssid });
}

async function linuxNetwork({ proxyLanIp, run, nics, sysClassNet }) {
  const route = await run('ip', ['route', 'get', '1.1.1.1'], { timeout: SHORT_TIMEOUT });
  const routed = parseIpRouteGet(route.stdout);
  const addrs = ipv4Addresses(nics);
  const names = new Set([...addrs.map((a) => a.name), ...(routed ? [routed.interface] : [])]);
  const kinds = new Map();
  await Promise.all([...names].map(async (n) => kinds.set(n, await linuxKind(n, sysClassNet))));
  const kindOf = (n) => kinds.get(n) || 'other';
  const def = preferLan(routed, addrs, kindOf);
  const owner = proxyLanIp ? addrs.find((a) => a.ip === proxyLanIp) : null;
  const primary = owner ? owner.name : def ? def.interface : null;
  let ssid = null;
  if (primary && kindOf(primary) === 'wifi') {
    const r = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi', 'list', '--rescan', 'no'], { timeout: SHORT_TIMEOUT });
    ssid = parseNmcliWifi(r.stdout);
  }
  const defaultIp = def ? def.ip || addrs.find((a) => a.name === def.interface)?.ip || null : null;
  return assemble({ proxyLanIp, defaultIf: def ? def.interface : null, defaultIp, addrs, kindOf, primaryKind: null, ssid });
}

async function windowsNetwork({ proxyLanIp, run, nics }) {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_NETWORK_SCRIPT], { timeout: POWERSHELL_TIMEOUT });
  let parsed = { route: null, kinds: new Map(), addresses: [] };
  try {
    parsed = parseWindowsNetwork(r.stdout);
  } catch {
    /* unparsable → fall back to os.networkInterfaces() only */
  }
  let addrs = ipv4Addresses(nics);
  if (addrs.length === 0) addrs = parsed.addresses.filter((a) => !a.ip.startsWith('127.') && !a.ip.startsWith('169.254.'));
  const kindOf = (n) => parsed.kinds.get(n) || 'other';
  const def = preferLan(parsed.route, addrs, kindOf);
  const owner = proxyLanIp ? addrs.find((a) => a.ip === proxyLanIp) : null;
  const primary = owner ? owner.name : def ? def.interface : null;
  let ssid = null;
  if (primary && kindOf(primary) === 'wifi') {
    const w = await run('netsh', ['wlan', 'show', 'interfaces'], { timeout: NETWORKSETUP_TIMEOUT });
    ssid = parseNetshWlan(w.stdout, primary).ssid;
  }
  const defaultIp = def ? def.ip || addrs.find((a) => a.name === def.interface)?.ip || null : null;
  return assemble({ proxyLanIp, defaultIf: def ? def.interface : null, defaultIp, addrs, kindOf, primaryKind: null, ssid });
}

async function genericNetwork({ proxyLanIp, nics }) {
  const addrs = ipv4Addresses(nics);
  const first = addrs[0];
  return assemble({ proxyLanIp, defaultIf: first ? first.name : null, defaultIp: first ? first.ip : null, addrs, kindOf: () => 'other', primaryKind: null, ssid: null });
}
