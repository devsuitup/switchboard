#!/usr/bin/env node
// see docs/releasing.md ("The tag check")
'use strict';

const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const BUMP_FILES = new Set(['CHANGELOG.md', 'package.json', 'package-lock.json']);
const DOCS = 'docs/releasing.md#the-tag-check';

function checkTagProvenance({ tag, resolveTag, containingBranches }) {
  const sha = resolveTag(tag);
  const branches = containingBranches(sha).filter(ref => /^refs\/remotes\/origin\/release\/[^/]+$/.test(ref));
  if (branches.length === 0) {
    return { ok: false, message: tag + ' (' + sha + '): releases must come from release/*; the tag commit is not reachable from any origin/release/* branch. See ' + DOCS };
  }
  return { ok: true, message: tag + ': reachable from ' + branches.join(', ') };
}

function isBump(sha, commit, readFileAt) {
  if (!commit.files.length || !commit.files.every(file => BUMP_FILES.has(file))) return false;
  return commit.files.every(file => {
    if (file === 'CHANGELOG.md') return true;
    if (commit.parents.length !== 1) return false;
    const values = [commit.parents[0], sha].map(ref => {
      const text = readFileAt(ref, file);
      if (text === null) return null;
      let value;
      try {
        value = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      delete value.version;
      if (file === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
      return value;
    });
    return values.every(value => value !== null) && isDeepStrictEqual(values[0], values[1]);
  });
}

function checkMerge(sha, commit, { mergeTree, diffFiles, readFileAt }) {
  if (commit.parents.length > 2) return 'octopus merge (' + commit.parents.length + ' parents) is unsupported';
  const automatic = mergeTree(...commit.parents);
  const handResolved = automatic.conflicts.filter(file => !BUMP_FILES.has(file));
  if (handResolved.length) return 'hand-resolved paths outside bump files: ' + handResolved.join(', ');
  const files = diffFiles(automatic.tree, sha);
  const invalid = [...new Set([...files, ...automatic.conflicts])].filter(file => {
    const parents = automatic.conflicts.includes(file) ? commit.parents : [automatic.tree];
    return !parents.every(parent => isBump(sha, { parents: [parent], files: [file] }, readFileAt));
  });
  return invalid.length ? 'merge resolution changes more than bump version fields: ' + invalid.join(', ') : null;
}

function checkReleaseProvenance({ base, head, listCommits, readCommit, readFileAt, isOnMain, mergeTree, diffFiles, patchId }) {
  const offenders = [];
  const commits = listCommits(base, head);
  for (const sha of commits) {
    if (isOnMain(sha)) continue;
    const commit = readCommit(sha);
    if (commit.parents.length > 1) {
      const reason = checkMerge(sha, commit, { mergeTree, diffFiles, readFileAt });
      if (reason) offenders.push('  ' + sha + ' ' + commit.message.split(/\r?\n/)[0] + ': ' + reason);
      continue;
    }
    if (isBump(sha, commit, readFileAt)) continue;
    const sources = [...commit.message.matchAll(/^\(cherry picked from commit ([a-fA-F0-9]{40}|[a-fA-F0-9]{64})\)\r?$/gm)];
    if (sources.some(match => {
      const source = match[1];
      if (!isOnMain(source)) return false;
      const patch = patchId(sha);
      if (patch && patch === patchId(source)) return true;
      const sourceFiles = new Set(readCommit(source).files);
      return commit.files.every(file => sourceFiles.has(file));
    })) continue;
    const reason = sources.length ? ': cherry-pick trailer does not match its source on origin/main' : '';
    offenders.push('  ' + sha + ' ' + commit.message.split(/\r?\n/)[0] + reason);
  }
  if (offenders.length) {
    return { ok: false, message: [
      'Release provenance: fixes must land on main first, then use git cherry-pick -x into release/*.',
      'Each commit must be on origin/main, a checked two-parent merge, a bump changing only CHANGELOG.md and package/lock version fields, or a matching cherry-pick from origin/main.',
      ...offenders,
      'See ' + DOCS,
    ].join('\n') };
  }
  return { ok: true, message: base + ': all ' + commits.length + ' incoming commits have release provenance' };
}

function createGitReaders({ cwd, env } = {}) {
  const git = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = text => text.split(/\r?\n/).filter(Boolean);
  const resolve = ref => git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
  return {
    resolveTag: tag => resolve('refs/tags/' + tag),
    containingBranches: sha => lines(git(['for-each-ref', '--format=%(refname)', '--contains=' + sha, 'refs/remotes/origin/release/'])),
    listCommits: (base, head) => {
      resolve('refs/remotes/origin/main');
      const baseSha = resolve('refs/remotes/origin/' + base);
      const headSha = resolve(head);
      return lines(git(['rev-list', baseSha + '..' + headSha]));
    },
    mergeTree: (first, second) => {
      let output;
      try {
        output = git(['merge-tree', '--write-tree', '--name-only', '-z', first, second]);
      } catch (err) {
        if (err.status !== 1) throw err;
        output = err.stdout;
      }
      const [tree, ...fields] = String(output).split('\0');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new Error('Invalid merge-tree output');
      const end = fields.indexOf('');
      if (end < 0) throw new Error('Invalid merge-tree conflict paths');
      return { tree, conflicts: fields.slice(0, end) };
    },
    diffFiles: (before, after) => git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', before, after]).split('\0').filter(Boolean),
    patchId: sha => {
      const patch = git(['show', '--pretty=format:', '--binary', '--no-renames', sha, '--']);
      return git(['patch-id', '--stable'], patch).trim().split(/\s+/)[0] || null;
    },
    readCommit: sha => ({
      parents: git(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/).slice(1),
      message: git(['show', '-s', '--format=%B', sha]),
      files: git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha]).split('\0').filter(Boolean),
    }),
    readFileAt: (sha, file) => {
      try {
        return git(['show', sha + ':' + file]);
      } catch (err) {
        if (err.status === 128) return null;
        throw err;
      }
    },
    isOnMain: sha => {
      const main = resolve('refs/remotes/origin/main');
      let commit;
      try {
        commit = resolve(sha);
      } catch (err) {
        if (err.status === 128) return false;
        throw err;
      }
      try {
        git(['merge-base', '--is-ancestor', commit, main]);
        return true;
      } catch (err) {
        if (err.status === 1) return false;
        throw err;
      }
    },
  };
}

if (require.main === module) {
  const [mode, ref, head, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== 'tag' && mode !== 'pr') || !ref ||
      (mode === 'tag' && head !== undefined) || (mode === 'pr' && (!head || !/^release\/[^/]+$/.test(ref)))) {
    console.error('usage: check-release-provenance.js tag <tag> | pr <release/base> <head>');
    process.exitCode = 2;
  } else {
    try {
      const readers = createGitReaders();
      const result = mode === 'tag'
        ? checkTagProvenance({ tag: ref, ...readers })
        : checkReleaseProvenance({ base: ref, head, ...readers });
      if (result.ok) console.log(result.message);
      else console.error('::error::' + result.message.split('\n')[0] + '\n' + result.message);
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      console.error('::error::' + err.message);
      process.exitCode = 2;
    }
  }
}

module.exports = { checkTagProvenance, checkReleaseProvenance, createGitReaders };
