'use strict';

function conversationMeta(partIds, metaMap, rootId) {
  const parts = partIds.map(id => metaMap.get(id));
  const renamed = parts.filter(meta => meta?.nameSource === 'user')
    .sort((a, b) => (b.nameRevision || 0) - (a.nameRevision || 0))[0];
  return {
    name: (renamed || metaMap.get(rootId))?.name || null,
    starred: parts.some(meta => meta?.starred) ? 1 : 0,
    archived: parts.every(meta => meta?.archived) ? 1 : 0,
  };
}

module.exports = { conversationMeta };
