'use strict';

// see .ai/contexts/terminal-refresh.md
const terminalReplayQueries = (() => {
  const queries = /\x1b(?:\[(?:\??6n|5n|0?c|>0?[cq]|\??[0-9;]*\$p)|\](?:4;[0-9]+;\?(?:;[0-9]+;\?)*|(?:10|11|12);\?(?:;\?)*)(?:\x07|\x1b\\)|P\$q[^\x00-\x1f\x7f-\x9f]*\x1b\\)/g;
  const MAX_QUERY_TAIL = 256;

  function removeCursorPositionQueries(data) {
    return data.replace(queries, '');
  }

  function queryTail(previous) {
    const chunks = typeof previous === 'string' ? [previous] : previous;
    const parts = [];
    let skip = 1;
    let remaining = MAX_QUERY_TAIL;
    for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = chunks[i].slice(-remaining);
      const end = chunk.length - 1 - skip;
      const start = end < 0 ? -1 : chunk.lastIndexOf('\x1b', end);
      parts.unshift(start < 0 ? chunk : chunk.slice(start));
      if (start >= 0) return parts.join('');
      remaining -= chunk.length;
      skip = Math.max(0, skip - chunk.length);
    }
    return chunks[chunks.length - 1]?.endsWith('\x1b') ? '\x1b' : null;
  }

  function splitReplayQuery(prev, next) {
    if (!next) return null;
    const tail = queryTail(prev);
    if (!tail) return null;
    queries.lastIndex = 0;
    let match;
    while ((match = queries.exec(tail + next))) {
      const end = match.index + match[0].length;
      if (match.index < tail.length && end > tail.length) {
        return { prefix: tail.length - match.index, remainder: end - tail.length };
      }
    }
    return null;
  }

  return { removeCursorPositionQueries, splitReplayQuery };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = terminalReplayQueries;
else window.terminalReplayQueries = terminalReplayQueries;
