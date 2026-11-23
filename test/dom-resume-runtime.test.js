'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { getHarness } = require('../harnesses');

function setup(t, effective = {}, platform = 'linux') {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const calls = [];
  const settingsPaths = [];
  Object.assign(ctx.window, {
    restoringWorkingSet: false,
    sessionOpenedOutsideRestore: false,
    openSessions: new Map(),
    skippedWorkingSetEntries: new Map(),
    dormantWorkingSet: new Map(),
    guardResume: async () => true,
    resolveResumeSession: require('../public/resume-guard').resolveResumeSession,
    createTerminalEntry: () => ({ initialSize: { cols: 80, rows: 24 }, terminal: { write() {} } }),
    forgetSessionExit() {},
    syncPtySizeAfterOpen() {},
    setSessionSandboxed() {},
    schedulePersistWorkingSet() {},
    pollActiveSessions() {},
    showSession() {},
    launchNewSession() {},
    api: {
      platform,
      getEffectiveSettings: async p => { settingsPaths.push(p); return effective; },
      getHarnessModels: async () => [{ slug: 'catalog-model', label: 'Catalog model' }],
      getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
      openTerminal: async (...args) => { calls.push(args); return { ok: true }; },
    },
  });
  ctx.evalPublic('setting-defaults.js');
  ctx.evalPublic('dialogs.js');
  const { openSession } = loadAppFunctions(ctx.context, {
    declarations: ['restoreRunDepth', 'ptyGenerations', 'pendingOpens', 'continuationRetryCancelled', 'openingSessions'],
    functions: ['beginPtyOpen', 'settlePtyOpen', 'openSession', 'openSessionNow', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'],
  });
  let opening;
  ctx.window.openSession = (...args) => { opening = openSession(...args); return opening; };
  return { ...ctx, calls, settingsPaths, async submit() {
    ctx.document.querySelector('.new-session-start-btn').click();
    await opening;
    assert.equal(calls.length, 1, 'one resume reaches the launch IPC');
    return calls[0];
  } };
}

const session = runtime => ({ sessionId: '12345678-abcd-4000-8000-123456789abc', projectPath: '/repo', cwd: '/repo/worktree', runtime, name: '<saved session>' });
const plain = value => JSON.parse(JSON.stringify(value));

test('Codex resume offers its CLI fields and never exposes Claude permissions, browser or bubblewrap', async t => {
  const h = setup(t, { permissionMode: 'plan', dangerouslySkipPermissions: true, sandbox: true, browserMode: 'claude-in-chrome' });
  await h.window.showResumeSessionDialog(session('codex'));
  assert.ok(h.document.querySelector('#rsd-codex-sandbox'), 'Codex resume must show the Codex sandbox select');
  for (const id of ['mode-grid', 'browser-mode', 'sandbox', 'worktree']) assert.equal(h.document.querySelector(`#rsd-${id}`), null);
  assert.match(h.document.querySelector('h3').textContent, /Resume Codex Session/);
  assert.equal(h.document.querySelector('h3 saved'), null);
  assert.doesNotMatch(h.document.querySelector('.new-session-dialog').textContent, /Prepended to the claude command/);
  const [id, cwd, isNew, options] = await h.submit();
  assert.equal(id, session('codex').sessionId);
  assert.equal(cwd, '/repo');
  assert.equal(isNew, false);
  assert.deepEqual(plain(options), { runtime: 'codex', addDirs: '' });
  const args = getHarness(options.runtime).buildLaunchArgs({ sessionId: id, isNew, options });
  assert.deepEqual(args.slice(0, 2), ['resume', id]);
  for (const flag of ['--permission-mode', '--chrome', '--dangerously-bypass-approvals-and-sandbox', '--worktree']) assert.ok(!args.includes(flag));
});

test('Codex resume prefills recorded options over settings and submits edits through the real openSession IPC path', async t => {
  const h = setup(t, { codexModel: 'global', codexSandbox: 'danger-full-access', codexApproval: 'never', codexEffort: 'low', preLaunchCmd: 'global-wrapper', addDirs: '/global' });
  await h.window.showResumeSessionDialog({ ...session('codex'), codexModel: 'recorded-model', codexSandbox: 'read-only', codexApproval: 'on-request', codexEffort: 'high', preLaunchCmd: '', addDirs: '' });
  for (const [field, value] of [['model', 'recorded-model'], ['sandbox', 'read-only'], ['approval', 'on-request'], ['effort', 'high']]) {
    assert.equal(h.document.querySelector(`#rsd-codex-${field}`)?.value, value, `recorded Codex ${field} wins`);
  }
  assert.equal(h.document.querySelector('#rsd-pre-launch').value, '');
  assert.equal(h.document.querySelector('#rsd-add-dirs').value, '');
  h.document.querySelector('#rsd-codex-sandbox').value = 'workspace-write';
  h.document.querySelector('#rsd-add-dirs').value = '/extra';
  const [id, , isNew, options] = await h.submit();
  assert.deepEqual(plain(options), { runtime: 'codex', codexModel: 'recorded-model', codexSandbox: 'workspace-write', codexApproval: 'on-request', codexEffort: 'high', addDirs: '/extra' });
  const args = getHarness('codex').buildLaunchArgs({ sessionId: id, isNew, options });
  assert.deepEqual(args.slice(0, 2), ['resume', id]);
  for (const value of ['--model', 'recorded-model', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', 'model_reasoning_effort="high"', '--add-dir', '/extra']) assert.ok(args.includes(value), value);
});

test('resume displays the recorded cwd without changing the grouped project identity', async t => {
  const h = setup(t);
  await h.window.showResumeSessionDialog(session('codex'));
  assert.equal(h.document.querySelector('#rsd-cwd')?.value, '/repo/worktree', 'resume shows its recorded worktree cwd');
  assert.equal(h.document.querySelector('#rsd-cwd').readOnly, true);
  assert.deepEqual(h.settingsPaths, ['/repo']);
});

test('Claude resume keeps recorded permission/browser/sandbox overrides, including explicit false and null', async t => {
  const h = setup(t, { permissionMode: 'auto', dangerouslySkipPermissions: true, sandbox: true, browserMode: 'claude-in-chrome', worktree: true, codexModel: 'wrong-runtime', mcpEmulation: false });
  await h.window.showResumeSessionDialog({ ...session('claude'), permissionMode: null, dangerouslySkipPermissions: false, sandbox: false, browserMode: 'off' });
  assert.equal(h.document.querySelector('#rsd-mode-grid .selected')?.dataset.mode, 'null', 'recorded Default replaces the project Dangerous Skip');
  assert.equal(h.document.querySelector('#rsd-sandbox').checked, false);
  assert.equal(h.document.querySelector('#rsd-browser-mode').value, 'off');
  assert.equal(h.document.querySelector('#rsd-worktree'), null);
  assert.equal(h.document.querySelector('#rsd-codex-model'), null);
  h.document.querySelector('#rsd-mode-grid [data-mode="acceptEdits"]').click();
  h.document.querySelector('#rsd-sandbox').checked = true;
  const [id, , isNew, options] = await h.submit();
  assert.deepEqual(plain(options), { runtime: 'claude', permissionMode: 'acceptEdits', browserMode: 'off', sandbox: true, addDirs: '', mcpEmulation: false });
  assert.deepEqual(getHarness('claude').buildLaunchArgs({ sessionId: id, isNew, options }), ['--resume', id, '--permission-mode', 'acceptEdits']);
});

test('legacy sessions default to Claude and use project values when nothing is recorded', async t => {
  const h = setup(t, { permissionMode: 'plan', sandbox: true, browserMode: 'claude-in-chrome' }, 'win32');
  await h.window.showResumeSessionDialog({ ...session(undefined), cwd: undefined });
  assert.match(h.document.querySelector('h3').textContent, /Resume Claude Session/);
  assert.equal(h.document.querySelector('#rsd-cwd').value, '/repo');
  assert.equal(h.document.querySelector('#rsd-mode-grid .selected').dataset.mode, 'plan');
  assert.equal(h.document.querySelector('#rsd-sandbox'), null);
  const [id, , isNew, options] = await h.submit();
  assert.equal(options.sandbox, undefined);
  assert.deepEqual(getHarness('claude').buildLaunchArgs({ sessionId: id, isNew, options }), ['--resume', id, '--permission-mode', 'plan', '--chrome']);
});

test('New Codex and Resume Codex use the same fields and model defaults', async t => {
  const h = setup(t, { codexModel: 'catalog-model', codexSandbox: 'workspace-write', codexApproval: 'on-request', codexEffort: 'medium' });
  let launched;
  h.window.launchNewSession = (project, options) => { launched = { project, options }; };
  await h.window.showNewSessionDialog({ projectPath: '/repo', runtime: 'codex' });
  assert.ok(h.document.querySelector('#nsd-codex-model'), 'New Codex must use the runtime form too');
  const fields = [...h.document.querySelectorAll('.new-session-body input, .new-session-body select')].map(el => [el.id.replace('nsd-', ''), el.value]);
  h.document.querySelector('.new-session-start-btn').click();
  assert.equal(launched.options.runtime, 'codex');
  await h.window.showResumeSessionDialog(session('codex'));
  const resumeFields = [...h.document.querySelectorAll('.new-session-body input, .new-session-body select')].filter(el => el.id !== 'rsd-cwd').map(el => [el.id.replace('rsd-', ''), el.value]);
  assert.deepEqual(resumeFields, fields);
});
