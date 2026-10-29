// Pure session-state domain model — see .ai/contexts/session-state.md
'use strict';

const PRIORITY = ['attention', 'responseReady', 'busy', 'agentsBusy', 'waitingForInput', 'idle', 'stale', 'archived'];

// slotClasses use their own session-icon--* namespace, distinct from classes — see .ai/contexts/session-state.md
const ICON_BY_RUNG = {
  attention: { classes: ['needs-attention'], slotClasses: ['session-icon--attention'], glyph: '!', title: 'Needs your attention' },
  responseReady: { classes: ['response-ready'], slotClasses: ['session-icon--response-ready'], glyph: '●', title: 'Response ready' },
  busy: { classes: ['cli-busy'], slotClasses: ['session-icon--busy'], glyph: '⠋', title: 'Working' },
  agentsBusy: { classes: ['has-busy-agents'], slotClasses: ['session-icon--agents-busy'], glyph: '⠿', title: 'Background work running' },
  waitingForInput: { classes: [], slotClasses: ['session-icon--waiting'], glyph: '○', title: 'Waiting for input' },
  idle: { classes: [], slotClasses: ['session-icon--idle'], glyph: '', title: 'Idle' },
  stale: { classes: [], slotClasses: ['session-icon--stale'], glyph: '', title: 'Not running' },
  archived: { classes: [], slotClasses: ['session-icon--archived'], glyph: '', title: 'Archived' },
};

function createSessionState(kind) {
  let liveness = 'unknown'; // 'alive' | 'dead' | 'unknown'
  let attached = false; // Switchboard holds a PTY / ssh attach for this session
  let busy = false;
  let waitingForInput = false;
  let attention = false;
  let attentionFromDescriptor = false;
  let responseReady = false;
  let manualUnread = false;
  let agentsBusy = false;
  let lastActivityAt = null;
  let lastActivitySource = null;
  let label = null;
  let labelConfidence = null;
  let attachable = null;
  let archived = false;
  let stale = false;
  let idleHintAt = null;
  let promptHint = false;
  let promptHintAt = null;
  let lastDescriptorStatus = null;
  let lastDescriptorAt = null;
  let writtenWatermark = 0;
  let seenWrittenWatermark = 0;

  function clearExclusive() {
    busy = false;
    waitingForInput = false;
    responseReady = false;
    manualUnread = false;
  }

  function releaseDescriptorAttention() {
    if (!attentionFromDescriptor) return;
    attention = false;
    attentionFromDescriptor = false;
  }

  function touch(event) {
    if (event && event.at !== undefined) lastActivityAt = event.at;
    if (event && event.source !== undefined) lastActivitySource = event.source;
  }

  function clearPromptHint(at) {
    if (at > Math.max(idleHintAt ?? -Infinity, promptHintAt ?? -Infinity)) promptHint = false;
  }

  function apply(event) {
    if (!event || typeof event.type !== 'string') return;
    switch (event.type) {
      case 'writtenActivity':
        if (Number.isSafeInteger(event.watermark) && event.watermark > writtenWatermark) writtenWatermark = event.watermark;
        break;
      case 'writtenActivitySeen':
        if (Number.isSafeInteger(event.watermark) && event.watermark >= 0) seenWrittenWatermark = Math.max(seenWrittenWatermark, Math.min(writtenWatermark, event.watermark));
        break;
      case 'busy':
        if (event.active) {
          clearExclusive();
          busy = true;
          clearPromptHint(event.at ?? Date.now());
        } else {
          busy = false;
          waitingForInput = true;
          responseReady = event.armReady !== false;
        }
        touch(event);
        break;
      case 'promptHint':
        promptHint = true;
        if (Number.isFinite(event.at)) promptHintAt = Math.max(promptHintAt ?? -Infinity, event.at);
        break;
      case 'attention':
        attentionFromDescriptor = false;
        if (event.active === false) {
          attention = false;
        } else {
          clearExclusive();
          attention = true;
        }
        touch(event);
        break;
      case 'releaseDescriptorAttention':
        releaseDescriptorAttention();
        break;
      case 'markUnread':
        responseReady = true;
        manualUnread = true;
        break;
      case 'clearUnread':
        responseReady = false;
        manualUnread = false;
        break;
      case 'turnEndForgotten':
        waitingForInput = false;
        if (event.busy) busy = false;
        break;
      case 'liveness':
        liveness = event.value === 'alive' || event.value === 'dead' ? event.value : 'unknown';
        if (liveness === 'dead') releaseDescriptorAttention();
        break;
      case 'attached':
        attached = !!event.value;
        break;
      case 'transcriptTouched':
        clearPromptHint(event.at ?? Date.now());
        touch({ at: event.at !== undefined ? event.at : Date.now(), source: event.source || 'transcript' });
        break;
      case 'descriptorStatus':
        if ((event.status === 'busy' || event.status === 'shell')
          && (lastDescriptorStatus !== event.status || Number.isFinite(event.at) && event.at > (lastDescriptorAt ?? -Infinity))) clearPromptHint(event.at ?? Date.now());
        if (event.status === 'idle' && (lastDescriptorStatus !== 'idle' || Number.isFinite(event.at) && event.at > (idleHintAt ?? -Infinity))) {
          promptHint = true;
          if (Number.isFinite(event.at)) idleHintAt = Math.max(idleHintAt ?? -Infinity, event.at);
        }
        lastDescriptorStatus = event.status;
        if (Number.isFinite(event.at)) lastDescriptorAt = Math.max(lastDescriptorAt ?? -Infinity, event.at);
        liveness = event.status === 'alive' || event.status === 'dead' ? event.status : liveness;
        if (event.attention === false) releaseDescriptorAttention();
        if (event.attention === true) {
          if (event.status === 'waiting' && liveness !== 'dead') {
            clearExclusive();
            attention = true;
            attentionFromDescriptor = true;
          } else {
            releaseDescriptorAttention();
          }
        }
        touch({ at: event.at, source: 'descriptor' });
        break;
      case 'subagentSpawned':
        agentsBusy = true;
        break;
      case 'subagentCompleted':
        agentsBusy = !!event.stillActive;
        break;
      case 'label':
        label = event.value !== undefined ? event.value : label;
        labelConfidence = event.confidence !== undefined ? event.confidence : labelConfidence;
        break;
      case 'attachable':
        attachable = !!event.value;
        break;
      case 'archived':
        archived = !!event.value;
        break;
      case 'stale':
        stale = !!event.value;
        break;
      default:
        break;
    }
  }

  function snapshot() {
    return {
      kind,
      liveness,
      attached,
      busy,
      waitingForInput,
      attention,
      responseReady,
      manualUnread,
      agentsBusy,
      lastActivityAt,
      lastActivitySource,
      label,
      labelConfidence,
      attachable,
      archived,
      stale,
      idleHintAt,
      promptHint,
      promptHintAt,
      writtenWatermark,
      seenWrittenWatermark,
      unseenWrittenActivity: writtenWatermark > seenWrittenWatermark,
    };
  }

  return { apply, snapshot };
}

// One icon slot per row, highest rung wins — see .ai/contexts/session-state.md
function renderSessionIcon(snapshot) {
  const s = snapshot || {};
  for (const rung of PRIORITY) {
    if (rungActive(s, rung)) {
      const icon = ICON_BY_RUNG[rung];
      const title = s.headTurn === 'unknown' && rung === 'waitingForInput' ? 'Turn state unavailable' : icon.title;
      return { classes: icon.classes.slice(), slotClasses: icon.slotClasses.slice(), glyph: icon.glyph, title };
    }
  }
  const idle = ICON_BY_RUNG.idle;
  return { classes: idle.classes.slice(), slotClasses: idle.slotClasses.slice(), glyph: idle.glyph, title: s.titleOverride || idle.title };
}

function rungActive(s, rung) {
  switch (rung) {
    case 'attention': return !!s.attention;
    case 'responseReady': return !!s.responseReady;
    case 'busy': return !!s.busy && (s.headTurn === undefined || s.headTurn === 'open');
    case 'agentsBusy': return !!(s.agentsBusy || s.backgroundWork);
    case 'waitingForInput': return !!s.waitingForInput;
    case 'idle': return false; // fallback rung, never matched directly here
    case 'stale': return !!s.stale;
    case 'archived': return !!s.archived;
    default: return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSessionState, renderSessionIcon };
}
