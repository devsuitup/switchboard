'use strict';

// Cold-start indexing UX fix: workers/scan-projects.js used to buffer every
// folder's parsed sessions into one `results` array and post a single message
// once the ENTIRE ~/.claude/projects/ tree had been read — on a large history
// (1GB+, witnessed live) that meant the main thread (and therefore the
// renderer's get-projects call) had nothing to act on for many minutes.
//
// The worker now streams one `{type:'folder', ...}` message per folder as
// soon as it's read, so session-cache.js can write it to the DB and push a
// sidebar update immediately instead of waiting for the full tree.
//
// No native modules on this path (fs/path + pure-JS derive/read helpers), so
// spinning the REAL worker is safe under plain node:test — same pattern as
// test/search-worker-db-failure.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { encodeProjectPath } = require('../encode-project-path');
const { readSessionFile } = require('../read-session-file');
const { fullIndexConfig } = require('../src/main/session-index/full-read-state');
let originalCodexHome, isolatedCodexHome;
test.before(() => {
  originalCodexHome = process.env.CODEX_HOME;
  isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-a2-codex-'));
  process.env.CODEX_HOME = isolatedCodexHome;
});
test.after(() => { process.env.CODEX_HOME = originalCodexHome; fs.rmSync(isolatedCodexHome, { recursive: true, force: true }); });

function startupScan(t, mutate, fault) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-a2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root), dir = path.join(root, folder), file = path.join(dir, 'source.jsonl');
  fs.mkdirSync(dir);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root, timestamp: '2024-01-01', message: { content: 'indexed body' } }) + '\n');
  const row = readSessionFile(file, folder, root);
  const config = fullIndexConfig({}, root);
  mutate?.({ root, dir, file, row });
  const filename = require.resolve('../workers/scan-projects'), native = require('node:module').createRequire(filename);
  const messages = [];
  const wrappedFs = new Proxy(fs, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => { fault?.(key, args, { root, dir, file }); return value(...args); };
  } });
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, console, process,
    require: name => name === 'worker_threads' ? { parentPort: { postMessage: msg => messages.push(msg) },
      workerData: { projectsDir: root, folders: [], startup: { config, inventory: [{ folder, rows: [row],
        meta: { projectPath: root, fullIndexVersion: 1, fullIndexConfig: config, fullIndexPending: null } }] } } }
      : name === 'fs' || name === 'node:fs' ? wrappedFs : (() => {
        assert.ok(!/sqlite|session-index-store|database/.test(name), 'the scan worker cannot import a SQLite backend');
        return native(name);
      })(),
  }, { filename });
  return { messages, folder, row };
}

test('A2 startup inventory selects confirmed vanished files for explicit partial deletion', t => {
  const { messages } = startupScan(t, ({ file, dir, row }) => {
    fs.unlinkSync(file);
    fs.writeFileSync(path.join(dir, 'neighbor.jsonl'), JSON.stringify({ type: 'user', cwd: row.projectPath, message: { content: 'neighbor' } }) + '\n');
  });
  const result = messages.find(message => message.type === 'folder')?.result;
  assert.ok(result?.toDelete?.includes('source'), 'confirmed missing source is selected for deletion');
});

test('A2 startup inventory reports inaccessible scope without authorizing deletion', t => {
  const { messages } = startupScan(t, null, (method, args, { dir }) => {
    if (method === 'readdirSync' && args[0] === dir) throw Object.assign(new Error('inaccessible fixture'), { code: 'EACCES' });
  });
  assert.equal(messages.at(-1).ok, false, 'incomplete inventory fails the population');
  assert.ok(messages.every(message => !message.result?.toDelete?.length), 'inaccessible rows are retained');
});

test('A2 startup stable bookkeeping-only rewrite removes its previously indexed row', t => {
  const { messages } = startupScan(t, ({ file, row }) => fs.writeFileSync(file, JSON.stringify({ type: 'system', cwd: row.projectPath, message: 'bookkeeping' }) + '\n'));
  assert.ok(messages.find(message => message.type === 'folder')?.result?.toDelete?.includes('source'),
    'stable complete parse with no indexable session deletes the old row');
});

for (const scope of ['root', 'folder', 'nested']) {
  test('A2 inventory retains inaccessible ' + scope + ' scope', t => {
    const { messages } = startupScan(t, ({ root, dir }) => {
      const blocked = scope === 'root' ? root : scope === 'folder' ? dir : path.join(dir, 'parent');
      if (scope === 'nested') fs.mkdirSync(blocked);
      const readdir = fs.readdirSync;
      t.mock.method(fs, 'readdirSync', function (file, ...args) {
        if (file === blocked) throw Object.assign(new Error('incomplete ' + scope), { code: 'EACCES' });
        return readdir.call(this, file, ...args);
      });
    });
    assert.equal(messages.at(-1).ok, false);
    assert.ok(messages.every(message => !message.result?.toDelete?.length));
  });
}

test('A2 whole missing root plans deletion while failed body reads defer', t => {
  const gone = startupScan(t, ({ root }) => fs.rmSync(root, { recursive: true }));
  assert.ok(gone.messages.find(message => message.type === 'folder').result.toDelete.includes('source'));
  const failed = startupScan(t, ({ file }) => {
    fs.appendFileSync(file, '\n');
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (name, ...args) {
      if (name === file) throw Object.assign(new Error('unreadable body'), { code: 'EIO' });
      return read.call(this, name, ...args);
    });
  });
  const result = failed.messages.find(message => message.type === 'folder').result;
  assert.ok(result.deferred.includes('source.jsonl'));
  assert.ok(!result.toDelete.includes('source'));
});

test('A2 source migration preserves a subagent logical identity at its new path', t => {
  const { messages } = startupScan(t, ({ dir, row }) => {
    const oldFile = path.join(dir, 'parent', 'agent-a.jsonl');
    fs.mkdirSync(path.dirname(oldFile));
    fs.writeFileSync(oldFile, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent body' } }) + '\n');
    Object.assign(row, readSessionFile(oldFile, row.folder, row.projectPath, { parentSessionId: 'parent' }));
    const newFile = path.join(dir, 'parent', 'subagents', 'agent-a.jsonl');
    fs.mkdirSync(path.dirname(newFile));
    fs.renameSync(oldFile, newFile);
  });
  const result = messages.find(message => message.type === 'folder')?.result;
  assert.ok(result?.sessions.some(row => row.sessionId === 'sub:parent:a'), 'moved subagent is upserted from its real new path');
  assert.ok(!result.toDelete?.includes('sub:parent:a'), 'the removed old path must not delete the replacement logical row');
});

test('A2 sidecar-only changes select the saved subagent source path', t => {
  const { messages } = startupScan(t, ({ dir, row }) => {
    const file = path.join(dir, 'parent', 'subagents', 'agent-a.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent body' } }) + '\n');
    Object.assign(row, readSessionFile(file, row.folder, row.projectPath, { parentSessionId: 'parent' }));
    fs.writeFileSync(file.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'new sidecar description' }));
  });
  assert.equal(messages.find(message => message.type === 'folder')?.result?.sessions.find(row => row.sessionId === 'sub:parent:a')?.description,
    'new sidecar description', 'a metadata sidecar change invalidates the full-read observation');
});

test('A2 ambiguous legacy and nested sources force the existing full enumeration policy', t => {
  const { messages } = startupScan(t, ({ dir, row }) => {
    const legacy = path.join(dir, 'parent', 'agent-a.jsonl');
    const nested = path.join(dir, 'parent', 'subagents', 'agent-a.jsonl');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    const body = JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'duplicate identity' } }) + '\n';
    fs.writeFileSync(legacy, body);
    Object.assign(row, readSessionFile(legacy, row.folder, row.projectPath, { parentSessionId: 'parent' }));
    fs.writeFileSync(nested, body);
  });
  const result = messages.find(message => message.type === 'folder').result;
  assert.ok(!result.partial, 'two physical sources for one identity require full enumeration');
  assert.equal(result.reason, 'changed-layout', 'canonical nested layout supersedes the cached legacy source');
});

test('A2 failed folder diagnostics retain bytes read before the failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-a2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'read.jsonl');
  fs.writeFileSync(file, 'known bytes');
  const counters = require('../src/main/session-index/read-counters');
  assert.throws(() => counters.measureFolder(() => {
    counters.enumerateReads([file]);
    counters.readBodyFile(file);
    throw new Error('later inaccessible directory');
  }), error => {
    assert.equal(error.counters?.bytesRead, 11, 'failed scopes must retain actual completed read bytes');
    assert.equal(error.counters.filesFailed, 1);
    return true;
  });
});

function writeSession(projectsDir, name, cwd = path.join(projectsDir, name)) {
  const folderPath = path.join(projectsDir, encodeProjectPath(cwd));
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function runWorker(projectsDir, data = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'scan-projects.js'), {
      workerData: { projectsDir, ...data },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker did not finish within 10s'));
    }, 10000);
    worker.on('message', (msg) => {
      messages.push(msg);
      if (msg.type === 'done') {
        clearTimeout(timer);
        resolve(messages);
      }
    });
    worker.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('A2 explicit Claude scopes do not widen the coordinated Codex full phase', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-phase-a2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  t.after(() => { process.env.CODEX_HOME = previous; });
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '08', '26');
  fs.mkdirSync(day, { recursive: true });
  const id = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
  fs.writeFileSync(path.join(day, 'rollout-2026-08-26T11-55-02-' + id + '.jsonl'), [
    { type: 'session_meta', payload: { id, cwd: root, originator: 'codex_cli_rs' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'codex body' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const restricted = await runWorker(root, { folders: [], targets: [] });
  assert.equal(restricted.filter(message => message.type === 'folder').length, 0, 'explicit empty folders never trigger implicit harness reads');
  const coordinated = await runWorker(root, { folders: [], disabledHarnesses: ['claude'], startup: { inventory: [], config: fullIndexConfig({ disabledHarnesses: ['claude'] }, root) } });
  const results = coordinated.filter(message => message.type === 'folder');
  assert.equal(results.length, 1, 'Codex is visited once even with Claude disabled');
  assert.equal(results[0].result.folder, 'codex/2026/08/26');
  assert.equal(results[0].result.sessions[0].runtime, 'codex');
  assert.equal(results[0].result.projectPath, null);
});

test('scan-projects worker streams one folder message per folder, then a final done message', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-'));
  try {
    writeSession(projectsDir, 'proj-a');
    writeSession(projectsDir, 'proj-b');
    writeSession(projectsDir, 'proj-c');

    const messages = await runWorker(projectsDir);

    const folderMsgs = messages.filter(m => m.type === 'folder');
    const doneMsgs = messages.filter(m => m.type === 'done');

    assert.equal(folderMsgs.length, 3, 'one folder message per on-disk project folder');
    assert.equal(doneMsgs.length, 1, 'exactly one final done message');
    assert.equal(doneMsgs[0].ok, true);
    assert.equal(doneMsgs[0].total, 3);

    // Each folder message must carry its own result plus progress counters,
    // so the caller can write it to the DB and report progress without
    // waiting for the rest of the tree.
    for (const msg of folderMsgs) {
      assert.equal(msg.total, 3);
      assert.ok(msg.current >= 1 && msg.current <= 3);
      assert.ok(msg.result, 'folder message must carry a parsed result');
      assert.equal(msg.result.sessions.length, 1);
    }

    const folders = folderMsgs.map(m => m.result.folder).sort();
    assert.deepEqual(folders, ['proj-a', 'proj-b', 'proj-c'].map(n => encodeProjectPath(path.join(projectsDir, n))).sort());
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('scan-projects worker reports done:ok even for an empty projects dir', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-empty-'));
  try {
    const messages = await runWorker(projectsDir);
    assert.equal(messages.filter(m => m.type === 'folder').length, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
    assert.equal(messages[0].ok, true);
    assert.equal(messages[0].total, 0);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('scan-projects worker indexes no project path from a transcript whose cwd does not encode to its folder', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-forged-'));
  try {
    const project = path.join(projectsDir, 'proj');
    writeSession(projectsDir, 'proj', path.join(project, 'evil'));
    fs.renameSync(
      path.join(projectsDir, encodeProjectPath(path.join(project, 'evil'))),
      path.join(projectsDir, encodeProjectPath(project))
    );

    const messages = await runWorker(projectsDir);

    const folderMsgs = messages.filter(m => m.type === 'folder');
    assert.equal(folderMsgs.length, 1);
    assert.equal(folderMsgs[0].result, null);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
