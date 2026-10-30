'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { killPty, writePty, resizePty, detachPty } = require('../pty-ops');

const root = { pid: 897, parentPid: 1, created: '100' };
const child = { pid: 898, parentPid: 897, created: '110' };
const grandchild = { pid: 899, parentPid: 898, created: '120' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ snapshot = [root, child, grandchild], survivors = [child, grandchild] } = {}) {
  const calls = [];
  let queries = 0;
  const pty = { pid: root.pid, kill() { calls.push('pty'); }, write() {}, resize() {}, _agent: {} };
  const session = { pty, kind: 'local-pty', exited: false };
  const options = {
    platform: 'win32',
    queryProcesses: async () => { calls.push(queries++ ? 'survivors' : 'snapshot'); return queries === 1 ? snapshot : survivors; },
    wait: async ms => { calls.push(['wait', ms]); },
    stopTree: async pid => { calls.push(['kill', pid]); return true; },
  };
  return { calls, pty, session, options };
}

test('snapshot precedes normal ConPTY close, then a bounded wait and survivor kills', async () => {
  const f = fixture();
  assert.equal(killPty(f.session, 'snapshot', f.options), true);
  assert.equal(killPty(f.session, 'snapshot', f.options), false);
  assert.equal(writePty(f.session, 'x'), false);
  assert.equal(resizePty(f.session, 80, 24), false);
  await flush();
  assert.deepEqual(f.calls, ['snapshot', 'pty', ['wait', 500], 'survivors', ['kill', 898], ['kill', 899]]);
});

test('creation-time mismatch and absent survivors never receive taskkill', async () => {
  const f = fixture({ survivors: [{ ...child, created: '111' }] });
  killPty(f.session, 'snapshot', f.options);
  await flush();
  assert.deepEqual(f.calls, ['snapshot', 'pty', ['wait', 500], 'survivors']);
});

test('a descendant older than the root and its subtree are excluded', async () => {
  const stale = { pid: 900, parentPid: 897, created: '99' };
  const orphan = { pid: 901, parentPid: 900, created: '130' };
  const f = fixture({ snapshot: [orphan, stale, grandchild, child, root], survivors: [stale, orphan, child] });
  killPty(f.session, 'snapshot', f.options);
  await flush();
  assert.deepEqual(f.calls, ['snapshot', 'pty', ['wait', 500], 'survivors', ['kill', 898]]);
});

test('snapshot rejection or synchronous failure still closes ConPTY without taskkill', async () => {
  for (const synchronous of [false, true]) {
    const f = fixture();
    f.options.queryProcesses = () => {
      f.calls.push('snapshot');
      if (synchronous) throw new Error('spawn failed');
      return Promise.reject(new Error('timeout'));
    };
    assert.equal(killPty(f.session, 'snapshot', f.options), true);
    await flush();
    assert.deepEqual(f.calls, ['snapshot', 'pty']);
  }
});

test('native exit observed during snapshot closes ConPTY without survivor query or kill', async () => {
  const f = fixture();
  const query = f.options.queryProcesses;
  f.options.queryProcesses = async () => { const rows = await query(); f.pty._agent.exitCode = 0; return rows; };
  killPty(f.session, 'snapshot', f.options);
  await flush();
  assert.deepEqual(f.calls, ['snapshot', 'pty']);
});

test('native exit already observed means no snapshot and no survivor kill', async () => {
  for (const exitCode of [0, 1]) {
    const f = fixture();
    f.pty._agent.exitCode = exitCode;
    killPty(f.session, 'snapshot', f.options);
    await flush();
    assert.deepEqual(f.calls, ['pty']);
  }
});

test('all excluded session states and non-Windows closes remain immediate', async () => {
  for (const extra of [{ exited: true }, { isAttach: true }, { detaching: true }, { backgrounding: true },
    { backgrounded: true }, { host: 'host' }, { kind: 'remote-attach' }]) {
    const f = fixture();
    Object.assign(f.session, extra);
    killPty(f.session, 'snapshot', f.options);
    await flush();
    assert.deepEqual(f.calls, ['pty']);
  }
  const f = fixture();
  killPty(f.session, 'snapshot', { ...f.options, platform: 'linux' });
  assert.deepEqual(f.calls, ['pty']);
});

test('root missing from snapshot and survivor lookup failure only close ConPTY', async () => {
  const f = fixture({ snapshot: [child] });
  killPty(f.session, 'snapshot', f.options);
  await flush();
  assert.deepEqual(f.calls, ['snapshot', 'pty']);
  const g = fixture();
  const query = g.options.queryProcesses;
  let queries = 0;
  g.options.queryProcesses = () => ++queries === 1 ? query() : Promise.reject(new Error('lookup failed'));
  killPty(g.session, 'snapshot', g.options);
  await flush();
  assert.deepEqual(g.calls, ['snapshot', 'pty', ['wait', 500]]);
});

test('loss of ownership during snapshot suppresses all survivor work and closes the original PTY', async () => {
  for (const change of [s => { s.exited = true; }, s => { s.pty = { pid: 897 }; }, s => { s.pty.pid++; }]) {
    const f = fixture();
    let finish;
    f.options.queryProcesses = () => { f.calls.push('snapshot'); return new Promise(resolve => { finish = resolve; }); };
    killPty(f.session, 'snapshot', f.options);
    change(f.session);
    finish([root, child]);
    await flush();
    assert.deepEqual(f.calls, ['snapshot', 'pty']);
  }
});

test('detach write failure takes the immediate PTY-only fallback', () => {
  const f = fixture();
  f.pty.write = () => { throw new Error('closed'); };
  assert.equal(detachPty(f.session, 'snapshot'), true);
  assert.deepEqual(f.calls, ['pty']);
});
