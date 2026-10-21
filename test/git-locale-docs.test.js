'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('localGitEnv documentation: local policy, remote exception and bounded discovery agree', () => {
  const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const changes = read('.ai/contexts/changes-view.md');
  const touched = read('.ai/contexts/touched-files.md');
  const bg = read('.ai/contexts/bg-agents.md');
  const paragraph = "Repository detection never matches Git diagnostic text. Main-process local Git runs with `LC_ALL=C`, `LC_MESSAGES=C`, and `LANG=C`, with `LANGUAGE` removed. Remote Git keeps the host's locale, so its translated diagnostics cannot be used for detection. The worktree probe reads only `git rev-parse --is-inside-work-tree`'s exit code and the literal `true`/`false` tokens; local exit 128 additionally requires the bounded filesystem corroboration below.";
  assert.ok(changes.includes(paragraph));
  for (const doc of [changes,touched]) {
    assert.match(doc,/noRepositoryAt/);
    assert.match(doc,/HEAD-less|without HEAD/);
    assert.match(doc,/gitfile/);
    assert.match(doc,/symlink/);
    assert.match(doc,/GIT_CEILING_DIRECTORIES/);
    assert.match(doc,/GIT_DISCOVERY_ACROSS_FILESYSTEM/);
    assert.match(doc,/strict ancestor/);
    assert.match(doc,/uncertainty/);
    assert.match(doc,/LANGUAGE/);
    assert.doesNotMatch(doc,/matching stderr diagnostic|stderr says "not a git repository"|exit 128 not saying|own host runs it in French/);
  }
  assert.match(changes,/only exact `false` corroborates exit 128/);
  assert.match(changes,/exit 0, stdout `true`.*\{ok: true, isRepo: true\}/);
  assert.match(changes,/exit 128, not corroborated.*\{ok: false, error\}/);
  assert.match(bg,/strips \*\*all\*\* `GIT_\*`/);
  assert.match(bg,/LC_MESSAGES=C/);
  assert.match(touched,/separate remote change/);
});
