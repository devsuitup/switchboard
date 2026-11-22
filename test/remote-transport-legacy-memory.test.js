'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSshTransport } = require('../src/main/remote/remote-transport');

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-memory-'));
  const calls = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = createSshTransport({
    fetchTimeoutMs: 100, concurrency: 4,
    resolveScpPath: () => 'fake-scp', resolveSshPath: () => 'fake-ssh',
    spawn: (_cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null);
      fs.writeFileSync(args.at(-1), 'complete');
      calls.push({ child, legacy: args.includes('-O'), file: path.basename(args.at(-1), '.part') });
      return child;
    },
  });
  t.after(() => { transport.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    transport, dir, calls,
    fetch: names => transport.fetchFiles('host', names.map(name => `-p/${name}.jsonl`), dir),
    finish: (name, code = 0) => calls.findLast(c => c.file === `${name}.jsonl`).child.emit('close', code),
    tick: async (ms = 100) => { t.mock.timers.tick(ms); await flush(); },
  };
}

test('learned legacy survives one sequential copy timeout and the next file starts with -O', async t => {
  const f = fixture(t);
  const first = f.fetch(['a']);
  await f.tick();
  f.finish('a');
  assert.deepEqual((await first).fetched, ['-p/a.jsonl']);
  const big = f.fetch(['big']);
  await f.tick();
  await f.tick();
  assert.deepEqual(await big, { fetched: [], failed: ['-p/big.jsonl'] });
  const next = f.fetch(['next']);
  f.finish('next');
  assert.deepEqual((await next).fetched, ['-p/next.jsonl']);
  assert.equal(f.calls.at(-1).legacy, true, 'the next file must start directly in learned legacy mode');
  assert.deepEqual(f.calls.filter(c => c.file === 'big.jsonl').map(c => c.legacy), [true],
    'a legacy timeout must not retry SFTP');
  assert.equal(fs.existsSync(path.join(f.dir, '-p/big.jsonl.part')), false);
});

test('a timeout in the parallel first batch preserves the legacy mode learned by sibling copies', async t => {
  const f = fixture(t);
  const first = f.fetch(['a', 'b', 'c', 'big']);
  await f.tick();
  for (const name of ['a', 'b', 'c']) f.finish(name);
  await flush();
  await f.tick();
  const result = await first;
  assert.deepEqual(result.fetched.sort(), ['-p/a.jsonl', '-p/b.jsonl', '-p/c.jsonl']);
  assert.deepEqual(result.failed, ['-p/big.jsonl']);
  const next = f.fetch(['next']);
  f.finish('next');
  assert.deepEqual((await next).fetched, ['-p/next.jsonl']);
  assert.equal(f.calls.at(-1).legacy, true, 'a sibling timeout must not erase learned legacy mode');
});

test('a later in-flight legacy success clears timeout suppression before protocol recovery', async t => {
  const f = fixture(t);
  const big = f.fetch(['big']);
  await f.tick(50);
  const good = f.fetch(['good']);
  await f.tick(50);
  await f.tick(50);
  await f.tick(50);
  assert.deepEqual((await big).failed, ['-p/big.jsonl']);
  f.finish('good');
  await good;
  const recovery = f.fetch(['recover']);
  f.finish('recover', 1);
  await flush();
  f.finish('recover');
  await recovery;
  const next = f.fetch(['next']);
  await f.tick();
  assert.equal(f.calls.at(-1).legacy, true, 'legacy success must clear an earlier timeout suppression');
  f.finish('next');
  assert.deepEqual((await next).fetched, ['-p/next.jsonl']);
});
