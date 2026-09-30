// test/dom-dispatch-dialog.test.js — the fields become exactly the dispatch payload. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup({ dispatchResult = { ok: true, id: 'cccccccc' }, projects, effective = { permissionMode: 'auto', addDirs: '' } } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { dispatched: [], selected: [] };
  window.api = {
    platform: 'linux',
    getEffectiveSettings: async () => effective,
    dispatchBgAgent: async (fields) => { calls.dispatched.push(fields); return dispatchResult; },
  };
  const g = {
    cachedAllProjects: projects || [{ projectPath: '/w/one' }, { projectPath: '/w/two' }],
    selectAgentsRow: (id) => calls.selected.push(id),
    launchNewSession: () => {}, cachedProjects: [], sessionMap: new Map(), pendingSessions: new Map(),
    openSessions: new Map(), activePtyIds: new Set(), refreshSidebar: () => {}, pollActiveSessions: () => {},
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  for (const f of ['setting-defaults.js', 'utils.js', 'icons.js', 'dialogs.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  return { window, document: window.document, calls, destroy: () => window.close() };
}

test('Start sends the trimmed fields with the chosen project and mode, then selects the new row', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog({ projectPath: '/w/two' });
  const d = ctx.document;
  assert.equal(d.querySelector('#dad-project').value, '/w/two', 'the given project is preselected');
  d.querySelector('#dad-prompt').value = '  review the backlog  ';
  d.querySelector('#dad-name').value = 'em-1';
  d.querySelector('#dad-agent').value = 'fleet:em';
  d.querySelector('#dad-add-dirs').value = '/srv/a';
  d.querySelector('.permission-option[data-mode="plan"]').click();
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.dispatched)), [{ prompt: 'review the backlog', name: 'em-1', agent: 'fleet:em', cwd: '/w/two', permissionMode: 'plan', dangerouslySkipPermissions: false, addDirs: '/srv/a' }]);
  assert.deepEqual(ctx.calls.selected, ['cccccccc']);
  assert.equal(d.querySelector('.new-session-overlay'), null, 'the dialog closed');
});

test('an empty prompt never reaches main, and a failed dispatch keeps the dialog open with the error', async (t) => {
  const ctx = setup({ dispatchResult: { ok: false, error: 'daemon said no' } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  d.querySelector('.new-session-start-btn').click();
  await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  assert.match(d.querySelector('#dad-error').textContent, /prompt/);
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 1);
  assert.equal(ctx.calls.dispatched[0].cwd, '/w/one', 'first project by default');
  assert.match(d.querySelector('#dad-error').textContent, /daemon said no/);
  assert.ok(d.querySelector('.new-session-overlay'), 'still open');
});

test('Enter inside the prompt does not start; Escape closes', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const prompt = d.querySelector('#dad-prompt');
  prompt.value = 'x';
  prompt.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  d.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d.querySelector('.new-session-overlay'), null);
});

test('Enter on a focused button is left to the button: Enter on Cancel never starts; Enter elsewhere does', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-cancel-btn').dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  d.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 1);
});

test('main refusing a prompt that starts with "-" is shown inline, the dialog stays open', async (t) => {
  const ctx = setup({ dispatchResult: { ok: false, error: 'a prompt starting with "-" would be read as a flag' } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  d.querySelector('#dad-prompt').value = '--help';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched[0].prompt, '--help');
  assert.match(d.querySelector('#dad-error').textContent, /starting with "-"/);
  assert.ok(d.querySelector('.new-session-overlay'), 'still open');
  assert.equal(d.querySelector('.new-session-start-btn').disabled, false, 'Start usable again');
});

test('ok:true with a null id is a success: the dialog closes and no row is selected', async (t) => {
  const ctx = setup({ dispatchResult: { ok: true, id: null } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 1);
  assert.equal(d.querySelector('.new-session-overlay'), null, 'the dialog closed');
  assert.equal(d.querySelector('#dad-error'), null);
  assert.deepEqual(ctx.calls.selected, []);
});

test('a project path and add-dirs holding quotes and markup reach dispatch intact', async (t) => {
  const odd = '/w/a"b\' onmouseover="x<img>';
  const dirs = '/srv/"q" <b>';
  const ctx = setup({ projects: [{ projectPath: odd }], effective: { addDirs: dirs } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const select = d.querySelector('#dad-project');
  assert.equal(select.options.length, 1);
  assert.equal(select.value, odd);
  assert.equal(select.options[0].getAttribute('onmouseover'), null, 'no attribute injected');
  assert.equal(d.querySelector('img'), null, 'no markup injected');
  assert.equal(d.querySelector('#dad-add-dirs').value, dirs);
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched[0].cwd, odd);
  assert.equal(ctx.calls.dispatched[0].addDirs, dirs.trim());
});
