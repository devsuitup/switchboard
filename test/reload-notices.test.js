'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

async function reloadHarness(t, graph, options = {}) {
  const h = setup(t, graph, options);
  h.rows.get('old').name = 'Reload conversation';
  await h.ctx.api.setSetting('global', { ...h.settings(), restoreOnStartup: 'auto' });
  vm.runInContext('activeSessionId = "old"; restoringWorkingSet = false;', h.ctx, { filename: __filename });
  const app = loadAppFunctions(h.ctx, { functions: ['reopenActiveSessionAfterReload', 'showNotRestoredNotice', 'restoreWorkingSet', 'tickRestorePlanner', 'markRestoreIndexingDone', 'restoreSessionsAfterIndexing', 'restoreStartupSessions', 'loadStartupProjects'] });
  h.ctx.createRestorePlanner = require('../public/restore-plan').createRestorePlanner;
  h.ctx.api.getIndexingState = async () => ({ finished: false });
  h.ctx.api.getActiveSessions = async () => [];
  h.ctx.loadProjects = async () => {};
  h.ctx.encodeProjectPath = require('../encode-project-path').encodeProjectPath;
  return { ...h, reload: app.reopenActiveSessionAfterReload,
    notices: () => h.dom.window.document.querySelectorAll('#app-notices .app-notice') };
}

for (const kind of ['interactive', 'schedule', 'bg']) {
  test(`reload names a skipped ${kind} session in exactly one dismissible notice`, async t => {
    const h = await reloadHarness(t, { old: [] }, { live: { old: { kind, pid: 4242, cwd: '/elsewhere' } } });
    await h.reload();
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0].textContent, /Reload conversation.*old.*\/elsewhere.*live outside this window in pid 4242/);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
    h.notices()[0].querySelector('.app-notice-dismiss').click();
    assert.equal(h.notices().length, 0);
  });
}

test('reload names the live continuation rather than the original id', async t => {
  const h = await reloadHarness(t, { old: ['new'], new: [] }, { live: { new: { pid: 5151, cwd: '/continued' } } });
  h.rows.get('new').name = 'Continued conversation';
  await h.reload();
  assert.equal(h.notices().length, 1);
  assert.match(h.notices()[0].textContent, /Continued conversation.*new.*\/continued.*pid 5151/);
  assert.deepEqual(h.spawned, []);
});

test('reload of ambiguous continuations shows the named hold notice without prompting', async t => {
  const h = await reloadHarness(t, { old: ['a', 'b'], a: [], b: [] });
  await h.reload();
  assert.equal(h.notices().length, 1);
  assert.match(h.notices()[0].textContent, /Reload conversation.*A continuation choice is needed.*sidebar to choose/);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
});

test('reload waiting for an unindexed continuation shows the indexing hold notice', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.api.getSessionContinuations = async () => ({ unresolved: true, waitingForIndex: true });
  await h.reload();
  assert.equal(h.notices().length, 1);
  assert.match(h.notices()[0].textContent, /Reload conversation.*Waiting for indexing.*sidebar/);
  assert.deepEqual(h.spawned, []);
});

test('reload and restore merge their notices for the same skipped session', async t => {
  const h = await reloadHarness(t, { old: [] }, { live: { old: { pid: 4242 } } });
  await h.reload();
  assert.equal(h.notices().length, 1);
  await h.restore();
  assert.equal(h.notices().length, 1);
  assert.equal(h.notices()[0].textContent.match(/Reload conversation/g)?.length, 1);
  assert.deepEqual(h.spawned, []);
});

test('reload and restore merge their hold notices for the same ambiguous session', async t => {
  const h = await reloadHarness(t, { old: ['a', 'b'], a: [], b: [] });
  await h.reload();
  assert.equal(h.notices().length, 1);
  await h.restore();
  assert.equal(h.notices().length, 1);
  assert.equal(h.notices()[0].textContent.match(/Reload conversation/g)?.length, 1);
  assert.deepEqual(h.spawned, []);
});

test('reload and restore keep one notice while waiting for indexing', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.api.getSessionContinuations = async () => ({ unresolved: true, waitingForIndex: true });
  await h.reload();
  assert.equal(h.notices().length, 1);
  await h.restore();
  assert.equal(h.notices().length, 1);
  assert.equal(h.notices()[0].textContent.match(/Reload conversation/g)?.length, 1);
  assert.match(h.notices()[0].textContent, /Restore pending.*Waiting for indexing/);
  assert.deepEqual(h.spawned, []);
});

test('normal reload reopens the session without any notice', async t => {
  const h = await reloadHarness(t, { old: [] });
  await h.reload();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.equal(h.notices().length, 0);
  assert.deepEqual(h.prompts, []);
});

test('automatic continuation lookup failure reports its own hold reason', async () => {
  const { resolveResumeSession } = require('../public/resume-guard');
  const holds = [];
  const resolved = await resolveResumeSession({ sessionId: 'old' }, {
    automatic: true,
    api: { getSessionContinuations: async () => { throw new Error('lookup unavailable'); } },
    onHold: reason => holds.push(reason),
  });
  assert.equal(resolved, null);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].lookupFailed, true);
});

for (const first of ['reload', 'restore']) {
  test(`${first} reports a continuation lookup failure and merges the other notice`, async t => {
    const h = await reloadHarness(t, { old: [] });
    h.ctx.api.getSessionContinuations = async () => { throw new Error('lookup unavailable'); };
    for (const action of first === 'reload' ? ['reload', 'restore'] : ['restore', 'reload']) {
      await h[action]();
      assert.equal(h.notices().length, 1);
      const text = h.notices()[0].textContent;
      assert.match(text, /Reload conversation.*Switchboard could not check the conversation's continuations/);
      if (action === 'restore' || first === 'restore') {
        assert.match(text, /Restore pending.*Restore will retry when indexing finishes/);
      } else {
        assert.match(text, /sidebar.*retry/);
      }
      assert.doesNotMatch(text, /continuation choice|choose/);
      assert.equal(text.match(/Reload conversation/g)?.length, 1);
    }
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.settings().openWorkingSet[0].sessionId, 'old');
  });
}

for (const mode of ['auto', 'off', 'lazy']) {
  test(`reload reports an active session missing from the index with restore ${mode}`, async t => {
    const h = await reloadHarness(t, { old: [] });
    await h.ctx.api.setSetting('global', { ...h.settings(), restoreOnStartup: mode });
    h.ctx.sessionMap.clear();
    h.ctx.api.getIndexingState = async () => ({ finished: true });
    await h.reload();
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0].textContent, /old.*not in the index.*Reindex all sessions.*sidebar/);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
    h.notices()[0].querySelector('.app-notice-dismiss').click();
    assert.equal(h.notices().length, 0);
  });
}

test('reload first reports the missing entry and restore merges it once', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  vm.runInContext('restoreIndexingDone = true; var savedWorkingSetRead = false;', h.ctx);
  const { restoreWorkingSet } = loadAppFunctions(h.ctx, { functions: ['restoreWorkingSet'] });
  const actions = { reload: h.reload, restore: restoreWorkingSet };
  for (const action of ['reload', 'restore']) {
    await actions[action]();
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0].textContent, /old.*not in the index/);
    assert.equal(h.notices()[0].textContent.match(/"old"/g)?.length, 1);
  }
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
});

test('a fresh active entry without a transcript is not reported missing', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  await h.ctx.api.setSetting('global', { ...h.settings(), openWorkingSet: [{ ...h.saved[0], fresh: true }] });
  const loadProjects = t.mock.method(h.ctx, 'loadProjects');
  await h.reload();
  assert.equal(loadProjects.mock.callCount(), 0);
  assert.equal(h.notices().length, 0);
  assert.deepEqual(h.spawned, []);
});

test('an unindexed active entry with a live PTY is not reported missing', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  h.ctx.api.getActiveSessions = async () => [{ sessionId: 'old' }];
  await h.reload();
  assert.equal(h.notices().length, 0);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].id, 'old');
  assert.equal(h.spawned[0].options.reattachOnly, true);
});

for (const mode of ['auto', 'off', 'lazy']) {
  test(`an active entry waits for indexing and repeated completion keeps one missing notice with restore ${mode}`, async t => {
    const h = await reloadHarness(t, { old: [] });
    await h.ctx.api.setSetting('global', { ...h.settings(), restoreOnStartup: mode });
    h.ctx.sessionMap.clear();
    await h.reload();
    assert.equal(h.notices().length, 0);
    h.ctx.api.getIndexingState = async () => ({ finished: true });
    await h.ctx.restoreSessionsAfterIndexing();
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0].textContent, /not in the index/);
    await h.ctx.restoreSessionsAfterIndexing();
    assert.equal(h.notices().length, 1);
    assert.equal(h.notices()[0].textContent.match(/"old"/g)?.length, 1);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.prompts, []);
  });
}

test('a failed live PTY lookup cannot establish a missing transcript', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  h.ctx.api.getActiveSessions = async () => { throw new Error('PTY lookup unavailable'); };
  await h.reload();
  assert.equal(h.notices().length, 0);
});

test('two failed startup project loads do not report saved sessions missing', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  let loads = 0;
  h.ctx.loadProjects = async () => { loads++; throw new Error('projects unavailable'); };
  const retries = [];
  h.ctx.setTimeout = callback => { retries.push(callback); };
  await h.ctx.loadStartupProjects();
  assert.equal(loads, 2);
  assert.equal(retries.length, 1);
  assert.equal(h.notices().length, 0);
  assert.deepEqual(h.spawned, []);
});

test('startup recovery handles a restore failure after a successful delayed project load', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.loadProjects = async () => { throw new Error('projects unavailable'); };
  const retries = [];
  h.ctx.setTimeout = callback => { retries.push(callback); };
  await h.ctx.loadStartupProjects();
  h.ctx.reloadProjects = async () => true;
  let restores = 0;
  h.ctx.restoreStartupSessions = async () => { restores++; throw new Error('restore unavailable'); };
  await assert.doesNotReject(retries.shift());
  assert.equal(restores, 1);
});

test('a transcript arriving in the final projects load is reopened without a missing notice', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  h.ctx.loadProjects = async () => { h.ctx.sessionMap.set('old', h.rows.get('old')); };
  await h.reload();
  assert.equal(h.notices().length, 0);
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
});

test('a fresh live active entry reattaches once and remains fresh in the saved set', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  const item = { ...h.saved[0], fresh: true };
  await h.ctx.api.setSetting('global', { ...h.settings(), openWorkingSet: [item] });
  h.ctx.api.getActiveSessions = async () => [{ sessionId: 'old' }];
  h.ctx.restoreAgentsViewAtStartup = () => {};
  await h.ctx.restoreStartupSessions();
  await h.app.persistWorkingSet();
  assert.equal(h.notices().length, 0);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].options.reattachOnly, true);
  assert.deepEqual(h.settings().openWorkingSet, [item]);
});

test('a fresh active entry without a PTY uses the startup fresh launch path', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  const item = { ...h.saved[0], fresh: true };
  await h.ctx.api.setSetting('global', { ...h.settings(), openWorkingSet: [item] });
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  const launches = [];
  h.ctx.launchNewSession = async (project, options, originalId) => {
    launches.push({ project, options, originalId });
    return null;
  };
  h.ctx.restoreAgentsViewAtStartup = () => {};
  await h.ctx.restoreStartupSessions();
  assert.equal(h.notices().length, 0);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].originalId, 'old');
  assert.equal(launches[0].project.projectPath, h.root);
  assert.deepEqual(h.spawned, []);
});

test('a failed continuation lookup after indexing requests a manual retry', async t => {
  const h = await reloadHarness(t, { old: [] });
  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  h.ctx.api.getSessionContinuations = async () => { throw new Error('lookup unavailable'); };
  await h.restore();
  assert.equal(h.notices().length, 1);
  assert.match(h.notices()[0].textContent, /Restore failed.*could not check.*sidebar to retry checking and restoring/);
  assert.doesNotMatch(h.notices()[0].textContent, /Restore will retry|Restore pending/);
});

test('a failed continuation lookup stays pending until its indexing retry opens it', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.api.getSessionContinuations = async () => { throw new Error('lookup unavailable'); };
  await h.restore();
  assert.equal(h.notices()[0]?.dataset.noticeId, 'Restore:pending');
  assert.match(h.notices()[0].textContent, /Restore will retry when indexing finishes/);
  h.ctx.api.getSessionContinuations = async () => ({ candidates: [], unresolved: false });
  await h.ctx.markRestoreIndexingDone();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.equal(h.notices().length, 0);
});

test('a failed projects load cannot establish a missing transcript', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  h.ctx.loadProjects = async () => { throw new Error('projects unavailable'); };
  await h.reload();
  assert.equal(h.notices().length, 0);
});

test('an exited terminal absent from the saved working set is not a missing transcript', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  await h.ctx.api.setSetting('global', { ...h.settings(), openWorkingSet: [] });
  await h.reload();
  assert.equal(h.notices().length, 0);
});

test('an active entry in a hidden project is not reported missing', async t => {
  const h = await reloadHarness(t, { old: [] });
  h.ctx.sessionMap.clear();
  h.ctx.api.getIndexingState = async () => ({ finished: true });
  await h.ctx.api.setSetting('global', { ...h.settings(), hiddenProjects: [h.root] });
  await h.reload();
  assert.equal(h.notices().length, 0);
});

test('reload of a merged row reports its live older part', async t => {
  const h = await reloadHarness(t, { old: ['new'], new: [] }, { live: { old: { kind: 'interactive', pid: 6161, cwd: '/older' } } });
  Object.assign(h.ctx.sessionMap.get('old'), { headSessionId: 'new', mergedMemberIds: ['new'] });
  h.ctx.sessionMap.delete('new');
  await h.reload();
  assert.equal(h.notices().length, 1);
  assert.match(h.notices()[0].textContent, /Reload conversation.*\(old\).*\/older.*pid 6161/);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
});

test('reload with a refused open shows only the existing failure notice', async t => {
  const h = await reloadHarness(t, { old: [] });
  const opens = [];
  h.ctx.api.openTerminal = async id => { opens.push(id); return { ok: false, error: 'terminal unavailable' }; };
  await h.reload();
  assert.deepEqual(opens, ['old']);
  assert.equal(h.notices().length, 1);
  assert.equal(h.notices()[0].dataset.noticeId, 'Restore:local:old');
  assert.match(h.notices()[0].textContent, /Restore failed.*Reload conversation.*terminal unavailable.*sidebar.*retry restoring/);
  assert.doesNotMatch(h.notices()[0].textContent, /live outside|continuation choice|not in the index/);
  assert.equal(h.ctx.openSessions.size, 0);
  assert.deepEqual(h.prompts, []);
});
