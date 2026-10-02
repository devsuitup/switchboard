// scripts/changelog-section.js: the release notes are the tag's CHANGELOG.md section — see docs/releasing.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { releaseNotes } = require('../scripts/changelog-section');

const ROOT = path.join(__dirname, '..');

const TEXT = [
  '# Changelog', '',
  '## Unreleased', '', '### New', '- Later. (#3)', '',
  '## v0.0.2 — 2026-10-02', '', '### Fixed', '- Two. (#2)', '',
  '## v0.0.1 — 2026-10-01', '', '',
  '---', '', 'Older versions: see GitHub Releases.', '',
].join('\n');

test('the notes of a tag are its section, without the version heading', () => {
  assert.equal(releaseNotes(TEXT, 'v0.0.2'), '### Fixed\n- Two. (#2)');
  assert.equal(releaseNotes(TEXT, '0.0.2'), '### Fixed\n- Two. (#2)');
});

test('a tag with no section is an error that says what to do', () => {
  assert.throws(() => releaseNotes(TEXT, 'v0.0.3'), /no "## v0\.0\.3 — YYYY-MM-DD" section/);
});

test('a tag whose section is empty is an error, never an empty body', () => {
  assert.throws(() => releaseNotes(TEXT, 'v0.0.1'), /section for v0\.0\.1 is empty/);
});

test('the Unreleased section is never published as a version', () => {
  assert.throws(() => releaseNotes(TEXT.replace('## v0.0.2 — 2026-10-02', '## v0.0.9 — 2026-10-02'), 'v0.0.2'), /no "## v0\.0\.2/);
});

test('the build workflow writes the release body from the tag\'s changelog section', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Fill in release notes'));
  assert.match(step, /node scripts\/changelog-section\.js "\$TAG" > release-notes\.md/);
  assert.match(step, /gh release edit "\$TAG" --notes-file release-notes\.md/);
});
