'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const CHUNK_BYTES = 256 * 1024;
const READ_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const API_PREFIX = /^\s*\{\s*"type"\s*:\s*"api-request"\s*[,}]/;

function readRange(filePath, start, length, expectedStat) {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (expectedStat) {
      const actual = fs.fstatSync(fd, { bigint: true });
      if (actual.dev !== expectedStat.dev || actual.ino !== expectedStat.ino || actual.size < BigInt(start + length)) {
        throw new Error('transcript changed during read');
      }
    }
    let off = 0;
    while (off < length) {
      const n = fs.readSync(fd, buf, off, length - off, start + off);
      if (n <= 0) throw new Error('transcript shortened during read');
      off += n;
    }
    return buf;
  } finally { fs.closeSync(fd); }
}

// see .ai/contexts/trigger-watcher.md, "Transcript tail reads"
function createTranscriptTailReader({ tailBytes = CHUNK_BYTES } = {}) {
  const cache = new Map();
  const droppedLine = (offset, length) => {
    const fingerprint = createHash('sha256').update(`${offset}:${length}`).digest('hex');
    const record = JSON.stringify({ type: 'assistant', message: { content: fingerprint } });
    return Buffer.from(record.padEnd(tailBytes, ' '));
  };
  return {
    read(filePath, stat, budget = READ_BYTES) {
      let scan = cache.get(filePath);
      let consumed = 0;
      const sample = (start, length) => {
        consumed += length;
        return readRange(filePath, start, length, stat);
      };
      const sameIdentity = scan && scan.dev === stat.dev && scan.ino === stat.ino;
      const unchanged = sameIdentity && scan.size === stat.size && scan.mtimeMs === stat.mtimeMs;
      const appended = !unchanged && sameIdentity && stat.size > scan.size && scan.mtimeMs <= stat.mtimeMs
        && sample(0, scan.head.length).equals(scan.head)
        && sample(Math.floor(scan.size / 2), scan.middle.length).equals(scan.middle)
        && sample(scan.size - scan.boundary.length, scan.boundary.length).equals(scan.boundary);
      if (!unchanged && !appended) {
        scan = { ...stat, offset: stat.size, end: stat.size, pending: [], pendingBytes: 0, pendingHead: Buffer.alloc(0), dropped: false,
          lines: [], bytes: 0, raw: '', lastLine: true, complete: stat.size === 0,
          trailing: Buffer.alloc(0), trailingStart: stat.size, trailingDropped: false, trailingApi: false,
          head: sample(0, Math.min(64, stat.size)),
          middle: sample(Math.floor(stat.size / 2), Math.min(64, stat.size - Math.floor(stat.size / 2))),
          boundary: sample(Math.max(0, stat.size - 64), Math.min(64, stat.size)) };
      } else if (appended) {
        if (!scan.complete) {
          const length = Math.min(tailBytes, stat.size - scan.size, Math.max(0, Math.floor((budget - consumed - 192) / 2)));
          const newest = sample(stat.size - length, length).toString('utf8');
          scan.raw = length === stat.size - scan.size ? (scan.raw + newest).slice(-tailBytes) : newest;
        }
        scan.size = stat.size;
        scan.mtimeMs = stat.mtimeMs;
        if (scan.head.length < 64) scan.head = sample(0, Math.min(64, stat.size));
        scan.middle = sample(Math.floor(stat.size / 2), Math.min(64, stat.size - Math.floor(stat.size / 2)));
        scan.boundary = sample(Math.max(0, stat.size - 64), Math.min(64, stat.size));
      }
      cache.delete(filePath);
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(filePath, scan);
      const finishLine = (prefix, offset) => {
        const bytes = prefix.length + scan.pendingBytes;
        const head = Buffer.concat([prefix.subarray(0, 128), scan.pendingHead]).toString('utf8', 0, 128);
        const terminated = !scan.lastLine || scan.baseEndsWithNewline;
        scan.lastLine = false;
        const api = API_PREFIX.test(head);
        const line = bytes && !api ? scan.dropped ? droppedLine(offset, bytes) : Buffer.concat([prefix, ...scan.pending]) : null;
        if (!terminated) {
          scan.trailing = line && !scan.dropped ? line : Buffer.alloc(0);
          scan.trailingStart = offset;
          scan.trailingDropped = api || scan.dropped;
          scan.trailingApi = api;
        }
        scan.pending = [];
        scan.pendingBytes = 0;
        scan.pendingHead = Buffer.alloc(0);
        scan.dropped = false;
        if (!line) return;
        scan.lines.unshift({ line, terminated });
        scan.bytes += line.length + 1;
      };
      while (!scan.complete && consumed < budget) {
        const length = Math.min(tailBytes, scan.offset, budget - consumed);
        const chunk = readRange(filePath, scan.offset - length, length, stat);
        if (scan.offset === scan.end) {
          scan.raw = chunk.toString('utf8');
          scan.baseEndsWithNewline = scan.raw.endsWith('\n');
        }
        scan.offset -= length;
        consumed += length;
        let end = chunk.length;
        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] !== 10) continue;
          finishLine(chunk.subarray(i + 1, end), scan.offset + i + 1);
          end = i;
          if (scan.bytes >= tailBytes) { scan.complete = true; break; }
        }
        if (!scan.complete) {
          scan.pendingBytes += end;
          scan.pendingHead = Buffer.concat([chunk.subarray(0, Math.min(end, 128)), scan.pendingHead]).subarray(0, 128);
          if (scan.pendingBytes > MAX_PENDING_BYTES) { scan.pending = []; scan.dropped = true; }
          if (end && !scan.dropped) scan.pending.unshift(chunk.subarray(0, end));
          if (!scan.offset) { finishLine(Buffer.alloc(0), 0); scan.complete = true; }
        }
      }
      if (scan.complete && scan.end < stat.size && scan.lines.at(-1)?.terminated === false) {
        const removed = scan.lines.pop();
        scan.bytes -= removed.line.length + 1;
      }
      while (scan.complete && scan.end < stat.size && consumed < budget) {
        const length = Math.min(tailBytes, stat.size - scan.end, budget - consumed);
        const chunk = readRange(filePath, scan.end, length, stat);
        scan.end += length;
        consumed += length;
        scan.raw = (scan.raw + chunk.toString('utf8')).slice(-tailBytes);
        let start = 0;
        for (let i = 0; i <= chunk.length; i++) {
          if (i < chunk.length && chunk[i] !== 10) continue;
          const part = chunk.subarray(start, i);
          if (!scan.trailingDropped) {
            if (scan.trailing.length + part.length > MAX_PENDING_BYTES) {
              scan.trailing = Buffer.alloc(0);
              scan.trailingDropped = true;
            } else {
              scan.trailing = Buffer.concat([scan.trailing, part]);
              if (API_PREFIX.test(scan.trailing.toString('utf8', 0, 128))) {
                scan.trailing = Buffer.alloc(0);
                scan.trailingDropped = true;
                scan.trailingApi = true;
              }
            }
          }
          if (i < chunk.length) {
            if (!scan.trailingApi) {
              const line = scan.trailingDropped ? droppedLine(scan.trailingStart, scan.end - chunk.length + i - scan.trailingStart) : scan.trailing;
              scan.lines.push({ line, terminated: true });
              scan.bytes += line.length + 1;
            }
            scan.trailing = Buffer.alloc(0);
            scan.trailingStart = scan.end - chunk.length + i + 1;
            scan.trailingDropped = false;
            scan.trailingApi = false;
          }
          start = i + 1;
        }
        while (scan.lines.length > 1 && scan.bytes - scan.lines[0].line.length - 1 >= tailBytes) {
          scan.bytes -= scan.lines.shift().line.length + 1;
        }
      }
      const complete = scan.complete && scan.end === stat.size;
      const trailingText = scan.trailingDropped && !scan.trailingApi ? droppedLine(scan.trailingStart, scan.end - scan.trailingStart).toString('utf8') : scan.trailing.toString('utf8');
      const writtenText = complete ? scan.lines.map(({ line, terminated }) => line.toString('utf8') + (terminated ? '\n' : '')).join('')
        + (scan.lines.at(-1)?.terminated !== false ? trailingText : '') : scan.raw;
      const bytes = Buffer.from(writtenText);
      const text = bytes.subarray(Math.max(0, bytes.length - tailBytes)).toString('utf8');
      return { text, writtenText, complete, endsWithNewline: !stat.size || scan.boundary.at(-1) === 10 };
    },
    forget(filePath) { cache.delete(filePath); },
  };
}

module.exports = { createTranscriptTailReader, readRange };
