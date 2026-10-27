'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const script = path.resolve(__dirname, '../scripts/canary-cli-capabilities.js');

for (const field of ['ino', 'dev']) {
  test(`GIVEN ${field} identities colliding as numbers WHEN the sandbox directory changes THEN reject its descriptor`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-directory-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sessions = path.join(root, '.claude', 'sessions');
    const descriptorFile = path.join(sessions, '42.json');
    const original = { dev: 1n, ino: 2n ** 53n, [field]: 2n ** 53n };
    const replacement = { ...original, [field]: original[field] + 1n };
    assert.equal(Number(original[field]), Number(replacement[field]));
    let identity = original;
    let published;
    let exit;
    const localRequire = createRequire(script);
    const virtualFs = {
      ...fs,
      statSync(file, options) {
        if (file !== sessions) return fs.statSync(file, options);
        return options?.bigint ? { ...identity } : { dev: Number(identity.dev), ino: Number(identity.ino) };
      },
      readdirSync(file, ...args) {
        return file === '/proc' ? ['42'] : fs.readdirSync(file, ...args);
      },
      readFileSync(file, ...args) {
        if (file === '/proc/42/stat') {
          const fields = Array(20).fill('0');
          fields[0] = 'S'; fields[1] = '1'; fields[19] = published.procStart;
          return `42 (fixture) ${fields.join(' ')}`;
        }
        if (file === '/proc/42/status') return 'NSpid:\t42\t7\n';
        return fs.readFileSync(file, ...args);
      },
      readlinkSync(file, ...args) {
        return file === '/proc/42/ns/pid' ? 'pid:[fixture]' : fs.readlinkSync(file, ...args);
      },
    };
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
      module: loaded,
      require(name) {
        if (name === 'node:fs') return virtualFs;
        if (name === 'node:child_process') return {
          spawn() { throw new Error('subprocesses are forbidden'); },
          spawnSync() { throw new Error('subprocesses are forbidden'); },
        };
        if (name === 'node-pty') throw new Error('subprocesses are forbidden');
        return localRequire(name);
      },
      __dirname: path.dirname(script), Buffer, setTimeout,
      process: { platform: 'linux', versions: {}, env: {} },
    }, { filename: script });
    const ctx = {
      opts: { dryRun: true, home: root }, repo: root, run: root, env: {},
      deadline: Date.now() + 1000, processes: [], evidence: { processes: [] },
      ptyFactory(_exe, argv, { env }) {
        published = { pid: 42, procStart: env.CANARY_FIXTURE_PROC_START, startedAt: Date.now(),
          sessionId: argv[argv.indexOf('--session-id') + 1], status: 'idle', cwd: root };
        fs.writeFileSync(descriptorFile, JSON.stringify(published));
        return { pid: 42, onData() {}, onExit(callback) { exit = callback; } };
      },
    };
    const harness = loaded.exports;
    const proc = await harness.launch(ctx);
    t.after(async () => { exit(); await harness.stop(ctx, proc); });
    assert.doesNotThrow(() => JSON.stringify(ctx.evidence), 'launch evidence must remain JSON serializable');
    ctx.opts.dryRun = false;
    proc.sandbox = true;
    published.pid = 7;
    fs.writeFileSync(descriptorFile, JSON.stringify(published));
    assert.equal(harness.descriptor(ctx, proc)?.sessionId, proc.id, 'the original directory must authenticate');
    identity = replacement;
    assert.equal(harness.descriptor(ctx, proc), null, 'a different directory must not authenticate');
    assert.equal(proc.directoryIdentity[field], original[field], 'launch must retain the exact directory identity');
  });
}
