// see docs/decisions/0003-trigger-delivery-per-tab.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { resolveContinuations, resolveContinuationsSync, scanContinuationIndex } = require('../session-continuations');
const { createTriggerContext } = require('../trigger-context');

function fixture(t, edges) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-592-continuation-'));
  const folder = path.join(projectsDir, 'proj');
  fs.mkdirSync(folder);
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  for (const [id, children] of Object.entries(edges)) {
    fs.writeFileSync(path.join(folder, id + '.jsonl'), children.map(child => JSON.stringify({
      type: 'continued-in', sessionId: id, continuedInSessionId: child,
    })).join('\n') + '\n');
  }
  return { projectsDir, node(id) {
    const file = path.join(folder, id + '.jsonl');
    return fs.existsSync(file) ? { index: JSON.parse(scanContinuationIndex(file, id)) } : { missing: true };
  } };
}

function deliveryContext(f, writer, createContext = createTriggerContext) {
  const session = { generation: 1, host: null, projectFolder: 'proj', pty: { pid: process.pid, write() {} } };
  return createContext({ activeSessions: new Map([['a', session]]), projectsDir: f.projectsDir,
    isPtyAlive: () => true,
    cliSessionState: { deliveryPtyStart: () => 'start', findDeliveryTab: () => ({}), refreshProcessTable: async () => {} },
    observeTabWriter: () => ({ writer: { sessionId: writer }, identity: '200:200' }),
  });
}

async function admit(ctx) {
  const pinned = ctx.pinDelivery('a', ctx.getPtyForSession('a'), false);
  await pinned.binding.admit(Date.now() + 1000);
}

test('ADR growing 40 MiB transcript: the second trigger reads only appended data and validation bytes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t, { a: ['b'], b: [] });
  const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
  const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4000) } }) + '\n';
  fs.appendFileSync(file, line.repeat(Math.ceil(40 * 1024 * 1024 / line.length)));
  const ctx = deliveryContext(f, 'b');
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args); bytes += n; return n; });
  await admit(ctx);
  assert.ok(bytes >= 40 * 1024 * 1024);
  bytes = 0;
  await admit(ctx);
  assert.equal(bytes, 0);
  for (let i = 0; i < 2; i++) {
    fs.appendFileSync(file, line);
    bytes = 0;
    await admit(ctx);
    assert.ok(bytes >= Buffer.byteLength(line));
    assert.ok(bytes <= Buffer.byteLength(line) + 256, `append read ${bytes} bytes`);
  }
});

test('ADR admission: a writer already naming the requested id reads no continuation transcript', async t => {
  const f = fixture(t, { a: [] });
  const ctx = deliveryContext(f, 'a');
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args); bytes += n; return n; });
  await admit(ctx);
  assert.equal(bytes, 0);
});

test('ADR continuation cache: retained bytes evict the oldest index before the entry limit', async t => {
  const f = fixture(t, { b: [] });
  const ctx = deliveryContext(f, 'b');
  const line = JSON.stringify({ type: 'assistant', content: 'x'.repeat(1024 * 1024 - 64) });
  const admitId = async id => {
    const entry = ctx.getPtyForSession('a');
    const pinned = ctx.pinDelivery(id, entry, false);
    await pinned.binding.admit(Date.now() + 1000);
  };
  for (let i = 0; i < 25; i++) {
    const id = 'root' + i;
    fs.writeFileSync(path.join(f.projectsDir, 'proj', id + '.jsonl'),
      JSON.stringify({ type: 'continued-in', sessionId: id, continuedInSessionId: 'b' }) + '\n' + line);
    await admitId(id);
  }
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args); bytes += n; return n; });
  await admitId('root24');
  assert.equal(bytes, 0, 'newest index stays retained');
  await admitId('root0');
  assert.ok(bytes >= Buffer.byteLength(line), `oldest index must rescan after byte eviction, read ${bytes}`);
});

test('ADR continuation cache: an unfinished line resumes from the retained serialized index', async t => {
  const f = fixture(t, { a: ['b'], b: [] });
  const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
  const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4000) } }) + '\n';
  fs.appendFileSync(file, line.repeat(1024) + '{"type":"continued-in",');
  const ctx = deliveryContext(f, 'b');
  await admit(ctx);
  const append = '"sessionId":"a","continuedInSessionId":"b"}\n';
  fs.appendFileSync(file, append);
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args); bytes += n; return n; });
  await admit(ctx);
  assert.ok(bytes <= Buffer.byteLength(append) + 256, `unfinished line read ${bytes} bytes`);
});

for (const change of ['dev', 'rounded inode collision', 'birth time', 'nanosecond mtime']) {
  test(`#652 continuation cache: ${change} invalidates equal-size, equal-millisecond evidence`, t => {
    const f = fixture(t, { a: ['b'], b: [], c: [] });
    const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
    const content = '{}\n'.repeat(32) + fs.readFileSync(file, 'utf8') + '{}\n'.repeat(32);
    fs.writeFileSync(file, content);
    const inode = 2n ** 53n;
    assert.equal(Number(inode), Number(inode + 1n));
    const stat = fs.statSync;
    let replaced = false;
    t.mock.method(fs, 'statSync', (name, options) => {
      const result = stat(name, options);
      if (name !== file) return result;
      const dev = 1n + (replaced && change === 'dev' ? 1n : 0n);
      const ino = inode + (replaced && change === 'rounded inode collision' ? 1n : 0n);
      const birthtimeNs = 1_000_000_000n + (replaced && change === 'birth time' ? 1n : 0n);
      const mtimeNs = 2_000_000_000n + (replaced && change === 'nanosecond mtime' ? 1n : 0n);
      return Object.assign(result, options?.bigint
        ? { dev, ino, birthtimeNs, mtimeNs }
        : { dev: Number(dev), ino: Number(ino), birthtimeMs: 1000, mtimeMs: 2000, mtime: new Date(2000) });
    });
    const ctx = deliveryContext(f, 'b');
    const written = [];
    t.mock.method(ctx.getPtyForSession('a').ptyProcess, 'write', data => written.push(data));
    const write = () => {
      const pinned = ctx.pinDelivery('a', ctx.getPtyForSession('a'), false);
      pinned.binding.beginStep('prompt');
      pinned.handle.write('prompt');
    };
    write();
    assert.deepEqual(written, ['prompt']);
    fs.renameSync(file, file + '.previous');
    fs.writeFileSync(file, content.replace('"b"', '"c"'));
    replaced = true;
    assert.throws(write, /ownership writer/, 'the replaced transcript must revoke the old continuation');
    assert.deepEqual(written, ['prompt'], 'no bytes may reach the old continuation after replacement');
  });
}

for (const change of ['dev', 'ino', 'birthtimeNs', 'mtimeNs']) {
  test(`#652 continuation scan: changed ${change} in the final stat leaves ownership unknown`, t => {
    const f = fixture(t, { a: ['b'], b: [] });
    const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
    const stat = fs.statSync;
    let calls = 0;
    t.mock.method(fs, 'statSync', (name, options) => {
      const result = stat(name, options);
      if (name === file && ++calls >= 3 && options?.bigint) result[change] += 1n;
      return result;
    });
    const ctx = deliveryContext(f, 'b');
    const entry = ctx.getPtyForSession('a');
    entry.keyKind = 'historical';
    const written = [];
    t.mock.method(entry.ptyProcess, 'write', data => written.push(data));
    const pinned = ctx.pinDelivery('a', entry, false);
    pinned.binding.beginStep('prompt');
    assert.throws(() => pinned.handle.write('prompt'), /ownership.*unknown/);
    assert.deepEqual(written, []);
  });
}

for (const change of ['truncate', 'replace', 'different head']) {
  test(`ADR continuation cache ${change}: changed evidence rescans from byte zero`, async t => {
    const f = fixture(t, { a: ['b'], b: [], c: [] });
    const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
    fs.appendFileSync(file, '{}\n'.repeat(1024));
    const ctx = deliveryContext(f, 'b');
    await admit(ctx);
    const content = fs.readFileSync(file, 'utf8').replace('"b"', '"c"');
    if (change === 'truncate') fs.writeFileSync(file, content.slice(0, content.indexOf('\n') + 1));
    else if (change === 'replace') {
      const replacement = file + '.replacement';
      fs.writeFileSync(replacement, content + '{}\n');
      fs.renameSync(replacement, file);
    } else {
      const fd = fs.openSync(file, 'r+');
      try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
      fs.appendFileSync(file, '{}\n');
    }
    const read = fs.readSync;
    const positions = [];
    t.mock.method(fs, 'readSync', (...args) => { if (args[3] > 64) positions.push(args[4]); return read(...args); });
    await assert.rejects(admit(ctx), /ownership writer/);
    assert.equal(positions[0], 0);
  });
}

test('ADR continuation size cap: a 65 MiB uncontinued conversation refuses a foreign writer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t, { a: [] });
  const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
  const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4000) } }) + '\n';
  fs.appendFileSync(file, line.repeat(Math.ceil(65 * 1024 * 1024 / line.length)));
  const ctx = deliveryContext(f, 'foreign');
  const pinned = ctx.pinDelivery('a', ctx.getPtyForSession('a'), false);
  const written = [];
  t.mock.method(pinned.binding.tab.pty, 'write', data => written.push(data));
  await assert.rejects(pinned.binding.admit(Date.now() + 1000), /ownership writer/);
  pinned.binding.beginStep('prompt');
  assert.throws(() => pinned.handle.write('prompt'), /ownership writer/);
  assert.deepEqual(written, []);
});

test('ADR continuation size cap: the production limit is 512 MiB', () => {
  const source = fs.readFileSync(require.resolve('../trigger-context'), 'utf8');
  const expression = source.match(/let remainingBytes = ([^;]+);/);
  assert.ok(expression, 'production scan limit must be declared');
  assert.equal(vm.runInNewContext(expression[1]), 512 * 1024 * 1024);
});

test('ADR continuation size cap: over 512 MiB is unresolved and refuses an alias without bytes', { timeout: 30000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture(t, { a: [] });
  const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
  fs.appendFileSync(file, '{}\n'.repeat(1024 * 1024));
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (...args) => {
    const result = stat(...args);
    if (args[0] === file) result.size = args[1]?.bigint ? 512n * 1024n * 1024n + 1n : 512 * 1024 * 1024 + 1;
    return result;
  });
  const graphs = [];
  const filename = require.resolve('../trigger-context');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: id => {
    const loaded = localRequire(id);
    if (id !== './session-continuations') return loaded;
    return { ...loaded, resolveContinuationsSync: (...args) => {
      const graph = loaded.resolveContinuationsSync(...args);
      graphs.push(graph);
      return graph;
    } };
  }, setTimeout, clearTimeout, Date, Buffer }, { filename });
  const ctx = deliveryContext(f, 'foreign', module.exports.createTriggerContext);
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args); bytes += n; return n; });
  await admit(ctx);
  assert.ok(graphs.length > 0);
  assert.ok(graphs.every(graph => graph.unresolved === true));
  assert.equal(bytes, 0);
  const entry = ctx.getPtyForSession('a');
  entry.keyKind = 'historical';
  const pinned = ctx.pinDelivery('a', entry, false);
  const written = [];
  t.mock.method(pinned.binding.tab.pty, 'write', data => written.push(data));
  const refusal = assert.rejects(pinned.binding.admit(Date.now() + 1000), /ownership.*deadline/);
  let finished = false;
  refusal.then(() => { finished = true; }, () => { finished = true; });
  for (let elapsed = 0; elapsed < 1100 && !finished; elapsed += 10) {
    t.mock.timers.tick(10);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(finished, 'unresolved alias must refuse at the deadline');
  await refusal;
  assert.ok(graphs.every(graph => graph.unresolved === true));
  pinned.binding.beginStep('prompt');
  assert.throws(() => pinned.handle.write('prompt'), /ownership.*unknown/);
  assert.throws(() => pinned.handle.write('\r'), /ownership.*unknown/);
  assert.deepEqual(written, []);
  assert.equal(bytes, 0);
});

test('ADR continuation cache: new bindings reuse complete indexes and invalidate size and mtime changes', t => {
  const f = fixture(t, { a: [], b: [] });
  const bytes = [];
  const session = { generation: 1, host: null, projectFolder: 'proj',
    pty: { pid: process.pid, write(data) { bytes.push(data); } } };
  const ctx = createTriggerContext({ activeSessions: new Map([['a', session]]),
    projectsDir: f.projectsDir, isPtyAlive: () => true,
    cliSessionState: { deliveryPtyStart: () => 'start' },
    observeTabWriter: () => ({ writer: { sessionId: 'b' }, identity: '200:200' }),
  });
  const write = () => {
    const pinned = ctx.pinDelivery('a', ctx.getPtyForSession('a'), false);
    pinned.binding.beginStep('prompt');
    pinned.handle.write('prompt');
  };
  const read = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (...args) => { reads++; return read(...args); });
  assert.throws(write, /ownership writer/);
  assert.ok(reads > 0);
  reads = 0;
  assert.throws(write, /ownership writer/);
  assert.equal(reads, 0);
  const file = path.join(f.projectsDir, 'proj', 'a.jsonl');
  const record = JSON.stringify({ type: 'continued-in', sessionId: 'a', continuedInSessionId: 'b' }) + '\n';
  fs.appendFileSync(file, record);
  write();
  assert.deepEqual(bytes, ['prompt']);
  assert.ok(reads > 0);
  const before = fs.statSync(file);
  fs.writeFileSync(file, '\n' + record.replace('"b"', '"c"'));
  assert.equal(fs.statSync(file).size, before.size);
  fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
  fs.writeFileSync(path.join(f.projectsDir, 'proj', 'c.jsonl'), '\n');
  assert.throws(write, /ownership writer/);
  assert.deepEqual(bytes, ['prompt']);
});

test('ADR missing branch: delivery exposes incomplete reachability without changing restore selection', async t => {
  const f = fixture(t, { a: ['b', 'missing'], b: [] });
  const restore = await resolveContinuations('a', f.node);
  assert.equal(restore.unresolved, false);
  assert.deepEqual(restore.candidates.map(node => node.sessionId), ['b']);
  assert.equal(Object.hasOwn(restore, 'incomplete'), false);
  const graph = resolveContinuationsSync('a', f.node, { includeReachable: true });
  assert.equal(graph.incomplete, true, JSON.stringify(graph));
  assert.deepEqual(graph.reachable, ['a', 'b']);
});

for (const key of ['direct', 'historical']) {
  for (const writer of ['b', 'foreign']) {
    test(`ADR missing branch ${key}/${writer}: reachable writer delivers and unproven foreign stays unknown`, async t => {
      const f = fixture(t, { a: ['b', 'missing'], b: [], foreign: [] });
      const bytes = [];
      const session = { generation: 1, host: null, projectFolder: 'proj',
        pty: { pid: process.pid, write(data) { bytes.push(data); } } };
      const ctx = createTriggerContext({ activeSessions: new Map([[key === 'direct' ? 'a' : writer, session]]),
        projectsDir: f.projectsDir, isPtyAlive: () => true,
        resolveSessionId: id => id === 'a' && key === 'historical' ? writer : id,
        cliSessionState: { deliveryPtyStart: () => 'start', refreshProcessTable: async () => {} },
        observeTabWriter: () => ({ writer: { sessionId: writer, pid: 200, procStart: '200' }, identity: '200:200' }),
      });
      const delivery = ctx.pinDelivery('a', ctx.getPtyForSession('a'), false);
      delivery.binding.beginStep('prompt');
      if (key === 'historical' && writer === 'foreign') {
        await assert.rejects(delivery.binding.prepareText(Date.now() + 40), /ownership.*deadline/);
        assert.throws(() => delivery.handle.write('\r'), /ownership.*unknown/);
        assert.deepEqual(bytes, []);
      } else {
        delivery.handle.write('prompt');
        delivery.handle.write('\r');
        assert.deepEqual(bytes, ['prompt', '\r']);
        assert.equal(delivery.binding.effectiveId, writer === 'b' ? 'b' : 'a');
      }
    });
  }
}
