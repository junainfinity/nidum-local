// Add manually panel (design: "Add manually"; spec §7.7, §7.8, §8.2).
import { h } from '../dom.js';
import { Addr } from '../addr.js';
import { T } from '../strings.js';
import { icon } from '../icons.js';
import { S, proxy, routesBlocked, serviceForPort, takenBy, urlFor } from '../store.js';
import * as A from '../actions.js';
import { errorText } from '../client.js';
import { checkName, checkPort, normalizeNameInput } from '../util.js';
import { Btn, ReplaceBtn, RoutesReason, SectionHead, routesErrorFix } from './common.js';

export function AddManually() {
  const f = S.add;
  const p = checkPort(f.port, proxy()?.port);
  const n = checkName(f.name);
  const portErr = (f.submitted || (f.portTouched && p.kind !== 'empty')) && p.error ? p.error : null;
  const nameErr = (f.submitted || (f.nameTouched && n.kind !== 'empty') || (n.error && n.kind !== 'empty' && f.name)) && n.error ? n.error : null;
  const svc = p.port ? serviceForPort(p.port) : null;
  let hint;
  if (portErr) hint = h('p', { class: 'ferr', id: 'add-port-hint' }, portErr);
  else if (p.port && svc) {
    hint = h('p', { class: 'hint', id: 'add-port-hint' }, icon('dot', { cls: 'live' }),
      svc.http?.title ? `This is ${svc.http.title} from Discover.` : `Something is running here: ${svc.process || 'another user’s app'}.`);
  } else if (p.port) {
    hint = h('p', { class: 'hint', id: 'add-port-hint' }, icon('hint'), `Nothing is running on ${p.port} yet. You can still save it.`);
  } else {
    hint = h('p', { class: 'hint', id: 'add-port-hint' }, icon('hint'), 'Type the port your service listens on, like 3000 or 8080.');
  }
  const url = n.name ? urlFor(n.name) : null;
  const err = f.error;
  const live = !err && !nameErr && n.name ? takenBy(n.name) : null; // spec §7.7 live "taken" check
  const taken = (err && err.code === 'NAME_TAKEN') || (live && !live.app);
  const blocked = routesBlocked(); // E13: a locked or not-writable address list
  const valid = !p.error && !n.error && !(live && live.app) && !blocked;
  return h('section', { class: 'section', 'aria-labelledby': 'panel-h', key: 'add' },
    SectionHead('add', T.addTitle, T.addDesc),
    h('form', { class: 'card add-card', novalidate: true, onsubmit: (e) => { e.preventDefault(); A.addSubmit(false); } },
      h('div', { class: 'fgroup' },
        h('label', { for: 'add-port', class: 'flabel' }, 'Port'),
        h('div', { class: `field mono port-field${portErr ? ' invalid' : ''}` },
          h('span', { class: 'prefix' }, ':'),
          h('input', { id: 'add-port', value: f.port, inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'add-port-hint', 'aria-invalid': portErr ? 'true' : null, disabled: f.busy,
            oninput: (e) => A.addInput('port', e.target.value), onblur: () => { if (f.port) { f.portTouched = true; A.addInput('port', f.port); } } }))),
      h('div', { class: 'fgroup grow' },
        h('label', { for: 'add-name', class: 'flabel' }, 'Name'),
        h('div', { class: `field mono name-field${nameErr ? ' invalid' : ''}` },
          h('input', { id: 'add-name', value: f.name, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', disabled: f.busy,
            'aria-describedby': nameErr ? 'add-name-err' : err || live ? 'add-taken add-preview' : 'add-preview', 'aria-invalid': nameErr || err || live ? 'true' : null,
            oninput: (e) => { const v = normalizeNameInput(e.target.value); if (v !== e.target.value) { const c = e.target.selectionStart; e.target.value = v; e.target.setSelectionRange(c, c); } A.addInput('name', v); },
            onblur: () => { if (f.name) { f.nameTouched = true; A.addInput('name', f.name); } } }),
          h('span', { class: 'suffix' }, '.local')),
        nameErr ? h('p', { class: 'ferr', id: 'add-name-err' }, nameErr) : null),
      h('div', { class: `preview${url && !nameErr ? ' ok' : ''}`, id: 'add-preview' },
        url && !nameErr ? icon('check') : null,
        h('span', { class: 'mono addr' }, url && !nameErr ? Addr(url) : '')),
      Btn('Create address', { cls: 'btn btn-p create', busy: f.busy, disabled: !valid, attrs: { type: 'submit', 'aria-disabled': valid ? null : 'true', 'aria-describedby': blocked ? 'routes-reason-add' : null } }),
      hint,
      err || live ? h('p', { class: 'ferr', id: 'add-taken', role: err ? 'alert' : null },
        err ? errorText(err) : live.message,
        taken ? [
          h('button', { type: 'button', class: 'btn btn-g', onclick: () => { f.error = null; A.focusLater('#add-name'); } }, T.useAnotherName),
          ReplaceBtn(() => A.addSubmit(true), 'routes-reason-add'),
        ] : null,
        err && err.raw ? h('details', null, h('summary', null, 'Details'), h('pre', null, err.raw)) : null) : null,
      routesErrorFix(err, 'add'),
      RoutesReason('routes-reason-add', blocked),
    ),
  );
}
