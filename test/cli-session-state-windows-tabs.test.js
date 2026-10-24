'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli-session-state');
const { createTriggerContext } = require('../trigger-context');
const { start } = require('../trigger-watcher');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture(t, { root = 'Electron', count = 3, parent, malformed = false } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-windows-tabs-')));
  const descriptors = path.join(dir, 'sessions');
  const triggers = path.join(dir, 'triggers');
  fs.mkdirSync(descriptors);
  fs.mkdirSync(triggers);
  const rootPid = root === 'Electron' ? 5592 : 12660;
  const absentParent = root === 'Electron' ? 15044 : 12564;
  const created = order => String(134373885000000000n + BigInt(order) * 10000000n);
  const rows = [[rootPid, absentParent, created(0), root === 'Electron' ? 'Switchboard.exe' : 'explorer.exe']];
  const tabs = Array.from({ length: count }, (_, index) => {
    const ptyPid = 7432 + index * 100;
    const writerPid = 10840 + index * 100;
    const sessionId = `windows-tab-${index}`;
    const status = index === 0 ? 'waiting' : 'idle';
    rows.push([ptyPid, rootPid, created(1), `bash.exe -l -i -c "claude --resume ${sessionId}"`],
      [ptyPid + 1, ptyPid, created(2), `sh.exe -c "claude --resume ${sessionId}"`],
      [writerPid, ptyPid + 1, created(3), `claude.exe --resume ${sessionId}`]);
    fs.writeFileSync(path.join(descriptors, `${writerPid}.json`), JSON.stringify({ pid: writerPid,
      sessionId, kind: 'interactive', pidDomain: 'win32:anchor', procStart: created(3), status,
      statusUpdatedAt: Date.now() }));
    const written = [];
    return { writerPid, status, written, generation: 1, realSessionId: sessionId, cwd: dir, host: null,
      pty: { pid: ptyPid, write: data => written.push(data) } };
  });
  const table = cli.parseProcessTable(rows.map(([pid, ppid, stamp, command]) => `${pid} ${ppid} ${stamp}\t${command}`).join('\r\n'));
  if (malformed) table.get(rootPid).ppid = parent;
  let clock = Date.now() + 10000;
  let refreshBlocked = false;
  cli.init({ dir: descriptors, platform: 'win32', ownPid: rootPid, now: () => clock,
    isProcessAlive: () => true, readProcessTable: async () => {
      if (refreshBlocked) throw new Error('process table unavailable');
      return table;
    } });
  await cli.refreshProcessTable();
  const ctx = createTriggerContext({ activeSessions: new Map(tabs.map(tab => [tab.realSessionId, tab])),
    cliSessionState: cli, log: silent, isPtyAlive: () => true,
    getCliStatus: id => ({ status: tabs.find(tab => tab.realSessionId === id)?.status }) });
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  const watcher = start(ctx);
  t.after(() => {
    watcher.close();
    cli.stop();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function dispatch(index, payload) {
    const name = `tab-${index}.json`;
    fs.writeFileSync(path.join(triggers, name), JSON.stringify({ sessionId: tabs[index].realSessionId, ...payload }));
    const result = path.join(triggers, 'processed', `tab-${index}.result.json`);
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(result)) {
      assert.ok(performance.now() < deadline, 'trigger must produce a result');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  }
  return { tabs, ctx, dispatch, stale() { clock += 3001; refreshBlocked = true; } };
}

for (const root of ['Electron', 'Explorer']) {
  for (const count of [2, 3]) {
    test(`Windows ${count} interactive tabs under ${root} with an exited parent each select their own writer`, async t => {
      const f = await fixture(t, { root, count });
      for (const tab of f.tabs) {
        assert.equal(cli.observeTabWriter(tab.pty.pid).writer?.pid, tab.writerPid);
        assert.equal(cli.findDeliveryTab(tab.realSessionId, f.tabs).tab, tab);
      }
    });
  }

  test(`Windows multi-session ${root} tree delivers exactly one Escape to its waiting tab`, async t => {
    const f = await fixture(t, { root });
    const result = await f.dispatch(0, { key: 'escape' });
    assert.equal(result.ok, true);
    assert.deepEqual(f.tabs.map(tab => tab.written), [['\x1b'], [], []]);
  });

  test(`Windows multi-session ${root} tree refuses idle Escape with status idle`, async t => {
    const f = await fixture(t, { root });
    const result = await f.dispatch(1, { key: 'escape' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session not waiting on a dialog (status: idle)');
    assert.deepEqual(f.tabs.map(tab => tab.written), [[], [], []]);
  });

  test(`Windows multi-session ${root} tree proves command ownership and delivers through descriptor fallback`, async t => {
    const f = await fixture(t, { root });
    const tab = f.tabs[1];
    const fallback = await f.ctx.lookupDeliveryFallback(tab.realSessionId, Date.now() + 1000);
    assert.equal(fallback.entry?.session, tab);
    const pinned = f.ctx.pinDelivery(tab.realSessionId, fallback.entry);
    await pinned.binding.admit(Date.now() + 1000);
    pinned.binding.beginStep('hello');
    assert.equal(pinned.handle.write('hello').outcome, 'mine');
    assert.equal(pinned.handle.write('\r').outcome, 'mine');
    assert.deepEqual(f.tabs.map(tab => tab.written), [[], ['hello', '\r'], []]);
  });
}

test('Windows multi-session stale table keeps command ownership unknown, allows direct command and refuses alias and Escape', async t => {
  const f = await fixture(t);
  f.stale();
  assert.equal(cli.observeTabWriter(f.tabs[0].pty.pid).writer, undefined);
  const direct = f.ctx.pinDelivery(f.tabs[1].realSessionId, f.ctx.getPtyForSession(f.tabs[1].realSessionId));
  await direct.binding.admit(Date.now() + 1000);
  direct.binding.beginStep('hello');
  assert.equal(direct.handle.write('hello').outcome, 'unknown');
  const alias = f.ctx.pinDelivery(f.tabs[1].realSessionId,
    { ...f.ctx.getPtyForSession(f.tabs[1].realSessionId), keyKind: 'historical' });
  alias.binding.beginStep('hello');
  assert.throws(() => alias.handle.write('hello'), /ownership of the pinned alias writer is unknown/);
  const result = await f.dispatch(0, { key: 'escape' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session not waiting on a dialog (status: unknown)');
  assert.deepEqual(f.tabs.map(tab => tab.written), [[], ['hello'], []]);
});

for (const parent of [undefined, NaN, 'unparsable']) {
  test(`Windows multi-session root row with parent ${String(parent)} remains unknown`, async t => {
    const f = await fixture(t, { malformed: true, parent });
    assert.equal(cli.observeTabWriter(f.tabs[0].pty.pid).writer, undefined);
    const result = await f.dispatch(0, { key: 'escape' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session not waiting on a dialog (status: unknown)');
    assert.deepEqual(f.tabs.map(tab => tab.written), [[], [], []]);
  });
}
