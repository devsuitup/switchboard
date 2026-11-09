'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const state = require('../cli-session-state');

const ID = '01234567-89ab-cdef-0123-456789abcdef';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-v1-'));
  t.after(() => { state.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const procs = new Map();
  const put = (pid, parent, start, ns, inner = pid) => procs.set(pid, { parent, start, ns, inner });
  put(100, 1, '10', 'host');
  put(200, 100, '20', 'box', 2);
  put(300, 200, '30', 'box', 3);
  const procFs = {
    readdirSync: () => [...procs.keys()].map(String),
    readlinkSync(file) { return procs.get(Number(file.split('/')[2]))?.ns ?? fail(); },
    readFileSync(file) {
      const p = procs.get(Number(file.split('/')[2]));
      if (!p) return fail();
      if (file.endsWith('/status')) return `NSpid:\t${file.split('/')[2]}\t${p.inner}\n`;
      const fields = [p.state || 'S', p.parent, ...Array(17).fill('0'), p.start];
      return `0 (claude) ${fields.join(' ')}`;
    },
  };
  function fail() { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }
  const write = (extra = {}) => fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: ID,
    kind: 'interactive', status: 'idle', statusUpdatedAt: 1000, procStart: '30', ...extra }));
  write();
  state.init({ dir, platform: 'linux', activeSessions: new Map(), isProcessAlive: () => false,
    readProcStart: pid => procs.get(pid)?.start, readParentPid: pid => procs.get(pid)?.parent,
    readCliProcess: () => false, v1ProcFs: procFs });
  const live = (...args) => (state.liveElsewhereV1Checked || state.liveElsewhereChecked)(...args);
  const observe = (...args) => state.observeTabWriterV1 ? state.observeTabWriterV1(...args) : state.observeTabWriter(100);
  return { dir, procs, procFs, put, write, live, observe };
}

test('raw namespace writer is live without a host PID or local PTY', async t => {
  const f = fixture(t);
  const result = await f.live(ID.toUpperCase(), () => false, () => [], { deadline: Date.now() + 1000 });
  assert.equal(result.known, true);
  assert.equal(result.live?.pid, 300);
  assert.equal(result.live?.rawPid, 3);
});
for (const mode of ['zero', 'multiple', 'no-start', 'malformed', 'unreadable', 'deadline', 'replaced', 'zombie']) {
  test(`unresolved ${mode} evidence cannot establish absence`, async t => {
    const f = fixture(t);
    if (mode === 'zero') f.procs.delete(300);
    if (mode === 'multiple') f.put(400, 100, '30', 'other', 3);
    if (mode === 'no-start') f.write({ procStart: null });
    if (mode === 'zombie') f.procs.get(300).state = 'Z';
    if (mode === 'malformed') { fs.unlinkSync(path.join(f.dir, '3.json')); fs.writeFileSync(path.join(f.dir, '4.json'), '{'); }
    if (mode === 'unreadable') f.procFs.readdirSync = () => { throw new Error('denied'); };
    if (mode === 'replaced') {
      const read = f.procFs.readFileSync;
      f.procFs.readFileSync = file => { const value = read(file); if (file === '/proc/300/stat') f.write({ procStart: '31' }); return value; };
    }
    const result = await f.live(ID, () => false, () => [], { deadline: mode === 'deadline' ? 0 : Date.now() + 1000 });
    assert.equal(result.known, false, `${mode} is unknown, never known absence/live`);
  });
}
test('complete empty descriptor directory establishes absence', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, '3.json'));
  assert.deepEqual(await f.live(ID, () => false), { known: true, live: null });
});
test('only the matching conversation PTY excludes a proven writer', async t => {
  const f = fixture(t);
  assert.equal((await f.live(ID, () => false, () => [100])).live, null);
  assert.equal((await f.live(ID, () => false, () => [999])).live?.pid, 300);
});
test('tracked schedules survive absence of all descriptors', async t => {
  const f = fixture(t);
  const child = new EventEmitter(); child.pid = 999;
  state.trackScheduleRun(ID, child, f.dir, 'job');
  t.after(() => child.emit('exit'));
  fs.unlinkSync(path.join(f.dir, '3.json'));
  assert.equal((await f.live(ID, () => false)).live.kind, 'schedule');
});
test('PTY sandbox observation translates PID and returns the same proven status', t => {
  const f = fixture(t);
  const pty = { pid: 100 };
  const session = { pty, generation: 7, sandbox: true };
  const result = f.observe({ session, pty, generation: 7, ptyStart: '10', deadline: Date.now() + 1000 });
  assert.equal(result.uncertain, false);
  assert.equal(result.writer?.pid, 300);
  assert.equal(result.writer?.rawPid, 3);
  assert.equal(result.writer?.status, 'idle');
  assert.equal(result.writer?.statusUpdatedAt, 1000);
});
for (const mode of ['same-namespace', 'wrong-parent', 'reused-pty', 'changed-generation', 'nested-cli', 'background', 'zombie', 'parent-exited']) {
  test(`sandbox proof rejects ${mode}`, t => {
    const f = fixture(t);
    const pty = { pid: 100 };
    const session = { pty, generation: 7, sandbox: true };
    if (mode === 'same-namespace') f.procs.get(300).ns = 'host';
    if (mode === 'wrong-parent') f.procs.get(300).parent = 1;
    if (mode === 'reused-pty') f.procs.get(100).start = '11';
    if (mode === 'changed-generation') session.generation = 8;
    if (mode === 'nested-cli') {
      fs.writeFileSync(path.join(f.dir, '2.json'), JSON.stringify({ pid: 2, procStart: '20', kind: 'interactive', sessionId: 'other', status: 'idle' }));
    }
    if (mode === 'background') f.write({ kind: 'bg' });
    if (mode === 'zombie') f.procs.get(300).state = 'Z';
    if (mode === 'parent-exited') f.procs.get(200).state = 'Z';
    const result = f.observe({ session, pty, generation: 7, ptyStart: '10', deadline: Date.now() + 1000 });
    if (mode === 'nested-cli') {
      assert.equal(result.writer?.pid, 200, 'only the nearest interactive writer owns the PTY');
    } else {
      assert.equal(result.writer, undefined, 'unproven or ineligible writer supplies no status');
      assert.equal(result.uncertain, true);
    }
  });
}

test('v1 native process rechecks do not start another probe after the shared deadline', async t => {
  const f = fixture(t); let clock = 10, probes = 0;
  const token = '134000000000000000';
  f.write({ pid: 300, pidDomain: 'win32:anchor', procStart: token });
  state.init({ dir: f.dir, platform: 'win32', now: () => clock, activeSessions: new Map(), readParentPid: () => 1,
    readProcStartMany: async () => { probes++; clock = 20; return new Map([[300, token]]); } });
  const result = await state.liveElsewhereV1Checked(ID, () => false, () => [], { deadline: 20 });
  assert.equal(result.known, false); assert.equal(probes, 1, 'the expired action must not initiate its second native probe');
});

test('a stalled v1 native process probe returns unknown at its own action deadline', async t => {
  const f = fixture(t); const token = '134000000000000000';
  let probes = 0;
  f.write({ pid: 300, pidDomain: 'win32:anchor', procStart: token });
  state.init({ dir: f.dir, platform: 'win32', activeSessions: new Map(), readParentPid: () => 1,
    readProcStartMany: () => { probes++; return new Promise(() => {}); } });
  const pending = state.liveElsewhereV1Checked(ID, () => false, () => [], { deadline: Date.now() + 250 });
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ watchdog: true }), 500))]);
  assert.equal(probes, 1, 'the stalled native port must actually have been reached');
  assert.equal(result.known, false, 'the raw reader itself must enforce the deadline');
});
