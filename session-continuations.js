const fs = require('fs');

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);

function continuationId(entry, sessionId) {
  return entry.type === 'continued-in' && entry.sessionId === sessionId && validId(entry.continuedInSessionId)
    ? entry.continuedInSessionId : null;
}

function topLevelType(prefix) {
  let depth = 0;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start = i++;
      while (i < prefix.length && prefix[i] !== '"') {
        if (prefix[i] === '\\') i++;
        i++;
      }
      if (depth === 1) {
        try {
          if (JSON.parse(prefix.slice(start, i + 1)) === 'type') {
            const value = prefix.slice(i + 1).match(/^\s*:\s*("(?:\\.|[^"\\])*")/);
            if (value) return JSON.parse(value[1]);
          }
        } catch {}
      }
    }
  }
  return null;
}

function scanContinuationIndex(file, sessionId, previous, maxBytes = 4 * 1024 * 1024) {
  const stat = fs.statSync(file);
  let index;
  try { index = JSON.parse(previous); } catch {}
  const mtime = stat.mtime.toISOString();
  if (index?.complete && index.bytes === stat.size && index.mtime === mtime) return previous;
  const append = index && index.bytes < stat.size;
  const ids = new Set(append ? index.ids : []);
  let position = append ? index.bytes : 0;
  const end = Math.min(stat.size, position + maxBytes);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0), oversized = append ? !!index.skipLine : false, unresolved = append ? !!index.unresolved : false;
  let consumed = position;
  try {
    while (position < end) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (!n) break;
      position += n;
      pending = Buffer.concat([pending, buffer.subarray(0, n)]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        if (!oversized && line.length) {
          try {
            const entry = JSON.parse(line.toString('utf8'));
            const id = continuationId(entry, sessionId);
            if (id) ids.add(id);
            if (entry.type === 'continued-in' && entry.sessionId === sessionId && !id) unresolved = true;
          } catch { unresolved = true; }
        }
        pending = pending.subarray(newline + 1);
        consumed = position - pending.length;
        oversized = false;
      }
      if (pending.length > 1024 * 1024) {
        if (!oversized) {
          const type = topLevelType(pending.subarray(0, 65536).toString('utf8'));
          if (!type || type === 'continued-in') unresolved = true;
        }
        pending = Buffer.alloc(0);
        oversized = true;
        consumed = position;
      }
    }
    if (position === stat.size && pending.length && !oversized) {
      try {
        const entry = JSON.parse(pending.toString('utf8'));
        const id = continuationId(entry, sessionId);
        if (id) ids.add(id);
        if (entry.type === 'continued-in' && entry.sessionId === sessionId && !id) unresolved = true;
        consumed = position;
      } catch {}
    }
    if (oversized) consumed = position;
  } finally { fs.closeSync(fd); }
  return JSON.stringify({ ids: [...ids], bytes: consumed, complete: consumed === stat.size, mtime, unresolved, skipLine: oversized });
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
    if (!index?.complete || index.unresolved) unresolved = true;
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
