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

const MAX_PROMPTS = 50;
const COMMAND_ELEMENTS_ONLY = /^(?:\s*<(command-message|command-name|command-args|command-contents)>[\s\S]*?<\/\1>)+\s*$/;

function isLocalCommandOutput(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t.startsWith('<local-command-stdout>') && t.endsWith('</local-command-stdout>');
}

function isManualCompactBoundary(entry) {
  return !!entry && entry.type === 'system' && entry.subtype === 'compact_boundary'
    && !!entry.compactMetadata && entry.compactMetadata.trigger === 'manual';
}

function endsTurn(entry, turnDurationAfter, previous) {
  if (entry.type === 'user') {
    if (entry.isCompactSummary === true) return isManualCompactBoundary(previous);
    return isLocalCommandOutput(entry);
  }
  return turnDurationAfter && CLOSED_STOP_REASONS.has(entry.message && entry.message.stop_reason);
}

function parseMainThread(text) {
  const entries = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    entries.push(entry);
  }
  return entries;
}

function promptOf(entry) {
  if (entry.type === 'queue-operation') {
    return entry.operation === 'enqueue' && typeof entry.content === 'string' ? entry.content : null;
  }
  if (entry.type !== 'user' || entry.isMeta) return null;
  const content = entry.message && entry.message.content;
  return typeof content === 'string' ? content : null;
}

function collectPrompts(entries) {
  const prompts = [];
  for (const entry of entries) {
    const text = promptOf(entry);
    const at = stampOf(entry);
    if (text !== null && at !== null) prompts.push({ at, text });
  }
  return prompts.slice(-MAX_PROMPTS);
}

function promptMatches(text, command) {
  if (typeof text !== 'string' || typeof command !== 'string') return false;
  const want = command.trim();
  if (!want) return false;
  const got = text.trim();
  if (got === want) return true;
  if (want.startsWith('!')) {
    const bash = got.match(/^<bash-input>([\s\S]*)<\/bash-input>$/);
    const typed = want.slice(1).trim();
    return !!bash && !!typed && bash[1].trim() === typed;
  }
  if (!COMMAND_ELEMENTS_ONLY.test(got)) return false;
  const name = got.match(/<command-name>([^<]*)<\/command-name>/);
  return !!name && name[1].trim() === want.split(/\s/)[0];
}

function classifyTranscriptTail(text) {
  const entries = parseMainThread(text);
  const prompts = collectPrompts(entries);
  const compactBoundaries = entries.filter(isManualCompactBoundary)
    .map((entry) => ({ at: stampOf(entry), uuid: entry.uuid || null }))
    .filter((entry) => entry.at !== null);
  let lastEntryAt = null;
  let enqueued = 0;
  let removed = 0;
  let dequeued = 0;
  let turnDurationAfter = false;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const at = stampOf(entry);
    if (at !== null && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
    if (entry.type === 'queue-operation') {
      if (entry.operation === 'enqueue') enqueued += 1;
      else if (entry.operation === 'remove') removed += 1;
      else if (entry.operation === 'dequeue') dequeued += 1;
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') turnDurationAfter = true;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const queueIdle = enqueued <= removed && dequeued === 0;
    const closed = endsTurn(entry, turnDurationAfter, entries[i - 1]) && queueIdle && at !== null;
    return { closed, closedAt: closed ? at : null, lastEntryAt, prompts, compactBoundaries };
  }
  return { closed: false, closedAt: null, lastEntryAt, prompts, compactBoundaries };
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
  const cache = new Map();
  return {
    read(filePath) {
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { return null; }
      const hit = cache.get(filePath);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { ...hit.turn };
      let tail;
      try { tail = readTail(filePath, stat.size, tailBytes); } catch (_) { return null; }
      const turn = { ...classifyTranscriptTail(tail), mtimeMs: stat.mtimeMs };
      cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, turn });
      return { ...turn };
    },
    forget(filePath) {
      cache.delete(filePath);
    },
  };
}

module.exports = { classifyTranscriptTail, createTranscriptTurnReader, promptMatches, CLOSED_STOP_REASONS };
