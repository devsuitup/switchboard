'use strict';

// see .ai/contexts/terminal-refresh.md
const terminalReplayQueries = (() => {
  const queries = ['\x1b[6n', '\x1b[?6n', '\x1b[c', '\x1b[0c'];
  const maxPrefixLength = Math.max(...queries.map(query => query.length)) - 1;

  function removeCursorPositionQueries(data) {
    return data.replace(/\x1b\[(?:\??6n|0?c)/g, '');
  }

  function splitReplayQuery(prev, next) {
    if (!'[?60nc'.includes(next[0])) return null;
    for (const query of queries) {
      for (let k = query.length - 1; k > 0; k--) {
        if (prev.endsWith(query.slice(0, k)) && next.startsWith(query.slice(k))) return { prefix: k, remainder: query.length - k };
      }
    }
    return null;
  }

  return { removeCursorPositionQueries, splitReplayQuery, maxPrefixLength };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = terminalReplayQueries;
else window.terminalReplayQueries = terminalReplayQueries;
