'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createSshTransport } = require('../src/main/remote/remote-transport');

function running(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

test('real scp tree timeout starts legacy promptly and leaves no running descendants', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-real-tree-'));
  const pidFile = path.join(dir, 'pids.json');
  const children = [];
  const calls = [];
  const start = Date.now();
  let guard;
  const transport = createSshTransport({
    fetchTimeoutMs: 1000,
    resolveScpPath: () => 'fake-scp', resolveSshPath: () => 'fake-ssh',
    spawn: (_cmd, args, options) => {
      calls.push({ at: Date.now() - start, legacy: args.includes('-O') });
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/scp-stderr-holder.cjs'), pidFile, ...args], options);
      children.push(child);
      return child;
    },
  });
  const pids = () => [...new Set([
    ...children.map(c => c.pid).filter(Number.isSafeInteger),
    ...(fs.existsSync(pidFile) ? JSON.parse(fs.readFileSync(pidFile, 'utf8')) : []),
  ])];
  t.after(async () => {
    clearTimeout(guard);
    transport.dispose();
    const owned = pids();
    for (const pid of owned) {
      if (running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
    const deadline = Date.now() + 2000;
    while (owned.some(running) && Date.now() < deadline) await delay(20);
    assert.deepEqual(owned.filter(running), [], 'PID-only cleanup must leave no test process running');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pending = transport.fetchFiles('host', ['-p/a.jsonl'], dir);
  const result = await Promise.race([pending, new Promise(resolve => { guard = setTimeout(() => resolve(null), 4000); })]);
  clearTimeout(guard);
  assert.ok(fs.existsSync(pidFile), 'the real fake scp must have started its stderr-holding descendant');
  const retry = calls.find(c => c.legacy);
  t.diagnostic(`legacy retry started at ${retry?.at ?? 'never'} ms (timeout 1000 ms)`);
  assert.ok(retry && retry.at < 2200, 'legacy retry must start within timeout + 1200 ms, despite inherited stderr');
  assert.deepEqual(result, { fetched: ['-p/a.jsonl'], failed: [] });
  assert.equal(fs.readFileSync(path.join(dir, '-p/a.jsonl'), 'utf8'), 'complete');
  const deadline = Date.now() + 1000;
  while (pids().some(running) && Date.now() < deadline) await delay(20);
  assert.deepEqual(pids().filter(running), [], 'timeout must kill the whole scp tree before cleanup');
  assert.equal(transport.liveCount(), 0);
});
