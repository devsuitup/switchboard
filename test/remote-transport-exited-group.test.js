'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { stopProcessTree } = require('../src/main/terminals/stop-process-tree');

for (const missingGroup of [false, true]) {
  test(`POSIX timeout signals the scp group after its leader exited (ESRCH=${missingGroup})`, async t => {
    const filename = path.resolve(__dirname, '../src/main/remote/remote-transport.js');
    const localRequire = createRequire(filename);
    const signals = [];
    const loaded = { exports: {} };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: loaded, exports: loaded.exports, Buffer, setTimeout, clearTimeout,
      process: { platform: 'linux' },
      require: name => name === '../terminals/stop-process-tree' ? {
        stopProcessTree: (pid, options) => stopProcessTree(pid, { ...options, platform: 'linux',
          signalGroup: (group, signal) => {
            signals.push([group, signal]);
            if (missingGroup) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
          },
        }),
      } : localRequire(name),
    }, { filename });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-exited-group-'));
    let leader;
    const transport = loaded.exports.createSshTransport({
      fetchTimeoutMs: 100, resolveScpPath: () => 'fake-scp', resolveSshPath: () => 'fake-ssh',
      spawn: (_cmd, args, options) => {
        assert.equal(options.detached, true);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { throw new Error('the exited leader cannot release inherited pipes'); };
        if (args.includes('-O')) {
          fs.writeFileSync(args.at(-1), 'complete');
          queueMicrotask(() => child.emit('close', 0));
        } else {
          child.pid = 123456;
          child.exitCode = 0;
          child.signalCode = null;
          leader = child;
          queueMicrotask(() => child.emit('exit', 0));
        }
        return child;
      },
    });
    t.after(() => { transport.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
    const pending = transport.fetchFiles('host', ['-p/a.jsonl'], dir);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(100);
    const result = await pending;
    assert.deepEqual(signals, [[-123456, 'SIGKILL']], 'the descendant group must be signalled even after leader exit');
    assert.deepEqual(Array.from(result.fetched), ['-p/a.jsonl']);
    assert.equal(leader.stderr.destroyed, true);
    assert.equal(transport.liveCount(), 0);
  });
}
