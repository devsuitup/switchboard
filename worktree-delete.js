'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

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

async function readStatus(worktreePath, parentRepo, runGit) {
  const list = await runGit(['-C', parentRepo, 'worktree', 'list', '--porcelain', '-z']);
  const records = list.split('\0\0').map(record => record.split('\0'));
  const fields = records.find(record => record[0]?.startsWith('worktree ')
    && comparablePath(record[0].slice(9)) === comparablePath(worktreePath));
  if (!fields) throw new Error('This path is no longer a registered worktree. Refresh the project list before trying Delete again.');
  const branch = fields.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || '(detached HEAD)';
  const lock = fields.find(line => line === 'locked' || line.startsWith('locked '));
  const locked = lock !== undefined;
  const lockReason = locked ? lock.slice(6).trim() : '';
  const output = await runGit(['-C', parentRepo, '-C', worktreePath, 'status', '--porcelain=v1', '-z', '--ignored']);
  const entries = output.split('\0').filter(Boolean);
  const dirty = [], ignored = [], recordsForFingerprint = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith('!! ')) ignored.push(entry);
    else if (/^[RC]|^.[RC]/.test(entry)) {
      const source = entries[++i];
      if (source === undefined) throw new Error('Git returned an incomplete rename. Review the worktree and try Delete again.');
      recordsForFingerprint.push(JSON.stringify([entry, source]));
      dirty.push(`${entry.slice(0, 3)}${source} -> ${entry.slice(3)}`);
    } else {
      recordsForFingerprint.push(JSON.stringify([entry]));
      dirty.push(entry);
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([
    comparablePath(worktreePath), fields, recordsForFingerprint.sort(), ignored.sort(),
  ])).digest('hex');
  return { ok: true, path: worktreePath, branch, locked, lockReason, dirty, total: dirty.length,
    ignoredCount: ignored.length, fingerprint };
}

function changed(status, error = 'The worktree changed since the dialog opened.') {
  return { ok: false, refresh: true, status, error: `${error} Review the refreshed status and confirm Delete again, or Cancel to keep the folder.` };
}

async function removeWorktree(worktreePath, parentRepo, shown, read, runGit) {
  const current = await read();
  if (!shown || typeof shown.fingerprint !== 'string' || shown.fingerprint !== current.fingerprint) return changed(current);
  if (current.locked && shown.confirmLocked !== true) return changed(current,
    `The worktree is locked${current.lockReason ? ': ' + current.lockReason : ''}. Explicit lock confirmation is required.`);
  const args = ['-C', parentRepo, 'worktree', 'remove'];
  if (current.locked) args.push('-f', '-f');
  else if (current.dirty.length > 0) args.push('-f');
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
