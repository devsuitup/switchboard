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

for (const runtime of ['claude', 'codex']) {
  for (const resume of [false, true]) {
    test(`${resume ? 'Resume' : 'New'} ${runtime}: Enter on a select keeps the dialog open without launching`, async t => {
      const h = setup(t);
      const launches = [];
      h.window.launchNewSession = (...args) => launches.push(args);
      h.window.openSession = (...args) => launches.push(args);
      if (resume) await h.window.showResumeSessionDialog(session(runtime));
      else await h.window.showNewSessionDialog({ projectPath: '/repo', runtime });
      const select = h.document.querySelector('.new-session-dialog select');
      select.focus();
      select.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert.equal(launches.length, 0, 'Enter on a select must not launch');
      assert.ok(h.document.querySelector('.new-session-overlay'), 'Enter on a select keeps the form open');
      assert.equal(h.document.activeElement, select);
    });
  }

  test(`Resume ${runtime}: submitting restores focus to the opener before openSession`, async t => {
    const h = setup(t);
    const opener = h.document.createElement('button');
    h.document.body.appendChild(opener);
    opener.focus();
    let focusAtOpen;
    h.window.openSession = () => { focusAtOpen = h.document.activeElement; };
    await h.window.showResumeSessionDialog(session(runtime));
    h.document.querySelector('.new-session-start-btn').click();
    assert.equal(focusAtOpen, opener, 'Resume restores opener focus before openSession');
    assert.equal(h.document.activeElement, opener);
    assert.equal(h.document.querySelector('.new-session-overlay'), null);
  });
}

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

test('resume displays the recorded cwd without changing the grouped project identity', async t => {
  const h = setup(t);
  await h.window.showResumeSessionDialog(session('codex'));
  assert.equal(h.document.querySelector('#rsd-cwd')?.value, '/repo/worktree', 'resume shows its recorded worktree cwd');
  assert.equal(h.document.querySelector('#rsd-cwd').readOnly, true);
  assert.deepEqual(h.settingsPaths, ['/repo']);
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

test('Codex resume submits the values picked in the form and the harness turns them into argv', async t => {
  const h = setup(t, { codexModel: 'configured-model', codexSandbox: 'read-only', codexApproval: 'on-request', codexEffort: 'low' });
  await h.window.showResumeSessionDialog(session('codex'));
  const pick = (id, value) => {
    const el = h.document.querySelector(`#rsd-${id}`);
    assert.ok([...(el.options || [{ value }])].some(o => o.value === value), `${id} offers ${value}`);
    el.value = value;
    el.dispatchEvent(new h.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  assert.equal(h.document.querySelector('#rsd-codex-model').value, 'configured-model', 'the form starts from the effective model');
  pick('codex-sandbox', 'workspace-write');
  pick('codex-approval', 'never');
  pick('codex-model', 'catalog-model');
  pick('codex-effort', 'high');
  pick('add-dirs', ' /extra/a, /extra/b ');
  const [id, , isNew, options] = await h.submit();
  assert.deepEqual(plain(options), {
    runtime: 'codex', codexSandbox: 'workspace-write', codexApproval: 'never',
    codexModel: 'catalog-model', codexEffort: 'high', addDirs: '/extra/a, /extra/b',
  });
  const args = getHarness(options.runtime).buildLaunchArgs({ sessionId: id, isNew, options });
  assert.deepEqual(args.slice(0, 2), ['resume', id]);
  const picked = [
    '--sandbox', 'workspace-write',
    '--ask-for-approval', 'never',
    '--model', 'catalog-model',
    '-c', 'model_reasoning_effort="high"',
    '--add-dir', '/extra/a',
    '--add-dir', '/extra/b',
  ];
  assert.deepEqual(args.slice(-picked.length), picked, 'each picked value follows its own flag, in order, at the end of argv');
});
