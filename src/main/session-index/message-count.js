'use strict';

const fs = require('fs');
const { continuationStamp, matchesContinuationStamp } = require('../../../session-continuations');

function isCountedMessage(entry) {
  return entry?.type === 'user' || entry?.type === 'assistant'
    || (entry?.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'));
}

function laterConversation(current, entry) {
  return isCountedMessage(entry) && typeof entry.timestamp === 'string' && (!current || entry.timestamp > current) ? entry.timestamp : current;
}

function lastConversationAt(row) {
  let index;
  try { index = JSON.parse(row?.messageCountIndex); } catch {}
  return typeof index?.conversationAt === 'string' ? index.conversationAt : row?.modified || '';
}

function messageCountIndex(buffer, stat, count, tailCount, filtered = false, conversationAt = null, sealedConversationAt = null) {
  const bytes = Buffer.isBuffer(buffer) ? buffer.lastIndexOf(10) + 1 : buffer.bytes;
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 64) : buffer.head;
  const tail = Buffer.isBuffer(buffer) ? buffer.subarray(Math.max(0, buffer.length - 64)) : buffer.tail;
  return JSON.stringify({ version: 1, stamp: continuationStamp(stat), count,
    filtered, sealedCount: count - tailCount, bytes, conversationAt, sealedConversationAt,
    head: head.toString('hex'), tail: tail.toString('hex') });
}

// see .ai/contexts/session-cache.md ("Incremental message counts")
function readMessageCount(file, previous, stat, filtered = false, allowReplacement = false, onEntry = null) {
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
    const reusable = index?.version === 1 && oldSize < size && Object.hasOwn(index, 'sealedConversationAt')
      && (allowReplacement || ['dev', 'ino', 'birthtimeNs'].every(key => index.stamp[key] === stat[key].toString()))
      && head.toString('hex').startsWith(index.head)
      && read(Math.max(0, oldSize - 64), Math.min(oldSize, 64)).toString('hex') === index.tail;
    if ((filtered || index?.filtered) && (!reusable || index.bytes !== oldSize)) return { needsFullRead: true };
    const position = reusable ? index.bytes : 0;
    let sealedCount = reusable ? index.sealedCount : 0;
    let sealedConversationAt = reusable ? index.sealedConversationAt : null;
    const parseLine = line => {
      let entry;
      try { entry = JSON.parse(line); } catch { return null; }
      if (onEntry) onEntry(entry);
      return entry;
    };
    const scan = require('../../../jsonl-scan').scanLines(fd, position, line => {
      const entry = parseLine(line);
      if (isCountedMessage(entry)) sealedCount++;
      sealedConversationAt = laterConversation(sealedConversationAt, entry);
    }, size);
    const bytes = scan.consumed;
    const tailEntry = parseLine(scan.tail);
    const count = sealedCount + (isCountedMessage(tailEntry) ? 1 : 0);
    const conversationAt = laterConversation(sealedConversationAt, tailEntry);
    const tail = read(Math.max(0, size - 64), Math.min(size, 64));
    if (!matchesContinuationStamp(continuationStamp(stat), fs.statSync(file, { bigint: true }))) return null;
    return { messageCount: count, messageCountIndex: JSON.stringify({ version: 1,
      stamp: continuationStamp(stat), count, sealedCount, bytes, filtered: index?.filtered || filtered, conversationAt, sealedConversationAt,
      head: head.toString('hex'), tail: tail.toString('hex') }) };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { isCountedMessage, laterConversation, lastConversationAt, messageCountIndex, readMessageCount };
