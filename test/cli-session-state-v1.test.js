'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const state = require('../cli-session-state');

const ID = '01234567-89ab-cdef-0123-456789abcdef';
for (const platform of ['win32', 'linux']) {
  test(`1083FIX: ${platform} start identity ignores every non-positive-integer PID`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-pid-guard-'));
    t.after(() => { state.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    const invalid = [0, -1, 1.5, '42', null, undefined, NaN, Infinity];
    state.init({ dir, platform, activeSessions: new Map(), onIdle() {},
      readProcStart: () => '100',
      readProcessTable: async () => new Map([...invalid, 42].map(pid => [pid, { ppid: 1, created: '100' }])) });
    if (platform === 'win32') await state.refreshProcessTable({ force: true });
    for (const pid of invalid) assert.equal(state.deliveryPtyStart(pid), null, `invalid PID ${String(pid)}`);
    assert.equal(state.deliveryPtyStart(42), '100');
  });
}

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

test('status refuses two verified writers for one conversation while action retains its live refusal', async t => {
  const f = fixture(t);
  f.put(400, 100, '40', 'other', 4);
  fs.writeFileSync(path.join(f.dir, '4.json'), JSON.stringify({ pid: 4, sessionId: ID,
    kind: 'interactive', status: 'busy', statusUpdatedAt: 1001, procStart: '40' }));
  assert.equal(typeof state.readStatusEvidence, 'function');
  const result = await state.readStatusEvidence(ID, Date.now() + 2000);
  assert.equal(result?.known, false, 'competing verified writer identities do not select the first descriptor');
  assert.equal(result?.ambiguous, true);
  assert.equal((await f.live(ID, () => false)).known, true, 'action still refuses any verified live writer');
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
  state.init({ dir: f.dir, platform: 'win32', now: () => clock, activeSessions: new Map(), readParentPid: () => 1, isProcessAlive: () => true,
    readProcStartMany: async () => { probes++; clock = 20; return new Map([[300, token]]); } });
  const result = await state.liveElsewhereV1Checked(ID, () => false, () => [], { deadline: 20 });
  assert.equal(result.known, false); assert.equal(probes, 1, 'the expired action must not initiate its second native probe');
});

test('a stalled v1 native process probe returns unknown at its own action deadline', async t => {
  const f = fixture(t); const token = '134000000000000000';
  let probes = 0;
  f.write({ pid: 300, pidDomain: 'win32:anchor', procStart: token });
  state.init({ dir: f.dir, platform: 'win32', activeSessions: new Map(), readParentPid: () => 1, isProcessAlive: () => true,
    readProcStartMany: () => { probes++; return new Promise(() => {}); } });
  const pending = state.liveElsewhereV1Checked(ID, () => false, () => [], { deadline: Date.now() + 250 });
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ watchdog: true }), 500))]);
  assert.equal(probes, 1, 'the stalled native port must actually have been reached');
  assert.equal(result.known, false, 'the raw reader itself must enforce the deadline');
});

for (const anchor of [true, false]) {
  test(`Windows twice-dead ${anchor ? 'anchor' : 'unanchored'} descriptor establishes absence`, async t => {
    const f = fixture(t); let reads = 0;
    f.write(anchor ? { pid: 300, pidDomain: 'win32:anchor', procStart: '134000000000000000' } : { pid: 300 });
    state.init({ dir: f.dir, platform: 'win32', activeSessions: new Map(),
      isProcessAlive: () => { reads++; return false; }, readProcStartMany: async () => new Map() });
    assert.deepEqual(await f.live(ID, () => false), { known: true, live: null });
    assert.equal(reads, 2, 'absence requires two native PID reads');
  });
}

test('Windows twice-mismatched anchor start establishes stale absence', async t => {
  const f = fixture(t); let probes = 0;
  f.write({ pid: 300, pidDomain: 'win32:anchor', procStart: '134000000000000000' });
  state.init({ dir: f.dir, platform: 'win32', activeSessions: new Map(), isProcessAlive: () => true,
    readProcStartMany: async () => { probes++; return new Map([[300, '135000000000000000']]); } });
  assert.deepEqual(await f.live(ID, () => false), { known: true, live: null });
  assert.equal(probes, 2);
});

test('Linux mismatched start remains unknown even when native PID reads say dead', async t => {
  const f = fixture(t);
  f.write({ procStart: '31' });
  assert.equal((await f.live(ID, () => false)).known, false);
});

for (const mode of ['mixed-death', 'mixed-start', 'unreadable-start', 'replaced']) {
  test(`Windows ${mode} evidence remains unknown`, async t => {
    const f = fixture(t); let reads = 0, probes = 0;
    const token = '134000000000000000';
    f.write({ pid: 300, pidDomain: 'win32:anchor', procStart: token });
    state.init({ dir: f.dir, platform: 'win32', activeSessions: new Map(),
      isProcessAlive: () => mode === 'mixed-death' ? ++reads !== 1 : true,
      readProcStartMany: async () => {
        probes++;
        if (mode === 'replaced' && probes === 2) f.write({ pid: 300, procStart: '136000000000000000' });
        return new Map([[300, mode === 'unreadable-start' || mode === 'mixed-death' ? null
          : mode === 'mixed-start' && probes === 1 ? token : '135000000000000000']]);
      } });
    assert.equal((await f.live(ID, () => false)).known, false);
  });
}

const { createWorld } = require('./fixtures/trigger-sandbox-world.cjs');
function expireDuring(w, offset) {
  const counts = { reads: 0, afterExpiry: 0, expired: false };
  const readLink = w.procFs.readlinkSync;
  const readFile = w.procFs.readFileSync;
  w.procFs.readFileSync = (p, ...args) => { if (counts.expired) counts.afterExpiry++; return readFile(p, ...args); };
  w.procFs.readlinkSync = p => {
    if (counts.expired) counts.afterExpiry++;
    const value = readLink(p);
    if (p === '/proc/100/ns/pid' && ++counts.reads === 3) { w.setClock(w.deadline + offset); counts.expired = true; }
    return value;
  };
  return counts;
}
const observe = w => w.reader.observeTabWriterV1({ session: w.session, pty: w.session.pty, generation: 7, ptyStart: '10', deadline: w.deadline });
for (const offset of [0, 1]) {
  test(`v1 observation finishing at deadline + ${offset} returns no usable writer or identity`, t => {
    const w = createWorld(t); const counts = expireDuring(w, offset);
    const observed = observe(w);
    assert.equal(counts.expired, true);
    assert.equal(observed.uncertain, true);
    assert.equal(observed.writer, undefined);
    assert.equal(observed.identity, undefined);
    assert.equal(counts.afterExpiry, 0, 'no further proc read starts once expiry is known');
  });
}
test('v1 observation finishing just before the deadline stays usable', t => {
  const w = createWorld(t); expireDuring(w, -1);
  const observed = observe(w);
  assert.equal(observed.uncertain, false);
  assert.equal(observed.writer.sessionId, ID);
  assert.ok(observed.identity);
});
test('v1 observation expiring during the descriptor reread is refused', t => {
  const w = createWorld(t); let reads = 0;
  w.descriptorFs.readFileSync = (p, ...args) => { const value = fs.readFileSync(p, ...args); if (++reads === 2) w.expire(); return value; };
  assert.equal(observe(w).uncertain, true);
});

function addProcess(w, pid, { inner = pid, start = '5' } = {}) {
  const dir = path.join(w.root, 'proc', String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status'), `Name:\tother\nNSpid:\t${pid}\t${inner}\n`);
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (other) ${['S', 1, ...Array(17).fill('0'), start].join(' ')}`);
}
function denyNamespace(w, pid, code) {
  const readLink = w.procFs.readlinkSync;
  w.procFs.readlinkSync = p => { if (p === `/proc/${pid}/ns/pid`) throw Object.assign(new Error(code), { code }); return readLink(p); };
}
test('a process whose PID namespace link is denied but whose identity cannot match the writer does not make the scan incomplete', t => {
  const w = createWorld(t);
  addProcess(w, 900, { inner: 777 }); denyNamespace(w, 900, 'EACCES');
  const observed = observe(w);
  assert.equal(observed.uncertain, false);
  assert.equal(observed.writer.sessionId, ID);
});
test('a denied PID namespace link on a process matching the writer identity keeps the observation uncertain', t => {
  const w = createWorld(t);
  addProcess(w, 900, { inner: 3, start: '30' }); denyNamespace(w, 900, 'EACCES');
  assert.equal(observe(w).uncertain, true);
});
test('any other failure reading a process still makes the scan incomplete', t => {
  const w = createWorld(t);
  addProcess(w, 900, { inner: 777 }); denyNamespace(w, 900, 'EIO');
  assert.equal(observe(w).uncertain, true);
});

for (const code of ['ENOENT', 'ESRCH']) {
  test(`a process that exits during the scan (${code}) does not make the scan incomplete`, t => {
    const w = createWorld(t);
    addProcess(w, 900, { inner: 777 });
    const readFile = w.procFs.readFileSync;
    w.procFs.readFileSync = (p, ...args) => { if (p === '/proc/900/status') throw Object.assign(new Error(code), { code }); return readFile(p, ...args); };
    assert.equal(observe(w).uncertain, false);
  });
}

function addCompetingWriter(w) {
  w.put(400, 200, '40', 'pid:[2]', 4);
  fs.writeFileSync(path.join(w.dir, '4.json'), JSON.stringify({ pid: 4, sessionId: '11234567-89ab-cdef-0123-456789abcdef',
    kind: 'interactive', status: 'busy', statusUpdatedAt: Date.now() - 500, procStart: '40' }));
}
test('two readable descriptor writers under one PTY stay uncertain', t => {
  const w = createWorld(t); addCompetingWriter(w);
  assert.equal(observe(w).uncertain, true);
});
test('a competing descriptor writer whose PID namespace is unreadable keeps the observation uncertain', t => {
  const w = createWorld(t); addCompetingWriter(w); denyNamespace(w, 400, 'EACCES');
  assert.equal(observe(w).uncertain, true);
});
test('an expired descriptor scan starts no /proc enumeration', t => {
  const w = createWorld(t); let enumerations = 0; let reads = 0;
  w.descriptorFs.readFileSync = (p, ...args) => { const value = fs.readFileSync(p, ...args); if (++reads === 1) w.expire(); return value; };
  const readdir = w.procFs.readdirSync;
  w.procFs.readdirSync = p => { enumerations++; return readdir(p); };
  assert.equal(observe(w).uncertain, true);
  assert.equal(enumerations, 0);
});

function expireOnce(w, target, name, offset = 1) {
  const object = target === 'descriptor' ? w.descriptorFs : w.procFs;
  const original = object[name];
  const state = { fired: false, after: [] };
  object[name] = (...args) => {
    if (state.fired) state.after.push(name);
    const value = original(...args);
    if (!state.fired) { state.fired = true; w.setClock(w.deadline + offset); }
    return value;
  };
  return state;
}
function trackAfter(w, state, target, names) {
  const object = target === 'descriptor' ? w.descriptorFs : w.procFs;
  for (const name of names) {
    const original = object[name];
    object[name] = (...args) => { if (state.fired) state.after.push(name); return original(...args); };
  }
}
for (const offset of [0, 1]) {
  test(`expiry after a descriptor lstat starts no content read at deadline + ${offset}`, t => {
    const w = createWorld(t);
    const state = expireOnce(w, 'descriptor', 'lstatSync', offset);
    trackAfter(w, state, 'descriptor', ['readFileSync']);
    assert.equal(observe(w).uncertain, true);
    assert.deepEqual(state.after, []);
  });
}
for (const offset of [0, 1]) {
  test(`expiry after the descriptor revalidation lstat starts no content reread at deadline + ${offset}`, t => {
    const w = createWorld(t);
    let lstats = 0; const lstat = w.descriptorFs.lstatSync; const state = { fired: false, after: [] };
    w.descriptorFs.lstatSync = (...args) => { const value = lstat(...args); if (++lstats === 2) { state.fired = true; w.setClock(w.deadline + offset); } return value; };
    const read = w.descriptorFs.readFileSync;
    w.descriptorFs.readFileSync = (...args) => { if (state.fired) state.after.push('readFileSync'); return read(...args); };
    assert.equal(observe(w).uncertain, true);
    assert.deepEqual(state.after, []);
  });
}
for (const offset of [0, 1]) {
  test(`expiry after a /proc status read starts no stat or namespace read at deadline + ${offset}`, t => {
    const w = createWorld(t);
    const state = { fired: false, after: [] };
    const read = w.procFs.readFileSync;
    w.procFs.readFileSync = (p, ...args) => { if (state.fired) state.after.push(p); const value = read(p, ...args); if (!state.fired && p.endsWith('/status')) { state.fired = true; w.setClock(w.deadline + offset); } return value; };
    const link = w.procFs.readlinkSync;
    w.procFs.readlinkSync = p => { if (state.fired) state.after.push(p); return link(p); };
    assert.equal(observe(w).uncertain, true);
    assert.deepEqual(state.after, []);
  });
}
for (const offset of [0, 1]) {
  test(`expiry after a /proc stat read starts no namespace read at deadline + ${offset}`, t => {
    const w = createWorld(t);
    const state = { fired: false, after: [] };
    const read = w.procFs.readFileSync;
    w.procFs.readFileSync = (p, ...args) => { const value = read(p, ...args); if (!state.fired && p.endsWith('/stat')) { state.fired = true; w.setClock(w.deadline + offset); } return value; };
    const link = w.procFs.readlinkSync;
    w.procFs.readlinkSync = p => { if (state.fired) state.after.push(p); return link(p); };
    assert.equal(observe(w).uncertain, true);
    assert.deepEqual(state.after, []);
  });
}
for (const offset of [0, 1]) {
  test(`an observation already expired on entry (deadline + ${offset}) performs no I/O`, t => {
    const w = createWorld(t); let calls = 0;
    for (const object of [w.descriptorFs, w.procFs]) {
      for (const name of Object.keys(object)) {
        const original = object[name];
        if (typeof original === 'function') object[name] = (...args) => { calls++; return original(...args); };
      }
    }
    w.setClock(w.deadline + offset);
    assert.equal(observe(w).uncertain, true);
    assert.equal(calls, 0);
  });
}

for (const code of ['EACCES', 'EPERM']) {
  test(`a denied (${code}) PID namespace link on the anchor makes the observation uncertain and withholds every byte`, async t => {
    const w = createWorld(t);
    const pinned = w.pin();
    await pinned.binding.admit(w.deadline);
    pinned.binding.beginStep('private note');
    assert.equal(pinned.ctx.getCliStatus(ID).status, 'idle', 'positive control: the admitted binding is usable');
    denyNamespace(w, 100, code);
    const observed = observe(w);
    assert.equal(observed.uncertain, true);
    assert.equal(observed.identity, undefined);
    assert.equal(observed.writer, undefined);
    assert.equal(pinned.ctx.getCliStatus(ID), undefined);
    assert.throws(() => pinned.handle.write('private note'));
    assert.throws(() => pinned.handle.write('\r'));
    assert.deepEqual(w.writes, []);
  });
}
test('the same world with a readable anchor namespace link observes a usable writer', t => {
  const w = createWorld(t);
  const observed = observe(w);
  assert.equal(observed.uncertain, false);
  assert.ok(observed.identity);
});
