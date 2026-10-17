// Tools and Advanced panels (design: "Tools", "Advanced"; spec §7.17, §8.5, §8.6).
import { h } from '../dom.js';
import { T } from '../strings.js';
import { icon } from '../icons.js';
import { S, caps, proxy, routes, routesBlocked, routesUnavailable } from '../store.js';
import * as A from '../actions.js';
import { Btn, ErrorNotice, Notice, RoutesReason, SectionHead, Switch } from './common.js';

function outputPanel(tool) {
  const t = S.tools[tool];
  const r = t?.result;
  if (!r) return null;
  const lines = (r.findings || []).map((f) => h('span', { key: null },
    h('span', { class: `g-${f.status}` }, `${f.glyph || '·'} `), f.message, f.hint ? `\n    ${f.hint.replace(/\n/g, '\n    ')}` : '', '\n'));
  const text = (r.findings || []).map((f) => `${f.glyph || '·'} ${f.message}${f.hint ? `\n    ${f.hint}` : ''}`).join('\n') || r.raw || '';
  const sum = r.summary;
  return h('div', { class: 'output', role: 'region', 'aria-label': 'Diagnostics output' },
    h('div', { class: 'output-head' },
      h('span', { class: 'mono cmd' }, 'portless doctor'),
      h('button', { type: 'button', class: 'btn btn-g', onclick: () => A.copyUrl(text, 'doctor') }, 'Copy output'),
      h('button', { type: 'button', class: 'btn btn-i', 'aria-label': 'Close output', id: 'output-close', onclick: () => A.closeOutput(tool) }, icon('x'))),
    h('pre', { tabindex: '0' }, lines.length ? lines : r.raw || 'No output.'),
    sum ? h('div', { class: 'output-sum' }, sum.failures || sum.warnings
      ? `${sum.failures} ${sum.failures === 1 ? 'problem' : 'problems'}, ${sum.warnings} ${sum.warnings === 1 ? 'warning' : 'warnings'}.`
      : 'Everything looks right.') : null);
}

function toolCard({ id, iconName, title, desc, button, onclick, hidden, extra }) {
  if (hidden) return null;
  const t = S.tools[id];
  return h('div', { class: 'card tool tools-card', key: id },
    h('span', { class: 'tool-ic' }, icon(iconName)),
    h('div', { class: 'tool-body' }, h('h3', null, title), h('p', null, desc)),
    Btn(button, { cls: 'btn btn-s', busy: Boolean(t?.busy), disabled: !S.data, onclick, attrs: { 'data-tool': id, 'aria-describedby': null } }),
    t?.busy && proxy()?.job?.phase === 'waitingForPassword' ? h('p', { class: 'pwd-note' }, icon('info'), 'Your computer may ask for your password.') : null,
    t?.error ? ErrorNotice(t.error, { actions: [h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick }, 'Try again')] }) : null,
    extra || null);
}

export function Tools() {
  const setup = caps().deviceSetup;
  const t = S.tools;
  return h('section', { class: 'section', 'aria-labelledby': 'panel-h', key: 'tools' },
    SectionHead('tools', T.toolsTitle, T.toolsDesc),
    h('div', { class: 'tool-grid' },
      toolCard({ id: 'doctor', iconName: 'diagnostics', title: 'Run diagnostics', desc: 'Checks sharing, addresses and certificates.', button: 'Run', onclick: () => A.runTool('doctor') }),
      toolCard({ id: 'setup', iconName: 'phone', title: 'Set up another device', desc: 'Lets phones and laptops open secure addresses without warnings.', button: 'Start setup', onclick: A.openSetup, hidden: setup && setup.supported === false }),
      toolCard({ id: 'trust', iconName: 'shield', title: 'Fix certificate on this computer', desc: 'Use if this browser warns about your addresses.', button: 'Fix', onclick: () => A.runTool('trust'),
        extra: t.trust?.result ? Notice({ kind: 'ok', title: 'This computer trusts your addresses now. Reload any page that warned.' }) : null }),
      toolCard({ id: 'hosts-sync', iconName: 'compass', title: 'Fix Safari', desc: 'Use if Safari can’t find your addresses.', button: 'Fix', onclick: () => A.runTool('hosts-sync'),
        extra: t['hosts-sync']?.result ? Notice({ kind: 'ok', title: 'Safari can find your addresses now. Reload the page in Safari.' }) : null }),
      toolCard({ id: 'prune', iconName: 'eraser', title: 'Clean up stray servers', desc: 'Stops dev servers left behind by closed apps.', button: 'Clean up', onclick: () => A.runTool('prune') }),
    ),
    outputPanel('doctor'),
  );
}

export function Advanced() {
  const cap = caps().internetSharing || { supported: false, reason: null };
  const list = routes().filter((r) => !r.foreignTld && r.pid === 0);
  const cols = [['tailscale', 'Tailscale'], ['funnel', 'Tailscale Funnel'], ['ngrok', 'ngrok']];
  return h('section', { class: 'section', 'aria-labelledby': 'panel-h', key: 'advanced' },
    SectionHead('advanced', T.advancedTitle, T.advancedDesc),
    h('div', { class: 'card clip adv-card' },
      h('div', { class: 'adv-head' },
        icon('globe'),
        h('div', null,
          h('h3', null, 'Share outside your network'),
          h('p', null, 'Off for every address. Turning one on asks you to confirm, because anyone with the link can open it.'),
          !cap.supported ? h('p', { class: 'reason', id: 'inet-reason' }, icon('info'), cap.reason || 'Sharing outside your network isn’t available yet.') : null)),
      h('div', { style: 'overflow-x:auto' },
        h('table', { class: 'tbl adv-tbl' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', class: 'first' }, 'Address'),
            cols.map(([k, label], i) => h('th', { scope: 'col', class: `c-sw${i === 2 ? ' wide' : ''}`, key: k }, label)))),
          h('tbody', null, list.length ? list.map((r) => h('tr', { key: r.hostname },
            h('td', { class: 'first mono addr' }, r.hostname),
            cols.map(([k, label]) => h('td', { key: k }, Switch({
              checked: false, label: `Share ${r.hostname} with ${label}`, describedby: cap.supported ? null : 'inet-reason',
              disabled: !cap.supported, title: cap.supported ? null : cap.reason, onchange: () => {},
            }))))) : h('tr', null, h('td', { class: 'first', colspan: '4', style: 'color:var(--text-2)' }, routesUnavailable() ? 'Reading your addresses…' : 'No addresses yet.')))))),
    h('div', { class: 'danger' },
      h('div', { class: 'danger-head' }, icon('triangle'), h('h3', null, 'Danger zone')),
      h('div', { class: 'danger-row' },
        h('div', null,
          h('div', { style: 'font-weight:500' }, 'Reset Portless'),
          h('div', { class: 'set-desc' }, 'Removes every address, the certificate on this computer and your sharing settings. Your services keep running.'),
          // D59(c): reset removes every address, so it is blocked with the list (E13), with the same reason.
          RoutesReason('routes-reason-reset', routesBlocked())),
        h('button', { type: 'button', class: 'btn btn-s btn-d', 'data-reset-open': '', disabled: !S.data || Boolean(routesBlocked()), 'aria-describedby': routesBlocked() ? 'routes-reason-reset' : null, onclick: A.openReset }, 'Reset Portless…'))),
  );
}
