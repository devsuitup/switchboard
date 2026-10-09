// test/dom-dispatch-dialog.test.js — the fields become exactly the dispatch payload. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { dispatchArgs } = require('../bg-agents-roster');

const PUBLIC = path.join(__dirname, '..', 'public');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup({ dispatchResult = { ok: true, id: 'cccccccc' }, projects, effective = { permissionMode: 'auto', addDirs: '' } } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { dispatched: [], selected: [] };
  window.api = {
    platform: 'linux',
    getEffectiveSettings: async (projectPath) => (typeof effective === 'function' ? effective(projectPath) : effective),
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
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC, f) });
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

test('the dialog scrolls inside the window when it is taller than the screen', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const dialog = ctx.document.querySelector('.new-session-dialog');
  assert.ok(dialog.classList.contains('dispatch-agent-dialog'), 'the dialog carries its own class');
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const rule = css.match(/\.new-session-dialog\.dispatch-agent-dialog\s*\{([^}]*)\}/);
  assert.ok(rule, 'a rule scoped to the dispatch dialog');
  assert.match(rule[1], /max-height:\s*calc\(100vh\s*-\s*\d+px\)/);
  assert.match(rule[1], /overflow-y:\s*auto/);
});

test('switching project re-reads directories and takes the background mode of the new project when it is offered', async (t) => {
  const byProject = {
    '/w/one': { dangerouslySkipPermissions: true, addDirs: '/srv/one' },
    '/w/two': { permissionMode: 'plan', dangerouslySkipPermissions: false, addDirs: '' },
  };
  const ctx = setup({ effective: (p) => byProject[p] }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  assert.ok(d.querySelector('.permission-option[data-mode="acceptEdits"]').classList.contains('selected'));
  d.querySelector('.permission-option[data-mode="bypassPermissions"]').click();
  const select = d.querySelector('#dad-project');
  select.value = '/w/two';
  select.dispatchEvent(new ctx.window.Event('change'));
  await tick(); await tick();
  assert.equal(d.querySelector('.permission-option[data-mode="bypassPermissions"]').classList.contains('selected'), false);
  assert.ok(d.querySelector('.permission-option[data-mode="plan"]').classList.contains('selected'));
  assert.equal(d.querySelector('#dad-add-dirs').value, '');
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched[0].cwd, '/w/two');
  assert.equal(ctx.calls.dispatched[0].dangerouslySkipPermissions, false);
  assert.equal(ctx.calls.dispatched[0].permissionMode, 'plan');
  assert.equal(ctx.calls.dispatched[0].addDirs, '');
});

test('a sandboxed project, or one with a pre-launch command, says why and cannot be started', async (t) => {
  const byProject = { '/w/one': { sandbox: true }, '/w/two': { preLaunchCmd: 'aws-vault exec p --' } };
  const ctx = setup({ effective: (p) => byProject[p] }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const startBtn = d.querySelector('.new-session-start-btn');
  assert.match(d.querySelector('#dad-error').textContent, /sandbox/);
  assert.equal(startBtn.disabled, true);
  d.querySelector('#dad-prompt').value = 'go';
  startBtn.click();
  d.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  const select = d.querySelector('#dad-project');
  select.value = '/w/two';
  select.dispatchEvent(new ctx.window.Event('change'));
  await tick(); await tick();
  assert.match(d.querySelector('#dad-error').textContent, /pre-launch command/);
  assert.equal(startBtn.disabled, true);
});

test('remote projects are not offered, and a remote active project does not become a local destination', async (t) => {
  const ctx = setup({ projects: [{ projectPath: '/w/one' }, { projectPath: '/srv/remote', remoteAlias: 'box' }] }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog({ projectPath: '/srv/remote', remoteAlias: 'box' });
  const select = ctx.document.querySelector('#dad-project');
  assert.deepEqual([...select.options].map(o => o.value), ['/w/one']);
  assert.equal(select.value, '/w/one');
});

test('a failed dispatch does not re-enable Start while the next project\'s settings are still loading', async (t) => {
  let release;
  const byProject = {
    '/w/one': { dangerouslySkipPermissions: true, addDirs: '/srv/one' },
    '/w/two': new Promise(r => { release = () => r({ permissionMode: 'plan', addDirs: '' }); }),
  };
  let answer;
  const ctx = setup({ effective: (p) => byProject[p] }); t.after(ctx.destroy);
  ctx.window.api.dispatchBgAgent = (fields) => { ctx.calls.dispatched.push(fields); return new Promise(r => { answer = r; }); };
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const startBtn = d.querySelector('.new-session-start-btn');
  d.querySelector('#dad-prompt').value = 'go';
  startBtn.click();
  await tick();
  const select = d.querySelector('#dad-project');
  select.value = '/w/two';
  select.dispatchEvent(new ctx.window.Event('change'));
  answer({ ok: false, error: 'daemon said no' });
  await tick(); await tick();
  assert.equal(startBtn.disabled, true, 'Start waits for /w/two\'s settings');
  startBtn.click();
  d.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(ctx.calls.dispatched.length, 1, 'no retry with the previous project\'s settings');
  release();
  await tick(); await tick();
  assert.equal(startBtn.disabled, false);
  startBtn.click();
  await tick();
  assert.equal(ctx.calls.dispatched.length, 2);
  assert.equal(ctx.calls.dispatched[1].cwd, '/w/two');
  assert.equal(ctx.calls.dispatched[1].dangerouslySkipPermissions, false);
  assert.equal(ctx.calls.dispatched[1].addDirs, '');
});

test('a settings lookup that fails keeps Start disabled and says so, never dispatching with empty settings', async (t) => {
  const byProject = { '/w/one': { addDirs: '/srv/one' } };
  const ctx = setup({ effective: (p) => (p in byProject ? byProject[p] : Promise.reject(new Error('settings store locked'))) }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const startBtn = d.querySelector('.new-session-start-btn');
  assert.equal(startBtn.disabled, false);
  const select = d.querySelector('#dad-project');
  select.value = '/w/two';
  select.dispatchEvent(new ctx.window.Event('change'));
  await tick(); await tick();
  assert.equal(startBtn.disabled, true);
  assert.match(d.querySelector('#dad-error').textContent, /Could not read this project's settings \(settings store locked\)/);
  d.querySelector('#dad-prompt').value = 'go';
  startBtn.click();
  d.body.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
});

test('a failed lookup for the opening project keeps Start disabled too', async (t) => {
  const ctx = setup({ effective: () => Promise.reject(new Error('boom')) }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  assert.equal(ctx.document.querySelector('.new-session-start-btn').disabled, true);
  assert.match(ctx.document.querySelector('#dad-error').textContent, /boom/);
});

test('background permissions offer only Accept Edits, Auto, Plan and Bypass, with Accept Edits selected when the project mode is not offered', async (t) => {
  const ctx = setup({ effective: { permissionMode: 'default', addDirs: '' } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const buttons = [...ctx.document.querySelectorAll('#dad-mode-grid .permission-option')];
  assert.deepEqual(buttons.map(b => [b.dataset.mode, b.querySelector('.perm-name').textContent]), [
    ['acceptEdits', 'Accept Edits'], ['auto', 'Auto'], ['plan', 'Plan'], ['bypassPermissions', 'Bypass'],
  ]);
  assert.deepEqual(buttons.filter(b => b.classList.contains('selected')).map(b => b.dataset.mode), ['acceptEdits']);
  assert.deepEqual(buttons.filter(b => b.classList.contains('dangerous')).map(b => b.dataset.mode), ['bypassPermissions']);
  ctx.document.querySelector('#dad-prompt').value = 'go';
  ctx.document.querySelector('.new-session-start-btn').click();
  await tick();
  assert.equal(ctx.calls.dispatched[0].permissionMode, 'acceptEdits');
  assert.equal(ctx.calls.dispatched[0].dangerouslySkipPermissions, false);
});

test('a project whose mode is offered opens with that mode selected', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const selected = [...ctx.document.querySelectorAll('#dad-mode-grid .permission-option.selected')].map(b => b.dataset.mode);
  assert.deepEqual(selected, ['auto']);
});

test('every offered background mode sends its value without the dangerous-skip flag', async (t) => {
  for (const mode of ['acceptEdits', 'auto', 'plan', 'bypassPermissions']) {
    const ctx = setup(); t.after(ctx.destroy);
    await ctx.window.showDispatchAgentDialog(null);
    ctx.document.querySelector('#dad-prompt').value = 'go';
    ctx.document.querySelector(`.permission-option[data-mode="${mode}"]`).click();
    ctx.document.querySelector('.new-session-start-btn').click();
    await tick();
    assert.equal(ctx.calls.dispatched[0].permissionMode, mode);
    assert.equal(ctx.calls.dispatched[0].dangerouslySkipPermissions, false);
  }
});

test('Agent keeps the text fallback when no definition catalogue is exposed, and an empty value selects none', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const agent = ctx.document.querySelector('#dad-agent');
  assert.equal(agent.tagName, 'INPUT');
  assert.equal(agent.type, 'text');
  assert.equal(agent.value, '');
  ctx.document.querySelector('#dad-prompt').value = 'go';
  ctx.document.querySelector('.new-session-start-btn').click();
  await tick();
  assert.equal(ctx.calls.dispatched[0].agent, '');
  assert.equal(dispatchArgs(ctx.calls.dispatched[0]).args.includes('--agent'), false);
});

test('field descriptions explain the task without CLI flags and Project uses the shared select style', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  for (const description of ctx.document.querySelectorAll('.dispatch-agent-dialog .settings-description')) {
    assert.doesNotMatch(description.textContent, /--[a-z]/);
  }
  assert.ok(ctx.document.querySelector('#dad-project').classList.contains('settings-select'));
});

test('Additional Directories is multiline and dispatch preserves commas within paths while ignoring empty lines', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const dirs = ctx.document.querySelector('#dad-add-dirs');
  assert.equal(dirs.tagName, 'TEXTAREA');
  dirs.value = '  /srv/a,b  \n\n   \n C:\\work\\shared files \n';
  ctx.document.querySelector('#dad-prompt').value = 'go';
  dirs.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  ctx.document.querySelector('.new-session-start-btn').click();
  await tick();
  const fields = ctx.calls.dispatched[0];
  assert.equal(typeof fields.addDirs, 'string');
  assert.deepEqual(dispatchArgs(fields).args, [
    '--bg', '--permission-mode', 'auto', '--add-dir', '/srv/a,b',
    '--add-dir', 'C:\\work\\shared files', '--', 'go',
  ]);
});

test('comma-separated directories from existing session settings are shown one per line on project changes', async (t) => {
  const ctx = setup({ effective: p => ({ addDirs: p === '/w/one' ? '/srv/one, /srv/two' : '/srv/three, /srv/four' }) });
  t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  assert.equal(ctx.document.querySelector('#dad-add-dirs').value, '/srv/one\n/srv/two');
  const project = ctx.document.querySelector('#dad-project');
  project.value = '/w/two';
  project.dispatchEvent(new ctx.window.Event('change'));
  await tick();
  assert.equal(ctx.document.querySelector('#dad-add-dirs').value, '/srv/three\n/srv/four');
});
