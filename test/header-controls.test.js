// The session header's right-hand row: one declared order, one look per kind.
// see .ai/contexts/window-frame.md ("The session header's controls")
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const {
  HEADER_CONTROLS,
  HEADER_TOGGLE_ICONS,
  placeHeaderControl,
  createHeaderToggle,
  setHeaderToggle,
} = require('../public/header-controls');
const { setupTerminalDom } = require('./terminal-manager-harness');

const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const KIND_RANK = { indicator: 0, toggle: 1, action: 2 };

function emptyRow() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="terminal-header-controls"></div></body>');
  return dom.window.document;
}

function rowIds(doc) {
  return [...doc.getElementById('terminal-header-controls').children].map((e) => e.id);
}

test('the row is declared once: indicators, then panel toggles, then Stop last', () => {
  assert.deepEqual(HEADER_CONTROLS.map((c) => [c.id, c.kind]), [
    ['terminal-header-status', 'indicator'],
    ['terminal-header-sandbox', 'indicator'],
    ['ide-emulation-indicator', 'indicator'],
    ['panel-terminal-toggle-btn', 'toggle'],
    ['changes-toggle-btn', 'toggle'],
    ['terminal-stop-btn', 'action'],
  ]);
  const ranks = HEADER_CONTROLS.map((c) => KIND_RANK[c.kind]);
  assert.deepEqual(ranks, [...ranks].sort(), 'each kind is one contiguous group');
  assert.ok(Object.isFrozen(HEADER_CONTROLS));
});

test('index.html carries its static controls in the declared order, marked with their kind', () => {
  const doc = new JSDOM(HTML).window.document;
  const controls = doc.getElementById('terminal-header-controls');
  const staticIds = [...controls.children].map((e) => e.id);
  const declared = HEADER_CONTROLS.map((c) => c.id).filter((id) => staticIds.includes(id));
  assert.deepEqual(staticIds, declared);
  assert.deepEqual(staticIds, ['terminal-header-status', 'terminal-header-sandbox', 'terminal-stop-btn']);
  for (const el of controls.children) {
    assert.equal(el.dataset.headerKind, HEADER_CONTROLS.find((c) => c.id === el.id).kind, `#${el.id}`);
  }
  assert.equal(doc.querySelector('#terminal-header-info #terminal-header-sandbox'), null,
    'the sandbox indicator sits with the other indicators, not with the name');
});

test('placeHeaderControl puts each control at its declared place whatever the insertion order', () => {
  const orders = [
    ['terminal-stop-btn', 'changes-toggle-btn', 'panel-terminal-toggle-btn', 'ide-emulation-indicator', 'terminal-header-sandbox', 'terminal-header-status'],
    ['changes-toggle-btn', 'terminal-header-status', 'terminal-stop-btn', 'ide-emulation-indicator', 'panel-terminal-toggle-btn', 'terminal-header-sandbox'],
    HEADER_CONTROLS.map((c) => c.id),
  ];
  for (const order of orders) {
    const doc = emptyRow();
    for (const id of order) {
      const el = doc.createElement('span');
      el.id = id;
      placeHeaderControl(el, doc);
    }
    assert.deepEqual(rowIds(doc), HEADER_CONTROLS.map((c) => c.id), `inserted as ${order.join(', ')}`);
    for (const c of HEADER_CONTROLS) assert.equal(doc.getElementById(c.id).dataset.headerKind, c.kind);
  }
});

test('placeHeaderControl refuses a control the row does not declare', () => {
  const doc = emptyRow();
  const el = doc.createElement('button');
  el.id = 'something-else';
  assert.throws(() => placeHeaderControl(el, doc), /not a declared header control/);
});

test('a header toggle is an icon button with a tooltip, and shows its on state', () => {
  const doc = emptyRow();
  let clicks = 0;
  const btn = createHeaderToggle({ id: 'changes-toggle-btn', label: 'Changes', title: 'Show changes', icon: 'changes', onClick: () => { clicks++; } }, doc);
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.equal(btn.className, 'icon-btn');
  assert.equal(btn.title, 'Show changes');
  assert.equal(btn.getAttribute('aria-label'), 'Changes');
  assert.equal(btn.textContent, '', 'no words on the button');
  assert.ok(btn.querySelector('svg'));
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  btn.click();
  assert.equal(clicks, 1);

  setHeaderToggle(btn, true);
  assert.ok(btn.classList.contains('active'));
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  setHeaderToggle(btn, false);
  assert.ok(!btn.classList.contains('active'));
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.doesNotThrow(() => setHeaderToggle(null, true));

  assert.throws(() => createHeaderToggle({ id: 'terminal-stop-btn', label: 'x', title: 'x', icon: 'shell', onClick() {} }, doc),
    /not a header toggle/);
  assert.deepEqual(Object.keys(HEADER_TOGGLE_ICONS).sort(), ['changes', 'shell']);
});

test('the live row, built by the modules in their start-up order, reads in the declared order', () => {
  const ctx = setupTerminalDom({ filePanel: true });
  try {
    const doc = ctx.window.document;
    const present = HEADER_CONTROLS.map((c) => c.id).filter((id) => doc.getElementById(id));
    assert.deepEqual(present, ['ide-emulation-indicator', 'panel-terminal-toggle-btn', 'changes-toggle-btn', 'terminal-stop-btn']);
    assert.deepEqual(rowIds(doc), present);
    for (const id of ['panel-terminal-toggle-btn', 'changes-toggle-btn']) {
      assert.equal(doc.getElementById(id).className, 'icon-btn', `#${id}`);
    }
  } finally { ctx.destroy(); }
});

function ruleBodies(selectorPattern) {
  const bodies = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selectorPattern.test(selector)) bodies.push({ selector, body: m[2] });
  }
  return bodies;
}

test('the header toggles share the sidebar filter buttons\' rule, on state included', () => {
  const base = ruleBodies(/#running-toggle,[^{]*\.icon-btn\s*$/);
  assert.equal(base.length, 1, '.icon-btn is styled by the filter row\'s own rule');
  assert.match(base[0].body, /width:\s*26px/);
  assert.match(base[0].body, /border:\s*1px solid var\(--control-border\)/);
  assert.equal(ruleBodies(/#running-toggle:hover,[^{]*\.icon-btn:hover\s*$/).length, 1);
  assert.equal(ruleBodies(/#archive-toggle\.active,\s*\.icon-btn\.active\s*$/).length, 1);
});

test('an indicator reads as state: no hover, no pointer, no border', () => {
  const indicator = ruleBodies(/^#terminal-header-controls \[data-header-kind="indicator"\]$/);
  assert.equal(indicator.length, 1);
  assert.match(indicator[0].body, /cursor:\s*default/);
  assert.doesNotMatch(indicator[0].body, /border|background/);
  for (const { selector, body } of ruleBodies(/data-header-kind="indicator"|#terminal-header-(status|sandbox)\b|#ide-emulation-indicator/)) {
    assert.doesNotMatch(selector, /:hover/, `"${selector}" must not react to hover`);
    assert.doesNotMatch(body, /cursor:\s*pointer/, `"${selector}" must not show a pointer`);
  }
});

test('Stop is set apart from the toggles by a divider that is not part of its hit area', () => {
  const stop = ruleBodies(/^#terminal-stop-btn$/);
  assert.equal(stop.length, 1);
  assert.match(stop[0].body, /margin-left:\s*\d+px/);
  const divider = ruleBodies(/^#terminal-stop-btn::before$/);
  assert.equal(divider.length, 1);
  assert.match(divider[0].body, /pointer-events:\s*none/);
});
