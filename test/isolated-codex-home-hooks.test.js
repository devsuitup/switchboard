'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const isolate = require('./fixtures/isolated-codex-home.cjs');
const original = process.env.CODEX_HOME;
const outer = isolate(test);

test('nested test isolation restores the file-scoped home', async t => {
  let inner;
  await t.test('test-scoped home', child => {
    inner = isolate(child);
    assert.notEqual(inner.home, outer.home);
    assert.equal(process.env.CODEX_HOME, inner.home);
  });
  assert.equal(process.env.CODEX_HOME, outer.home);
  assert.equal(fs.existsSync(outer.home), true);
  assert.equal(fs.existsSync(inner.home), false);
});

test.after(() => {
  assert.equal(process.env.CODEX_HOME, original, 'file hook restores the original home');
  assert.equal(fs.existsSync(outer.home), false);
});
