// Headless Chrome over the DevTools protocol (node N4 tests).
//
// Talks CDP over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-delimited
// JSON), so no debugging port is opened. Node ≥ 22.
//
//   const browser = await launchChrome();
//   const page = await browser.newPage({ width: 1440, height: 900 });
//   await page.goto(url);
//   await page.evaluate(() => document.title);
//   await browser.close();          // always (also on failure): kills Chrome, removes the profile
//
// Every page records console errors / exceptions / failed loads in
// `page.errors` and every network request URL in `page.requests`.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME_PATH = process.env.NIDUM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function haveChrome() {
  return existsSync(CHROME_PATH);
}

const live = new Set();
process.once('exit', () => {
  for (const proc of live) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

const KEYS = {
  Tab: { code: 'Tab', vk: 9 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  '/': { code: 'Slash', vk: 191, text: '/' },
  '?': { code: 'Slash', vk: 191, text: '?', shift: true },
};

function keyInfo(key) {
  if (KEYS[key]) return { key: KEYS[key].key || key, ...KEYS[key] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const letter = /[a-z]/i.test(key);
    const digit = /[0-9]/.test(key);
    return { key, code: letter ? `Key${upper}` : digit ? `Digit${key}` : '', vk: upper.charCodeAt(0), text: key, shift: letter && key !== key.toLowerCase() };
  }
  throw new Error(`chrome.js: unknown key ${key}`);
}

/**
 * Launch headless Chrome.
 * @param {{ timeoutMs?: number, args?: string[] }} [opts]  timeoutMs: hard kill after this long (default 10 min)
 */
export async function launchChrome(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nidum-chrome-'));
  const proc = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-pipe',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--font-render-hinting=none',
    `--user-data-dir=${join(dir, 'profile')}`,
    ...(opts.args || []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  live.add(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => {
    if (stderr.length < 4000) stderr += d;
  });
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => {
    live.delete(proc);
    resolve({ code, signal });
  }));
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
  killTimer.unref();

  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let buffer = '';
  let closed = false;
  proc.stdio[4].setEncoding('utf8');
  proc.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (msg.id && pending.has(msg.id)) {
        const w = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(`CDP ${w.method}: ${msg.error.message}`));
        else w.resolve(msg.result);
      } else if (msg.method) {
        for (const l of listeners) l(msg);
      }
    }
  });
  proc.stdio[3].on('error', () => {});
  exited.then(() => {
    closed = true;
    for (const w of pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(`Chrome exited${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
    }
    pending.clear();
  });

  function send(method, params = {}, sessionId, timeout = 30_000) {
    if (closed) return Promise.reject(new Error(`Chrome is closed (${method})`));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeout} ms`));
      }, timeout);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  const pages = new Set();
  const browser = {
    proc,
    send,
    on,
    /** Open a new tab and attach to it. */
    async newPage({ width = 1440, height = 900, mobile = false } = {}) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const page = makePage(browser, targetId, sessionId);
      pages.add(page);
      await page.init({ width, height, mobile });
      return page;
    },
    /** Close Chrome (graceful, then SIGKILL) and remove the profile dir. Never throws. */
    async close() {
      clearTimeout(killTimer);
      if (!closed) {
        send('Browser.close', {}, undefined, 5000).catch(() => {});
        const done = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
        if (!done) {
          proc.kill('SIGKILL');
          await Promise.race([exited, delay(5000)]);
        }
      }
      // Let go of Chrome's pipes and the child handle. A Chrome helper that outlives the browser
      // can keep its inherited stderr or CDP pipe open, and an open pipe handle would keep the test
      // process (node --test) alive long after its last test.
      for (const s of proc.stdio) {
        try {
          s?.removeAllListeners('data');
          s?.on?.('error', () => {});
          s?.destroy();
        } catch {
          /* already closed */
        }
      }
      proc.unref();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best effort */
      }
    },
  };
  // Make sure Chrome answers before returning.
  try {
    await send('Browser.getVersion', {}, undefined, 20_000);
  } catch (err) {
    await browser.close();
    throw err;
  }
  return browser;
}

function makePage(browser, targetId, sessionId) {
  const send = (method, params, timeout) => browser.send(method, params, sessionId, timeout);
  const errors = [];
  const requests = [];
  const waiters = [];
  const off = browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    switch (msg.method) {
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') errors.push(`console.${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
        break;
      case 'Runtime.exceptionThrown':
        errors.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
        break;
      case 'Log.entryAdded':
        if (p.entry?.level === 'error') errors.push(`log[${p.entry.source}]: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
        break;
      case 'Network.requestWillBeSent':
        requests.push(p.request?.url);
        break;
      default:
        break;
    }
    for (const w of waiters.slice()) {
      if (w.method === msg.method) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(p);
      }
    }
  });

  function cancelWait(promise) {
    const i = waiters.findIndex((w) => w.promise === promise);
    if (i >= 0) waiters.splice(i, 1);
  }

  function waitEvent(method, timeout = 30_000) {
    const w = { method };
    const promise = new Promise((resolve, reject) => {
      w.resolve = resolve;
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeout).unref?.();
    });
    w.promise = promise;
    return promise;
  }

  async function evaluate(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  const page = {
    targetId,
    sessionId,
    errors,
    requests,
    send,
    evaluate,
    async init({ width, height, mobile }) {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Log.enable');
      await send('Network.enable');
      await page.setViewport(width, height, { mobile });
    },
    async setViewport(width, height, { mobile = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    },
    /** colorScheme: 'light' | 'dark' | ''; reducedMotion: 'reduce' | ''. */
    async emulate({ colorScheme = '', reducedMotion = '' } = {}) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }, { name: 'prefers-reduced-motion', value: reducedMotion }] });
    },
    /** Navigate and wait for the load event (a same-document navigation only waits for the hash change). */
    async goto(url, { timeout = 30_000 } = {}) {
      const loaded = waitEvent('Page.loadEventFired', timeout);
      loaded.catch(() => {});
      const r = await send('Page.navigate', { url });
      if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
      if (!r.loaderId) {
        cancelWait(loaded);
        return;
      }
      await loaded;
    },
    async reload({ timeout = 30_000 } = {}) {
      const loaded = waitEvent('Page.loadEventFired', timeout);
      await send('Page.reload', { ignoreCache: true });
      await loaded;
    },
    /** Poll `fn(...args)` in the page until it returns truthy; returns that value. */
    async waitFor(fn, { timeout = 10_000, args = [], interval = 50, what } = {}) {
      const end = Date.now() + timeout;
      let last;
      for (;;) {
        try {
          last = await evaluate(fn, ...args);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        if (Date.now() > end) throw new Error(`waitFor ${what || String(fn).slice(0, 120)} timed out (last: ${JSON.stringify(last)})`);
        await delay(interval);
      }
    },
    async screenshot({ clip } = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: false });
      return Buffer.from(r.data, 'base64');
    },
    /** Press a key (`Tab`, `Enter`, `Escape`, `ArrowDown`, `/`, `?`, `a`, …). */
    async key(key, { shift = false, meta = false } = {}) {
      const k = keyInfo(key);
      const modifiers = (shift || k.shift ? 8 : 0) | (meta ? 4 : 0);
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
      await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    /** Type text into the focused element (fires input events). */
    async type(text) {
      for (const ch of text) await page.key(ch);
    },
    async insertText(text) {
      await send('Input.insertText', { text });
    },
    /**
     * Real mouse click at the centre of the first element matching `selector`.
     * Refuses a covered target: if `elementFromPoint` at the click point isn't the element (or inside
     * it), the mouse is parked at (0, 0) — so a hover can't hold whatever covers it, such as a toast —
     * and the click waits up to `coveredTimeout` ms for it to uncover, then throws "covered by …".
     */
    async click(selector, { coveredTimeout = 8000 } = {}) {
      const end = Date.now() + coveredTimeout;
      let parked = false;
      for (;;) {
        const box = await evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return { hidden: true };
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          const describe = (n) => {
            if (!n) return 'nothing (off screen)';
            const cls = typeof n.className === 'string' && n.className ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
            const owner = n.closest?.('.toast, .dialog, .popover, .scrim, .banner, header');
            const t = (owner || n).textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
            return `<${n.localName}${n.id ? `#${n.id}` : ''}${cls}>${owner && owner !== n ? ` in <${owner.localName}.${owner.className}>` : ''} "${t}"`;
          };
          return { x, y, covered: hit === el || el.contains(hit) ? null : describe(hit) };
        }, selector);
        if (!box) throw new Error(`click: no element ${selector}`);
        if (box.hidden) {
          if (Date.now() > end) throw new Error(`click: ${selector} isn't shown (zero size)`);
          await delay(100);
          continue;
        }
        if (!box.covered) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
          return;
        }
        if (Date.now() > end) {
          throw new Error(`click: ${selector} is covered by ${box.covered} at (${Math.round(box.x)}, ${Math.round(box.y)})`);
        }
        if (!parked) {
          parked = true;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
        }
        await delay(100);
      }
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    /** Description of document.activeElement (for focus assertions). */
    async active() {
      return evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return { tag: el.localName, id: el.id || null, text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80), cls: el.className && el.className.baseVal === undefined ? el.className : '' };
      });
    },
    async close() {
      off();
      await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };
  return page;
}
