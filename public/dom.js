// Nidum Local dashboard — a tiny hyperscript + keyed DOM patcher.
//
//   h('button', { class: 'btn', onclick: fn, key: 'x' }, 'Label')
//   patch(container, [vnodes])   // morphs container's children in place
//
// Patching keeps existing elements (so focus, caret and scroll survive a
// re-render). Props: `class`, `style` (string), `key`, `html` (innerHTML; the
// element's children are then left alone), `on<event>` handlers, `value`,
// `checked`, `disabled`, `ref` (called with the element after patching);
// everything else becomes an attribute (false/null/undefined removes it).

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'indeterminate']);

/** Create a vnode. Children may be strings, numbers, vnodes, arrays, or falsy (skipped). */
export function h(tag, props, ...children) {
  return { tag, props: props || {}, children: flatten(children) };
}

function flatten(list, out = []) {
  for (const c of list) {
    if (c === null || c === undefined || c === false || c === true || c === '') continue;
    if (Array.isArray(c)) flatten(c, out);
    else if (typeof c === 'object') out.push(c);
    else out.push(String(c));
  }
  return out;
}

function create(v, svg) {
  if (typeof v === 'string') return document.createTextNode(v);
  const isSvg = svg || v.tag === 'svg';
  const el = isSvg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
  el._props = {};
  update(el, v, isSvg);
  return el;
}

function dispatch(ev) {
  const fn = ev.currentTarget._on && ev.currentTarget._on[ev.type];
  if (fn) fn(ev);
}

function update(el, v, svg) {
  const old = el._props || {};
  const next = v.props;
  el._on = el._on || {};
  for (const k of Object.keys(old)) {
    if (k in next) continue;
    if (k.startsWith('on')) {
      delete el._on[k.slice(2)];
    } else if (k === 'class') {
      el.removeAttribute('class');
    } else if (PROPS.has(k)) {
      el[k] = k === 'value' ? '' : false;
    } else if (k !== 'key' && k !== 'html' && k !== 'ref') {
      el.removeAttribute(k);
    }
  }
  for (const k of Object.keys(next)) {
    const val = next[k];
    if (k === 'key' || k === 'ref') continue;
    if (k.startsWith('on')) {
      const type = k.slice(2);
      if (!el._on[type]) el.addEventListener(type, dispatch);
      el._on[type] = val;
      continue;
    }
    if (k === 'html') {
      if (old.html !== val) el.innerHTML = val;
      continue;
    }
    if (PROPS.has(k)) {
      if (k === 'value') {
        const s = val === null || val === undefined ? '' : String(val);
        if (el.value !== s) el.value = s;
      } else if (el[k] !== Boolean(val)) {
        el[k] = Boolean(val);
      }
      continue;
    }
    if (val === false || val === null || val === undefined) {
      if (el.hasAttribute(k === 'class' ? 'class' : k)) el.removeAttribute(k);
      continue;
    }
    const s = val === true ? '' : String(val);
    if (old[k] !== val || el.getAttribute(k) !== s) {
      if (k === 'class' && !svg) {
        if (el.className !== s) el.className = s;
      } else {
        el.setAttribute(k, s);
      }
    }
  }
  el._key = next.key;
  el._props = next;
  if (!('html' in next)) patchChildren(el, v.children, svg && v.tag !== 'foreignObject');
  // A <select>'s value can only be set once its options exist.
  if (el.localName === 'select' && 'value' in next) {
    const s = next.value === null || next.value === undefined ? '' : String(next.value);
    if (el.value !== s) el.value = s;
  }
}

function sameKind(node, v) {
  if (typeof v === 'string') return node.nodeType === 3;
  return node.nodeType === 1 && node.localName === v.tag && node._key === v.props.key && node._props !== undefined;
}

function patchChildren(parent, vchildren, svg) {
  const existing = Array.from(parent.childNodes);
  const keyed = new Map();
  for (const n of existing) if (n._key !== undefined && n._key !== null) keyed.set(n._key, n);
  const used = new Set();
  let cursor = 0;
  // Pass 1: pair each vnode with the element it reuses (or a new one). Nothing moves yet.
  const nodes = vchildren.map((v) => {
    let node = null;
    const key = typeof v === 'object' ? v.props.key : undefined;
    if (key !== undefined && key !== null) {
      const cand = keyed.get(key);
      if (cand && !used.has(cand) && sameKind(cand, v)) node = cand;
    } else {
      // Unkeyed: the next unused unkeyed element of the same kind. Looking past a different one
      // means a line that disappears above a field (say a reason line above the search box) doesn't
      // make the field a new element, which would drop the keyboard focus in it.
      for (let j = cursor; j < existing.length; j += 1) {
        const cand = existing[j];
        if (used.has(cand) || (cand._key !== undefined && cand._key !== null)) continue;
        if (sameKind(cand, v)) {
          node = cand;
          cursor = j + 1;
          break;
        }
      }
    }
    if (node) {
      if (typeof v === 'string') {
        if (node.nodeValue !== v) node.nodeValue = v;
      } else {
        update(node, v, svg || v.tag === 'svg');
      }
    } else {
      node = create(v, svg);
    }
    used.add(node);
    return node;
  });
  // Pass 2: drop what isn't reused first, so a kept sibling never has to move past it. Moving an
  // element (insertBefore) blurs any focused control inside it: a banner that goes away must not
  // move <main> and take focus out of the Add form or the search field.
  for (const n of existing) if (!used.has(n)) parent.removeChild(n);
  // Pass 3: put the rest in order, inserting new nodes and moving a kept one only when it must.
  const refs = [];
  nodes.forEach((node, i) => {
    const at = parent.childNodes[i];
    if (at !== node) parent.insertBefore(node, at || null);
    const v = vchildren[i];
    if (typeof v === 'object' && v.props.ref) refs.push([v.props.ref, node]);
  });
  for (const [fn, node] of refs) fn(node);
}

/** Morph `container`'s children to match `vnodes`. */
export function patch(container, vnodes) {
  patchChildren(container, flatten([vnodes]), false);
}
