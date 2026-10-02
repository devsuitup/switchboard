// The ssh and scp binaries every remote operation runs — see docs/remote-hosts.md ("Which ssh and scp run")
'use strict';

const fs = require('fs');
const path = require('path');

function defaultIsExecutable(p) {
  const st = fs.statSync(p);
  if (!st.isFile()) return false;
  if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
  return true;
}

function probe(p, isExecutable) {
  try { return !!isExecutable(p); } catch { return false; }
}

function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function createBinaryResolver({ env = process.env, platform = process.platform, isExecutable = defaultIsExecutable, log = console } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? '.exe' : '';
  const cache = new Map();

  function configured(name) {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return null;
    if (!p.isAbsolute(value)) {
      log.warn(`[remote] ${name}=${JSON.stringify(value)} is ignored: it must be an absolute path`);
      return null;
    }
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(value)) {
      log.warn(`[remote] ${name}=${JSON.stringify(value)} is a batch script, which cannot be started without a shell: name an .exe`);
    }
    return value;
  }

  function onPath(name) {
    const dirs = String(envValue(env, 'PATH') || '').split(p.delimiter).filter((d) => d && p.isAbsolute(d));
    for (const dir of dirs) {
      const candidate = p.join(dir, name + exe);
      if (probe(candidate, isExecutable)) return candidate;
    }
    return null;
  }

  function system(name) {
    const candidates = platform === 'win32'
      ? [
          p.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`),
          p.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', `${name}.exe`),
        ]
      : [`/usr/bin/${name}`];
    return candidates.find((c) => probe(c, isExecutable)) || null;
  }

  function memo(key, compute) {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  }

  // A path the search found is re-checked on each call, and searched for again once it is gone.
  function memoSearched(key, fromEnv, search) {
    const hit = cache.get(key);
    if (hit && (!hit.searched || probe(hit.value, isExecutable))) return hit.value;
    const configuredValue = fromEnv();
    const found = configuredValue ? null : search();
    const entry = configuredValue ? { value: configuredValue, searched: false }
      : found ? { value: found, searched: true }
        : { value: key, searched: false };
    cache.set(key, entry);
    return entry.value;
  }

  const sshConfigured = () => memo('ssh-env', () => configured('SWITCHBOARD_SSH_PATH'));
  const scpConfigured = () => memo('scp-env', () => configured('SWITCHBOARD_SCP_PATH'));

  function resolveSshPath() {
    return memoSearched('ssh', sshConfigured, () => onPath('ssh') || system('ssh'));
  }

  function besideSsh() {
    const ssh = sshConfigured();
    if (!ssh) return null;
    const ext = /\.exe$/i.test(ssh) ? p.extname(ssh) : '';
    const sibling = p.join(p.dirname(ssh), `scp${ext}`);
    return probe(sibling, isExecutable) ? sibling : null;
  }

  function resolveScpPath() {
    return memoSearched('scp', scpConfigured, () => besideSsh() || onPath('scp') || system('scp'));
  }

  return { resolveSshPath, resolveScpPath };
}

let processLog = null;
let processResolver = null;

function current() {
  if (!processResolver) processResolver = createBinaryResolver({ log: processLog || console });
  return processResolver;
}

function resolveSshPath() { return current().resolveSshPath(); }
function resolveScpPath() { return current().resolveScpPath(); }
function resetResolvedBinaries() { processResolver = null; }
function setResolverLog(log) { processLog = log; processResolver = null; }

module.exports = { createBinaryResolver, resolveSshPath, resolveScpPath, resetResolvedBinaries, setResolverLog };
