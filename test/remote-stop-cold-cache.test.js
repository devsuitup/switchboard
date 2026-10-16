'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createRemoteIndexer } = require('../remote-index');
const { createSshTransport } = require('../remote-transport');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const mainPath = path.join(__dirname, '..', 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const start = mainSource.indexOf("ipcMain.handle('remote-stop-session'");
const end = mainSource.indexOf("ipcMain.handle('remote-launch-session'", start);

function setup(t, { present = true, pollError = null, stopError = null, polling = false, firstPollError = null, localFailure = false, pollLocalError = null, busyElsewhere = false, sshChild = null, configured = true, timeoutMs = 60000 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-556-'));
  let live = present;
  let polls = 0;
  let pollsAtStop = null;
  let finishPoll;
  const pollGate = (polling || busyElsewhere) ? new Promise(resolve => { finishPoll = resolve; }) : null;
  const pollsBy = {};
  const transportError = message => Object.assign(new Error(message), { remoteTransport: true });
  const indexer = createRemoteIndexer({
    scanFolders: async () => { if (localFailure) throw new Error('disk full'); },
    getHosts: () => (configured ? [{ alias: 'host' }, ...(busyElsewhere ? [{ alias: 'other' }] : [])] : []), dataDir, transport: sshChild ? createSshTransport({ spawn: () => { const child = new EventEmitter(); child.stdout = new Readable({ read() {} }); child.stderr = new Readable({ read() {} }); child.kill = () => child.emit('close', null); setImmediate(() => sshChild(child)); return child; } }) : {},
    ...(sshChild ? {} : { sync: async ({ alias }) => {
      polls++;
      pollsBy[alias] = (pollsBy[alias] || 0) + 1;
      if (alias === 'other') { await pollGate; return { fetched: 0, unchanged: 0, removed: 0, failed: 0, changedFolders: new Set(), sessions: [] }; }
      if (firstPollError && pollsBy[alias] === 1) throw transportError(firstPollError);
      if (pollLocalError) throw new Error(pollLocalError);
      if (polling && pollGate) await pollGate;
      if (pollError) throw transportError(pollError);
      return { fetched: 0, unchanged: 0, removed: 0, failed: 0, changedFolders: new Set(localFailure ? ['f'] : []), sessions: live ? [{ sessionId: 'A', pid: 100 }] : [] };
    } }),
  });
  const calls = [];
  const attached = { kind: 'remote-attach', exited: false };
  let handler;
  const main = vm.createContext({
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    remoteIndexer: indexer,
    REMOTE_STOP_SYNC_TIMEOUT_MS: timeoutMs,
    setTimeout, clearTimeout,
    remoteStopAdapter: { stop: async (alias, descriptor) => {
      pollsAtStop = polls;
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
  return {
    ...ctx, indexer, calls, attached, session, polls: () => polls, pollsAtStop: () => pollsAtStop, isLive: () => live, finishPoll,
    get notices() {
      return [...ctx.document.querySelectorAll('#app-notices .app-notice')].map(el => el.querySelector('.app-notice-message').textContent);
    },
  };
}

async function archive(ctx) {
  const button = ctx.document.querySelector('#si-A .session-archive-btn');
  await button.onclick({ stopPropagation() {} });
  return button;
}

test('the notices getter includes error, info and Undo messages', t => {
  const ctx = setup(t);
  for (const kind of ['error', 'info', 'undo']) {
    ctx.window.showAppNotice({ id: kind, kind, message: kind });
  }
  assert.deepEqual(ctx.notices, ['error', 'info', 'undo']);
});

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

test('Archive hides a cold-cache row anyway when the host fails its first poll, and says it was not stopped', async t => {
  const ctx = setup(t, { pollError: 'host unreachable' });
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.equal(ctx.isLive(), true);
  assert.equal(ctx.attached.exited, false);
  assert.equal(ctx.notices.length, 1);
  assert.match(ctx.notices[0], /not stopped/);
  assert.match(ctx.notices[0], /host did not answer \(host unreachable\)/);
});

test('Archive waits for a first poll already in flight and stops the session once it answers', async t => {
  const ctx = setup(t, { polling: true });
  const pending = ctx.indexer.refreshHostNow('host');
  const click = archive(ctx);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(ctx.calls, []);
  ctx.finishPoll();
  await pending;
  await click;
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
  assert.deepEqual(ctx.notices, []);
});

test('Archive preserves its attach and row if stopping after the first poll fails', async t => {
  const ctx = setup(t, { stopError: 'stop refused' });
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A']]);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /stop refused/);
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

test('Archive still archives a row whose host is no longer configured', async t => {
  const ctx = setup(t, { configured: false });
  const button = await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.doesNotMatch(button.title, /not yet synced/);
});

test('Archive still archives a row when the remote indexer is stopped', async t => {
  const ctx = setup(t);
  ctx.indexer.stop();
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
});

test('Archive stops waiting for a host that does not answer the first sync, then archives and says so', async t => {
  const ctx = setup(t, { polling: true, timeoutMs: 20 });
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.equal(ctx.isLive(), true);
  assert.match(ctx.notices[0], /host did not answer \(no answer within/);
});

test('Archive stops waiting for an in-flight poll that never answers, then archives and says so', async t => {
  const ctx = setup(t, { polling: true, timeoutMs: 40 });
  const pending = ctx.indexer.refreshHostNow('host');
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.match(ctx.notices[0], /host did not answer/);
  ctx.finishPoll();
  await pending;
});

test('Archive is busy while it checks the host and ignores a second click', async t => {
  const ctx = setup(t, { polling: true });
  const button = ctx.document.querySelector('#si-A .session-archive-btn');
  const first = button.onclick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, true);
  assert.match(button.title, /Checking the host/);
  await button.onclick({ stopPropagation() {} });
  assert.match(button.title, /Checking the host/);
  ctx.finishPoll();
  await first;
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Archive');
});

test('Archive re-enables its button after a refusal', async t => {
  const ctx = setup(t, { stopError: 'stop refused' });
  const button = await archive(ctx);
  assert.equal(button.disabled, false);
});

test('Archive busy state follows the live button when a re-render replaces it', async t => {
  const ctx = setup(t, { polling: true });
  const first = ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [ctx.session] })], true);
  const live = ctx.document.querySelector('#si-A .session-archive-btn');
  assert.equal(live.disabled, true);
  assert.match(live.title, /Checking the host/);
  ctx.finishPoll();
  await first;
  const after = ctx.document.querySelector('#si-A .session-archive-btn');
  assert.equal(after.disabled, false);
  assert.equal(after.title, 'Archive');
});

test('Archive reports a stop that throws instead of leaving the click unhandled', async t => {
  const ctx = setup(t);
  ctx.window.api.remoteStopSession = async () => { throw new Error('ipc broke'); };
  await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /ipc broke/);
  assert.equal(ctx.document.querySelector('#si-A .session-archive-btn').disabled, false);
});

test('Archive does not take a stale error from an earlier attempt as the answer of the poll in flight', async t => {
  const ctx = setup(t, { polling: true, firstPollError: 'old failure' });
  const first = await ctx.indexer.refreshHostNow('host');
  assert.equal(first.error, 'old failure');
  const pending = ctx.indexer.refreshHostNow('host', { force: true });
  const click = archive(ctx);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(ctx.calls, []);
  ctx.finishPoll();
  await pending;
  await click;
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
  assert.deepEqual(ctx.notices, []);
});

test('Archive refuses, as before, when the first sync fails for a local reason rather than the connection', async t => {
  const ctx = setup(t, { localFailure: true });
  await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /disk full/);
  assert.equal(ctx.notices.length, 1, 'persistent failure notice');
  const notice = ctx.document.querySelector('[data-notice-id="Archive:host:A"]');
  assert.ok(notice, 'Archive notice for this row');
  assert.match(notice.textContent, /^Archive failed.*A.*host:\/project/);
  assert.match(notice.textContent, /disk full/);
});

test('Archive refuses, as before, when the mirror write fails locally during the first sync', async t => {
  const ctx = setup(t, { pollLocalError: 'EACCES: mirror write' });
  await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /EACCES/);
  assert.equal(ctx.notices.length, 1, 'persistent failure notice');
  const notice = ctx.document.querySelector('[data-notice-id="Archive:host:A"]');
  assert.ok(notice, 'Archive notice for this row');
  assert.match(notice.textContent, /^Archive failed.*A.*host:\/project/);
  assert.match(notice.textContent, /EACCES/);
});

test('Archive asks a host in backoff even when a global poll is busy elsewhere', async t => {
  const ctx = setup(t, { busyElsewhere: true, firstPollError: 'old failure' });
  assert.equal((await ctx.indexer.refreshHostNow('host')).error, 'old failure');
  const global = ctx.indexer.refreshNow();
  await new Promise(resolve => setTimeout(resolve, 20));
  const click = archive(ctx);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(ctx.calls, []);
  ctx.finishPoll();
  await global;
  await click;
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
  assert.deepEqual(ctx.notices, []);
});

test('Archive refuses when ssh answers with a plain non-zero exit, because the host did answer', async t => {
  const ctx = setup(t, { sshChild: child => { child.stderr.push('find: permission denied'); child.stderr.push(null); child.emit('close', 1); } });
  await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /exit 1/);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /remove the host/);
  assert.equal(ctx.notices.length, 1, 'persistent failure notice');
  const notice = ctx.document.querySelector('[data-notice-id="Archive:host:A"]');
  assert.ok(notice, 'Archive notice for this row');
  assert.match(notice.textContent, /^Archive failed.*A.*host:\/project/);
  assert.match(notice.textContent, /exit 1/);
});

test('Archive refuses when the inventory is over the size cap, and says what to do', async t => {
  const ctx = setup(t, { sshChild: child => { child.stdout.push('x'.repeat(8 * 1024 * 1024 + 16)); } });
  await archive(ctx);
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /size cap/);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /remove the host/);
  assert.equal(ctx.notices.length, 1, 'persistent failure notice');
  const notice = ctx.document.querySelector('[data-notice-id="Archive:host:A"]');
  assert.ok(notice, 'Archive notice for this row');
  assert.match(notice.textContent, /^Archive failed.*A.*host:\/project/);
  assert.match(notice.textContent, /size cap/);
});

test('Archive archives with a notice when ssh itself fails to connect (exit 255)', async t => {
  const ctx = setup(t, { sshChild: child => { child.stderr.push('Connection timed out'); child.stderr.push(null); child.emit('close', 255); } });
  await archive(ctx);
  assert.deepEqual(ctx.calls, [['archive', 'A', 1]]);
  assert.match(ctx.notices[0], /host did not answer \(ssh inventory failed \(exit 255\)/);
});

test('Archive uses a poll that just finished instead of forcing a second sync', async t => {
  const ctx = setup(t, { polling: true });
  const pending = ctx.indexer.refreshHostNow('host');
  const click = archive(ctx);
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.finishPoll();
  await pending;
  await click;
  assert.equal(ctx.pollsAtStop(), 1);
  assert.deepEqual(ctx.calls, [['stop', 'host', 'A'], ['killAttach', 'A'], ['archive', 'A', 1]]);
});
