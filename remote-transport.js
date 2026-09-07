// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const fs = require('fs');
const path = require('path');
const { isSafeRelPath } = require('./remote-hosts');

const REMOTE_PROJECTS_REL = '.claude/projects';
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const DEFAULT_LIST_TIMEOUT_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;

const SSH_BASE_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_S}`,
];

const LIST_COMMAND =
  `find ${REMOTE_PROJECTS_REL} -type f -name '*.jsonl' -printf '%T@\\t%s\\t%P\\n'`;

function parseInventory(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const mtime = Number.parseFloat(parts[0]);
    const size = Number.parseInt(parts[1], 10);
    const rel = parts.slice(2).join('\t').replace(/\r$/, '');
    if (!Number.isFinite(mtime) || !Number.isFinite(size)) continue;
    if (!isSafeRelPath(rel)) continue;
    out.push({ rel, size, mtimeMs: Math.round(mtime * 1000) });
  }
  return out;
}

/**
 * ssh/scp transport. `spawn` is injected so the process bounding, the argv and
 * the parsing are all testable without a network or an ssh binary.
 */
function createSshTransport(opts = {}) {
  const spawn = opts.spawn || require('child_process').spawn;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const listTimeoutMs = opts.listTimeoutMs || DEFAULT_LIST_TIMEOUT_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || DEFAULT_CONCURRENCY));

  // Every child stays registered until it settles; dispose() kills the set.
  const live = new Set();
  let disposed = false;

  function run(command, args, { timeoutMs, maxBytes }) {
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ code: -1, stdout: '', stderr: 'transport disposed', timedOut: false });
        return;
      }
      let child;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false });
        return;
      }
      live.add(child);

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const kill = () => {
        try { child.kill('SIGKILL'); } catch {}
      };
      // Never unref'd: this timer IS the bound on the child. Unref'd, an
      // otherwise-idle loop exits before it fires and the promise never
      // settles. see .ai/contexts/session-cache.md ("Remote SSH hosts")
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.delete(child);
        resolve({ code, stdout, stderr: stderr.slice(0, 4096), timedOut, truncated });
      };

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (stdout.length + chunk.length > (maxBytes || MAX_LIST_BYTES)) {
            truncated = true;
            kill();
            return;
          }
          stdout += chunk;
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
      }
      child.on('error', (err) => { stderr += err.message; finish(-1); });
      child.on('close', (code) => finish(code == null ? -1 : code));
    });
  }

  async function listFiles(alias) {
    const res = await run('ssh', [...SSH_BASE_OPTS, '-n', alias, LIST_COMMAND], {
      timeoutMs: listTimeoutMs,
      maxBytes: MAX_LIST_BYTES,
    });
    if (res.timedOut) throw new Error(`ssh inventory timed out after ${listTimeoutMs} ms`);
    if (res.truncated) throw new Error('ssh inventory output exceeded the size cap');
    if (res.code !== 0) throw new Error(`ssh inventory failed (exit ${res.code}): ${res.stderr.trim() || 'no stderr'}`);
    return parseInventory(res.stdout);
  }

  async function fetchOne(alias, rel, destRoot) {
    const destPath = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.part';
    // Deliberately unquoted; isSafeRelPath is the guard. see .ai/contexts/session-cache.md ("Remote SSH hosts")
    const remote = `${alias}:${REMOTE_PROJECTS_REL}/${rel}`;
    const res = await run('scp', [...SSH_BASE_OPTS, '-p', '-q', remote, tmpPath], {
      timeoutMs: fetchTimeoutMs,
    });
    if (res.code !== 0 || res.timedOut) {
      try { fs.rmSync(tmpPath, { force: true }); } catch {}
      const why = res.timedOut ? 'timed out' : `exit ${res.code}: ${res.stderr.trim()}`;
      log.warn(`[remote:${alias}] scp ${rel} failed — ${why}`);
      return false;
    }
    try {
      fs.renameSync(tmpPath, destPath);
    } catch (err) {
      try { fs.rmSync(tmpPath, { force: true }); } catch {}
      log.warn(`[remote:${alias}] could not place ${rel}: ${err.message}`);
      return false;
    }
    return true;
  }

  async function fetchFiles(alias, rels, destRoot) {
    const fetched = [];
    const failed = [];
    const queue = rels.filter(isSafeRelPath);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (!disposed) {
        const i = cursor++;
        if (i >= queue.length) return;
        const rel = queue[i];
        if (await fetchOne(alias, rel, destRoot)) fetched.push(rel);
        else failed.push(rel);
      }
    });
    await Promise.all(workers);
    // A dispose mid-run leaves the rest unfetched — report them as failures.
    for (let i = cursor; i < queue.length; i++) failed.push(queue[i]);
    return { fetched, failed };
  }

  // Kill what is running without ending the transport -- see
  // .ai/contexts/session-cache.md, "Remote hosts".
  function cancelInFlight() {
    for (const child of live) {
      try { child.kill('SIGKILL'); } catch {}
    }
    live.clear();
  }

  function dispose() {
    disposed = true;
    cancelInFlight();
  }

  return { listFiles, fetchFiles, cancelInFlight, dispose, liveCount: () => live.size };
}

module.exports = { createSshTransport, parseInventory, LIST_COMMAND, REMOTE_PROJECTS_REL };
