'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTmuxAttachAdapter } = require('../remote-attach');

function profileDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'electron');
}

function loadProfile(dataDir, warnings) {
  const { loadAttachProfileId } = require('../remote-attach-profile');
  return loadAttachProfileId(dataDir, { warn: message => warnings.push(message) });
}

function tagFor(profileId, instanceId) {
  const spawns = [];
  const adapter = createTmuxAttachAdapter({
    profileId, instanceId, createAttachId: () => 'attach',
    resolveSshPath: () => 'fake-ssh',
    spawnPty(file, args) { spawns.push(args); return { onExit() {}, resize() {} }; },
    runRemoteCommand: async () => ({ code: 0, stdout: ['/tmp/tmux-0/test', '100x40', 'status off', '', '', '', '', '0', '1'].join('\u0001') }),
  });
  return adapter.attach('fixture', { pid: 42, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 })
    .then(result => { assert.equal(result.ok, true); return /SWITCHBOARD_ATTACH=([A-Za-z0-9_:-]+)/.exec(spawns[0].at(-1))[1].split(':'); });
}

test('profile file is created once in userData and reused by a restarted instance attach', async t => {
  const dir = profileDirectory(t);
  const warnings = [];
  const first = loadProfile(dir, warnings);
  assert.match(first, /^[A-Za-z0-9_-]{22,128}$/);
  const filename = path.join(dir, 'remote-attach-profile-id');
  assert.equal(fs.readFileSync(filename, 'utf8'), first);
  const stat = fs.statSync(filename);
  const next = loadProfile(dir, warnings);
  assert.equal(next, first);
  assert.equal(fs.statSync(filename).mtimeMs, stat.mtimeMs, 'restart must not rewrite the file');
  const before = await tagFor(first, 'previous');
  const after = await tagFor(next, 'current');
  assert.equal(before[0], after[0]);
  assert.notEqual(before[1], after[1]);
  assert.deepEqual(warnings, []);
  assert.notEqual(loadProfile(profileDirectory(t), []), first, 'a dev profile must be independent');
});

for (const corrupt of ['', 'bad:id', 'short', 'x'.repeat(129), 'validlookingid0123456789\n']) {
  test(`corrupt profile ${JSON.stringify(corrupt)} is logged and regenerated only in memory`, t => {
    const dir = profileDirectory(t);
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, 'remote-attach-profile-id');
    fs.writeFileSync(filename, corrupt);
    let writes = 0;
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', function (...args) { writes++; return write.apply(this, args); });
    const warnings = [];
    const first = loadProfile(dir, warnings);
    const second = loadProfile(dir, warnings);
    assert.match(first, /^[A-Za-z0-9_-]{22,128}$/);
    assert.notEqual(first, second, 'untrusted profiles must never be shared across runs');
    assert.equal(fs.readFileSync(filename, 'utf8'), corrupt, 'corrupt file must not be overwritten');
    assert.equal(writes, 0, 'a known corrupt profile must only be regenerated in memory');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /profile|identity/i);
  });
}

test('an unreadable profile path is logged and never overwritten', t => {
  const dir = profileDirectory(t);
  const filename = path.join(dir, 'remote-attach-profile-id');
  fs.mkdirSync(filename, { recursive: true });
  const warnings = [];
  const first = loadProfile(dir, warnings);
  const second = loadProfile(dir, warnings);
  assert.match(first, /^[A-Za-z0-9_-]{22,128}$/);
  assert.notEqual(first, second);
  assert.equal(fs.statSync(filename).isDirectory(), true);
  assert.equal(warnings.length, 2);
});

test('atomic first creation reuses the winning file when another creator wins the race', t => {
  const dir = profileDirectory(t);
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, 'remote-attach-profile-id');
  const winner = 'winning-profile-0123456789';
  const read = fs.readFileSync;
  let firstRead = true;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === filename && firstRead) {
      firstRead = false;
      fs.writeFileSync(filename, winner, { flag: 'wx' });
      throw Object.assign(new Error('not present at initial read'), { code: 'ENOENT' });
    }
    return read.call(this, file, ...args);
  });
  const warnings = [];
  assert.equal(loadProfile(dir, warnings), winner, 'exclusive creation must preserve the winner');
  assert.equal(read(filename, 'utf8'), winner);
  assert.deepEqual(warnings, []);
});

test('an unwritable profile directory uses a logged run-only identity', t => {
  const dir = profileDirectory(t);
  fs.writeFileSync(dir, 'blocked');
  const warnings = [];
  assert.match(loadProfile(dir, warnings), /^[A-Za-z0-9_-]{22,128}$/);
  assert.equal(warnings.length, 1);
});

test('shipped main adapter uses the same userData directory as the single-instance lock', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('const remoteAttachAdapter = createTmuxAttachAdapter(');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  assert.ok(start >= 0 && end > start);
  const calls = [];
  let options;
  vm.runInNewContext(source.slice(start, end), {
    createTmuxAttachAdapter: opts => { options = opts; },
    loadAttachProfileId: (dir, logger) => { calls.push({ dir, logger }); return 'persisted-profile'; },
    app: { getPath: name => { assert.equal(name, 'userData'); return 'isolated-userData'; } },
    log: 'logger',
  });
  assert.deepEqual(calls, [{ dir: 'isolated-userData', logger: 'logger' }]);
  assert.equal(options.profileId, 'persisted-profile');
  assert.match(source, /require\('\.\/remote-attach-profile'\)/);
});
