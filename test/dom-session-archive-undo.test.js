'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function setup(t, rows = [{ sessionId: 'A' }]) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const calls = [];
  rows = rows.map(row => ({ projectPath: '/project', summary: row.sessionId, modified: new Date().toISOString(), ...row }));
  for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
  ctx.window.cachedAllProjects = [makeSampleProject({ sessions: rows })];
  ctx.sidebar.renderProjects(ctx.window.cachedAllProjects, true);
  ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  ctx.window.api.stopSession = async id => { calls.push(['stop', id]); return { ok: true }; };
  ctx.window.api.remoteStopSession = async (alias, id) => { calls.push(['remoteStop', alias, id]); return { ok: true }; };
  ctx.window.api.archiveSession = async (id, value) => { calls.push(['archive', id, value]); return { ok: true }; };
  ctx.window.openSession = (...args) => calls.push(['open', ...args]);
  return { ...ctx, calls, rows };
}

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

function archive(ctx, group = false) {
  const button = ctx.document.querySelector(group ? '.slug-group-archive-btn' : '#si-A .session-archive-btn');
  return button.onclick({ stopPropagation() {} });
}

function undo(ctx) {
  return [...ctx.document.querySelectorAll('#app-notices .app-notice-action')].find(button => button.textContent === 'Undo');
}

function answer(ctx, accept) {
  const overlay = ctx.document.querySelector('.modal-overlay');
  assert.ok(overlay, 'Archive opens a confirmation');
  const button = overlay.querySelector(accept ? '.choice-dialog-confirm.delete-worktree-confirm-btn' : '.choice-dialog-cancel');
  assert.ok(button, accept ? 'Archive uses a danger confirmation' : 'Cancel is available');
  button.click();
}

test('P1 idle row archives without a dialog and Undo unarchives it', async t => {
  const ctx = setup(t);
  await archive(ctx);
  assert.equal(ctx.document.querySelector('.modal-overlay'), null);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.ok(undo(ctx), 'an Undo notice is shown');
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [['archive', 'A', 1], ['archive', 'A', 0]]);
});

test('P2 live row asks before any stop or archive and Cancel changes nothing', async t => {
  const ctx = setup(t);
  ctx.window.activePtyIds.add('A');
  const pending = archive(ctx);
  await settle();
  assert.ok(ctx.document.querySelector('.modal-overlay'), 'a confirmation opens');
  assert.deepEqual(ctx.calls, []);
  answer(ctx, false);
  await pending;
  assert.deepEqual(ctx.calls, []);
  assert.equal(undo(ctx), undefined);
});

for (const state of ['job', 'unknown', 'throws']) {
  test(`Archive refuses a ${state} background member before any dialog or stop`, async t => {
    const ctx = setup(t, [{ sessionId: 'A', mergedMemberIds: ['B'] }]);
    ctx.window.activePtyIds.add('A');
    ctx.window.activePtyIds.add('B');
    ctx.window.api.bgAgentLiveJob = async id => {
      if (id === 'A') return { known: true, job: null };
      if (state === 'throws') throw new Error('daemon offline');
      return state === 'job' ? { known: true, job: { id: 'job-B' } } : { known: false, reason: 'daemon offline' };
    };
    const refused = archive(ctx);
    await settle();
    assert.equal(ctx.document.querySelector('.modal-overlay'), null);
    await refused;
    assert.deepEqual(ctx.calls, []);
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, state === 'job' ? /job-B.*Agents view/ : /cannot tell.*daemon offline/);
    ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
    const retry = archive(ctx);
    await settle();
    answer(ctx, false);
    await retry;
    assert.deepEqual(ctx.calls, [], 'retry can be cancelled after the background refusal clears');
  });
}

test('group background refusal checks every row before any dialog or stop', async t => {
  const ctx = setup(t, [{ sessionId: 'A', scheduleSlug: 'group' }, { sessionId: 'B', scheduleSlug: 'group', mergedMemberIds: ['C'] }]);
  ctx.window.activePtyIds.add('A');
  ctx.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'C' ? { id: 'job-C' } : null });
  const refused = archive(ctx, true);
  await settle();
  assert.equal(ctx.document.querySelector('.modal-overlay'), null);
  await refused;
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /job-C/);
});

test('group live rows share one confirmation naming every target and Cancel changes nothing', async t => {
  const ctx = setup(t, [{ sessionId: 'A', scheduleSlug: 'group' }, { sessionId: 'B', scheduleSlug: 'group' }]);
  ctx.window.activePtyIds.add('A');
  ctx.window.activePtyIds.add('B');
  const pending = archive(ctx, true);
  await settle();
  assert.equal(ctx.document.querySelectorAll('.modal-overlay').length, 1, 'one group confirmation');
  assert.match(ctx.document.querySelector('.modal-overlay').textContent, /A.*in this window[\s\S]*B.*in this window/);
  assert.deepEqual(ctx.calls, []);
  answer(ctx, false);
  await pending;
  assert.deepEqual(ctx.calls, []);
  const accepted = archive(ctx, true);
  await settle();
  answer(ctx, true);
  await accepted;
  assert.equal(ctx.document.querySelector('.modal-overlay'), null, 'no second confirmation');
  assert.deepEqual(ctx.calls, [['stop', 'A'], ['archive', 'A', 1], ['stop', 'B'], ['archive', 'B', 1]]);
  assert.ok(undo(ctx), 'confirmed group offers Undo');
});

test('group Undo restores exactly the rows archived by this click', async t => {
  const ctx = setup(t, [{ sessionId: 'A', scheduleSlug: 'group' }, { sessionId: 'B', scheduleSlug: 'group' }, { sessionId: 'C', scheduleSlug: 'group', archived: 1 }]);
  await archive(ctx, true);
  assert.equal(ctx.document.querySelector('.modal-overlay'), null);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1], ['archive', 'B', 1]]);
  assert.ok(undo(ctx), 'group offers Undo');
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [['archive', 'A', 1], ['archive', 'B', 1], ['archive', 'A', 0], ['archive', 'B', 0]]);
});

test('Q3 confirmed Archive offers Undo saying stopped processes stay stopped', async t => {
  const ctx = setup(t);
  ctx.window.activePtyIds.add('A');
  const pending = archive(ctx);
  await settle();
  answer(ctx, true);
  await pending;
  assert.deepEqual(ctx.calls, [['stop', 'A'], ['archive', 'A', 1]]);
  assert.ok(undo(ctx), 'confirmed Archive still offers Undo');
  assert.match(undo(ctx).parentElement.textContent, /stay stopped/);
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [['stop', 'A'], ['archive', 'A', 1], ['archive', 'A', 0]]);
});

test('unseeded remote Archive names its possibly running part and host before stopping', async t => {
  const ctx = setup(t, [{ sessionId: 'A', remoteAlias: 'host', remoteHostAt: null, mergedMemberIds: ['B'] }]);
  ctx.window.setRemoteHostLabels([{ alias: 'host', label: 'VPS' }]);
  const pending = archive(ctx);
  await settle();
  assert.match(ctx.document.querySelector('.modal-overlay')?.textContent || '', /Part B.*possibly running.*on VPS/);
  answer(ctx, true);
  await pending;
  assert.deepEqual(ctx.calls, [['remoteStop', 'host', 'A'], ['remoteStop', 'host', 'B'], ['archive', 'A', 1]]);
});

test('failed group archive is excluded from Undo while successful rows remain reversible', async t => {
  const ctx = setup(t, [{ sessionId: 'A', scheduleSlug: 'group' }, { sessionId: 'B', scheduleSlug: 'group' }]);
  ctx.window.api.archiveSession = async (id, value) => {
    ctx.calls.push(['archive', id, value]);
    return id === 'B' ? { ok: false, error: 'write failed' } : { ok: true };
  };
  await archive(ctx, true);
  assert.ok(undo(ctx), 'successful subset offers Undo');
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [['archive', 'A', 1], ['archive', 'B', 1], ['archive', 'A', 0]]);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /write failed/);
});

test('row Undo expires at ten seconds', async t => {
  const ctx = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  ctx.window.setTimeout = setTimeout;
  ctx.window.clearTimeout = clearTimeout;
  ctx.window.Date = Date;
  await archive(ctx);
  assert.ok(undo(ctx), 'Undo exists before expiry');
  t.mock.timers.tick(9999);
  assert.ok(undo(ctx));
  t.mock.timers.tick(2);
  assert.equal(undo(ctx), undefined);
});

test('Q3 group Undo warns when a row stopped one part before another stop failed', async t => {
  const ctx = setup(t, [{ sessionId: 'A', scheduleSlug: 'group', mergedMemberIds: ['C'] }, { sessionId: 'B', scheduleSlug: 'group' }]);
  ctx.window.activePtyIds.add('A');
  ctx.window.activePtyIds.add('C');
  ctx.window.api.stopSession = async id => {
    ctx.calls.push(['stop', id]);
    return id === 'C' ? { ok: false, error: 'stop refused' } : { ok: true };
  };
  const pending = archive(ctx, true);
  await settle();
  answer(ctx, true);
  await pending;
  assert.deepEqual(ctx.calls, [['stop', 'A'], ['stop', 'C'], ['archive', 'B', 1]]);
  assert.ok(undo(ctx));
  assert.match(undo(ctx).parentElement.textContent, /stay stopped/);
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [['stop', 'A'], ['stop', 'C'], ['archive', 'B', 1], ['archive', 'B', 0]]);
});
