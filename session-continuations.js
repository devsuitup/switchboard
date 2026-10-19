const fs = require('fs');
const { parseFolderKey } = require('./remote-hosts');

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);

function continuationStamp(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(), size: stat.size.toString() };
}

function matchesContinuationStamp(stamp, stat) {
  return !!stamp && stamp.dev === stat.dev.toString() && stamp.ino === stat.ino.toString()
    && stamp.birthtimeNs === stat.birthtimeNs.toString() && stamp.mtimeNs === stat.mtimeNs.toString()
    && stamp.size === stat.size.toString();
}

function continuationId(entry, sessionId) {
  return entry?.type === 'continued-in' && typeof entry.sessionId === 'string' && typeof sessionId === 'string'
    && entry.sessionId.toLowerCase() === sessionId.toLowerCase() && validId(entry.continuedInSessionId)
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
    const reuse = index?.version === 3 && index.bytes <= stat.size && index.size <= stat.size
      && (index.size !== stat.size || index.mtime === mtime) && index.tail === tailAt(index.bytes);
    if (reuse && index.complete && index.bytes === stat.size && index.mtime === mtime) return previous;
    const ids = new Set(reuse ? index.sealedIds : []);
    let position = reuse ? index.bytes : 0;
    let pending = reuse ? Buffer.from(index.pending || '', 'base64') : Buffer.alloc(0);
    let oversized = reuse ? !!index.skipLine : false;
    let invalid = reuse ? !!index.invalid : false;
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
        if (/"type"\s*:\s*"continued-in"/.test(line.toString('utf8'))) invalid = true;
        return false;
      }
    };
    const segment = bytes => {
      if (!oversized) {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > 1024 * 1024) {
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
        if (!oversized) consume(pending);
        pending = Buffer.alloc(0);
        oversized = false;
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
    return JSON.stringify({ format: 3, version: 3, ids: [...ids], sealedIds, bytes: position,
      complete: position === stat.size && (!pending.length || tailValid || oversized), size: stat.size, mtime,
      unresolved: invalid || tailUnresolved, invalid,
      skipLine: oversized, pending: pending.toString('base64'), tail: tailAt(position) });
  } finally { fs.closeSync(fd); }
}

function* continuationTraversal(sessionId, { maxDepth = 32, maxNodes = 128, includeReachable = false } = {}) {
  const candidates = new Map(), visiting = new Set(), visited = new Set();
  const reachable = new Set();
  let unresolved = false, incomplete = false, nodes = 0, continued = false, waitingForIndex = false;
  let allMissingSeen = false, other = false;
  function* visit(id, depth) {
    if (visiting.has(id) || depth > maxDepth || ++nodes > maxNodes) { unresolved = other = true; return; }
    if (visited.has(id)) return;
    const node = yield id;
    if (!node) { unresolved = other = true; return; }
    if (node.waitingForIndex) { unresolved = other = true; waitingForIndex = true; return; }
    if (node.missing) { incomplete = true; return false; }
    reachable.add(id);
    const index = node.index;
    if (index?.unresolved) unresolved = other = true;
    const children = index?.ids || [];
    if (!children.length) {
      if (id !== sessionId) candidates.set(id, { sessionId: id, modified: node.modified || null });
    } else {
      continued = true;
      visiting.add(id);
      let allMissing = true;
      for (const child of children) {
        if ((yield* visit(child, depth + 1)) !== false) allMissing = false;
        if (nodes > maxNodes) break;
      }
      if (allMissing) unresolved = allMissingSeen = true;
      visiting.delete(id);
    }
    visited.add(id);
  }
  if (!validId(sessionId)) return { candidates: [], unresolved: true, continued: false, missing: false };
  if ((yield* visit(sessionId, 0)) === false) unresolved = other = true;
  return { candidates: [...candidates.values()], unresolved, continued, waitingForIndex, missing: unresolved && allMissingSeen && !other,
    ...(includeReachable ? { reachable: [...reachable], incomplete: incomplete || unresolved } : {}) };
}

async function resolveContinuations(sessionId, getNode, options) {
  const traversal = continuationTraversal(sessionId, options);
  let step = traversal.next();
  while (!step.done) {
    let node;
    try { node = await getNode(step.value); } catch { node = null; }
    step = traversal.next(node);
  }
  return step.value;
}

// see docs/decisions/0003-trigger-delivery-per-tab.md
function resolveContinuationsSync(sessionId, getNode, options) {
  const traversal = continuationTraversal(sessionId, options);
  let step = traversal.next();
  while (!step.done) {
    let node;
    try { node = getNode(step.value); } catch { node = null; }
    step = traversal.next(node && typeof node.then === 'function' ? null : node);
  }
  return step.value;
}

// see .ai/contexts/session-cache.md ("Continuation rows (#564)")
function continuationRollup(rows) {
  const result = new Map();
  const candidates = [];
  for (const row of rows) {
    if (row.parentSessionId || !row.projectPath) continue;
    const serialized = row.continuationIndex;
    if (serialized && !serialized.includes('"ids":[]') && parseFolderKey(row.folder).alias === null) candidates.push(row);
  }
  if (!candidates.length) return result;
  const local = rows.filter(row => !row.parentSessionId && row.projectPath && parseFolderKey(row.folder).alias === null);
  const byId = new Map(local.map(row => [row.sessionId, row]));
  let folded;
  const find = id => byId.get(id) || (folded ||= new Map(local.map(row => [row.sessionId.toLowerCase(), row]))).get(String(id).toLowerCase());
  const representative = row => find(row.mergedIntoSessionId || row.sessionId)?.sessionId;
  const nodes = new Map();
  for (const row of local) {
    const id = representative(row);
    if (!id) continue;
    if (!nodes.has(id)) nodes.set(id, { row: find(id), parts: [], next: new Set(), incoming: new Set() });
    nodes.get(id).parts.push(row);
  }
  const indexes = new Map(), blocked = new Set();
  const read = row => {
    if (indexes.has(row)) return indexes.get(row);
    let index;
    try { index = JSON.parse(row.continuationIndex); } catch {}
    const ids = Array.isArray(index?.ids) ? index.ids : [...(String(row.continuationIndex || '')
      .match(/"ids"\s*:\s*\[([^\]]*)/)?.[1] || '').matchAll(/"([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
    const proven = index?.format === 3 && index.complete && !index.unresolved && Array.isArray(index.ids)
      && index.ids.every(validId) && index.mtime === row.fileMtime;
    const value = { ids, proven };
    indexes.set(row, value);
    return value;
  };
  for (const row of candidates) {
    const source = nodes.get(representative(row));
    if (!source) continue;
    const { ids, proven } = read(row);
    for (const id of ids) {
      const target = find(id), targetId = target && representative(target);
      if (!proven) {
        if (targetId) blocked.add(targetId);
      }
      if (target && row.bridgeSessionId && row.bridgeSessionId === target.bridgeSessionId) continue;
      if (targetId === source.row.sessionId) continue;
      const nextId = targetId || String(id).toLowerCase();
      source.next.add(nextId);
      if (proven && targetId) nodes.get(targetId)?.incoming.add(source.row.sessionId);
    }
  }
  for (const [rootId, root] of nodes) {
    if (root.incoming.size || !root.next.size) continue;
    const chain = [];
    let node = root, valid = true;
    while (node) {
      if (blocked.has(node.row.sessionId) || node.row.projectPath !== root.row.projectPath
        || node.row.folder !== root.row.folder || chain.length > 32) { valid = false; break; }
      chain.push(node.row.sessionId);
      if (!node.next.size) break;
      if (node.next.size > 1) { valid = false; break; }
      const next = nodes.get(node.next.values().next().value);
      if (!next) break;
      if (!node.parts.every(part => read(part).proven)) { valid = false; break; }
      if (next.incoming.size !== 1) { valid = false; break; }
      node = next;
    }
    if (valid) for (const id of chain.slice(1)) result.set(id, rootId);
  }
  return result;
}

module.exports = { continuationId, continuationStamp, matchesContinuationStamp,
  scanContinuationIndex, resolveContinuations, resolveContinuationsSync, validId, continuationRollup };
