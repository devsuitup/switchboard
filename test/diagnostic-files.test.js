'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDiagnosticFiles } = require('../src/main/shared/diagnostic-files');
const day = 86400000;

function setup(t, io = fs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs');
  const traces = path.join(dir, 'data');
  fs.mkdirSync(logs); fs.mkdirSync(traces);
  const now = Date.now();
  const put = (folder, name, age = 20) => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, '1234');
    fs.utimesSync(file, new Date(now - age * day), new Date(now - age * day));
    return file;
  };
  const main = put(logs, 'main.log');
  const old = put(logs, 'main.old.log');
  const active = put(traces, 'activity-trace-20260101-000000.jsonl');
  const trace = put(traces, 'activity-trace-20260102-000000.001.jsonl');
  const service = createDiagnosticFiles({ mainLogFile: () => fs.realpathSync.native(main), traceDir: traces,
    currentTrace: () => fs.realpathSync.native(active), io, now: () => now });
  return { service, dir, logs, traces, main, old, active, trace, put, now };
}

test('inventory groups owned files and pruning respects age and both active writers across real path spellings', t => {
  const h = setup(t);
  const recent = h.put(h.traces, 'activity-trace-20260103-000000.jsonl', 2);
  const boundary = h.put(h.traces, 'activity-trace-20260104-000000.jsonl', 14);
  const db = h.put(h.traces, 'switchboard.db');
  const foreign = h.put(h.logs, 'transcript.jsonl');
  const plan = h.service.inventory(14);
  assert.equal(plan.groups.length, 2, 'inventory has main logs and activity traces');
  assert.equal(plan.groups.reduce((n, g) => n + g.count, 0), 6);
  assert.equal(plan.groups.reduce((n, g) => n + g.size, 0), 24);
  assert.equal(plan.count, 2, 'only old inactive files qualify');
  assert.equal(plan.size, 8);
  const result = h.service.prune(14, plan.files.filter(f => f.eligible));
  assert.equal(result.deleted.length, 2);
  for (const file of [h.main, h.active, recent, boundary, db, foreign]) assert.ok(fs.existsSync(file), file);
  assert.equal(fs.existsSync(h.old), false);
  assert.equal(fs.existsSync(h.trace), false);
});

test('escape, symlink and junction paths cannot enter the deletion allowlist', t => {
  const h = setup(t);
  const outside = h.put(h.dir, 'main.old.log');
  const link = path.join(h.logs, 'linked');
  const result = h.service.prune(14, [{ filePath: outside }, { filePath: path.join(link, 'main.old.log') }]);
  assert.equal(result.skipped.length, 2, 'outside and junction candidates are refused');
  assert.ok(fs.existsSync(outside));
  const redirected = createDiagnosticFiles({ mainLogFile: () => path.join(link, 'main.log'), traceDir: h.traces, currentTrace: () => h.active,
    io: { ...fs, lstatSync: file => file === link ? { isSymbolicLink: () => true } : fs.lstatSync(file) } });
  assert.equal(redirected.inventory(14).groups.find(g => g.kind === 'main').count, 0, 'a linked root is refused');
});

test('per-file deletion failures are returned while other deletions continue', t => {
  const h = setup(t, { ...fs, unlinkSync(file) {
    if (file.endsWith('main.old.log')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    fs.unlinkSync(file);
  } });
  const result = h.service.prune(14, h.service.inventory(14).files.filter(f => f.eligible));
  assert.equal(result.failed.length, 1, 'locked file is reported');
  assert.equal(result.failed[0].code, 'EBUSY');
  assert.equal(result.deleted.length, 1);
});

test('changed files and invalid retention cannot cause deletion', t => {
  const h = setup(t);
  const plan = h.service.inventory(14);
  fs.appendFileSync(h.old, 'new content');
  const result = h.service.prune(14, plan.files.filter(f => f.eligible));
  assert.equal(result.skipped.length, 1, 'a file changed after confirmation is skipped');
  assert.ok(fs.existsSync(h.old));
  assert.equal(h.service.prune(0, [{ filePath: h.old }]).failed.length, 1, 'invalid retention fails closed');
});

test('linked files and real paths escaping the diagnostic root are excluded', t => {
  const h = setup(t);
  const canonicalOld = fs.realpathSync.native(h.old);
  for (const mode of ['link', 'escape']) {
    const io = { ...fs,
      lstatSync(file) {
        const stat = fs.lstatSync(file);
        if (mode === 'link' && file === canonicalOld) stat.isSymbolicLink = () => true;
        return stat;
      },
      realpathSync: { native(file) {
        const resolved = fs.realpathSync.native(file);
        return mode === 'escape' && resolved === canonicalOld ? path.join(fs.realpathSync.native(h.dir), 'main.old.log') : resolved;
      } },
    };
    const service = createDiagnosticFiles({ mainLogFile: () => h.main, traceDir: h.traces, currentTrace: () => h.active, io });
    assert.equal(service.inventory(14).files.some(f => f.name === 'main.old.log'), false, `${mode} must not enter inventory`);
    assert.ok(fs.existsSync(h.old));
  }
});

test('main diagnostics IPC delegates inventory and deletion with the app-owned paths', t => {
  const h = setup(t);
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const diagnosticFiles =');
  const end = source.indexOf('\nfunction listActivityTraceFiles()', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const ctx = vm.createContext({ require: createRequire(filename), TRACE_DIR: h.traces,
    log: { transports: { file: { getFile: () => ({ path: h.main }) } } },
    activityTrace: { currentFile: () => h.active }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  });
  vm.runInContext(source.slice(start, end), ctx, { filename });
  assert.equal(typeof handlers.get('get-diagnostic-files'), 'function', 'inventory IPC is registered');
  assert.equal(typeof handlers.get('prune-diagnostic-files'), 'function');
  const plan = handlers.get('get-diagnostic-files')({}, 14);
  assert.equal(plan.count, 2);
  const result = handlers.get('prune-diagnostic-files')({}, 14, plan.files.filter(f => f.eligible));
  assert.equal(result.deleted.length, 2);
  assert.ok(fs.existsSync(h.main));
  assert.ok(fs.existsSync(h.active));
});
