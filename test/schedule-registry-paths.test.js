'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadScheduleRunner } = require('./schedule-runner-harness');

const missing = () => { throw Object.assign(new Error('Missing project'), { code: 'ENOENT' }); };

function setup(t, { platform = 'win32', stored, seed = () => [], realpath = missing } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-registry-paths-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settingsFile = path.join(home, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(stored === undefined ? {} : { scheduleProjects: stored }));
  let writes = 0;
  const get = key => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))[key];
  const set = (key, value) => {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings[key] = value;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    writes++;
  };
  const { runner } = loadScheduleRunner({ home, platform,
    pathModule: platform === 'win32' ? path.win32 : path.posix, realpath });
  return { registry: runner.scheduleRegistry(get, set, seed), get, writes: () => writes,
    reload: () => runner.scheduleRegistry(get, set, () => { throw new Error('Must not reseed'); }) };
}

test('Windows add keeps the registered spelling when case and separators differ, even for a missing project', t => {
  const first = 'C:/Work/Project';
  const h = setup(t, { stored: [first] });
  h.registry.add('c:\\work\\PROJECT');
  assert.deepEqual(h.get('scheduleProjects'), [first]);
  assert.equal(h.writes(), 0, 'an equivalent add does not rewrite the setting');
});

test('Windows remove deletes every equivalent spelling and keeps other projects', t => {
  const other = 'C:/Work/Project-other';
  const h = setup(t, { stored: ['C:/Work/Project', 'c:\\work\\PROJECT', other] });
  h.registry.remove('C:\\WORK\\project');
  assert.deepEqual(h.get('scheduleProjects'), [other]);
});

test('Windows loading an existing duplicate registry persists the first spelling and does not reseed on restart', t => {
  const first = 'C:/Work/Project';
  const other = 'C:/Work/Other';
  const h = setup(t, { stored: [first, 'c:\\work\\PROJECT', other, first] });
  assert.deepEqual(Array.from(h.registry.list()), [first, other]);
  assert.deepEqual(h.get('scheduleProjects'), [first, other]);
  assert.equal(h.writes(), 1);
  assert.deepEqual(Array.from(h.reload().list()), [first, other]);
  assert.equal(h.writes(), 1, 'a clean registry is not rewritten');
});

test('Windows initial seed collapses equivalent paths keeping its first resolved spelling', t => {
  const h = setup(t, { seed: () => ['C:/Work/Project', 'c:\\work\\PROJECT'] });
  assert.deepEqual(Array.from(h.registry.list()), ['C:\\Work\\Project']);
  assert.deepEqual(h.get('scheduleProjects'), ['C:\\Work\\Project']);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} registry keeps paths with different case distinct through load, add and remove`, t => {
    const h = setup(t, { platform, stored: ['/work/Project', '/work/project'] });
    assert.deepEqual(Array.from(h.registry.list()), ['/work/Project', '/work/project']);
    assert.equal(h.writes(), 0);
    h.registry.add('/work/PROJECT');
    assert.deepEqual(h.get('scheduleProjects'), ['/work/Project', '/work/project', '/work/PROJECT']);
    h.registry.remove('/work/project');
    assert.deepEqual(h.get('scheduleProjects'), ['/work/Project', '/work/PROJECT']);
  });
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform} registry compares real paths while preserving the first alias spelling`, t => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const first = paths.resolve('/work/link');
    const target = paths.resolve('/work/project');
    const h = setup(t, { platform, stored: [first], realpath: value => value === first ? target : value });
    h.registry.add(target);
    assert.deepEqual(h.get('scheduleProjects'), [first]);
    h.registry.remove(target);
    assert.deepEqual(h.get('scheduleProjects'), []);
    assert.deepEqual(Array.from(h.reload().list()), []);
  });
}

test('a registry holding non-string entries drops them and keeps the valid paths', t => {
  const h = setup(t, { platform: 'linux', stored: [null, 42, '', '/a'] });
  assert.deepEqual(Array.from(h.registry.list()), ['/a']);
  assert.deepEqual(h.get('scheduleProjects'), ['/a']);
  assert.equal(h.writes(), 1);
});

test('Windows paths that resolve keep their on-disk spelling and stay distinct', t => {
  const onDisk = { 'C:\\x\\Proj': 'C:\\x\\Proj', 'C:\\x\\proj': 'C:\\x\\proj' };
  const h = setup(t, { stored: ['C:\\x\\Proj', 'C:\\x\\proj'], realpath: value => onDisk[value] });
  assert.deepEqual(Array.from(h.registry.list()), ['C:\\x\\Proj', 'C:\\x\\proj']);
  assert.equal(h.writes(), 0);
});

test('Windows paths that do not resolve match whatever their case', t => {
  const h = setup(t, { stored: ['C:\\X\\P'] });
  h.registry.add('c:\\x\\p');
  assert.deepEqual(h.get('scheduleProjects'), ['C:\\X\\P']);
});
