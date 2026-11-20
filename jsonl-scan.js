'use strict';

const fs = require('node:fs');

const CHUNK_BYTES = 256 * 1024;

// see .ai/contexts/cli-harnesses.md ("Streaming transcript scan")
function scanLines(filePath, startByte, onLine, endByte) {
  const ownsFd = typeof filePath !== 'number';
  const fd = ownsFd ? fs.openSync(filePath, 'r') : filePath;
  let consumed = startByte;
  let read = 0;
  try {
    if (endByte === undefined) endByte = fs.fstatSync(fd).size;
    let pending = [];
    let pendingBytes = 0;
    let pos = startByte;
    while (pos < endByte) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, endByte - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      require('./src/main/session-index/read-counters').countBytes(n);
      if (n === 0) throw new Error('JSONL file truncated during scan');
      read += n;
      let from = 0;
      let nl;
      const data = buf.subarray(0, n);
      while ((nl = data.indexOf(0x0A, from)) !== -1) {
        const piece = data.subarray(from, nl);
        const line = pendingBytes
          ? Buffer.concat([...pending, piece], pendingBytes + piece.length).toString('utf8')
          : piece.toString('utf8');
        pending = [];
        pendingBytes = 0;
        consumed = pos + nl + 1;
        if (line && onLine(line) === false) return { consumed, read, tail: '', stopped: true };
        from = nl + 1;
      }
      if (from < n) {
        pending.push(data.subarray(from));
        pendingBytes += n - from;
      }
      pos += n;
    }
    const tail = pendingBytes ? Buffer.concat(pending, pendingBytes).toString('utf8') : '';
    return { consumed, read, tail, stopped: false };
  } finally {
    if (ownsFd) fs.closeSync(fd);
  }
}

function readHead(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

module.exports = { scanLines, readHead, CHUNK_BYTES };
