'use strict';

// see .ai/contexts/session-cache.md ("Session names and transcript refreshes")
function applySessionName(previous, sessionId, name, source = 'user', cachedTitle = null) {
  const userOwned = previous?.nameSource ? previous.nameSource === 'user' : !!previous?.name;
  const baseline = previous?.nameTranscriptTitle;
  const sameTitle = baseline != null && name != null &&
    baseline.replace(/ \(\d+\)$/, '') === name.replace(/ \(\d+\)$/, '');
  if (source === 'transcript' && userOwned && sameTitle) return previous;
  return { ...previous, sessionId, name, nameSource: source,
    nameTranscriptTitle: source === 'user' ? cachedTitle : name };
}

function establishTranscriptBaseline(previous, cachedEntry) {
  const userOwned = previous?.nameSource ? previous.nameSource === 'user' : !!previous?.name;
  if (userOwned && previous.nameTranscriptTitle == null && cachedEntry?.customTitle != null &&
    !cachedEntry.parentSessionId && cachedEntry.folder && !cachedEntry.folder.includes('::')) {
    return { ...previous, nameSource: 'user', nameTranscriptTitle: cachedEntry.customTitle };
  }
  return previous;
}

module.exports = { applySessionName, establishTranscriptBaseline };
