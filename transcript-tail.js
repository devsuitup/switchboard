'use strict';

const fs = require('node:fs');
const CHUNK_BYTES = 256 * 1024;
const READ_BYTES = 1024 * 1024;
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
  return {
    read(filePath, stat, budget = READ_BYTES) {
      let scan = cache.get(filePath);
      if (!scan || scan.size !== stat.size || scan.mtimeMs !== stat.mtimeMs || scan.dev !== stat.dev || scan.ino !== stat.ino) {
        scan = { ...stat, offset: stat.size, pending: [], pendingBytes: 0,
          lines: [], bytes: 0, raw: '', lastLine: true, complete: stat.size === 0 };
        if (!cache.has(filePath) && cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(filePath, scan);
      }
      const finishLine = prefix => {
        const bytes = prefix.length + scan.pendingBytes;
        const head = Buffer.concat([prefix, ...scan.pending.slice(0, 2)].map(part => part.subarray(0, 128))).toString('utf8', 0, 128);
        const terminated = !scan.lastLine || scan.raw.endsWith('\n');
        scan.lastLine = false;
        const line = bytes && !API_PREFIX.test(head) ? Buffer.concat([prefix, ...scan.pending]) : null;
        scan.pending = [];
        scan.pendingBytes = 0;
        if (!line) return;
        scan.lines.unshift({ line, terminated });
        scan.bytes += bytes + 1;
      };
      let consumed = 0;
      while (!scan.complete && consumed < budget) {
        const length = Math.min(tailBytes, scan.offset, budget - consumed);
        const chunk = readRange(filePath, scan.offset - length, length, stat);
        if (scan.offset === stat.size) scan.raw = chunk.toString('utf8');
        scan.offset -= length;
        consumed += length;
        let end = chunk.length;
        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] !== 10) continue;
          finishLine(chunk.subarray(i + 1, end));
          end = i;
          if (scan.bytes >= tailBytes) { scan.complete = true; break; }
        }
        if (!scan.complete) {
          scan.pendingBytes += end;
          if (end) scan.pending.unshift(chunk.subarray(0, end));
          if (!scan.offset) { finishLine(Buffer.alloc(0)); scan.complete = true; }
        }
      }
      const writtenText = scan.complete ? scan.lines.map(({ line }) => line.toString('utf8')).join('\n')
        + (scan.lines.at(-1)?.terminated ? '\n' : '') : scan.raw;
      const bytes = Buffer.from(writtenText);
      const text = bytes.subarray(Math.max(0, bytes.length - tailBytes)).toString('utf8');
      return { text, writtenText, complete: scan.complete, endsWithNewline: !stat.size || scan.raw.endsWith('\n') };
    },
    forget(filePath) { cache.delete(filePath); },
  };
}

module.exports = { createTranscriptTailReader, readRange };
