// CHANGELOG.md parsing and the What's new decisions — see docs/changelog.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  compareVersions,
  parseChangelog,
  sectionsBetween,
  whatsNewOnStartup,
  whatsNewForVersion,
} = require('../changelog');

const ROOT = path.join(__dirname, '..');

const SAMPLE = [
  '# Changelog',
  '',
  'Intro line.',
  '',
  '## Unreleased',
  '',
  '### New',
  '- Pending thing. (#9)',
  '',
  '## v0.0.100 — 2026-10-03',
  '',
  '### Fixed',
  '- Hundredth. (#8)',
  '',
  '## v0.0.99 — 2026-10-02',
  '',
  '### New',
  '- Ninety-nine. (#7)',
  '',
  '## v0.0.98 — 2026-10-01',
  '',
  '### Changed',
  '- Ninety-eight. (#6)',
  '',
  '---',
  '',
  'Older versions: see GitHub Releases.',
  '',
].join('\n');

test('compareVersions orders numerically, not as text: 0.0.100 is greater than 0.0.99', () => {
  assert.equal(compareVersions('0.0.100', '0.0.99'), 1);
  assert.equal(compareVersions('0.0.99', '0.0.100'), -1);
  assert.equal(compareVersions('0.1.0', '0.0.999'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.0.84', '0.0.84'), 0);
});

test('compareVersions accepts a leading v on either side', () => {
  assert.equal(compareVersions('v0.0.85', '0.0.84'), 1);
  assert.equal(compareVersions('0.0.84', 'v0.0.84'), 0);
});

test('compareVersions throws on something that is not X.Y.Z', () => {
  for (const bad of ['', '0.0', '0.0.x', 'latest', null, undefined, 84, '0.0.84.1']) {
    assert.throws(() => compareVersions(bad, '0.0.1'), TypeError, `accepted ${String(bad)}`);
    assert.throws(() => compareVersions('0.0.1', bad), TypeError, `accepted ${String(bad)}`);
  }
});

test('parseChangelog reads the Unreleased body and each version with its date, in file order', () => {
  const parsed = parseChangelog(SAMPLE);
  assert.equal(parsed.unreleased, '### New\n- Pending thing. (#9)');
  assert.deepEqual(parsed.versions.map((v) => [v.version, v.date]), [
    ['0.0.100', '2026-10-03'],
    ['0.0.99', '2026-10-02'],
    ['0.0.98', '2026-10-01'],
  ]);
  assert.equal(parsed.versions[1].body, '### New\n- Ninety-nine. (#7)');
});

test('parseChangelog ends the last section at the closing rule, so the pointer line is not part of it', () => {
  const last = parseChangelog(SAMPLE).versions.at(-1);
  assert.equal(last.body, '### Changed\n- Ninety-eight. (#6)');
});

test('parseChangelog accepts CRLF line endings', () => {
  const parsed = parseChangelog(SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(parsed.versions[0].body, '### Fixed\n- Hundredth. (#8)');
});

test('parseChangelog throws on a file with no version section', () => {
  assert.throws(() => parseChangelog('# Changelog\n\n## Unreleased\n\n- x\n'), /no version section/);
  assert.throws(() => parseChangelog(''), /no version section/);
});

test('parseChangelog throws on a second-level heading that is neither Unreleased nor a version', () => {
  assert.throws(() => parseChangelog(SAMPLE.replace('## v0.0.99 — 2026-10-02', '## Version 99')), /malformed heading/);
  assert.throws(() => parseChangelog(SAMPLE.replace('## v0.0.99 — 2026-10-02', '## v0.0.99')), /malformed heading/);
});

test('parseChangelog throws on something that is not a string', () => {
  assert.throws(() => parseChangelog(null), TypeError);
  assert.throws(() => parseChangelog(Buffer.from(SAMPLE)), TypeError);
});

test('sectionsBetween keeps every version after the last seen, up to the current one, skipped ones included, newest first', () => {
  const { versions } = parseChangelog(SAMPLE);
  assert.deepEqual(sectionsBetween(versions, '0.0.97', '0.0.100').map((v) => v.version), ['0.0.100', '0.0.99', '0.0.98']);
  assert.deepEqual(sectionsBetween(versions, '0.0.98', '0.0.100').map((v) => v.version), ['0.0.100', '0.0.99']);
});

test('sectionsBetween excludes the last seen version and anything newer than the current one', () => {
  const { versions } = parseChangelog(SAMPLE);
  assert.deepEqual(sectionsBetween(versions, '0.0.98', '0.0.99').map((v) => v.version), ['0.0.99']);
  assert.deepEqual(sectionsBetween(versions, '0.0.99', '0.0.99'), []);
});

test('sectionsBetween sorts newest first whatever the file order', () => {
  const { versions } = parseChangelog(SAMPLE);
  const shuffled = [versions[2], versions[0], versions[1]];
  assert.deepEqual(sectionsBetween(shuffled, '0.0.1', '0.0.100').map((v) => v.version), ['0.0.100', '0.0.99', '0.0.98']);
});

function reader(text) {
  let calls = 0;
  const read = () => { calls++; return text; };
  read.calls = () => calls;
  return read;
}

test('startup after an update shows the sections since the last seen version and records nothing yet', () => {
  const read = reader(SAMPLE);
  const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion: '0.0.98', readChangelog: read });
  assert.deepEqual(result.sections.map((s) => s.version), ['0.0.100', '0.0.99']);
  assert.equal(result.record, null);
  assert.equal(result.error, null);
});

test('startup on a fresh install shows nothing, records the current version and never reads the file', () => {
  for (const lastSeenVersion of [undefined, null, '']) {
    const read = reader(SAMPLE);
    const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion, readChangelog: read });
    assert.equal(result.sections, null);
    assert.equal(result.record, '0.0.100');
    assert.equal(read.calls(), 0);
  }
});

test('startup with an unreadable stored version records the current one and shows nothing', () => {
  const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion: 'garbage', readChangelog: reader(SAMPLE) });
  assert.equal(result.sections, null);
  assert.equal(result.record, '0.0.100');
});

test('startup on the same or an older version shows nothing and records nothing', () => {
  for (const lastSeenVersion of ['0.0.100', '0.0.101']) {
    const read = reader(SAMPLE);
    const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion, readChangelog: read });
    assert.equal(result.sections, null);
    assert.equal(result.record, null);
    assert.equal(read.calls(), 0);
  }
});

test('startup with a missing changelog shows nothing, reports the error and records nothing', () => {
  const missing = () => { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; };
  const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion: '0.0.98', readChangelog: missing });
  assert.equal(result.sections, null);
  assert.equal(result.record, null);
  assert.match(result.error, /ENOENT/);
});

test('startup with a broken changelog shows nothing, reports the error and records nothing', () => {
  const result = whatsNewOnStartup({ currentVersion: '0.0.100', lastSeenVersion: '0.0.98', readChangelog: reader('## nonsense\n') });
  assert.equal(result.sections, null);
  assert.equal(result.record, null);
  assert.match(result.error, /malformed heading/);
});

test('startup with no section in range records the current version and shows nothing', () => {
  const result = whatsNewOnStartup({ currentVersion: '0.0.101', lastSeenVersion: '0.0.100', readChangelog: reader(SAMPLE) });
  assert.equal(result.sections, null);
  assert.equal(result.record, '0.0.101');
  assert.equal(result.error, null);
});

test('the menu entry gives the current version section only', () => {
  const result = whatsNewForVersion({ currentVersion: '0.0.99', readChangelog: reader(SAMPLE) });
  assert.deepEqual(result.sections.map((s) => s.version), ['0.0.99']);
  assert.equal(result.error, null);
});

test('the menu entry gives nothing and an error when the current version has no section or the file is broken', () => {
  const absent = whatsNewForVersion({ currentVersion: '0.0.101', readChangelog: reader(SAMPLE) });
  assert.equal(absent.sections, null);
  assert.match(absent.error, /no section for 0\.0\.101/);
  const broken = whatsNewForVersion({ currentVersion: '0.0.99', readChangelog: reader('') });
  assert.equal(broken.sections, null);
  assert.match(broken.error, /no version section/);
});

test('the repository CHANGELOG.md parses, and has a section for the version in package.json', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const { unreleased, versions } = parseChangelog(text);
  assert.equal(typeof unreleased, 'string', 'CHANGELOG.md must keep a ## Unreleased section');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(versions.some((v) => v.version === version), `CHANGELOG.md has no section for ${version}`);
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareVersions(versions[i - 1].version, versions[i].version), 1, 'versions must be newest first');
  }
});

test('electron-builder packages CHANGELOG.md', () => {
  const { build } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(build.files.includes('CHANGELOG.md'), 'CHANGELOG.md must be in build.files, or the packaged app has no changelog to read');
});
