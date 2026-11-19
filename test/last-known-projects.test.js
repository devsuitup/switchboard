'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLastKnownProjectsStore } = require('../src/main/projects/last-known-projects');

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
  assert.equal(written.version, 1);
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
    ['format', JSON.stringify({ version: 2, appVersion: '1.2.3', ...payload })],
    ['app version', JSON.stringify({ version: 1, appVersion: '1.2.4', ...payload })],
    ['shape', JSON.stringify({ version: 1, appVersion: '1.2.3', defaultProjects: [{ sessions: [] }], allProjects: [] })],
    ['rows', JSON.stringify({ version: 1, appVersion: '1.2.3', defaultProjects: [{ projectPath: '/p', sessions: [{ summary: 'no id' }] }], allProjects: [] })],
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

test('an oversize payload is not written and the previous file is removed', async t => {
  const s = setup(t, { maxBytes: 200 });
  s.store.remember({ defaultProjects: [], allProjects: [] });
  await s.store.flush();
  assert.ok(fs.existsSync(s.file));
  s.store.remember(payload);
  await s.store.flush();
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(await s.store.load(), null);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /exceed/);
});

test('a payload that cannot be serialized is skipped and the previous file kept', async t => {
  const s = setup(t);
  s.store.remember(payload);
  await s.store.flush();
  const cyclic = { projectPath: '/cyclic', sessions: [] };
  cyclic.self = cyclic;
  s.store.remember({ defaultProjects: [cyclic], allProjects: [] });
  await s.store.flush();
  assert.deepEqual((await s.store.load()).defaultProjects, payload.defaultProjects);
  assert.equal(s.warnings.length, 1);
});
