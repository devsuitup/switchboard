// git-changes.js — pure parser for the Changes panel — see .ai/contexts/changes-view.md

'use strict';

// dotAll: a raw newline inside a -z path must still match — see .ai/contexts/changes-view.md
const ORDINARY_RE = /^1 (?<xy>\S\S) (?<sub>\S+) (?<mH>\S+) (?<mI>\S+) (?<mW>\S+) (?<hH>\S+) (?<hI>\S+) (?<path>.+)$/s;
const RENAME_RE = /^2 (?<xy>\S\S) (?<sub>\S+) (?<mH>\S+) (?<mI>\S+) (?<mW>\S+) (?<hH>\S+) (?<hI>\S+) (?<score>\S+) (?<path>.+)$/s;
const UNMERGED_RE = /^u (?<xy>\S\S) (?<sub>\S+) (?<m1>\S+) (?<m2>\S+) (?<m3>\S+) (?<mW>\S+) (?<h1>\S+) (?<h2>\S+) (?<h3>\S+) (?<path>.+)$/s;

function makeOrdinaryFile(path, xy, renamed, origPath) {
  const X = xy[0];
  const Y = xy[1];
  return {
    path,
    origPath: origPath || null,
    staged: X !== '.',
    unstaged: Y !== '.',
    untracked: false,
    renamed: !!renamed,
    state: X !== '.' ? X : Y,
  };
}

// Parse `git status --porcelain=v2 --branch -z` output — see .ai/contexts/changes-view.md ("Quoting rule: -z instead of core.quotepath")
function parseStatusPorcelainV2(text) {
  const branch = { head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  const tokens = String(text || '').split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (!raw) continue; // trailing empty token after the final NUL, or empty input

    if (raw.startsWith('# branch.head ')) {
      const v = raw.slice('# branch.head '.length).trim();
      branch.head = v === '(detached)' ? null : v;
      continue;
    }
    if (raw.startsWith('# branch.upstream ')) {
      branch.upstream = raw.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (raw.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(raw);
      if (m) {
        branch.ahead = parseInt(m[1], 10);
        branch.behind = parseInt(m[2], 10);
      }
      continue;
    }
    if (raw.startsWith('#')) continue; // other header lines (branch.oid, etc.) — not modeled

    if (raw.startsWith('1 ')) {
      const m = ORDINARY_RE.exec(raw);
      if (!m) continue;
      files.push(makeOrdinaryFile(m.groups.path, m.groups.xy, false, null));
      continue;
    }
    if (raw.startsWith('2 ')) {
      const m = RENAME_RE.exec(raw);
      if (!m) continue;
      // -z rename layout: path then origPath as the next NUL token — see .ai/contexts/changes-view.md
      const origPath = tokens[i + 1];
      i += 1;
      files.push(makeOrdinaryFile(m.groups.path, m.groups.xy, true, typeof origPath === 'string' ? origPath : null));
      continue;
    }
    if (raw.startsWith('u ')) {
      const m = UNMERGED_RE.exec(raw);
      if (!m) continue;
      files.push(makeOrdinaryFile(m.groups.path, m.groups.xy, false, null));
      continue;
    }
    if (raw.startsWith('? ')) {
      files.push({
        path: raw.slice(2),
        origPath: null,
        staged: false,
        unstaged: false,
        untracked: true,
        renamed: false,
        state: '?',
      });
      continue;
    }
  }

  return { branch, files };
}

// Parse `git diff --numstat -z` output — see .ai/contexts/changes-view.md ("Quoting rule: -z instead of core.quotepath")
function parseNumstat(text) {
  const result = {};
  const tokens = String(text || '').split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue; // trailing empty token, or a blank/malformed line
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tok);
    if (!m) continue;
    const added = m[1] === '-' ? null : parseInt(m[1], 10);
    const deleted = m[2] === '-' ? null : parseInt(m[2], 10);
    if (m[3] === '') {
      // -z numstat rename: empty path field, then old and new paths — see .ai/contexts/changes-view.md
      const newPath = tokens[i + 2];
      i += 2;
      if (typeof newPath === 'string') result[newPath] = { added, deleted };
      continue;
    }
    result[m[3]] = { added, deleted };
  }
  return result;
}

function combineCounts(a, b) {
  if ((a && a.added === null) || (b && b.added === null)) return { added: null, deleted: null };
  const added = (a ? a.added || 0 : 0) + (b ? b.added || 0 : 0);
  const deleted = (a ? a.deleted || 0 : 0) + (b ? b.deleted || 0 : 0);
  return { added, deleted };
}

// Combine status + both numstat maps into the panel's model — see .ai/contexts/changes-view.md
function mergeChanges(status, numstatStaged, numstatUnstaged) {
  const staged = numstatStaged || {};
  const unstaged = numstatUnstaged || {};
  const files = (status && status.files ? status.files : []).map((f) => {
    if (f.untracked) return { ...f, added: null, deleted: null };
    const counts = combineCounts(staged[f.path], unstaged[f.path]);
    return { ...f, added: counts.added, deleted: counts.deleted };
  });

  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of files) {
    if (typeof f.added === 'number') totalAdded += f.added;
    if (typeof f.deleted === 'number') totalDeleted += f.deleted;
  }

  return {
    branch: (status && status.branch) || { head: null, upstream: null, ahead: 0, behind: 0 },
    files,
    totals: { files: files.length, added: totalAdded, deleted: totalDeleted },
  };
}

module.exports = { parseStatusPorcelainV2, parseNumstat, mergeChanges };
