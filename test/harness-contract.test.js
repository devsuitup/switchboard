'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('every registered adapter conforms and invalid ports are rejected', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../harnesses/contract.js')), 'harness contract must exist');
  const { assertHarness, CAPABILITIES } = require('../harnesses/contract');
  const { allHarnesses, getHarness, harnessForFolder, HARNESSES, availableHarnesses, transcriptPath } = require('../harnesses');
  assert.ok(allHarnesses().length);
  for (const adapter of allHarnesses()) {
    assert.equal(assertHarness(adapter), adapter);
    for (const name of CAPABILITIES) assert.equal(typeof adapter.capabilities[name], 'boolean', name);
    for (const key of ['sessionsRoot', 'listFolders', 'folderPath', 'folderForProject', 'listTranscripts', 'transcriptPath',
      'readSessionFile', 'deriveProjectPath', 'resolveWorktreePath', 'buildLaunchArgs', 'classifyTitleActivity',
      'sessionIdFromPath', 'needsIdDetection']) {
      assert.throws(() => assertHarness({ ...adapter, [key]: null }), /harness/i, key);
    }
    assert.throws(() => assertHarness({ ...adapter, capabilities: {} }), /capabilit/i);
    assert.throws(() => assertHarness({ ...adapter, usageProvider: {} }), /usage/i);
    assert.equal(assertHarness({ ...adapter, usageProvider: { getUsage() { return {}; } } }).id, adapter.id);
    for (const key of ['id', 'label', 'binary']) assert.throws(() => assertHarness({ ...adapter, [key]: '' }), /harness/i);
    assert.throws(() => assertHarness({ ...adapter, folderPrefix: '' }), /harness/i);
  }
  assert.equal(getHarness(), getHarness('claude'));
  assert.equal(getHarness('unknown'), getHarness('claude'));
  assert.equal(getHarness('toString'), getHarness('claude'));
  const original = HARNESSES.claude;
  HARNESSES.claude = { ...original, available: () => false };
  const fake = { ...getHarness(), id: 'test', folderPrefix: 'test:', available: () => true };
  HARNESSES.test = fake;
  try {
    assert.equal(harnessForFolder('test:folder'), fake);
    assert.equal(harnessForFolder('alias::test:folder'), fake);
    assert.equal(harnessForFolder('alias::-project'), getHarness());
    assert.equal(harnessForFolder('bad alias::test:folder'), getHarness());
    assert.equal(harnessForFolder(null), getHarness());
    assert.deepEqual(availableHarnesses(), [fake]);
    assert.equal(transcriptPath({ runtime: 'test', sessionFile: '/authoritative.jsonl' }), '/authoritative.jsonl');
  } finally { delete HARNESSES.test; HARNESSES.claude = original; }
});

for (const method of ['sessionIdFromPath', 'needsIdDetection']) {
  test(`the contract rejects a missing ${method} method`, () => {
    const { assertHarness } = require('../harnesses/contract');
    const claude = require('../harnesses/claude');
    assert.throws(() => assertHarness({ ...claude, [method]: undefined }), new RegExp(method));
  });
}

test('the contract requires project grouping metadata and accepts an ungrouped store', () => {
  const { assertHarness } = require('../harnesses/contract');
  const claude = require('../harnesses/claude');
  for (const groupsByProject of [undefined, null, 'true', 1]) {
    assert.throws(() => assertHarness({ ...claude, groupsByProject }), /groupsByProject/);
  }
  const ungrouped = { ...claude, groupsByProject: false, folderForProject: () => null,
    sessionIdFromPath: () => null, needsIdDetection: ({ isNew }) => !!isNew };
  assert.equal(assertHarness(ungrouped), ungrouped);
  assert.equal(ungrouped.folderForProject('/project'), null);
});

test('Claude exposes upstream grouping, filename identity and launch detection semantics', () => {
  const claude = require('../harnesses/claude');
  assert.equal(claude.groupsByProject, true);
  assert.equal(claude.sessionIdFromPath(path.join('project', 'parent.jsonl')), 'parent');
  assert.equal(claude.sessionIdFromPath(path.join('project', 'parent', 'subagents', 'agent-child.jsonl')), 'agent-child');
  assert.equal(claude.needsIdDetection({ isNew: true }), false);
  assert.equal(claude.needsIdDetection({ isNew: false }), false);
  assert.equal(claude.needsIdDetection({ isNew: true, options: { forkFrom: 'parent' } }), true);
  assert.equal(claude.needsIdDetection({ isNew: false, options: { forkFrom: 'parent' } }), true);
});

test('Claude delegates fork transcript, continuation, state, job and binary contracts', () => {
  const claude = require('../harnesses/claude');
  const transcripts = require('../read-session-file');
  const projects = require('../derive-project-path');
  for (const key of ['readSessionFile', 'enumerateSessionFiles']) assert.equal(claude[key], transcripts[key]);
  for (const key of ['deriveProjectPath', 'resolveWorktreePath']) assert.equal(claude[key], projects[key]);
  for (const key of ['resolveContinuations', 'resolveContinuationsSync']) assert.equal(claude[key], require('../session-continuations')[key]);
  assert.equal(claude.liveElsewhere, require('../cli-session-state').liveElsewhere);
  assert.equal(claude.getCachedJobs, require('../bg-agents').getCachedJobs);
  assert.equal(claude.resolveWindowsLaunch, require('../claude-binary').resolveWindowsClaude);
  assert.equal(claude.classifyTitleActivity, require('../classify-title-activity').classifyTitleActivity);
  assert.deepEqual(claude.classifyTitleActivity('plain title'), { busy: false, idle: false, via: null });
  const pending = [require.cache[require.resolve('../harnesses')]];
  const seen = new Set();
  while (pending.length) {
    const module = pending.pop();
    if (!module || seen.has(module)) continue;
    seen.add(module);
    assert.doesNotMatch(module.filename, /(?:^|[\\/])(?:electron|db\.js|session-index-store\.js)(?:[\\/]|$)/);
    pending.push(...module.children);
  }
});

test('harness modules ship in the package and remain visible to the layout guard', () => {
  assert.ok(require('../package.json').build.files.includes('harnesses/**'));
  const files = require('../scripts/module-paths').appFiles(path.join(__dirname, '..'));
  for (const file of ['harnesses/index.js', 'harnesses/claude.js', 'harnesses/contract.js']) assert.ok(files.includes(file), file);
});

test('Claude store enumerates parent, preferred and legacy subagents under an isolated root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createClaudeHarness } = require('../harnesses/claude');
  const claude = createClaudeHarness({ projectsDir: root });
  const folder = claude.folderForProject(root);
  const dir = claude.folderPath(folder);
  fs.mkdirSync(path.join(dir, 'parent', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'not-a-folder'), '');
  const files = ['parent.jsonl', 'parent/subagents/agent-child.jsonl', 'legacy/agent-old.jsonl'].map(file => path.join(dir, file));
  for (const file of files) fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root, timestamp: '2026-10-01T00:00:00.000Z', message: { content: 'hello' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), '');
  assert.equal(claude.sessionsRoot(), root);
  assert.equal(claude.available(), true);
  assert.deepEqual(claude.listFolders(), [folder]);
  assert.deepEqual(claude.listTranscripts(dir).sort(), files.sort());
  assert.equal(claude.transcriptPath({ folder, sessionId: 'parent' }), path.join(dir, 'parent.jsonl'));
  assert.equal(claude.transcriptPath({ folder, sessionId: 'sub:parent:child', parentSessionId: 'parent', agentId: 'child' }), path.join(dir, 'parent/subagents/agent-child.jsonl'));
  assert.equal(claude.transcriptPath({ sessionFile: files[2] }), files[2]);
  const parsed = claude.readSessionFile(path.join(dir, 'parent.jsonl'), folder, root);
  assert.equal(parsed.summary, 'hello');
  assert.equal(parsed.projectPath, root);
  assert.equal(claude.deriveProjectPath(dir), root);
  assert.equal(claude.readSessionFile(path.join(dir, 'absent.jsonl'), folder, root), null);
  const missing = createClaudeHarness({ projectsDir: path.join(root, 'absent') });
  assert.equal(missing.available(), false);
  assert.deepEqual(missing.listFolders(), []);
  assert.deepEqual(missing.listTranscripts(missing.folderPath(folder)), []);
});
