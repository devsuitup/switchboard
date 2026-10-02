#!/usr/bin/env node
// see docs/releasing.md
'use strict';

const fs = require('fs');
const path = require('path');
const { parseChangelog, compareVersions } = require('../changelog');

function releaseNotes(text, tag) {
  const version = tag.replace(/^v/, '');
  const section = parseChangelog(text).versions.find((v) => compareVersions(v.version, version) === 0);
  if (!section) throw new Error(`CHANGELOG.md has no "## v${version} — YYYY-MM-DD" section`);
  if (!section.body) throw new Error(`the CHANGELOG.md section for v${version} is empty`);
  return section.body;
}

if (require.main === module) {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    process.stdout.write(releaseNotes(text, process.argv[2] || '') + '\n');
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { releaseNotes };
