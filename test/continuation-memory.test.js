'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

test('S8 key-aware settings preserve global working set and unrelated settings across choice writes', async t => {
  const h = setup(t, { old: ['b', 'c'], b: [], c: [] }, { choice: 'b' });
  const global = { ...h.settings(), theme: 'dark', sentinel: 42 };
  await h.ctx.api.setSetting('global', global);
  await h.ctx.api.setSetting('project:test', { fontSize: 19 });
  assert.deepEqual(await h.ctx.api.getSetting('global'), global);
  assert.deepEqual(await h.ctx.api.getSetting('project:test'), { fontSize: 19 });
  await h.click();
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.spawned.map(s => s.id), ['b']);
  assert.equal(h.settings().sentinel, 42);
  assert.equal(h.settings().theme, 'dark');
  assert.deepEqual(h.settings().openWorkingSet.map(s => s.sessionId), ['b']);
  assert.deepEqual(JSON.parse(JSON.stringify(await h.ctx.api.getSetting('continuationChoice:old'))), { chosen: 'b', candidates: ['b', 'c'] });
});

test('S1 and S2 startup loads prefix once before reload and restore use the choice without prompting', async t => {
  const h = setup(t, { old: ['b', 'c'], b: [], c: [] });
  const calls = [];
  h.ctx.api.getSettingsByPrefix = async prefix => {
    calls.push(prefix);
    return { 'continuationChoice:old': { chosen: 'b', candidates: ['b', 'c'] } };
  };
  vm.runInContext('activeSessionId = "old";', h.ctx, { filename: __filename });
  const app = loadAppFunctions(h.ctx, { functions: ['restoreStartupSessions', 'reopenActiveSessionAfterReload'] });
  h.ctx.reopenActiveSessionAfterReload = async () => {
    assert.deepEqual(calls, ['continuationChoice:'], 'prefix loading must precede reload');
    await app.reopenActiveSessionAfterReload();
    assert.deepEqual(h.spawned.map(s => s.id), ['b'], 'reload itself must use the choice before restore runs');
  };
  h.ctx.restoreWorkingSet = () => h.restore();
  h.ctx.restoreAgentsViewAtStartup = () => {};
  await app.restoreStartupSessions();
  assert.deepEqual(calls, ['continuationChoice:']);
  assert.deepEqual(h.spawned.map(s => s.id), ['b']);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.dom.window.document.querySelectorAll('.app-notice').length, 0);
});

test('restore reads the representative record and opens the chosen row head with every member guarded', async t => {
  const h = setup(t, { old: ['x', 'b'], x: [], b: [], y: [], z: [] });
  Object.assign(h.rows.get('y'), { headSessionId: 'z', mergedMemberIds: ['x', 'z'] });
  h.ctx.sessionMap.delete('x');
  h.ctx.sessionMap.delete('z');
  h.ctx._continuationChoices = new Map([['continuationChoice:old', { chosen: 'x', candidates: ['b', 'x'] }]]);
  await h.restore();
  assert.deepEqual(h.spawned.map(s => s.id), ['z']);
  assert.deepEqual(Array.from(h.ctx.openSessions.get('z').session.mergedMemberIds).sort(), ['x', 'y']);
  assert.deepEqual(h.prompts, []);
});

test('choice under a non-root head is saved under its representative key and survives renderer reload', async t => {
  const h = setup(t, { old: [], head: ['b', 'c'], b: [], c: [] }, { choice: 'b' });
  Object.assign(h.rows.get('old'), { headSessionId: 'head', mergedMemberIds: ['head'] });
  h.ctx.sessionMap.delete('head');
  const head = h.ctx.rowHeadSession(h.rows.get('old'));
  await h.app.openSession(head);
  const record = await h.ctx.api.getSetting('continuationChoice:old');
  assert.deepEqual(JSON.parse(JSON.stringify(record)), { chosen: 'b', candidates: ['b', 'c'] });
  assert.equal(await h.ctx.api.getSetting('continuationChoice:head'), null);
  h.ctx.openSessions.clear();
  h.ctx._continuationChoices = new Map(Object.entries(await h.ctx.api.getSettingsByPrefix('continuationChoice:')));
  await h.app.openSession(head);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.spawned.map(s => s.id), ['b', 'b']);
});

test('S7 a rejected choice write shows an error notice while the real open still spawns', async t => {
  const h = setup(t, { old: ['b', 'c'], b: [], c: [] }, { choice: 'b' });
  const set = h.ctx.api.setSetting;
  h.ctx.api.setSetting = (key, value) => key.startsWith('continuationChoice:') ? Promise.reject(new Error('read only')) : set(key, value);
  await h.click();
  assert.deepEqual(h.spawned.map(s => s.id), ['b']);
  const notice = h.dom.window.document.querySelector('.app-notice');
  assert.match(notice?.textContent || '', /could not remember this choice: read only.*ask again next time/);
  assert.equal(notice.getAttribute('role'), 'alert');
});

test('startup restores reload, working set and Agents after the choice settings read rejects', async t => {
  const h = setup(t, { old: [], other: [] }, { savedEntries: [
    { sessionId: 'old', projectPath: 'saved-project', active: true },
    { sessionId: 'other', projectPath: 'saved-project', active: false },
  ] });
  for (const item of h.saved) item.projectPath = h.root;
  h.ctx.api.getSettingsByPrefix = async () => { throw new Error('settings unavailable'); };
  h.ctx._continuationChoices.set('continuationChoice:old', { chosen: 'stale', candidates: ['stale'] });
  vm.runInContext('activeSessionId = "old";', h.ctx, { filename: __filename });
  const app = loadAppFunctions(h.ctx, { functions: ['restoreStartupSessions', 'reopenActiveSessionAfterReload'] });
  const calls = [];
  h.ctx.reopenActiveSessionAfterReload = async () => { calls.push('reload'); await app.reopenActiveSessionAfterReload(); };
  h.ctx.restoreWorkingSet = async () => { calls.push('working set'); await h.restore(); };
  h.ctx.restoreAgentsViewAtStartup = () => { calls.push('Agents'); };
  await assert.doesNotReject(app.restoreStartupSessions);
  assert.deepEqual(calls, ['reload', 'working set', 'Agents']);
  assert.deepEqual(h.spawned.map(s => s.id), ['old', 'other']);
  assert.equal(h.ctx._continuationChoices.size, 0);
  assert.equal(h.ctx._startupResumeResolutions, null);
});

test('restore of an unindexed continuation keeps the saved project path', async t => {
  const h = setup(t, { old: ['new'], new: [] });
  h.rows.get('old').projectPath = 'stale-project';
  h.ctx.sessionMap.delete('new');
  await h.restore();
  assert.deepEqual(h.spawned.map(s => ({ id: s.id, project: s.project })), [{ id: 'new', project: h.root }]);
  assert.equal(h.ctx.openSessions.get('new').session.projectPath, h.root);
  assert.equal(h.settings().openWorkingSet[0].projectPath, h.root);
});
