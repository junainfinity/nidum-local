// N4 dashboard UI: end-to-end checks in headless Chrome against the real N3
// server running on fakes (test/helpers/mock-api.js).
//
//   node --test test/e2e/ui.test.js
//   NIDUM_UI_SHOTS=1 node --test test/e2e/ui.test.js   # also writes side-by-side PNGs
//                                                       # to docs/Nidum Local/Reports/assets/N4/
//
// Acceptance criteria (docs/Nidum Local/Plan/N4 Dashboard UI.md):
//  1 geometry + computed styles vs design/reference/geometry.json and the tokens, both themes
//  2 every API action reachable, with loading, success and error states
//  3 QR popover decodes (BarcodeDetector) to the exact URL; PNG download decodes too
//  4 keyboard-only flows, visible focus, dialogs trap and restore focus
//  5 no console errors, no requests outside 127.0.0.1:<port>
//  6 at 375 px, no horizontal scroll
// Never touches Portless or ~/.nidum-local: every server is mock-api.js with a temp NIDUM_HOME.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PortlessError } from '../../src/portless.js';
import { haveChrome, launchChrome } from '../helpers/chrome.js';
import { FIXTURE_NETWORKS, createFakeAdapter, createFakeDiscovery, createFakeNetwork, startMockApi } from '../helpers/mock-api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEOMETRY = JSON.parse(readFileSync(join(ROOT, 'design', 'reference', 'geometry.json'), 'utf8'));
const REF_DIR = join(ROOT, 'design', 'reference');
const SHOT_DIR = join(ROOT, 'docs', 'Nidum Local', 'Reports', 'assets', 'N4');
const SHOTS = process.env.NIDUM_UI_SHOTS === '1';
const SKIP = haveChrome() ? false : 'Google Chrome not found (set NIDUM_CHROME)';
const TABS = ['discover', 'add', 'addresses', 'sharing', 'tools', 'advanced'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures

const svc = (port, pid, proc, title, cwd, http = true) => ({
  port, pid, process: proc, user: 'me', addresses: ['127.0.0.1'], reach: 'loopback', cwd, command: `${proc} dev`,
  http: http ? { status: 200, title, server: null, framework: null, redirectsTo: null, tls: false } : null,
  hidden: null, suggestedName: title.toLowerCase().split(/\W+/)[0],
});

/** The data shown on the design boards (dashboard-light.html). */
const DESIGN_SERVICES = [
  svc(6006, 5120, 'node', 'Storybook', '/Users/me/code/design-kit'),
  svc(5173, 4821, 'node', 'Vite + React', '/Users/me/code/recipes'),
  svc(8888, 913, 'python3', 'Jupyter Server', '/Users/me/notebooks'),
  svc(4312, 6034, 'node', 'Shop', '/Users/me/code/shop'),
  svc(5432, 201, 'postgres', 'postgres', null, false),
];
const HTTPS_PROXY = { running: true, pid: 3333, port: 443, tls: true, lan: true, lanIp: '192.168.1.42', tlds: ['local'], wildcard: false, elevated: true, managedBy: 'manual' };
const DESIGN_ROUTES = [
  { hostname: 'recipes.local', port: 5173, pid: 0 },
  { hostname: 'jupyter.local', port: 8888, pid: 0 },
  { hostname: 'shop.local', port: 4312, pid: 4312 },
  { hostname: 'dashboard.local', port: 3000, pid: 0 },
];
const designProbe = async (port) => (port === 3000 ? { status: 'waiting', statusDetail: { reason: 'refused' } } : { status: 'live', statusDetail: { httpStatus: 200 } });

function designMock({ adapter: adapterOpts = {}, app = {}, dismissed = [], services = DESIGN_SERVICES, readOnly = false, network = FIXTURE_NETWORKS.wifi, discovery = null } = {}) {
  const adapter = createFakeAdapter({ proxy: HTTPS_PROXY, routes: DESIGN_ROUTES, ...adapterOpts });
  return startMockApi({
    adapter,
    readOnly,
    discovery: discovery || createFakeDiscovery(services),
    network: createFakeNetwork(network),
    state: { version: 1, names: ['recipes', 'dashboard'], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: true }, dismissed },
    app: { probeRoute: designProbe, ...app },
  });
}

// ---------------------------------------------------------------- page helpers

let browser = null;

async function openApp(mock, { theme = 'light', tab = 'discover', width = 1440, height = 900, mobile = false, reducedMotion = '' } = {}) {
  const page = await browser.newPage({ width, height, mobile });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: mock.url.replace(/\/$/, '') }).catch(() => {});
  await page.emulate({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: reducedMotion || 'reduce' });
  await page.goto(mock.tokenUrl);
  await page.evaluate((t) => localStorage.setItem('nidum-theme', t), theme);
  await page.goto('about:blank');
  await page.goto(`${mock.url}#${tab}`);
  await page.waitFor(() => document.querySelector('[data-section]') && document.querySelector('#tab-addresses .nav-count'), { what: 'dashboard loaded' });
  await page.waitFor(() => !document.querySelector('.pill .spin'), { what: 'live connection', timeout: 10_000 });
  page.mock = mock;
  return page;
}

async function goTab(page, tab) {
  await page.evaluate((t) => { location.hash = t; }, tab);
  await page.waitFor((t) => document.querySelector(`[data-section="${t}"]`), { args: [tab] });
}

// Read visible text: the screen-reader copy of each address (.addr-sr) is hidden while reading.
const VISIBLE = `(() => { let st = document.getElementById('t-hide-sr'); if (!st) { st = document.createElement('style'); st.id = 't-hide-sr'; document.head.appendChild(st); } return st; })()`;
const text = (page, sel) => page.evaluate((s, v) => {
  const st = eval(v); // eslint-disable-line no-eval
  st.textContent = '.addr-sr{display:none!important}';
  const t = document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() ?? null;
  st.textContent = '';
  return t;
}, sel, VISIBLE);
const exists = (page, sel) => page.evaluate((s) => Boolean(document.querySelector(s)), sel);
const waitSel = (page, sel, timeout = 10_000) => page.waitFor((s) => document.querySelector(s), { args: [sel], timeout, what: sel });
const waitGone = (page, sel, timeout = 10_000) => page.waitFor((s) => !document.querySelector(s), { args: [sel], timeout, what: `no ${sel}` });
const waitText = (page, sel, needle, timeout = 10_000) =>
  page.waitFor((s, n, v) => {
    const st = eval(v); // eslint-disable-line no-eval
    st.textContent = '.addr-sr{display:none!important}';
    const ok = [...document.querySelectorAll(s)].some((e) => e.innerText.replace(/\s+/g, ' ').includes(n));
    st.textContent = '';
    return ok;
  }, { args: [sel, needle, VISIBLE], timeout, what: `${sel} ~ ${needle}` });
const toastText = (page, needle) => waitText(page, '.toast', needle);

/**
 * Tests that share one page must not inherit each other's toasts: a toast left by an earlier test
 * can sit over the next test's button (validation 6, finding 1). Esc dismisses toasts one at a time;
 * it is sent only when no form, popover or dialog is open (Esc would close those instead).
 */
async function clearToasts(page) {
  if (!page) return;
  await page.evaluate(() => {
    if (document.querySelector('.dialog, .popover, .assign, .edit-box')) return;
    for (let i = 0; i < 5 && document.querySelector('.toast'); i += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  });
  await page.waitFor(() => !document.querySelector('.toast') || document.querySelector('.dialog, .popover, .assign, .edit-box'), { what: 'leftover toasts dismissed' });
}

/**
 * Make sure an address exists (created through the API, as an earlier test would have), so a test
 * that edits or removes it also passes on its own (`--test-name-pattern`) or in any order.
 */
async function ensureRoute(page, name, port) {
  await page.evaluate(async (n, p) => {
    const state = await fetch('/api/state').then((r) => r.json());
    if (state.routes.some((r) => r.hostname === `${n}.local`)) return;
    const res = await fetch('/api/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, port: p }) });
    if (!res.ok) throw new Error(`ensureRoute ${n}: ${res.status}`);
  }, name, port);
  await waitSel(page, `main [data-copy="${name}.local"]`, 10_000);
}

/** Click the first element matching `sel` whose text includes `label`. */
async function clickText(page, sel, label) {
  const ok = await page.evaluate((s, l) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.replace(/\s+/g, ' ').includes(l));
    if (!el) return false;
    el.setAttribute('data-test-click', '1');
    return true;
  }, sel, label);
  assert.ok(ok, `no ${sel} with text ${label}`);
  await page.click('[data-test-click="1"]');
  await page.evaluate(() => document.querySelector('[data-test-click]')?.removeAttribute('data-test-click'));
}

async function fill(page, sel, value) {
  await page.evaluate((s) => { const el = document.querySelector(s); el.focus(); el.select?.(); }, sel);
  await page.key('Backspace');
  if (value) await page.insertText(value);
}

/** Console errors other than the API's own deliberate 4xx/5xx answers in error-path tests. */
function unexpectedErrors(page, { allowApi = false } = {}) {
  return page.errors.filter((e) => !(allowApi && /^log\[network\]: Failed to load resource/.test(e) && /\/api\//.test(e)));
}

function offOrigin(page) {
  const origin = page.mock.url.replace(/\/$/, '');
  return page.requests.filter((u) => u && !u.startsWith(`${origin}/`) && u !== origin && !u.startsWith('data:') && !u.startsWith('blob:') && u !== 'about:blank');
}

function assertClean(page, opts) {
  assert.deepEqual(unexpectedErrors(page, opts), [], 'console errors');
  assert.deepEqual(offOrigin(page), [], 'requests outside 127.0.0.1:<port>');
}

// ---------------------------------------------------------------- geometry helpers

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Which token each measured colour in geometry.json is (so dark can be checked too). */
const COLOR_TOKENS = {
  'sidebar.background-color': '--surface', 'sidebar.border-right-color': '--border',
  'header.background-color': '--surface', 'banner.background-color': '--accent-weak',
  'navRow.background-color': '--accent-weak', 'navRow.color': '--text', 'navRowUnselected.color': '--text-2', 'navIcon.color': '--nav-icon',
  'sectionDescription.color': '--text-2',
  'btnSecondary.background-color': '--surface', 'btnSecondary.color': '--text',
  'btnPrimary.background-color': '--accent', 'btnPrimary.color': '--on-accent',
  'input.border-top-color': '--border-input', 'input.background-color': '--surface',
  'body.color': '--text', 'body.background-color': '--bg', 'btnGhost.color': '--text-2',
  'switchOn.background-color': '--live', 'switchOnKnob.background-color': '--knob-on',
  'switchOff.background-color': '--border-input', 'switchOffKnob.background-color': '--knob-off',
};
const SKIP_KEYS = new Set(['selector', 'page', 'text']);
/** Keys that depend on text width rather than layout (compared with a looser tolerance). */
const LOOSE = new Set(['brandTitle.width', 'sectionTitle.width', 'sectionDescription.width', 'btnGhost.x', 'btnGhost.width']);

async function measure(page, sel, keys, pseudoChild = null) {
  return page.evaluate((s, ks, child) => {
    let el = document.querySelector(s);
    if (el && child) el = el.querySelector(child);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of ks) {
      if (['x', 'y', 'width', 'height'].includes(k)) out[k] = r[k];
      else {
        const v = cs.getPropertyValue(k);
        out[k] = /^-?[\d.]+px$/.test(v) ? parseFloat(v) : v;
      }
    }
    return out;
  }, sel, keys, pseudoChild);
}

async function compareGeometry(page, name, expected, theme, { selector, child } = {}) {
  const keys = Object.keys(expected).filter((k) => !SKIP_KEYS.has(k) && typeof expected[k] !== 'object');
  const got = await measure(page, selector || expected.selector, keys, child);
  assert.ok(got, `${name}: ${selector || expected.selector} not found`);
  const problems = [];
  for (const k of keys) {
    let want = expected[k];
    const token = COLOR_TOKENS[`${name}.${k}`];
    if (token) {
      const lightRgb = hexRgb(GEOMETRY.tokens.light[token]);
      assert.equal(lightRgb, expected[k], `geometry.json ${name}.${k} is ${token}`); // sanity: the mapping is right
      want = hexRgb(GEOMETRY.tokens[theme][token]);
    }
    const g = got[k];
    if (typeof want === 'number') {
      const tol = LOOSE.has(`${name}.${k}`) ? 4 : 1;
      if (typeof g !== 'number' || Math.abs(g - want) > tol) problems.push(`${k}: ${g} ≠ ${want}`);
    } else if (String(g) !== String(want)) {
      problems.push(`${k}: ${g} ≠ ${want}`);
    }
  }
  assert.deepEqual(problems, [], `${name} (${theme})`);
}

// ---------------------------------------------------------------- side-by-side PNGs

async function sideBySide(ours, refFile, label, outName, { width = 1440, height = 900 } = {}) {
  const ref = readFileSync(join(REF_DIR, refFile));
  const cmp = await browser.newPage({ width: width * 2 + 24, height: height + 40 });
  try {
    await cmp.evaluate((a, b, t) => {
      document.body.style.cssText = 'margin:0;background:#888;font:600 16px system-ui;color:#fff';
      document.body.innerHTML = `<div style="display:flex;gap:24px"><div><div style="height:40px;line-height:40px;padding-left:8px">Ours · ${t}</div><img src="data:image/png;base64,${a}"></div><div><div style="height:40px;line-height:40px;padding-left:8px">Design reference · ${t}</div><img src="data:image/png;base64,${b}"></div></div>`;
      return Promise.all([...document.images].map((i) => i.decode()));
    }, ours.toString('base64'), ref.toString('base64'), label);
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, outName), await cmp.screenshot());
  } finally {
    await cmp.close();
  }
}

// ---------------------------------------------------------------- suite

describe('N4 dashboard UI (headless Chrome)', { skip: SKIP, timeout: 600_000 }, () => {
  before(async () => {
    browser = await launchChrome();
  });
  after(async () => {
    await browser?.close();
  });

  describe('1 · geometry, tokens and design fidelity', () => {
    let mock;
    before(async () => {
      mock = await designMock();
    });
    after(async () => mock?.close());

    for (const theme of ['light', 'dark']) {
      test(`tokens are the design's exact values (${theme})`, async () => {
        const page = await openApp(mock, { theme });
        try {
          const tokens = await page.evaluate((names) => {
            const cs = getComputedStyle(document.documentElement);
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
          }, Object.keys(GEOMETRY.tokens[theme]));
          const norm = (v) => v.replace(/\s+/g, ' ').toLowerCase();
          for (const [k, v] of Object.entries(GEOMETRY.tokens[theme])) assert.equal(norm(tokens[k]), norm(v), `${theme} ${k}`);
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), theme);
          assertClean(page);
        } finally {
          await page.close();
        }
      });

      test(`shell and components match geometry.json (${theme})`, async () => {
        const page = await openApp(mock, { theme });
        try {
          await page.click('[data-assign-port="6006"]');
          await waitSel(page, '#assign-name');
          await page.evaluate(() => document.activeElement.blur());
          for (const name of ['sidebar', 'brandMark', 'brandTitle', 'collapseButton', 'header', 'headerInner', 'banner', 'navRow', 'navRowUnselected', 'navIcon', 'navGap',
            'sectionTitle', 'sectionDescription', 'btnSecondary', 'btnPrimary', 'btnIcon', 'input', 'inputName', 'row', 'port']) {
            await compareGeometry(page, name, GEOMETRY[name], theme);
          }
          const { height: _h, ...wrap } = GEOMETRY.mainWrap; // height is content-dependent
          await compareGeometry(page, 'mainWrap', wrap, theme);
          await compareGeometry(page, 'body', { ...GEOMETRY.body, selector: 'body' }, theme);
          // Discover rows: 5 services, the first expanded (accent-weak), postgres not a web service.
          assert.equal(await page.evaluate(() => document.querySelectorAll('main .row, main .expanded').length), 5);
          assert.equal(await text(page, '.row.nonweb .badge'), 'Not a web service');
          // Collapsed sidebar: 64 px.
          await page.click('.collapse-toggle');
          await page.waitFor(() => document.querySelector('.app').dataset.collapsed === 'true');
          await sleep(50);
          await compareGeometry(page, 'sidebarCollapsed', GEOMETRY.sidebarCollapsed, theme, { selector: '.app[data-collapsed=true] aside.side' });
          await page.click('.collapse-toggle');
          await page.waitFor(() => document.querySelector('.app').dataset.collapsed === 'false');
          // Ghost button (Your addresses) and switch (Network sharing).
          await goTab(page, 'addresses');
          await compareGeometry(page, 'btnGhost', GEOMETRY.btnGhost, theme);
          assert.equal(await text(page, 'main .btn.btn-g'), 'Change port');
          await goTab(page, 'sharing');
          // Switch rows sit lower than on the board: the fixture's "keep after restart" is on without a
          // startup service, so the (truthful) Apply strip shows above them. y is data-dependent; the rest is exact.
          const noY = ({ y: _y, ...rest }) => rest;
          const sw = GEOMETRY.switch;
          await compareGeometry(page, 'switchOn', noY(sw.switchOn), theme);
          await compareGeometry(page, 'switchOnKnob', noY(sw.switchOnKnob), theme, { selector: '.sw[aria-checked=true]', child: 'span' });
          await compareGeometry(page, 'switchOff', noY(sw.switchOff), theme);
          await compareGeometry(page, 'switchOffKnob', noY(sw.switchOffKnob), theme, { selector: '.sw[aria-checked=false]', child: 'span' });
          const { width: _w, x: _x, y: _sy, ...sel } = sw.select; // width depends on the font's digits
          await compareGeometry(page, 'select', sel, theme);
          assertClean(page);
        } finally {
          await page.close();
        }
      });

      test(`focus ring is 2 px --focus with 2 px offset (${theme})`, async () => {
        const page = await openApp(mock, { theme });
        try {
          await page.evaluate(() => document.getElementById('tab-discover').focus());
          await page.key('ArrowDown'); // keyboard focus → :focus-visible
          const ring = await page.evaluate(() => {
            const cs = getComputedStyle(document.activeElement);
            return { id: document.activeElement.id, style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset };
          });
          assert.deepEqual(ring, { id: 'tab-add', style: 'solid', width: '2px', color: hexRgb(GEOMETRY.tokens[theme]['--focus']), offset: '2px' });
          assertClean(page);
        } finally {
          await page.close();
        }
      });
    }

    test('dark is built from the dark board, not only a token swap', async () => {
      const page = await openApp(mock, { theme: 'dark' });
      try {
        const d = GEOMETRY.tokens.dark;
        const got = await page.evaluate(() => {
          const cs = (s, p) => getComputedStyle(document.querySelector(s)).getPropertyValue(p);
          return {
            pillMix: getComputedStyle(document.documentElement).getPropertyValue('--pill-mix').trim(),
            bannerIcon: cs('.banner .banner-ic', 'color'),
            kbd: cs('main kbd', 'border-top-color'),
            notWeb: cs('.row.nonweb .badge', 'border-top-color'),
            themeGroup: cs('.theme-group', 'background-color'),
            themeGroupBorder: cs('.theme-group', 'border-top-width'),
            themePressed: cs('.theme-group [aria-pressed=true]', 'background-color'),
          };
        });
        assert.deepEqual(got, {
          pillMix: '15%', bannerIcon: hexRgb(d['--amber']), kbd: hexRgb(d['--border-strong']), notWeb: hexRgb(d['--border-strong']),
          themeGroup: hexRgb(d['--bg']), themeGroupBorder: '1px', themePressed: hexRgb(d['--surface-2']),
        });
        await goTab(page, 'add');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.add-card .field')).backgroundColor), hexRgb(d['--surface-2']));
        assert.equal(await page.evaluate(() => document.querySelector('.theme-group [aria-pressed=true]').getAttribute('aria-label')), 'Dark');
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('System theme follows prefers-color-scheme; choice and sidebar are remembered', async () => {
      const page = await openApp(mock, { theme: 'light' });
      try {
        await page.click('.theme-group [aria-label="Match system"]');
        await page.emulate({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.waitFor(() => document.documentElement.dataset.theme === 'dark');
        await page.emulate({ colorScheme: 'light', reducedMotion: 'reduce' });
        await page.waitFor(() => document.documentElement.dataset.theme === 'light');
        await page.click('.theme-group [aria-label="Dark"]');
        await page.click('.collapse-toggle');
        await page.reload();
        await waitSel(page, '[data-section]');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
        assert.equal(await page.evaluate(() => document.querySelector('.app').dataset.collapsed), 'true');
        assert.equal(await page.evaluate(() => [localStorage.getItem('nidum-theme'), localStorage.getItem('nidum-sidebar')].join()), 'dark,collapsed');
        await page.evaluate(() => { localStorage.setItem('nidum-sidebar', 'expanded'); localStorage.setItem('nidum-theme', 'light'); });
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('side-by-side PNGs for every panel in both themes', { skip: SHOTS ? false : 'set NIDUM_UI_SHOTS=1 to write the PNGs' }, async () => {
      for (const theme of ['light', 'dark']) {
        const page = await openApp(mock, { theme });
        try {
          for (const tab of TABS) {
            await page.goto('about:blank');
            await page.goto(`${mock.url}#${tab}`);
            await page.waitFor((t) => document.querySelector(`[data-section="${t}"]`) && document.querySelector('#tab-addresses .nav-count')?.textContent === '4', { args: [tab] });
            await sleep(300);
            if (tab === 'discover') {
              await page.click('[data-assign-port="6006"]');
              await waitSel(page, '#assign-name');
            }
            if (tab === 'add') {
              await page.click('#add-port');
              await page.insertText('8000');
              await page.click('#add-name');
              await page.insertText('docs');
            }
            await page.evaluate(() => { document.activeElement?.blur(); document.querySelectorAll('.toasts > *').forEach((t) => t.remove()); });
            await sleep(250);
            await sideBySide(await page.screenshot(), `${theme}-${tab}.png`, `${theme} · ${tab}`, `${theme}-${tab}.png`);
          }
          assertClean(page);
        } finally {
          await page.close();
        }
      }
    });
  });

  describe('1b · overlays match the popovers board', () => {
    let mock;
    let adapter;
    before(async () => {
      adapter = createFakeAdapter({ proxy: HTTPS_PROXY, routes: [{ hostname: 'recipes.local', port: 5173, pid: 0 }, { hostname: 'dashboard.local', port: 3000, pid: 0 }] });
      mock = await startMockApi({
        adapter,
        discovery: createFakeDiscovery([]),
        network: createFakeNetwork(FIXTURE_NETWORKS.wifi),
        state: { version: 1, names: ['recipes'], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: ['first-run'] },
        app: {
          intervals: { core: 300 },
          hostCheck: async ({ route }) => ({ result: 'host-blocked', ok: false, httpStatus: 403, framework: 'Vite', message: `Vite blocks requests for ${route.hostname}.`, fix: "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.", checkedAt: new Date().toISOString() }),
        },
      });
    });
    after(async () => mock?.close());

    test('error banner, QR popover, confirm dialog, warning notice and toasts (both themes)', async () => {
      const crops = {};
      for (const theme of ['light', 'dark']) {
        const page = await openApp(mock, { theme, tab: 'addresses' });
        const clip = async (sel, pad = 0) => {
          const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }, sel);
          return (await page.screenshot({ clip: { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 } })).toString('base64');
        };
        try {
          const c = (crops[theme] = {});
          // Warning notice from a host check (Vite blocked the name), with the fix and Check again.
          await page.evaluate(() => fetch('/api/routes/recipes/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
          await waitSel(page, '.notice');
          assert.match(await text(page, '.notice'), /recipes\.local works, but Vite blocked the name\..*server: \{ allowedHosts: \['\.local'\] \}.*Check again/);
          c.notice = await clip('.notice');
          // QR popover: 272 px, radius 14, black on white even in dark.
          await page.click('[data-qr="https://recipes.local"]');
          await waitSel(page, '.popover svg');
          const pop = await page.evaluate(() => {
            const p = document.querySelector('.popover');
            const box = document.querySelector('.qr-box');
            const cs = getComputedStyle(p);
            return { width: p.getBoundingClientRect().width, radius: cs.borderRadius, qrBg: getComputedStyle(box).backgroundColor, svgW: box.querySelector('svg').getBoundingClientRect().width, fill: box.querySelector('path').getAttribute('fill'), foot: document.querySelector('.qr-foot')?.textContent };
          });
          assert.deepEqual(pop, { width: 272, radius: '14px', qrBg: 'rgb(255, 255, 255)', svgW: 231, fill: '#000000', foot: 'First time on this phone? Set up this device' });
          await page.evaluate(() => document.activeElement.blur());
          await sleep(200);
          c.qr = await clip('.popover');
          await page.key('Escape');
          await waitGone(page, '.popover');
          // Confirm dialog: max 340 px, danger button --error / --on-error, Cancel focused.
          await page.click('button[aria-label="Remove recipes.local"]');
          await waitSel(page, '.dialog');
          const dlg = await page.evaluate(() => ({
            width: document.querySelector('.dialog').getBoundingClientRect().width,
            title: (() => { const c = document.querySelector('.dialog h3').cloneNode(true); c.querySelectorAll('.addr-vis').forEach((x) => x.remove()); return c.textContent; })(), // the accessible text
            focused: document.activeElement.textContent,
            danger: [getComputedStyle(document.querySelector('[data-confirm]')).backgroundColor, getComputedStyle(document.querySelector('[data-confirm]')).color],
          }));
          const t = GEOMETRY.tokens[theme];
          assert.deepEqual(dlg, { width: 340, title: 'Remove recipes.local?', focused: 'Cancel', danger: [hexRgb(t['--error']), hexRgb(t['--on-error'])] });
          await sleep(200);
          c.dialog = await clip('.dialog', 24);
          await page.key('Escape');
          await waitGone(page, '.dialog');
          // Toast.
          await page.evaluate(() => document.querySelectorAll('.toasts > *').forEach((x) => x.remove()));
          await page.click('[data-copy="dashboard.local"]');
          await toastText(page, 'Copied https://dashboard.local');
          await sleep(200);
          c.toast = await clip('.toast');
          // Error banner when sharing stops underneath us.
          adapter.proxy.running = false;
          await waitSel(page, '[data-banner="sharing-off"][role="alert"]');
          assert.equal(await text(page, '[data-banner="sharing-off"]'), 'Network sharing stopped. Your addresses are offline. Run diagnostics Start again');
          await sleep(200);
          c.banner = await clip('[data-banner="sharing-off"]');
          adapter.proxy.running = true;
          await waitGone(page, '[data-banner="sharing-off"]');
          assertClean(page);
        } finally {
          adapter.proxy.running = true;
          await page.close();
        }
      }
      if (SHOTS) {
        const cmp = await browser.newPage({ width: 2904, height: 1100 });
        try {
          const ref = readFileSync(join(REF_DIR, 'popovers.png')).toString('base64');
          await cmp.evaluate((cr, rf) => {
            const col = (t, c, bg) => `<div style="background:${bg};padding:40px;display:flex;flex-direction:column;gap:20px;width:640px">
              <div style="font:600 20px system-ui;color:${t === 'light' ? '#12151B' : '#F3F1EC'}">${t === 'light' ? 'Light' : 'Dark'} (ours, cropped from the dashboard)</div>
              <img style="max-width:640px" src="data:image/png;base64,${c.banner}">
              <div style="display:flex;gap:24px;align-items:flex-start"><img src="data:image/png;base64,${c.qr}"><img style="max-width:340px" src="data:image/png;base64,${c.dialog}"></div>
              <img style="max-width:640px" src="data:image/png;base64,${c.notice}">
              <img style="align-self:flex-start" src="data:image/png;base64,${c.toast}"></div>`;
            document.body.style.cssText = 'margin:0;background:#888';
            document.body.innerHTML = `<div style="display:flex;gap:24px"><div style="display:flex">${col('light', cr.light, '#F3F1EC')}${col('dark', cr.dark, '#0D0F13')}</div><img src="data:image/png;base64,${rf}"></div>`;
            return Promise.all([...document.images].map((i) => i.decode()));
          }, crops, ref);
          mkdirSync(SHOT_DIR, { recursive: true });
          writeFileSync(join(SHOT_DIR, 'popovers.png'), await cmp.screenshot());
        } finally {
          await cmp.close();
        }
      }
    });
  });

  describe('2 · every API action: loading, success, error', () => {
    let mock;
    let page;
    beforeEach(() => clearToasts(page)); // no toast from an earlier test may cover this one's buttons
    before(async () => {
      mock = await designMock({
        adapter: { delayMs: 350 },
        app: {
          intervals: { core: 600_000 }, // only explicit refreshes, so failNext() hits the request under test
          hostCheck: async ({ route }) => (route.hostname === 'jupyter.local'
            ? { result: 'host-blocked', ok: false, httpStatus: 403, framework: 'Vite', message: `Vite blocks requests for ${route.hostname}.`, fix: "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.", checkedAt: new Date().toISOString() }
            : { result: 'ok', ok: true, httpStatus: 200, framework: null, message: `${route.hostname} works through Portless.`, fix: null, checkedAt: new Date().toISOString() }),
        },
      });
      page = await openApp(mock);
    });
    after(async () => {
      await page?.close();
      await mock?.close();
    });

    const busy = (sel) => page.waitFor((s) => document.querySelector(s)?.getAttribute('aria-busy') === 'true', { args: [sel], timeout: 3000, what: `${sel} busy` });

    test('Discover: give a service an address (busy → toast → chip, focus on Copy); NAME_TAKEN offers Replace it', async () => {
      await goTab(page, 'discover');
      await waitSel(page, '[data-assign-port="6006"]', 15_000); // the first port scan can land after the page is up
      await page.click('[data-assign-port="6006"]');
      await waitSel(page, '#assign-name');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'assign-name');
      assert.equal(await page.evaluate(() => document.getElementById('assign-name').value), 'storybook');
      assert.equal(await text(page, '#assign-preview'), 'https://storybook.local');
      // Local validation.
      await fill(page, '#assign-name', 'list');
      await waitText(page, '.assign .ferr', 'list is reserved by Portless. Try list-app.');
      await fill(page, '#assign-name', 'Story Book');
      assert.equal(await page.evaluate(() => document.getElementById('assign-name').value), 'story-book');
      // Taken by an alias → Replace it (force).
      await fill(page, '#assign-name', 'recipes');
      await page.click('.assign button[type=submit]');
      await busy('.assign button[type=submit]');
      await waitText(page, '.assign .ferr', 'recipes already points to port 5173.');
      await page.waitFor(() => !document.querySelector('.assign button[type=submit][aria-busy=true]'), { what: 'request finished' });
      assert.ok(await exists(page, '.assign .ferr .btn-d'), 'Replace it offered');
      await fill(page, '#assign-name', 'storybook');
      await page.key('Enter');
      await toastText(page, 'storybook.local is ready. Open it on any device on HomeWiFi.');
      await waitSel(page, '[data-copy="storybook.local"]');
      await page.waitFor(() => document.activeElement?.dataset.copy === 'storybook.local', { what: 'focus on the new Copy button' });
      assert.ok(mock.adapter.calls.some((c) => c.method === 'addAlias' && c.args[0] === 'storybook'));
    });

    test('NAME_TAKEN_BY_APP never offers Replace it', async () => {
      await goTab(page, 'add');
      await fill(page, '#add-port', '7000');
      await fill(page, '#add-name', 'shop');
      await page.click('.add-card button[type=submit]');
      await waitText(page, '.add-card .ferr', 'shop is used by a running app');
      assert.equal(await exists(page, '.add-card .ferr .btn-d'), false);
      assertClean(page, { allowApi: true });
    });

    test('Add manually: hints, validation, create (busy → toast → fields clear, focus on Port)', async () => {
      await goTab(page, 'add');
      await fill(page, '#add-port', '70000');
      await page.evaluate(() => document.getElementById('add-port').blur());
      await waitText(page, '#add-port-hint', 'Ports go from 1 to 65535.');
      await fill(page, '#add-port', '443');
      await waitText(page, '#add-port-hint', "Port 443 is used by Nidum Local's network sharing.");
      await fill(page, '#add-port', '8888');
      await waitText(page, '#add-port-hint', 'This is Jupyter Server from Discover.');
      await fill(page, '#add-port', '9100');
      await waitText(page, '#add-port-hint', 'Nothing is running on 9100 yet. You can still save it.');
      await fill(page, '#add-name', 'docs');
      assert.equal(await text(page, '#add-preview'), 'https://docs.local');
      await page.click('.add-card button[type=submit]');
      await busy('.add-card button[type=submit]');
      await toastText(page, 'docs.local is ready.');
      await page.waitFor(() => document.getElementById('add-port').value === '' && document.activeElement.id === 'add-port');
      await goTab(page, 'addresses');
      await waitSel(page, 'tr[data-row-url="https://docs.local"]');
    });

    test('Change port and Rename: inline edit, busy, success, error', async () => {
      await goTab(page, 'addresses');
      await ensureRoute(page, 'docs', 9100);
      await page.click('button[aria-label="Change port of docs.local"]');
      await waitSel(page, '#edit-input');
      await fill(page, '#edit-input', '9200');
      await page.key('Enter');
      await busy('.edit-inline button[type=submit]');
      await toastText(page, 'docs.local now points to port 9200.');
      await waitText(page, 'tr[data-row-url="https://docs.local"] .c-port', ':9200');
      // Rename onto an existing alias → NAME_TAKEN → Replace it.
      await page.click('button[aria-label="Rename docs.local"]');
      await fill(page, '#edit-input', 'dashboard');
      await page.key('Enter');
      await waitText(page, '#edit-err', 'dashboard already points to port 3000.');
      await page.waitFor(() => !document.getElementById('edit-input').disabled, { what: 'request finished' });
      await fill(page, '#edit-input', 'handbook');
      await page.key('Enter');
      await toastText(page, 'Renamed to handbook.local.');
      await waitSel(page, 'tr[data-row-url="https://handbook.local"]');
      // Adapter failure → inline error with the server's message.
      mock.adapter.failNext('changePort', new PortlessError('PERMISSION', 'Permission denied'));
      await page.click('button[aria-label="Change port of handbook.local"]');
      await fill(page, '#edit-input', '9300');
      await page.key('Enter');
      await waitText(page, '#edit-err', 'Password not entered. Nothing changed.');
      await page.key('Escape');
      await waitGone(page, '#edit-input');
      assertClean(page, { allowApi: true });
    });

    test('Remove: confirm dialog → busy → toast with Undo; Undo re-creates; failure shows a row error', async () => {
      await goTab(page, 'addresses');
      await ensureRoute(page, 'handbook', 9200);
      await page.click('button[aria-label="Remove handbook.local"]');
      await waitSel(page, '.dialog');
      assert.equal(await text(page, '.dialog h3'), 'Remove handbook.local?');
      await page.click('.dialog [data-confirm]');
      await busy('button[aria-label="Remove handbook.local"]');
      await toastText(page, 'Removed handbook.local.');
      await waitGone(page, 'tr[data-row-url="https://handbook.local"]');
      await clickText(page, '.toast button', 'Undo');
      await toastText(page, 'handbook.local is back.');
      await waitSel(page, 'tr[data-row-url="https://handbook.local"]');
      mock.adapter.failNext('removeAlias', new PortlessError('TIMEOUT', 'timed out'));
      await page.click('button[aria-label="Remove handbook.local"]');
      await page.click('.dialog [data-confirm]');
      await waitText(page, '.notice.n-error', 'This is taking longer than expected.');
      assertClean(page, { allowApi: true });
    });

    test('Host check: warning notice with the fix, Copy and Check again', async () => {
      await goTab(page, 'addresses');
      await page.evaluate(() => fetch('/api/routes/jupyter/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
      await waitText(page, '.notice', 'jupyter.local works, but Vite blocked the name.');
      await clickText(page, '.notice button', 'Check again');
      await page.waitFor(() => document.querySelector('.notice .btn-s[aria-busy=true]'), { timeout: 3000, what: 'Check again busy' });
      await page.waitFor(() => !document.querySelector('.notice .btn-s[aria-busy=true]'));
      assert.ok(await exists(page, '.notice'));
    });

    test('Copy, Open and QR on an address chip', async () => {
      await goTab(page, 'addresses');
      await page.click('[data-copy="recipes.local"]');
      await toastText(page, 'Copied https://recipes.local');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://recipes.local');
      await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
      await page.click('button[aria-label="Open https://recipes.local"]');
      assert.deepEqual(await page.evaluate(() => window.__opened), ['https://recipes.local']);
    });

    test('Refresh services (busy → updated)', async () => {
      await goTab(page, 'discover');
      mock.discovery.services = [...DESIGN_SERVICES, svc(9999, 42, 'node', 'Fresh', '/Users/me/code/fresh')];
      await page.click('.sec-actions .btn');
      await page.waitFor(() => document.querySelector('[data-port="9999"]'), { timeout: 10_000, what: 'new service after Refresh' });
      mock.discovery.services = [...DESIGN_SERVICES];
    });

    test('Pause (confirm, job, Paused) and Resume; failures show an error banner with Try again', async () => {
      await goTab(page, 'sharing');
      await page.click('main [data-action="pause"]');
      await waitSel(page, '.dialog');
      assert.match(await text(page, '.dialog'), /Pause sharing\? \d+ addresses will go offline until you resume\./);
      await page.click('.dialog [data-confirm]');
      await page.waitFor(() => /Pausing…|Paused/.test(document.querySelector('header .pill').textContent));
      await waitText(page, 'header .pill', 'Paused', 15_000);
      await waitText(page, 'main [data-action="pause"]', 'Resume sharing');
      // A deliberate pause is not a failure (E11/D29): info banner, no (!) title, counter says paused.
      await waitSel(page, '[data-banner="sharing-paused"][role=status]');
      assert.equal(await text(page, '[data-banner="sharing-paused"] .banner-text'), 'Sharing is paused. Your addresses are offline until you resume.');
      assert.equal(await exists(page, '[data-banner="sharing-off"]'), false);
      assert.equal(await page.evaluate(() => document.title), 'Nidum Local');
      assert.equal(await text(page, 'header .counter'), 'Sharing paused');
      await page.click('main [data-action="pause"]');
      await waitText(page, 'header .pill', 'Sharing on', 15_000);
      mock.adapter.failNext('stopProxy', new PortlessError('PORT_IN_USE', 'Port 443 is in use by httpd.'));
      await page.click('main [data-action="pause"]');
      await page.click('.dialog [data-confirm]');
      await waitText(page, '.banner[role=alert]', "Couldn't pause sharing. Port 443 is in use by httpd.", 15_000);
      await clickText(page, '.banner button', 'Try again');
      await waitText(page, 'header .pill', 'Paused', 15_000);
      await page.click('main [data-action="pause"]');
      await waitText(page, 'header .pill', 'Sharing on', 15_000);
    });

    test('Restart sharing', async () => {
      await goTab(page, 'sharing');
      const starts = mock.adapter.calls.filter((c) => c.method === 'startProxy').length;
      await page.click('main [data-action="restart"]');
      await page.waitFor(() => document.querySelector('main [data-action="restart"]').getAttribute('aria-busy') === 'true');
      assert.equal(await text(page, 'main [data-action="restart"]'), 'Restart', 'the label stays while busy (spec §7.3)');
      await toastText(page, 'Sharing restarted.', );
      assert.ok(mock.adapter.calls.filter((c) => c.method === 'startProxy').length > starts);
    });

    test('Settings: switches apply immediately; HTTPS change asks to restart; keep-after-restart runs the service job', async () => {
      await goTab(page, 'sharing');
      // Portless doesn't keep the sub-name setting, so N3 only knows it for a proxy Nidum started
      // (src/state.js settingsView). Restart first, so this test doesn't depend on "Restart sharing" running before it.
      if (!mock.adapter.calls.some((c) => c.method === 'startProxy')) {
        await page.click('main [data-action="restart"]');
        await toastText(page, 'Sharing restarted.');
        await clearToasts(page);
      }
      await page.click('.sw[aria-labelledby="set-sub"]');
      await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-sub"]').getAttribute('aria-checked') === 'true');
      await waitText(page, '.strip', 'Restart sharing to apply your changes.');
      await page.click('.sw[aria-labelledby="set-sub"]');
      await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-sub"]').getAttribute('aria-checked') === 'false');
      await waitGone(page, '.strip:not([data-strip="service"])');
      await page.click('.sw[aria-labelledby="set-https"]');
      await waitText(page, '.set-row', 'Camera, microphone and offline features won’t work on other devices.');
      await page.click('.sw[aria-labelledby="set-https"]');
      await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-https"]').getAttribute('aria-checked') === 'true');
      // Fixed address: select enables with the switch.
      await page.click('.sw[aria-labelledby="set-fixed"]');
      await page.waitFor(() => !document.getElementById('fixed-ip').disabled);
      await page.click('.sw[aria-labelledby="set-fixed"]');
      await page.waitFor(() => document.getElementById('fixed-ip').disabled);
      // Keep sharing after restart: off → service uninstall job; failure reverts and shows the error.
      await page.click('.sw[aria-labelledby="set-keep"]');
      await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-busy') === 'true', { timeout: 3000 });
      await toastText(page, 'Sharing won’t start automatically any more.');
      mock.adapter.failNext('serviceInstall', new PortlessError('PERMISSION', 'User cancelled'));
      await page.click('.sw[aria-labelledby="set-keep"]');
      await waitText(page, '.set-row .notice', 'Password not entered. Nothing changed.', 15_000);
      await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked') === 'false', { what: 'reverted' });
      // Older fakes stopped sharing in the uninstall job (not a user pause, so "Start again"); N3's F1
      // change keeps it running. Either way, end with sharing on for the next tests.
      await page.waitFor(() => !document.querySelector('.pill .spin'), { timeout: 15_000, what: 'job settled' });
      if ((await text(page, 'main [data-action="pause"]')) === 'Start again') {
        await page.click('main [data-action="pause"]');
      }
      await waitText(page, 'header .pill', 'Sharing on', 15_000);
      assertClean(page, { allowApi: true });
    });

    test('Tools: diagnostics output, certificate and Safari fixes, clean up; errors inline', async () => {
      await goTab(page, 'tools');
      await page.click('[data-tool="doctor"]');
      await busy('[data-tool="doctor"]');
      await waitSel(page, '.output pre');
      assert.match(await text(page, '.output'), /portless doctor.*✓/);
      await page.click('#output-close');
      await waitGone(page, '.output');
      await page.click('[data-tool="trust"]');
      await waitText(page, '.tool .notice.n-ok', 'This computer trusts your addresses now.');
      await page.click('[data-tool="hosts-sync"]');
      await waitText(page, '.tool .notice.n-ok', 'Safari can find your addresses now.');
      await page.click('[data-tool="prune"]');
      await toastText(page, 'Stopped 1 stray server.');
      mock.adapter.failNext('doctor', new PortlessError('CLI_MISSING', 'portless not found'));
      await page.click('[data-tool="doctor"]');
      await waitText(page, '.tool .notice.n-error', 'Portless isn’t installed anymore.');
      assertClean(page, { allowApi: true });
    });

    test('Set up another device: dialog → start → QR + countdown + per-OS steps → close stops it', async () => {
      await goTab(page, 'tools');
      await page.click('[data-tool="setup"]');
      await waitSel(page, '.dialog');
      await clickText(page, '.dialog button', 'Start');
      await waitSel(page, '.dialog .qr-box svg', 15_000);
      assert.match(await text(page, '.dialog'), /https?:\/\/[\d.]+:\d+\/? .*\d+:\d\d left/);
      const setupUrl = await text(page, '.dialog .qr-url');
      const decoded = await page.evaluate(async () => {
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(document.querySelector('.dialog .qr-box svg').outerHTML)}`;
        await img.decode();
        return (await new BarcodeDetector({ formats: ['qr_code'] }).detect(img)).map((b) => b.rawValue);
      });
      assert.deepEqual(decoded, [setupUrl]);
      await clickText(page, '.dialog .setup-tabs button', 'Android');
      await waitText(page, '.dialog ol', 'Install a certificate');
      await clickText(page, '.dialog button', 'Done');
      await toastText(page, 'Device setup closed.');
      const { setup } = await page.evaluate(() => fetch('/api/setup-device').then((r) => r.json()));
      assert.equal(setup, null);
    });

    test('Reset Portless: neutral loading line until the list arrives, typed confirmation, busy, success', async () => {
      await goTab(page, 'advanced');
      // Hold the GET of what gets removed: the dialog opens at once with a neutral line, no partial list.
      await page.evaluate(() => {
        const f = window.fetch;
        const gate = new Promise((r) => { window.__releaseClean = r; });
        window.fetch = (u, o) => (String(u).includes('/api/tools/clean') && !(o && o.method && o.method !== 'GET') ? gate.then(() => f(u, o)) : f(u, o));
        window.__restoreFetch = () => { window.fetch = f; };
      });
      try {
        await clickText(page, 'main button', 'Reset Portless…');
        await waitSel(page, '#reset-confirm');
        assert.equal(await exists(page, '.dialog ul'), false, 'no list before the server answers');
        assert.equal(await text(page, '.dialog .reset-list'), 'Checking what gets removed…');
        await page.insertText('reset');
        assert.equal(await page.evaluate(() => document.querySelector('.dialog .btn-x').disabled), true, 'Reset waits for the list');
        await page.evaluate(() => window.__releaseClean());
        await waitText(page, '.dialog', 'Removes the Portless block from /etc/hosts');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.dialog ul li').length), 5);
        assert.equal(await page.evaluate(() => document.getElementById('reset-confirm').value), 'reset', 'typing survives the list arriving');
      } finally {
        await page.evaluate(() => window.__restoreFetch?.());
      }
      await page.evaluate(() => { const i = document.getElementById('reset-confirm'); i.focus(); i.select(); });
      await page.key('Backspace');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.dialog .btn-x')][0].disabled), true);
      await page.insertText('reset');
      await page.waitFor(() => !document.querySelector('.dialog .btn-x').disabled);
      await page.click('.dialog .btn-x');
      await toastText(page, 'Portless was reset.');
      assert.ok(mock.adapter.calls.some((c) => c.method === 'clean'));
      await page.waitFor(() => document.querySelector('#tab-addresses .nav-count')?.textContent === '0', { timeout: 10_000 });
    });

    test('Banner Got it dismisses first-run for good', async () => {
      await waitSel(page, '[data-banner="first-run"]');
      await clickText(page, '[data-banner="first-run"] button', 'Got it');
      await waitGone(page, '[data-banner="first-run"]');
      const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
      assert.equal(state.banners.some((b) => b.id === 'first-run'), false);
    });

    test('503 STATE_UNREADABLE is retried once after 1 s', async () => {
      await goTab(page, 'add');
      mock.adapter.failNext('listRoutes', new PortlessError('STATE_UNREADABLE', 'busy'));
      const t0 = Date.now();
      await fill(page, '#add-port', '9400');
      await fill(page, '#add-name', 'retry');
      await page.click('.add-card button[type=submit]');
      await toastText(page, 'retry.local is ready.');
      assert.ok(Date.now() - t0 >= 1000, 'waited for the retry');
      assertClean(page, { allowApi: true });
    });

    test('Quit: confirm → the page shows the closed screen', async () => {
      await page.click('button[title="Quit Nidum Local"]');
      await waitSel(page, '.dialog');
      assert.equal(await text(page, '.dialog p'), 'Your addresses keep working; only this dashboard closes.');
      await page.click('.dialog [data-confirm]');
      await waitText(page, '.fullpage', 'Nidum Local is closed.');
      assertClean(page, { allowApi: true });
    });
  });

  describe('2b · read-only server: every mutation shows its error inline', () => {
    let mock;
    let page;
    beforeEach(() => clearToasts(page)); // no toast from an earlier test may cover this one's buttons
    const RO = 'Read-only mode: nothing can be changed.';
    before(async () => {
      mock = await designMock({ readOnly: true });
      page = await openApp(mock);
    });
    after(async () => {
      await page?.close();
      await mock?.close();
    });

    test('create, add, change port, rename, remove, pause, settings, tools, reset, setup, dismiss', async () => {
      await page.click('[data-assign-port="6006"]');
      await page.key('Enter');
      await waitText(page, '.assign .ferr', RO);
      await page.key('Escape');
      await goTab(page, 'add');
      await fill(page, '#add-port', '8000');
      await fill(page, '#add-name', 'docs');
      await page.key('Enter');
      await waitText(page, '.add-card .ferr', RO);
      await goTab(page, 'addresses');
      await page.click('button[aria-label="Change port of recipes.local"]');
      await fill(page, '#edit-input', '5174');
      await page.key('Enter');
      await waitText(page, '#edit-err', RO);
      await page.key('Escape');
      await page.click('button[aria-label="Rename recipes.local"]');
      await fill(page, '#edit-input', 'cook');
      await page.key('Enter');
      await waitText(page, '#edit-err', RO);
      await page.key('Escape');
      await page.click('button[aria-label="Remove recipes.local"]');
      await page.click('.dialog [data-confirm]');
      await waitText(page, '.notice.n-error', RO);
      await goTab(page, 'sharing');
      await page.click('main [data-action="pause"]');
      await page.click('.dialog [data-confirm]');
      await waitText(page, '.banner[role=alert]', RO);
      await page.click('.banner button[aria-label="Dismiss"]');
      await page.click('.sw[aria-labelledby="set-sub"]');
      await waitText(page, '.set-row .notice', RO);
      await goTab(page, 'tools');
      await page.click('[data-tool="trust"]');
      await waitText(page, '.tool .notice', RO);
      await page.click('[data-tool="setup"]');
      await waitSel(page, '.dialog');
      await clickText(page, '.dialog button', 'Start');
      await waitText(page, '.dialog .notice', RO);
      await page.key('Escape');
      await goTab(page, 'advanced');
      await clickText(page, 'main button', 'Reset Portless…');
      await waitSel(page, '#reset-confirm');
      await page.insertText('reset');
      await page.waitFor(() => !document.querySelector('.dialog .btn-x').disabled, { what: 'Reset enabled once the list arrives' });
      await page.click('.dialog .btn-x');
      await waitText(page, '.dialog .notice', RO);
      await page.key('Escape');
      await clickText(page, '[data-banner="first-run"] button', 'Got it');
      await waitText(page, '[data-banner="first-run"] .banner-err', 'Couldn’t hide this notice. Read-only mode: nothing can be changed.');
      assert.equal(await exists(page, '.toast'), false, 'errors are never toasts (spec §11)');
      // Diagnostics is allowed in read-only mode.
      await goTab(page, 'tools');
      await page.click('[data-tool="doctor"]');
      await waitSel(page, '.output pre');
      assertClean(page, { allowApi: true });
    });
  });

  describe('3 · QR codes decode to the exact URL', () => {
    let mock;
    let page;
    beforeEach(() => clearToasts(page)); // no toast from an earlier test may cover this one's buttons
    before(async () => {
      mock = await designMock();
      page = await openApp(mock, { tab: 'addresses' });
    });
    after(async () => {
      await page?.close();
      await mock?.close();
    });

    async function decodeSvg() {
      return page.evaluate(async () => {
        const svg = document.querySelector('.popover .qr-box svg').outerHTML;
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return { width: img.naturalWidth, values: (await new BarcodeDetector({ formats: ['qr_code'] }).detect(c)).map((b) => b.rawValue) };
      });
    }

    test('popover QR (7 px modules, ≤ 232 px) and the downloaded PNG decode to the URL', async () => {
      await page.click('[data-qr="https://recipes.local"]');
      await waitSel(page, '.popover svg');
      const r = await decodeSvg();
      assert.deepEqual(r, { width: 231, values: ['https://recipes.local'] });
      assert.equal(await text(page, '.popover .qr-url'), 'https://recipes.local');
      await page.evaluate(() => {
        window.__dl = null;
        const orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function click() {
          if (this.download) window.__dl = { href: this.href, name: this.download };
          else orig.call(this);
        };
      });
      await clickText(page, '.popover button', 'Download');
      await page.waitFor(() => window.__dl);
      const dl = await page.evaluate(async () => {
        // fetch(blob:) is blocked by the page's CSP (connect-src 'self'); img-src allows blob:.
        const img = new Image();
        img.src = window.__dl.href;
        await img.decode();
        const values = (await new BarcodeDetector({ formats: ['qr_code'] }).detect(img)).map((b) => b.rawValue);
        return { name: window.__dl.name, png: window.__dl.href.startsWith('blob:'), values };
      });
      assert.deepEqual(dl, { name: 'recipes.local-qr.png', png: true, values: ['https://recipes.local'] });
      // Esc closes and returns focus to the QR button.
      await page.key('Escape');
      await waitGone(page, '.popover');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.qr), 'https://recipes.local');
      assertClean(page);
    });

    test('a long URL scales the modules down but stays ≤ 232 px and decodes', async () => {
      const name = 'a-really-long-name-for-a-service.with-several.labels-that-make-the-qr-bigger';
      await page.evaluate((n) => fetch('/api/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, port: 7777 }) }), name);
      const url = `https://${name}.local`;
      await page.waitFor((u) => document.querySelector(`[data-qr="${u}"]`), { args: [url] });
      await page.click(`[data-qr="${url}"]`);
      await waitSel(page, '.popover svg');
      const r = await decodeSvg();
      assert.ok(r.width <= 232, `width ${r.width}`);
      assert.deepEqual(r.values, [url]);
      await page.key('Escape');
      assertClean(page);
    });
  });

  describe('4 · keyboard-only flows, visible focus, focus trap', () => {
    let mock;
    let page;
    beforeEach(() => clearToasts(page)); // no toast from an earlier test may cover this one's buttons
    before(async () => {
      mock = await designMock({ dismissed: ['first-run'] });
      page = await openApp(mock);
    });
    after(async () => {
      await page?.close();
      await mock?.close();
    });

    test('/ focuses search; n opens Add manually; g a opens Your addresses; ? opens the shortcuts', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.key('/');
      await page.waitFor(() => document.activeElement?.id === 'search');
      await page.type('vite');
      await page.waitFor(() => document.querySelectorAll('main .row').length === 1);
      await page.key('Escape');
      await page.waitFor(() => document.getElementById('search').value === '');
      await page.evaluate(() => document.activeElement.blur());
      await page.key('n');
      await page.waitFor(() => document.activeElement?.id === 'add-port' && location.hash === '#add');
      await page.evaluate(() => document.activeElement.blur());
      await page.key('g');
      await page.key('a');
      await page.waitFor(() => location.hash === '#addresses' && document.activeElement?.id === 'panel-h');
      await page.key('?');
      await waitSel(page, '.dialog');
      assert.equal(await text(page, '.dialog h3'), 'Keyboard shortcuts');
      await page.key('Escape');
      await waitGone(page, '.dialog');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'panel-h');
    });

    test('tabs: arrow keys move the selection (roving tabindex)', async () => {
      await goTab(page, 'addresses');
      await page.evaluate(() => document.getElementById('tab-addresses').focus());
      await page.key('ArrowDown');
      await page.waitFor(() => document.activeElement.id === 'tab-sharing' && document.querySelector('[data-section="sharing"]'));
      await page.key('Home');
      await page.waitFor(() => document.activeElement.id === 'tab-discover');
      await page.key('End');
      await page.waitFor(() => document.activeElement.id === 'tab-advanced');
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((t) => t.tabIndex)), [-1, -1, -1, -1, -1, 0]);
    });

    test('create an address with the keyboard only (Tab, typing, Enter); focus lands on the new Copy button', async () => {
      await page.evaluate(() => document.activeElement.blur());
      await page.key('n');
      await page.waitFor(() => document.activeElement?.id === 'add-port');
      await page.type('8123');
      await page.key('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'add-name');
      await page.type('kb');
      await page.key('Enter');
      await toastText(page, 'kb.local is ready.');
      await page.waitFor(() => document.activeElement?.id === 'add-port');
      // Discover: Give it an address → type → Enter.
      await page.evaluate(() => document.activeElement.blur());
      await page.key('/');
      await page.key('Tab'); // leaves the search field
      let found = false;
      for (let i = 0; i < 40 && !found; i += 1) {
        found = await page.evaluate(() => document.activeElement?.dataset.assignPort === '6006');
        if (!found) await page.key('Tab');
      }
      assert.ok(found, 'reached "Give it an address" with Tab');
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      assert.equal(ring, 'solid', 'focus is visible');
      await page.key('Enter');
      await page.waitFor(() => document.activeElement?.id === 'assign-name');
      await page.key('Escape');
      await page.waitFor(() => document.activeElement?.dataset.assignPort === '6006', { what: 'Esc closes the form and restores focus' });
      await page.key('Enter');
      await page.waitFor(() => document.activeElement?.id === 'assign-name');
      await page.key('Enter');
      await page.waitFor(() => document.activeElement?.dataset.copy === 'storybook.local', { timeout: 10_000, what: 'focus on new Copy' });
      // c copies the focused address row.
      await page.key('c');
      await toastText(page, 'Copied https://storybook.local');
    });

    test('remove dialog: Cancel focused, Tab and Shift+Tab stay inside, Esc restores focus to the opener', async () => {
      await goTab(page, 'addresses');
      await ensureRoute(page, 'kb', 8123);
      await page.evaluate(() => document.getElementById('tab-addresses').focus());
      await page.key('Enter');
      await page.evaluate(() => document.getElementById('panel-h').focus());
      let found = false;
      for (let i = 0; i < 60 && !found; i += 1) {
        await page.key('Tab');
        found = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Remove kb.local');
      }
      assert.ok(found, 'reached Remove with Tab');
      await page.key('Enter');
      await waitSel(page, '.dialog');
      await page.waitFor(() => document.activeElement?.textContent === 'Cancel');
      await page.key('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Remove address');
      await page.key('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel', 'Tab wraps inside the dialog');
      await page.key('Tab', { shift: true });
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Remove address', 'Shift+Tab wraps');
      assert.equal(await page.evaluate(() => document.querySelector('.app').inert), true, 'page behind the dialog is inert');
      await page.key('Escape');
      await waitGone(page, '.dialog');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Remove kb.local');
      // And remove it for real with Enter, Tab, Enter.
      await page.key('Enter');
      await waitSel(page, '.dialog');
      await page.key('Tab');
      await page.key('Enter');
      await toastText(page, 'Removed kb.local.');
      assertClean(page);
    });
  });

  describe('5 · states, capabilities and copy from the contract', () => {
    test('mac-service: Ethernet header, Pause enabled (D43), Restart reason, app + different-suffix rows, setup hidden, internet sharing disabled', async () => {
      const mock = await startMockApi({ scenario: 'mac-service' });
      const page = await openApp(mock);
      try {
        assert.equal(await text(page, 'header .netinfo'), 'Ethernet · 192.168.68.119');
        await page.waitFor(() => !document.querySelector('header [data-action="pause"]').disabled, { what: 'Pause enabled (D43)' });
        await goTab(page, 'sharing');
        assert.equal(await exists(page, '#pause-reason'), false, 'no "kept on by the startup service" reason (D43)');
        assert.match(await text(page, '#restart-reason'), /startup service runs sharing/, 'Restart stays disabled with a visible reason');
        await goTab(page, 'addresses');
        assert.match(await text(page, 'tbody'), /shop\.local.*Managed by its app/);
        assert.match(await text(page, 'tbody'), /old\.localhost\s*different suffix/);
        assert.deepEqual(await page.evaluate(() => [...[...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('old.localhost')).querySelectorAll('button')].map((b) => b.textContent)), ['Remove']);
        await page.click('[data-qr="http://plex.local"]');
        await waitSel(page, '.popover');
        assert.equal(await exists(page, '.qr-foot'), false, 'no setup footnote over HTTP');
        await page.key('Escape');
        await goTab(page, 'tools');
        assert.equal(await exists(page, '[data-tool="setup"]'), false);
        await goTab(page, 'advanced');
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.adv-tbl .sw')].every((s) => s.disabled)), true);
        const reason = await page.evaluate(() => fetch('/api/state').then((r) => r.json()).then((st) => st.capabilities.internetSharing.reason));
        assert.equal(await text(page, '#inet-reason'), reason, 'D28: the reason is visible text');
        assert.doesNotMatch(reason, /portless/i, 'no CLI words in the main UI (spec §2)');
        // Remove the different-suffix route (by hostname), no Undo offered.
        await goTab(page, 'addresses');
        await page.click('button[aria-label="Remove old.localhost"]');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'Removed old.localhost.');
        assert.equal(await exists(page, '.toast .btn-link'), false);
        assertClean(page);
      } finally {
        await page.close();
        await mock.close();
      }
    });

    test('stopped (not by the user, E11): Needs attention pill jumps to the error banner; Start again turns sharing on', async () => {
      const mock = await startMockApi({ scenario: 'stopped' });
      const page = await openApp(mock, { tab: 'addresses' });
      try {
        await waitText(page, '[data-banner="sharing-off"][role=alert]', 'Network sharing stopped. Your addresses are offline.');
        assert.equal(await text(page, 'header .pill'), 'Needs attention');
        await page.click('header button.pill');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'page-banner');
        assert.equal(await page.evaluate(() => document.title), '(!) Nidum Local');
        assert.equal(await text(page, 'header .counter'), 'Sharing is off');
        assert.equal(await text(page, 'header [data-action="pause"]'), 'Start again', 'one label per action after an unexpected stop');
        await goTab(page, 'sharing');
        assert.equal(await text(page, 'main [data-action="pause"]'), 'Start again');
        await goTab(page, 'addresses');
        await waitText(page, '.paused-strip', 'Sharing is off. These addresses are offline.');
        await clickText(page, '[data-banner="sharing-off"] button', 'Start again');
        await waitText(page, 'header .pill', 'Sharing', 15_000);
        await waitGone(page, '.paused-strip');
        assertClean(page);
      } finally {
        await page.close();
        await mock.close();
      }
    });

    test('empty: empty states, public-network banner wins over first-run and can be dismissed for that network', async () => {
      const mock = await startMockApi({ scenario: 'empty' });
      const page = await openApp(mock);
      try {
        await waitText(page, '.empty', 'Nothing is running yet.');
        await waitText(page, '[data-banner="public-network"]', 'Hotel Guest looks like a public network.');
        await clickText(page, '[data-banner="public-network"] button', 'Dismiss');
        await waitSel(page, '[data-banner="first-run"]');
        await goTab(page, 'addresses');
        await waitText(page, '.empty', 'No addresses yet.');
        await clickText(page, '.empty button', 'Add manually');
        await page.waitFor(() => location.hash === '#add' && document.activeElement.id === 'add-port');
        assertClean(page);
      } finally {
        await page.close();
        await mock.close();
      }
    });

    test('password prompt: "Waiting for your password…" while the OS dialog is up (spec §7.16)', async () => {
      let mock = null;
      let release;
      const gate = new Promise((r) => { release = r; });
      mock = await designMock({ dismissed: ['first-run'], adapter: { onElevate: () => gate } }); // the fake raises waitingForPassword itself (E10)
      const page = await openApp(mock, { tab: 'sharing' });
      try {
        await page.click('main [data-action="pause"]');
        await page.click('.dialog [data-confirm]');
        await waitText(page, 'header .pill', 'Waiting for your password…');
        await waitText(page, 'main .pwd-note', 'Your computer is asking for your password in a separate window.');
        assert.equal(await text(page, 'main [data-action="pause"]'), 'Waiting for your password…');
        // A different sharing change while that job runs → 409 BUSY (API extensions E3), shown inline and reverted.
        await page.click('.sw[aria-labelledby="set-keep"]');
        await waitText(page, '.set-row .notice', 'Another sharing change is still running. Try again when it finishes.');
        await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked') === 'true', { what: 'reverted after BUSY' });
        release();
        await waitText(page, 'header .pill', 'Paused', 15_000);
        await waitGone(page, 'main .pwd-note');
        assertClean(page, { allowApi: true });
      } finally {
        release();
        await page.close();
        await mock.close();
      }
    });

    test('before the first good read: proxy null and routesUnavailable never look like Paused or "No addresses yet" (E1)', async () => {
      const adapter = createFakeAdapter({ proxy: HTTPS_PROXY, routes: DESIGN_ROUTES });
      let blocked = true;
      const orig = { listRoutes: adapter.listRoutes, getProxyState: adapter.getProxyState };
      adapter.listRoutes = async (...a) => { if (blocked) throw new PortlessError('STATE_UNREADABLE', 'busy'); return orig.listRoutes(...a); };
      adapter.getProxyState = async (...a) => { if (blocked) throw new PortlessError('TIMEOUT', 'slow'); return orig.getProxyState(...a); };
      const mock = await startMockApi({
        adapter, discovery: createFakeDiscovery(DESIGN_SERVICES), network: createFakeNetwork(FIXTURE_NETWORKS.wifi),
        state: { version: 1, names: ['recipes'], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: ['first-run'] },
        app: { probeRoute: designProbe, intervals: { core: 300 } },
      });
      const page = await browser.newPage({ width: 1440, height: 900 });
      page.mock = mock;
      try {
        await page.emulate({ colorScheme: 'light', reducedMotion: 'reduce' });
        await page.goto(mock.tokenUrl);
        await page.goto('about:blank');
        await page.goto(`${mock.url}#addresses`);
        await waitText(page, 'main', 'Reading your addresses…');
        const st = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        assert.equal(st.routesUnavailable, true);
        assert.equal(st.proxy, null);
        assert.equal(await text(page, 'header .pill'), 'Checking sharing…');
        assert.equal(await exists(page, '.empty'), false, 'no "No addresses yet" while unavailable');
        assert.equal(await exists(page, '#tab-addresses .nav-count'), false);
        assert.equal(await exists(page, 'header .counter'), false);
        assert.equal(await page.evaluate(() => document.querySelector('header [data-action="pause"]').disabled), true);
        assert.equal(await text(page, 'header [data-action="pause"]'), 'Pause sharing', 'neutral label while the state is unknown');
        blocked = false;
        await waitSel(page, 'tr[data-row-url="https://recipes.local"]', 10_000);
        await waitText(page, 'header .pill', 'Sharing on');
        assert.equal(await text(page, '#tab-addresses .nav-count'), '4');
        assertClean(page);
      } finally {
        blocked = false;
        await page.close();
        await mock.close();
      }
    });

    test('no network: header says Not connected', async () => {
      const mock = await designMock({ network: FIXTURE_NETWORKS.none });
      const page = await openApp(mock);
      try {
        assert.equal(await text(page, 'header .netinfo'), 'Not connected');
        assertClean(page);
      } finally {
        await page.close();
        await mock.close();
      }
    });

    test('server gone: Reconnecting…, then Lost contact with a Reconnect button', async () => {
      const mock = await designMock();
      const page = await openApp(mock);
      try {
        await mock.close();
        await waitText(page, '.fullpage', 'Lost contact with Nidum Local.', 25_000);
        assert.ok(await exists(page, '#reconnect'));
        assert.deepEqual(offOrigin(page), []);
      } finally {
        await page.close();
      }
    });
  });

  describe('6 · 375 px wide: no horizontal scroll', () => {
    let mock;
    before(async () => {
      mock = await designMock();
    });
    after(async () => mock?.close());

    for (const theme of ['light', 'dark']) {
      test(`every panel fits 375 px (${theme})`, async () => {
        const page = await openApp(mock, { theme, width: 375, height: 812, mobile: true });
        try {
          for (const tab of TABS) {
            await goTab(page, tab);
            if (tab === 'discover') {
              await page.click('[data-assign-port="6006"]');
              await waitSel(page, '#assign-name');
            }
            await sleep(50);
            const w = await page.evaluate(() => ({
              doc: document.documentElement.scrollWidth,
              panel: document.getElementById('panel').scrollWidth - document.getElementById('panel').clientWidth,
              side: document.querySelector('aside.side').getBoundingClientRect().width,
            }));
            assert.ok(w.doc <= 375, `${tab}: documentElement.scrollWidth ${w.doc}`);
            assert.ok(w.panel <= 0, `${tab}: panel scrolls sideways by ${w.panel}`);
            assert.equal(w.side, 64, 'sidebar forced to 64 px');
            if (SHOTS && theme === 'light' && (tab === 'discover' || tab === 'addresses')) {
              mkdirSync(SHOT_DIR, { recursive: true });
              writeFileSync(join(SHOT_DIR, `mobile-375-${tab}.png`), await page.screenshot());
            }
          }
          assertClean(page);
        } finally {
          await page.close();
        }
      });
    }
  });
  describe('7 · iteration 2: layout sweep, risky services, live checks, freshness', () => {
    const LONG = 'a'.repeat(63);
    let mock;
    before(async () => {
      mock = await designMock({
        adapter: { routes: [...DESIGN_ROUTES, { hostname: `${LONG}.local`, port: 7001, pid: 0 }] },
        services: [...DESIGN_SERVICES, { ...svc(7001, 77, 'a-very-long-process-name-that-goes-on-and-on-and-on', 'Long one', '/Users/me/code/long'), reach: 'loopback' }],
      });
    });
    after(async () => mock?.close());

    /**
     * In-page: line breaks inside every address element matching `sel`. A break is fine after "." or
     * before ":"; anywhere else only inside a single label wider than the whole line (last resort).
     */
    const BREAKS = (sel) => {
      const bad = [];
      const singleLine = [];
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent;
        if (!text) continue;
        const chars = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (let i = 0; i < n.data.length; i += 1) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getBoundingClientRect();
            chars.push({ c: n.data[i], top: Math.round(rect.top), w: rect.width });
          }
        }
        let block = el;
        while (block && getComputedStyle(block).display === 'inline') block = block.parentElement;
        const lineWidth = block.clientWidth;
        let lines = 1;
        for (let i = 1; i < chars.length; i += 1) {
          if (chars[i].top <= chars[i - 1].top + 2) continue;
          lines += 1;
          if (chars[i - 1].c === '.' || chars[i].c === ':') continue;
          let a = i - 1;
          while (a > 0 && !'.:'.includes(chars[a - 1].c)) a -= 1;
          let b = i;
          while (b < chars.length - 1 && !'.:'.includes(chars[b + 1].c)) b += 1;
          if (b + 1 < chars.length && chars[b + 1].c === '.') b += 1; // the piece includes its trailing "."
          const labelW = chars.slice(a, b + 1).reduce((sum, x) => sum + x.w, 0);
          if (labelW <= lineWidth + 1) bad.push(`${text.slice(0, i)} / ${text.slice(i)}`);
        }
        singleLine.push(lines === 1);
      }
      return { bad, allOneLine: singleLine.every(Boolean), count: singleLine.length };
    };

    /**
     * Your addresses at the current viewport (D35, iteration 4): cards, or a table whose Address column
     * keeps ≥ 280 px and shows every address on one line (port included). Breaks only after "." or
     * before ":"; chip buttons together and inside the card; every action reachable; no sideways scroll.
     */
    async function checkAddresses(page, label) {
      const r = await page.evaluate((breaksSrc) => {
        const breaks = eval(`(${breaksSrc})`); // eslint-disable-line no-eval
        const sec = document.querySelector('.addr-section');
        const card = sec.querySelector('.card');
        const cr = card.getBoundingClientRect();
        const table = getComputedStyle(sec.querySelector('thead')).display !== 'none';
        const addrCol = table ? sec.querySelector('thead th.first').getBoundingClientRect().width : null;
        const chips = [...sec.querySelectorAll('.chip')].map((c) => {
          const btns = [...c.querySelectorAll('.btn-i')].map((b) => b.getBoundingClientRect());
          return {
            btnsTogether: btns.every((b) => Math.abs(b.top - btns[0].top) <= 2),
            inside: [c, ...c.children].every((k) => { const kr = k.getBoundingClientRect(); return kr.right <= cr.right + 1 && kr.left >= cr.left - 1; }),
          };
        });
        const acts = [...sec.querySelectorAll('.acts button, .managed')].map((b) => {
          const br = b.getBoundingClientRect();
          return br.left >= cr.left - 1 && br.right <= cr.right + 1 && br.right <= window.innerWidth;
        });
        return { table, addrCol, chips, acts, breaks: breaks('.addr-section .chip-addr'), cardOverflow: card.scrollWidth - card.clientWidth, doc: document.documentElement.scrollWidth, vw: window.innerWidth };
      }, String(BREAKS));
      if (r.table) {
        assert.ok(r.addrCol >= 280, `${label}: Address column ${r.addrCol} < 280`);
        assert.ok(r.breaks.allOneLine, `${label}: table mode but an address takes more than one line`);
      }
      assert.deepEqual(r.breaks.bad, [], `${label}: address broken inside a label or the port`);
      assert.ok(r.chips.every((c) => c.btnsTogether), `${label}: chip buttons split`);
      assert.ok(r.chips.every((c) => c.inside), `${label}: a chip leaves the card`);
      assert.ok(r.acts.length >= 3 && r.acts.every(Boolean), `${label}: a row action is outside the card or the viewport`);
      assert.ok(r.cardOverflow <= 0, `${label}: card scrolls sideways by ${r.cardOverflow}`);
      assert.ok(r.doc <= r.vw, `${label}: page wider than the viewport (${r.doc})`);
      return r;
    }

    const PORT_PROXY = { ...HTTPS_PROXY, port: 46703, tls: false };
    const SETS = [
      ['board, no port', {}],
      ['board, port 46703', { adapter: { proxy: PORT_PROXY } }],
      ['63-char label, no port', { adapter: { routes: [...DESIGN_ROUTES, { hostname: `${LONG}.local`, port: 7001, pid: 0 }, { hostname: 'n6-pancakes.local', port: 7002, pid: 0 }] } }],
      ['63-char label, port 46703', { adapter: { proxy: PORT_PROXY, routes: [...DESIGN_ROUTES, { hostname: `${LONG}.local`, port: 7001, pid: 0 }, { hostname: 'n6-pancakes.local', port: 7002, pid: 0 }] } }],
    ];

    for (const [name, opts] of SETS) {
      test(`Your addresses sweep (${name}): every 20 px from 1500 to 320, sidebar open and collapsed`, async () => {
        const m = await designMock({ dismissed: ['first-run'], ...opts });
        const page = await openApp(m, { tab: 'addresses', width: 1500, height: 900 });
        try {
          await page.waitFor(() => document.querySelectorAll('.addr-section tbody tr[data-row-url]').length >= 3);
          let tables = 0;
          let cards = 0;
          for (const collapsed of [false, true]) {
            if (collapsed) {
              await page.setViewport(1500, 900);
              await page.click('.collapse-toggle');
              await page.waitFor(() => document.querySelector('.app').dataset.collapsed === 'true');
            }
            for (let w = 1500; w >= 320; w -= 20) {
              await page.setViewport(w, 900);
              await page.waitFor(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true)))));
              const r = await checkAddresses(page, `${name} · ${w} px${collapsed ? ' · collapsed' : ''}`);
              if (r.table) tables += 1;
              else cards += 1;
            }
          }
          assert.ok(cards > 50, `cards exercised (${tables} tables, ${cards} cards)`);
          if (name === 'board, no port') assert.ok(tables > 5, `table exercised (${tables})`);
          // Discover rows and the QR popover URL break the same way. The toggle isn't shown at 320 px, so
          // expand the sidebar at full width (a click at 320 px used to land on the sidebar and do nothing).
          await page.setViewport(1500, 900);
          await page.click('.collapse-toggle');
          await page.waitFor(() => document.querySelector('.app').dataset.collapsed !== 'true', { what: 'sidebar expanded' });
          await goTab(page, 'discover');
          for (let w = 700; w >= 320; w -= 20) {
            await page.setViewport(w, 900);
            await page.waitFor(() => new Promise((res) => requestAnimationFrame(() => res(true))));
            const d = await page.evaluate((src) => eval(`(${src})`)('main .row .chip-addr'), String(BREAKS)); // eslint-disable-line no-eval
            assert.deepEqual(d.bad, [], `${name} · Discover ${w} px`);
          }
          await page.setViewport(375, 812);
          await goTab(page, 'addresses');
          await page.evaluate(() => document.querySelector('.addr-section [data-qr]').scrollIntoView({ block: 'center' }));
          await sleep(150);
          await page.click('.addr-section [data-qr]');
          await waitSel(page, '.popover .qr-url');
          const q = await page.evaluate((src) => eval(`(${src})`)('.popover .qr-url .addr-vis'), String(BREAKS)); // eslint-disable-line no-eval
          assert.deepEqual(q.bad, [], `${name} · QR popover URL`);
          await page.key('Escape');
          await page.evaluate(() => localStorage.setItem('nidum-sidebar', 'expanded'));
          assertClean(page);
        } finally {
          await page.close();
          await m.close();
        }
      });
    }

    test('board data at 1440 / 1280 / 1100 / 1024 in both themes, with and without a port', async () => {
      for (const [setName, opts, tableAt1440] of [['no port', {}, true], ['port 46703', { adapter: { proxy: PORT_PROXY } }, false]]) {
        const board = await designMock(opts);
        try {
          for (const theme of ['light', 'dark']) {
            const page = await openApp(board, { theme, tab: 'addresses', width: 1440, height: 900 });
            try {
              for (const w of [1440, 1280, 1100, 1024]) {
                await page.setViewport(w, 900);
                await page.waitFor(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true)))));
                const r = await checkAddresses(page, `${setName} ${theme} ${w}`);
                assert.equal(r.table, w === 1440 && tableAt1440, `${setName} ${theme} ${w}: ${r.table ? 'table' : 'cards'}`);
                if (SHOTS) {
                  mkdirSync(SHOT_DIR, { recursive: true });
                  writeFileSync(join(SHOT_DIR, `addresses-${setName === 'no port' ? '' : 'port-'}${theme}-${w}.png`), await page.screenshot());
                }
              }
              assertClean(page);
            } finally {
              await page.close();
            }
          }
        } finally {
          await board.close();
        }
      }
    });

    test('Rename and Change port editors get ≥ 240 px in a row of their own; the typed name stays visible', async () => {
      const page = await openApp(mock, { tab: 'addresses', width: 1440, height: 900 });
      try {
        for (const w of [1440, 1100, 900, 375]) {
          await page.setViewport(w, 900);
          await page.click('button[aria-label="Rename recipes.local"]');
          await waitSel(page, '#edit-input');
          await fill(page, '#edit-input', w >= 1100 ? 'a-fairly-long-new-name-for-recipes' : w >= 640 ? 'a-new-name-for-recipes' : 'new-name-recipes');
          const r = await page.evaluate(() => {
            const i = document.getElementById('edit-input');
            return { field: i.closest('.field').getBoundingClientRect().width, input: i.clientWidth, fits: i.scrollWidth <= i.clientWidth + 1, row: Boolean(i.closest('tr.edit-row')), vw: window.innerWidth };
          });
          assert.ok(r.row, `${w}: editor in its own row`);
          assert.ok(r.field >= 240, `${w}: rename field ${r.field}`);
          if (w >= 640) assert.ok(r.input >= 220, `${w}: rename input ${r.input}`); // at 375 the field is ≥ 240 but its suffix leaves ~170 to type in
          assert.ok(r.fits, `${w}: the typed name is fully visible`);
          assert.match(await text(page, '#edit-preview'), /^https:\/\/(a-fairly-long-new-name-for-recipes|a-new-name-for-recipes|new-name-recipes)\.local$/, `${w}: preview line`);
          assert.match(await page.evaluate(() => document.getElementById('edit-input').getAttribute('aria-describedby')), /edit-preview/);
          await page.key('Escape');
          await waitGone(page, '#edit-input');
          await page.click('button[aria-label="Change port of recipes.local"]');
          await waitSel(page, '#edit-input');
          const pw = await page.evaluate(() => document.getElementById('edit-input').closest('.field').getBoundingClientRect().width);
          assert.ok(pw >= 240, `${w}: port field ${pw}`);
          await page.key('Escape');
          await waitGone(page, '#edit-input');
        }
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('Your addresses at 200 % zoom (1440 window = 720 CSS px, device scale 2)', async () => {
      const page = await openApp(mock, { tab: 'addresses', width: 720, height: 450 });
      try {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
        await sleep(100);
        const r = await checkAddresses(page, '200 %');
        assert.equal(r.table, false, 'cards at 200 %');
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('320 px: every panel fits; Add manually fields stay inside the card; wrapped header has padding', async () => {
      const page = await openApp(mock, { width: 320, height: 700, mobile: true });
      try {
        for (const tab of TABS) {
          await goTab(page, tab);
          const r = await page.evaluate(() => {
            const card = document.querySelector('.add-card');
            const out = { doc: document.documentElement.scrollWidth, panel: document.getElementById('panel').scrollWidth - document.getElementById('panel').clientWidth };
            if (card) {
              const cr = card.getBoundingClientRect();
              out.fieldsInside = [...card.querySelectorAll('.field')].every((f) => f.getBoundingClientRect().right <= cr.right - 1);
            }
            const head = document.querySelector('header.top').getBoundingClientRect();
            out.pillGap = document.querySelector('header .pill').getBoundingClientRect().top - head.top;
            return out;
          });
          assert.ok(r.doc <= 320 && r.panel <= 0, `${tab}: no sideways scroll (${r.doc}, ${r.panel})`);
          if (tab === 'add') assert.equal(r.fieldsInside, true, 'Add manually fields inside the card');
          assert.ok(r.pillGap >= 8, `header padding (${r.pillGap})`);
        }
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('risky services (spec §12): Docker API and admin pages ask first, from Discover and Add manually', async () => {
      const risky = await designMock({
        dismissed: ['first-run'],
        services: [...DESIGN_SERVICES, svc(2375, 99, 'dockerd', 'Docker Engine API', null), svc(8081, 98, 'node', 'Router admin', '/Users/me/code/router')],
      });
      const page = await openApp(risky);
      try {
        await page.click('[data-assign-port="2375"]');
        await waitSel(page, '#assign-name');
        await page.key('Enter');
        await waitSel(page, '.dialog');
        assert.match(await text(page, '.dialog'), /Give docker\.local an address\? Anyone on this network could control Docker on this computer\./);
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
        await page.key('Escape');
        await waitGone(page, '.dialog');
        assert.equal(risky.adapter.calls.some((c) => c.method === 'addAlias'), false, 'nothing created on Cancel');
        await page.key('Enter');
        await waitSel(page, '.dialog');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'docker.local is ready.');
        await page.click('[data-assign-port="8081"]');
        await waitSel(page, '#assign-name');
        await page.key('Enter');
        await waitText(page, '.dialog', 'Anyone on this network could open Router admin, an admin page on this computer.');
        await page.key('Escape');
        await page.key('Escape');
        await goTab(page, 'add');
        await fill(page, '#add-port', '2376');
        await fill(page, '#add-name', 'docker-tls');
        await page.key('Enter');
        await waitText(page, '.dialog', 'Anyone on this network could control Docker on this computer.');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'docker-tls.local is ready.');
        assertClean(page);
      } finally {
        await page.close();
        await risky.close();
      }
    });

    test('setup dialog OS tabs: Tab reaches them; arrows, Home and End move the selection', async () => {
      const page = await openApp(mock, { tab: 'tools' });
      try {
        await page.click('[data-tool="setup"]');
        await waitSel(page, '.dialog');
        await clickText(page, '.dialog button', 'Start');
        await waitSel(page, '#os-tab-ios');
        await page.waitFor(() => document.activeElement?.id === 'os-tab-ios' || document.activeElement?.textContent === 'Done');
        await page.evaluate(() => document.querySelector('.dialog [data-autofocus]').focus());
        await page.key('Tab', { shift: true });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'os-panel', 'the steps panel is focusable');
        await page.key('Tab', { shift: true });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'os-tab-ios', 'Tab reaches the selected tab');
        await page.key('ArrowRight');
        await page.waitFor(() => document.activeElement.id === 'os-tab-android' && document.getElementById('os-panel').getAttribute('aria-labelledby') === 'os-tab-android');
        assert.match(await text(page, '#os-panel'), /Install a certificate/);
        await page.key('End');
        await page.waitFor(() => document.activeElement.id === 'os-tab-windows');
        await page.key('Home');
        await page.waitFor(() => document.activeElement.id === 'os-tab-ios');
        await page.key('ArrowLeft');
        await page.waitFor(() => document.activeElement.id === 'os-tab-windows');
        assert.equal(await page.evaluate(() => document.querySelector('.setup-tabs [role=tab][aria-selected=true]').id), 'os-tab-windows');
        // A stray click on the scrim doesn't end the setup.
        await page.clickAt(5, 5);
        await sleep(100);
        assert.ok(await exists(page, '.dialog'), 'still open after an outside click');
        await page.key('Escape');
        await toastText(page, 'Device setup closed.');
        assertClean(page);
      } finally {
        await page.close();
      }
    });

    test('live "taken" check while typing; app names block Create; stable button label and width while busy', async () => {
      const page = await openApp(mock, { tab: 'add' });
      try {
        await fill(page, '#add-port', '9500');
        await fill(page, '#add-name', 'recipes');
        await waitText(page, '#add-taken', 'recipes already points to port 5173.');
        assert.deepEqual(await page.evaluate(() => [document.getElementById('add-name').getAttribute('aria-describedby').split(' ').includes('add-taken'), document.getElementById('add-name').getAttribute('aria-invalid')]), [true, 'true'], 'the taken message is linked to the field');
        assert.ok(await exists(page, '#add-taken .btn-d'), 'Replace it offered before submitting');
        await fill(page, '#add-name', 'shop');
        await waitText(page, '#add-taken', 'shop is used by a running app.');
        assert.equal(await page.evaluate(() => document.querySelector('.add-card button[type=submit]').disabled), true);
        assert.equal(await exists(page, '#add-taken .btn-d'), false);
        await fill(page, '#add-name', 'fresh-name');
        await waitGone(page, '#add-taken');
        const before = await page.evaluate(() => document.querySelector('.add-card button[type=submit]').getBoundingClientRect().width);
        mock.adapter.delayMs = 600;
        await page.key('Enter');
        await page.waitFor(() => document.querySelector('.add-card button[type=submit]').getAttribute('aria-busy') === 'true');
        const during = await page.evaluate(() => ({ w: document.querySelector('.add-card button[type=submit]').getBoundingClientRect().width, t: document.querySelector('.add-card button[type=submit]').textContent }));
        mock.adapter.delayMs = 0;
        assert.equal(during.t, 'Create address');
        assert.ok(Math.abs(during.w - before) < 0.5, `width ${before} → ${during.w}`);
        await toastText(page, 'fresh-name.local is ready.');
        assertClean(page);
      } finally {
        mock.adapter.delayMs = 0;
        await page.close();
      }
    });

    test('errors stay inline: failed copy next to the chip, failed Undo above the table', async () => {
      const page = await openApp(mock, { tab: 'addresses' });
      try {
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
          document.execCommand = () => false;
        });
        await page.click('[data-copy="recipes.local"]');
        await waitText(page, '.chip-err', 'Couldn’t copy. Select the address and copy it yourself.');
        assert.equal(await exists(page, '.toast'), false);
        await page.click('button[aria-label="Remove fresh-name.local"]');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'Removed fresh-name.local.');
        mock.adapter.failNext('addAlias', new PortlessError('PORT_IN_USE', 'Port 9500 is in use.'));
        await clickText(page, '.toast button', 'Undo');
        await waitText(page, '.notice.n-error', 'Couldn’t bring back fresh-name.local.');
        assert.equal(await exists(page, '.toast'), false);
        await clickText(page, '.notice.n-error button', 'Try again');
        await toastText(page, 'fresh-name.local is back.');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
      }
    });

    test('Error routes get an inline notice with Retry (spec §8.3)', async () => {
      const errMock = await designMock({
        dismissed: ['first-run'],
        app: { probeRoute: async (port) => (port === 8888 ? { status: 'error', statusDetail: { httpStatus: 502, tls: false } } : designProbe(port)) },
      });
      const page = await openApp(errMock, { tab: 'addresses' });
      try {
        await waitText(page, '.notice', 'jupyter.local isn’t working: :8888 answered with error 502.');
        await clickText(page, '.notice button', 'Retry');
        await page.waitFor(() => document.querySelector('.notice .btn[aria-busy=true]') || errMock.adapter.calls, { what: 'busy' });
        await page.waitFor(() => !document.querySelector('.notice .btn[aria-busy=true]'));
        assert.ok(await exists(page, '.notice'));
        assertClean(page);
      } finally {
        await page.close();
        await errMock.close();
      }
    });

    test('host-check warning shows on the Discover row where the address was created (spec §7.10)', async () => {
      const hc = await designMock({
        dismissed: ['first-run'],
        app: { hostCheck: async ({ route }) => ({ result: 'host-blocked', ok: false, httpStatus: 403, framework: 'Vite', message: `Vite blocks requests for ${route.hostname}.`, fix: "Add server: { allowedHosts: ['.local'] } to vite.config.js, then restart the dev server.", checkedAt: new Date().toISOString() }) },
      });
      const page = await openApp(hc);
      try {
        await page.click('[data-assign-port="6006"]');
        await waitSel(page, '#assign-name');
        await page.key('Enter');
        await waitText(page, '.row[data-port="6006"] .row-notice', 'storybook.local works, but Vite blocked the name.');
        assertClean(page);
      } finally {
        await page.close();
        await hc.close();
      }
    });

    test('E10: Refresh forces a scan, new services are announced politely, "Updated" follows scannedAt, capabilities events apply without a re-fetch', async () => {
      const fresh = await designMock({ dismissed: ['first-run'], app: { intervals: { core: 300 } } });
      const page = await openApp(fresh);
      try {
        assert.match(await text(page, '[data-updated]'), /^Updated (a moment|\d+ seconds?) ago$/);
        fresh.discovery.services = [...DESIGN_SERVICES, svc(9999, 42, 'node', 'Fresh', '/Users/me/code/fresh')];
        await page.click('.sec-actions .btn');
        await waitSel(page, '[data-port="9999"]');
        assert.ok(page.requests.some((u) => u.endsWith('/api/services?refresh=1')), 'Refresh uses ?refresh=1');
        await page.waitFor(() => document.getElementById('announcer').textContent === 'New service on port 9999.', { what: 'announcement' });
        assert.equal(await page.evaluate(() => document.getElementById('announcer').getAttribute('aria-live')), 'polite');
        // capabilities: TLS off underneath → the setup card disappears from the event alone.
        await goTab(page, 'tools');
        assert.ok(await exists(page, '[data-tool="setup"]'));
        const stateCalls = page.requests.filter((u) => u.endsWith('/api/state')).length;
        fresh.adapter.proxy.tls = false;
        await waitGone(page, '[data-tool="setup"]');
        assert.equal(page.requests.filter((u) => u.endsWith('/api/state')).length, stateCalls, 'no /api/state re-fetch');
        fresh.adapter.proxy.tls = true;
        assertClean(page);
      } finally {
        await page.close();
        await fresh.close();
      }
    });

    test('toasts and dialog titles: addresses break only after "." or before ":"; toasts fit 360 px and the screen (iteration 5)', async () => {
      const LONG63 = 'b'.repeat(63);
      const m = await designMock({ dismissed: ['first-run'], adapter: { proxy: { ...HTTPS_PROXY, port: 46703, tls: false }, routes: [...DESIGN_ROUTES, { hostname: `${LONG63}.local`, port: 7003, pid: 0 }, { hostname: 'myportfoliowebsite.local', port: 7004, pid: 0 }] } });
      const page = await openApp(m, { tab: 'addresses', width: 1440, height: 900 });
      try {
        for (const w of [1440, 375, 320]) {
          await page.setViewport(w, 800);
          for (const host of ['myportfoliowebsite.local', `${LONG63}.local`]) {
            await page.evaluate(() => document.querySelectorAll('.toasts > *').forEach((t) => t.remove()));
            await page.evaluate((hh) => document.querySelector(`[data-copy="${hh}"]`).click(), host);
            await waitSel(page, '.toast .addr-vis');
            const t = await page.evaluate((src) => {
              const r = eval(`(${src})`)('.toast .addr-vis'); // eslint-disable-line no-eval
              const box = document.querySelector('.toast').getBoundingClientRect();
              return { bad: r.bad, width: box.width, right: box.right, left: box.left, vw: innerWidth };
            }, String(BREAKS));
            assert.deepEqual(t.bad, [], `${w}: toast for ${host.slice(0, 20)}`);
            assert.ok(t.width <= 360.5 && t.right <= t.vw && t.left >= 0, `${w}: toast inside 360 px and the screen (${JSON.stringify(t)})`);
            await page.evaluate((hh) => document.querySelector(`button[aria-label="Remove ${hh}"]`).click(), host);
            await waitSel(page, '.dialog h3 .addr-vis');
            const d = await page.evaluate((src) => eval(`(${src})`)('.dialog h3 .addr-vis'), String(BREAKS)); // eslint-disable-line no-eval
            assert.deepEqual(d.bad, [], `${w}: dialog title for ${host.slice(0, 20)}`);
            await page.key('Escape');
            await waitGone(page, '.dialog');
          }
        }
        assertClean(page);
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('assistive tech gets each address whole (accessibility tree), not the visual pieces', async () => {
      const m = await designMock({ dismissed: ['first-run'], adapter: { proxy: { ...HTTPS_PROXY, port: 46703, tls: false } } });
      const page = await openApp(m, { tab: 'addresses' });
      try {
        await page.click('[data-copy="dashboard.local"]');
        await waitSel(page, '.toast .addr-vis');
        await page.send('Accessibility.enable');
        const { nodes } = await page.send('Accessibility.getFullAXTree');
        const named = nodes.filter((n) => !n.ignored).map((n) => ({ role: n.role?.value, name: n.name?.value || '' }));
        const links = named.filter((n) => n.role === 'link' && /\.local/.test(n.name));
        assert.ok(links.length >= 4, 'address links present');
        for (const l of links) assert.match(l.name, /^[a-z0-9.-]+\.local(:\d+)?$/, `link name is the whole address: "${l.name}"`);
        assert.ok(links.some((l) => l.name === 'dashboard.local:46703'));
        const fragments = named.filter((n) => n.role === 'StaticText' && (/^[a-z0-9-]+\.$/.test(n.name) || n.name === 'local' || n.name === ':46703'));
        assert.deepEqual(fragments, [], 'no address fragments in the accessibility tree');
        assert.ok(named.some((n) => n.role === 'StaticText' && n.name.includes('http://dashboard.local:46703')), 'toast address read as one string');
        assertClean(page);
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('Discover keeps "ip:port" together in the reach note', async () => {
      const m = await designMock({ dismissed: ['first-run'], services: [...DESIGN_SERVICES, { ...svc(8765, 90, 'python3', 'Open one', '/Users/me/x'), reach: 'network', addresses: ['0.0.0.0'] }] });
      const page = await openApp(m, { width: 360, height: 800, mobile: true });
      try {
        const r = await page.evaluate(() => {
          const span = [...document.querySelectorAll('.row-meta .nowrap')].find((x) => x.textContent === '192.168.1.42:8765');
          return span ? span.getClientRects().length : null;
        });
        assert.equal(r, 1, 'ip:port on one line');
        assertClean(page);
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('toasts never cover the active form (N6: Create address near the bottom of the window)', async () => {
      const many = Array.from({ length: 10 }, (_, i) => svc(7100 + i, 500 + i, 'node', `Service ${i}`, `/Users/me/code/s${i}`));
      const tm = await designMock({ services: [...DESIGN_SERVICES, ...many] }); // first-run banner stays up
      const page = await openApp(tm, { width: 1440, height: 900 });
      try {
        await page.evaluate(() => { const b = document.querySelector('[data-assign-port="7109"]'); b.scrollIntoView({ block: 'end' }); });
        await sleep(100);
        await page.click('[data-assign-port="7109"]');
        await waitSel(page, '#assign-name');
        await page.evaluate(() => document.querySelector('.expanded').scrollIntoView({ block: 'end' }));
        await sleep(100);
        await page.evaluate(() => document.querySelector('[data-copy="recipes.local"]').click());
        await toastText(page, 'Copied https://recipes.local');
        const r = await page.evaluate(() => {
          const t = document.querySelector('.toast').getBoundingClientRect();
          const c = document.querySelector('.assign button[type=submit]').getBoundingClientRect();
          const b = document.querySelector('.banner').getBoundingClientRect();
          return { overlap: t.left < c.right && t.right > c.left && t.top < c.bottom && t.bottom > c.top, createBottom: c.bottom, vh: innerHeight, belowBanner: t.top >= b.bottom };
        });
        assert.equal(r.belowBanner, true, 'moved toasts sit below the header and the banner');
        assert.ok(r.createBottom > r.vh - 200, `the form sits near the bottom (${r.createBottom})`);
        assert.equal(r.overlap, false, 'the toast doesn’t cover Create address');
        assertClean(page);
      } finally {
        await page.close();
        await tm.close();
      }
    });

    test('keep-after-restart off on a service-managed Mac: confirm first, password phases and failure inline, no crash banner during the job (F1)', async () => {
      let release = () => {};
      let gate = Promise.resolve();
      const arm = () => { gate = new Promise((r) => { release = r; }); };
      const m = await startMockApi({ scenario: 'mac-service', onElevate: () => gate });
      const page = await openApp(m, { tab: 'sharing' });
      try {
        await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]')?.getAttribute('aria-checked') === 'true');
        // Cancel: nothing changes.
        await page.click('.sw[aria-labelledby="set-keep"]');
        await waitSel(page, '.dialog');
        assert.equal(await text(page, '.dialog h3'), 'Stop starting sharing automatically?');
        assert.equal(await text(page, '.dialog p'), 'Nidum Local will remove the startup service and keep sharing running until you restart this computer. Your computer may ask for your password twice.');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
        assert.equal(await text(page, '.dialog [data-confirm]'), 'Turn off');
        assert.ok(await page.evaluate(() => document.querySelector('.dialog [data-confirm]').classList.contains('btn-p')));
        await page.key('Escape');
        await waitGone(page, '.dialog');
        assert.equal(m.adapter.calls.some((c) => c.method === 'serviceUninstall'), false, 'Cancel changes nothing');
        assert.equal(await page.evaluate(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked')), 'true');
        // Turn off: the password phase shows at the switch; no crash banner while the job runs.
        arm();
        await page.click('.sw[aria-labelledby="set-keep"]');
        await page.click('.dialog [data-confirm]');
        await waitText(page, '.set-row .pwd-note', 'Your computer is asking for your password in a separate window.');
        await waitText(page, 'header .pill', 'Waiting for your password…');
        assert.equal(await exists(page, '[data-banner="sharing-off"]'), false, 'no crash banner during the job');
        release();
        await toastText(page, 'Sharing won’t start automatically any more.', 15_000);
        assert.ok(m.adapter.calls.some((c) => c.method === 'serviceUninstall'));
        assert.equal(await page.evaluate(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked')), 'false');
        assertClean(page, { allowApi: true });
      } finally {
        release();
        await page.close();
        await m.close();
      }
    });

    test('keep-after-restart off: a failed service job shows inline at the switch and reverts it (F1)', async () => {
      const m = await startMockApi({ scenario: 'mac-service' });
      const page = await openApp(m, { tab: 'sharing' });
      try {
        await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]')?.getAttribute('aria-checked') === 'true');
        m.adapter.failNext('serviceUninstall', new PortlessError('PERMISSION', 'User cancelled'));
        await page.click('.sw[aria-labelledby="set-keep"]');
        await page.click('.dialog [data-confirm]');
        await waitText(page, '.set-row .notice', 'Password not entered. Nothing changed.', 15_000);
        await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked') === 'true', { what: 'reverted' });
        assert.equal(await exists(page, '[data-banner="sharing-off"]'), false);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('D43/E12: pause and resume a service-managed Mac (password phase, paused banner, resume, cancelled password)', async () => {
      let release = () => {};
      let gate = Promise.resolve();
      const arm = () => { gate = new Promise((r) => { release = r; }); };
      const m = await startMockApi({ scenario: 'mac-service', onElevate: () => gate });
      const page = await openApp(m, { tab: 'sharing' });
      try {
        await page.waitFor(() => !document.querySelector('header [data-action="pause"]').disabled, { what: 'Pause enabled for a service-managed proxy' });
        assert.equal(await exists(page, '#pause-reason'), false, 'no "kept on by the startup service" reason');
        // Pause: confirm copy, password phase, then the paused banner.
        arm();
        await page.click('header [data-action="pause"]');
        await waitSel(page, '.dialog');
        assert.equal(await text(page, '.dialog'), 'Pause sharing? Your addresses go offline until you resume or restart this computer. Cancel Pause sharing');
        await page.click('.dialog [data-confirm]');
        await waitText(page, 'header .pill', 'Waiting for your password…');
        await waitText(page, 'header [data-action="pause"]', 'Waiting for your password…');
        assert.equal(await exists(page, '[data-banner="sharing-off"]'), false, 'no crash banner during the job');
        release();
        await waitSel(page, '[data-banner="sharing-paused"]', 15_000);
        await waitText(page, 'header .pill', 'Paused');
        await waitText(page, 'header [data-action="pause"]', 'Resume sharing');
        assert.equal(await page.evaluate(() => document.title), 'Nidum Local');
        // Resume.
        arm();
        await page.click('header [data-action="pause"]');
        await waitText(page, 'header .pill', 'Waiting for your password…');
        release();
        await waitText(page, 'header .pill', 'Sharing on', 15_000);
        await waitGone(page, '[data-banner="sharing-paused"]');
        // Cancelled password: the error shows where it happened, and sharing stays on.
        const method = typeof m.adapter.stopService === 'function' ? 'stopService' : 'stopProxy';
        m.adapter.failNext(method, new PortlessError('PERMISSION', 'User cancelled'));
        await page.click('header [data-action="pause"]');
        await page.click('.dialog [data-confirm]');
        await waitText(page, '.banner[role=alert]', "Couldn't pause sharing. Password not entered. Nothing changed.", 15_000);
        assert.equal(await text(page, 'header [data-action="pause"]'), 'Pause sharing');
        await page.click('.banner button[aria-label="Dismiss"]');
        await waitText(page, 'header .pill', 'Sharing on');
        assertClean(page, { allowApi: true });
      } finally {
        release();
        await page.close();
        await m.close();
      }
    });

    test('D45 and D50 while paused: keep-off copy keeps the pause (one password), removal toast; Apply and keep-on ask before turning sharing back on', async () => {
      const m = await startMockApi({ scenario: 'mac-service' });
      const page = await openApp(m, { tab: 'sharing' });
      const pause = async () => {
        await page.click('header [data-action="pause"]');
        await page.click('.dialog [data-confirm]');
        await waitSel(page, '[data-banner="sharing-paused"]', 15_000);
        await waitText(page, 'header [data-action="pause"]', 'Resume sharing');
      };
      const calls = (name) => m.adapter.calls.filter((c) => c.method === name).length;
      try {
        await page.waitFor(() => !document.querySelector('header [data-action="pause"]').disabled, { what: 'Pause enabled' });
        await pause();
        // D50: a changed setting while paused; Apply asks first, Cancel is focused and changes nothing.
        await page.click('.sw[aria-labelledby="set-sub"]');
        await waitText(page, '[data-strip="service"]', 'The startup service still uses your old settings.');
        await clickText(page, '[data-strip="service"] button', 'Apply');
        await waitSel(page, '.dialog');
        assert.equal(await text(page, '.dialog h3'), 'Apply and turn sharing back on?');
        assert.equal(await text(page, '.dialog p'), 'Your addresses come back online.');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
        assert.equal(await text(page, '.dialog [data-confirm]'), 'Apply');
        await page.key('Escape');
        await waitGone(page, '.dialog');
        assert.equal(calls('serviceInstall'), 0, 'Cancel runs nothing');
        assert.equal(await exists(page, '[data-banner="sharing-paused"]'), true, 'still paused');
        await clickText(page, '[data-strip="service"] button', 'Apply');
        await page.click('.dialog [data-confirm]');
        await waitText(page, 'header .pill', 'Sharing on', 15_000);
        assert.equal(calls('serviceInstall'), 1);
        await waitGone(page, '[data-banner="sharing-paused"]');
        // D45: turning keep-after-restart off while paused: the pause stays, one password, the right toast.
        await pause();
        await page.click('.sw[aria-labelledby="set-keep"]');
        await waitSel(page, '.dialog');
        assert.equal(await text(page, '.dialog h3'), 'Stop starting sharing automatically?');
        assert.equal(await text(page, '.dialog p'), 'Nidum Local will remove the startup service. Sharing stays paused until you resume it. Your computer will ask for your password.');
        const starts = calls('startProxy') + calls('startService');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'Sharing won’t start automatically any more.', 15_000);
        assert.equal(calls('serviceUninstall'), 1);
        assert.equal(calls('startProxy') + calls('startService'), starts, 'sharing is not started again');
        await waitSel(page, '[data-banner="sharing-paused"]');
        assert.equal(await text(page, 'header .pill'), 'Paused');
        // Turning it back on would install the service and resume sharing: ask first; Esc changes nothing.
        await page.waitFor(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked') === 'false' && !document.querySelector('.sw[aria-labelledby="set-keep"]').disabled);
        await page.click('.sw[aria-labelledby="set-keep"]');
        await waitSel(page, '.dialog');
        assert.equal(await text(page, '.dialog h3'), 'Turn sharing back on?');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
        await page.key('Escape');
        await waitGone(page, '.dialog');
        assert.equal(await page.evaluate(() => document.querySelector('.sw[aria-labelledby="set-keep"]').getAttribute('aria-checked')), 'false');
        assert.equal(calls('serviceInstall'), 1, 'Cancel installs nothing');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('keyboard focus returns to the sharing control after a pause or resume job; a failed resume says "resume"', async () => {
      const fx = await designMock({ dismissed: ['first-run'], adapter: { delayMs: 300 } });
      const page = await openApp(fx, { tab: 'sharing' });
      // Enter on the focused Pause button. The confirm shows only while an address is live (it may not be
      // yet right after a resume, while the probes run again); when it shows, Tab to Pause sharing and Enter.
      const pauseByKeyboard = async () => {
        await page.key('Enter');
        const r = await page.waitFor(() => (document.querySelector('.dialog') ? 'dialog' : /Pausing|Paused|Waiting/.test(document.querySelector('header .pill')?.textContent || '') ? 'job' : null), { what: 'confirm or pause job' });
        if (r === 'dialog') {
          await page.waitFor(() => document.activeElement?.textContent === 'Cancel', { what: 'Cancel focused' });
          await page.key('Tab');
          await page.key('Enter');
        }
      };
      try {
        // Pause from the card with the keyboard: confirm (Cancel focused) → Tab → Enter.
        await page.evaluate(() => document.querySelector('main [data-action="pause"]').focus());
        await pauseByKeyboard();
        await waitText(page, 'header .pill', 'Paused', 15_000);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'card-pause', { what: 'focus back on the card button after pausing' });
        assert.equal(await text(page, 'main [data-action="pause"]'), 'Resume sharing');
        // Resume with Enter on the same (re-rendered) control.
        await page.key('Enter');
        await waitText(page, 'header .pill', 'Sharing on', 15_000);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'card-pause', { what: 'focus back after resuming' });
        // Resume from the banner: the banner goes away, so focus moves to its replacement.
        await pauseByKeyboard();
        await waitSel(page, '[data-fk="banner-resume"]', 15_000);
        await page.waitFor(() => !document.querySelector('[data-fk="banner-resume"]').disabled);
        await page.evaluate(() => document.querySelector('[data-fk="banner-resume"]').focus());
        await page.key('Enter');
        await waitText(page, 'header .pill', 'Sharing on', 15_000);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'card-pause', { what: 'focus on the replacement (the card button)' });
        // A failed resume: "Couldn't resume sharing." (validation 6, finding 6).
        await pauseByKeyboard();
        await waitText(page, 'header .pill', 'Paused', 15_000);
        fx.adapter.failNext('startProxy', new PortlessError('PERMISSION', 'User cancelled'));
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'card-pause');
        await page.key('Enter');
        await waitText(page, '.banner[role=alert]', "Couldn't resume sharing. Password not entered. Nothing changed.", 15_000);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'card-pause', { what: 'focus back after a failed resume' });
        await clickText(page, '.banner button', 'Try again');
        await waitText(page, 'header .pill', 'Sharing on', 15_000);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await fx.close();
      }
    });

    test('Discover before the first scan: "Looking for services…" and no count, never "Nothing is running yet." (validation 6, finding 5)', async () => {
      let release = () => {};
      const gate = new Promise((r) => { release = r; });
      const discovery = createFakeDiscovery(DESIGN_SERVICES);
      const scan = discovery.scan.bind(discovery);
      discovery.scan = async (o) => { await gate; return scan(o); };
      const fx = await designMock({ dismissed: ['first-run'], discovery });
      const page = await openApp(fx, { tab: 'discover' });
      try {
        // Sample the page for a while: the empty state and a 0 count must never show before the scan.
        const seen = await page.evaluate(async () => {
          const out = { empty: false, count: false, scanning: 0 };
          for (let i = 0; i < 20; i += 1) {
            if (document.querySelector('main .empty')) out.empty = true;
            if (document.querySelector('#tab-discover .nav-count')) out.count = true;
            if (document.querySelector('[data-scanning]')?.textContent.includes('Looking for services…')) out.scanning += 1;
            await new Promise((r) => setTimeout(r, 50));
          }
          return out;
        });
        assert.deepEqual(seen, { empty: false, count: false, scanning: 20 });
        assert.equal(await page.evaluate(() => document.querySelector('[data-scanning]').getAttribute('aria-busy')), 'true');
        release();
        await waitSel(page, '[data-port="6006"]', 15_000);
        await waitGone(page, '[data-scanning]');
        assert.equal(await text(page, '#tab-discover .nav-count'), String(await page.evaluate(() => document.querySelectorAll('main [data-port]').length)));
        assertClean(page);
      } finally {
        release();
        await page.close();
        await fx.close();
      }
    });

    test('fixed address offers only unicast IPv4 addresses this computer lists (D27)', async () => {
      const net = { ip: '192.168.1.42', interface: 'en0', kind: 'wifi', ssid: 'HomeWiFi', interfaces: [{ name: 'en0', ip: '192.168.1.42', kind: 'wifi' }, { name: 'lo0', ip: '127.0.0.1', kind: 'other' }, { name: 'en5', ip: '10.0.0.7', kind: 'ethernet' }, { name: 'x', ip: '224.0.0.251', kind: 'other' }] };
      const fx = await designMock({ dismissed: ['first-run'], network: net });
      const page = await openApp(fx, { tab: 'sharing' });
      try {
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#fixed-ip option')].map((o) => o.value)), ['192.168.1.42', '10.0.0.7']);
        assertClean(page);
      } finally {
        await page.close();
        await fx.close();
      }
    });

    test('Apply strip whenever settings.serviceReinstallNeeded (manual proxy, keep-after-restart on)', async () => {
      const ap = await designMock({ dismissed: ['first-run'] });
      const page = await openApp(ap, { tab: 'sharing' });
      try {
        await waitText(page, '[data-strip="service"]', 'the startup service isn’t set up yet');
        await clickText(page, '[data-strip="service"] button', 'Apply');
        await toastText(page, 'The startup service now uses your settings.');
        await waitGone(page, '[data-strip="service"]');
        assert.ok(ap.adapter.calls.some((c) => c.method === 'serviceInstall'));
        assertClean(page);
      } finally {
        await page.close();
        await ap.close();
      }
    });
  });
  describe('8 · E13: a locked or not-writable address list (D47, D48, D51)', () => {
    const LOCKED = 'Your address list is locked, so addresses can\'t be added, changed or removed.';
    const R_LOCKED = 'Your address list is locked.';
    const R_NOT_WRITABLE = "Nidum Local isn't allowed to change your address list.";
    const fixText = (page) => text(page, '[data-banner] .routes-fix');
    const cmds = (page) => page.evaluate(() => [...document.querySelectorAll('[data-banner] [data-copy-cmd]')].map((b) => b.getAttribute('data-copy-cmd')));

    /** Every route-changing control is disabled and points at the visible reason (or none is). */
    async function assertBlocked(page, reason) {
      await goTab(page, 'discover');
      await waitSel(page, '[data-assign-port]', 15_000);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-assign-port]')].map((b) => [b.disabled, b.getAttribute('aria-describedby')])).then((l) => [...new Set(l.map(String))]), [reason ? 'true,routes-reason-d' : 'false,']);
      if (reason) assert.equal(await text(page, '#routes-reason-d'), reason);
      else assert.equal(await exists(page, '#routes-reason-d'), false);
      await goTab(page, 'add');
      await fill(page, '#add-port', '9100');
      await fill(page, '#add-name', 'locked-test');
      assert.equal(await page.evaluate(() => document.querySelector('.add-card button[type=submit]').disabled), Boolean(reason));
      if (reason) assert.equal(await text(page, '#routes-reason-add'), reason);
      await fill(page, '#add-port', '');
      await fill(page, '#add-name', '');
      await goTab(page, 'addresses');
      const acts = await page.evaluate(() => [...document.querySelectorAll('main [aria-label^="Change port of"], main [aria-label^="Rename"], main [aria-label^="Remove"]')].map((b) => b.disabled));
      assert.ok(acts.length >= 3, 'address actions exist');
      assert.deepEqual([...new Set(acts)], [Boolean(reason)]);
      if (reason) assert.equal(await text(page, '#routes-reason-a'), reason);
    }

    test('routes-locked (uchg on routes.json): banner with Finder steps and a copyable command, actions disabled with the reason; Check again unlocks', async () => {
      const m = await startMockApi({ scenario: 'routes-locked' });
      const page = await openApp(m, { tab: 'discover' });
      try {
        await waitSel(page, '[data-banner="routes-locked"][role=alert]', 15_000);
        assert.equal(await text(page, '[data-banner="routes-locked"] .banner-text'), LOCKED);
        assert.equal(await fixText(page), 'In Finder, choose Go → Go to Folder…, enter /Users/me/.portless, select routes.json, choose File → Get Info, and uncheck Locked. Or in Terminal: chflags -- nouchg /Users/me/.portless/routes.json Copy');
        assert.deepEqual(await cmds(page), ['chflags -- nouchg /Users/me/.portless/routes.json']);
        assert.equal(await page.evaluate(() => document.title), '(!) Nidum Local');
        assert.equal(await exists(page, '[data-banner="routes-locked"] button[aria-label="Dismiss"]'), false, 'not dismissible');
        // Copy copies the exact command.
        await page.click('[data-banner] [data-copy-cmd]');
        await toastText(page, 'Copied the command.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'chflags -- nouchg /Users/me/.portless/routes.json');
        await clearToasts(page);
        await assertBlocked(page, R_LOCKED);
        // Check again while still locked: busy, then "Nothing has changed yet.", focus stays on the button.
        await page.evaluate(() => document.querySelector('[data-fk="routes-check"]').focus());
        await page.key('Enter');
        await waitText(page, '[data-banner="routes-locked"]', 'Nothing has changed yet.', 15_000);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'routes-check', { what: 'focus back on Check again' });
        // The user unlocks it; Check again (GET /api/state?refresh=1) clears the banner.
        m.adapter.unlockRoutes();
        await page.evaluate(() => { window.__stateReqs = performance.getEntriesByType('resource').filter((e) => /\/api\/state\?refresh=1/.test(e.name)).length; });
        await page.click('[data-fk="routes-check"]');
        await page.waitFor(() => document.querySelector('[data-fk="routes-check"]')?.getAttribute('aria-busy') === 'true' || !document.querySelector('[data-banner="routes-locked"]'), { what: 'Check again busy' });
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        await toastText(page, 'Your address list can be changed again.');
        assert.ok(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/api\/state\?refresh=1/.test(e.name)).length > window.__stateReqs), 'Check again asked for ?refresh=1');
        await clearToasts(page);
        await assertBlocked(page, null);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('routes-locked-schg: Terminal only, sudo chflags noschg, and it asks for the password', async () => {
      const m = await startMockApi({ scenario: 'routes-locked-schg' });
      const page = await openApp(m, { tab: 'discover' });
      try {
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        assert.equal(await fixText(page), 'Only Terminal can clear this lock: sudo chflags -- noschg /Users/me/.portless/routes.json Copy Terminal asks for this computer’s password.');
        assert.deepEqual(await cmds(page), ['sudo chflags -- noschg /Users/me/.portless/routes.json']);
        await page.click('[data-banner] [data-copy-cmd]');
        await toastText(page, 'Copied the command.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'sudo chflags -- noschg /Users/me/.portless/routes.json');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('folder target and routes-not-writable (owner known, owner unknown, ownedByYou stubbed)', async () => {
      const m = await startMockApi({ scenario: 'routes-locked' });
      const page = await openApp(m, { tab: 'discover' });
      const check = async (id) => {
        await page.click('[data-fk="routes-check"]');
        await waitSel(page, `[data-banner="${id}"]`, 15_000);
        await page.waitFor(() => !document.querySelector('[data-fk="routes-check"]')?.disabled, { what: 'check finished' });
      };
      try {
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        // The lock is on the folder: the same steps, applied to the folder.
        m.adapter.lockRoutes({ flag: 'uchg', target: 'folder' });
        await check('routes-locked');
        // Finder hides ".portless": show hidden items first (validation 7, finding 4).
        await waitText(page, '[data-banner] .routes-fix', 'enter /Users/me, press Command-Shift-Period (⌘⇧.) to show hidden items, select .portless, choose File → Get Info');
        assert.deepEqual(await cmds(page), ['chflags -- nouchg /Users/me/.portless']);
        // The problem changed kind (file → folder): the note says so, never "Nothing has changed yet."
        await waitText(page, '[data-banner="routes-locked"]', 'That changed something, but your address list is still blocked.');
        assert.equal((await text(page, '[data-banner="routes-locked"]')).includes('Nothing has changed yet.'), false);
        // Not writable, owned by another account.
        m.adapter.unlockRoutes();
        m.adapter.setRoutesWritable(false, { owner: 'root' });
        await check('routes-not-writable');
        assert.equal(await text(page, '[data-banner="routes-not-writable"] .banner-text'), "Nidum Local isn't allowed to change your address list.");
        await waitText(page, '[data-banner] .routes-fix', 'The file belongs to another account (root). To fix it, run this in Terminal:');
        assert.deepEqual(await cmds(page), ['sudo chown -- "$USER" /Users/me/.portless/routes.json']);
        await page.click('[data-banner] [data-copy-cmd]');
        await toastText(page, 'Copied the command.');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'sudo chown -- "$USER" /Users/me/.portless/routes.json');
        await clearToasts(page);
        await assertBlocked(page, R_NOT_WRITABLE);
        // D51: ownedByYou (not in the mock yet): stub it into the state answer of Check again.
        await page.evaluate(() => {
          const f = window.fetch;
          window.fetch = async (u, o) => {
            const res = await f(u, o);
            if (!String(u).includes('/api/state?refresh=1')) return res;
            const j = await res.json();
            if (j.routesAccess) j.routesAccess.ownedByYou = true;
            for (const b of j.banners) if (b.details) b.details.ownedByYou = true;
            return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
          };
        });
        await check('routes-not-writable');
        await waitText(page, '[data-banner] .routes-fix', "This file's permissions don't allow changes. To fix it, run this in Terminal:");
        assert.deepEqual(await cmds(page), ['chmod -- u+rw /Users/me/.portless/routes.json']);
        assert.equal((await fixText(page)).includes('password'), false, 'chmod needs no password');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('stale state: a 423 ROUTES_LOCKED answer shows inline with the same explanation; client.js maps neither code', async () => {
      const m = await startMockApi({ scenario: 'mac-service', app: { intervals: { core: 600_000, services: 600_000 } } });
      const page = await openApp(m, { tab: 'add' });
      try {
        assert.equal(await exists(page, '[data-banner="routes-locked"]'), false);
        // client.js passes the server's message through for both codes (no FRIENDLY text).
        assert.deepEqual(await page.evaluate(async () => {
          const c = await import('/client.js');
          return ['ROUTES_LOCKED', 'ROUTES_NOT_WRITABLE'].map((code) => c.errorText(new c.ApiError(code, `server text ${code}`)));
        }), ['server text ROUTES_LOCKED', 'server text ROUTES_NOT_WRITABLE']);
        m.adapter.lockRoutes(); // the page doesn't know yet
        await fill(page, '#add-port', '9100');
        await fill(page, '#add-name', 'stale');
        await page.click('.add-card button[type=submit]');
        await waitText(page, '.add-card #add-taken', "Your address list is locked, so Nidum Local can't change it.", 15_000);
        await waitText(page, '.add-card .routes-fix', 'chflags -- nouchg');
        assert.equal(await text(page, '.add-card #add-taken').then((t) => /Password not entered/.test(t)), false, 'never the PERMISSION text');
        // The server re-reads the lock after the refusal: the banner follows and Create is disabled.
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        await page.waitFor(() => document.querySelector('.add-card button[type=submit]').disabled, { what: 'Create disabled' });
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    /** Ask the server to re-read the lock now (its state event updates the page); never touches focus. */
    const refreshAccess = (page) => page.evaluate(() => fetch('/api/state?refresh=1').then((r) => r.status));
    const bannerIds = (page) => page.evaluate(() => [...document.querySelectorAll('.banners > .banner')].map((b) => b.getAttribute('data-banner')));

    test('D59(a), V7-5: a lock on another account\'s file gets sudo; without target the copy fits a file or a folder', async () => {
      const m = await startMockApi({ scenario: 'routes-locked' });
      const page = await openApp(m, { tab: 'discover' });
      const check = async () => {
        await page.click('[data-fk="routes-check"]');
        await page.waitFor(() => document.querySelector('[data-fk="routes-check"]')?.getAttribute('aria-busy') !== 'true', { what: 'check finished' });
      };
      try {
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        // uchg on root's file: Terminal with sudo, and the password line.
        m.adapter.lockRoutes({ flag: 'uchg', target: 'file', owner: 'root', ownedByYou: false });
        await check();
        await waitText(page, '[data-banner] .routes-fix', 'The file belongs to another account (root), so only an administrator can unlock it.');
        assert.equal(await fixText(page), 'The file belongs to another account (root), so only an administrator can unlock it. To fix it, run this in Terminal: sudo chflags -- nouchg /Users/me/.portless/routes.json Copy Terminal asks for this computer’s password.');
        assert.deepEqual(await cmds(page), ['sudo chflags -- nouchg /Users/me/.portless/routes.json']);
        // Owner unknown (ownedByYou null): Finder steps, and the Terminal command with sudo.
        m.adapter.lockRoutes({ flag: 'uchg', target: 'file', owner: null, ownedByYou: null });
        await check();
        await waitText(page, '[data-banner] .routes-fix', 'sudo chflags -- nouchg');
        assert.equal(await fixText(page), 'In Finder, choose Go → Go to Folder…, enter /Users/me/.portless, select routes.json, choose File → Get Info, and uncheck Locked. Or in Terminal: sudo chflags -- nouchg /Users/me/.portless/routes.json Copy Terminal asks for this computer’s password.');
        // No target (an older adapter, or N3's null): the item is named, never called a file or a folder
        // from its path. A file inside routes.lock used to be called a folder.
        await page.evaluate(() => {
          const f = window.fetch;
          window.fetch = async (u, o) => {
            const res = await f(u, o);
            if (!String(u).includes('/api/state?refresh=1')) return res;
            const j = await res.json();
            const patchIt = (d) => { if (d) { d.target = null; d.path = '/Users/me/.portless/routes.lock/pid'; d.ownedByYou = true; d.owner = 'me'; } };
            patchIt(j.routesAccess);
            for (const b of j.banners) patchIt(b.details);
            return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
          };
        });
        m.adapter.unlockRoutes();
        m.adapter.setRoutesWritable(false, { owner: 'me', ownedByYou: true, target: 'folder' });
        await check();
        await waitText(page, '[data-banner="routes-not-writable"] .routes-fix', 'The permissions on pid don\'t allow changes.');
        assert.equal(await fixText(page), 'The permissions on pid don\'t allow changes. To fix it, run this in Terminal: chmod -- u+rwX /Users/me/.portless/routes.lock/pid Copy');
        assert.equal(await page.evaluate(() => document.querySelector('[data-banner] .routes-fix').getAttribute('data-target')), 'unknown');
        assert.equal(/\b(file|folder)\b/.test(await fixText(page)), false, 'neither "file" nor "folder" is guessed');
        // The same with a lock and no owner facts: Finder steps name the item; sudo for the command.
        await page.evaluate(() => {
          const f = window.fetch;
          window.fetch = async (u, o) => {
            const res = await f(u, o);
            if (!String(u).includes('/api/state?refresh=1')) return res;
            const j = await res.json();
            for (const d of [j.routesAccess, ...j.banners.map((b) => b.details)]) if (d) d.ownedByYou = null;
            return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
          };
        });
        m.adapter.setRoutesWritable(true);
        m.adapter.lockRoutes({ flag: 'uchg', target: 'file' });
        await check();
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        await waitText(page, '[data-banner] .routes-fix', 'enter /Users/me/.portless/routes.lock, select pid, choose File → Get Info');
        assert.deepEqual(await cmds(page), ['sudo chflags -- nouchg /Users/me/.portless/routes.lock/pid']);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('focus in Add manually and the Discover search survives a banner arriving, changing and clearing; <main> never moves (validation 7, finding 2)', async () => {
      const fx = await designMock({ dismissed: [] }); // the first-run banner is up
      const page = await openApp(fx, { tab: 'add' });
      const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.localName);
      try {
        await waitSel(page, '[data-banner="first-run"]', 15_000);
        await page.evaluate(() => {
          window.__mainMoved = 0;
          window.__blurs = 0;
          new MutationObserver((list) => {
            for (const r of list) for (const n of r.removedNodes) if (n.localName === 'main') window.__mainMoved += 1;
          }).observe(document.querySelector('.main-col'), { childList: true });
          // The two fields under test never lose focus to nothing (clicking "Got it" may).
          document.addEventListener('focusout', (e) => { if (!e.relatedTarget && ['add-name', 'search'].includes(e.target.id)) window.__blurs += 1; }, true);
        });
        await fill(page, '#add-name', 'keep');
        // A lock arrives: the first-run banner gives way to the lock banner (a different keyed banner).
        fx.adapter.lockRoutes();
        await refreshAccess(page);
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        assert.deepEqual(await bannerIds(page), ['routes-locked']);
        assert.equal(await focused(), 'add-name');
        await page.insertText('-on');
        assert.equal(await page.evaluate(() => document.getElementById('add-name').value), 'keep-on');
        // The lock clears (another client, or a scan): the first-run banner comes back; focus stays.
        fx.adapter.unlockRoutes();
        await refreshAccess(page);
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        await waitSel(page, '[data-banner="first-run"]');
        assert.equal(await focused(), 'add-name');
        await fill(page, '#add-name', '');
        // The Discover search, with no banner at all before the lock.
        await clickText(page, '[data-banner="first-run"] button', 'Got it');
        await waitGone(page, '[data-banner="first-run"]', 15_000);
        await goTab(page, 'discover');
        await page.evaluate(() => document.getElementById('search').focus());
        await page.insertText('stor');
        fx.adapter.lockRoutes();
        await refreshAccess(page);
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        assert.equal(await focused(), 'search');
        fx.adapter.unlockRoutes();
        await refreshAccess(page);
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        assert.equal(await focused(), 'search');
        await page.insertText('y');
        assert.equal(await page.evaluate(() => document.getElementById('search').value), 'story');
        assert.deepEqual(await page.evaluate(() => [window.__mainMoved, window.__blurs]), [0, 0], '<main> never moved and nothing lost focus');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await fx.close();
      }
    });

    test('D59(d): a lock never hides the sharing state: stopped or paused shows first, the lock banner under it', async () => {
      const m = await startMockApi({ scenario: 'stopped' });
      const page = await openApp(m, { tab: 'discover' });
      try {
        await waitSel(page, '[data-banner="sharing-off"]', 15_000);
        m.adapter.lockRoutes();
        await refreshAccess(page);
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        // Whatever order the server sends, the page shows sharing first, then the lock (never more than two).
        assert.deepEqual(await bannerIds(page), ['sharing-off', 'routes-locked']);
        assert.equal(await text(page, 'header .pill'), 'Needs attention');
        await page.click('header button.pill');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'page-banner');
        assert.equal(await page.evaluate(() => document.querySelector('[data-banner="routes-locked"] .banner-text').id), 'page-banner-routes-locked');
        // Sharing back on: only the lock banner, which is now the top one.
        await clickText(page, '[data-banner="sharing-off"] button', 'Start again');
        await waitGone(page, '[data-banner="sharing-off"]', 15_000);
        await page.waitFor(() => document.querySelectorAll('.banners > .banner').length === 1, { what: 'one banner' });
        assert.deepEqual(await bannerIds(page), ['routes-locked']);
        // Paused: the paused banner first, the lock under it; the pill says Paused, the title keeps (!).
        await page.click('header [data-action="pause"]');
        await page.waitFor(() => document.querySelector('.dialog [data-confirm]') || /Pausing|Paused/.test(document.querySelector('header .pill').textContent), { what: 'pause confirm or job' });
        if (await exists(page, '.dialog [data-confirm]')) await page.click('.dialog [data-confirm]');
        await waitSel(page, '[data-banner="sharing-paused"]', 15_000);
        assert.deepEqual(await bannerIds(page), ['sharing-paused', 'routes-locked']);
        await waitText(page, 'header .pill', 'Paused', 15_000);
        assert.equal(await page.evaluate(() => document.title), '(!) Nidum Local');
        // The lock banner keeps its own Check again.
        m.adapter.unlockRoutes();
        await page.click('[data-banner="routes-locked"] [data-fk="routes-check"]');
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        assert.deepEqual(await bannerIds(page), ['sharing-paused']);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await m.close();
      }
    });

    test('D59(c): Replace it, the failed-Undo Try again and Reset Portless are disabled with the same visible reason while blocked', async () => {
      const fx = await designMock({ dismissed: ['first-run'] });
      const page = await openApp(fx, { tab: 'addresses' });
      const shown = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return Boolean(el && el.getClientRects().length && el.offsetHeight > 0); }, sel);
      try {
        // A failed Undo, before the lock.
        await ensureRoute(page, 'undo-me', 9501);
        await page.click('button[aria-label="Remove undo-me.local"]');
        await page.click('.dialog [data-confirm]');
        await toastText(page, 'Removed undo-me.local.');
        fx.adapter.failNext('addAlias', new PortlessError('PORT_IN_USE', 'Port 9501 is in use.'));
        await clickText(page, '.toast button', 'Undo');
        await waitText(page, '.notice.n-error', 'Couldn’t bring back undo-me.local.');
        await clearToasts(page);
        assert.equal(await page.evaluate(() => document.querySelector('[data-undo-retry]').disabled), false);
        fx.adapter.lockRoutes();
        await refreshAccess(page);
        await waitSel(page, '[data-banner="routes-locked"]', 15_000);
        await page.waitFor(() => document.querySelector('[data-undo-retry]')?.disabled, { what: 'Undo Try again disabled' });
        assert.equal(await page.evaluate(() => document.querySelector('[data-undo-retry]').getAttribute('aria-describedby')), 'routes-reason-a');
        assert.equal(await text(page, '#routes-reason-a'), R_LOCKED);
        assert.ok(await shown('#routes-reason-a'));
        // Replace it next to a name that is taken by an address.
        await goTab(page, 'add');
        await fill(page, '#add-port', '9100');
        await fill(page, '#add-name', 'recipes');
        await waitSel(page, '#add-taken [data-replace]');
        assert.deepEqual(await page.evaluate(() => { const b = document.querySelector('#add-taken [data-replace]'); return [b.textContent, b.disabled, b.getAttribute('aria-describedby')]; }), ['Replace it', true, 'routes-reason-add']);
        assert.equal(await text(page, '#routes-reason-add'), R_LOCKED);
        assert.ok(await shown('#routes-reason-add'));
        await fill(page, '#add-name', '');
        await fill(page, '#add-port', '');
        // Reset Portless (Advanced).
        await goTab(page, 'advanced');
        assert.deepEqual(await page.evaluate(() => { const b = document.querySelector('[data-reset-open]'); return [b.disabled, b.getAttribute('aria-describedby')]; }), [true, 'routes-reason-reset']);
        assert.equal(await text(page, '#routes-reason-reset'), R_LOCKED);
        assert.ok(await shown('#routes-reason-reset'));
        // Unlocked: all three work again.
        fx.adapter.unlockRoutes();
        await refreshAccess(page);
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        assert.equal(await page.evaluate(() => document.querySelector('[data-reset-open]').disabled), false);
        assert.equal(await exists(page, '#routes-reason-reset'), false);
        // A lock that arrives while the Reset dialog is open blocks its Reset button too.
        await page.click('[data-reset-open]');
        await waitSel(page, '.dialog #reset-confirm');
        await page.waitFor(() => !document.querySelector('.dialog .reset-list'), { what: 'reset list loaded' });
        await fill(page, '#reset-confirm', 'reset');
        await page.waitFor(() => { const b = [...document.querySelectorAll('.dialog button')].find((x) => x.textContent.includes('Reset Portless')); return b && !b.disabled; }, { what: 'Reset enabled' });
        fx.adapter.lockRoutes();
        await refreshAccess(page);
        await page.waitFor(() => { const b = [...document.querySelectorAll('.dialog button')].find((x) => x.textContent.includes('Reset Portless')); return b && b.disabled; }, { what: 'Reset disabled by the lock', timeout: 15_000 });
        assert.equal(await text(page, '.dialog #routes-reason-dlg'), R_LOCKED);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.dialog button')].find((x) => x.textContent.includes('Reset Portless')).getAttribute('aria-describedby')), 'routes-reason-dlg');
        await page.key('Escape');
        await waitGone(page, '.dialog');
        await goTab(page, 'addresses');
        assert.equal(await page.evaluate(() => document.querySelector('[data-undo-retry]').disabled), true);
        fx.adapter.unlockRoutes();
        await refreshAccess(page);
        await waitGone(page, '[data-banner="routes-locked"]', 15_000);
        assert.equal(await page.evaluate(() => document.querySelector('[data-undo-retry]').disabled), false);
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await fx.close();
      }
    });

    test('Discover when scans keep failing: an error with Try again, never "Looking for services…" forever (validation 7, finding 8)', async () => {
      const discovery = createFakeDiscovery(DESIGN_SERVICES);
      const scan = discovery.scan.bind(discovery);
      let failing = true;
      discovery.scan = async (o) => { if (failing) throw new Error('lsof failed'); return scan(o); };
      const fx = await designMock({ dismissed: ['first-run'], discovery });
      const page = await openApp(fx, { tab: 'discover' });
      try {
        await waitSel(page, '[data-scanning]');
        // A forced scan (Refresh) that comes back without a completed scan ends the wait.
        await page.evaluate(() => document.querySelector('[data-fk="scan-refresh"]').focus());
        await page.key('Enter');
        await waitSel(page, '[data-scan-stuck]', 15_000);
        assert.equal(await exists(page, '[data-scanning]'), false);
        assert.equal(await exists(page, 'main .empty'), false, 'never "Nothing is running yet."');
        assert.equal(await exists(page, '#tab-discover .nav-count'), false, 'no count');
        assert.match(await text(page, '[data-scan-stuck]'), /Couldn’t look for services\. Nidum Local keeps trying in the background\. You can still add an address by port\. Try again/);
        assert.equal(await page.evaluate(() => document.querySelector('[data-scan-stuck] [role=alert]') !== null), true);
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'scan-refresh', { what: 'focus back on Refresh' });
        // Try again while it still fails: still the error, focus kept on Try again.
        await page.evaluate(() => document.querySelector('[data-fk="scan-retry"]').focus());
        await sleep(2100); // past E10's 2 s reuse window, so the server really scans again
        await page.key('Enter');
        await page.waitFor(() => document.querySelector('[data-fk="scan-retry"]') && !document.querySelector('[data-fk="scan-retry"]').disabled, { what: 'retry finished', timeout: 15_000 });
        assert.ok(await exists(page, '[data-scan-stuck]'));
        await page.waitFor(() => document.activeElement?.getAttribute('data-fk') === 'scan-retry', { what: 'focus back on Try again' });
        // Scanning works again: Try again shows the services.
        failing = false;
        await sleep(2100);
        await page.click('[data-fk="scan-retry"]');
        await waitSel(page, '[data-port="6006"]', 15_000);
        await waitGone(page, '[data-scan-stuck]');
        assertClean(page, { allowApi: true });
      } finally {
        await page.close();
        await fx.close();
      }
    });

    test('long paths with spaces: the command quotes the path; paths break only after "/" at 1440, 375 and 320 px in both themes', async () => {
      const dir = '/Users/Jane Doe/Library/Application Support/An extremely long folder name for testing/.portless';
      const adapter = createFakeAdapter({ proxy: HTTPS_PROXY, routes: DESIGN_ROUTES, stateDir: dir, routesLock: { flag: 'uchg', target: 'file' } });
      const m = await startMockApi({ adapter, discovery: createFakeDiscovery(DESIGN_SERVICES), network: createFakeNetwork(FIXTURE_NETWORKS.wifi), state: { version: 1, names: [], settings: { tls: true, port: 443, fixedIp: null, wildcard: false, keepAfterRestart: false }, dismissed: ['first-run'] } });
      const PATH_BREAKS = () => {
        const bad = [];
        const els = [...document.querySelectorAll('[data-banner] .routes-fix .addr-vis')];
        const limit = document.querySelector('[data-banner] .routes-fix').clientWidth;
        for (const el of els) {
          const chars = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (let i = 0; i < n.data.length; i += 1) {
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + 1);
              const rect = r.getBoundingClientRect();
              chars.push({ c: n.data[i], top: Math.round(rect.top), w: rect.width });
            }
          }
          for (let i = 1; i < chars.length; i += 1) {
            if (chars[i].top <= chars[i - 1].top + 2 || chars[i].w === 0 || chars[i - 1].w === 0) continue;
            if (chars[i - 1].c === '/' || chars[i - 1].c === ' ' || chars[i].c === ' ') continue;
            let a = i - 1;
            while (a > 0 && !'/ '.includes(chars[a - 1].c)) a -= 1;
            let b = i;
            while (b < chars.length - 1 && !'/ '.includes(chars[b + 1].c)) b += 1;
            const w = chars.slice(a, b + 1).reduce((sum, x) => sum + x.w, 0);
            if (w <= limit + 1) bad.push(`${el.textContent.slice(0, i)} / ${el.textContent.slice(i)}`);
          }
        }
        const fix = document.querySelector('[data-banner] .routes-fix');
        const over = [...fix.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className || e.localName);
        return { bad, over, scroll: document.documentElement.scrollWidth <= innerWidth, count: els.length };
      };
      try {
        for (const theme of ['light', 'dark']) {
          const page = await openApp(m, { theme, tab: 'discover' });
          try {
            await waitSel(page, '[data-banner="routes-locked"]', 15_000);
            const cmd = `chflags -- nouchg '${dir}/routes.json'`;
            assert.deepEqual(await cmds(page), [cmd]);
            assert.ok((await fixText(page)).includes(`enter ${dir}, select routes.json,`));
            for (const [w, hgt] of [[1440, 900], [375, 812], [320, 700]]) {
              await page.setViewport(w, hgt, { mobile: w < 400 });
              await page.waitFor(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true)))));
              const r = await page.evaluate(PATH_BREAKS);
              assert.ok(r.count >= 3, `${theme} ${w}: paths and command found (${r.count})`);
              assert.deepEqual(r.bad, [], `${theme} ${w}: paths break only after "/" or between words`);
              assert.deepEqual(r.over, [], `${theme} ${w}: nothing in the fix leaves the screen`);
              assert.equal(r.scroll, true, `${theme} ${w}: no horizontal scroll`);
            }
            // Short phone-sized windows (validation 7, finding 1): the banner slot scrolls on its own
            // and never takes more than 40 % of the window, so the page keeps its room and scrolls.
            for (const [w, hgt] of [[320, 568], [375, 667]]) {
              await page.setViewport(w, hgt, { mobile: true });
              await page.waitFor(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true)))));
              const r = await page.evaluate(() => {
                const b = document.querySelector('.banners');
                const main = document.getElementById('panel');
                const before = main.scrollTop;
                main.scrollTop = 200;
                const moved = main.scrollTop > before;
                main.scrollTop = before;
                return { slot: b.getBoundingClientRect().height, main: main.getBoundingClientRect().height, own: b.scrollHeight > b.clientHeight, moved, h: innerHeight };
              });
              assert.ok(r.slot <= r.h * 0.4 + 1, `${theme} ${w}×${hgt}: banner slot ${r.slot} px ≤ 40 %`);
              assert.ok(r.main >= r.h * 0.35, `${theme} ${w}×${hgt}: ${r.main} px of page left under the banner`);
              assert.ok(r.own, `${theme} ${w}×${hgt}: the long fix scrolls inside the banner slot`);
              assert.ok(r.moved, `${theme} ${w}×${hgt}: the page below scrolls`);
            }
            await page.setViewport(1440, 900);
            await page.click('[data-banner] [data-copy-cmd]');
            await toastText(page, 'Copied the command.');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cmd);
            // Assistive tech reads each path and the command once, whole.
            const named = await page.evaluate(() => [...document.querySelectorAll('[data-banner] .routes-fix .addr-sr')].map((e) => e.textContent));
            assert.ok(named.includes(cmd) && named.includes(dir), 'whole strings for screen readers');
            assertClean(page, { allowApi: true });
          } finally {
            await page.close();
          }
        }
      } finally {
        await m.close();
      }
    });
  });
});
