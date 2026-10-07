// see .ai/contexts/bg-agents.md

const AGENTS_RECONCILE_MS = 30000;
const bgAgentSessionIds = new Set();
let agentsViewActive = false;
let agentsRoster = [];
let agentsDaemonReachable = true;
let agentsSelectedKey = null;
let agentsShowFinished = true;
let agentsGroupBy = 'state';
let agentsGroupWorktrees = true;
const AGENTS_COLLAPSE_MAX = 200;
let agentsCollapsedGroups = new Set();
let agentsReconcileTimer = null;
let agentsOpenAtStartup = false;
const agentsPendingVerbs = new Set();
const agentsVerbErrors = new Map();

function agentsEscapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function agentsEntryKey(entry) {
  return entry.kind === 'background' ? 'bg:' + entry.id : 'int:' + entry.sessionId;
}

function agentJobIsLive(entry) {
  return entry.kind === 'background' && (entry.state === 'working' || entry.state === 'blocked');
}

function agentIsLive(entry) {
  return entry.kind === 'interactive' || agentJobIsLive(entry);
}

function sortAgentEntries(entries) {
  return entries.slice().sort((a, b) => {
    const rank = (e) => (agentIsLive(e) ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const sa = Number.isFinite(a.startedAt) ? a.startedAt : -Infinity;
    const sb = Number.isFinite(b.startedAt) ? b.startedAt : -Infinity;
    return sb - sa;
  });
}

const AGENTS_GROUP_MODES = ['none', 'state', 'project'];
const AGENT_STATE_META = {
  working: { emoji: '⚙️', label: 'Working' },
  blocked: { emoji: '✋', label: 'Blocked' },
  done: { emoji: '✅', label: 'Done' },
  stopped: { emoji: '⏹️', label: 'Stopped' },
  failed: { emoji: '❌', label: 'Failed' },
  external: { emoji: '🖥️', label: 'External' },
  unknown: { emoji: '❓', label: 'Unknown' },
};

function normalizeAgentsGroupBy(value) {
  return AGENTS_GROUP_MODES.includes(value) ? value : 'state';
}

function agentStateGroupKey(entry) {
  if (entry.kind === 'interactive') return 'external';
  const known = entry.state && entry.state !== 'external' && entry.state !== 'unknown' && Object.hasOwn(AGENT_STATE_META, entry.state);
  return known ? entry.state : 'unknown';
}

function agentStateMeta(entry) {
  const key = agentStateGroupKey(entry);
  return { key, ...AGENT_STATE_META[key] };
}

function agentPathSegments(cwd) {
  return String(cwd).split(/[\\/]+/).filter(Boolean);
}

function bucketAgentsByPath(entries, keyOf) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = keyOf(entry) || '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  return [...buckets].map(([key, list]) => {
    const segs = agentPathSegments(key);
    return { key, segs, label: segs[segs.length - 1] || key, title: key, entries: list };
  });
}

function disambiguatePathLabels(groups, eligible) {
  const relabel = (pick) => {
    const counts = new Map();
    for (const g of groups) if (eligible(g)) counts.set(g.label, (counts.get(g.label) || 0) + 1);
    for (const g of groups) if (eligible(g) && counts.get(g.label) > 1) g.label = pick(g);
  };
  relabel((g) => (g.segs.length > 1 ? `${g.segs[g.segs.length - 1]} (${g.segs[g.segs.length - 2]})` : g.key));
  relabel((g) => g.key);
}

function agentLiveRank(group) {
  return group.entries.some(agentIsLive) ? 0 : 1;
}

function agentsByLabel(a, b) {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

function groupAgentsByWorktree(projectKey, entries) {
  const groups = bucketAgentsByPath(entries, e => e.worktreeRoot || e.cwd);
  for (const g of groups) g.main = !!projectKey && g.key === projectKey;
  for (const g of groups) if (g.main) g.label = 'main';
  disambiguatePathLabels(groups, g => !g.main);
  groups.sort((a, b) => agentLiveRank(a) - agentLiveRank(b) || Number(b.main) - Number(a.main) || agentsByLabel(a, b));
  return groups.map(({ key, label, title, entries: list }) => ({ key, label, title, entries: list }));
}

function groupAgentsByProject(entries, worktrees) {
  const groups = bucketAgentsByPath(entries, e => e.projectRoot || e.cwd);
  for (const g of groups) if (!g.key) g.label = 'No project';
  disambiguatePathLabels(groups, g => !!g.key);
  groups.sort((a, b) => agentLiveRank(a) - agentLiveRank(b) || Number(!a.key) - Number(!b.key) || agentsByLabel(a, b));
  return groups.map(({ key, label, title, entries: list }) => {
    const group = { key, label, title, entries: list };
    if (worktrees && key) {
      const children = groupAgentsByWorktree(key, list);
      if (children.length > 1) group.children = children;
    }
    return group;
  });
}

function groupAgentEntries(entries, mode, opts = {}) {
  if (!entries.length) return [];
  const m = normalizeAgentsGroupBy(mode);
  if (m === 'none') return [{ key: '', label: '', title: '', entries: entries.slice() }];
  if (m === 'project') return groupAgentsByProject(entries, !!opts.worktrees);
  return Object.entries(AGENT_STATE_META)
    .map(([key, meta]) => ({ key, label: meta.label, emoji: meta.emoji, title: '', entries: entries.filter(e => agentStateGroupKey(e) === key) }))
    .filter(g => g.entries.length);
}

function agentRowIcon(entry) {
  const live = agentIsLive(entry);
  const blocked = entry.kind === 'background' && entry.state === 'blocked';
  const icon = renderSessionIcon({
    busy: live && !blocked && entry.status === 'busy',
    waitingForInput: live && (blocked || entry.status === 'waiting'),
    stale: !live,
  });
  return { slotClass: icon.slotClasses[0], title: icon.title };
}

function agentVerbAvailability(entry, daemonReachable) {
  const bg = entry.kind === 'background';
  const live = agentJobIsLive(entry);
  const reachable = !!daemonReachable;
  return {
    transcript: !!entry.sessionId,
    attach: live && reachable,
    stop: live && reachable,
    respawn: bg && !live && reachable,
    rm: bg && !live && reachable,
  };
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function formatAgentAge(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function agentsSelectedEntry() {
  return agentsRoster.find(e => agentsEntryKey(e) === agentsSelectedKey) || null;
}

function applyAgentsSnapshot(snapshot) {
  agentsRoster = Array.isArray(snapshot && snapshot.roster) ? snapshot.roster : [];
  agentsDaemonReachable = !snapshot || snapshot.daemonReachable !== false;
  const next = new Set(agentsRoster.filter(e => agentJobIsLive(e) && e.sessionId).map(e => String(e.sessionId).toLowerCase()));
  let changed = next.size !== bgAgentSessionIds.size;
  if (!changed) for (const id of next) if (!bgAgentSessionIds.has(id)) { changed = true; break; }
  if (changed) {
    bgAgentSessionIds.clear();
    for (const id of next) bgAgentSessionIds.add(id);
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }
  if (agentsViewActive) renderAgentsView();
}

async function refreshAgentsRoster() {
  try {
    applyAgentsSnapshot(await window.api.getBgAgents());
  } catch (err) {
    console.warn('[agents-view] roster refresh failed', err);
  }
}

function selectAgentsRow(id) {
  agentsSelectedKey = 'bg:' + id;
  if (agentsViewActive) renderAgentsView();
}

function renderAgentRow(entry, nested = false) {
  const key = agentsEntryKey(entry);
  const icon = agentRowIcon(entry);
  const state = entry.kind === 'interactive' ? 'external' : (entry.state || '?');
  const stateEmoji = agentStateMeta(entry).emoji;
  const status = entry.status ? ' · ' + entry.status : '';
  const classes = ['agents-row'];
  if (nested) classes.push('agents-row--nested');
  if (key === agentsSelectedKey) classes.push('selected');
  if (agentsPendingVerbs.has(key)) classes.push('pending');
  return `<div class="${classes.join(' ')}" data-key="${agentsEscapeAttr(key)}">
    <span class="session-icon ${icon.slotClass}" title="${agentsEscapeAttr(icon.title)}"></span>
    <span class="agents-row-name">${escapeHtml(entry.name || entry.sessionId || entry.id || '')}</span>
    <span class="agents-row-agent">${escapeHtml(entry.agent || '—')}</span>
    <span class="agents-row-state"><span class="agents-state-emoji" aria-hidden="true">${stateEmoji}</span> ${escapeHtml(state + status)}</span>
    <span class="agents-row-cwd" title="${agentsEscapeAttr(entry.cwd || '')}">${escapeHtml(entry.cwd ? shortProjectPath(entry.cwd) : '')}</span>
    <span class="agents-row-age">${escapeHtml(formatAgentAge(entry.startedAt))}</span>
  </div>`;
}

function agentsCollapseKey(mode, group, parentKey) {
  if (mode === 'worktree') return `worktree:${parentKey}|${group.key}`;
  return `${mode}:${group.key}`;
}

function parseCollapsedGroups(text) {
  let list;
  try { list = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const keys = [...new Set(list.filter(k => typeof k === 'string'))];
  return keys.slice(-AGENTS_COLLAPSE_MAX);
}

function serializeCollapsedGroups(keys) {
  return JSON.stringify([...keys].slice(-AGENTS_COLLAPSE_MAX));
}

function readAgentsCollapsedGroups() {
  try {
    return new Set(parseCollapsedGroups(localStorage.getItem('agentsCollapsedGroups')));
  } catch {
    return new Set();
  }
}

function toggleAgentsGroup(collapseKey) {
  if (agentsCollapsedGroups.has(collapseKey)) agentsCollapsedGroups.delete(collapseKey);
  else agentsCollapsedGroups.add(collapseKey);
  while (agentsCollapsedGroups.size > AGENTS_COLLAPSE_MAX) agentsCollapsedGroups.delete(agentsCollapsedGroups.values().next().value);
  try { localStorage.setItem('agentsCollapsedGroups', serializeCollapsedGroups(agentsCollapsedGroups)); } catch {}
  renderAgentsView();
}

function renderAgentHeader(cls, group, collapseKey, collapsed) {
  const title = group.title ? ` title="${agentsEscapeAttr(group.title)}"` : '';
  const emoji = group.emoji ? `<span class="agents-group-emoji" aria-hidden="true">${group.emoji}</span> ` : '';
  const chevron = `<span class="agents-group-chevron" aria-hidden="true">${collapsed ? '▸' : '▾'}</span> `;
  return `<div class="${cls}" data-collapse="${agentsEscapeAttr(collapseKey)}" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}"${title}>${chevron}${emoji}<span class="agents-group-label">${escapeHtml(group.label)}</span> · <span class="agents-group-count">${group.entries.length}</span></div>`;
}

function renderAgentGroup(group) {
  const key = agentsCollapseKey(agentsGroupBy, group);
  const collapsed = agentsCollapsedGroups.has(key);
  const head = renderAgentHeader('agents-group-header', group, key, collapsed);
  if (collapsed) return head;
  if (!group.children) return head + group.entries.map(e => renderAgentRow(e)).join('');
  return head + group.children.map((c) => {
    const subKey = agentsCollapseKey('worktree', c, group.key);
    const subCollapsed = agentsCollapsedGroups.has(subKey);
    const subHead = renderAgentHeader('agents-subgroup-header', c, subKey, subCollapsed);
    return subCollapsed ? subHead : subHead + c.entries.map(e => renderAgentRow(e, true)).join('');
  }).join('');
}

function renderAgentList(visible) {
  if (agentsGroupBy === 'none') return visible.map(e => renderAgentRow(e)).join('');
  return groupAgentEntries(visible, agentsGroupBy, { worktrees: agentsGroupWorktrees }).map(renderAgentGroup).join('');
}

function readAgentsGroupWorktrees() {
  try {
    return localStorage.getItem('agentsGroupWorktrees') !== '0';
  } catch {
    return true;
  }
}

function readAgentsGroupBy() {
  try {
    return normalizeAgentsGroupBy(localStorage.getItem('agentsGroupBy'));
  } catch {
    return 'state';
  }
}

function renderAgentDetail(entry) {
  const key = agentsEntryKey(entry);
  const v = agentVerbAvailability(entry, agentsDaemonReachable);
  const pending = agentsPendingVerbs.has(key);
  const btn = (verb, label, enabled) =>
    `<button type="button" class="control-btn agents-verb-btn" data-verb="${verb}"${enabled && !pending ? '' : ' disabled'}>${label}</button>`;
  const meta = [];
  if (Number.isFinite(entry.tokens)) meta.push(formatTokens(entry.tokens) + ' tokens');
  if (entry.model) meta.push(entry.model);
  if (Number.isFinite(entry.startedAt)) meta.push('started ' + new Date(entry.startedAt).toLocaleString());
  if (entry.pid) meta.push('pid ' + entry.pid);
  const fan = (entry.fan || []).map((f) => {
    const dur = Number.isFinite(f.startedAt) && Number.isFinite(f.doneAt) ? formatAgentAge(f.startedAt, f.doneAt) : '';
    const tail = f.doneAt ? (dur ? ` (${dur}, done)` : ' (done)') : ' (running)';
    return `<li>${escapeHtml(f.label || f.id || '')}${escapeHtml(tail)}</li>`;
  }).join('');
  const children = (entry.children || []).filter(c => c.href)
    .map(c => `<a href="#" class="agents-link" data-href="${agentsEscapeAttr(c.href)}">${escapeHtml(c.id || c.href)}</a>`)
    .join(' · ');
  const error = agentsVerbErrors.get(key);
  return `
    <div class="agents-detail-head">
      <span class="agents-detail-name">${escapeHtml(entry.name || entry.sessionId || '')}</span>
      <span class="agents-detail-actions">
        ${btn('attach', 'Attach', v.attach)}${btn('transcript', 'Transcript', v.transcript)}${btn('stop', 'Stop', v.stop)}${btn('respawn', 'Respawn', v.respawn)}${btn('rm', 'Delete', v.rm)}
      </span>
    </div>
    ${entry.detail ? `<div class="agents-detail-line">${escapeHtml(entry.detail)}</div>` : ''}
    ${meta.length ? `<div class="agents-detail-meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
    ${entry.kind === 'interactive' ? `<div class="agents-detail-meta">${escapeHtml(entry.cwd || '')}${entry.status ? ' · ' + escapeHtml(entry.status) : ''}</div>` : ''}
    ${fan ? `<div class="agents-detail-section">Subagents<ul>${fan}</ul></div>` : ''}
    ${children ? `<div class="agents-detail-section">Produced: ${children}</div>` : ''}
    ${entry.result ? `<div class="agents-detail-section">Last result: ${escapeHtml(entry.result)}</div>` : ''}
    ${error ? `<div class="agents-detail-error">${escapeHtml(error)}</div>` : ''}
  `;
}

function renderAgentsView() {
  const listEl = document.getElementById('agents-list');
  const detailEl = document.getElementById('agents-detail');
  const countEl = document.getElementById('agents-viewer-count');
  const bannerEl = document.getElementById('agents-viewer-banner');
  if (!listEl || !detailEl) return;
  const visible = sortAgentEntries(agentsRoster.filter(e => agentsShowFinished || agentIsLive(e)));
  const running = agentsRoster.filter(agentJobIsLive).length;
  const finished = agentsRoster.filter(e => e.kind === 'background' && !agentJobIsLive(e)).length;
  const worktreesBox = document.getElementById('agents-group-worktrees');
  if (worktreesBox) worktreesBox.disabled = agentsGroupBy !== 'project';
  if (countEl) countEl.textContent = `${running} running · ${finished} finished`;
  if (bannerEl) {
    bannerEl.textContent = 'The daemon is not answering; state comes from files only.';
    bannerEl.style.display = agentsDaemonReachable ? 'none' : '';
  }
  if (agentsSelectedKey && !visible.some(e => agentsEntryKey(e) === agentsSelectedKey)) agentsSelectedKey = null;

  const nextList = document.createElement('div');
  nextList.id = 'agents-list';
  nextList.innerHTML = visible.length
    ? renderAgentList(visible)
    : '<div class="plans-empty">No background agents. <code>claude --bg</code> starts one, or New agent.</div>';
  morphdom(listEl, nextList);

  const selected = agentsSelectedEntry();
  const nextDetail = document.createElement('div');
  nextDetail.id = 'agents-detail';
  nextDetail.innerHTML = selected ? renderAgentDetail(selected) : '<div class="agents-detail-empty">Select an agent</div>';
  morphdom(detailEl, nextDetail);
}

function attachBgAgent(entry) {
  if (!entry || !agentJobIsLive(entry) || !entry.sessionId) return;
  let session = sessionMap.get(entry.sessionId);
  if (!session) {
    session = { sessionId: entry.sessionId, projectPath: entry.cwd, name: entry.name, summary: entry.name || entry.id, firstPrompt: '' };
    sessionMap.set(entry.sessionId, session);
  }
  if (agentsViewActive && gridViewActive) hideAgentsView();
  openSession(session, { type: 'attach', jobId: entry.id, cwd: entry.cwd });
}

async function runAgentVerb(verb, entry) {
  if (!entry) return;
  const key = agentsEntryKey(entry);
  if (verb === 'transcript') {
    showJsonlViewer(sessionMap.get(entry.sessionId) || { sessionId: entry.sessionId, name: entry.name, projectPath: entry.cwd });
    return;
  }
  if (verb === 'attach') {
    attachBgAgent(entry);
    return;
  }
  if (verb === 'rm' && !window.confirm('Delete this background session? Its conversation goes, and its worktree when that is safe.')) return;
  if (entry.attachedHere && (verb === 'stop' || verb === 'rm')) {
    try { await window.api.stopSession(entry.sessionId); } catch {}
  }
  agentsPendingVerbs.add(key);
  agentsVerbErrors.delete(key);
  if (agentsViewActive) renderAgentsView();
  let result;
  try {
    result = await window.api.bgAgentVerb(verb, entry.id);
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  agentsPendingVerbs.delete(key);
  if (!result || result.ok === false) agentsVerbErrors.set(key, (result && result.error) || 'unknown error');
  await refreshAgentsRoster();
}

function setAgentsToggleActive(on) {
  const btn = document.getElementById('agents-toggle-btn');
  if (btn) btn.classList.toggle('active', on);
}

async function showAgentsView() {
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  terminalHeader.style.display = 'none';
  const el = document.getElementById('agents-viewer');
  if (el) el.style.display = 'flex';
  agentsViewActive = true;
  localStorage.setItem('agentsViewActive', '1');
  setAgentsToggleActive(true);
  renderAgentsView();
  await refreshAgentsRoster();
  if (!agentsReconcileTimer) {
    agentsReconcileTimer = setInterval(() => { if (agentsViewActive) refreshAgentsRoster(); }, AGENTS_RECONCILE_MS);
  }
}

function hideAgentsView({ restore = true } = {}) {
  const el = document.getElementById('agents-viewer');
  if (el) el.style.display = 'none';
  const wasActive = agentsViewActive;
  agentsViewActive = false;
  if (wasActive) localStorage.setItem('agentsViewActive', '0');
  if (agentsReconcileTimer) { clearInterval(agentsReconcileTimer); agentsReconcileTimer = null; }
  setAgentsToggleActive(false);
  if (!wasActive || !restore) return;
  terminalArea.style.display = '';
  if (gridViewActive) {
    placeholder.style.display = 'none';
    terminalHeader.style.display = 'none';
    gridViewer.style.display = 'block';
    for (const entry of openSessions.values()) if (!entry.closed) fitAndScroll(entry);
  } else if (activeSessionId && openSessions.has(activeSessionId)) {
    showSession(activeSessionId);
  } else {
    placeholder.style.display = '';
  }
}

function toggleAgentsView() {
  if (agentsViewActive) hideAgentsView();
  else showAgentsView();
}

async function restoreAgentsViewAtStartup() {
  if (!agentsOpenAtStartup) return;
  agentsOpenAtStartup = false;
  await showAgentsView();
}

function initAgentsView() {
  agentsOpenAtStartup = localStorage.getItem('agentsViewActive') === '1';
  agentsShowFinished = localStorage.getItem('agentsShowFinished') !== '0';
  const box = document.getElementById('agents-show-finished');
  if (box) {
    box.checked = agentsShowFinished;
    box.addEventListener('change', () => {
      agentsShowFinished = box.checked;
      localStorage.setItem('agentsShowFinished', agentsShowFinished ? '1' : '0');
      renderAgentsView();
    });
  }
  agentsGroupBy = readAgentsGroupBy();
  const groupSel = document.getElementById('agents-group-by');
  if (groupSel) {
    groupSel.value = agentsGroupBy;
    groupSel.addEventListener('change', () => {
      agentsGroupBy = normalizeAgentsGroupBy(groupSel.value);
      try { localStorage.setItem('agentsGroupBy', agentsGroupBy); } catch {}
      renderAgentsView();
    });
  }
  agentsCollapsedGroups = readAgentsCollapsedGroups();
  agentsGroupWorktrees = readAgentsGroupWorktrees();
  const worktreesBox = document.getElementById('agents-group-worktrees');
  if (worktreesBox) {
    worktreesBox.checked = agentsGroupWorktrees;
    worktreesBox.disabled = agentsGroupBy !== 'project';
    worktreesBox.addEventListener('change', () => {
      agentsGroupWorktrees = worktreesBox.checked;
      try { localStorage.setItem('agentsGroupWorktrees', agentsGroupWorktrees ? '1' : '0'); } catch {}
      renderAgentsView();
    });
  }
  const newBtn = document.getElementById('agents-new-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (typeof showDispatchAgentDialog !== 'function') return;
      const active = activeSessionId ? sessionMap.get(activeSessionId) : null;
      showDispatchAgentDialog(active && active.projectPath ? { projectPath: active.projectPath, remoteAlias: active.remoteAlias } : null);
    });
  }
  const viewer = document.getElementById('agents-viewer');
  if (viewer) {
    viewer.addEventListener('click', (e) => {
      const link = e.target.closest('.agents-link');
      if (link) {
        e.preventDefault();
        window.api.openExternal(link.dataset.href);
        return;
      }
      const verbBtn = e.target.closest('.agents-verb-btn');
      if (verbBtn) {
        if (!verbBtn.disabled) runAgentVerb(verbBtn.dataset.verb, agentsSelectedEntry());
        return;
      }
      const head = e.target.closest('[data-collapse]');
      if (head) {
        toggleAgentsGroup(head.dataset.collapse);
        return;
      }
      const row = e.target.closest('.agents-row');
      if (row) {
        agentsSelectedKey = row.dataset.key;
        renderAgentsView();
      }
    });
  }
  if (viewer) {
    viewer.addEventListener('dblclick', (e) => {
      if (e.target.closest('.agents-verb-btn, .agents-link, [data-collapse]')) return;
      const row = e.target.closest('.agents-row');
      if (!row) return;
      const entry = agentsRoster.find(x => agentsEntryKey(x) === row.dataset.key);
      if (entry && agentVerbAvailability(entry, agentsDaemonReachable).attach) attachBgAgent(entry);
    });
    viewer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const head = e.target.closest && e.target.closest('[data-collapse]');
      if (!head) return;
      e.preventDefault();
      toggleAgentsGroup(head.dataset.collapse);
    });
  }
  window.api.onBgAgentsChanged((snapshot) => applyAgentsSnapshot(snapshot));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sortAgentEntries, agentRowIcon, agentVerbAvailability, formatTokens, formatAgentAge, agentsEntryKey, groupAgentEntries, normalizeAgentsGroupBy, AGENT_STATE_META, agentStateMeta,
    agentsCollapseKey, parseCollapsedGroups, serializeCollapsedGroups, AGENTS_COLLAPSE_MAX };
}
