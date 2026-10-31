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

function rig(t, file, error) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-atomic-callers-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const filename = path.resolve(__dirname, '..', file);
  const nativeRequire = createRequire(filename);
  const atomicWritePath = require.resolve('../src/main/shared/atomic-write');
  const module = { exports: {} };
  const env = { ...process.env, SWITCHBOARD_TRIGGERS_DIR: dir };
  let atomicLoads = 0;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: id => nativeRequire.resolve(id) === atomicWritePath ? (atomicLoads++, {
      renameWithRetry: (src, dest, opts) => {
        calls.push({ src, dest, opts });
        if (error) throw error;
        return (opts?.rename || fs.renameSync)(src, dest);
      },
    }) : nativeRequire(id),
    process: { env, platform: process.platform, pid: process.pid, kill: process.kill.bind(process) },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
  }, { filename });
  assert.equal(atomicLoads, 1, `${file} must load the atomic-write stub`);
  return { dir, calls, api: module.exports };
}

for (const fail of [false, true]) {
  const suffix = fail ? ' preserves final failure handling' : ' publishes through the shared helper';
  test('project remap' + suffix, t => {
    const error = fail ? new Error('final rename failure') : null;
    const { dir, calls, api } = rig(t, 'project-remap.js', error);
    const dest = path.join(dir, 'session.jsonl');
    const original = JSON.stringify({ cwd: 'old' }) + '\n';
    fs.writeFileSync(dest, original);
    if (fail) assert.throws(() => api.rewriteJsonlAtomic(dest, 'old', 'new'), e => e === error);
    else api.rewriteJsonlAtomic(dest, 'old', 'new');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dest, dest);
    assert.equal(fs.existsSync(dest + '.tmp'), false);
    assert.equal(fs.readFileSync(dest, 'utf8'), fail ? original : JSON.stringify({ cwd: 'new' }) + '\n');
  });

  test('mirror manifest' + suffix, async t => {
    const error = fail ? new Error('final rename failure') : null;
    const { dir, calls, api } = rig(t, 'src/main/remote/remote-mirror.js', error);
    const dest = path.join(dir, 'manifest.json');
    const transport = { listFiles: async () => ({ files: [], sessions: [] }) };
    const sync = () => api.syncMirror({ alias: 'test', transport, projectsDir: dir, manifestPath: dest });
    if (fail) await assert.rejects(sync(), e => e === error);
    else {
      await sync();
      assert.equal(calls.length, 1);
      await sync();
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].src, calls[1].src, 'manifest writes need unique sibling temps');
      assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), { version: 1, files: {} });
    }
    assert.equal(calls.length, fail ? 1 : 2);
    assert.equal(calls[0].dest, dest);
    assert.equal(path.dirname(calls[0].src), dir);
    if (fail) assert.equal(fs.existsSync(calls[0].src), false, 'a failed manifest write removes its temp');
  });

  for (const incremental of [false, true]) {
    test((incremental ? 'range append' : 'scp fetch') + suffix, async t => {
      const error = fail ? new Error('final rename failure') : null;
      const { dir, calls, api } = rig(t, 'src/main/remote/remote-transport.js', error);
      const rel = '-srv-test/session.jsonl';
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'old');
      const warnings = [];
      const transport = api.createSshTransport({
        log: { warn: message => warnings.push(message) },
        spawn: (_cmd, args) => {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => {};
          setImmediate(() => {
            if (incremental) child.stdout.end('new');
            else fs.writeFileSync(args[args.length - 1], 'new');
            child.emit('close', 0);
          });
          return child;
        },
      });
      t.after(() => transport.dispose());
      const result = incremental
        ? await transport.fetchIncremental('test', [{ rel, offset: 3 }], dir)
        : await transport.fetchFiles('test', [rel], dir);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].dest, dest);
      assert.equal(result[fail ? 'failed' : 'fetched'].join(), rel);
      assert.equal(result[fail ? 'fetched' : 'failed'].length, 0);
      assert.equal(fs.readFileSync(dest, 'utf8'), fail ? 'old' : incremental ? 'oldnew' : 'new');
      assert.equal(fs.existsSync(dest + '.part'), false);
      assert.equal(warnings.length, fail ? 1 : 0);
    });
  }

  test('schedule enable' + suffix, t => {
    const error = fail ? new Error('final rename failure') : null;
    const { dir, calls, api } = rig(t, 'schedule-runner.js', error);
    const commands = path.join(dir, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    const dest = path.join(commands, 'schedule-test.md');
    const original = '---\ncron: * * * * *\nenabled: true\n---\nbody\n';
    fs.writeFileSync(dest, original);
    let injectedCalls = 0;
    const rename = (src, dest) => { injectedCalls++; fs.renameSync(src, dest); };
    const result = api.setScheduleEnabled(dest, false, { projectRoot: dir, rename });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dest, dest);
    assert.equal(calls[0].opts.rename, rename, 'the original rename injection must reach the helper');
    assert.equal(result.ok, !fail);
    if (fail) assert.equal(result.error, error.message);
    assert.equal(injectedCalls, fail ? 0 : 1);
    assert.equal(fs.readFileSync(dest, 'utf8'), fail ? original : original.replace('enabled: true', 'enabled: false'));
    assert.deepEqual(fs.readdirSync(commands), ['schedule-test.md']);
  });

  test('trigger result' + suffix, async t => {
    const error = fail ? new Error('final rename failure') : null;
    const { dir, calls, api } = rig(t, 'trigger-watcher.js', error);
    const errors = [];
    const trigger = path.join(dir, 'bad.json');
    fs.writeFileSync(trigger, '{');
    const watcher = api.start({ log: { info() {}, warn() {}, error: (...args) => errors.push(args) } });
    t.after(() => watcher.close());
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      function poll() {
        if (!fs.existsSync(trigger)) return resolve();
        if (Date.now() >= deadline) return reject(new Error('trigger not processed'));
        setTimeout(poll, 10);
      }
      poll();
    });
    assert.equal(calls.length, 1);
    const dest = path.join(dir, 'processed', 'bad.result.json');
    assert.equal(calls[0].dest, dest);
    assert.equal(fs.existsSync(dest), !fail);
    if (fail) {
      assert.equal(fs.existsSync(dest + '.tmp'), true, 'result loss and orphan temp stay unchanged');
      assert.ok(errors.some(args => args.includes(error.message)));
    } else assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).ok, false);
  });
}
