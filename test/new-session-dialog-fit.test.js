// Issue #377 — the New Session dialog must fit the window: title and action
// buttons stay put, the middle body scrolls. CSS layout cannot be measured in
// jsdom, so this pins the structure and the stylesheet rules the fit relies on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selector) {
  const blocks = CSS.match(/[^{}]+\{[^{}]*\}/g) || [];
  return blocks.find((b) => b.split('{')[0].trim() === selector);
}

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = { platform: 'win32', getEffectiveSettings: async () => ({}) };
  const stubs = {
    launchNewSession: () => {}, openSession: () => {}, cachedProjects: [], cachedAllProjects: [],
    sessionMap: new Map(), pendingSessions: new Map(), openSessions: new Map(),
    activePtyIds: new Set(), refreshSidebar: () => {}, pollActiveSessions: () => {},
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }
  for (const f of ['setting-defaults.js', 'utils.js', 'dialogs.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
  }
  return window;
}

test('style.css: .new-session-dialog is capped to the viewport and lays out as a column', () => {
  const rule = ruleFor('.new-session-dialog');
  assert.ok(rule, 'expected a .new-session-dialog rule');
  assert.match(rule, /max-height:\s*100%/);
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /flex-direction:\s*column/);
});

test('style.css: .new-session-overlay keeps the dialog below the window strip', () => {
  const rule = ruleFor('.new-session-overlay');
  assert.ok(rule, 'expected a .new-session-overlay rule');
  assert.match(rule, /padding-top:[^;]*var\(--strip-min-height\)/);
  assert.match(rule, /box-sizing:\s*border-box/);
});

test('style.css: .new-session-body is the scrolling region', () => {
  const rule = ruleFor('.new-session-dialog .new-session-body');
  assert.ok(rule, 'expected a .new-session-dialog .new-session-body rule');
  assert.match(rule, /overflow-y:\s*auto/);
  assert.match(rule, /min-height:\s*0/);
});

for (const [name, show, arg] of [
  ['New Session', 'showNewSessionDialog', { projectPath: '/p' }],
  ['Resume Session', 'showResumeSessionDialog', { projectPath: '/p', sessionId: 'abcdef123456', name: 'n' }],
]) {
  test(`${name} dialog: fields sit in .new-session-body, title and actions stay outside it`, async () => {
    const window = setup();
    try {
      await window[show](arg);
      const dialog = window.document.querySelector('.new-session-dialog');
      const body = dialog.querySelector('.new-session-body');
      assert.ok(body, 'the dialog must have a .new-session-body');
      assert.equal(body.parentElement, dialog);
      assert.ok(body.querySelector('.permission-grid'));
      assert.ok(body.querySelector('input.settings-input'));
      assert.equal(dialog.querySelector('h3').parentElement, dialog);
      const actions = dialog.querySelector('.new-session-actions');
      assert.equal(actions.parentElement, dialog);
      assert.ok(!body.contains(actions));
    } finally {
      window.close();
    }
  });
}

test('style.css: .new-session-body carries the app\'s dark scrollbar', () => {
  const sel = '.new-session-dialog .new-session-body::-webkit-scrollbar';
  assert.match(ruleFor(sel) || '', /width:\s*5px/);
  assert.match(ruleFor(`${sel}-track`) || '', /background:\s*transparent/);
  assert.match(ruleFor(`${sel}-thumb`) || '', /background:\s*var\(--hairline\)/);
  assert.match(ruleFor(`${sel}-thumb:hover`) || '', /background:\s*rgba\(255,\s*255,\s*255,\s*0\.1\)/);
});
