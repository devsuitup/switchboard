'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { resolveOnDisk } = require('./resolve-path-on-disk');

const HASH_LIMIT = 512 * 1024 * 1024;
const DIRECTORY_LIMIT = 200000;
const DIRECTORY_SCAN_MS = 5000;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function refuseDirectoryLinks(root) {
  const started = Date.now();
  const checkTime = () => {
    if (Date.now() - started >= DIRECTORY_SCAN_MS) throw new Error('Directory link scan exceeded its 5 second time budget. Review or reduce the worktree directories before trying Delete again.');
  };
  const realRoot = await fs.promises.realpath(root).catch(() => null);
  if (!realRoot) {
    try { await fs.promises.lstat(root); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Cannot resolve the worktree on disk. Review its permissions before deleting.');
  }
  const links = [];
  let count = 0;
  async function checkLink(directory, expectedPath) {
    let stat, target;
    try {
      stat = await fs.promises.stat(directory);
      if (stat.isFile()) return;
      target = await fs.promises.realpath(directory);
    } catch { target = null; }
    if (stat?.isDirectory() && target === expectedPath) return true;
    if (process.platform === 'win32' || !stat?.isDirectory() || !target || (target !== realRoot && !within(realRoot, target))) {
      count++;
      if (links.length < 10) links.push(path.resolve(directory));
    }
  }
  const stat = await fs.promises.lstat(root);
  const pending = [];
  let directories = 1;
  if (stat.isSymbolicLink()) {
    const realParent = await fs.promises.realpath(path.dirname(root));
    await checkLink(root, path.join(realParent, path.basename(root)));
    if (!count) pending.push({ directory: root, realDirectory: realRoot });
  }
  else if (stat.isDirectory()) pending.push({ directory: root, realDirectory: realRoot });
  while (pending.length) {
    checkTime();
    const batch = pending.splice(Math.max(0, pending.length - 32));
    const results = await Promise.allSettled(batch.map(({ directory }) => fs.promises.readdir(directory, { withFileTypes: true })));
    checkTime();
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') throw result.reason;
      for (const entry of result.value) {
        checkTime();
        const candidate = path.join(batch[i].directory, entry.name);
        const realCandidate = path.join(batch[i].realDirectory, entry.name);
        if (entry.isSymbolicLink() ? await checkLink(candidate, realCandidate) : entry.isDirectory()) {
          if (++directories > DIRECTORY_LIMIT) throw new Error('Directory link scan exceeds the 200,000 directory limit. Review or reduce the worktree directories before trying Delete again.');
          pending.push({ directory: candidate, realDirectory: realCandidate });
        }
      }
    }
  }
  checkTime();
  if (count) {
    const instruction = process.platform === 'win32'
      ? 'Git for Windows can follow links while removing. Remove the link first: use rmdir <path>, never a recursive delete.'
      : 'Remove the link first: use rm <link> without -r.';
    throw new Error(`Deletion refused: ${count} directory link(s): ${links.join(', ')}${count > 10 ? `; ${count - 10} more` : ''}. ${instruction} Then try Delete again.`);
  }
}

function hashBytes(budget, bytes) {
  budget.used += bytes;
  if (budget.used > HASH_LIMIT) {
    const largest = [...budget.files].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, size]) => `${name} (${size} bytes)`);
    throw new Error(`Cannot preview more than 512 MiB of total hashed data. Biggest files encountered: ${largest.join(', ') || 'Git index output'}. Review or move these files before trying Delete again.`);
  }
}

function streamGit(args, consume, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn || require('node:child_process').spawn)('git', args, {
      env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let failure, stderr = '';
    const timer = setTimeout(() => {
      failure = Object.assign(new Error('Git preview timed out. Review the worktree with Git before deleting.'), { killed: true });
      child.kill();
    }, 15000);
    child.stdout.on('data', chunk => {
      if (failure) return;
      try { consume(chunk); }
      catch (error) { failure = error; child.kill(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(stderr.trim() || `Git preview exited with ${code}`), { signal }));
      else resolve();
    });
  });
}

async function indexSnapshot(args, runGit, budget) {
  const hash = createHash('sha256'), decoder = new StringDecoder('utf8');
  const submodules = [];
  let pending = '';
  const consume = chunk => {
    hashBytes(budget, Buffer.byteLength(chunk));
    hash.update(chunk);
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\0')) !== -1) {
      const entry = pending.slice(0, end);
      if (entry.startsWith('160000 ')) submodules.push(entry.slice(entry.indexOf('\t') + 1));
      pending = pending.slice(end + 1);
    }
    if (pending.length > 1024 * 1024 || submodules.length > 100000) throw new Error('Git index preview is too large. Review the worktree with Git before deleting.');
  };
  const output = await runGit([...args, 'ls-files', '--stage', '-z'], consume);
  if (output) consume(output);
  if (pending || decoder.end()) throw new Error('Git returned an incomplete index preview. Review the worktree before deleting.');
  return { index: hash.digest('hex'), submodules: [...new Set(submodules)] };
}

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

async function fileFingerprint(root, name, submodules, runGit, depth, budget) {
  const absolute = path.resolve(root, name);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Git returned a path outside the worktree. Review the folder before deleting.');
  }
  let stat;
  try { stat = await fs.promises.lstat(absolute); }
  catch (error) { if (error.code === 'ENOENT') return ['missing']; throw error; }
  const realRoot = resolveOnDisk(root);
  const candidate = resolveOnDisk(stat.isSymbolicLink() ? path.dirname(absolute) : absolute);
  if (!realRoot || !candidate || (candidate !== realRoot && !within(realRoot, candidate))) {
    throw new Error('A file resolves outside the worktree. Review its directory links before deleting.');
  }
  if (stat.isSymbolicLink()) return ['symlink', await fs.promises.readlink(path.join(candidate, path.basename(absolute)))];
  if (stat.isDirectory()) {
    if (submodules.includes(name)) {
      try { await fs.promises.lstat(path.join(candidate, '.git')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const directory = await fs.promises.opendir(candidate);
        try {
          if (await directory.read()) throw new Error(`Uninitialised submodule ${name} is not empty. Review or move its files before trying Delete again.`);
        } finally { await directory.close(); }
        return ['submodule', 'uninitialised'];
      }
      return ['submodule', await statusSnapshot(candidate, runGit, depth + 1, budget)];
    }
    if (await fs.promises.lstat(path.join(candidate, '.git')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new Error(`Directory ${name} is a nested repository. Review or move the nested repository before trying Delete again.`);
    throw new Error(`Cannot preview the contents of directory ${name}. Review or move it before trying Delete again.`);
  }
  if (!stat.isFile()) throw new Error(`Cannot preview ${name}. Review or move it before trying Delete again.`);
  budget.files.set(absolute, stat.size);
  if (stat.size > HASH_LIMIT - budget.used) hashBytes(budget, stat.size);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(candidate)) { hashBytes(budget, chunk.length); hash.update(chunk); }
  return ['file', stat.mode, hash.digest('hex')];
}

async function statusSnapshot(worktreePath, runGit, depth = 0, budget = { used: 0, files: new Map() }) {
  if (depth > 16) throw new Error('Too many nested submodules to preview. Review the worktree with Git before deleting.');
  const args = ['-C', worktreePath];
  const output = await runGit([...args, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const ignoredOutput = await runGit([...args, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=none']);
  const { index, submodules } = await indexSnapshot(args, runGit, budget);
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
  const dirty = [], recordsForFingerprint = [], previewed = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith('!! ')) continue;
    const name = entry.slice(3);
    previewed.add(name);
    const content = await fileFingerprint(worktreePath, name, submodules, runGit, depth, budget);
    if (/^[RC]|^.[RC]/.test(entry)) {
      const source = entries[++i];
      if (source === undefined) throw new Error('Git returned an incomplete rename. Review the worktree and try Delete again.');
      recordsForFingerprint.push(JSON.stringify([entry, source, content,
        await fileFingerprint(worktreePath, source, submodules, runGit, depth, budget)]));
      dirty.push(`${entry.slice(0, 3)}${source} -> ${name}`);
    } else {
      recordsForFingerprint.push(JSON.stringify([entry, content]));
      dirty.push(entry);
    }
  }
  for (const name of submodules) {
    if (!previewed.has(name)) recordsForFingerprint.push(JSON.stringify(['gitlink', name,
      await fileFingerprint(worktreePath, name, submodules, runGit, depth, budget)]));
  }
  return { dirty, ignored, submodules, index, records: recordsForFingerprint.sort() };
}

async function readStatus(worktreePath, parentRepo, runGit, readFile = fs.promises.readFile) {
  const rawGit = runGit;
  runGit = async (...args) => {
    try { return await rawGit(...args); }
    catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(error.message)) {
        throw new Error('Git preview output is too large. Review or reduce the changed files with Git before trying Delete again.');
      }
      if (error.killed || error.signal) throw new Error('Git preview timed out or was interrupted. Review the worktree with Git before trying Delete again.');
      throw error;
    }
  };
  const list = await runGit(['-C', parentRepo, 'worktree', 'list', '--porcelain']);
  const records = list.split(/\r?\n\r?\n/).map(record => record.split(/\r?\n/));
  const registered = records.filter(record => record[0]?.startsWith('worktree '));
  const canonicalPath = async value => comparablePath(await fs.promises.realpath(value).catch(() => value));
  const requestedPath = await canonicalPath(worktreePath);
  const registeredPaths = await Promise.all(registered.map(record => canonicalPath(unquote(record[0].slice(9)))));
  const fields = registered[registeredPaths.indexOf(requestedPath)];
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
  await refuseDirectoryLinks(worktreePath);
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
  await refuseDirectoryLinks(worktreePath);
  try {
    await runGit(args);
    return { ok: true };
  } catch (error) {
    if (error.killed || error.signal) return { ok: false, error: 'Worktree removal was interrupted; the folder may be partly deleted. Review the remaining folder and Git worktree registration before trying again.' };
    try {
      const fresh = await read();
      return changed(fresh, `Git refused to remove the worktree: ${error.message}`);
    } catch {
      return { ok: false, error: `Git refused to remove the worktree: ${error.message}. Its registration may already be gone and the folder may be partly deleted; review it on disk.` };
    }
  }
}

module.exports = { readStatus, removeWorktree, runningSessions, streamGit };
