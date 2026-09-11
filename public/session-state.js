// Pure session-state domain model — see .ai/contexts/session-state.md
'use strict';

const PRIORITY = ['attention', 'responseReady', 'busy', 'agentsBusy', 'waitingForInput', 'idle', 'stale', 'archived'];

// slotClasses use their own session-icon--* namespace, distinct from classes — see .ai/contexts/session-state.md
const ICON_BY_RUNG = {
  attention: { classes: ['needs-attention'], slotClasses: ['session-icon--attention'], glyph: '!', title: 'Needs your attention' },
  responseReady: { classes: ['response-ready'], slotClasses: ['session-icon--response-ready'], glyph: '●', title: 'Response ready' },
  busy: { classes: ['cli-busy'], slotClasses: ['session-icon--busy'], glyph: '⠋', title: 'Working' },
  agentsBusy: { classes: ['has-busy-agents'], slotClasses: ['session-icon--agents-busy'], glyph: '◆', title: 'Subagents running' },
  waitingForInput: { classes: [], slotClasses: ['session-icon--waiting'], glyph: '○', title: 'Waiting for input' },
  idle: { classes: [], slotClasses: ['session-icon--idle'], glyph: '', title: 'Idle' },
  stale: { classes: [], slotClasses: ['session-icon--stale'], glyph: '', title: 'Stale' },
  archived: { classes: [], slotClasses: ['session-icon--archived'], glyph: '', title: 'Archived' },
};

function createSessionState(kind) {
  let liveness = 'unknown'; // 'alive' | 'dead' | 'unknown'
  let attached = false; // Switchboard holds a PTY / ssh attach for this session
  let busy = false;
  let waitingForInput = false;
  let attention = false;
  let responseReady = false;
  let agentsBusy = false;
  let lastActivityAt = null;
  let lastActivitySource = null;
  let label = null;
  let labelConfidence = null;
  let attachable = null;
  let archived = false;
  let stale = false;

  function clearExclusive() {
    busy = false;
    waitingForInput = false;
    attention = false;
    responseReady = false;
  }

  function touch(event) {
    if (event && event.at !== undefined) lastActivityAt = event.at;
    if (event && event.source !== undefined) lastActivitySource = event.source;
  }

  function apply(event) {
    if (!event || typeof event.type !== 'string') return;
    switch (event.type) {
      case 'busy':
        if (event.active) {
          clearExclusive();
          busy = true;
        } else {
          busy = false;
          waitingForInput = true;
          responseReady = event.armReady !== false;
        }
        touch(event);
        break;
      case 'attention':
        if (event.active === false) {
          attention = false;
        } else {
          clearExclusive();
          attention = true;
        }
        touch(event);
        break;
      case 'clearUnread':
        responseReady = false;
        break;
      case 'liveness':
        liveness = event.value === 'alive' || event.value === 'dead' ? event.value : 'unknown';
        break;
      case 'attached':
        attached = !!event.value;
        break;
      case 'transcriptTouched':
        touch({ at: event.at !== undefined ? event.at : Date.now(), source: event.source || 'transcript' });
        break;
      case 'descriptorStatus':
        liveness = event.status === 'alive' || event.status === 'dead' ? event.status : liveness;
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
      agentsBusy,
      lastActivityAt,
      lastActivitySource,
      label,
      labelConfidence,
      attachable,
      archived,
      stale,
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
      return { classes: icon.classes.slice(), slotClasses: icon.slotClasses.slice(), glyph: icon.glyph, title: icon.title };
    }
  }
  const idle = ICON_BY_RUNG.idle;
  return { classes: idle.classes.slice(), slotClasses: idle.slotClasses.slice(), glyph: idle.glyph, title: idle.title };
}

function rungActive(s, rung) {
  switch (rung) {
    case 'attention': return !!s.attention;
    case 'responseReady': return !!s.responseReady;
    case 'busy': return !!s.busy;
    case 'agentsBusy': return !!s.agentsBusy;
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
