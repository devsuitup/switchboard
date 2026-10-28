'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

function comparablePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(normalized) ? path.posix.normalize(normalized).toLowerCase() : path.posix.normalize(normalized);
}

function runningSessions(worktreePath, activeSessions, descriptors) {
  const root = comparablePath(worktreePath);
  const sessions = new Map();
  for (const [key, session] of [...activeSessions, ...descriptors.map(s => [s.sessionId, s])]) {
    if (!session || session.exited || session.host || !session.cwd) continue;
    const cwd = comparablePath(session.cwd);
    if (cwd !== root && !cwd.startsWith(root + '/')) continue;
    const sessionId = session.realSessionId || session.sessionId || key;
    sessions.set(sessionId, { sessionId, cwd: session.cwd });
  }
  return [...sessions.values()];
}

function unquote(value) {
  if (!value.startsWith('"')) return value;
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const char = String.fromCodePoint(value.codePointAt(i));
      bytes.push(...Buffer.from(char));
      i += char.length - 1;
    } else {
      const octal = value.slice(i + 1).match(/^[0-7]{3}/);
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; }
      else {
        const escaped = escapes[value[++i]];
        if (escaped === undefined) throw new Error('Git returned an invalid quoted path. Review the folder before deleting.');
        bytes.push(escaped);
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

async function fileFingerprint(root, name, submodules, runGit, depth) {
  const absolute = path.resolve(root, name);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Git returned a path outside the worktree. Review the folder before deleting.');
  }
  let stat;
  try { stat = await fs.promises.lstat(absolute); }
  catch (error) { if (error.code === 'ENOENT') return ['missing']; throw error; }
  if (stat.isSymbolicLink()) return ['symlink', await fs.promises.readlink(absolute)];
  if (stat.isDirectory()) {
    if (submodules.includes(name)) return ['submodule', await statusSnapshot(absolute, runGit, depth + 1)];
    throw new Error(`Cannot preview the contents of directory ${name}. Review or move it before trying Delete again.`);
  }
  if (!stat.isFile()) throw new Error(`Cannot preview ${name}. Review or move it before trying Delete again.`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
  return ['file', stat.mode, hash.digest('hex')];
}

async function statusSnapshot(worktreePath, runGit, depth = 0) {
  if (depth > 16) throw new Error('Too many nested submodules to preview. Review the worktree with Git before deleting.');
  const args = ['-C', worktreePath];
  const output = await runGit([...args, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const ignoredOutput = await runGit([...args, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=none']);
  const index = await runGit([...args, 'ls-files', '--stage', '-z']);
  const submodules = [...new Set(index.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1)))];
  const ignoredEntries = ignoredOutput.split('\0').filter(Boolean);
  const ignored = [];
  for (let i = 0; i < ignoredEntries.length; i++) {
    const entry = ignoredEntries[i];
    if (entry.startsWith('!! ')) ignored.push(entry);
    else if (/^[RC]|^.[RC]/.test(entry)) i++;
  }
  ignored.sort();
  const entries = output.split('\0').filter(Boolean);
  if (entries.length > 100000) throw new Error('Too many changed files to preview. Review the worktree with Git before deleting.');
  const dirty = [], recordsForFingerprint = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith('!! ')) continue;
    const name = entry.slice(3);
    const content = await fileFingerprint(worktreePath, name, submodules, runGit, depth);
    if (/^[RC]|^.[RC]/.test(entry)) {
      const source = entries[++i];
      if (source === undefined) throw new Error('Git returned an incomplete rename. Review the worktree and try Delete again.');
      recordsForFingerprint.push(JSON.stringify([entry, source, content,
        await fileFingerprint(worktreePath, source, submodules, runGit, depth)]));
      dirty.push(`${entry.slice(0, 3)}${source} -> ${name}`);
    } else {
      recordsForFingerprint.push(JSON.stringify([entry, content]));
      dirty.push(entry);
    }
  }
  return { dirty, ignored, submodules, index, records: recordsForFingerprint.sort() };
}

async function readStatus(worktreePath, parentRepo, runGit, readFile = fs.promises.readFile) {
  const list = await runGit(['-C', parentRepo, 'worktree', 'list', '--porcelain']);
  const records = list.split(/\r?\n\r?\n/).map(record => record.split(/\r?\n/));
  const fields = records.find(record => record[0]?.startsWith('worktree ')
    && comparablePath(unquote(record[0].slice(9))) === comparablePath(worktreePath));
  if (!fields) throw new Error('This path is no longer a registered worktree. Refresh the project list before trying Delete again.');
  const branch = fields.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || '(detached HEAD)';
  const lock = fields.find(line => line === 'locked' || line.startsWith('locked '));
  let locked = lock !== undefined;
  let lockReason = locked ? unquote(lock.slice(6).trim()) : '';
  if (!locked) {
    const lockPath = (await runGit(['-C', worktreePath, 'rev-parse', '--git-path', 'locked'])).replace(/\r?\n$/, '');
    if (!lockPath) throw new Error('Cannot locate the worktree lock file. Review the worktree with Git before trying Delete again.');
    try {
      lockReason = (await readFile(path.resolve(worktreePath, lockPath), 'utf8')).trim();
      locked = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const snapshot = await statusSnapshot(worktreePath, runGit);
  const { dirty, ignored, submodules } = snapshot;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    comparablePath(worktreePath), fields, locked, lockReason, snapshot,
  ])).digest('hex');
  return { ok: true, path: worktreePath, branch, locked, lockReason, dirty, total: dirty.length,
    ignoredCount: ignored.length, submodules, fingerprint };
}

function changed(status, error = 'The worktree changed since the dialog opened.') {
  return { ok: false, refresh: true, status, error: `${error} Review the refreshed status and confirm Delete again, or Cancel to keep the folder.` };
}

async function removeWorktree(worktreePath, parentRepo, shown, read, runGit) {
  const current = await read();
  if (!shown || typeof shown.fingerprint !== 'string' || shown.fingerprint !== current.fingerprint) return changed(current);
  if (current.locked && shown.confirmLocked !== true) return changed(current,
    `The worktree is locked${current.lockReason ? ': ' + current.lockReason : ''}. Explicit lock confirmation is required.`);
  if (current.submodules?.length && shown.confirmSubmodules !== true) return changed(current,
    'The worktree contains submodules. Explicit confirmation to force their removal is required.');
  const args = ['-C', parentRepo, 'worktree', 'remove'];
  if (current.locked) args.push('-f', '-f');
  else if (current.dirty.length > 0 || current.submodules?.length) args.push('-f');
  args.push('--', worktreePath);
  try {
    await runGit(args);
    return { ok: true };
  } catch (error) {
    const fresh = await read();
    return changed(fresh, `Git refused to remove the worktree: ${error.message}`);
  }
}

module.exports = { readStatus, removeWorktree, runningSessions };
