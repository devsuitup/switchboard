// git-changes.js — pure parser for the Changes panel — see .ai/contexts/changes-view.md

'use strict';

const ORDINARY_RE = /^1 (?<xy>\S\S) (?<sub>\S+) (?<mH>\S+) (?<mI>\S+) (?<mW>\S+) (?<hH>\S+) (?<hI>\S+) (?<path>.+)$/;
const RENAME_RE = /^2 (?<xy>\S\S) (?<sub>\S+) (?<mH>\S+) (?<mI>\S+) (?<mW>\S+) (?<hH>\S+) (?<hI>\S+) (?<score>\S+) (?<rest>.+)$/;
const UNMERGED_RE = /^u (?<xy>\S\S) (?<sub>\S+) (?<m1>\S+) (?<m2>\S+) (?<m3>\S+) (?<mW>\S+) (?<h1>\S+) (?<h2>\S+) (?<h3>\S+) (?<path>.+)$/;

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

// Parse `git status --porcelain=v2 --branch` output — see .ai/contexts/changes-view.md
function parseStatusPorcelainV2(text) {
  const branch = { head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];

  for (const raw of String(text || '').split('\n')) {
    if (!raw) continue;

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
      const rest = m.groups.rest;
      const tabIdx = rest.indexOf('\t');
      const path = tabIdx >= 0 ? rest.slice(0, tabIdx) : rest;
      const origPath = tabIdx >= 0 ? rest.slice(tabIdx + 1) : null;
      files.push(makeOrdinaryFile(path, m.groups.xy, true, origPath));
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

// see .ai/contexts/changes-view.md (numstat rename spellings)
function resolveNumstatPath(raw) {
  const braceMatch = /^(.*)\{.* => (.*)\}(.*)$/.exec(raw);
  if (braceMatch) {
    return (braceMatch[1] + braceMatch[2] + braceMatch[3]).replace(/\/{2,}/g, '/');
  }
  const arrowMatch = /^(.*) => (.*)$/.exec(raw);
  if (arrowMatch) return arrowMatch[2];
  return raw;
}

// Parse `git diff --numstat` output — see .ai/contexts/changes-view.md
function parseNumstat(text) {
  const result = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const added = m[1] === '-' ? null : parseInt(m[1], 10);
    const deleted = m[2] === '-' ? null : parseInt(m[2], 10);
    const path = resolveNumstatPath(m[3]);
    result[path] = { added, deleted };
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
