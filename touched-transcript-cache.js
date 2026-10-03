'use strict';

const fs = require('fs');

const TOUCHED_CACHE_SESSIONS = 32;
const MAX_CACHED_TRANSCRIPTS = 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const VALIDATION_BYTES = 256;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_TOUCHES = 1000;
const MAX_SESSION_TOUCHES = 4000;
const MAX_CACHED_PATH_CHARS = 4097;

function createTouchedFilesCache({ maxSessions = TOUCHED_CACHE_SESSIONS, onRead = () => {}, onParse = () => {} } = {}) {
  const sessions = new Map();
  let queue = Promise.resolve();

  function dropSession(id) {
    for (const [key, value] of sessions) if (value.id === id) sessions.delete(key);
  }

  async function run(id, folder, work) {
    const result = queue.then(async () => {
      const key = folder + '\0' + id;
      const session = sessions.get(key) || { id, files: new Map() };
      sessions.delete(key);
      sessions.set(key, session);
      while (sessions.size > Math.max(1, maxSessions)) sessions.delete(sessions.keys().next().value);
      return work(session);
    });
    queue = result.catch(() => {});
    return result;
  }

  async function load(session, entry, windowStart, budget, parse, cwdOf) {
    const filePath = entry.filePath;
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch { session.files.delete(filePath); return null; }
    let cached = session.files.get(filePath);
    if (stat.mtimeMs < windowStart && !cached) return { rows: [], cwd: null, hasOlder: stat.size > 0, windowStart, malformed: 0, skipped: 0, omitted: 0 };
    let sessionTouches = [...session.files.values()].reduce((n, file) => n + file.rows.size, 0);
    let handle;
    async function read(start, length) {
      const size = Math.min(length, budget.remaining);
      if (size <= 0) { budget.truncated = true; return Buffer.alloc(0); }
      if (!handle) handle = await fs.promises.open(filePath, 'r');
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, start);
      budget.remaining -= bytesRead;
      onRead(filePath, start, bytesRead);
      return buf.subarray(0, bytesRead);
    }
    function add(line) {
      onParse(filePath);
      const result = parse(line);
      if (result.malformed) cached.malformed++;
      if (result.oversized) cached.skipped++;
      for (const touch of result.touches) {
        const raw = touch.path.slice(0, MAX_CACHED_PATH_CHARS);
        const key = raw + '\0' + touch.tool;
        let row = cached.rows.get(key);
        if (!row) {
          if (cached.rows.size >= MAX_CACHED_TOUCHES || sessionTouches >= MAX_SESSION_TOUCHES) { cached.omitted++; continue; }
          row = { ...touch, path: raw, count: 0, lastTouched: null };
          cached.rows.set(key, row);
          sessionTouches++;
        }
        row.count++;
        if (touch.timestamp != null) row.lastTouched = Math.max(row.lastTouched ?? -Infinity, touch.timestamp);
      }
    }
    async function backwards(end, lower, stopAtWindow) {
      let cursor = end;
      let pending = Buffer.alloc(0);
      let lineEnd = end;
      let skipping = false;
      while (cursor > lower) {
        if (budget.remaining <= 0) { budget.truncated = true; return lineEnd; }
        const start = Math.max(lower, cursor - Math.min(READ_CHUNK_BYTES, budget.remaining));
        const chunk = await read(start, cursor - start);
        if (chunk.length !== cursor - start) { budget.truncated = true; return lineEnd; }
        cursor = start;
        pending = Buffer.concat([chunk, pending]);
        let nl = pending.lastIndexOf(10);
        while (nl !== -1) {
          const lineStart = cursor + nl + 1;
          const buf = pending.subarray(nl + 1);
          if (!skipping && buf.length) {
            const line = buf.toString('utf8');
            const timestamp = timestampOf(line);
            if (stopAtWindow && timestamp != null && timestamp < windowStart) return lineEnd;
            add(line);
          }
          skipping = false;
          lineEnd = lineStart;
          pending = pending.subarray(0, nl);
          nl = pending.lastIndexOf(10);
        }
        if (pending.length > MAX_LINE_BYTES) { pending = Buffer.alloc(0); skipping = true; cached.skipped++; }
      }
      if (!skipping && pending.length) {
        const line = pending.toString('utf8');
        const timestamp = timestampOf(line);
        if (stopAtWindow && timestamp != null && timestamp < windowStart) return lineEnd;
        add(line);
      }
      return lower;
    }
    async function completeEnd(size, lower) {
      let cursor = size;
      while (cursor > lower) {
        const start = Math.max(lower, cursor - READ_CHUNK_BYTES);
        const chunk = await read(start, cursor - start);
        if (chunk.length !== cursor - start) { budget.truncated = true; return lower; }
        const nl = chunk.lastIndexOf(10);
        if (nl !== -1) return start + nl + 1;
        cursor = start;
      }
      return lower;
    }
    try {
      if (cached && (cached.size !== stat.size || cached.mtime !== stat.mtimeMs)) {
        let valid = stat.size > cached.size;
        if (valid) {
          const prefix = await read(0, cached.prefix.length);
          valid = prefix.equals(cached.prefix);
          if (valid && cached.anchor.length) valid = (await read(cached.anchorStart, cached.anchor.length)).equals(cached.anchor);
        }
        if (!valid) { sessionTouches -= cached.rows.size; session.files.delete(filePath); cached = null; }
      }
      if (!cached) {
        cached = { rows: new Map(), size: 0, mtime: null, start: stat.size, end: 0, windowStart: Infinity, malformed: 0, skipped: 0, omitted: 0, cwd: null };
        if (session.files.size >= MAX_CACHED_TRANSCRIPTS) { budget.truncated = true; return null; }
        session.files.set(filePath, cached);
        cached.prefix = await read(0, Math.min(stat.size, VALIDATION_BYTES));
        try { cached.cwd = cwdOf(entry); } catch {}
        cached.end = await completeEnd(stat.size, 0);
        cached.start = await backwards(cached.end, 0, true);
        cached.windowStart = windowStart;
      } else {
        if (stat.size > cached.size) {
          const end = await completeEnd(stat.size, cached.end);
          await backwards(end, cached.end, false);
          cached.end = end;
        }
        if (windowStart < cached.windowStart && cached.start > 0) {
          cached.start = await backwards(cached.start, 0, true);
          cached.windowStart = windowStart;
        }
      }
      if (cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
        cached.anchorStart = Math.max(0, cached.end - VALIDATION_BYTES);
        cached.anchor = await read(cached.anchorStart, cached.end - cached.anchorStart);
      }
      cached.size = stat.size;
      cached.mtime = stat.mtimeMs;
      if (budget.truncated) session.files.delete(filePath);
      return { rows: [...cached.rows.values()], cwd: cached.cwd, hasOlder: cached.start > 0, windowStart: cached.start > 0 ? cached.windowStart : -Infinity, malformed: cached.malformed, skipped: cached.skipped, omitted: cached.omitted };
    } catch {
      session.files.delete(filePath);
      return null;
    } finally {
      if (handle) await handle.close();
    }
  }

  return { run, load, dropSession };
}

function timestampOf(line) {
  if (!line.includes('"timestamp"') || line.length > MAX_LINE_BYTES) return null;
  try {
    const entry = JSON.parse(line);
    const value = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

module.exports = { createTouchedFilesCache, timestampOf };
