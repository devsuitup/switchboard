'use strict';

function parseStat(text) {
  const end = text.lastIndexOf(')');
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19])) return null;
  return { startTime: fields[19], parentPid: Number(fields[1]) };
}

function matchesArgv(text, binary, profile, port) {
  if (text.length > 65536 || (text.match(/--user-data-dir(?:=| )/g) || []).length !== 1 ||
      (text.match(/--remote-debugging-port(?:=| )/g) || []).length !== 1) return false;
  const args = text.split('\0').filter(Boolean);
  if (args.length > 256) return false;
  if (args.length > 1) return args[0] === binary && args.includes(`--user-data-dir=${profile}`) && args.includes(`--remote-debugging-port=${port}`);
  const joined = args[0] || '';
  const contains = value => joined.includes(` ${value} `) || joined.endsWith(` ${value}`);
  return joined.startsWith(`${binary} `) && contains(`--user-data-dir=${profile}`) && contains(`--remote-debugging-port=${port}`);
}

function createProc({ fs = require('node:fs'), pid = process.pid, kill = process.kill.bind(process) } = {}) {
  const read = file => fs.readFileSync(file, 'utf8');
  function identity(n) {
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    try {
      const stat = parseStat(read(`/proc/${n}/stat`));
      return stat ? { pid: n, ...stat, boot: read('/proc/sys/kernel/random/boot_id').trim() } : null;
    } catch { return null; }
  }
  function alive(state) {
    const actual = identity(state?.pid);
    return !!actual && actual.startTime === state.startTime && actual.boot === state.boot;
  }
  function verify(state) {
    if (!alive(state)) return false;
    try {
      return fs.realpathSync(`/proc/${state.pid}/exe`) === state.binary && matchesArgv(read(`/proc/${state.pid}/cmdline`), state.binary, state.profile, state.port);
    } catch { return false; }
  }
  function listeners(port) {
    const found = [];
    for (const table of ['tcp', 'tcp6']) {
      for (const line of read(`/proc/net/${table}`).trim().split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== '0A') continue;
        const [address, hex] = fields[1].split(':');
        if (Number.parseInt(hex, 16) === port) found.push({ address, inode: fields[9], table });
      }
    }
    return found;
  }
  function listener(state) {
    try {
      const rows = listeners(state.port);
      if (!rows.length) return 'missing';
      if (!verify(state) || rows.some(row => row.table !== 'tcp' || row.address !== '0100007F')) return 'foreign';
      const inodes = new Set(fs.readdirSync(`/proc/${state.pid}/fd`).flatMap(fd => {
        try { return [fs.readlinkSync(`/proc/${state.pid}/fd/${fd}`)]; } catch { return []; }
      }));
      return rows.every(row => inodes.has(`socket:[${row.inode}]`)) ? 'owned' : 'foreign';
    } catch { return 'foreign'; }
  }
  function findBrowser(state) {
    try {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const found = { ...state, ...identity(Number(name)) };
        if (verify(found)) return found.pid;
      }
    } catch {}
    return null;
  }
  function descendants(state) {
    const found = [], parents = new Set([state.pid]);
    let entries;
    try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => identity(Number(name))).filter(Boolean); } catch { return found; }
    for (let pass = 0; pass < entries.length; pass++) {
      let added = false;
      for (const entry of entries) {
        if (parents.has(entry.pid) || !parents.has(entry.parentPid) || entry.boot !== state.boot) continue;
        parents.add(entry.pid); found.push(entry); added = true;
      }
      if (!added) break;
    }
    return found;
  }
  return { self: () => identity(pid), identity, alive, verify, listener, findBrowser, listenerPid: findBrowser, descendants, signal: kill };
}

module.exports = { parseStat, matchesArgv, createProc };
