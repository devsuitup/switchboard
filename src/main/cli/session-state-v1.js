'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createV1Reader({ dir, parseDescriptor, parseState, platform, now, procFs = fs, descriptorFs = fs,
  readProcStartMany, readParentPid, readCliProcess, scheduledRuns, procStartMatches, isProcessAlive }) {
  const expired = deadline => now() >= deadline;
  const unknown = reason => ({ known: false, reason });
  function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
  function rawScan(deadline) {
    const candidates = [];
    let complete = true;
    let names;
    try { names = descriptorFs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)).sort(); }
    catch (error) { return { candidates, complete: error.code === 'ENOENT' && !expired(deadline) }; }
    if (names.length > 1000) complete = false;
    for (const name of names.slice(0, 1000)) {
      if (expired(deadline)) { complete = false; break; }
      const file = path.join(dir, name);
      try {
        const stat = descriptorFs.lstatSync(file);
        if (!stat.isFile() || stat.size > 65536) { complete = false; continue; }
        if (expired(deadline)) { complete = false; break; }
        const text = descriptorFs.readFileSync(file, 'utf8');
        const descriptor = parseDescriptor(text);
        if (!descriptor) { complete = false; continue; }
        const raw = JSON.parse(text);
        candidates.push({ file, text, stamp: stamp(stat), raw, descriptor, state: parseState(text) });
      } catch { complete = false; }
    }
    return { candidates, complete: complete && !expired(deadline) };
  }
  function sameFile(candidate, deadline) {
    try {
      return !expired(deadline) && stamp(descriptorFs.lstatSync(candidate.file)) === candidate.stamp
        && !expired(deadline) && descriptorFs.readFileSync(candidate.file, 'utf8') === candidate.text;
    } catch { return false; }
  }
  function proc(pid, deadline) {
    if (expired(deadline)) throw new Error('deadline');
    const status = procFs.readFileSync(`/proc/${pid}/status`, 'utf8');
    if (expired(deadline)) throw new Error('deadline');
    const stat = procFs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (expired(deadline)) throw new Error('deadline');
    let namespace;
    try { namespace = procFs.readlinkSync(`/proc/${pid}/ns/pid`); }
    catch (error) { if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error; namespace = null; }
    const match = /^NSpid:\s*(\d+(?:\s+\d+)*)\s*$/m.exec(status);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const pids = match?.[1].trim().split(/\s+/).map(Number);
    if (namespace === '' || !pids?.length || pids[0] !== pid || !/^\d+$/.test(fields[19])
      || !Number.isInteger(Number(fields[1]))) throw new Error('incomplete proc identity');
    return { pid, parent: Number(fields[1]), start: fields[19], namespace, inner: pids.at(-1), live: !['Z', 'X', 'x'].includes(fields[0]) };
  }
  function procScan(deadline) {
    const table = new Map();
    let complete = true;
    let names;
    if (expired(deadline)) return { table, complete: false };
    try { names = procFs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); }
    catch { return { table, complete: false }; }
    if (names.length > 32768) complete = false;
    for (const name of names.slice(0, 32768)) {
      if (expired(deadline)) { complete = false; break; }
      try { table.set(Number(name), proc(Number(name), deadline)); }
      catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') complete = false; }
    }
    return { table, complete: complete && !expired(deadline) };
  }
  function mapped(candidate, scan) {
    if (!scan.complete || !/^\d+$/.test(String(candidate.raw.procStart))) return null;
    const matches = [...scan.table.values()].filter(p => p.live && p.inner === candidate.raw.pid && p.start === String(candidate.raw.procStart));
    return matches.length === 1 && matches[0].namespace !== null ? matches[0] : null;
  }
  function unreadableMatch(candidate, scan) {
    return [...scan.table.values()].some(p => p.live && p.namespace === null && p.inner === candidate.raw.pid
      && p.start === String(candidate.raw.procStart));
  }
  function unchangedProc(identity, deadline) {
    try { return JSON.stringify(proc(identity.pid, deadline)) === JSON.stringify(identity); }
    catch { return false; }
  }
  function ancestry(writer, ptyPid, table, candidates, deadline, nearest) {
    const chain = [];
    const seen = new Set();
    let p = writer;
    while (p && chain.length < 64 && !seen.has(p.pid) && !expired(deadline)) {
      seen.add(p.pid); chain.push(p);
      if (p.pid === ptyPid) return chain;
      if (p.pid <= 1) return null;
      const parent = table.get(p.parent);
      if (!parent || !parent.live || BigInt(parent.start) > BigInt(p.start)) return null;
      if (nearest && parent.pid !== ptyPid) {
        const descriptors = candidates.filter(c => c.raw.pid === parent.inner && String(c.raw.procStart) === parent.start);
        if (descriptors.length || readCliProcess(parent.pid) !== false) return null;
      }
      p = parent;
    }
    return null;
  }
  function liveInfo(candidate, writer) {
    return { ...candidate.descriptor, ...candidate.state, pid: writer.pid, rawPid: candidate.raw.pid,
      procStart: writer.start, namespace: writer.namespace };
  }
  async function probe(pids, deadline) {
    if (expired(deadline)) throw new Error('descriptor deadline');
    let timer;
    try {
      const read = readProcStartMany(pids, deadline);
      if (!Number.isFinite(deadline)) return await read;
      return await Promise.race([read, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('descriptor deadline')), Math.max(0, deadline - now()));
      })]);
    } finally { clearTimeout(timer); }
  }
  async function liveElsewhereV1Checked(sessionId, _hasPty, ptyPids = () => [], { deadline = Infinity, requireUnique = false, processTable } = {}) {
    const key = String(sessionId).toLowerCase();
    const scheduled = scheduledRuns.get(key);
    if (scheduled) return { known: true, live: scheduled };
    if (expired(deadline)) return unknown('descriptor deadline');
    const scan = rawScan(deadline);
    const matches = scan.candidates.filter(c => c.descriptor.sessionId.toLowerCase() === key);
    const lives = [];
    let unresolved = !scan.complete;
    const table = platform === 'linux' && matches.length ? procScan(deadline) : null;
    for (const candidate of matches) {
      if (expired(deadline)) return unknown('descriptor deadline');
      let writer;
      let owned = false;
      if (platform === 'linux') {
        writer = mapped(candidate, table);
        if (writer) {
          const again = mapped(candidate, procScan(deadline));
          if (!again || JSON.stringify(writer) !== JSON.stringify(again)) writer = null;
          else for (const pid of ptyPids(key)) {
            const chain = ancestry(writer, pid, table.table, scan.candidates, deadline, false);
            if (chain && chain.every(p => unchangedProc(p, deadline))) owned = true;
          }
        }
      } else if (platform === 'win32') {
        try {
          const firstAlive = isProcessAlive(candidate.raw.pid);
          if (expired(deadline)) return unknown('descriptor deadline');
          const secondAlive = isProcessAlive(candidate.raw.pid);
          if (firstAlive === false && secondAlive === false) {
            if (sameFile(candidate, deadline)) continue;
            unresolved = true; continue;
          }
          if (candidate.raw.pidDomain !== 'win32:anchor' || !/^\d{15,}$/.test(String(candidate.raw.procStart))) {
            unresolved = true; continue;
          }
          const cached = processTable !== undefined;
          if (cached && (!processTable.map || now() >= processTable.expiresAt)) { unresolved = true; continue; }
          const first = cached ? processTable.map.get(candidate.raw.pid)?.created : (await probe([candidate.raw.pid], deadline))?.get(candidate.raw.pid);
          if (expired(deadline)) return unknown('descriptor deadline');
          const second = cached ? first : (await probe([candidate.raw.pid], deadline))?.get(candidate.raw.pid);
          if (first != null && second != null && !procStartMatches(first, candidate.raw.procStart)
            && !procStartMatches(second, candidate.raw.procStart)) {
            if (!cached && sameFile(candidate, deadline)) continue;
            unresolved = true; continue;
          }
          if (first != null && second != null && procStartMatches(first, candidate.raw.procStart)
            && procStartMatches(second, candidate.raw.procStart)) {
            writer = { pid: candidate.raw.pid, start: String(candidate.raw.procStart), namespace: null };
            for (const anchor of ptyPids(key)) {
              let current = writer.pid;
              const seen = new Set();
              while (current > 1 && seen.size < 64 && !seen.has(current) && !expired(deadline)) {
                if (current === anchor) { owned = true; break; }
                seen.add(current); current = cached ? processTable.map.get(current)?.ppid : readParentPid(current);
              }
            }
          }
        } catch {}
      }
      if (!writer || !sameFile(candidate, deadline)) { unresolved = true; continue; }
      if (!owned || candidate.descriptor.kind === 'bg') {
        if (!requireUnique) return { known: true, live: liveInfo(candidate, writer) };
        lives.push(liveInfo(candidate, writer));
      }
    }
    if (requireUnique && lives.length > 1) return { ...unknown('ambiguous writers'), ambiguous: true };
    if (requireUnique && lives.length === 1 && !unresolved && !expired(deadline)) return { known: true, live: lives[0] };
    return unresolved || expired(deadline) ? unknown('descriptor identity unavailable') : { known: true, live: null };
  }
  function observeTabWriterV1({ session, pty, generation, ptyStart, deadline = Infinity }) {
    const unavailable = { supported: platform === 'linux', uncertain: true };
    if (platform !== 'linux' || session?.pty !== pty || session.generation !== generation || session.exited
      || !ptyStart || expired(deadline)) return unavailable;
    const scan = rawScan(deadline);
    const table = procScan(deadline);
    const anchor = table.table.get(pty.pid);
    if (!scan.complete || !table.complete || !anchor || !anchor.live || anchor.namespace === null || anchor.start !== String(ptyStart)) return unavailable;
    const eligible = [];
    for (const candidate of scan.candidates) {
      if (unreadableMatch(candidate, table)) return unavailable;
      const writer = mapped(candidate, table);
      if (!writer || writer.namespace === anchor.namespace) continue;
      let chain;
      try { chain = ancestry(writer, pty.pid, table.table, scan.candidates, deadline, true); }
      catch { return unavailable; }
      if (!chain || chain.length < 2) continue;
      eligible.push({ candidate, writer, chain });
    }
    if (eligible.length !== 1) return unavailable;
    const { candidate, writer, chain } = eligible[0];
    if (candidate.descriptor.kind !== 'interactive' || !candidate.state) return unavailable;
    const again = mapped(candidate, procScan(deadline));
    if (!again || JSON.stringify(again) !== JSON.stringify(writer) || !sameFile(candidate, deadline)
      || !chain.every(p => unchangedProc(p, deadline)) || session.pty !== pty || session.generation !== generation
      || expired(deadline)) return unavailable;
    const normalized = { ...candidate.raw, ...candidate.state, pid: writer.pid, rawPid: candidate.raw.pid,
      procStart: writer.start, namespace: writer.namespace };
    return { supported: true, uncertain: false, writer: normalized,
      identity: [generation, anchor.pid, anchor.start, writer.namespace, writer.pid, writer.start, candidate.raw.pid].join(':') };
  }
  return { liveElsewhereV1Checked, observeTabWriterV1 };
}

module.exports = { createV1Reader };
