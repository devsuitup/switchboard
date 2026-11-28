'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyAndPersistArchived, groupedHiddenMatcher } = require('../archived-projects');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');

const SHORT = 'C:/Users/JEAN-B~1/proj';
const LONG = 'C:/Users/Jean-Baptiste/proj';
const fakeLong = map => value => Object.hasOwn(map, value) ? map[value] : value;

function shortSpelling(long) {
  return require('node:child_process').execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${long}") do @echo %~sI`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
}

function spellings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const long = fs.realpathSync.native(dir);
  const short = shortSpelling(long);
  if (short.toLowerCase() === long.toLowerCase()) return null;
  assert.equal(fs.realpathSync.native(short), long, 'fixture must address the same real directory');
  return { dir, long, short };
}

test('GIVEN a long-form hide entry WHEN a project uses the short spelling THEN the injected resolver hides it', () => {
  const hidden = groupedHiddenMatcher([LONG.toLowerCase()], {}, fakeLong({ [SHORT]: LONG }));
  assert.equal(hidden(null, SHORT), true, 'the short spelling must match its long-form hide entry');
  assert.equal(hidden(null, 'C:/Users/JEAN-B~1/other'), false, 'an unrelated short path must stay visible');
});

test('GIVEN a short-form hide entry WHEN the project uses the long spelling THEN it is hidden too', () => {
  const hidden = groupedHiddenMatcher([SHORT], {}, fakeLong({ [SHORT]: LONG }));
  assert.equal(hidden(null, LONG), true);
});

test('GIVEN a hidden worktree group WHEN a session recorded its cwd in short form THEN the session is hidden', () => {
  const group = LONG + '/.work-files/worktrees/topic';
  const cwd = SHORT + '/.work-files/worktrees/topic';
  const hidden = groupedHiddenMatcher([group], {}, fakeLong({ [cwd]: group }));
  assert.equal(hidden(null, SHORT, { runtime: 'claude', recordedCwd: cwd }), true, 'a short recorded cwd must fall under its long hidden group');
  assert.equal(hidden(null, SHORT, { runtime: 'claude', recordedCwd: SHORT + '/.work-files/worktrees/other' }), false, 'a sibling worktree must stay visible');
});

test('GIVEN a remote project WHEN its path looks short THEN the resolver is never asked and bare entries still match it', () => {
  const asked = [];
  const hidden = groupedHiddenMatcher([LONG, 'box::/srv/JEAN-B~1'], {}, value => { asked.push(value); return value; });
  assert.equal(hidden('box', '/srv/JEAN-B~1'), true);
  assert.equal(hidden('other', LONG), true, 'a bare entry must keep matching every host');
  assert.deepEqual(asked.filter(value => value.startsWith('/srv')), [], 'a remote path must never reach the local resolver');
});

test('GIVEN no resolver WHEN the spellings differ THEN they do not match', () => {
  const hidden = groupedHiddenMatcher([LONG], {}, null);
  assert.equal(hidden(null, SHORT), false);
});

test('Windows: a deleted project stays hidden when its sessions use the real 8.3 short spelling', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const entry = s.long.replaceAll('\\', '/').toLowerCase();
  const global = { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'delete' } };
  const projects = [{ remoteAlias: null, projectPath: s.short, sessions: [{ runtime: 'claude', recordedCwd: s.short }] }];
  const visible = applyAndPersistArchived(projects, true, { getSetting: key => key === 'global' ? global : {}, setSetting() {} });
  assert.deepEqual(visible, [], 'the short spelling must match the long-form deletion entry');
});

function settingsWriter(dir, global) {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ global }));
  const db = {
    getSetting: key => JSON.parse(fs.readFileSync(file, 'utf8'))[key],
    setSetting(key, value) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state[key] = value;
      fs.writeFileSync(file, JSON.stringify(state));
    },
    getAllCached: () => [], deleteCachedFolder() {}, deleteSearchFolder() {},
  };
  return { db, writer: memoryWriter(db) };
}

test('Windows: Add project under the short spelling clears its long-form hide entry', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const entry = s.long.replaceAll('\\', '/').toLowerCase();
  const sibling = path.join(s.dir, 'missing~1');
  const h = settingsWriter(s.dir, { hiddenProjects: [entry, sibling], hiddenProjectKinds: { [entry]: 'delete', [sibling]: 'archive' } });
  await h.writer.revealAddedProject(s.short);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [sibling], 'the long-form entry must be cleared and a missing path kept');
});

test('Windows: unhiding a long-form entry from a project spelled short removes it', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const h = settingsWriter(s.dir, { hiddenProjects: [s.long], hiddenProjectKinds: { [s.long]: 'archive' } });
  await h.writer.unhideProject(s.long, null, s.short);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'the entry must be removed when the project is spelled short');
});
