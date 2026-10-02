'use strict';

// see .ai/contexts/ipc-bridge.md (IPC path-guard inventory, `open-terminal` row)
const { spawnSync } = require('child_process');

const NTSTATUS_FLOOR = 0x80000000;
const MAX_RETRIES = 2;

function isNtStatusCrash(status) {
  if (typeof status !== 'number') return false;
  return (status >>> 0) >= NTSTATUS_FLOOR;
}

function spawnSyncRetryingCrash(cmd, args, opts, { spawn = spawnSync, log = (m) => process.stderr.write(m) } = {}) {
  let res = spawn(cmd, args, opts);
  for (let attempt = 1; attempt <= MAX_RETRIES && isNtStatusCrash(res.status); attempt++) {
    log(`spawn-retry: ${cmd} exited ${res.status >>> 0} (0x${(res.status >>> 0).toString(16)}), retry ${attempt}/${MAX_RETRIES}\n`);
    res = spawn(cmd, args, opts);
  }
  return res;
}

module.exports = { spawnSyncRetryingCrash, isNtStatusCrash };
