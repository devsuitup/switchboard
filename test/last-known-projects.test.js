'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLastKnownProjectsStore, FORMAT_VERSION, MAX_BYTES } = require('../src/main/projects/last-known-projects');

const projects = [{ projectPath: '/fixture', sessions: [{ sessionId: 'one', summary: 'first' }] }];
const payload = { defaultProjects: projects, allProjects: [...projects, { projectPath: '/archived', sessions: [] }] };

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-known-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const warnings = [];
  const timers = [];
  const store = createLastKnownProjectsStore({
    dir, appVersion: '1.2.3', log: { warn: line => warnings.push(line) },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {}, ...options,
  });
  return { dir, store, warnings, timers, file: path.join(dir, 'last-known-projects.json') };
}

test('remember then flush writes one versioned file that load returns', async t => {
  const s = setup(t);
  s.store.remember(payload);
  assert.equal(s.timers.length, 1, 'the write is deferred');
  assert.equal(fs.existsSync(s.file), false);
  await s.store.flush();
  const written = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(written.version, FORMAT_VERSION);
  assert.equal(written.appVersion, '1.2.3');
  assert.equal(typeof written.savedAt, 'number');
  const loaded = await s.store.load();
  assert.deepEqual(loaded.defaultProjects, payload.defaultProjects);
  assert.deepEqual(loaded.allProjects, payload.allProjects);
  assert.equal(loaded.savedAt, written.savedAt);
  assert.deepEqual(fs.readdirSync(s.dir), ['last-known-projects.json'], 'no temporary file remains');
  assert.deepEqual(s.warnings, []);
});

test('remembers within the delay coalesce into one write carrying the latest payload', async t => {
  const s = setup(t);
  s.store.remember({ defaultProjects: [], allProjects: [] });
  s.store.remember(payload);
  assert.equal(s.timers.length, 1);
  s.timers.shift()();
  await s.store.flush();
  assert.deepEqual((await s.store.load()).defaultProjects, payload.defaultProjects);
});

test('load discards a corrupt file, a foreign format and another app version, removing the file', async t => {
  for (const [label, content] of [
    ['corrupt', '{"version":1,"appVersion":"1.2.3","defaultProjects":[{'],
    ['format', JSON.stringify({ version: 999, appVersion: '1.2.3', ...payload })],
    ['app version', JSON.stringify({ version: FORMAT_VERSION, appVersion: '1.2.4', projects: [] })],
    ['shape', JSON.stringify({ version: FORMAT_VERSION, appVersion: '1.2.3', projects: [{ sessions: [] }] })],
    ['rows', JSON.stringify({ version: FORMAT_VERSION, appVersion: '1.2.3', projects: [{ projectPath: '/p', sessions: [[null, 'no id']] }] })],
    ['default rows', JSON.stringify({ version: FORMAT_VERSION, appVersion: '1.2.3', projects: [{ projectPath: '/p', sessions: [['id']], defaultOrder: 0, defaultRows: [1] }] })],
    ['not an object', '"text"'],
  ]) {
    const s = setup(t);
    fs.writeFileSync(s.file, content);
    assert.equal(await s.store.load(), null, label);
    assert.equal(fs.existsSync(s.file), false, `${label}: the file is removed`);
    assert.equal(s.warnings.length, 1, label);
    assert.match(s.warnings[0], /last known projects/);
  }
});

test('a missing file loads as null without a warning', async t => {
  const s = setup(t);
  assert.equal(await s.store.load(), null);
  assert.deepEqual(s.warnings, []);
});

test('oversize snapshots keep the previous file and warn only once', async t => {
  const s = setup(t, { maxBytes: 200 });
  s.store.remember({ defaultProjects: [], allProjects: [] });
  await s.store.flush();
  assert.ok(fs.existsSync(s.file));
  const previous = fs.readFileSync(s.file);
  const huge = [{ projectPath: '/large', sessions: [{ sessionId: 'huge', summary: 'x'.repeat(2000) }] }];
  s.store.remember({ defaultProjects: huge, allProjects: huge });
  await s.store.flush();
  assert.ok(fs.existsSync(s.file), 'over-cap writes must preserve the previous snapshot');
  assert.deepEqual(fs.readFileSync(s.file), previous);
  s.store.remember({ defaultProjects: huge, allProjects: huge });
  await s.store.flush();
  assert.deepEqual((await s.store.load()).allProjects, []);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /exceed/);
});

test('a payload that cannot be serialized is skipped and the previous file kept', async t => {
  const s = setup(t);
  s.store.remember(payload);
  await s.store.flush();
  const cyclic = { projectPath: '/cyclic', sessions: [{ sessionId: 'cycle', summary: 1n }] };
  s.store.remember({ defaultProjects: [cyclic], allProjects: [cyclic] });
  await s.store.flush();
  assert.deepEqual((await s.store.load()).defaultProjects, payload.defaultProjects);
  assert.equal(s.warnings.length, 1);
});

test('a 30000 session install stores one compact list under 8 MiB and restores both views', async t => {
  const s = setup(t);
  const allProjects = Array.from({ length: 20 }, (_, p) => ({ projectPath: `/workspace/customer-${p}/long-project-directory`,
    sessions: Array.from({ length: 1500 }, (_, i) => ({
      sessionId: `a0000000-0000-4000-8000-${String(p * 1500 + i).padStart(12, '0')}`,
      summary: 'Investigate the session index and verify that all projects remain visible during startup. '.repeat(2),
      firstPrompt: 'Investigate the session index and verify that all projects remain visible during startup. '.repeat(2),
      created: '2026-11-01T10:20:30.000Z', modified: '2026-11-22T10:20:30.000Z', messageCount: 123,
      projectPath: `/workspace/customer-${p}/long-project-directory`, cwd: `/workspace/customer-${p}/long-project-directory`,
      sourceFolder: `-workspace-customer-${p}-long-project-directory`, runtime: 'claude', runtimeLabel: null, canLaunch: true,
      slug: null, scheduleSlug: null, aiTitle: null, parentSessionId: null, workflowRunId: null, workflowName: null,
      agentId: null, subagentType: null, description: null, name: null, starred: 0, archived: i % 5 === 0 ? 1 : 0,
      remoteAlias: null, bridgeSessionId: null, headSessionId: null, mergedMemberIds: [],
    })) }));
  const defaultProjects = allProjects.map(p => ({ ...p, sessions: p.sessions.filter(row => !row.archived) }));
  const before = Buffer.byteLength(JSON.stringify({ version: 1, appVersion: '1.2.3', savedAt: 1, defaultProjects, allProjects }));
  s.store.remember({ defaultProjects, allProjects });
  await s.store.flush();
  assert.ok(fs.existsSync(s.file), 'large install must persist instead of dropping the provisional sidebar');
  const after = fs.statSync(s.file).size;
  t.diagnostic(`payload before=${before} bytes after=${after} bytes cap=${MAX_BYTES}`);
  assert.ok(after < MAX_BYTES);
  const disk = JSON.parse(fs.readFileSync(s.file));
  assert.equal(disk.defaultProjects, undefined, 'default rows must not be stored twice');
  const loaded = await s.store.load();
  assert.equal(loaded.allProjects.length, 20);
  assert.equal(loaded.allProjects[0].sessions.length, 1500);
  assert.equal(loaded.defaultProjects[0].sessions.length, 1200);
  for (const key of ['sessionId', 'summary', 'modified', 'messageCount', 'archived']) {
    assert.equal(loaded.allProjects[0].sessions[0][key], allProjects[0].sessions[0][key]);
  }
  assert.equal(loaded.allProjects[0].sessions[0].firstPrompt, undefined);
});
