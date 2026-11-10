'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createJournal } = require('./session-request-journal.cjs');
const { hashSessionRequestCommand } = require('../../session-index-commands');
const { randomUUID, createHash } = require('node:crypto');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function mutate(journal, name, input) {
  input = { actionToken: randomUUID(), ...input };
  return journal[name]({ ...input, argsHash: hashSessionRequestCommand(name, input) });
}
async function rig(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-namespace-')));
  const processed = path.join(dir, 'processed'); fs.mkdirSync(processed);
  const stem = options.stem || 'AbCdEf01-2345-6789-abcd-0123456789ab';
  const input = path.join(dir, stem + '.json');
  const body = options.raw || Buffer.from(JSON.stringify(options.payload || { sessionId: 'missing', command: 'hello' }));
  const journal = options.journal || createJournal();
  if (!options.orphan) fs.writeFileSync(input, body);
  if (options.stale) fs.utimesSync(input, new Date(0), new Date(0));
  let effects = 0, notify;
  const errors = [], events = [], timers = new Map();
  const control = { fail: options.fail, queryError: options.queryError, ackError: options.ackError };
  const fakeFs = { ...fs, ...options.fs,
    watch(_dir, _opts, callback) { notify = callback; return { on() {}, close() {} }; },
    writeFileSync(file, ...args) {
      events.push(['write', file]);
      if (control.fail === 'write' && String(file).endsWith('.result.json.tmp')) throw new Error('injected write');
      return fs.writeFileSync(file, ...args);
    },
    fsyncSync(fd) { events.push(['flush', fd]); if (control.fail === 'flush') throw new Error('injected flush'); return fs.fsyncSync(fd); },
    unlinkSync(file) { events.push(['unlink', file]); if (control.fail === 'unlink') throw new Error('injected unlink'); return fs.unlinkSync(file); },
  };
  options.setup?.({ dir, processed, input, body, journal });
  const filename = require.resolve('../../src/main/triggers/trigger-watcher');
  const nativeRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === '../shared/atomic-write') return { renameWithRetry(from, to) {
        events.push(['rename', to]);
        if (control.fail === 'rename' && to.endsWith('.result.json')) throw new Error('injected rename');
        fs.renameSync(from, to);
      } };
      return nativeRequire(name);
    },
    process: { env: { ...process.env, SWITCHBOARD_TRIGGERS_DIR: dir }, platform: process.platform, pid: process.pid },
    Buffer, console, setTimeout(fn, ms, ...args) {
      if ([250, 1000, 5000, 30000].includes(ms)) { const token = { unref() {} }; timers.set(token, { fn: () => fn(...args), ms }); return token; }
      return setTimeout(fn, ms, ...args);
    }, clearTimeout(token) { if (!timers.delete(token)) clearTimeout(token); }, setInterval, clearInterval, setImmediate,
  }, { filename });
  const ports = Object.fromEntries(Object.entries(journal).map(([name, fn]) => [name, async input => {
    if (name === 'querySessionRequestOutcome' && control.queryError) throw new Error('injected query');
    const result = await fn(input);
    if (name !== 'querySessionRequestOutcome' && (control.ackError === true || control.ackError === name)) throw new Error('injected lost ACK');
    return result;
  }]));
  const watcher = module.exports.start({ sessionRequests: ports, log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    getPtyForSession() { effects++; return null; }, isSessionBusy() { effects++; return false; },
    lifecycle: { launchAllowed() { effects++; return true; }, open() { effects++; }, stop() { effects++; } }, ...options.ctx });
  t.after(() => { watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 35; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  if (options.raw && options.raw.length <= 65536) { await new Promise(resolve => setTimeout(resolve, 70)); await settle(); }
  return { dir, processed, stem, input, body, journal, errors, events, timers, control, watcher, effects: () => effects, settle,
    async retry() { const first = timers.entries().next().value; assertTimer(first); timers.delete(first[0]); first[1].fn(); await settle(); },
    async notify(name = stem + '.json') { notify('rename', name); await settle(); },
  };
}
function assertTimer(value) { require('node:assert/strict').ok(value, 'a bounded publication retry must be scheduled'); }
module.exports = { rig, mutate, sha };
