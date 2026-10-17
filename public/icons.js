// Nidum Local dashboard — inline icons (Lucide shapes, as used in design/*.html).
import { h } from './dom.js';

export const ICONS = {
  discover: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"></path><path d="M4 6h.01"></path><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"></path><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"></path><path d="M12 18h.01"></path><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"></path><circle cx="12" cy="12" r="2"></circle><path d="m13.41 10.59 5.66-5.66"></path>',
  add: '<circle cx="12" cy="12" r="10"></circle><path d="M8 12h8"></path><path d="M12 8v8"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
  wifi: '<path d="M12 20h.01"></path><path d="M2 8.82a15 15 0 0 1 20 0"></path><path d="M5 12.86a10 10 0 0 1 14 0"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path>',
  wifiOff: '<path d="M12 20h.01"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path><path d="M5 12.86a10 10 0 0 1 5.17-2.69"></path><path d="M19 12.86a10 10 0 0 0-2.01-1.53"></path><path d="M2 8.82a15 15 0 0 1 4.18-2.65"></path><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"></path><path d="m2 2 20 20"></path>',
  wifiPaused: '<path d="M12 20h.01"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path><path d="M2 8.82a15 15 0 0 1 4.18-2.65"></path><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"></path><path d="m2 2 20 20"></path>',
  tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
  advanced: '<path d="M21 4h-7"></path><path d="M10 4H3"></path><path d="M21 12h-9"></path><path d="M8 12H3"></path><path d="M21 20h-5"></path><path d="M12 20H3"></path><path d="M14 2v4"></path><path d="M8 10v4"></path><path d="M16 18v4"></path>',
  panelClose: '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m16 15-3-3 3-3"></path>',
  panelOpen: '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m14 9 3 3-3 3"></path>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path>',
  sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>',
  power: '<path d="M12 2v10"></path><path d="M18.4 6.6a9 9 0 1 1-12.77.04"></path>',
  info: '<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>',
  alert: '<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
  triangle: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path>',
  search: '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
  open: '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"></rect><rect width="5" height="5" x="16" y="3" rx="1"></rect><rect width="5" height="5" x="3" y="16" rx="1"></rect><path d="M21 16h-3a2 2 0 0 0-2 2v3"></path><path d="M21 21v.01"></path><path d="M12 7v3a2 2 0 0 1-2 2H7"></path><path d="M3 12h.01"></path><path d="M12 3h.01"></path><path d="M12 16v.01"></path><path d="M16 12h1"></path><path d="M21 12v.01"></path><path d="M12 21v-1"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  notWeb: '<circle cx="12" cy="12" r="9"></circle><path d="M8.5 15.5 15.5 8.5"></path>',
  hint: '<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 2.6"></circle>',
  dot: '<circle cx="12" cy="12" r="6"></circle>',
  dotSmall: '<circle cx="12" cy="12" r="8"></circle>',
  waiting: '<circle cx="12" cy="12" r="8" stroke-dasharray="3.4 2.9"></circle>',
  diagnostics: '<path d="M11 2v2"></path><path d="M5 2v2"></path><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"></path><path d="M8 15a6 6 0 0 0 12 0v-3"></path><circle cx="20" cy="10" r="2"></circle>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"></rect><path d="M12 18h.01"></path>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path>',
  compass: '<circle cx="12" cy="12" r="10"></circle><path d="m16.24 7.76-1.8 5.41a2 2 0 0 1-1.27 1.27L7.76 16.24l1.8-5.41a2 2 0 0 1 1.27-1.27z"></path>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path>',
  globe: '<circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path>',
  x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>',
};

/**
 * An icon vnode: `<svg class="ic …" viewBox="0 0 24 24" aria-hidden="true">`.
 * @param {keyof ICONS} name
 * @param {{ cls?: string, style?: string }} [o]
 */
export function icon(name, o = {}) {
  return h('svg', {
    class: `ic${o.cls ? ` ${o.cls}` : ''}${name === 'spinner' ? ' spin' : ''}`,
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    style: o.style || null,
    'data-icon': name,
    html: ICONS[name],
  });
}

/** The Nidum grid mark (28 px in the sidebar). */
export const MARK_SVG =
  '<g fill="currentColor"><rect x="3" y="3" width="14" height="14" rx="2"></rect><rect x="83" y="3" width="14" height="14" rx="2"></rect><rect x="3" y="19" width="14" height="14" rx="2"></rect><rect x="19" y="19" width="14" height="14" rx="2"></rect><rect x="83" y="19" width="14" height="14" rx="2"></rect><rect x="3" y="35" width="14" height="14" rx="2"></rect><rect x="83" y="35" width="14" height="14" rx="2"></rect><rect x="3" y="51" width="14" height="14" rx="2"></rect><rect x="51" y="51" width="14" height="14" rx="2"></rect><rect x="83" y="51" width="14" height="14" rx="2"></rect><rect x="3" y="67" width="14" height="14" rx="2"></rect><rect x="67" y="67" width="14" height="14" rx="2"></rect><rect x="83" y="67" width="14" height="14" rx="2"></rect><rect x="3" y="83" width="14" height="14" rx="2"></rect><rect x="83" y="83" width="14" height="14" rx="2"></rect></g>' +
  '<g fill="none" stroke="currentColor" stroke-width="2.5" opacity=".3"><rect x="19.75" y="3.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="35.75" y="3.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="51.75" y="3.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="67.75" y="3.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="35.75" y="19.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="51.75" y="19.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="67.75" y="19.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="19.75" y="35.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="51.75" y="35.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="67.75" y="35.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="19.75" y="51.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="35.75" y="51.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="67.75" y="51.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="19.75" y="67.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="35.75" y="67.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="51.75" y="67.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="19.75" y="83.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="35.75" y="83.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="51.75" y="83.75" width="12.5" height="12.5" rx="1.5"></rect><rect x="67.75" y="83.75" width="12.5" height="12.5" rx="1.5"></rect></g>' +
  '<rect x="35" y="35" width="14" height="14" rx="2" fill="#F2A33A"></rect>';
