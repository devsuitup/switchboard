'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const base = require('./warm-start-1144.cjs');
const codex = require('./warm-start-1152.cjs');

function timers(t) {
  const pending = new Map();
  const timeout = global.setTimeout, clear = global.clearTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    if (String(fn).includes('populateCacheViaWorker')) {
      const token = { unref() {} };
      pending.set(token, { fn, ms });
      return token;
    }
    return timeout(fn, ms, ...args);
  });
  t.mock.method(global, 'clearTimeout', token => { pending.delete(token); return clear(token); });
  return { pending, async fire() {
    assert.equal(pending.size, 1, 'every deferred folder must reach the in-run retry timer');
    const [token, timer] = pending.entries().next().value;
    pending.delete(token);
    return timer.fn();
  } };
}

async function setup(t, runtime = 'claude') {
  const f = await (runtime === 'codex' ? codex : base).fixture(t);
  const folder = runtime === 'codex' ? f.codexFolder : f.folder;
  let file, id;
  if (runtime === 'codex') { file = f.codexWrite(0); id = f.ids[0]; f.codexWrite(1); }
  else {
    f.write('neighbor');
    if (runtime === 'subagent') {
      f.write('parent');
      file = path.join(f.dir, 'parent', 'subagents', 'agent-failed.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: f.root, isSidechain: true, message: { content: 'original' } }) + '\n');
      id = 'sub:parent:failed';
    } else { file = f.write('failed'); id = 'failed'; }
  }
  assert.equal((await f.cache.populateCacheViaWorker()).ok, true);
  const warnings = [];
  const initialize = () => f.writer.initializeCache({ PROJECTS_DIR: f.projects, activeSessions: f.activeSessions,
    getMainWindow: () => null, log: { info: line => f.logs.push(line), warn: line => warnings.push(line), error() {} } });
  initialize();
  f.logs.length = 0;
  fs.appendFileSync(file, '\n');
  return { f, file, id, folder, warnings, initialize };
}

function failReads(t, f, files, code = 'EBUSY', count = Infinity) {
  const emit = Worker.prototype.emit;
  const failures = new Set(files);
  let attempts = 0;
  t.mock.method(Worker.prototype, 'emit', function (event, msg, ...args) {
    const dir = msg?.result?.startup && require('../../src/main/session-index/full-read-state').startupFolderPath(f.projects, msg.result.folder);
    if (event === 'message' && dir && files.some(file => file.startsWith(dir + path.sep)) && attempts < count) {
      const open = fs.openSync;
      const read = fs.readSync, handles = new Set();
      const patch = t.mock.method(fs, 'openSync', function (file, ...rest) {
        if (failures.has(file) && /at (?:Object\.)?readSessionFile /.test(new Error().stack)) {
          if (code === 'short' || code === 'changed') { const fd = open.call(this, file, ...rest); handles.add(fd); return fd; }
          throw Object.assign(new Error('private content and ' + file), { code });
        }
        const fd = open.call(this, file, ...rest);
        handles.delete(fd);
        return fd;
      });
      const readPatch = t.mock.method(fs, 'readSync', function (fd, ...rest) {
        if (handles.has(fd) && code === 'short') return 0;
        const bytes = read.call(this, fd, ...rest);
        if (handles.delete(fd) && code === 'changed') fs.appendFileSync(files[0], '\n');
        return bytes;
      });
      try {
        const replacement = codex.scan({ projectsDir: f.projects, inventory: [msg.result.inventory],
          scope: [msg.result.folder], disabledHarnesses: [], force: msg.result.reason === 'forced' })
          .find(item => item.result);
        if (replacement) { msg = { ...msg, ...replacement }; attempts++; }
      } finally { patch.mock.restore(); readPatch.mock.restore(); }
    }
    return emit.call(this, event, msg, ...args);
  });
}

module.exports = { timers, setup, failReads };
