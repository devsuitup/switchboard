// --- Sidebar rendering ---
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml (utils.js), ICONS (icons.js),
// showSession (terminal-manager.js), confirmAndStopSession, pollActiveSessions,
// showNewSessionPopover, showRemoteLaunchDialog, openSettingsViewer, showResumeSessionDialog,
// showJsonlViewer, forkSession, openSession, loadProjects (app.js/dialogs.js), resolveSessionStop, isRemoteSessionAlive, stopBeforeArchive (stop-session-ui.js), showAppNotice (app-notices.js)

function showProjectArchiveUndo(entry, name) {
  const id = `archive-project:${entry}`;
  const notice = showAppNotice({
    id, kind: 'undo', message: `Project "${name}" archived. Its settings and cached sessions are kept; schedules resume on unarchive.`,
    actionLabel: 'Undo',
    onAction: async () => {
      try {
        const result = await window.api.unarchiveProject(entry);
        if (!result?.ok && result?.code !== 'NOT_ARCHIVED') throw new Error(result?.error || 'The backend returned no result');
        await Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      } catch (error) {
        showAppNotice({ id, kind: 'error', message: `Could not unarchive project "${name}": ${error.message}` });
      }
    },
  });
  notice.dataset.loadGeneration = loadProjects.state?.started || 0;
}

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const archivingSessionIds = new Set();
const archivingGroupIds = new Set();
const ARCHIVE_CHECKING_TITLE = 'Checking the host before archiving…';

// see .ai/contexts/session-state.md ("Archive/delete are stop-then-archive/delete")
function setArchiveBusy(sessionId, busy) {
  if (busy) archivingSessionIds.add(sessionId); else archivingSessionIds.delete(sessionId);
  const item = sessionItemEl(sessionId, sidebarContent);
  const btn = item && item.querySelector('.session-archive-btn');
  if (!btn) return;
  btn.disabled = busy;
  const session = sessionMap.get(sessionId);
  btn.title = busy ? ARCHIVE_CHECKING_TITLE : (session && session.archived ? 'Unarchive' : 'Archive');
}

function setGroupArchiveBusy(domId, busy) {
  if (busy) archivingGroupIds.add(domId); else archivingGroupIds.delete(domId);
  const el = document.getElementById(domId);
  const btn = el && el.querySelector('.slug-group-archive-btn, .project-archive-btn');
  if (btn) btn.disabled = busy;
}

async function stopForArchive(session, unreachable, plan) {
  try {
    return await stopBeforeArchive(session, { unreachable, plan });
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'unknown error' };
  }
}

function announceNotStopped(entries) {
  const hosts = new Map();
  for (const entry of entries) {
    if (!hosts.has(entry.alias)) hosts.set(entry.alias, []);
    hosts.get(entry.alias).push(entry);
  }
  for (const [alias, rows] of hosts) {
    const members = [...new Map(rows.map(({ session, error }) => [sessionActionNoticeId('Archive', session),
      { id: sessionActionNoticeId('Archive', session), text: sessionActionDescription(session), error }])).values()];
    showAppNotice({
      id: `Archive:${alias}:not-stopped`, kind: 'error', members, mergeMembers: true,
      message: current => `Archived, but not stopped: ${remoteHostLabel(alias)} did not answer (${[...new Set(current.map(member => member.error))].join('; ')}). ${current.map(member => member.text).join('; ')}. The sessions may still be running there; unarchive them to try again once the host is back.`,
    });
  }
}

async function persistSessionArchive(session, value, stopped = false) {
  const operation = value ? 'Archive' : 'Unarchive';
  try {
    if (typeof window.api.archiveSession !== 'function') throw new Error('The archive backend is unavailable');
    const result = await window.api.archiveSession(session.sessionId, value);
    if (!result || result.ok === false || result.error) throw new Error(result?.error || 'The archive backend returned no result');
    session.archived = value;
    if (value) {
      for (const notice of document.querySelectorAll('[data-notice-id^="archive-sessions:"]')) {
        if (notice.dataset.noticeId.split(':').slice(1).includes(session.sessionId)) clearAppNotice(notice.dataset.noticeId);
      }
    }
    clearAppNotice(sessionActionNoticeId(operation, session));
    if (!value) clearAppNotice(sessionActionNoticeId('Archive', session));
    return true;
  } catch (error) {
    const reason = stopped ? `The process was stopped, but the row is not archived: ${error.message || error}` : error;
    showSessionActionFailure(operation, session, reason, 'Check the session location and connection, then retry ' + operation + ' from the sidebar.');
    return false;
  }
}

function showSessionArchiveUndo(rows, didStop) {
  showAppNotice({
    id: `archive-sessions:${rows.map(session => session.sessionId).join(':')}`, kind: 'undo',
    message: `${rows.length === 1 ? 'Session' : `${rows.length} sessions`} archived.${didStop ? ' Stopped processes stay stopped.' : ''}`,
    actionLabel: 'Undo',
    onAction: async () => {
      for (const session of rows) await persistSessionArchive(session, 0);
      Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
    },
  });
}

async function archiveSessionRows(rows) {
  let prepared = await window.planSessionArchive(rows);
  while (prepared.ok) {
    const targets = prepared.plans.flatMap(({ plan }) => plan.targets);
    if (!targets.length) break;
    const running = targets.filter(target => !target.attach).length;
    const question = rows.length === 1 ? 'Archive this session?' : `Archive ${rows.length} sessions?`;
    if (!await appConfirm({
      title: question, confirmLabel: 'Archive', danger: true,
      message: [question, `${running} running process${running === 1 ? '' : 'es'} will be stopped first.`,
        ...prepared.plans.filter(({ plan }) => plan.targets.length).map(({ plan }) => plan.confirmText.split('\n').slice(1).join('\n'))].join('\n'),
    })) return;
    const latest = await window.planSessionArchive(rows);
    if (!latest.ok) { prepared = latest; break; }
    const added = latest.plans.some(({ plan }) => plan.targets.some(target => !targets.some(confirmed =>
      confirmed.sessionId === target.sessionId && confirmed.alias === target.alias && confirmed.attach === target.attach)));
    prepared = latest;
    if (!added) break;
  }
  if (!prepared.ok) {
    surfaceStopFailure(null, prepared.error, prepared.session);
    return;
  }
  const unreachable = new Map();
  const notStopped = [];
  const archived = [];
  let stoppedAny = false;
  for (const { session, plan } of prepared.plans) {
    const result = await stopForArchive(session, unreachable, plan);
    stoppedAny ||= !!result.didStop;
    if (!result.ok) {
      surfaceStopFailure(null, result.error, session);
      continue;
    }
    const didStop = !!result.didStop;
    if (await persistSessionArchive(session, 1, didStop)) {
      archived.push(session);
      notStopped.push(...(result.notStopped || []).map(entry => ({ ...entry, session })));
    }
  }
  announceNotStopped(notStopped);
  if (archived.length) showSessionArchiveUndo(archived, stoppedAny);
  pollActiveSessions();
  Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function surfaceStopFailure(btn, message, session, operation = 'Archive') {
  session ||= sessionMap.get(btn?.closest('.session-item')?.dataset.sessionId);
  const reason = message?.message || String(message);
  const recovery = operation === 'Delete' && session?.remoteAlias
    ? 'Remote transcripts are read-only here. Use Archive in the sidebar to hide this session, or manage the transcript in its own terminal at the location above.'
    : /then retry Delete/i.test(reason) ? ''
    : 'Check the transcript and connection at the location above. If the session is running elsewhere, return to its own terminal and end it there. Then retry ' + operation + ' from the sidebar.';
  showSessionActionFailure(operation, session, message,
    recovery);
}

// see .ai/contexts/session-cache.md ("Remote hosts — freshness contract") and
// .ai/contexts/cli-session-state.md (local sessions use the same field pair)
function formatStatusAge(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const deltaMs = Date.now() - epochMs;
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

// see .ai/contexts/session-cache.md ("Remote hosts backoff" — manual reconnect, issue #252)
function formatNextAttemptIn(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const deltaMs = epochMs - Date.now();
  if (deltaMs <= 0) return null;
  const s = Math.ceil(deltaMs / 1000);
  if (s < 60) return s + 's';
  return Math.ceil(s / 60) + 'm';
}

// Three states a remote host's project header can carry (issue #212): the last
// sync cycle failed (host unreachable, reason visible), the host has never
// been read yet, or it was read successfully and genuinely has no live
// session right now. See .ai/contexts/session-cache.md.
function remoteHostTierLines(profile) {
  if (!profile || typeof profile.tier !== 'string' || !Array.isArray(profile.missing)) return '';
  const watch = profile.tools && profile.tools.inotifywait === false
    ? '\nlive updates: inotifywait is not installed: only the periodic pull runs' : '';
  return '\nCapability: ' + profile.tier
    + profile.missing.map(m => '\n' + m.tier + ' unavailable: ' + m.reason).join('')
    + watch;
}

function remoteHostState(project) {
  const state = remoteHostStatus(project);
  state.detail += remoteHostTierLines(project.remoteHostProfile);
  return state;
}

function remoteHostStatus(project) {
  if (project.remoteHostError) {
    const age = formatStatusAge(project.remoteHostAt);
    const nextIn = formatNextAttemptIn(project.remoteHostNextAttemptAt);
    return {
      cls: 'remote-host-error',
      detail: 'host unreachable: ' + project.remoteHostError
        + (age ? ' (last confirmed ' + age + ')' : ', never confirmed')
        + (nextIn ? '; next automatic attempt in ' + nextIn : ''),
    };
  }
  if (!Number.isFinite(project.remoteHostAt)) {
    return { cls: 'remote-host-unknown', detail: 'not yet synced with this host' };
  }
  const age = formatStatusAge(project.remoteHostAt);
  const liveCount = (project.sessions || []).filter(s => s.status).length;
  return {
    cls: liveCount > 0 ? 'remote-host-live' : 'remote-host-empty',
    detail: (liveCount > 0 ? liveCount + ' live session' + (liveCount > 1 ? 's' : '') : 'no live session')
      + ' (confirmed ' + age + ')',
  };
}

// --- Subagent localStorage helpers ---

// One-time GC: prune sessionIds that no longer exist in sessionMap.
// Runs once per page load (lazily on first read) to keep the stored set
// from growing indefinitely across long-lived Switchboard instances.
let _expandedSubagentsGCDone = false;
function _gcExpandedSubagentsOnce() {
  if (_expandedSubagentsGCDone) return;
  _expandedSubagentsGCDone = true;
  try {
    const raw = new Set(JSON.parse(localStorage.getItem('expandedSubagents') || '[]'));
    const pruned = new Set([...raw].filter(id => sessionMap.has(id)));
    if (pruned.size !== raw.size) {
      localStorage.setItem('expandedSubagents', JSON.stringify([...pruned]));
    }
  } catch {} // eslint: allowEmptyCatch
  try {
    const raw = new Set(JSON.parse(localStorage.getItem('expandedSubagentRest') || '[]'));
    const pruned = new Set([...raw].filter(k => !k.startsWith('p:') || sessionMap.has(k.slice(2))));
    if (pruned.size !== raw.size) {
      localStorage.setItem('expandedSubagentRest', JSON.stringify([...pruned]));
    }
  } catch {} // eslint: allowEmptyCatch
}

function getExpandedSubagents() {
  _gcExpandedSubagentsOnce();
  try {
    return new Set(JSON.parse(localStorage.getItem('expandedSubagents') || '[]'));
  } catch (e) { return new Set(); }
}

function saveExpandedSubagents(set) {
  try {
    localStorage.setItem('expandedSubagents', JSON.stringify([...set]));
  } catch (e) {}
}

// see .ai/contexts/subagent-observability.md (capped subagent lists)
const SUBAGENT_PREVIEW_COUNT = 10;

function getExpandedSubagentRest() {
  _gcExpandedSubagentsOnce();
  try {
    return new Set(JSON.parse(localStorage.getItem('expandedSubagentRest') || '[]'));
  } catch { return new Set(); } // eslint: allowEmptyCatch
}

function saveExpandedSubagentRest(set) {
  try {
    localStorage.setItem('expandedSubagentRest', JSON.stringify([...set]));
  } catch {} // eslint: allowEmptyCatch
}

// Subagent type → accent color (background / border)
const SUBAGENT_TYPE_COLORS = {
  explore:   { bg: 'rgba(62,207,130,0.18)',  border: '#3ecf82' },
  plan:      { bg: 'rgba(128,136,255,0.20)', border: '#8088ff' },
  implement: { bg: 'rgba(255,170,64,0.18)',  border: '#ffaa40' },
  review:    { bg: 'rgba(96,190,240,0.18)',  border: '#60bef0' },
  test:      { bg: 'rgba(255,100,100,0.18)', border: '#ff6464' },
  default:   { bg: 'rgba(160,160,180,0.15)', border: '#a0a0b4' },
};

function subagentTypeColor(type) {
  const key = (type || '').toLowerCase();
  return SUBAGENT_TYPE_COLORS[key] || SUBAGENT_TYPE_COLORS.default;
}

// --- Live subagent tracking — see .ai/contexts/subagent-observability.md ---
// parentSessionId → Map<agentId, Map<source, lastSeenAtMs>>.
const activeSubagentsByParent = window.taskRegistry?.agentView || new Map();

function isSubagentActive(parentSessionId, agentId) {
  const map = activeSubagentsByParent.get(parentSessionId);
  return !!map && map.has(agentId);
}

// remote-ssh/local-transcript parents have no PTY to feed activeSubagentsByParent — see .ai/contexts/subagent-observability.md
function parentHasActiveSubagent(parentSessionId) {
  const map = activeSubagentsByParent.get(parentSessionId);
  if (map && map.size > 0) return true;
  if (window.taskRegistry?.known(parentSessionId)) return false;
  if (typeof remoteSessionStates !== 'undefined') {
    const remote = remoteSessionStates.get(parentSessionId);
    if (remote && remote.snapshot().agentsBusy) return true;
  }
  if (typeof localTranscriptStates !== 'undefined') {
    const local = localTranscriptStates.get(parentSessionId);
    if (local && local.snapshot().agentsBusy) return true;
  }
  return false;
}

function pruneStaleSubagents() {
  const cutoff = Date.now() - SUBAGENT_LIVE_TTL_MS;
  for (const [parentId, map] of activeSubagentsByParent) {
    for (const [agentId, sources] of map) {
      for (const [source, at] of sources) {
        if (source !== 'cli-task' && at < cutoff) releaseSubagentSource(parentId, agentId, source, 'ttl');
      }
    }
  }
  if (window.ATRACE) window.atrace('subagents.prune', null, { map: 'activeSubagentsByParent', cutoff, parents: activeSubagentsByParent.size, agents: [...activeSubagentsByParent.values()].reduce((n, m) => n + m.size, 0), fn: 'pruneStaleSubagents' });
}

let subagentTtlTimer = null;

function scheduleSubagentTtlTick() {
  if (subagentTtlTimer) return;
  const oldest = window.taskRegistry?.oldestFallback() ?? Infinity;
  if (oldest === Infinity) return;
  const delay = Math.max(1, oldest + SUBAGENT_LIVE_TTL_MS + 1 - Date.now());
  subagentTtlTimer = setTimeout(runSubagentTtlTick, delay);
}

function runSubagentTtlTick() {
  subagentTtlTimer = null;
  const tracked = [];
  for (const [parentId, map] of activeSubagentsByParent) {
    for (const agentId of map.keys()) tracked.push([parentId, agentId]);
  }
  pruneStaleSubagents();
  for (const [parentId, agentId] of tracked) {
    if (!isSubagentActive(parentId, agentId)) reflectSubagentRunningState(parentId, agentId);
  }
  scheduleSubagentTtlTick();
}

// see .ai/contexts/subagent-observability.md (PTY cleanup provenance)
function releaseSubagentSource(parentSessionId, agentId, source, via) {
  const map = activeSubagentsByParent.get(parentSessionId);
  const sources = map?.get(agentId);
  if (!sources || (source !== undefined && !sources.has(source))) return;
  const from = Math.max(...sources.values());
  window.taskRegistry?.release(parentSessionId, agentId, source);
  const to = sources.size ? Math.max(...sources.values()) : null;

  if (window.ATRACE) window.atrace('recv.subagent-completed', parentSessionId, { map: 'activeSubagentsByParent', op: to === null ? 'delete' : 'set', agentId, from, to, source, via, fn: 'releaseSubagentSource' });
  reflectSubagentRunningState(parentSessionId, agentId);
}

function clearActiveSubagentsFor(parentSessionId, source) {
  const map = activeSubagentsByParent.get(parentSessionId);
  if (!map) return;
  for (const agentId of [...map.keys()]) releaseSubagentSource(parentSessionId, agentId, source, 'parent-cleared');
}

function rekeyActiveSubagents(oldId, newId) {
  window.taskRegistry?.rekey(oldId, newId);
}

function caretIdFor(parentSessionId) {
  return 'sub-caret-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function subagentDomId(parentSessionId, agentId) {
  return 'si-sub:' + parentSessionId + ':' + agentId;
}

function updateSessionSubagentCount(item, session) {
  if (!item) return;
  const count = window.taskRegistry?.runningAgentCount(rowSessionIds(session)) || 0;
  let text = item.querySelector('.session-subagent-count');
  if (!count) {
    text?.remove();
    return;
  }
  if (!text) {
    text = document.createElement('div');
    text.className = 'session-subagent-count';
    item.querySelector('.session-info').appendChild(text);
  }
  text.textContent = `${count} subagent${count === 1 ? '' : 's'} running`;
  text.setAttribute('aria-label', text.textContent);
}

function reflectSubagentRunningState(parentSessionId, agentId) {
  // Mirror the live-subagent count into the local-pty adapter — see .ai/contexts/session-state.md ("The local-pty adapter")
  if (typeof syncLocalPtyAgentsBusy === 'function') {
    const localMap = activeSubagentsByParent.get(parentSessionId);
    syncLocalPtyAgentsBusy(parentSessionId, !!(localMap && localMap.size > 0));
  }
  const parentEl = sessionItemEl(parentSessionId);
  const parentRow = parentEl && sessionMap.get(parentEl.dataset.sessionId);
  setHasBusyAgents(parentEl, rowSessionIds(parentRow || { sessionId: parentSessionId }).some(parentHasActiveSubagent));
  updateSessionSubagentCount(parentEl, parentRow || { sessionId: parentSessionId });
  // see .ai/contexts/subagent-observability.md
  if (parentEl) paintSessionIcon(parentEl.querySelector('.session-icon'), parentSessionId);
  if (window.ATRACE) {
    const running = isSubagentActive(parentSessionId, agentId);
    const el = document.getElementById(subagentDomId(parentSessionId, agentId));
    const caret = document.getElementById(caretIdFor(parentSessionId));
    window.atrace('class.subagent', parentSessionId, { agentId, running, childEl: el ? el.id : null, caretEl: caret ? caret.id : null, parentEl: parentEl ? parentEl.id : null, 'has-busy-agents': parentHasActiveSubagent(parentSessionId), fn: 'reflectSubagentRunningState' });
  }
}

// single write path into activeSubagentsByParent, sole emitter of recv.subagent-spawned — see docs/activity-trace.md
function noteSubagentActivity(parentSessionId, agentId, source, extra) {
  const previous = activeSubagentsByParent.get(parentSessionId)?.get(agentId);
  const from = previous ? Math.max(...previous.values()) : null;
  if (!window.taskRegistry?.note(parentSessionId, agentId, source || 'local-ipc', extra || {})) return;
  if (window.ATRACE) window.atrace('recv.subagent-spawned', parentSessionId, { map: 'activeSubagentsByParent', op: 'set', agentId, from, applied: true, source: source || 'local-ipc', fn: 'noteSubagentActivity', ...(extra || {}) });
  scheduleSubagentTtlTick();
  reflectSubagentRunningState(parentSessionId, agentId);
}

(function initSubagentLiveListeners() {
  if (!window.api) return; // guard for test/non-Electron contexts without preload

  if (typeof window.api.onSubagentSpawned === 'function') {
    window.api.onSubagentSpawned((payload) => {
      const { parentSessionId, agentId, _heartbeat } = payload || {};
      if (!parentSessionId || !agentId) return;
      const map = activeSubagentsByParent.get(parentSessionId);
      const sources = _heartbeat
        ? ['local-ipc', 'attached-ipc'].filter(source => map?.get(agentId)?.has(source))
        : [openSessions.get(parentSessionId)?.attach ? 'attached-ipc' : 'local-ipc'];
      if (!sources.length) {
        if (window.ATRACE) window.atrace('recv.subagent-spawned', parentSessionId, { map: 'activeSubagentsByParent', op: 'ignore', agentId, heartbeat: true, applied: false, reason: 'heartbeat-for-untracked-agent', fn: 'onSubagentSpawned' });
        return;
      }
      for (const source of sources) {
        noteSubagentActivity(parentSessionId, agentId, source, { subagentType: payload.subagentType, bootstrap: !!payload._bootstrap, heartbeat: !!_heartbeat });
      }
    });
  }

  if (typeof window.api.onSubagentCompleted === 'function') {
    window.api.onSubagentCompleted((payload) => {
      const { parentSessionId, agentId } = payload || {};
      if (!parentSessionId || !agentId) return;
      releaseSubagentSource(parentSessionId, agentId, 'local-ipc', 'ipc');
      releaseSubagentSource(parentSessionId, agentId, 'attached-ipc', 'ipc');
    });
  }
})();

function buildSubagentItem(session) {
  const item = document.createElement('div');
  item.className = 'sidebar-subagent session-item js-stateful';
  item.id = 'si-' + session.sessionId;
  setNeedsAttention(item, attentionSessions.has(session.sessionId));
  setResponseReady(item, responseReadySessions.has(session.sessionId));
  setCliBusy(item, !!sessionBusyState.get(session.sessionId));
  if (window.ATRACE) window.atrace('class.render', session.sessionId, { el: item.id, cls: item.className, parent: session.parentSessionId || null, agentId: session.agentId || null, fn: 'buildSubagentItem' });
  item.dataset.sessionId = session.sessionId;
  item.dataset.subagent = '1';

  const { bg, border } = subagentTypeColor(session.subagentType);
  item.style.borderLeftColor = border;

  const row = document.createElement('div');
  row.className = 'session-row';

  const typePill = document.createElement('span');
  typePill.className = 'sidebar-subagent-type';
  typePill.textContent = session.subagentType || 'sub';
  typePill.style.background = bg;
  typePill.style.borderColor = border;

  // One icon slot per row, painted by session-activity-dom.js — see .ai/contexts/session-state.md
  const icon = document.createElement('span');
  icon.className = 'session-icon';
  paintSessionIcon(icon, session.sessionId, session);

  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = session.description || session.summary || session.aiTitle || session.sessionId;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = session.messageCount ? session.messageCount + ' msgs' : '';

  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  row.appendChild(typePill);
  row.appendChild(icon);
  row.appendChild(info);
  item.appendChild(row);

  return item;
}

// see .ai/contexts/subagent-observability.md (capped subagent lists)
function splitSubagentsForPreview(list) {
  if (list.length <= SUBAGENT_PREVIEW_COUNT) return { shown: list, rest: [] };
  const recent = new Set(
    [...list]
      .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))
      .slice(0, SUBAGENT_PREVIEW_COUNT)
      .map(s => s.sessionId)
  );
  const shown = [];
  const rest = [];
  for (const s of list) {
    if (recent.has(s.sessionId) || isSubagentActive(s.parentSessionId, s.agentId)) shown.push(s);
    else rest.push(s);
  }
  return { shown, rest };
}

// see .ai/contexts/subagent-observability.md (capped subagent lists)
const pendingSubagentRest = new Map();

function appendSubagentRestToggle(container, domKey, stateKey, rest) {
  if (rest.length === 0) return;
  const toggle = document.createElement('div');
  toggle.className = 'subagents-more-toggle js-stateful';
  toggle.id = 'submore-' + domKey;
  toggle.textContent = `+ ${rest.length} more`;
  pendingSubagentRest.set(toggle.id, { stateKey, rest });
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const pending = pendingSubagentRest.get(toggle.id);
    if (!pending) return;
    pendingSubagentRest.delete(toggle.id);
    const frag = document.createDocumentFragment();
    for (const s of pending.rest) frag.appendChild(buildSubagentItem(s));
    toggle.parentNode.insertBefore(frag, toggle);
    toggle.remove();
    const set = getExpandedSubagentRest();
    set.add(pending.stateKey);
    saveExpandedSubagentRest(set);
  });
  container.appendChild(toggle);
}

// Shared by buildSessionsList and buildSlugGroup — see .ai/contexts/subagent-observability.md
function appendSubagentChildren(parentEl, parentSessionId, subagentIndex) {
  const children = subagentIndex && subagentIndex.get(parentSessionId);
  if (!children || children.length === 0) return;

  const expandedSet = getExpandedSubagents();
  const caretId = caretIdFor(parentSessionId);
  const isExpanded = expandedSet.has(parentSessionId);

  const caret = document.createElement('div');
  caret.className = 'sidebar-children-caret js-stateful';
  caret.id = caretId;
  if (isExpanded) caret.classList.add('expanded');
  caret.innerHTML = `<span class="caret-arrow">&#9654;</span> ${children.length} subagent${children.length !== 1 ? 's' : ''}`;

  const domKey = parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'sidebar-subagents-container js-stateful';
  childrenContainer.id = 'subc-' + domKey;
  childrenContainer.style.display = isExpanded ? '' : 'none';

  const restKey = 'p:' + parentSessionId;
  const restExpanded = searchMatchIds !== null || getExpandedSubagentRest().has(restKey);
  const { shown, rest } = restExpanded
    ? { shown: children, rest: [] }
    : splitSubagentsForPreview(children);

  for (const child of shown) {
    childrenContainer.appendChild(buildSubagentItem(child));
  }
  appendSubagentRestToggle(childrenContainer, domKey, restKey, rest);

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = childrenContainer.style.display !== 'none';
    childrenContainer.style.display = open ? 'none' : '';
    caret.classList.toggle('expanded', !open);
    const set = getExpandedSubagents();
    if (open) { set.delete(parentSessionId); } else { set.add(parentSessionId); }
    saveExpandedSubagents(set);
  });

  parentEl.after(caret);
  caret.after(childrenContainer);
}

function rowHeadSession(session, head = rowHeadId(session)) {
  const mergedMemberIds = [
    ...(session.mergedMemberIds || []).filter(id => id !== head),
    ...(session.sessionId !== head ? [session.sessionId] : []),
  ];
  return { ...session, sessionId: head, mergedMemberIds };
}

// See .ai/contexts/subagent-observability.md (slug-group orphan-detection fix)
function narrowSessionsToSearch(sessions, matchIds) {
  const matchedParents = new Set();
  for (const s of sessions) {
    if (s.parentSessionId && matchIds.has(s.sessionId)) matchedParents.add(s.parentSessionId);
  }
  return sessions.filter(s => [...rowSessionIds(s), rowHeadId(s)].some(id => matchIds.has(id) || matchedParents.has(id)));
}

function buildSlugGroup(slug, sessions, subagentIndex, project, legacyScheduleScopes) {
  const group = document.createElement('div');
  const id = 'schedule-' + encodeURIComponent(JSON.stringify([project.remoteAlias || '', project.projectPath, slug]));
  const expandedSlugs = getExpandedSlugs();
  try {
    const migrated = new Set(JSON.parse(sessionStorage.getItem('migratedScheduleSlugs') || '[]'));
    if (!migrated.has(id)) {
      migrated.add(id);
      sessionStorage.setItem('migratedScheduleSlugs', JSON.stringify([...migrated]));
      const legacyId = slugId(slug);
      if (!migrated.has(legacyId)) {
        migrated.add(legacyId);
        sessionStorage.setItem('migratedScheduleSlugs', JSON.stringify([...migrated]));
        if (legacyScheduleScopes.get(legacyId)?.size === 1 && expandedSlugs.has(legacyId)) {
          expandedSlugs.add(id);
          sessionStorage.setItem('expandedSlugs', JSON.stringify([...expandedSlugs]));
        }
      }
    }
  } catch {}
  const expanded = expandedSlugs.has(id);
  group.className = expanded ? 'slug-group js-stateful' : 'slug-group collapsed js-stateful';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
  const displayName = slug;
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => rowSessionIds(s).some(id => activePtyIds.has(id)));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = ICONS.archive(14);
  if (archivingGroupIds.has(id)) archiveSlugBtn.disabled = true;

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (rowSessionIds(session).some(id => activePtyIds.has(id))) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      const sessionEl = buildSessionItem(session);
      sessionsContainer.appendChild(sessionEl);
      appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more js-stateful';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older js-stateful';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        const sessionEl = buildSessionItem(session);
        olderDiv.appendChild(sessionEl);
        appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      const sessionEl = buildSessionItem(session);
      sessionsContainer.appendChild(sessionEl);
      appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

function renderProjects(projects, resort) {
  pruneStaleSubagents();
  pendingSubagentRest.clear();
  const legacyScheduleScopes = new Map();
  for (const project of [...cachedAllProjects, ...projects]) {
    for (const session of project.sessions) {
      const slug = session.scheduleSlug;
      if (session.parentSessionId || typeof slug !== 'string' || !slug) continue;
      const legacyId = slugId(slug);
      if (!legacyScheduleScopes.has(legacyId)) legacyScheduleScopes.set(legacyId, new Set());
      legacyScheduleScopes.get(legacyId).add(JSON.stringify([project.remoteAlias || '', project.projectPath, slug]));
    }
  }
  // see .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
  for (const project of projects) {
    for (const session of project.sessions) seedRemoteActivity(session, project.remoteHostError);
  }
  const newSidebar = document.createElement('div');

  // Sort project groups using sortedOrder as source of truth
  if (!resort && sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }
  // projects are now in the correct order (data order for resort, preserved order otherwise)

  // see .ai/contexts/session-cache.md ("Archived projects", worktree nesting)
  const nestKey = (project, projectPath = project.projectPath) => (project.remoteAlias || '') + '|' + projectPath;
  const listedGroups = new Set(projects.map(p => nestKey(p)));
  const worktreeMap = new Map(); // nestKey(parent) → [worktreeProject, ...]
  const worktreeSet = new Set();
  for (const project of projects) {
    const parentPath = worktreeParentPath(project.projectPath);
    if (parentPath === null) continue;
    if (project.hiddenRepository) {
      worktreeSet.add(nestKey(project));
      continue;
    }
    const parentKey = nestKey(project, parentPath);
    if (!listedGroups.has(parentKey)) continue;
    if (!worktreeMap.has(parentKey)) worktreeMap.set(parentKey, []);
    worktreeMap.get(parentKey).push(project);
    worktreeSet.add(nestKey(project));
  }

  const newSortedOrder = [];

  // Build subagent child index from all sessions in this project: parentSessionId → [sessions]
  function buildSubagentIndex(sessions) {
    const owners = new Map();
    for (const s of sessions) {
      if (!s.parentSessionId) owners.set(s.sessionId, s.sessionId);
    }
    for (const s of sessions) {
      if (s.parentSessionId) continue;
      for (const id of [...rowSessionIds(s), rowHeadId(s)]) if (!owners.has(id)) owners.set(id, s.sessionId);
    }
    const index = new Map();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const parentId = owners.get(s.parentSessionId) || s.parentSessionId;
        if (!index.has(parentId)) index.set(parentId, []);
        index.get(parentId).push(s);
      }
    }
    return index;
  }

  // Process a project's sessions: filter, sort, slug-group, order, and truncate.
  // Returns { filtered, visible, older, sortOrderEntry } or null if project should be skipped.
  function processProjectSessions(project, resort) {
    // Separate subagents from top-level sessions
    const allSessions = project.sessions;
    const subagentIndex = buildSubagentIndex(allSessions);
    let filtered = allSessions.filter(s => !s.parentSessionId);
    if (showStarredOnly) filtered = filtered.filter(s => s.starred);
    if (showRunningOnly) filtered = filtered.filter(s => rowSessionIds(s).some(id => activePtyIds.has(id)));
    if (showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter(s => {
        if (!s.modified) return false;
        const d = new Date(s.modified);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;
    // see .ai/contexts/subagent-observability.md
    const keepForOrphanSubagents = subagentIndex.size > 0 && !showStarredOnly && !showRunningOnly && !showTodayOnly;
    if (filtered.length === 0 && !project._projectMatchedOnly && !keepForOrphanSubagents && (project.sessions.length > 0 || anyFilterActive)) return null;

    // Sort
    filtered = [...filtered].sort((a, b) => {
      const aRunning = rowSessionIds(a).some(id => activePtyIds.has(id) || pendingSessions.has(id));
      const bRunning = rowSessionIds(b).some(id => activePtyIds.has(id) || pendingSessions.has(id));
      const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
      const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return new Date(b.modified) - new Date(a.modified);
    });

    // Slug grouping
    const slugMap = new Map();
    const ungrouped = [];
    for (const session of filtered) {
      const scheduled = typeof session.scheduleSlug === 'string' && session.scheduleSlug.length > 0;
      const slug = scheduled ? session.scheduleSlug : null;
      if (slug) {
        if (!slugMap.has(slug)) slugMap.set(slug, []);
        slugMap.get(slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }
    const allItems = [];
    for (const session of ungrouped) {
      const isRunning = rowSessionIds(session).some(id => activePtyIds.has(id) || pendingSessions.has(id));
      allItems.push({ sortTime: new Date(session.modified).getTime(), pinned: !!session.starred, running: isRunning, dormant: rowSessionIds(session).some(isDormantSession), element: buildSessionItem(session) });
    }
    for (const [slug, sessions] of slugMap) {
      const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
      const hasRunning = sessions.some(s => rowSessionIds(s).some(id => activePtyIds.has(id) || pendingSessions.has(id)));
      const hasPinned = sessions.some(s => s.starred);
      const hasDormant = sessions.some(s => rowSessionIds(s).some(isDormantSession));
      const element = buildSlugGroup(slug, sessions, subagentIndex, project, legacyScheduleScopes);
      allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, dormant: hasDormant, element });
    }

    // Sort render items
    const prevEntry = sortedOrder.find(e => e.projectPath === project.projectPath);
    if (resort || !prevEntry) {
      allItems.sort((a, b) => {
        const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
        const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
        if (aPri !== bPri) return bPri - aPri;
        return b.sortTime - a.sortTime;
      });
    } else {
      const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
      allItems.sort((a, b) => {
        const aPos = orderIndex.get(a.element.id);
        const bPos = orderIndex.get(b.element.id);
        if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
        if (aPos === undefined && bPos !== undefined) return -1;
        if (aPos !== undefined && bPos === undefined) return 1;
        return b.sortTime - a.sortTime;
      });
    }

    // Truncate
    let visible = [];
    let older = [];
    if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
      visible = allItems;
    } else {
      let count = 0;
      const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
      for (const item of allItems) {
        if (item.running || item.pinned || item.dormant || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
          visible.push(item);
          count++;
        } else {
          older.push(item);
        }
      }
      if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
    }

    return {
      filtered, visible, older, subagentIndex,
      topLevelIds: new Set(allSessions.filter(s => !s.parentSessionId).map(s => s.sessionId)),
      sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
    };
  }

  // Build the sessions list DOM (shared between projects and worktrees)
  function buildSessionsList(fId, visible, older, subagentIndex, projectPath, topLevelIds) {
    const sessionsList = document.createElement('div');
    sessionsList.className = 'project-sessions';
    sessionsList.id = 'sessions-' + fId;
    for (const item of visible) {
      sessionsList.appendChild(item.element);
      // Attach subagent children for top-level sessions
      const sid = item.element.dataset && item.element.dataset.sessionId;
      if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
    }
    if (older.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'sessions-more-toggle js-stateful';
      moreBtn.id = 'older-' + fId;
      moreBtn.textContent = `+ ${older.length} older`;
      const olderList = document.createElement('div');
      olderList.className = 'sessions-older js-stateful';
      olderList.id = 'older-list-' + fId;
      olderList.style.display = 'none';
      for (const item of older) {
        olderList.appendChild(item.element);
        const sid = item.element.dataset && item.element.dataset.sessionId;
        if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
      }
      sessionsList.appendChild(moreBtn);
      sessionsList.appendChild(olderList);
    }

    // Orphan subagents: children whose parentSessionId has no top-level session in this project.
    // see .ai/contexts/subagent-observability.md
    if (subagentIndex) {
      const orphans = [];
      for (const [parentId, kids] of subagentIndex) {
        if (!topLevelIds.has(parentId)) {
          for (const k of kids) orphans.push(k);
        }
      }
      if (orphans.length > 0) {
        // Persist expand/collapse per project. Default = collapsed: this
        // section is rarely the user's focus and can grow long on long-lived
        // projects (this very session has 1300+ orphan subagents).
        const orphanStateKey = 'orphanExpanded:' + projectPath;
        // see .ai/contexts/subagent-observability.md
        const expanded = searchMatchIds !== null || localStorage.getItem(orphanStateKey) === '1';

        const orphanGroup = document.createElement('div');
        orphanGroup.className = 'sidebar-orphan-subagents' + (expanded ? '' : ' collapsed');
        // Stable id so morphdom reconciles the element instead of rebuilding
        // it from scratch on every render, preventing minor flicker.
        orphanGroup.id = 'orphan-' + fId;

        const orphanLabel = document.createElement('div');
        orphanLabel.className = 'sidebar-orphan-label';
        orphanLabel.innerHTML = `<span class="orphan-caret">&#9656;</span> Orphan subagents <span class="orphan-count">${orphans.length}</span>`;
        orphanLabel.addEventListener('click', () => {
          const isCollapsed = orphanGroup.classList.toggle('collapsed');
          localStorage.setItem(orphanStateKey, isCollapsed ? '0' : '1');
        });
        orphanGroup.appendChild(orphanLabel);

        const restKey = 'o:' + projectPath;
        const restExpanded = searchMatchIds !== null || getExpandedSubagentRest().has(restKey);
        const { shown, rest } = restExpanded
          ? { shown: orphans, rest: [] }
          : splitSubagentsForPreview(orphans);

        for (const orphan of shown) {
          orphanGroup.appendChild(buildSubagentItem(orphan));
        }
        appendSubagentRestToggle(orphanGroup, fId, restKey, rest);
        sessionsList.appendChild(orphanGroup);
      }
    }

    return sessionsList;
  }

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(nestKey(project))) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, subagentIndex, topLevelIds, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group' + (project.missing ? ' missing' : '');
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header js-stateful';
    header.id = 'ph-' + fId;
    // shortProjectPath() is upstream's shared helper (utils.js); escapeHtml stays
    // because this is innerHTML — upstream's variant interpolates the raw path.
    const shortName = (project.remoteAlias ? remoteHostLabel(project.remoteAlias) + ': ' : '') + shortProjectPath(project.projectPath);
    const missingIcon = project.missing ? '<svg class="project-missing-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' : '';
    header.innerHTML = `<span class="arrow">&#9660;</span> ${missingIcon}<span class="project-name">${escapeHtml(shortName)}</span>`;

    // see .ai/contexts/session-cache.md ("Remote hosts — freshness contract")
    if (project.remoteAlias) {
      const state = remoteHostState(project);
      const hostDot = document.createElement('span');
      hostDot.className = 'session-status-dot remote-host-dot ' + state.cls;
      hostDot.title = state.detail;
      header.querySelector('.project-name').after(hostDot);

      // see .ai/contexts/session-cache.md ("Remote hosts backoff" — manual reconnect, issue #252)
      const hostRefreshBtn = document.createElement('button');
      hostRefreshBtn.className = 'remote-host-refresh-btn';
      hostRefreshBtn.title = 'Reconnect ' + remoteHostLabel(project.remoteAlias) + ' now';
      hostRefreshBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
      hostDot.after(hostRefreshBtn);
    }

    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'project-schedule-btn';
    scheduleBtn.title = 'Create scheduled task';
    scheduleBtn.innerHTML = ICONS.schedule(16);
    header.appendChild(scheduleBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.title = 'Project settings';
    settingsBtn.innerHTML = ICONS.gear(16);
    header.appendChild(settingsBtn);

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = 'Archive folder';
    archiveGroupBtn.innerHTML = ICONS.archive(18);
    if (archivingGroupIds.has(header.id)) archiveGroupBtn.disabled = true;
    header.appendChild(archiveGroupBtn);

    if (project.missing) {
      const remapBtn = document.createElement('button');
      remapBtn.className = 'project-remap-btn';
      remapBtn.title = 'Change project path';
      remapBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
      header.appendChild(remapBtn);
    }

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn js-stateful';
    newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
    if (project.remoteAlias) {
      const launch = project.remoteHostProfile && Array.isArray(project.remoteHostProfile.tiers)
        && project.remoteHostProfile.tiers.find(t => t.tier === 'launch');
      if (launch && launch.available) {
        newBtn.title = 'New session on ' + remoteHostLabel(project.remoteAlias);
      } else {
        newBtn.disabled = true;
        newBtn.title = launch && launch.reason
          ? 'New session unavailable on ' + remoteHostLabel(project.remoteAlias) + ': ' + launch.reason
          : 'Read-only mirror of ' + remoteHostLabel(project.remoteAlias) + ' — new sessions must be started on that host';
      }
    } else {
      newBtn.title = 'New session';
      newBtn.setAttribute('aria-haspopup', 'menu');
      newBtn.setAttribute('aria-expanded', 'false');
    }
    header.appendChild(newBtn);

    const sessionsList = buildSessionsList(fId, visible, older, subagentIndex, project.projectPath, topLevelIds);
    const offerNotice = buildReenableNotice(project, fId);
    if (offerNotice) sessionsList.prepend(offerNotice);

    // Auto-collapse if project path is missing, most recent session is older than threshold, or project matched with no sessions
    if (project.missing) {
      header.classList.add('collapsed');
    } else if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (project.reenableOffer) {
      // see .ai/contexts/session-cache.md ("Archived projects", re-enable offers)
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);

    // Render nested worktree sub-groups
    const childWorktrees = worktreeMap.get(nestKey(project)) || [];
    for (const wt of childWorktrees) {
      const wtResult = processProjectSessions(wt, resort);
      if (!wtResult) continue;
      newSortedOrder.push(wtResult.sortOrderEntry);

      const wtName = worktreeName(wt.projectPath) || wt.projectPath.split('/').pop();
      const wtFId = folderId(wt.projectPath);

      const wtGroup = document.createElement('div');
      wtGroup.className = 'worktree-group';
      wtGroup.id = wtFId;

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header js-stateful';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;

      const wtHideBtn = document.createElement('button');
      wtHideBtn.className = 'worktree-hide-btn';
      wtHideBtn.title = 'Archive project';
      wtHideBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      wtHeader.appendChild(wtHideBtn);

      const wtDeleteBtn = document.createElement('button');
      wtDeleteBtn.className = 'worktree-delete-btn';
      wtDeleteBtn.title = 'Delete worktree from disk';
      wtDeleteBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      wtHeader.appendChild(wtDeleteBtn);

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn js-stateful';
      wtNewBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      wtNewBtn.title = 'New session in worktree';
      wtNewBtn.setAttribute('aria-haspopup', 'menu');
      wtNewBtn.setAttribute('aria-expanded', 'false');
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older, wtResult.subagentIndex, wt.projectPath, wtResult.topLevelIds);
      wtSessionsList.className = 'worktree-sessions';
      const wtOfferNotice = buildReenableNotice(wt, wtFId);
      if (wtOfferNotice) wtSessionsList.prepend(wtOfferNotice);

      // Auto-collapse worktree if stale
      if (!wt.reenableOffer && searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    newSidebar.appendChild(group);
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = sessionItemEl(activeSessionId, newSidebar);
    if (activeItem) activeItem.classList.add('active');
  }

  revealDormantSessions(newSidebar);

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Fast-path: the stateful branches below only apply to a small set of
      // container elements tagged with `js-stateful` at build time. The vast
      // majority of nodes (SVG paths, button children, info divs, etc.) carry
      // none of these classes, so we bail immediately — this alone removes
      // ~589 ms of per-node classList probe overhead on the full 22k-node tree.
      if (!fromEl.classList.contains('js-stateful')) return true;

      if (fromEl.classList.contains('project-new-btn') && fromEl.getAttribute('aria-expanded') === 'true') {
        toEl.setAttribute('aria-expanded', 'true');
      }
      if (fromEl.classList.contains('session-item') && fromEl === document.activeElement) {
        toEl.setAttribute('tabindex', '-1');
      }

      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
        return false;
      }
      if (fromEl.classList.contains('project-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sidebar-children-caret')) {
        if (fromEl.classList.contains('expanded')) {
          toEl.classList.add('expanded');
        } else {
          toEl.classList.remove('expanded');
        }
      }
      if (fromEl.classList.contains('sidebar-subagents-container')) {
        if (fromEl.style.display !== 'none') {
          toEl.style.display = '';
        } else {
          toEl.style.display = 'none';
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);
  if (typeof refreshGridCardMembers === 'function') refreshGridCardMembers();

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

// see .ai/contexts/session-cache.md ("Archived projects", re-enable offers)
function buildReenableNotice(project, fId) {
  const offer = project.reenableOffer;
  if (!offer || !Array.isArray(offer.names) || offer.names.length === 0) return null;
  const n = offer.names.length;
  const el = document.createElement('div');
  el.className = 'schedule-reenable-notice';
  el.id = 'sro-' + fId;
  const text = document.createElement('div');
  text.className = 'schedule-reenable-text';
  text.textContent = `${n} schedule${n === 1 ? ' was' : 's were'} turned off when this folder was archived: ${offer.names.join(', ')}`;
  el.appendChild(text);
  if (Array.isArray(offer.failed) && offer.failed.length > 0) {
    const failed = document.createElement('div');
    failed.className = 'schedule-reenable-failed';
    failed.textContent = 'Could not turn back on: ' + offer.failed.map(f => `${f.name}: ${f.error}`).join('; ');
    el.appendChild(failed);
  }
  const actions = document.createElement('div');
  actions.className = 'schedule-reenable-actions';
  const on = document.createElement('button');
  on.type = 'button';
  on.className = 'schedule-reenable-on';
  on.textContent = 'Turn back on';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'schedule-reenable-dismiss';
  dismiss.textContent = 'Dismiss';
  actions.append(on, dismiss);
  el.appendChild(actions);
  return el;
}

const ARCHIVE_INDEXING_MESSAGE = 'Switchboard is still indexing sessions. Archive the folder once indexing has finished.';

// see .ai/contexts/session-cache.md ("Archived projects")
async function archiveProjectFolder(project, button) {
  try {
    const counted = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const alias = project.remoteAlias || null;
    const parent = cachedAllProjects.find(p => (p.remoteAlias || null) === alias && p.projectPath === project.projectPath);
    if (!parent) {
      showSessionActionFailure('Archive folder', project, 'The folder is no longer in the index', 'Use Reindex all sessions, then retry Archive folder.');
      Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      return;
    }
    const children = cachedAllProjects.filter(p => (p.remoteAlias || null) === alias && worktreeParentPath(p.projectPath) === parent.projectPath);
    const groups = [parent, ...children];
    const groupsArg = groups.map(g => ({ projectPath: g.projectPath, folderKey: g.folder }));
    const sessions = groups.flatMap(g => g.sessions.filter(s => !s.parentSessionId && !s.archived));

    const refuseWhileBusy = () => {
      if (!sessions.some(s => archivingSessionIds.has(s.sessionId))) return false;
      showSessionActionFailure('Archive folder', project, 'An archive is still in progress', 'Try again when it finishes.');
      return true;
    };
    if (refuseWhileBusy()) return;

    const plan = await window.api.getProjectArchivePlan(groupsArg);
    if (!plan || plan.indexing) {
      showSessionActionFailure('Archive folder', project, ARCHIVE_INDEXING_MESSAGE, 'Try again when indexing finishes.');
      return;
    }
    const schedules = plan.schedules || [];
    const disableable = schedules.filter(s => s.disableable);

    const message = ['The folder is hidden from the sidebar until it is added again or a new session starts in it.'];
    for (const s of schedules) {
      if (!s.disableable) message.push(`${s.name} stays enabled: ${s.reason}`);
    }
    if (children.length > 0) {
      message.push(`Its ${counted(children.length, 'worktree')} ${children.length === 1 ? 'is' : 'are'} archived with it.`);
    }
    const choices = [];
    if (sessions.length > 0) {
      // issue #271 / .ai/contexts/session-state.md: archive is stop-then-archive.
      const aliasesToStop = [...new Set(
        sessions.filter(s => s.remoteAlias && isRemoteSessionAlive(s)).map(s => s.remoteAlias)
      )];
      let label = `Archive the ${counted(sessions.length, 'session')}`;
      if (aliasesToStop.length > 0) label += ` — running ones are stopped first (on ${aliasesToStop.map(alias => remoteHostLabel(alias)).join(', ')})`;
      choices.push({ id: 'archiveSessions', label, checked: true, rememberKey: 'archiveFolder.archiveSessions' });
    }
    if (disableable.length > 0) {
      choices.push({
        id: 'disableSchedules',
        label: `Disable the ${disableable.length} enabled schedule${disableable.length === 1 ? '' : 's'}: ${disableable.map(s => s.name).join(', ')}`,
        checked: true,
        rememberKey: 'archiveFolder.disableSchedules',
      });
    }

    const result = await showChoiceDialog({
      title: `Archive ${shortProjectPath(parent.projectPath)}?`,
      message,
      choices,
      confirmLabel: 'Archive folder',
      initialFocus: 'confirm',
      returnFocus: button,
    });
    if (!result) return;
    if (refuseWhileBusy()) return;

    if (result.archiveSessions) {
      let refused = false;
      const notStopped = [];
      const groupKey = 'ph-' + folderId(project.projectPath);
      const own = sessions.filter(s => !archivingSessionIds.has(s.sessionId));
      setGroupArchiveBusy(groupKey, true);
      for (const s of own) setArchiveBusy(s.sessionId, true);
      const unreachable = new Map();
      try {
        for (const s of own) {
          let stopResult;
          try { stopResult = await stopForArchive(s, unreachable); } finally { setArchiveBusy(s.sessionId, false); }
          if (!stopResult.ok) {
            refused = true;
            const item = document.getElementById('si-' + s.sessionId);
            surfaceStopFailure(item && item.querySelector('.session-archive-btn'), stopResult.error, s);
          } else {
            notStopped.push(...(stopResult.notStopped || []).map(entry => ({ ...entry, session: s })));
          }
        }
      } finally {
        for (const s of own) if (archivingSessionIds.has(s.sessionId)) setArchiveBusy(s.sessionId, false);
        setGroupArchiveBusy(groupKey, false);
      }
      if (refused) {
        pollActiveSessions();
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        return;
      }
      for (const s of own) {
        if (!await persistSessionArchive(s, 1)) refused = true;
      }
      announceNotStopped(notStopped.filter(entry => entry.session.archived));
      if (refused) {
        showSessionActionFailure('Archive folder', project, 'Some sessions could not be archived; the folder was kept', 'Successful session archives were kept. Retry Archive folder after resolving the session errors.');
        pollActiveSessions();
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        return;
      }
    }

    const res = await window.api.archiveProject(groupsArg, {
      disableSchedules: result.disableSchedules ? disableable.map(s => s.filePath) : [],
    });
    if (!res || res.ok === false || res.error) {
      const reason = res?.error === 'indexing' ? ARCHIVE_INDEXING_MESSAGE : 'The folder could not be archived: ' + (res?.error || 'The backend returned no result');
      const disabled = res?.disabled?.length ? '. These schedules were turned off: ' + res.disabled.join(', ') : '';
      showSessionActionFailure('Archive folder', project, reason + disabled, 'Check schedule-*.md in the Agent Files tab, then retry Archive folder.');
    } else if (res.failed?.length) {
      showSessionActionFailure('Archive folder', project, 'The folder is archived, but these schedules could not be disabled: ' + res.failed.map(f => f.name + ': ' + f.error).join('; '),
        'Review schedule-*.md in the Agent Files tab. Restore the folder from Settings → Archived projects if you need to retry Archive folder.', undefined, { headline: 'Archive folder partly done' });
    } else {
      clearAppNotice(sessionActionNoticeId('Archive folder', project));
    }
    pollActiveSessions();
    Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
  } catch (error) {
    showSessionActionFailure('Archive folder', project, error, 'Check the folder location and connection, then retry Archive folder from the sidebar.');
  }
}

function rebindSidebarEvents(projects) {
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      if (project.remoteAlias) {
        newBtn.onclick = (e) => {
          e.stopPropagation();
          if (!newBtn.disabled) showRemoteLaunchDialog(project);
        };
      } else {
        newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
      }
    }
    const scheduleBtn = header.querySelector('.project-schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.onclick = (e) => { e.stopPropagation(); launchScheduleCreator(project); };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath, project.folder); };
    }
    const offerNotice = document.getElementById('sro-' + fId);
    if (offerNotice) {
      offerNotice.querySelector('.schedule-reenable-on').onclick = async (e) => {
        e.stopPropagation();
        await window.api.reenableProjectSchedules(project.projectPath, project.folder);
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      };
      offerNotice.querySelector('.schedule-reenable-dismiss').onclick = async (e) => {
        e.stopPropagation();
        await window.api.dismissScheduleReenableOffer(project.projectPath, project.folder);
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = (e) => {
        e.stopPropagation();
        return archiveProjectFolder(project, archiveGroupBtn);
      };
    }
    const hostRefreshBtn = header.querySelector('.remote-host-refresh-btn');
    if (hostRefreshBtn) {
      hostRefreshBtn.onclick = async (e) => {
        e.stopPropagation();
        const hostDot = header.querySelector('.remote-host-dot');
        if (hostDot) hostDot.className = 'session-status-dot remote-host-dot remote-host-connecting';
        try {
          await window.api.remoteHostRefresh(project.remoteAlias);
        } catch (err) {
          console.error('remote host refresh failed for ' + project.remoteAlias, err);
        }
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      };
    }
    const remapBtn = header.querySelector('.project-remap-btn');
    if (remapBtn) {
      remapBtn.onclick = async (e) => {
        e.stopPropagation();
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const projectShortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        if (!await appConfirm({ title: 'Remap?', message: `Remap ${projectShortName} to:\n${newPath}?`, confirmLabel: 'Remap', danger: true })) return;
        const result = await window.api.remapProject(project.projectPath, newPath);
        if (result.error) {
          await appAlert({ title: 'Switchboard', message: 'Failed to remap: ' + result.error });
        } else {
          Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        }
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-schedule-btn') || e.target.closest('.project-remap-btn') || e.target.closest('.remote-host-refresh-btn')) return;
      header.classList.toggle('collapsed');
    };
  }

  // Bind worktree header events
  sidebarContent.querySelectorAll('.worktree-header').forEach(wtHeader => {
    const wtFId = wtHeader.id.replace('ph-', '');
    const wtProject = projects.find(p => folderId(p.projectPath) === wtFId);
    if (!wtProject) return;

    const wtNewBtn = wtHeader.querySelector('.worktree-new-btn');
    if (wtNewBtn) {
      wtNewBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(wtProject, wtNewBtn); };
    }
    const wtHideBtn = wtHeader.querySelector('.worktree-hide-btn');
    if (wtHideBtn) {
      wtHideBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        const returnFocusId = wtHeader.closest('.project-group')?.querySelector('.project-header')?.id;
        try {
          const result = await window.api.archiveProjectSettings(wtProject.projectPath, wtProject.folder);
          if (result.error) throw new Error(result.error);
          window.showProjectArchiveUndo(result.entry, name);
          await Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
          if (!wtHideBtn.isConnected && document.activeElement === document.body) {
            const target = document.getElementById(returnFocusId) || sidebarContent;
            target.setAttribute('tabindex', '-1');
            target.focus();
          }
        } catch (err) {
          await showChoiceDialog({ title: 'Could not archive project', message: err.message, confirmLabel: 'OK', returnFocus: wtHideBtn });
        }
      };
    }
    const wtDeleteBtn = wtHeader.querySelector('.worktree-delete-btn');
    if (wtDeleteBtn) {
      wtDeleteBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        const confirmed = await showDeleteWorktreeDialog(name, wtProject.projectPath);
        if (!confirmed) return;
        const result = await window.api.deleteWorktree(wtProject.projectPath);
        if (result && result.ok) {
          Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
        } else {
          const msg = (result && result.error) ? result.error : 'Unknown error';
          await appAlert({ title: 'Switchboard', message: `Failed to delete worktree: ${msg}` });
        }
      };
    }
    wtHeader.onclick = (e) => {
      if (e.target.closest('.worktree-new-btn') || e.target.closest('.worktree-hide-btn') || e.target.closest('.worktree-delete-btn')) return;
      wtHeader.classList.toggle('collapsed');
    };
  });

  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        if (archivingGroupIds.has(group.id)) return;
        setGroupArchiveBusy(group.id, true);
        const todo = [...group.querySelectorAll('.session-item:not([data-subagent])')]
          .map(item => ({ item, sid: item.dataset.sessionId, session: sessionMap.get(item.dataset.sessionId) }))
          .filter(({ session, sid }) => session && !session.archived && !archivingSessionIds.has(sid));
        for (const { sid } of todo) setArchiveBusy(sid, true);
        try {
          await archiveSessionRows(todo.map(({ session }) => session));
        } finally {
          for (const { sid } of todo) if (archivingSessionIds.has(sid)) setArchiveBusy(sid, false);
          setGroupArchiveBusy(group.id, false);
        }
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    moreBtn.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    // Sessions under missing projects can't be opened — the path no longer exists
    if (item.closest('.project-group.missing')) {
      item.classList.add('disabled');
      item.title = 'Project path no longer exists — use "Change path" to fix';
      item.onclick = () => {};
      return;
    }

    // see .ai/contexts/session-cache.md ("Remote SSH hosts")
    if (session.remoteAlias && !session.remoteAttachable) {
      item.title = session.remoteAttachBlocked
        ? 'Attach unavailable: ' + session.remoteAttachBlocked + ' — opening the transcript instead'
        : 'Not currently attachable — opening the transcript instead';
    }

    item.onclick = () => {
      if (item.dataset.subagent && session.parentSessionId) {
        showSubagentTranscript(session);
      } else if (session.remoteAlias && !session.remoteAttachable) {
        showJsonlViewer(rowHeadSession(session));
      } else {
        const head = session.remoteAlias ? (session.remoteAttachSessionId || rowHeadId(session)) : rowHeadId(session);
        openSession(rowHeadSession(session, head));
      }
    };

    // Subagent items are read-only: skip pin, rename, stop, fork, archive, jsonl, launchConfig
    if (item.dataset.subagent) return;

    item.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      showSessionContextMenu(event, sessionId);
    };

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.setStar(session.sessionId, !session.starred);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        return confirmAndStopSession(session, stopBtn);
      };
    }

    const sendBtn = item.querySelector('.session-send-btn');
    if (sendBtn) {
      sendBtn.onclick = (e) => {
        e.stopPropagation();
        if (session.remoteSendBlocked) return;
        showSendPromptDialog(session);
      };
    }

    const launchConfigBtn = item.querySelector('.session-launch-config-btn');
    if (launchConfigBtn) {
      launchConfigBtn.onclick = (e) => {
        e.stopPropagation();
        showResumeSessionDialog(rowHeadSession(session));
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(rowHeadSession(session), project);
        }
      };
    }

    const bridgeBtn = item.querySelector('.session-bridge-btn');
    if (bridgeBtn) {
      bridgeBtn.onclick = (e) => {
        e.stopPropagation();
        const url = bridgeSessionUrl(session.bridgeSessionId);
        if (url) window.api.openExternal(url);
      };
    }

    const jsonlBtn = item.querySelector('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e) => {
        e.stopPropagation();
        showJsonlViewer(rowHeadSession(session));
      };
    }

    const deleteBtn = item.querySelector('.session-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (session.mergedMemberIds?.some(id =>
            activePtyIds.has(id) || (openSessions.has(id) && !openSessions.get(id).closed)
            || storedActivitySnapshot(id)?.liveness === 'alive')) {
            surfaceStopFailure(deleteBtn, 'A merged member is still running', session, 'Delete');
            return;
          }
          const confirmation = await showDeleteSessionDialog(session);
          if (!confirmation) return;
          if (!resolveSessionStop(session).remote) {
            const stopResult = await stopBeforeArchive(session);
            if (!stopResult.ok) {
              surfaceStopFailure(deleteBtn, stopResult.error, session, 'Delete');
              return;
            }
            pollActiveSessions();
          }
          // see .ai/contexts/session-state.md (#271: remote Delete)
          const res = await window.api.deleteSession(session.sessionId, confirmation.partIds);
          if (!res || !res.ok) {
            surfaceStopFailure(deleteBtn, res?.error || 'The delete backend is unavailable or returned no result', session, 'Delete');
          } else {
            clearAppNotice(sessionActionNoticeId('Delete', session));
          }
          const removedPartIds = res?.ok ? confirmation.partIds : (res?.removedPartIds || []);
          for (const id of removedPartIds) {
            window._continuationChoices?.delete('continuationChoice:' + id);
            if (typeof pendingSessions !== 'undefined') pendingSessions.delete(id);
            if (typeof dismissDormantSession === 'function') dismissDormantSession(id);
            if (typeof sessionMap !== 'undefined') sessionMap.delete(id);
            if (typeof destroySession === 'function' && typeof openSessions !== 'undefined'
                && openSessions.has(id)) {
              destroySession(id);
            }
          }
          if (res?.ok || Array.isArray(res?.removedPartIds)) {
            Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
          }
        } catch (error) {
          surfaceStopFailure(deleteBtn, error, session, 'Delete');
        }
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal) {
          if (archivingSessionIds.has(session.sessionId)) return;
          setArchiveBusy(session.sessionId, true);
          try {
            await archiveSessionRows([session]);
          } finally {
            setArchiveBusy(session.sessionId, false);
          }
          return;
        }
        if (!await persistSessionArchive(session, newVal)) return;
        Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = sessionItemEl(activeSessionId, sidebarContent);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

const SESSION_MENU_EDGE_MARGIN = 4;
let activeSessionContextMenu = null;
let sessionMenuReturnFocus = null;

function closeSessionContextMenu() {
  activeSessionContextMenu?.remove();
  activeSessionContextMenu = null;
  document.removeEventListener('mousedown', onSessionMenuOutside, true);
  document.removeEventListener('keydown', onSessionMenuKey, true);
  document.removeEventListener('scroll', onSessionMenuScroll, true);
}

function runSessionMenuAction(action) {
  const returnFocus = sessionMenuReturnFocus;
  closeSessionContextMenu();
  const focusBeforeAction = document.activeElement;
  try {
    return action();
  } finally {
    if (returnFocus?.isConnected && document.activeElement === focusBeforeAction) returnFocus.focus();
  }
}

function onSessionMenuOutside(event) {
  if (!activeSessionContextMenu?.contains(event.target)) closeSessionContextMenu();
}

function onSessionMenuScroll(event) {
  if (!activeSessionContextMenu?.contains(event.target)) closeSessionContextMenu();
}

function positionSessionContextMenu(menu, x, y) {
  menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - SESSION_MENU_EDGE_MARGIN)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - SESSION_MENU_EDGE_MARGIN)) + 'px';
}

function onSessionMenuKey(event) {
  const menu = activeSessionContextMenu;
  if (!menu) return;
  if (!menu.contains(event.target)) {
    closeSessionContextMenu();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSessionContextMenu();
    if (sessionMenuReturnFocus?.isConnected) sessionMenuReturnFocus.focus();
    return;
  }
  if (event.key === 'Tab') {
    closeSessionContextMenu();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const list = menu.querySelector('.session-parts-menu');
  const partsButton = menu.querySelector('.session-parts-btn');
  if (event.key === 'ArrowLeft' && list && !list.hidden) {
    list.hidden = true;
    partsButton.setAttribute('aria-expanded', 'false');
    partsButton.focus();
  } else if (event.key === 'ArrowRight' && event.target === partsButton) {
    partsButton.click();
  } else {
    const scope = list && !list.hidden && list.contains(event.target) ? list : menu;
    const buttons = [...scope.querySelectorAll('button')].filter(b => !b.disabled && !b.closest('[hidden]'));
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if ((event.key === 'Enter' || event.key === ' ') && index >= 0) buttons[index].click();
    else return;
    if (next !== undefined) buttons[next]?.focus();
  }
  event.preventDefault();
  event.stopPropagation();
}

function rowPartIds(session) {
  return [...new Set([...rowSessionIds(session), rowHeadId(session)])];
}

function appendSessionPartsMenu(menu, session) {
  const partIds = rowPartIds(session);
  if (partIds.length < 2) return;
  const button = document.createElement('button');
  button.className = 'popover-option session-parts-btn';
  button.textContent = 'Parts';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'session-parts-menu');
  const list = document.createElement('div');
  list.id = 'session-parts-menu';
  list.className = 'session-parts-menu';
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', 'Parts');
  list.hidden = true;
  const metadata = new Map((session.conversationParts || []).map(part => [part.sessionId, part]));
  const parts = partIds.map(id => ({
    sessionId: id, ...metadata.get(id),
  }));
  const time = part => Date.parse(part.modified) || 0;
  parts.sort((a, b) => time(b) - time(a) || (a.sessionId === rowHeadId(session) ? -1 : b.sessionId === rowHeadId(session) ? 1 : a.sessionId.localeCompare(b.sessionId)));
  for (const part of parts) {
    const group = document.createElement('div');
    group.className = 'session-part';
    group.dataset.partId = part.sessionId;
    group.setAttribute('role', 'group');
    const label = document.createElement('div');
    label.className = 'session-part-label';
    label.id = 'session-part-' + part.sessionId;
    const name = cleanDisplayName(part.name || part.aiTitle || part.summary) || 'Untitled conversation';
    const date = part.modified && Number.isFinite(Date.parse(part.modified)) ? formatDate(new Date(part.modified)) : 'unknown';
    label.textContent = `${name} · last active ${date}`;
    group.setAttribute('aria-labelledby', label.id);
    group.appendChild(label);
    for (const [text, action] of [
      ['View messages', () => showJsonlViewer({ ...rowHeadSession(session, part.sessionId), name: null, aiTitle: null, summary: null, ...part })],
      ['Copy id', async () => {
        const noticeId = sessionActionNoticeId('Copy id', { ...session, sessionId: part.sessionId });
        try {
          await window.api.writeClipboard(part.sessionId);
          clearAppNotice(noticeId);
        } catch (error) {
          showAppNotice({
            id: noticeId, kind: 'error',
            message: `Could not copy the id ${part.sessionId.split('-')[0]}: ${error?.message || error || 'Clipboard unavailable'}. Try Copy id again.`,
          });
        }
      }],
    ]) {
      const item = document.createElement('button');
      item.className = 'popover-option';
      item.setAttribute('role', 'menuitem');
      item.textContent = text;
      item.onclick = () => runSessionMenuAction(action);
      group.appendChild(item);
    }
    list.appendChild(group);
  }
  button.onclick = () => {
    list.hidden = !list.hidden;
    button.setAttribute('aria-expanded', String(!list.hidden));
    positionSessionContextMenu(menu, parseFloat(menu.style.left), parseFloat(menu.style.top));
    if (!list.hidden) list.querySelector('button')?.focus();
  };
  menu.append(button, list);
}

function showSessionContextMenu(event, sessionId) {
  closeSessionContextMenu();
  sessionMenuReturnFocus = document.activeElement;
  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu session-context-menu';
  menu.setAttribute('role', 'menu');
  const button = document.createElement('button');
  button.className = 'popover-option session-refresh-btn';
  button.setAttribute('role', 'menuitem');
  button.textContent = 'Refresh screen';
  const openId = rowOpenId(sessionMap.get(sessionId) || { sessionId });
  button.disabled = !openId;
  if (button.disabled) button.title = 'Open this session in a terminal to refresh its screen';
  button.onclick = () => runSessionMenuAction(() => requestTerminalRefresh(openId));
  menu.appendChild(button);
  const bgButton = document.createElement('button');
  bgButton.className = 'popover-option session-bg-btn';
  bgButton.setAttribute('role', 'menuitem');
  bgButton.textContent = 'Send to background';
  const reason = backgroundActionReason(openId);
  bgButton.disabled = !!reason;
  if (reason) bgButton.title = reason;
  bgButton.onclick = () => runSessionMenuAction(() => sendSessionToBackground(openId));
  menu.appendChild(bgButton);
  const row = sessionMap.get(sessionId) || { sessionId };
  if (window._continuationChoices?.has('continuationChoice:' + row.sessionId)) {
    const choose = document.createElement('button');
    choose.className = 'popover-option session-choose-part-btn';
    choose.setAttribute('role', 'menuitem');
    choose.textContent = 'Choose part to open…';
    choose.onclick = () => runSessionMenuAction(() => openSession(rowHeadSession(row), undefined, { chooseAgain: true }));
    menu.appendChild(choose);
  }
  appendSessionPartsMenu(menu, sessionMap.get(sessionId) || { sessionId });
  const dormantIds = rowSessionIds(sessionMap.get(sessionId) || { sessionId }).filter(isDormantSession);
  if (dormantIds.length) {
    const dismiss = document.createElement('button');
    dismiss.className = 'popover-option session-dismiss-dormant-btn';
    dismiss.setAttribute('role', 'menuitem');
    dismiss.textContent = "Don't restore";
    dismiss.title = 'Remove this session from the sessions to restore, without starting it';
    dismiss.onclick = () => runSessionMenuAction(() => dormantIds.forEach(dismissDormantSession));
    menu.appendChild(dismiss);
  }
  document.body.appendChild(menu);
  positionSessionContextMenu(menu, event.clientX, event.clientY);
  activeSessionContextMenu = menu;
  document.addEventListener('mousedown', onSessionMenuOutside, true);
  document.addEventListener('keydown', onSessionMenuKey, true);
  document.addEventListener('scroll', onSessionMenuScroll, true);
  menu.querySelector('button:not(:disabled)')?.focus();
}

// see .ai/contexts/session-state.md ("Descriptor-owned attention")
function remoteAttentionSnapshot(sessionId) {
  if (typeof remoteSessionStates === 'undefined') return null;
  const state = remoteSessionStates.get(sessionId);
  if (!state) return null;
  const snapshot = state.snapshot();
  return !snapshot.attached && snapshot.attention ? snapshot : null;
}

// see .ai/contexts/session-cache.md ("Restore on click")
function revealDormantSessions(root = sidebarContent) {
  for (const row of root.querySelectorAll('.session-item.dormant')) {
    let el = row;
    while (el && el !== root) {
      if (el.classList.contains('slug-group')) el.classList.remove('collapsed');
      const header = el.previousElementSibling;
      if ((el.classList.contains('project-sessions') || el.classList.contains('worktree-sessions'))
          && header && header.classList.contains('collapsed')) {
        header.classList.remove('collapsed');
      }
      el = el.parentElement;
    }
  }
}

function isDormantSession(sessionId) {
  return typeof dormantWorkingSet !== 'undefined' && dormantWorkingSet.has(sessionId);
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item js-stateful';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (rowSessionIds(session).some(id => activePtyIds.has(id))) item.classList.add('has-running-pty');
  const ids = rowSessionIds(session);
  item.dataset.headSessionId = rowHeadId(session);
  if (ids.some(isDormantSession)) item.classList.add('dormant');
  if (session.mergedMemberIds?.length) item.dataset.mergedMemberIds = session.mergedMemberIds.join(' ');
  const snapshot = mergedRowSnapshot(ids, session.sessionId,
    storedActivitySnapshot(session.sessionId, session), session);
  const remoteAttention = ids.map(remoteAttentionSnapshot).find(Boolean);
  setNeedsAttention(item, snapshot.attention || !!remoteAttention);
  setResponseReady(item, snapshot.responseReady);
  setUnseenWrittenActivity(item, snapshot.unseenWrittenActivity);
  setCliBusy(item, snapshot.busy);
  setHasBusyAgents(item, ids.some(id => parentHasActiveSubagent(id)));
  // initial-paint mirror of the remote-ssh adapter's liveness — see .ai/contexts/session-state.md
  setIsAlive(item, snapshot.liveness === 'alive' || (session.remoteAlias && isRemoteSessionAlive(session)));
  if (window.ATRACE && item.className !== 'session-item js-stateful') window.atrace('class.render', session.sessionId, { el: item.id, cls: item.className, fn: 'buildSessionItem' });
  item.dataset.sessionId = session.sessionId;
  if (session.remoteAlias) item.dataset.remoteAlias = session.remoteAlias;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // One icon slot per row, painted by session-activity-dom.js — see .ai/contexts/session-state.md
  const icon = document.createElement('span');
  icon.className = 'session-icon' + (rowSessionIds(session).some(id => activePtyIds.has(id)) ? ' running' : '');
  const bgActivity = (typeof backgroundActivityLabel === 'function' && backgroundActivityLabel(rowHeadId(session), snapshot, session))
    || (session.bgJobId ? { text: 'Activity unavailable', title: `${renderSessionIcon(snapshot).title}\nJob activity unavailable` } : null);
  paintSessionIconFromSnapshot(icon, snapshot, bgActivity?.title, bgActivity?.text);
  if (remoteAttention) paintSessionIconFromSnapshot(icon, remoteAttention);

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  // Compact meta line: time + msgs on the left, first UUID segment on the right
  // (replaces the full-width session-id line). The 30s label ticker in app.js
  // updates .session-time only, so it must stay its own span.
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');
  const shortIdEl = document.createElement('span');
  shortIdEl.className = 'session-short-id';
  shortIdEl.title = rowHeadId(session);
  shortIdEl.textContent = rowHeadId(session).split('-')[0];

  // see .ai/contexts/session-state.md ("Surfacing status on the session object")
  const statusEl = document.createElement('span');
  statusEl.className = 'session-status';
  if (bgActivity) {
    statusEl.textContent = bgActivity.text;
  } else if (session.status) {
    const age = formatStatusAge(session.statusUpdatedAt);
    const why = session.status === 'waiting' && session.waitingFor ? ' · ' + session.waitingFor : '';
    statusEl.textContent = session.status + why + (age ? ' · ' + age : '');
  }
  metaEl.append(timeEl, shortIdEl, statusEl);
  const count = rowPartIds(session).length;
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'session-parts-badge';
    badge.textContent = `${count} parts`;
    badge.title = `This conversation has ${count} parts: compaction mirrors and continuations of one exchange`;
    metaEl.insertBefore(badge, statusEl);
  }

  if (session.remoteAlias) {
    const badge = document.createElement('span');
    badge.className = 'remote-badge';
    badge.title = session.remoteAttachable
      ? 'Live session on ' + remoteHostLabel(session.remoteAlias) + ' — click to attach'
      : session.remoteAttachBlocked
        ? 'Session on ' + remoteHostLabel(session.remoteAlias) + ' — attach unavailable: ' + session.remoteAttachBlocked + ', click to read its transcript'
        : 'Session on ' + remoteHostLabel(session.remoteAlias) + ' — no live process, click to read its transcript';
    badge.textContent = remoteHostLabel(session.remoteAlias);
    summaryEl.prepend(badge);
  }

  // see .ai/contexts/bg-agents.md ("The sidebar")
  if (session.bgJobId || (typeof bgAgentSessionIds !== 'undefined'
    && rowSessionIds(session).some(id => bgAgentSessionIds.has(String(id).toLowerCase())))) {
    const badge = document.createElement('span');
    badge.className = 'bg-badge';
    badge.title = 'Background session run by the claude daemon — click to attach';
    badge.textContent = 'bg';
    summaryEl.prepend(badge);
  }

  if (session.type === 'terminal') {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'session-send-btn';
  sendBtn.title = 'Send a prompt…';
  sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  if (session.remoteSendBlocked) {
    sendBtn.disabled = true;
    sendBtn.title = 'Send unavailable: ' + session.remoteSendBlocked;
  }

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);
  if (archivingSessionIds.has(session.sessionId)) {
    archiveBtn.disabled = true;
    archiveBtn.title = ARCHIVE_CHECKING_TITLE;
  }

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  const bridgeBtn = document.createElement('button');
  bridgeBtn.className = 'session-bridge-btn';
  bridgeBtn.title = 'Open on claude.ai';
  bridgeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'session-delete-btn';
  deleteBtn.title = 'Delete session (removes the transcript from disk)';
  deleteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  const launchConfigBtn = document.createElement('button');
  launchConfigBtn.className = 'session-launch-config-btn';
  launchConfigBtn.title = 'Resume with config';
  launchConfigBtn.innerHTML = ICONS.launchConfig(14);

  actions.appendChild(stopBtn);
  if (session.remoteAlias) actions.appendChild(sendBtn);
  if (session.type !== 'terminal') {
    actions.appendChild(forkBtn);
    // see .ai/contexts/session-cache.md ("Remote hosts — descriptor-only sessions")
    if (!session.placeholder) actions.appendChild(jsonlBtn);
    if (bridgeSessionUrl(session.bridgeSessionId)) actions.appendChild(bridgeBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(launchConfigBtn);
    if (!session.remoteAlias) actions.appendChild(deleteBtn);
  }

  row.appendChild(pin);
  row.appendChild(icon);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  updateSessionSubagentCount(item, session);
  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}

// see .ai/contexts/session-state.md
async function showDeleteSessionDialog(session) {
  if (!window.api.deleteSessionPreview) throw new Error('The delete preview backend is unavailable');
  const p = await window.api.deleteSessionPreview(session.sessionId);
  if (!p?.ok || !Array.isArray(p.partIds)) {
    throw new Error(p?.error || 'The delete preview backend is unavailable or returned no parts');
  }
  const partIds = [...p.partIds];

  return enqueueModalQuestion(() => new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog delete-worktree-dialog';

    const label = cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId;
    dialog.innerHTML = `
      <h3>Delete session "${escapeHtml(label)}"?</h3>
      <div class="delete-worktree-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>The transcript is removed from disk permanently. This cannot be undone — use <strong>Archive</strong> instead to hide a session while keeping the file.</span>
      </div>
      <div class="delete-worktree-status" id="dss-status">
        <span class="dwt-loading">Checking what will be removed…</span>
      </div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="dss-cancel">Cancel</button>
        <button class="delete-worktree-confirm-btn" id="dss-confirm">Delete permanently</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const statusEl = dialog.querySelector('#dss-status');
    const projectLine = `<div class="dwt-dirty-label">Project: ${escapeHtml(session.projectPath || 'unknown')}</div>`;

    const parts = [];
    parts.push(p.parts > 1
      ? `${p.parts} parts of this conversation, ${p.transcripts} files on disk`
      : p.transcripts > 0
      ? `${p.transcripts} file${p.transcripts !== 1 ? 's' : ''} on disk`
      : 'no transcript on disk (this session never started)');
    if (p.subagents > 0) parts.push(`${p.subagents} subagent transcript${p.subagents !== 1 ? 's' : ''}`);
    if (p.running) parts.push('session is still running and will be stopped first');
    statusEl.innerHTML = projectLine + `<pre class="dwt-dirty-list">${escapeHtml(parts.join('\n'))}</pre>`;

    function close(confirmed) {
      overlay.remove();
      unregister();
      resolve(confirmed);
    }

    dialog.querySelector('#dss-cancel').onclick = () => close(false);
    dialog.querySelector('#dss-confirm').onclick = () => close({ partIds });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    const unregister = registerModal({ overlay, cancel: () => close(false) });
    dialog.querySelector('#dss-cancel').focus();
  }));
}

// --- Delete worktree confirmation dialog ---
// Returns a Promise<boolean> — true if the user confirmed deletion.
async function showDeleteWorktreeDialog(name, worktreePath) {
  // Fetch worktree status (dirty files) while the dialog is shown
  const statusPromise = window.api.worktreeStatus(worktreePath);

  return enqueueModalQuestion(() => new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog delete-worktree-dialog';

    dialog.innerHTML = `
      <h3>Delete worktree "${escapeHtml(name)}"?</h3>
      <div class="delete-worktree-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Any uncommitted changes in this worktree will be permanently lost.</span>
      </div>
      <div class="delete-worktree-status" id="dwt-status">
        <span class="dwt-loading">Checking worktree status…</span>
      </div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="dwt-cancel">Cancel</button>
        <button class="delete-worktree-confirm-btn" id="dwt-confirm">Delete anyway</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const statusEl = dialog.querySelector('#dwt-status');

    // Populate status once the IPC resolves
    statusPromise.then((status) => {
      if (!overlay.isConnected) return; // dialog already closed
      if (!status || !status.ok) {
        const errMsg = (status && status.error) ? escapeHtml(status.error) : 'Unknown error';
        statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${errMsg}</span>`;
        return;
      }
      if (status.total === 0) {
        statusEl.innerHTML = `<span class="dwt-clean">Worktree is clean — no uncommitted changes.</span>`;
        return;
      }
      const shown = status.dirty.slice(0, 10);
      const overflow = status.total - shown.length;
      const lines = shown.map(l => escapeHtml(l)).join('\n');
      const extra = overflow > 0 ? `\n+ ${overflow} more…` : '';
      statusEl.innerHTML = `<div class="dwt-dirty-label">${status.total} uncommitted file${status.total !== 1 ? 's' : ''}:</div><pre class="dwt-dirty-list">${lines}${extra}</pre>`;
    }).catch((err) => {
      if (!overlay.isConnected) return;
      statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${escapeHtml(String(err))}</span>`;
    });

    function close(confirmed) {
      overlay.remove();
      unregister();
      resolve(confirmed);
    }

    dialog.querySelector('#dwt-cancel').onclick = () => close(false);
    dialog.querySelector('#dwt-confirm').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    const unregister = registerModal({ overlay, cancel: () => close(false) });
    dialog.querySelector('#dwt-cancel').focus();
  }));
}
