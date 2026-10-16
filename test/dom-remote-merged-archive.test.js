'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./app-source');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { attachBlockReason, sendBlockReason, computeHostProfile } = require('../remote-host-profile');

const mainPath = path.join(__dirname, '..', 'main.js');
const annotateSource = extractFunction(fs.readFileSync(mainPath, 'utf8'), 'annotateRemoteAttachable');

function setup(t, { seen, members = ['B'], at = 1000 }) {
  const descriptors = seen.map(sessionId => ({ sessionId, pid: 100 }));
  const main = vm.createContext({
    remoteIndexer: {
      getRemoteSessions: () => ({ sessions: descriptors, at, error: null }),
      getRemoteHostState: () => ({ consecutiveFailures: 0 }),
      getRemoteHostProfile: () => computeHostProfile({ at: 1000, descriptors, tools: null }),
    },
    remoteAttachAdapter: { supports: () => false },
    remoteActivityTracker: { activeAt: () => null },
    attachBlockReason, sendBlockReason,
  });
  vm.runInContext(annotateSource, main, { filename: mainPath });
  const projects = main.annotateRemoteAttachable([makeSampleProject({
    remoteAlias: 'host',
    sessions: [{ sessionId: 'A', mergedMemberIds: members, remoteAlias: 'host', projectPath: '/project', modified: new Date().toISOString() }],
  })]);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const payload = JSON.parse(JSON.stringify(projects));
  ctx.window.sessionMap.set('A', payload[0].sessions[0]);
  ctx.sidebar.renderProjects(payload, true);
  ctx.read("remoteSessionStates.delete('B')");
  const calls = [];
  ctx.window.api.remoteStopSession = async (alias, id) => {
    calls.push(['stop', alias, id]);
    return seen.includes(id) ? { ok: true } : { ok: false, error: 'session not found on that host' };
  };
  ctx.window.api.archiveSession = async (id, value) => { calls.push(['archive', id, value]); return { ok: true }; };
  return { ...ctx, calls, session: payload[0].sessions[0] };
}

async function archive(ctx) {
  await ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
}

test('Archive stops an unseeded live member when the representative descriptor is unseen', async t => {
  const ctx = setup(t, { seen: ['B'] });
  assert.equal(ctx.session.remoteDescriptorSeen, false);
  assert.equal(ctx.remoteSessionStates.has('B'), false);
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'B'], ['archive', 'A', 1]]);
  assert.equal(ctx.remoteSessionStates.get('B').snapshot().liveness, 'dead');
});

test('Archive does not borrow a seen representative descriptor for an unseeded dead member', async t => {
  const ctx = setup(t, { seen: ['A'] });
  assert.equal(ctx.session.remoteDescriptorSeen, true);
  assert.equal(ctx.remoteSessionStates.has('B'), false);
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['archive', 'A', 1]]);
});

test('Archive on a non-merged remote row retains its own descriptor decision', async t => {
  for (const seen of [[], ['A']]) {
    const ctx = setup(t, { seen, members: [] });
    await archive(ctx);
    assert.deepEqual(ctx.calls, seen.length ? [['stop', 'host', 'A'], ['archive', 'A', 1]] : [['archive', 'A', 1]]);
  }
});

test('Archive keeps a confirmed dead member authoritative over its seen descriptor', async t => {
  const ctx = setup(t, { seen: ['B'] });
  ctx.read("remoteState('B').apply({ type: 'liveness', value: 'dead' })");
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
});

test('Archive keeps a live member state authoritative when its descriptor is absent', async t => {
  const ctx = setup(t, { seen: [] });
  ctx.read("remoteState('B').apply({ type: 'liveness', value: 'alive' })");
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'B'], ['archive', 'A', 1]]);
});

test('Archive asks the host about a row whose host never synced this run', async t => {
  const ctx = setup(t, { seen: [], members: [], at: null });
  assert.equal(ctx.session.remoteHostAt, null);
  ctx.window.openSessions.delete('A');
  ctx.window.activePtyIds.delete('A');
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['archive', 'A', 1]]);
});

test('Archive asks the host about every member of a merged row whose host never synced', async t => {
  const ctx = setup(t, { seen: [], members: ['B'], at: null });
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['stop', 'host', 'B'], ['archive', 'A', 1]]);
});

test('Archive trusts a confirmed dead state even when the host never synced', async t => {
  const ctx = setup(t, { seen: [], members: [], at: null });
  ctx.read("remoteState('A').apply({ type: 'liveness', value: 'dead' })");
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
});

test('an unreachable host archives the row and leaves an alert saying it was not stopped', async t => {
  const ctx = setup(t, { seen: ['A', 'B'] });
  ctx.window.api.remoteStopSession = async (alias, id) => {
    ctx.calls.push(['stop', alias, id]);
    return { ok: false, hostUnreachable: true, error: 'SSH timed out' };
  };
  const errors = [];
  ctx.window.console.error = (...args) => errors.push(args);
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['archive', 'A', 1]]);
  const notice = ctx.document.querySelector('[role="alert"]');
  assert.ok(notice, 'the archived-but-not-stopped failure must be visible');
  assert.equal(notice.dataset.noticeId, 'Archive:host:not-stopped');
  assert.match(notice.querySelector('.app-notice-message').textContent, /^Archived, but not stopped: host did not answer \(SSH timed out\).*A.*host:\/project.*unarchive/);
  assert.doesNotMatch(notice.textContent, /Archive failed/);
  assert.deepEqual(errors, []);
});
