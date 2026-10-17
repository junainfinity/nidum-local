// Discover panel (design: dashboard-*.html "Discover"; spec §7.9, §7.10, §8.1).
import { h } from '../dom.js';
import { Addr } from '../addr.js';
import { T } from '../strings.js';
import { icon } from '../icons.js';
import { S, network, proxy, routeByName, routesBlocked, scanPending, scanStuck, services, takenBy, urlFor, rerender } from '../store.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';
import { checkName, homeFolder, normalizeNameInput, relTime, shortFolder } from '../util.js';
import { AddressChip, Btn, ErrorNotice, Notice, ReplaceBtn, RoutesReason, SectionHead, hostCheckNotice, routesErrorFix } from './common.js';

function reachNote(s) {
  if (s.reach === 'network') {
    const ip = network()?.ip;
    return ip ? ['already open to the network at ', h('span', { class: 'nowrap' }, `${ip}:${s.port}`)] : 'already open to the network';
  }
  return 'only this computer';
}

function sorted(list) {
  const group = (s) => (!s.http ? 2 : s.routeName ? 1 : 0);
  return list.slice().sort((a, b) => group(a) - group(b) || a.port - b.port);
}

function matches(s, q) {
  if (!q) return true;
  const hay = [String(s.port), `:${s.port}`, s.http?.title, s.process, s.cwd, s.routeName, s.suggestedName].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function rowLine(s, right) {
  const web = Boolean(s.http);
  const title = s.http?.title || s.process || (web ? 'Web service' : `Port ${s.port}`);
  const folder = shortFolder(s.cwd);
  const meta = [];
  if (web) {
    meta.push(s.process ? s.process : h('span', { class: 'muted' }, 'Another user'));
    if (s.pid) meta.push(`PID ${s.pid}`);
    meta.push(reachNote(s));
  } else {
    if (s.pid) meta.push(`PID ${s.pid}`);
    meta.push('only web services can get an address');
  }
  const metaNodes = [];
  meta.forEach((m, i) => {
    if (i) metaNodes.push(' ', h('span', { 'aria-hidden': 'true' }, '·'), ' ');
    metaNodes.push(m);
  });
  return [
    h('div', { class: 'row-main' },
      web ? icon('dot', { cls: 'row-glyph live' }) : icon('notWeb', { cls: 'row-glyph neutral' }),
      h('span', { class: 'mono row-port' }, `:${s.port}`),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, title),
        h('div', { class: 'row-meta', title: s.command || null }, metaNodes)),
    ),
    folder ? h('span', { class: 'mono hide-md row-folder', title: homeFolder(s.cwd) }, folder) : null,
    right,
  ];
}

function assignForm(s) {
  const a = S.assign;
  const chk = checkName(a.name);
  const showErr = a.touched || (chk.error && chk.kind !== 'empty');
  const localErr = showErr && chk.error ? chk.error : null;
  const err = a.error;
  const url = chk.name ? urlFor(chk.name) : null;
  const errId = 'assign-err';
  // Live "taken" check while typing (spec §7.7), from the address list the page already has.
  const live = !err && !localErr && chk.name ? takenBy(chk.name) : null;
  const taken = (err && err.code === 'NAME_TAKEN') || (live && !live.app);
  return h('form', { class: 'assign', novalidate: true, onsubmit: (e) => { e.preventDefault(); A.createFromAssign(false); }, onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); A.cancelAssign(); } } },
    h('div', { class: 'fgroup' },
      h('label', { for: 'assign-name', class: 'flabel' }, 'Name'),
      h('div', { class: `field mono${localErr || err ? ' invalid' : ''}` },
        h('input', {
          id: 'assign-name', value: a.name, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', disabled: a.busy,
          'aria-describedby': `assign-preview${localErr || err || live ? ` ${errId}` : ''}`, 'aria-invalid': localErr || err || live ? 'true' : null,
          oninput: (e) => { const v = normalizeNameInput(e.target.value); if (v !== e.target.value) { const p = e.target.selectionStart; e.target.value = v; e.target.setSelectionRange(p, p); } a.name = v; a.error = null; rerender(); },
          onblur: () => { a.touched = true; rerender(); },
        }),
        h('span', { class: 'suffix' }, '.local'))),
    h('div', { id: 'assign-preview', class: `preview${url && !localErr ? ' ok' : ''}` },
      url && !localErr ? icon('check') : null,
      h('span', { class: 'mono addr' }, Addr(url || urlFor('name')))),
    h('div', { class: 'assign-actions' },
      h('button', { type: 'button', class: 'btn btn-s', onclick: A.cancelAssign, disabled: a.busy }, 'Cancel'),
      Btn('Create address', { cls: 'btn btn-p', busy: a.busy, disabled: Boolean(live && live.app) || Boolean(routesBlocked()), attrs: { type: 'submit', 'aria-describedby': routesBlocked() ? 'routes-reason-d' : null } })),
    localErr ? h('p', { class: 'ferr', id: errId }, localErr) : null,
    !localErr && (err || live) ? h('p', { class: 'ferr', id: errId, role: err ? 'alert' : null },
      err ? errorText(err) : live.message,
      taken ? [
        h('button', { type: 'button', class: 'btn btn-g', onclick: () => { a.error = null; A.focusLater('#assign-name'); const i = document.getElementById('assign-name'); if (i) i.select(); } }, T.useAnotherName),
        ReplaceBtn(() => A.createFromAssign(true), 'routes-reason-d'),
      ] : null,
      err && err.raw ? h('details', null, h('summary', null, 'Details'), h('pre', null, err.raw)) : null) : null,
    !localErr ? routesErrorFix(err, 'assign') : null,
  );
}

function serviceRow(s) {
  const web = Boolean(s.http);
  const key = `svc-${s.port}`;
  if (S.assign && S.assign.port === s.port) {
    return h('div', { class: 'expanded', key, 'data-port': s.port },
      h('div', { class: 'row-line' }, rowLine(s, null)),
      assignForm(s));
  }
  let right = null;
  const route = s.routeName ? routeByName(s.routeName) : null;
  if (route) {
    right = AddressChip(route.url, { where: 'd' });
  } else if (web) {
    const blocked = routesBlocked();
    right = h('button', { type: 'button', class: 'btn btn-s btn-sm', 'data-assign-port': s.port, onclick: () => A.openAssign(s), disabled: Boolean(S.assign && S.assign.busy) || Boolean(blocked), 'aria-describedby': blocked ? 'routes-reason-d' : null }, 'Give it an address');
  } else {
    right = h('span', { class: 'badge soft', title: 'Only web services can get an address. This one speaks a different protocol.' },
      icon('notWeb', { cls: 'neutral' }), 'Not a web service');
  }
  const hl = route && S.highlight[route.hostname] > Date.now();
  // The host-check warning after a create shows where the address was created (spec §7.10).
  const notice = route ? hostCheckNotice(route) : null;
  return h('div', { class: `row${web ? '' : ' nonweb'}${hl ? ' highlight' : ''}`, key, 'data-port': s.port, 'data-row-url': route ? route.url : null },
    rowLine(s, right), notice ? h('div', { class: 'row-notice' }, notice) : null);
}

function skeleton(scanning = false) {
  return h('div', { class: 'card clip', 'aria-busy': 'true', 'aria-label': scanning ? T.scanning : 'Loading services', 'data-scanning': scanning ? '' : null },
    scanning ? h('p', { class: 'caption', role: 'status', style: 'padding:14px 20px 0' }, T.scanning) : null,
    h('div', { class: 'row-list' }, [0, 1, 2].map((i) => h('div', { class: 'skel', key: `sk${i}` }, h('span'), h('span'), h('span')))));
}

function empty(iconName, title, text, actions) {
  return h('div', { class: 'empty' }, icon(iconName), h('h3', null, title), text ? h('p', null, text) : null, actions ? h('div', { class: 'actions' }, actions) : null);
}

export function Discover() {
  const all = services();
  const visible = all.filter((s) => S.showSystem || !s.hidden);
  const q = S.search.trim();
  const shown = sorted(visible.filter((s) => matches(s, q)));
  // An expanded row stays put while its form is open (spec §8.1).
  if (S.assign && !shown.some((s) => s.port === S.assign.port)) {
    const s = all.find((x) => x.port === S.assign.port);
    if (s) shown.unshift(s);
  }
  let body;
  if (!S.data) body = skeleton();
  else if (scanPending()) body = skeleton(true);
  else if (scanStuck()) {
    // Scans keep failing: say so, with Try again, instead of "Looking for services…" forever.
    body = h('div', { class: 'card clip', 'data-scan-stuck': '' },
      h('div', { class: 'card-notice', style: 'padding:16px 20px' }, Notice({
        kind: 'error', role: 'alert', title: T.scanStuckTitle, text: T.scanStuckText,
        actions: [
          Btn(T.tryAgain, { cls: 'btn btn-s btn-sm', busy: S.refreshing, onclick: A.refreshServices, attrs: { 'data-fk': 'scan-retry' } }),
          h('button', { type: 'button', class: 'btn btn-g', onclick: () => A.selectTab('add', { focus: '#add-port' }) }, T.addByPort),
        ],
      })));
  } else {
    let inner;
    if (!all.length) {
      inner = empty('discover', T.nothingRunning, T.nothingRunningText,
        [h('button', { type: 'button', class: 'btn btn-s', onclick: () => A.selectTab('add', { focus: '#add-port' }) }, T.addByPort)]);
    } else if (!visible.length) {
      inner = empty('discover', T.onlySystem, null,
        [h('button', { type: 'button', class: 'btn btn-s', onclick: () => { S.showSystem = true; rerender(); } }, T.showSystem)]);
    } else if (!shown.length) {
      inner = empty('search', T.noMatch(q), null,
        [h('button', { type: 'button', class: 'btn btn-s', onclick: () => { S.search = ''; A.focusLater('#search'); } }, T.clearSearch)]);
    } else {
      inner = h('div', { class: 'row-list' }, shown.map(serviceRow));
    }
    body = h('div', { class: 'card clip' },
      S.scanError ? h('div', { class: 'card-notice', style: 'padding:16px 20px' }, ErrorNotice(S.scanError, {
        title: 'Couldn’t read open ports. Some services may be missing.',
        actions: [Btn('Try again', { cls: 'btn btn-s btn-sm', busy: S.refreshing, onclick: A.refreshServices, attrs: { 'data-fk': 'scan-retry' } })],
      })) : null,
      inner);
  }
  const stale = Boolean(S.scannedAt && Date.now() - S.scannedAt > 30000);
  return h('section', { class: 'section', 'aria-labelledby': 'panel-h', key: 'discover' },
    SectionHead('discover', T.discoverTitle, T.discoverDesc,
      h('div', { class: 'sec-actions' },
        h('label', { class: 'check-label' },
          h('input', { type: 'checkbox', checked: S.showSystem, onchange: (e) => { S.showSystem = e.target.checked; rerender(); } }),
          'Show system services'),
        Btn('Refresh', { cls: 'btn btn-s', iconName: 'refresh', busy: S.refreshing, disabled: !S.data, onclick: A.refreshServices, attrs: { 'data-fk': 'scan-refresh' } }))),
    RoutesReason('routes-reason-d', routesBlocked()),
    h('div', { class: 'field search' },
      icon('search'),
      h('input', { id: 'search', type: 'search', 'aria-label': 'Search services', placeholder: 'Search services…', value: S.search, autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => { S.search = e.target.value; rerender(); },
        onkeydown: (e) => { if (e.key === 'Escape' && S.search) { e.preventDefault(); e.stopPropagation(); S.search = ''; rerender(); } } }),
      h('kbd', { class: 'mono', 'aria-hidden': 'true' }, '/')),
    body,
    S.data ? h('p', { class: `caption${stale ? ' stale' : ''}`, 'data-updated': '', title: stale ? 'Updates have stalled. Check that Nidum Local is still running.' : null }, S.scannedAt ? `Updated ${relTime(S.scannedAt)}` : 'Waiting for the first scan…') : null,
  );
}

export { proxy };
