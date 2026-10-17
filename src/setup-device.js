// "Set up another device" (node N3, F15, D21): while HTTPS is on, serve
// Portless's CA certificate and per-OS trust steps over plain HTTP, directly
// on this computer's LAN IP and a random free port, for 10 minutes. Not
// through the proxy (an HTTPS proxy would redirect the phone to HTTPS and a
// certificate warning before it could fetch the certificate) and no `setup`
// alias. Stopped after 10 minutes, on cancel and on quit.
//
// Unverifiable end to end on this Mac (TLS off): tested with an injected bind
// address (127.0.0.1) and a fake LAN IP.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PortlessError } from './portless.js';
import { isUnicastIPv4 } from './state.js';

export const SETUP_DURATION_MS = 10 * 60 * 1000;
export const NO_NETWORK_MESSAGE = 'You’re not connected to a network.';

const HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const STEPS = [
  {
    id: 'ios',
    title: 'iPhone or iPad',
    steps: [
      'Open this page in Safari and tap Download certificate, then Allow.',
      'Open Settings › General › VPN & Device Management, tap the Portless profile and tap Install.',
      'Open Settings › General › About › Certificate Trust Settings and turn on the Portless certificate.',
    ],
  },
  {
    id: 'android',
    title: 'Android',
    steps: [
      'Tap Download certificate.',
      'Open Settings › Security › Encryption & credentials › Install a certificate › CA certificate.',
      'Pick the downloaded file and confirm.',
    ],
  },
  {
    id: 'mac',
    title: 'Mac',
    steps: [
      'Click Download certificate and open the file. Keychain Access adds it.',
      'Double-click the Portless certificate, open Trust and set "When using this certificate" to Always Trust.',
      'Close the window and enter your password.',
    ],
  },
  {
    id: 'windows',
    title: 'Windows',
    steps: [
      'Click Download certificate and open the file.',
      'Click Install Certificate, choose Local Machine, then "Place all certificates in the following store".',
      'Pick Trusted Root Certification Authorities and finish.',
    ],
  },
];

/** Per-OS steps shown by the dashboard and on the setup page. */
export function setupSteps() {
  return STEPS.map((s) => ({ ...s, steps: [...s.steps] }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function setupPage(expiresAt) {
  const sections = STEPS.map(
    (s) => `<section><h2>${escapeHtml(s.title)}</h2><ol>${s.steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol></section>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up this device · Nidum Local</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}a.btn{display:inline-block;padding:.6rem 1rem;border-radius:10px;background:#1a1a1a;color:#fff;text-decoration:none}h2{font-size:1.1rem;margin-top:1.5rem}</style>
</head><body><h1>Set up this device</h1>
<p>This lets this device open secure addresses from the computer running Nidum Local without warnings. This page closes at ${escapeHtml(new Date(expiresAt).toLocaleTimeString())}.</p>
<p><a class="btn" href="/portless-ca.pem" download>Download certificate</a></p>${sections}</body></html>`;
}

function noNetwork(details) {
  return new PortlessError('UNSUPPORTED', NO_NETWORK_MESSAGE, { details: { reason: 'no-network', ...(details || {}) } });
}

/**
 * Device setup controller.
 *
 * @param {object} deps
 * @param {{ stateDir: () => string }} deps.adapter  where Portless keeps ca.pem
 * @param {() => Promise<object>} deps.getProxy  fresh proxy state (needs `tls`)
 * @param {() => Promise<string | null>} deps.getLanIp  this computer's LAN IPv4, or null (anything but a unicast IPv4 → no-network)
 * @param {(lanIp: string) => string} [deps.bindAddress]  address to bind (default: the LAN IP itself; tests: 127.0.0.1)
 * @param {(info: object | null, reason?: string) => void} [deps.onChange]
 * @param {number} [deps.durationMs]
 * @param {(caPath: string) => string} [deps.readCa]
 */
export function createDeviceSetup(deps) {
  const { adapter, getProxy, getLanIp } = deps;
  const bindAddress = deps.bindAddress || ((ip) => ip);
  const durationMs = deps.durationMs ?? SETUP_DURATION_MS;
  const onChange = deps.onChange || (() => {});
  const readCa = deps.readCa || ((p) => fs.readFileSync(p, 'utf8'));
  let active = null; // { server, ip, port, timer, expiresAt, url }
  let starting = null;

  function info() {
    if (!active) return null;
    return { active: true, url: active.url, ip: active.ip, port: active.port, expiresAt: new Date(active.expiresAt).toISOString(), steps: setupSteps() };
  }

  async function startNow() {
    if (active) return info();
    const proxy = await getProxy();
    if (!proxy?.tls) {
      throw new PortlessError('UNSUPPORTED', 'Device setup is only needed for secure (HTTPS) addresses, and HTTPS is off.', { details: { reason: 'tls-off' } });
    }
    const ip = await getLanIp();
    // D27: only a unicast IPv4 is ever bound — never 0.0.0.0, loopback, multicast or broadcast.
    if (!isUnicastIPv4(ip)) throw noNetwork(ip ? { ip } : undefined);
    let ca;
    try {
      ca = readCa(path.join(adapter.stateDir(), 'ca.pem'));
    } catch {
      throw new PortlessError('UNSUPPORTED', 'There is no certificate to share yet. Use Fix certificate on this computer first.', { details: { reason: 'no-certificate' } });
    }
    const expiresAt = Date.now() + durationMs;
    const server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD' });
        return res.end();
      }
      if (url === '/') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : setupPage(expiresAt));
      }
      if (url === '/portless-ca.pem' || url === '/ca.pem') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="portless-ca.pem"' });
        return res.end(req.method === 'HEAD' ? undefined : ca);
      }
      res.writeHead(404, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    });
    server.keepAliveTimeout = 2000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, bindAddress(ip), () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      // e.g. EADDRNOTAVAIL: the IP is gone (network changed)
      throw noNetwork({ ip, error: err.code || err.message });
    }
    const port = server.address().port;
    const timer = setTimeout(() => {
      stop('expired').catch(() => {});
    }, durationMs);
    timer.unref?.();
    active = { server, ip, port, timer, expiresAt, url: `http://${ip}:${port}/` };
    onChange(info(), 'started');
    return info();
  }

  /** Start (or return the running) setup page. */
  async function start() {
    if (!starting) starting = startNow().finally(() => { starting = null; });
    return starting;
  }

  /**
   * Stop serving the page.
   * @param {'cancelled' | 'expired' | 'shutdown'} [reason]
   * @returns {Promise<boolean>} true when something was running
   */
  async function stop(reason = 'cancelled') {
    if (starting) await starting.catch(() => {});
    const a = active;
    active = null;
    if (!a) return false;
    clearTimeout(a.timer);
    a.server.closeAllConnections?.();
    await new Promise((r) => a.server.close(() => r()));
    onChange(null, reason);
    return true;
  }

  return { start, stop, info, get active() { return Boolean(active); } };
}
