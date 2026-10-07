// see .ai/contexts/window-frame.md ("The session header's controls")
'use strict';

const HEADER_CONTROLS = Object.freeze([
  Object.freeze({ id: 'terminal-header-sandbox', kind: 'indicator' }),
  Object.freeze({ id: 'ide-emulation-indicator', kind: 'indicator' }),
  Object.freeze({ id: 'panel-terminal-toggle-btn', kind: 'toggle' }),
  Object.freeze({ id: 'changes-toggle-btn', kind: 'toggle' }),
  Object.freeze({ id: 'touched-toggle-btn', kind: 'toggle' }),
  Object.freeze({ id: 'terminal-refresh-btn', kind: 'action' }),
  Object.freeze({ id: 'terminal-stop-btn', kind: 'action' }),
]);

const HEADER_TOGGLE_ICONS = Object.freeze({
  shell: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3l-3 3"/><path d="M13 15h3"/><path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2z"/></svg>',
  changes: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M11 6h5a2 2 0 0 1 2 2v8"/><path d="M14 9l-3-3l3-3"/><path d="M13 18h-5a2 2 0 0 1-2-2v-8"/><path d="M10 15l3 3l-3 3"/></svg>',
  touched: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 15l2 2l4-4"/></svg>',
});

function headerControlSpec(id) {
  const spec = HEADER_CONTROLS.find((c) => c.id === id);
  if (!spec) throw new Error(`#${id} is not a declared header control`);
  return spec;
}

function placeHeaderControl(el, doc = document) {
  const controls = doc.getElementById('terminal-header-controls');
  if (!controls) return;
  const spec = headerControlSpec(el.id);
  el.dataset.headerKind = spec.kind;
  const later = HEADER_CONTROLS.slice(HEADER_CONTROLS.indexOf(spec) + 1);
  let next = null;
  for (const c of later) {
    const candidate = doc.getElementById(c.id);
    if (candidate && candidate.parentElement === controls) { next = candidate; break; }
  }
  controls.insertBefore(el, next);
}

function createHeaderToggle({ id, label, title, icon, onClick }, doc = document) {
  if (headerControlSpec(id).kind !== 'toggle') throw new Error(`#${id} is not a header toggle`);
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.id = id;
  btn.className = 'icon-btn';
  btn.title = title;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = HEADER_TOGGLE_ICONS[icon];
  btn.addEventListener('click', onClick);
  placeHeaderControl(btn, doc);
  return btn;
}

function setHeaderToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle('active', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HEADER_CONTROLS, HEADER_TOGGLE_ICONS, placeHeaderControl, createHeaderToggle, setHeaderToggle };
}
