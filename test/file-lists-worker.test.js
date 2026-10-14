'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { encodeProjectPath } = require('../encode-project-path');
const { deriveProjectPath } = require('../derive-project-path');
const { scanMdFiles, acceptMdFile } = require('../scan-md-files');
const { isAllowedMemoryPath } = require('../ipc-path-validator');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lists-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeDir = path.join(root, 'claude');
  const projectsDir = path.join(claudeDir, 'projects');
  const project = path.join(root, 'repo');
  const hidden = path.join(root, 'hidden');
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const folder = encodeProjectPath(project);
  write(path.join(projectsDir, folder, 'session.jsonl'), JSON.stringify({ cwd: project }) + '\n');
  write(path.join(projectsDir, encodeProjectPath(hidden), 'session.jsonl'), JSON.stringify({ cwd: hidden }) + '\n');
  write(path.join(hidden, 'CLAUDE.md'), 'hidden');
  write(path.join(hidden, '.work-files', 'hidden.txt'), 'hidden');
  const worktree = path.join(project, '.worktrees', 'lane');
  fs.mkdirSync(worktree, { recursive: true });
  write(path.join(projectsDir, encodeProjectPath(worktree), 'session.jsonl'), JSON.stringify({ cwd: worktree }) + '\n');
  write(path.join(claudeDir, 'global.md'), 'global');
  write(path.join(projectsDir, folder, 'memory', 'note.md'), 'memory');
  const first = write(path.join(project, 'CLAUDE.md'), 'first');
  write(path.join(project, 'agents.md'), 'second');
  write(path.join(project, '.claude', 'commands', 'command.md'), 'command');
  write(path.join(project, '.claude', 'empty.md'), ' \n');
  write(path.join(project, '.work-files', 'nested', 'note.txt'), 'work text');
  write(path.join(project, '.work-files', 'stream.jsonl'), 'skip body');
  write(path.join(project, '.work-files', 'large.txt'), 'x'.repeat(65537));
  for (let i = 0; i < 202; i++) {
    const file = write(path.join(project, '.work-files', `${i}.txt`), 'small');
    fs.utimesSync(file, new Date('2026-01-01'), new Date('2026-01-01'));
  }
  const options = { claudeDir, projectsDir, hiddenProjects: [hidden], activeProjectPaths: [claudeDir] };
  return { options, first, project, write };
}

function baseline(options) {
  const handlers = new Map();
  const signatures = new Map();
  const batches = [];
  const context = {
    fs, path, console, CLAUDE_DIR: options.claudeDir, PROJECTS_DIR: options.projectsDir,
    scanMdFiles, acceptMdFile, deriveProjectPath,
    getSetting: () => ({ hiddenProjects: options.hiddenProjects }),
    getKnownProjectPaths: () => new Set([...options.activeProjectPaths, ...fs.readdirSync(options.projectsDir).map(folder => deriveProjectPath(path.join(options.projectsDir, folder), folder)).filter(Boolean)]),
    _isAllowedMemoryPath: isAllowedMemoryPath,
    computeIndexSignature: files => JSON.stringify(files),
    shouldReindex: (kind, signature) => { if (signatures.get(kind) === signature) return false; signatures.set(kind, signature); return true; },
    deleteSearchType: () => {}, upsertSearchEntries: entries => batches.push(entries),
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'fixtures/file-lists-baseline.cjs'), 'utf8'), context);
  return { handlers, batches };
}

function shipped(t, options, observed = false) {
  const script = observed ? path.join(__dirname, 'fixtures/file-lists-observed.cjs') : path.join(__dirname, '..', 'workers/file-lists-query.js');
  const worker = new Worker(script, { workerData: options });
  t.after(() => worker.terminate());
  let id = 0;
  const indexed = new Map();
  return async (kind, extra = {}) => {
    const reply = once(worker, 'message');
    worker.postMessage({ id: ++id, kind, ...options, indexed: [...(indexed.get(kind) || [])], ...extra });
    const [message] = await reply;
    assert.equal(message.error, undefined);
    indexed.set(kind, new Map(message.result.manifest));
    return message.result;
  };
}

test('worker lists equal the pre-change synchronous fixture including hidden projects, worktree dedupe and cap', async t => {
  const f = fixture(t);
  const old = baseline(f.options);
  const query = shipped(t, f.options);
  for (const [kind, channel] of [['memory', 'get-memories'], ['work-file', 'get-work-files']]) {
    const expected = old.handlers.get(channel)();
    const result = await query(kind);
    assert.deepEqual(JSON.parse(JSON.stringify(result.view)), JSON.parse(JSON.stringify(expected)));
    if (kind === 'work-file') { assert.equal(result.view.projects.length, 1); assert.equal(result.view.projects[0].files.length, 200); assert.equal(result.view.projects[0].totalCount, 205); }
    const expectedEntries = new Map(old.batches.flat().map(entry => [entry.id, { ...entry, body: entry.body.slice(0, 32768) }]));
    assert.deepEqual(JSON.parse(JSON.stringify(result.upserts)), JSON.parse(JSON.stringify([...expectedEntries.values()])));
    old.batches.length = 0;
  }
});

test('unchanged memory files are not indexed again and one changed file is indexed once', async t => {
  const f = fixture(t);
  const query = shipped(t, f.options);
  assert.ok((await query('memory')).upserts.length > 1);
  assert.equal((await query('memory')).upserts.length, 0);
  fs.writeFileSync(f.first, 'changed body with a different size');
  const changed = await query('memory');
  assert.equal(changed.upserts.length, 1);
  assert.equal(changed.upserts[0].id, f.first);
  assert.equal(changed.upserts[0].body, 'changed body with a different size');
});

test('unchanged memory bodies are not re-read and cache acceptance remembers empty files', async t => {
  const f = fixture(t);
  const query = shipped(t, f.options, true);
  const first = await query('memory');
  const second = await query('memory');
  assert.equal(second.bodyReads, first.bodyReads);
  const empty = path.join(f.project, '.claude', 'empty.md');
  fs.writeFileSync(empty, 'now nonempty');
  const changed = await query('memory');
  assert.equal(changed.bodyReads, first.bodyReads + 1);
  assert.equal(changed.upserts.length, 1);
  assert.equal(changed.upserts[0].id, empty);
});

test('work-file unchanged calls have no delta and size changes at the same mtime index only that file', async t => {
  const f = fixture(t);
  const query = shipped(t, f.options);
  const first = await query('work-file');
  assert.equal((await query('work-file')).upserts.length, 0);
  const file = first.view.projects[0].files.find(entry => entry.filename === 'note.txt');
  assert.ok(file);
  const stat = fs.statSync(file.filePath);
  fs.writeFileSync(file.filePath, 'changed work file size');
  fs.utimesSync(file.filePath, stat.atime, stat.mtime);
  const changed = await query('work-file');
  assert.equal(changed.upserts.length, 1);
  assert.equal(changed.upserts[0].id, file.filePath);
  assert.equal(changed.upserts[0].body, 'changed work file size');
});

test('removed and newly hidden files leave the incremental index', async t => {
  const f = fixture(t);
  const query = shipped(t, f.options);
  await query('memory');
  fs.unlinkSync(f.first);
  const removed = await query('memory');
  assert.ok(removed.deletes.includes(f.first));
  assert.equal(removed.upserts.length, 0);
  const hidden = await query('memory', { hiddenProjects: [...f.options.hiddenProjects, f.project] });
  assert.equal(hidden.view.projects.length, 0);
  assert.ok(hidden.deletes.length > 0);
  const restored = await query('memory');
  assert.ok(restored.upserts.length > 0);
});

test('memory acceptance stays nonempty when its first FTS window contains only whitespace', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.first, ' '.repeat(32768) + 'nonempty beyond FTS window');
  const query = shipped(t, f.options);
  const first = await query('memory');
  assert.ok(first.view.projects.some(project => project.files.some(file => file.filePath === f.first)));
  assert.equal((await query('memory')).upserts.length, 0);
});

test('the worker keeps the memory allowlist when commands is a directory link outside all known roots', async t => {
  const f = fixture(t);
  const commandDir = path.join(f.project, '.claude', 'commands');
  fs.rmSync(commandDir, { recursive: true });
  const outside = path.join(path.dirname(f.project), 'outside');
  f.write(path.join(outside, 'escape.md'), 'must not be listed or indexed');
  fs.symlinkSync(outside, commandDir, process.platform === 'win32' ? 'junction' : 'dir');
  const expected = baseline(f.options).handlers.get('get-memories')();
  const actual = await shipped(t, f.options)('memory');
  assert.deepEqual(JSON.parse(JSON.stringify(actual.view)), JSON.parse(JSON.stringify(expected)));
  assert.ok(!actual.upserts.some(entry => entry.id.endsWith('escape.md')));
});

test('saving a resolved Memory alias invalidates its cached body even at the same mtime and size', async t => {
  const f = fixture(t);
  const commandDir = path.join(f.project, '.claude', 'commands');
  fs.rmSync(commandDir, { recursive: true });
  const targetDir = path.join(f.project, '.claude', 'real-commands');
  const target = f.write(path.join(targetDir, 'alias.md'), 'before');
  fs.utimesSync(target, new Date('2026-01-01'), new Date('2026-01-01'));
  fs.symlinkSync(targetDir, commandDir, process.platform === 'win32' ? 'junction' : 'dir');
  const query = shipped(t, f.options, true);
  const first = await query('memory', { epoch: 0 });
  const stat = fs.statSync(target);
  fs.writeFileSync(target, 'after!');
  fs.utimesSync(target, stat.atime, stat.mtime);
  const changed = await query('memory', { epoch: 1, invalidated: [fs.realpathSync(target)] });
  assert.equal(changed.upserts.length, 1);
  assert.equal(changed.upserts[0].id, path.join(commandDir, 'alias.md'));
  assert.equal(changed.upserts[0].body, 'after!');
  assert.equal(changed.bodyReads, first.bodyReads + 1);
});
