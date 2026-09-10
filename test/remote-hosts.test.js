'use strict';

// Folder keys and host declarations. `::` is the separator because
// encodeProjectPath only ever emits [a-zA-Z0-9-] (encode-project-path.js:5),
// so a prefixed key can never collide with a local one.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidAlias, joinFolderKey, parseFolderKey, isRemoteFolder,
  normalizeHosts, enabledHosts, normalizeRefreshMs, isSafeRelPath,
  isSafeMetaRelPath, isSafeMirrorRelPath, topFolderOf,
  MIN_REFRESH_MS,
} = require('../remote-hosts');
const { encodeProjectPath } = require('../encode-project-path');

test('a local folder key never parses as remote', () => {
  for (const p of ['/srv/supervision', 'C:\\Serveur\\switchboard', '/home/jb/my-repo.v2', '/a'.repeat(300)]) {
    const folder = encodeProjectPath(p);
    assert.equal(isRemoteFolder(folder), false, `${folder} must stay local`);
    assert.deepEqual(parseFolderKey(folder), { alias: null, folder });
  }
});

test('joinFolderKey round-trips through parseFolderKey', () => {
  const folder = encodeProjectPath('/srv/orchestration');
  const key = joinFolderKey('planificator', folder);
  assert.equal(key, 'planificator::' + folder);
  assert.deepEqual(parseFolderKey(key), { alias: 'planificator', folder });
  assert.equal(isRemoteFolder(key), true);
});

test('an unparseable prefix is treated as a local folder, not a host', () => {
  // A leading dash could be read as an ssh option; a colon-laden name is not
  // an alias we ever wrote.
  assert.equal(parseFolderKey('-oProxyCommand=x::evil').alias, null);
  assert.equal(parseFolderKey('::bare').alias, null);
  assert.equal(parseFolderKey('a b::x').alias, null);
});

test('alias validation refuses what ssh or the folder key could not carry', () => {
  assert.equal(isValidAlias('planificator'), true);
  assert.equal(isValidAlias('vps-1.example.com'), true);
  assert.equal(isValidAlias(''), false);
  // A leading dash is the one that matters: ssh would read it as an option.
  assert.equal(isValidAlias('-vps'), false);
  assert.equal(isValidAlias('-oProxyCommand=id'), false);
  assert.equal(isValidAlias('a::b'), false);
  assert.equal(isValidAlias('a b'), false);
  assert.equal(isValidAlias('a;rm -rf /'), false);
  assert.equal(isValidAlias('x'.repeat(64)), false);
});

test('normalizeHosts drops invalid and duplicate aliases and defaults the label', () => {
  const hosts = normalizeHosts([
    { alias: 'planificator' },
    { alias: 'planificator', label: 'dupe' },
    { alias: 'bad alias' },
    { alias: 'second', label: '  VPS 2  ', enabled: false },
    'nonsense',
    null,
  ]);
  assert.deepEqual(hosts, [
    { alias: 'planificator', label: 'planificator', enabled: true },
    { alias: 'second', label: 'VPS 2', enabled: false },
  ]);
  assert.deepEqual(enabledHosts(hosts).map(h => h.alias), ['planificator']);
  assert.deepEqual(normalizeHosts(undefined), []);
});

test('the refresh interval is floored at 60 s', () => {
  assert.equal(normalizeRefreshMs(1000), MIN_REFRESH_MS);
  assert.equal(normalizeRefreshMs(0), 300_000);
  assert.equal(normalizeRefreshMs('nope'), 300_000);
  assert.equal(normalizeRefreshMs(900_000), 900_000);
});

test('isSafeRelPath is the only guard between remote output and an scp argument', () => {
  assert.equal(isSafeRelPath('-srv-supervision/abc.jsonl'), true);
  assert.equal(isSafeRelPath('-srv-x/uuid/subagents/agent-1.jsonl'), true);
  assert.equal(isSafeRelPath('../../etc/passwd.jsonl'), false);
  assert.equal(isSafeRelPath('/abs/path.jsonl'), false);
  assert.equal(isSafeRelPath('a/$(id).jsonl'), false);
  assert.equal(isSafeRelPath("a/x';id;'.jsonl"), false);
  assert.equal(isSafeRelPath('a/b.txt'), false);
  assert.equal(isSafeRelPath('bare.jsonl'), true);
  assert.equal(topFolderOf('bare.jsonl'), null);
  assert.equal(topFolderOf('-srv-x/abc.jsonl'), '-srv-x');
});

// issue #244: readSubagentMeta()'s sidecar needs its own safety gate, kept
// apart from isSafeRelPath so remote-watch.js's activity classification (which
// imports isSafeRelPath directly) keeps treating a sidecar write as a no-op —
// see .ai/contexts/session-cache.md ("Remote hosts — meta.json sidecars").
test('isSafeMetaRelPath admits only a well-formed .meta.json sidecar path', () => {
  assert.equal(isSafeMetaRelPath('-srv-x/uuid/subagents/agent-1.meta.json'), true);
  assert.equal(isSafeMetaRelPath('-srv-x/uuid/subagents/agent-1.jsonl'), false);
  assert.equal(isSafeMetaRelPath('../../etc/passwd.meta.json'), false);
  assert.equal(isSafeMetaRelPath('/abs/path.meta.json'), false);
  assert.equal(isSafeMetaRelPath("a/x';id;'.meta.json"), false);
});

test('isSafeMirrorRelPath admits both a transcript and its sidecar; isSafeRelPath stays .jsonl-only', () => {
  assert.equal(isSafeMirrorRelPath('-srv-x/uuid/subagents/agent-1.jsonl'), true);
  assert.equal(isSafeMirrorRelPath('-srv-x/uuid/subagents/agent-1.meta.json'), true);
  assert.equal(isSafeMirrorRelPath('-srv-x/notes.txt'), false);
  // The regression this guards: widening isSafeRelPath itself would make
  // remote-watch.js's parseWatchLine() treat a sidecar write as project
  // activity, which issue #244 explicitly rules out.
  assert.equal(isSafeRelPath('-srv-x/uuid/subagents/agent-1.meta.json'), false);
});
