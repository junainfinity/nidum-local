// Network sharing panel (design: "Network sharing"; spec §7.16, §7.19, §8.4).
import { T } from '../strings.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { S, caps, jobRunning, network, proxy, serviceManaged, settings } from '../store.js';
import * as A from '../actions.js';
import { Btn, ErrorNotice, Notice, SectionHead, Switch } from './common.js';
import { StatusPill, networkLabel, pauseButton } from './shell.js';

function unicast(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || '');
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
  const a = Number(m[1]);
  return a !== 0 && a !== 127 && a < 224;
}

function waitingForPassword(jobId) {
  const job = proxy()?.job;
  return Boolean(job && !job.finishedAt && job.phase === 'waitingForPassword' && (!jobId || job.id === jobId));
}

function pwdNote() {
  return h('p', { class: 'pwd-note', role: 'status' }, icon('info'), T.passwordNote);
}

function settingRow({ id, title, desc, key, checked, disabled, disabledReason, onchange, extra, note }) {
  const busy = Boolean(S.setBusy[key]);
  const err = S.setError[key];
  const permission = err && err.code === 'PERMISSION';
  return h('div', { class: 'set-row', key: id },
    h('div', { class: 'set-text' },
      h('div', { id, class: 'set-title' }, title),
      h('div', { class: 'set-desc', id: `${id}-desc` }, desc)),
    extra || null,
    h('div', { class: 'sw-wrap' },
      busy ? icon('spinner') : null,
      Switch({ checked, labelledby: id, describedby: `${id}-desc`, disabled, busy, title: disabled ? disabledReason : null, onchange })),
    busy && typeof S.setBusy[key] === 'string' && waitingForPassword(S.setBusy[key]) ? h('div', { class: 'set-extra' }, pwdNote()) : null,
    note ? h('p', { class: 'set-extra set-desc', role: 'note' }, note) : null,
    err ? h('div', { class: 'set-extra' }, ErrorNotice(err, {
      title: permission ? null : 'Couldn’t change this setting.',
      actions: [h('button', { type: 'button', class: 'btn btn-s btn-sm', onclick: () => { S.setError[key] = null; onchange(!checked); } }, 'Try again')],
    })) : null);
}

export function Sharing() {
  const p = proxy();
  const st = settings();
  const net = networkLabel();
  const n = network();
  const managed = serviceManaged();
  const busy = Boolean(S.proxyAct) || jobRunning();
  const pauseCap = caps().pause;
  const restartBusy = S.proxyAct?.action === 'restart';
  const ready = Boolean(S.data && st);
  // D27/E10: only unicast IPv4 addresses this computer lists right now.
  const ips = (n?.interfaces || []).filter((i) => unicast(i.ip));

  const strip = [];
  if (ready && st.restartNeeded && !managed) {
    strip.push(h('div', { class: 'strip', role: 'status', key: 'restart' },
      icon('info'),
      h('p', null, 'Restart sharing to apply your changes. Open addresses will drop for a second.'),
      Btn('Restart to apply', { cls: 'btn btn-p btn-sm', busy: restartBusy, busyLabel: restartBusy && waitingForPassword() ? 'Waiting for your password…' : null, disabled: busy, onclick: () => A.proxyAction('restart'), attrs: { 'data-fk': 'strip-restart' } })));
  }
  // E1: whenever the startup service and the saved settings disagree (service-managed or not).
  if (ready && st.serviceReinstallNeeded) {
    const sBusy = Boolean(S.setBusy.service);
    const text = !managed ? T.applyNotSetUp : !st.keepAfterRestart ? T.applyRemove : T.applyOld;
    strip.push(h('div', { class: 'strip', role: 'status', key: 'service', 'data-strip': 'service' },
      icon('info'),
      h('p', null, text),
      Btn(T.apply, { cls: 'btn btn-p btn-sm', busy: sBusy, busyLabel: sBusy && waitingForPassword() ? 'Waiting for your password…' : null, disabled: busy || sBusy, onclick: () => A.askApply() }),
      S.setError.service ? h('div', { style: 'flex-basis:100%' }, ErrorNotice(S.setError.service, { title: T.applyFailed })) : null));
  }

  return h('section', { class: 'section', 'aria-labelledby': 'panel-h', key: 'sharing' },
    SectionHead('sharing', T.sharingTitle, T.sharingDesc),
    h('div', { class: 'card' },
      h('div', { class: 'status-card' },
        StatusPill(),
        h('dl', null,
          h('div', null, h('dt', null, n?.kind === 'wifi' ? 'Wi-Fi' : 'Network'), h('dd', null, net.ip ? net.name : 'Not connected')),
          h('div', null, h('dt', null, 'This computer'), h('dd', { class: 'mono' }, p?.lanIp || n?.ip || '—')),
          h('div', null, h('dt', null, 'Secure (HTTPS)'), h('dd', null, p ? (p.tls ? 'On' : 'Off') : '—'))),
        h('div', { class: 'btn-row' },
          pauseButton({ cls: 'btn btn-s', withIcon: false }),
          Btn('Restart', { cls: 'btn btn-s', busy: restartBusy, busyLabel: restartBusy && waitingForPassword() ? 'Waiting for your password…' : null, disabled: !ready || busy || managed || !p?.running,
            onclick: () => A.proxyAction('restart'), attrs: { 'data-action': 'restart', 'data-fk': 'card-restart', 'aria-describedby': managed ? 'restart-reason' : null } })),
        pauseCap && pauseCap.supported === false && p?.running ? h('p', { id: 'pause-reason', class: 'set-desc reason-line' }, pauseCap.reason) : null,
        managed && ready ? h('p', { id: 'restart-reason', class: 'set-desc reason-line' }, T.restartReason) : null,
        S.proxyAct && waitingForPassword() ? h('div', { style: 'flex-basis:100%' }, pwdNote()) : null,
      ),
      strip,
      settingRow({
        id: 'set-keep', key: 'keepAfterRestart', title: 'Keep sharing after restart',
        desc: 'Starts automatically when this computer starts. Needs your password.',
        checked: st?.keepAfterRestart, disabled: !ready, onchange: (v) => A.toggleSetting('keepAfterRestart', v),
      }),
      settingRow({
        id: 'set-https', key: 'tls', title: 'Secure connections (HTTPS)',
        desc: 'Turn off if other devices show certificate warnings and you don’t need security features.',
        checked: st?.tls, disabled: !ready, onchange: (v) => A.toggleSetting('tls', v), note: st && !st.tls ? S.setNote.tls || null : null,
      }),
      settingRow({
        id: 'set-fixed', key: 'fixedIp', title: 'Use a fixed network address',
        desc: 'For computers with several network connections.',
        checked: Boolean(st?.fixedIp), disabled: !ready || (!st?.fixedIp && !ips.length), disabledReason: 'Connect to a network first.',
        onchange: (v) => A.setFixedIp(v, document.getElementById('fixed-ip')?.value),
        extra: h('select', { id: 'fixed-ip', class: 'sel mono', value: st?.fixedIp || n?.ip || (ips[0] && ips[0].ip) || '—', 'aria-label': 'Fixed network address', disabled: !st?.fixedIp || Boolean(S.setBusy.fixedIp),
          onchange: (e) => A.setFixedIp(true, e.target.value) },
        (ips.length ? ips : [{ ip: '—' }]).map((i) => h('option', { value: i.ip, key: i.ip }, i.ip))),
      }),
      settingRow({
        id: 'set-sub', key: 'wildcard', title: 'Allow any sub-name',
        desc: ['Lets ', h('span', { class: 'mono' }, 'api.recipes.local'), ' reach ', h('span', { class: 'mono' }, 'recipes.local'), ' when api isn’t set up separately.'],
        checked: st?.wildcard, disabled: !ready, onchange: (v) => A.toggleSetting('wildcard', v),
      }),
    ),
  );
}
