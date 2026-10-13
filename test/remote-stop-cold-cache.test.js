'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRemoteIndexer } = require('../remote-index');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const mainPath = path.join(__dirname, '..', 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const start = mainSource.indexOf("ipcMain.handle('remote-stop-session'");
const end = mainSource.indexOf("ipcMain.handle('remote-launch-session'", start);

function setup(t, { present = true, pollError = null, stopError = null, polling = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-556-'));
  let live = present;
  let polls = 0;
  let finishPoll;
  const pollGate = polling ? new Promise(resolve => { finishPoll = resolve; }) : null;
  const indexer = createRemoteIndexer({
    getHosts: () => [{ alias: 'host' }], dataDir, transport: {},
    sync: async () => {
      polls++;
      if (pollGate) await pollGate;
      if (pollError) throw new Error(pollError);
      return { fetched: 0, unchanged: 0, removed: 0, failed: 0, changedFolders: new Set(), sessions: live ? [{ sessionId: 'A', pid: 100 }] : [] };
    },
  });
  const calls = [];
  const attached = { kind: 'remote-attach', exited: false };
  let handler;
  const main = vm.createContext({
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    remoteIndexer: indexer,
    remoteStopAdapter: { stop: async (alias, descriptor) => {
      calls.push(['stop', alias, descriptor.sessionId]);
      if (stopError) return { ok: false, error: stopError };
      live = false;
      return { ok: true };
    } },
    activeSessions: new Map([['A', attached]]),
    killPty: (_session, id) => { calls.push(['killAttach', id]); attached.exited = true; },
    notifyRendererProjectsChanged: () => {},
  });
  vm.runInContext(mainSource.slice(start, end), main, { filename: mainPath });
  const ctx = setupSidebarDom();
  const session = { sessionId: 'A', mergedMemberIds: [], remoteAlias: 'host', projectPath: '/project', modified: new Date().toISOString() };
  ctx.window.sessionMap.set('A', session);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [session] })], true);
  ctx.window.openSessions.set('A', { closed: false });
  ctx.window.activePtyIds.add('A');
  ctx.window.api.remoteStopSession = (alias, sessionId) => handler(null, { alias, sessionId });
  ctx.window.api.archiveSession = async (id, value) => { calls.push(['archive', id, value]); return { ok: true }; };
  t.after(() => { finishPoll?.(); indexer.dispose(); ctx.destroy(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { ...ctx, indexer, calls, attached, session, polls: () => polls, isLive: () => live, finishPoll };
}

async function archive(ctx) {
  const button = ctx.document.querySelector('#si-A .session-archive-btn');
  await button.onclick({ stopPropagation() {} });
  return button;
}

test('Archive before the first remote poll stops the live process and closes its local attach', async t => {
  const ctx = setup(t);
  assert.equal(ctx.indexer.getRemoteSessions('host').at, null);
  assert.deepEqual(ctx.indexer.getRemoteSessions('host').sessions, []);
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
  assert.equal(ctx.isLive(), false);
  assert.equal(ctx.attached.stopRequested, true);
  assert.equal(ctx.attached.exited, true);
});

test('Archive refuses a cold-cache host whose first poll fails', async t => {
  const ctx = setup(t, { pollError: 'host unreachable' });
  const button = await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(button.title, /host unreachable/);
  assert.equal(ctx.isLive(), true);
  assert.equal(ctx.attached.exited, false);
});

test('Archive counts absence after a successful first poll as done', async t => {
  const ctx = setup(t, { present: false });
  await archive(ctx);
  assert.ok(ctx.polls() > 0);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
});

test('Archive refuses a cold cache while the first poll is still in flight', async t => {
  const ctx = setup(t, { polling: true });
  const pending = ctx.indexer.refreshHostNow('host');
  const button = await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(button.title, /not yet synced/);
  ctx.finishPoll();
  await pending;
});

test('Archive preserves its attach and row if stopping after the first poll fails', async t => {
  const ctx = setup(t, { stopError: 'stop refused' });
  const button = await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A']]);
  assert.match(button.title, /stop refused/);
  assert.equal(ctx.isLive(), true);
  assert.equal(ctx.attached.exited, false);
});

test('Archive keeps an already synced absent session harmless without another poll', async t => {
  const ctx = setup(t, { present: false });
  await ctx.indexer.refreshHostNow('host');
  const polls = ctx.polls();
  await archive(ctx);
  assert.equal(ctx.polls(), polls);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
});
