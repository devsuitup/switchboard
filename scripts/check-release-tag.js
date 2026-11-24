#!/usr/bin/env node
// see docs/releasing.md ("The tag check")
'use strict';

const { execFileSync } = require('child_process');
const { parseChangelog, compareVersions } = require('../src/main/app/changelog');

const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const ALLOWED_FINAL_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json'];

function parseTag(tag) {
  const m = typeof tag === 'string' ? TAG_RE.exec(tag) : null;
  if (!m) return null;
  return { version: tag.slice(1), base: `${m[1]}.${m[2]}.${m[3]}`, beta: m[4] === undefined ? null : Number(m[4]) };
}

function lastBetaTag(tags, base) {
  let best = null;
  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (parsed && parsed.base === base && parsed.beta !== null && (!best || parsed.beta > best.beta)) best = { tag, beta: parsed.beta };
  }
  return best ? best.tag : null;
}

function withoutVersion(file, text) {
  if (text === null) return null;
  const json = JSON.parse(text);
  delete json.version;
  if (file === 'package-lock.json' && json.packages && json.packages['']) delete json.packages[''].version;
  return JSON.stringify(json);
}

const fail = (message) => ({ ok: false, message });

function checkReleaseTag({ tag, tags, readFile, changedFiles }) {
  const parsed = parseTag(tag);
  if (!parsed) return fail(`${tag} is not a release tag: expected vX.Y.Z or vX.Y.Z-beta.N (N from 1)`);
  const pkg = readFile(tag, 'package.json');
  const pkgVersion = pkg === null ? null : JSON.parse(pkg).version;
  if (pkgVersion !== parsed.version) {
    return fail(`package.json at ${tag} carries version ${pkgVersion}, not ${parsed.version}: tag the release commit`);
  }
  if (parsed.beta !== null) return { ok: true, message: `${tag}: beta tag, package.json at ${parsed.version}` };

  const beta = lastBetaTag(tags, parsed.base);
  if (!beta) {
    return { ok: true, message: `${tag}: final, package.json at ${parsed.version}; no v${parsed.base}-beta.N tag, so no beta comparison` };
  }
  const files = changedFiles(beta, tag);
  const others = files.filter((f) => !ALLOWED_FINAL_FILES.includes(f));
  if (others.length > 0) {
    return fail([
      `${tag} differs from its last beta ${beta} by more than ${ALLOWED_FINAL_FILES.join(', ')}:`,
      ...others.map((f) => `  ${f}`),
      'Code merged after the last beta ships in a new beta first; cut one, then the final from it.',
    ].join('\n'));
  }
  for (const file of ['package.json', 'package-lock.json']) {
    if (!files.includes(file)) continue;
    if (withoutVersion(file, readFile(beta, file)) !== withoutVersion(file, readFile(tag, file))) {
      return fail(`${file} at ${tag} differs from ${beta} by more than its version`);
    }
  }
  let versions;
  try {
    versions = parseChangelog(readFile(tag, 'CHANGELOG.md') || '').versions;
  } catch (err) {
    return fail(`CHANGELOG.md at ${tag} does not parse: ${err.message}`);
  }
  if (!versions.some((v) => compareVersions(v.version, parsed.version) === 0)) {
    return fail(`CHANGELOG.md at ${tag} has no section for v${parsed.version}`);
  }
  const leftover = versions.filter((v) => parseTag(`v${v.version}`)?.base === parsed.base && v.version !== parsed.version);
  if (leftover.length > 0) {
    return fail(`CHANGELOG.md at ${tag} still has ${leftover.map((v) => `v${v.version}`).join(', ')}: fold the beta sections into the v${parsed.version} one`);
  }
  return { ok: true, message: `${tag}: differs from ${beta} only by ${files.length ? files.join(', ') : 'nothing'}` };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readFileAt(ref, file) {
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  try {
    return git(['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

if (require.main === module) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: check-release-tag.js <tag>');
    process.exitCode = 2;
  } else {
    try {
      const result = checkReleaseTag({
        tag,
        tags: git(['tag', '--list']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        readFile: readFileAt,
        changedFiles: (from, to) => git(['diff', '--name-only', '--no-renames', from, to])
          .split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      });
      if (result.ok) console.log(result.message);
      else console.error(`::error::${result.message.split('\n')[0]}\n${result.message}`);
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      console.error(`::error::${err.message}`);
      process.exitCode = 2;
    }
  }
}

module.exports = { ALLOWED_FINAL_FILES, parseTag, lastBetaTag, checkReleaseTag };
