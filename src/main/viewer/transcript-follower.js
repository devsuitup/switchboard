// see .ai/contexts/session-state.md
'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setImmediate: yieldToLoop } = require('node:timers/promises');
const { readRange, API_PREFIX } = require('../../../transcript-tail');

const READ_LIMIT = 8 * 1024 * 1024;
const REPLY_LIMIT = 1024 * 1024;
const LINE_LIMIT = 4 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const TYPES = new Set(['user', 'assistant', 'message', 'system', 'progress', 'custom-title']);
const visible = entry => entry && (TYPES.has(entry.type) || entry._localCmd);
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

function ranges(offset) {
  return [0, Math.floor(offset / 2), Math.max(0, offset - 64)]
    .map(start => ({ start, length: Math.min(64, offset - start) })).filter(range => range.length > 0);
}

function cursor(stat, offset, samples) {
  return { identity: identity(stat), offset, samples, size: Number(stat.size), mtime: String(stat.mtimeNs),
    pending: [], bytes: 0, head: Buffer.alloc(0), api: false, dropped: false, finalSize: null };
}

function createTranscriptFollower() {
  let current = null;
  let parked = null;

  function dispose() {
    if (current) current.closed = true;
    current = null;
    parked = null;
  }

  function open(id, file, checkpoint) {
    if (checkpoint) {
      const saved = parked;
      dispose();
      const matches = saved && saved.id === id && saved.token === checkpoint;
      if (!matches) return { ...open(id, file), reset: true };
      current = { id, file: saved.file, token: randomUUID(), closed: false, busy: false,
        cursor: { ...saved.cursor, finalSize: null } };
      return read(id, current.token, file, false, true);
    }
    dispose();
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = fs.readFileSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      const entries = [];
      const lines = buffer.toString('utf8').split('\n');
      let offset = buffer.length;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const entry = JSON.parse(lines[i]);
          if (visible(entry)) entries.push(entry);
        } catch {
          if (i === lines.length - 1) offset = buffer.lastIndexOf(10) + 1;
        }
      }
      const samples = ranges(offset).map(range => ({ start: range.start,
        data: Buffer.from(buffer.subarray(range.start, range.start + range.length)) }));
      current = { id, file, token: randomUUID(), closed: false, busy: false, cursor: cursor(stat, offset, samples) };
      return { entries, token: current.token, more: offset < Number(stat.size) };
    } finally { fs.closeSync(fd); }
  }

  function close(id, token, park = false) {
    if (parked && parked.id === id && parked.token === token && !park) {
      parked = null;
      return { ok: true };
    }
    if (!current || current.id !== id || current.token !== token) return { ok: false };
    const saved = park && !current.busy ? current : null;
    dispose();
    parked = saved;
    return { ok: true };
  }

  async function read(id, token, file, final = false, fullReset = false) {
    const record = current;
    if (!record || record.id !== id || record.token !== token || record.closed) return { error: 'Transcript follower expired or closed' };
    if (record.busy) return { error: 'A transcript read is already in progress' };
    record.busy = true;
    try {
      const stat = fs.statSync(file, { bigint: true });
      const original = record.cursor;
      let work = { ...original, pending: original.pending.slice() };
      let reset = record.file !== file || work.identity !== identity(stat) || Number(stat.size) < work.offset;
      let sampled = 0;
      if (!reset && work.offset === Number(stat.size) && work.size === Number(stat.size) && work.mtime === String(stat.mtimeNs)
        && !(final && (work.bytes || work.dropped))) {
        return { entries: [], append: true, token, reset: false, more: false, skipped: 0 };
      }
      if (!reset) {
        for (const sample of work.samples) {
          sampled += sample.data.length;
          if (!readRange(file, sample.start, sample.data.length, stat).equals(sample.data)) { reset = true; break; }
        }
      }
      if (reset && fullReset) return { ...open(id, file), reset: true };
      if (reset) work = cursor(stat, 0, []);
      if (final && work.finalSize === null) work.finalSize = Number(stat.size);
      const target = Math.min(Number(stat.size), work.finalSize ?? Number(stat.size));
      let budget = READ_LIMIT - sampled - 192;
      let replyBytes = 0, skipped = 0;
      const entries = [];
      while (work.offset < target && budget > 0 && replyBytes < REPLY_LIMIT) {
        if (record.closed) return { error: 'Transcript follower closed' };
        const length = Math.min(CHUNK_BYTES, target - work.offset, budget);
        const chunk = readRange(file, work.offset, length, stat);
        budget -= chunk.length;
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          if (work.head.length < 256) work.head = Buffer.concat([work.head, part.subarray(0, 256 - work.head.length)]);
          if (!work.api && !work.dropped) {
            if (API_PREFIX.test(work.head.toString('utf8'))) { work.api = true; work.pending = []; work.bytes = 0; }
            else if (work.bytes + part.length > LINE_LIMIT) { work.dropped = true; work.pending = []; work.bytes = 0; }
            else { work.pending.push(Buffer.from(part)); work.bytes += part.length; }
          }
          work.offset += part.length + (newline < 0 ? 0 : 1);
          if (newline >= 0) {
            if (work.dropped) skipped++;
            else if (!work.api && work.bytes) {
              try {
                const entry = JSON.parse(Buffer.concat(work.pending, work.bytes).toString('utf8'));
                if (visible(entry)) { entries.push(entry); replyBytes += work.bytes; }
              } catch {}
            }
            work.pending = []; work.bytes = 0; work.head = Buffer.alloc(0); work.api = false; work.dropped = false;
          }
          start = end + 1;
          if (replyBytes >= REPLY_LIMIT) break;
        }
        await yieldToLoop();
      }
      if (record.closed) return { error: 'Transcript follower closed' };
      if (final && work.offset >= target) {
        if (work.dropped) { skipped++; work.dropped = false; }
        else if (!work.api && work.bytes) {
          try {
            const entry = JSON.parse(Buffer.concat(work.pending, work.bytes).toString('utf8'));
            if (visible(entry)) entries.push(entry);
            work.pending = []; work.bytes = 0; work.head = Buffer.alloc(0);
          } catch {}
        }
      }
      work.samples = ranges(work.offset).map(range => ({ start: range.start, data: readRange(file, range.start, range.length, stat) }));
      work.size = Number(stat.size); work.mtime = String(stat.mtimeNs);
      record.file = file; record.cursor = work;
      return { entries, append: true, token, reset, more: work.offset < target, skipped };
    } catch (error) { return { error: error.message }; }
    finally { record.busy = false; }
  }

  return { open, read, close, dispose };
}

module.exports = { createTranscriptFollower };
