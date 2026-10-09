const fs = require('fs');

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);

function continuationId(entry, sessionId) {
  return entry?.type === 'continued-in' && entry.sessionId === sessionId && validId(entry.continuedInSessionId)
    ? entry.continuedInSessionId : null;
}

// see .ai/contexts/session-cache.md ("Continuation index")
function scanContinuationIndex(file, sessionId, previous, maxBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  const stat = fs.statSync(file), mtime = stat.mtime.toISOString();
  let index;
  try { index = JSON.parse(previous); } catch {}
  const fd = fs.openSync(file, 'r');
  const tailAt = position => {
    const tail = Buffer.alloc(Math.min(64, position));
    fs.readSync(fd, tail, 0, tail.length, position - tail.length);
    return tail.toString('hex');
  };
  try {
    const reuse = index?.version === 2 && index.bytes <= stat.size && index.size <= stat.size
      && (index.size !== stat.size || index.mtime === mtime) && index.tail === tailAt(index.bytes);
    if (reuse && index.complete && index.bytes === stat.size && index.mtime === mtime) return previous;
    const ids = new Set(reuse ? index.sealedIds : []);
    let position = reuse ? index.bytes : 0;
    let pending = reuse ? Buffer.from(index.pending || '', 'base64') : Buffer.alloc(0);
    let oversized = reuse ? !!index.skipLine : false;
    let invalid = reuse ? !!index.invalid : false;
    let lineContinued = reuse ? !!index.lineContinued : false;
    let patternTail = reuse ? index.patternTail || '' : '';
    const end = Math.min(stat.size, position + maxBytes), buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    const consume = line => {
      if (!line.length) return true;
      try {
        const entry = JSON.parse(line.toString('utf8'));
        const id = continuationId(entry, sessionId);
        if (id) ids.add(id);
        if (entry?.type === 'continued-in' && entry.sessionId === sessionId && !id) invalid = true;
        return true;
      } catch {
        if (line.includes('continued-in')) invalid = true;
        return false;
      }
    };
    const segment = bytes => {
      if (oversized) {
        const text = patternTail + bytes.toString('latin1');
        lineContinued ||= text.includes('continued-in');
        patternTail = text.slice(-11);
      } else {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > 1024 * 1024) {
          lineContinued = pending.includes('continued-in');
          patternTail = pending.subarray(-11).toString('latin1');
          pending = Buffer.alloc(0);
          oversized = true;
        }
      }
    };
    while (position < end) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (!n) break;
      position += n;
      let start = 0, newline;
      while ((newline = buffer.indexOf(10, start)) !== -1 && newline < n) {
        segment(buffer.subarray(start, newline));
        if (oversized) invalid ||= lineContinued;
        else consume(pending);
        pending = Buffer.alloc(0);
        oversized = false;
        lineContinued = false;
        patternTail = '';
        start = newline + 1;
      }
      segment(buffer.subarray(start, n));
    }
    const sealedIds = [...ids];
    let tailValid = false, tailUnresolved = false;
    if (position === stat.size && pending.length) {
      const before = invalid;
      tailValid = consume(pending);
      tailUnresolved = invalid && !before;
      invalid = before;
    }
    return JSON.stringify({ format: 2, version: 2, ids: [...ids], sealedIds, bytes: position,
      complete: position === stat.size && (!pending.length || tailValid || oversized), size: stat.size, mtime,
      unresolved: invalid || tailUnresolved || (oversized && lineContinued), invalid,
      skipLine: oversized, lineContinued, patternTail, pending: pending.toString('base64'), tail: tailAt(position) });
  } finally { fs.closeSync(fd); }
}

async function resolveContinuations(sessionId, getNode, { maxDepth = 32, maxNodes = 128 } = {}) {
  const candidates = new Map(), visiting = new Set(), visited = new Set();
  let unresolved = false, nodes = 0, continued = false;
  async function visit(id, depth) {
    if (visiting.has(id) || depth > maxDepth || ++nodes > maxNodes) { unresolved = true; return; }
    if (visited.has(id)) return;
    let node;
    try { node = await getNode(id); } catch { unresolved = true; return; }
    if (!node) { unresolved = true; return; }
    const index = node.index;
    if (index?.unresolved) unresolved = true;
    const children = index?.ids || [];
    if (!children.length) {
      if (id !== sessionId) candidates.set(id, { sessionId: id, modified: node.modified || null });
    } else {
      continued = true;
      visiting.add(id);
      for (const child of children) {
        await visit(child, depth + 1);
        if (nodes > maxNodes) break;
      }
      visiting.delete(id);
    }
    visited.add(id);
  }
  if (!validId(sessionId)) return { candidates: [], unresolved: true, continued: false };
  await visit(sessionId, 0);
  return { candidates: [...candidates.values()], unresolved, continued };
}

module.exports = { continuationId, scanContinuationIndex, resolveContinuations, validId };
