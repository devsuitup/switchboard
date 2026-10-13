// see docs/decisions/0003-trigger-delivery-per-tab.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
