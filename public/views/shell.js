// Sidebar, header and page banner (design: dashboard-*.html shell).
import { T } from '../strings.js';
import { h } from '../dom.js';
import { ICONS, MARK_SVG, icon } from '../icons.js';
import { S, TABS, caps, isPaused, isRoutesBanner, jobRunning, liveCount, network, proxy, routes, routesBanner, routesProblemKey, routesUnavailable, scanPending, scanStuck, serviceManaged, shownBanners, topBanner, visibleServices } from '../store.js';
import { Btn, RoutesFix } from './common.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';

const THEME_LABEL = { system: 'Match system', light: 'Light', dark: 'Dark' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

function onTabKey(e) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const i = TABS.findIndex((t) => t.id === S.tab);
  let n = i;
  if (e.key === 'ArrowDown') n = (i + 1) % TABS.length;
  if (e.key === 'ArrowUp') n = (i - 1 + TABS.length) % TABS.length;
  if (e.key === 'Home') n = 0;
  if (e.key === 'End') n = TABS.length - 1;
  A.selectTab(TABS[n].id, { focus: `#tab-${TABS[n].id}` });
}

export function Sidebar() {
  const counts = { discover: S.data && !scanPending() && !scanStuck() ? visibleServices().length : null, addresses: S.data && !routesUnavailable() ? routes().length : null };
  const v = S.data?.versions;
  return h('aside', { class: 'side', 'aria-label': 'Nidum Local' },
    h('div', { class: 'brand', title: 'Share what’s running on this computer with your network.' },
      h('svg', { width: 28, height: 28, viewBox: '0 0 100 100', 'aria-hidden': 'true', html: MARK_SVG }),
      h('h1', { class: 'nav-label' }, 'Nidum Local'),
      h('button', {
        type: 'button', class: 'btn btn-i collapse-toggle', 'aria-expanded': String(!S.collapsed),
        'aria-label': S.collapsed ? 'Expand sidebar' : 'Collapse sidebar', title: S.collapsed ? 'Expand sidebar' : 'Collapse sidebar',
        onclick: A.toggleCollapse,
      }, icon(S.collapsed ? 'panelOpen' : 'panelClose')),
    ),
    h('nav', { class: 'tabs', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Sections' },
      TABS.map((t) => h('button', {
        type: 'button', class: 'nav', role: 'tab', id: `tab-${t.id}`, key: t.id, 'aria-controls': 'panel',
        'aria-selected': String(S.tab === t.id), tabindex: S.tab === t.id ? '0' : '-1', title: t.label,
        onclick: () => A.selectTab(t.id), onkeydown: onTabKey,
      },
      icon(t.icon),
      h('span', { class: `nav-label${counts[t.id] !== undefined ? ' nav-grow' : ''}` }, t.label),
      counts[t.id] !== undefined && counts[t.id] !== null ? h('span', { class: 'nav-label mono nav-count', 'aria-label': `${counts[t.id]} items` }, String(counts[t.id])) : null,
      )),
    ),
    h('div', { class: 'side-spacer' }),
    h('div', { class: 'side-foot' },
      h('div', { class: 'nav-label theme-row' }, 'Theme',
        h('div', { class: 'theme-group', role: 'group', 'aria-label': 'Theme' },
          ['system', 'light', 'dark'].map((c) => h('button', {
            type: 'button', key: c, 'aria-pressed': String(S.theme === c), 'aria-label': THEME_LABEL[c], title: c === 'system' ? 'System' : THEME_LABEL[c],
            onclick: () => A.setTheme(c),
          }, icon(THEME_ICON[c]))),
        ),
      ),
      h('button', {
        type: 'button', class: 'nav only-collapsed', 'aria-label': `Theme: ${THEME_LABEL[S.theme] === 'Match system' ? 'System' : THEME_LABEL[S.theme]}`,
        title: `Theme: ${S.theme === 'system' ? 'System' : THEME_LABEL[S.theme]}`, onclick: A.cycleTheme,
      }, icon(THEME_ICON[S.theme])),
      h('button', { type: 'button', class: 'nav', title: 'Quit Nidum Local', onclick: A.askQuit, disabled: !S.data }, icon('power'), h('span', { class: 'nav-label' }, 'Quit Nidum Local')),
      h('p', { class: 'nav-label side-version' },
        h('a', { href: 'https://nidum.ai', target: '_blank', rel: 'noopener noreferrer' }, 'Nidum Local'),
        ` ${v?.nidum || ''}${v?.portless ? ` · Portless ${v.portless}` : ''}`, h('br'),
        'Powered by ', h('a', { href: 'https://github.com/vercel-labs/portless', target: '_blank', rel: 'noopener noreferrer' }, 'Portless')),
    ),
  );
}

/** Header status pill (design spec §7.2). "Needs attention" is a button that jumps to the banner. */
export function StatusPill() {
  const p = proxy();
  const job = p?.job && !p.job.finishedAt ? p.job : null;
  const spinner = (label) => h('span', { class: 'pill st-accent', role: 'status' }, icon('spinner'), label);
  if (S.conn === 'reconnecting') return spinner('Reconnecting…');
  if (!S.data) return spinner('Loading…');
  if (!p) return spinner('Checking sharing…'); // E1: proxy is null until N3's first read
  if (job) {
    if (job.phase === 'waitingForPassword') return spinner('Waiting for your password…');
    return spinner(job.phase === 'stopping' ? 'Pausing…' : 'Starting…');
  }
  const b = topBanner();
  if ((b && b.kind === 'error') || S.proxyErr) {
    return h('button', { type: 'button', class: 'pill st-error', title: 'Show what needs attention', onclick: () => {
      // The first error banner's text (the top banner, or the address-list one under a paused banner).
      const el = document.querySelector('.banners .banner.k-error .banner-text') || document.getElementById('page-banner');
      if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus(); }
    } }, icon('alert'), T.needsAttention);
  }
  if (!p.running) return h('span', { class: 'pill st-neutral' }, icon('wifiPaused'), 'Paused');
  if (!p.lan) return h('span', { class: 'pill st-waiting' }, icon('monitor'), 'Only this computer');
  return h('span', { class: 'pill st-live' }, icon('wifi'), 'Sharing on');
}

/** "HomeWiFi · ip", "Ethernet · ip" or "Not connected" (F14, F27). */
export function networkLabel() {
  const n = network();
  if (!n || !n.ip || n.kind === 'none') return { name: 'Not connected', ip: null };
  if (n.kind === 'wifi') return { name: n.ssid || 'Wi-Fi', ip: n.ip };
  return { name: 'Ethernet', ip: n.ip };
}

/** Pause / Resume / Start again: the label for the current state (E11; one label per action). */
export function sharingActionLabel() {
  const p = proxy();
  if (!p || p.running) return T.pauseSharing; // unknown state (E1 proxy null): neutral, and disabled
  return isPaused() ? T.resumeSharing : T.startAgain;
}

const pwd = () => proxy()?.job?.phase === 'waitingForPassword' && !proxy()?.job?.finishedAt;

/** Pause / Resume: one label per action; the label only changes for the password wait (§7.16). */
export function pauseButton({ cls = 'btn btn-s', inHeader = false, withIcon = true } = {}) {
  const p = proxy();
  const running = Boolean(p?.running);
  const act = S.proxyAct?.action;
  const mine = act === 'stop' || act === 'start';
  const busy = Boolean(S.proxyAct) || jobRunning();
  const cap = caps().pause;
  const blocked = running && cap && cap.supported === false;
  return Btn(sharingActionLabel(), {
    cls, busy: mine, busyLabel: mine && pwd() ? T.waitingForPassword : null,
    iconName: withIcon ? (running ? 'wifiOff' : 'wifi') : null,
    disabled: !S.data || !p || busy || blocked,
    onclick: () => (running ? A.askPause() : A.proxyAction('start')),
    attrs: { 'data-action': 'pause', 'data-fk': inHeader ? 'hdr-pause' : 'card-pause', 'aria-disabled': blocked ? 'true' : null, title: blocked ? cap.reason : null, 'aria-describedby': blocked && !inHeader ? 'pause-reason' : null },
  });
}

export function Header() {
  const net = networkLabel();
  const live = liveCount();
  const p = proxy();
  let counter = live === 0 ? 'No addresses live' : live === 1 ? '1 address live' : `${live} addresses live`;
  if (p && !p.running) counter = isPaused() ? T.counterPaused : T.counterOff;
  return h('header', { class: 'top' },
    h('div', { class: 'nl-wrap' },
      h('div', { class: 'top-left' },
        StatusPill(),
        S.data ? h('span', { class: 'hide-sm netinfo', title: net.ip ? `This computer is ${net.ip} on ${net.name}` : 'This computer isn’t connected to a network' },
          net.name, net.ip ? [' ', h('span', { 'aria-hidden': 'true' }, '·'), ' ', h('span', { class: 'mono' }, net.ip)] : null) : null,
      ),
      h('div', { class: 'top-right' },
        S.data && !routesUnavailable() ? h('button', { type: 'button', class: 'counter', onclick: () => A.selectTab('addresses', { focus: '#panel-h' }) }, counter) : null,
        pauseButton({ cls: 'btn btn-s hide-sm', inHeader: true }),
      ),
    ),
  );
}

function bannerText(text, id) {
  return h('p', { class: 'banner-text', id, tabindex: '-1' }, text);
}

/** A failed sharing action (start, resume, pause, restart): the page's top banner until dismissed. */
function ProxyErrorBanner() {
  const e = S.proxyErr.error;
  return h('div', { class: 'banner k-error', role: 'alert', key: 'proxy-error' },
    h('div', { class: 'nl-wrap' },
      icon('alert', { cls: 'banner-ic' }),
      bannerText(`${A.proxyErrorTitle()} ${errorText(e)}`, 'page-banner'),
      e.raw ? h('details', { class: 'banner-details' }, h('summary', null, 'Details'), h('pre', null, e.raw)) : null,
      h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: () => { S.proxyErr = null; A.selectTab('tools'); A.runTool('doctor'); } }, 'Run diagnostics'),
      h('button', { type: 'button', class: 'btn btn-p btn-sm', onclick: () => { const a = S.proxyErr.action; S.proxyErr = null; A.proxyAction(a); } }, 'Try again'),
      h('button', { type: 'button', class: 'btn btn-i', 'aria-label': 'Dismiss', onclick: () => { S.proxyErr = null; A.focusLater('#panel-h'); } }, icon('x')),
    ));
}

/**
 * The page banners (D26 priority, D59(d)). One banner shows at a time, except the address-list
 * banner (E13): it always shows, under the top one when sharing is paused or off, Portless is
 * missing, or a sharing action failed. So a lock never hides whether sharing is on, and the pause
 * never hides why addresses can't be changed. Never more than two.
 */
export function Banners() {
  const rb = routesBanner();
  if (!rb && S.routesCheck && !S.routesCheck.busy) S.routesCheck = null; // a later lock starts fresh
  const shown = shownBanners();
  const out = S.proxyErr ? [ProxyErrorBanner()] : [];
  shown.forEach((b) => out.push(PageBanner(b, out.length === 0)));
  return out;
}

function PageBanner(b, first) {
  const routesB = isRoutesBanner(b);
  const busy = S.bannerBusy === b.id;
  const kind = b.id === 'sharing-off' ? 'error' : b.kind;
  const role = kind === 'error' ? 'alert' : 'status';
  const ic = kind === 'info' ? 'info' : kind === 'error' ? 'alert' : 'triangle';
  const startBusy = S.proxyAct?.action === 'start';
  const actions = [];
  if (b.id === 'first-run') actions.push(Btn('Got it', { cls: 'btn btn-s btn-sm', busy, onclick: () => A.dismissBanner(b) }));
  if (b.id === 'sharing-off') {
    actions.push(h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: () => { A.selectTab('tools'); A.runTool('doctor'); } }, 'Run diagnostics'));
    actions.push(Btn(T.startAgain, { cls: 'btn btn-p btn-sm', busy: startBusy, busyLabel: startBusy && pwd() ? T.waitingForPassword : null, disabled: Boolean(S.proxyAct) || jobRunning(), onclick: () => A.proxyAction('start'), attrs: { 'data-fk': 'banner-start' } }));
  }
  if (b.id === 'sharing-paused' && caps().pause?.supported !== false) {
    actions.push(Btn(T.resumeSharing, { cls: 'btn btn-s btn-sm', busy: startBusy, busyLabel: startBusy && pwd() ? T.waitingForPassword : null, disabled: Boolean(S.proxyAct) || jobRunning(), onclick: () => A.proxyAction('start'), attrs: { 'data-fk': 'banner-resume' } }));
  }
  if (b.id === 'network-off' && !serviceManaged()) {
    const rb = S.proxyAct?.action === 'restart';
    actions.push(Btn('Share with other devices', { cls: 'btn btn-p btn-sm', busy: rb, busyLabel: rb && pwd() ? 'Waiting for your password…' : null, disabled: Boolean(S.proxyAct) || jobRunning(), onclick: () => A.proxyAction('restart'), attrs: { 'data-fk': 'banner-restart' } }));
  }
  if (b.id === 'public-network') {
    if (proxy()?.running && caps().pause?.supported !== false) actions.push(h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: A.askPause }, 'Pause sharing'));
    actions.push(Btn('Dismiss', { cls: 'btn btn-s btn-sm', busy, onclick: () => A.dismissBanner(b) }));
  }
  let checkNote = null;
  if (routesB) {
    // E13: not dismissible; Check again re-reads the lock now (GET /api/state?refresh=1).
    const c = S.routesCheck;
    actions.push(Btn(T.checkAgain, { cls: 'btn btn-s btn-sm', busy: Boolean(c?.busy), onclick: A.checkRoutesAccess, attrs: { 'data-fk': 'routes-check' } }));
    // "Nothing has changed yet." only while the problem is the same one the user checked against.
    if (c && !c.busy && (c.unchanged || c.changed)) {
      const same = c.unchanged && c.key === routesProblemKey();
      checkNote = h('p', { class: 'banner-err banner-sub fix-note', role: 'status' }, same ? T.routesStillBlocked : T.routesStillBlockedOther);
    }
  }
  const err = S.bannerErr && S.bannerErr.id === b.id ? S.bannerErr.error : null;
  const text = b.id === 'sharing-off' ? T.stoppedBanner : b.message;
  return h('div', { class: `banner k-${kind}`, role, key: `banner-${b.id}`, 'data-banner': b.id },
    h('div', { class: 'nl-wrap' },
      icon(ic, { cls: 'banner-ic' }),
      bannerText(text, first ? 'page-banner' : `page-banner-${b.id}`),
      actions,
      routesB ? RoutesFix(b.id === 'routes-locked' ? 'locked' : 'not-writable', { target: S.data?.routesAccess?.target || null, ownedByYou: S.data?.routesAccess?.ownedByYou ?? null, ...(b.details || {}) }) : null,
      checkNote,
      err ? h('p', { class: `ferr banner-err${routesB ? ' banner-sub' : ''}`, role: 'alert' }, `${routesB ? '' : `${T.dismissFailed} `}${errorText(err)}`) : null,
    ));
}
