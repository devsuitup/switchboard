'use strict';

const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { stopProcessTree } = require('./stop-process-tree');

const SNAPSHOT_TIMEOUT_MS = 1500;

function queryWindowsProcesses({ execute = execFile } = {}) {
  return new Promise(resolve => {
    let child;
    const timer = setTimeout(() => { resolve(null); try { child?.kill(); } catch {} }, SNAPSHOT_TIMEOUT_MS);
    const finish = rows => { clearTimeout(timer); resolve(rows); };
    try {
      child = execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-process-snapshot.ps1')],
        { windowsHide: true, timeout: SNAPSHOT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return finish(null);
          try {
            const parsed = JSON.parse(stdout);
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            if (!rows.every(row => row && Number.isSafeInteger(row.pid) && row.pid >= 0
              && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0
              && typeof row.created === 'string' && /^\d+$/.test(row.created))) return finish(null);
            finish(rows);
          } catch { finish(null); }
        });
    } catch { finish(null); }
  });
}

function descendants(rows, pid) {
  const root = rows?.find(row => row.pid === pid);
  if (!root) return [];
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.parentPid)) children.set(row.parentPid, []);
    children.get(row.parentPid).push(row);
  }
  const found = [], seen = new Set([pid]), pending = [root];
  for (let i = 0; i < pending.length; i++) {
    const parent = pending[i];
    for (const child of children.get(parent.pid) || []) {
      if (seen.has(child.pid) || BigInt(child.created) < BigInt(parent.created)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

async function closeWindowsPty(pid, close, { isCurrent = () => true, queryProcesses = queryWindowsProcesses,
  wait = delay, stopTree = stopProcessTree } = {}) {
  let snapshot = [], cleanup = false;
  try {
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isCurrent()) {
      snapshot = descendants(await queryProcesses(), pid);
      cleanup = isCurrent();
    }
  } catch {}
  close();
  if (!cleanup || !snapshot.length) return;
  try {
    await wait(500);
    const current = await queryProcesses();
    if (!current) return;
    const survivors = new Map(current.map(row => [row.pid, row.created]));
    await Promise.all(snapshot.filter(row => survivors.get(row.pid) === row.created)
      .map(row => stopTree(row.pid)));
  } catch {}
}

module.exports = { closeWindowsPty, queryWindowsProcesses };
