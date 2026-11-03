'use strict';

const fs = require('fs');
const { continuationStamp, matchesContinuationStamp } = require('../../../session-continuations');

function isCountedMessage(entry) {
  return entry?.type === 'user' || entry?.type === 'assistant'
    || (entry?.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'));
}

function messageCountIndex(buffer, stat, count, tailCount, filtered = false) {
  return JSON.stringify({ version: 1, stamp: continuationStamp(stat), count,
    filtered,
    sealedCount: count - tailCount, bytes: buffer.lastIndexOf(10) + 1,
    head: buffer.subarray(0, 64).toString('hex'),
    tail: buffer.subarray(Math.max(0, buffer.length - 64)).toString('hex') });
}

// see .ai/contexts/session-cache.md ("Incremental message counts")
function readMessageCount(file, previous, stat, filtered = false, allowReplacement = false) {
  let fd;
  try {
    let index;
    try { index = JSON.parse(previous); } catch {}
    if (index?.version === 1 && matchesContinuationStamp(index.stamp, stat)) {
      return { messageCount: index.count, messageCountIndex: previous };
    }
    fd = fs.openSync(file, 'r');
    const size = Number(stat.size);
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      const n = fs.readSync(fd, buffer, 0, length, position);
      if (n !== length) throw new Error('transcript changed during count');
      return buffer;
    };
    const head = read(0, Math.min(size, 64));
    const oldSize = Number(index?.stamp?.size);
    const reusable = index?.version === 1 && oldSize < size
      && (allowReplacement || ['dev', 'ino', 'birthtimeNs'].every(key => index.stamp[key] === stat[key].toString()))
      && head.toString('hex').startsWith(index.head)
      && read(Math.max(0, oldSize - 64), Math.min(oldSize, 64)).toString('hex') === index.tail;
    if ((filtered || index?.filtered) && (!reusable || index.bytes !== oldSize)) return { needsFullRead: true };
    let position = reusable ? index.bytes : 0;
    let sealedCount = reusable ? index.sealedCount : 0;
    let bytes = position;
    let pending = [];
    const countLine = buffer => {
      try { return isCountedMessage(JSON.parse(buffer.toString('utf8'))) ? 1 : 0; }
      catch { return 0; }
    };
    while (position < size) {
      const chunk = read(position, Math.min(64 * 1024, size - position));
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, end));
        sealedCount += countLine(Buffer.concat(pending));
        pending = [];
        start = end + 1;
        bytes = position + start;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
      position += chunk.length;
    }
    const count = sealedCount + countLine(Buffer.concat(pending));
    const tail = read(Math.max(0, size - 64), Math.min(size, 64));
    if (!matchesContinuationStamp(continuationStamp(stat), fs.statSync(file, { bigint: true }))) return null;
    return { messageCount: count, messageCountIndex: JSON.stringify({ version: 1,
      stamp: continuationStamp(stat), count, sealedCount, bytes, filtered: index?.filtered || filtered,
      head: head.toString('hex'), tail: tail.toString('hex') }) };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { isCountedMessage, messageCountIndex, readMessageCount };
