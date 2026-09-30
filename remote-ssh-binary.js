// The ssh and scp binaries every remote operation runs — see docs/remote-hosts.md ("Which ssh and scp run")
'use strict';

const fs = require('fs');
const path = require('path');

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function candidates(name, { env, platform }) {
  if (platform !== 'win32') return [`/usr/bin/${name}`];
  const p = path.win32;
  return [
    p.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`),
    p.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', `${name}.exe`),
  ];
}

function firstExisting(paths, existsSync) {
  for (const c of paths) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return null;
}

function resolveSshPath({ env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  if (env.SWITCHBOARD_SSH_PATH) return env.SWITCHBOARD_SSH_PATH;
  return firstExisting(candidates('ssh', { env, platform }), existsSync) || 'ssh';
}

function resolveScpPath({ env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  if (env.SWITCHBOARD_SCP_PATH) return env.SWITCHBOARD_SCP_PATH;
  const sshPath = env.SWITCHBOARD_SSH_PATH;
  const p = pathFor(platform);
  if (sshPath && p.isAbsolute(sshPath)) {
    const ext = /\.exe$/i.test(sshPath) ? p.extname(sshPath) : '';
    const sibling = firstExisting([p.join(p.dirname(sshPath), `scp${ext}`)], existsSync);
    if (sibling) return sibling;
  }
  return firstExisting(candidates('scp', { env, platform }), existsSync) || 'scp';
}

module.exports = { resolveSshPath, resolveScpPath };
