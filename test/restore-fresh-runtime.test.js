'use strict';

// see docs/session-restore.md ("A session with no transcript yet")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');
const { getHarness } = require('../harnesses');

const PROJECT = 'D:/project';
const HARNESSES = [
  { id: 'claude', label: 'Claude', available: true, enabled: true, isDefault: true },
  { id: 'codex', label: 'Codex', available: true, enabled: true, isDefault: false },
];

function setup({ openSessions = new Map(), pendingSessions = new Map(), dormantWorkingSet = new Map(), activeSessionId = null } = {}) {
  const saved = {};
  const launches = [];
  const context = vm.createContext({
    console, queueMicrotask, setTimeout, clearTimeout,
    exitingApp: false, _persistChain: Promise.resolve(), activeSessionId,
    openSessions, pendingSessions, dormantWorkingSet,
    pendingRestoreEntries: () => [], skippedWorkingSetEntries: new Map(),
    sessionMap: new Map(), restoreInFlight: new Map(), restoreRunDepth: 0, restoreIndexingDone: true,
    RESTORE_STAGGER_MS: 0, liveElsewhereMany: async () => new Map(),
    launchNewSession: async (project, options, restoreSessionId) => {
      launches.push({ projectPath: project.projectPath, restoreSessionId, options, harness: getHarness(options.runtime).id });
      return 'restored';
    },
    api: {
      getSetting: async () => saved.global,
      setSetting: async (key, value) => { saved[key] = JSON.parse(JSON.stringify(value)); },
      getEffectiveSettings: async () => ({ codexSandbox: 'workspace-write' }),
      getHarnesses: async () => HARNESSES,
    },
  });
  context.window = context;
  const defaults = path.join(__dirname, '..', 'public', 'setting-defaults.js');
  vm.runInContext(fs.readFileSync(defaults, 'utf8'), context, { filename: defaults });
  loadAppFunctions(context, { functions: ['resolveDefaultSessionOptions'], sourcePath: path.join(__dirname, '..', 'public', 'dialogs.js') });
  const app = loadAppFunctions(context, { functions: ['persistWorkingSet', 'runRestore'] });
  return { context, saved, launches, ...app };
}

const freshTab = (sessionId, runtime) => {
  const session = { sessionId, projectPath: PROJECT, summary: 'New session' };
  if (runtime) Object.assign(session, { runtime, runtimeLabel: HARNESSES.find(h => h.id === runtime).label, canLaunch: true });
  return { openSessions: new Map([[sessionId, { session }]]), pendingSessions: new Map([[sessionId, { session, projectPath: PROJECT }]]) };
};

for (const runtime of ['claude', 'codex']) {
  test(`a fresh ${runtime} tab saved before its first prompt restarts on the same CLI`, async () => {
    const tab = freshTab('fresh-tab', runtime === 'claude' ? null : runtime);
    const t = setup({ ...tab, activeSessionId: 'fresh-tab' });
    await t.persistWorkingSet({ checked: true });
    const [entry] = t.saved.global.openWorkingSet;
    assert.equal(entry.fresh, true, 'positive control: the unsent tab is saved for a fresh restore');
    if (runtime === 'claude') assert.equal('runtime' in entry, false, 'the default CLI leaves the entry as before');
    else assert.equal(entry.runtime, runtime, 'the entry names the CLI the tab ran on');
    t.context.openSessions.clear();
    t.context.pendingSessions.clear();
    await t.runRestore(t.saved.global.openWorkingSet);
    assert.equal(t.launches.length, 1);
    assert.equal(t.launches[0].harness, runtime, 'the restored tab must start the CLI it was opened with');
    assert.equal(t.launches[0].restoreSessionId, 'fresh-tab');
    if (runtime === 'codex') {
      assert.equal(t.launches[0].options.runtime, 'codex');
      assert.equal(t.launches[0].options.runtimeLabel, 'Codex', 'the pending row gets its badge from the harness list');
      assert.equal(t.launches[0].options.codexSandbox, 'workspace-write', 'the project defaults still apply');
    } else {
      assert.equal('runtime' in t.launches[0].options, false);
    }
  });
}

test('a fresh Codex entry held out of the open set is saved again with its CLI', async () => {
  const held = { sessionId: 'held-codex', projectPath: PROJECT, active: false, fresh: true, runtime: 'codex' };
  const t = setup({ ...freshTab('open-claude', null), dormantWorkingSet: new Map([['held-codex', { item: held, index: 0 }]]) });
  await t.persistWorkingSet({ checked: true });
  assert.deepEqual(t.saved.global.openWorkingSet.map(e => [e.sessionId, e.fresh, e.runtime ?? null]),
    [['held-codex', true, 'codex'], ['open-claude', true, null]]);
});
