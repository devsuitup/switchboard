// transcript-turn.js — whether a session transcript shows its main turn closed.
// see .ai/contexts/trigger-watcher.md, "Transcript fallback while the descriptor stays busy"
'use strict';

const fs = require('fs');

const CLOSED_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
const DEFAULT_TAIL_BYTES = 256 * 1024;

function stampOf(entry) {
  const t = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

function isLocalCommandOutput(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t.startsWith('<local-command-stdout>') && t.endsWith('</local-command-stdout>');
}

function endsTurn(entry) {
  if (entry.type === 'user') return entry.isCompactSummary === true || isLocalCommandOutput(entry);
  return CLOSED_STOP_REASONS.has(entry.message && entry.message.stop_reason);
}

function classifyTranscriptTail(text) {
  const lines = String(text).split('\n');
  let lastEntryAt = null;
  let enqueued = 0;
  let removed = 0;
  let dequeued = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const at = stampOf(entry);
    if (at !== null && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
    if (entry.type === 'queue-operation') {
      if (entry.operation === 'enqueue') enqueued += 1;
      else if (entry.operation === 'remove') removed += 1;
      else if (entry.operation === 'dequeue') dequeued += 1;
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const queueIdle = enqueued <= removed && dequeued === 0;
    const closed = endsTurn(entry) && queueIdle && at !== null;
    return { closed, closedAt: closed ? at : null, lastEntryAt };
  }
  return { closed: false, closedAt: null, lastEntryAt };
}

function readTail(filePath, size, tailBytes) {
  const start = Math.max(0, size - tailBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    let off = 0;
    while (off < length) {
      const n = fs.readSync(fd, buf, off, length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString('utf8', 0, off);
  } finally {
    fs.closeSync(fd);
  }
}

function createTranscriptTurnReader({ tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  let cache = null;
  return {
    read(filePath) {
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { return null; }
      if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return { ...cache.turn };
      }
      let tail;
      try { tail = readTail(filePath, stat.size, tailBytes); } catch (_) { return null; }
      const turn = { ...classifyTranscriptTail(tail), mtimeMs: stat.mtimeMs };
      cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, turn };
      return { ...turn };
    },
  };
}

module.exports = { classifyTranscriptTail, createTranscriptTurnReader, CLOSED_STOP_REASONS };
