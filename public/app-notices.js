// see docs/product/BUILDING-BLOCKS.md (B8)
const appNoticeEntries = new Map();
const transientNoticeEntries = new WeakMap();
const APP_NOTICE_STACK_LIMIT = 3;
let appNoticeStackExpanded = false;
const APP_NOTICE_ICON_SHAPES = {
  info: [['circle', { cx: '8', cy: '8', r: '6.5' }], ['path', { d: 'M8 7.2v4M8 4.8v.1', 'stroke-linecap': 'round' }]],
  error: [['path', { d: 'M8 1.8l6.6 11.6H1.4z', 'stroke-linejoin': 'round' }], ['path', { d: 'M8 6.3v3.4M8 11.6v.1', 'stroke-linecap': 'round' }]],
  ok: [['circle', { cx: '8', cy: '8', r: '6.5' }], ['path', { d: 'M5.2 8.2l2 2 3.6-4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  dismiss: [['path', { d: 'M1 1l8 8M9 1l-8 8' }]],
};

window.trackUiNotice = function (element, source, options = {}) {
  if (transientNoticeEntries.has(element)) { transientNoticeEntries.get(element)(options); return; }
  let previous = null;
  function report(event, text, reason) {
    try {
      window.api?.logUiNotice?.(window.sessionNoticeLog({ event, id: element.id, source, text, reason,
        kind: options.kind || 'info' }, options.sessions, options))?.catch?.(() => {});
    } catch {}
  }
  function sync() {
    if (options.progress) return;
    const text = element.querySelector('.restore-toast-msg, #update-toast-msg')?.textContent ?? element.textContent;
    const visible = element.isConnected && !element.hidden && !element.classList.contains('hidden') && !!text;
    if (!visible && previous !== null) { report('dismiss', previous, element.dataset.uiNoticeDismissReason || 'cleared'); previous = null; }
    if (visible && previous !== text) {
      report(previous === null ? 'show' : 'replace', text);
      previous = text;
      delete element.dataset.uiNoticeDismissReason;
    }
    if (!element.isConnected) { observer.disconnect(); transientNoticeEntries.delete(element); }
  }
  const observer = new MutationObserver(sync);
  observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  if (element.parentNode) observer.observe(element.parentNode, { childList: true });
  element.addEventListener('click', event => {
    const button = event.target.closest('button');
    element.dataset.uiNoticeDismissReason = button?.matches('.restore-toast-restore, #update-restart-btn')
      ? `action:${button.textContent.trim()}` : 'user';
    if (previous !== null && element.dataset.uiNoticeDismissReason.startsWith('action:')) {
      report('action', previous, element.dataset.uiNoticeDismissReason);
    }
  }, true);
  transientNoticeEntries.set(element, next => { options = next; sync(); });
  sync();
};

function reportAppNotice(event, options, notice, reason) {
  try {
    const counts = options.id === 'main-process-errors' && event === 'merge' ? options.members.map(({ id, count }) => ({ id, count })) : undefined;
    const sessions = [options.sessions || [], (options.members || []).map(member => member.session)].flat();
    window.api?.logUiNotice?.(window.sessionNoticeLog({ event, reason, counts, kind: options.kind === 'error' || options.kind === 'warning' ? options.kind : 'info',
      id: options.id, source: options.source || String(options.logId || (sessions.some(Boolean) ? 'session' : options.id) || 'notice').split(/[:-]/)[0],
      text: counts ? '' : notice.querySelector('.app-notice-message').textContent }, sessions,
      { logId: options.logId, logText: counts ? '' : typeof options.logText === 'function' ? options.logText(options.members) : options.logText }))?.catch?.(() => {});
  } catch {}
}

window.api?.onMainProcessError?.(notice => {
  const previous = appNoticeEntries.get('main-process-errors');
  const recent = new Map((previous?.options.members || []).map(member => [member.id, member]));
  const existing = recent.get(notice.id);
  notice = { ...notice, count: Math.max(existing?.count || 0, notice.count) };
  recent.delete(notice.id);
  recent.set(notice.id, notice);
  const members = [...recent.values()].slice(-5);
  const options = {
    id: 'main-process-errors', kind: 'error', members,
    message: entries => `${entries.map(member => `${member.message.replace(/\.$/, '')}${member.count > 1 ? ` (${member.count} occurrences)` : ''}`).join('\n')}. Open log; the log may hold details.`,
    actionLabel: 'Open log', onAction: openMainErrorLog, dismissOnAction: false,
    onDismiss: () => window.api?.mainErrorNoticesDismissed?.(members.map(member => member.id)),
  };
  if (previous) {
    previous.options = options;
    renderAppNoticeMessage(previous.notice.querySelector('.app-notice-message'), options.message(members));
    reportAppNotice('merge', options, previous.notice);
  }
  const group = previous?.notice || showAppNotice(options);
  let announcement = group.querySelector('.app-notice-announcement');
  if (!announcement) {
    announcement = document.createElement('span');
    announcement.className = 'app-notice-announcement';
    announcement.setAttribute('role', 'alert');
    announcement.setAttribute('aria-atomic', 'true');
    const first = group.querySelector('button');
    (first?.parentNode || group).insertBefore(announcement, first);
  }
  if (!existing) announcement.textContent = notice.message;
});
window.api?.mainErrorNoticesReady?.();

async function openMainErrorLog() {
  try {
    const result = await window.api.openMainLog();
    if (!result?.ok) throw new Error(result?.error || 'Application log is unavailable');
    clearAppNotice('main-process-log-error');
  } catch (error) {
    showAppNotice({ id: 'main-process-log-error', kind: 'error', message: `Cannot open application log: ${error.message}` });
  }
}

function sessionActionNoticeId(operation, session) {
  return `${operation}:${session?.remoteAlias || 'local'}:${session?.sessionId || session?.projectPath || 'unknown'}`;
}

function sessionActionDescription(session, { log = false } = {}) {
  const rawName = log && session?.sessionId ? session.sessionId.match(/^[a-f0-9]{8}/i)?.[0] || '00000000' : session?.name || session?.aiTitle || session?.summary;
  const name = typeof cleanDisplayName === 'function' ? cleanDisplayName(rawName) : rawName;
  const identity = name ? `"${name}"${session?.sessionId ? ` (${session.sessionId})` : ''}`
    : session?.sessionId ? `"${session.sessionId}"` : 'folder';
  const location = [session?.remoteAlias && remoteHostLabel(session.remoteAlias), session?.projectPath || session?.cwd].filter(Boolean).join(':') || 'location unavailable';
  return `${identity} at ${location}`;
}

function sessionActionLabel(session) {
  const rawName = session?.name || session?.aiTitle || session?.summary;
  const name = typeof cleanDisplayName === 'function' ? cleanDisplayName(rawName) : rawName;
  return name || (session?.sessionId ? session.sessionId.slice(0, 8) : 'a background session');
}

function showSessionActionFailure(operation, session, error, recovery, onRetry, { headline = `${operation} failed`, kind = 'error', sessions = [session], logReason, message, details } = {}) {
  const reason = error?.message || error || 'The backend is unavailable or returned no result';
  showAppNotice({
    id: sessionActionNoticeId(operation, session), kind, sessions,
    logText: sessions.length <= 1 || logReason !== undefined
      ? `${headline} for ${sessionActionDescription(session, { log: true })}: ${logReason ?? reason}.${recovery ? ' ' + recovery : ''}` : undefined,
    message: message ?? `${headline} for ${sessionActionDescription(session)}: ${reason}.${recovery ? ' ' + recovery : ''}`,
    details,
    actionLabel: onRetry ? 'Retry' : undefined, onAction: onRetry, dismissOnAction: false,
  });
}

function clearAppNotice(id, { membersOnly = false, exceptGroup, reason = 'cleared' } = {}) {
  const entry = appNoticeEntries.get(id);
  if (entry && !membersOnly) {
    reportAppNotice('dismiss', entry.options, entry.notice, reason);
    clearTimeout(entry.timer);
    const restoreFocus = entry.notice.contains(document.activeElement);
    entry.notice.remove();
    appNoticeEntries.delete(id);
    layoutAppNotices();
    if (restoreFocus && entry.returnFocus?.isConnected) entry.returnFocus.focus();
  }
  for (const [groupId, group] of [...appNoticeEntries]) {
    if (groupId === exceptGroup) continue;
    if (!group.options.members?.some(member => member.id === id)) continue;
    const members = group.options.members.filter(member => member.id !== id);
    if (members.length) showAppNotice({ ...group.options, members, mergeMembers: false });
    else clearAppNotice(groupId);
  }
}

function appNoticeSvg(shape, className, viewBox) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attributes] of APP_NOTICE_ICON_SHAPES[shape]) {
    const part = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value);
    svg.append(part);
  }
  return svg;
}

function renderAppNoticeMessage(element, message) {
  const value = message == null ? '' : String(message);
  const split = value.indexOf('\n');
  const title = document.createElement('span');
  title.className = 'app-notice-title';
  title.textContent = split < 0 ? value : value.slice(0, split);
  if (split < 0) { element.replaceChildren(title); return; }
  const body = document.createElement('span');
  body.className = 'app-notice-body';
  body.textContent = value.slice(split + 1);
  element.replaceChildren(title, '\n', body);
}

function appNoticeControlLabel(control) {
  return control.getAttribute('aria-label') || control.textContent;
}

function layoutAppNotices() {
  const container = document.getElementById('app-notices');
  if (!container) return;
  const notices = [...container.children].filter(element => element.classList.contains('app-notice'));
  if (notices.length <= APP_NOTICE_STACK_LIMIT) appNoticeStackExpanded = false;
  const folded = appNoticeStackExpanded ? 0 : notices.length - APP_NOTICE_STACK_LIMIT;
  notices.forEach((notice, index) => { notice.hidden = index < folded; });
  let pill = [...container.children].find(element => element.classList.contains('app-notice-more'));
  if (folded <= 0) { pill?.remove(); return; }
  if (!pill) {
    pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'app-notice-more';
    pill.setAttribute('aria-expanded', 'false');
    pill.addEventListener('click', () => {
      const firstFolded = [...container.children].find(element => element.classList.contains('app-notice') && element.hidden);
      appNoticeStackExpanded = true;
      layoutAppNotices();
      firstFolded?.querySelector('button, summary')?.focus();
    });
    container.prepend(pill);
  }
  pill.textContent = `+${folded} more`;
}

function showAppNotice(options) {
  const previous = appNoticeEntries.get(options.id);
  if (options.mergeMembers) {
    options = { ...options, members: [...new Map([...(previous?.options.members || []), ...options.members].map(member => [member.id, member])).values()] };
  }
  if (options.memberOptions) options = { ...options, ...options.memberOptions(options.members) };
  const { id, kind = 'info', message, details, members, actionLabel, onAction, dismissOnAction = true, dismissible = true, persistent = false } = options;
  clearTimeout(previous?.timer);
  const focusedButton = previous?.notice.contains(document.activeElement)
    ? { className: document.activeElement.className, label: appNoticeControlLabel(document.activeElement) } : null;
  const detailsOpen = previous?.notice.querySelector('.app-notice-details')?.open === true;
  const container = document.getElementById('app-notices');
  const notice = document.createElement('div');
  if (id !== undefined) notice.dataset.noticeId = id;
  notice.className = 'app-notice';
  notice.dataset.kind = kind;
  notice.setAttribute('role', id === 'main-process-errors' ? 'group' : kind === 'error' ? 'alert' : 'status');
  if (id === 'main-process-errors') {
    notice.setAttribute('aria-live', 'off');
    notice.setAttribute('aria-label', 'Application errors');
  }
  const head = document.createElement('div');
  head.className = 'app-notice-head';
  head.append(appNoticeSvg(kind === 'error' || kind === 'warning' ? 'error' : kind === 'ok' ? 'ok' : 'info', 'app-notice-icon', '0 0 16 16'));
  const text = document.createElement('span');
  text.className = 'app-notice-message';
  renderAppNoticeMessage(text, typeof message === 'function' ? message(members) : message);
  head.append(text);
  notice.append(head);
  const detailsText = typeof details === 'function' ? details(members) : details;
  if (detailsText) {
    const disclosure = document.createElement('details');
    disclosure.className = 'app-notice-details';
    disclosure.open = detailsOpen;
    const summary = document.createElement('summary');
    summary.className = 'app-notice-details-toggle';
    summary.textContent = 'Details';
    const body = document.createElement('div');
    body.className = 'app-notice-details-body';
    body.textContent = detailsText;
    disclosure.append(summary, body);
    notice.append(disclosure);
  }
  const actionRow = document.createElement('div');
  actionRow.className = 'app-notice-actions';
  const actions = options.actions || [{ label: actionLabel, onAction }];
  for (const { label, onAction: runAction } of actions) {
    if (!label || typeof runAction !== 'function') continue;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = actionRow.childElementCount ? 'app-notice-action' : 'app-notice-action app-notice-primary';
    action.textContent = label;
    action.addEventListener('click', () => {
      if (appNoticeEntries.get(id)?.notice !== notice) return;
      if (dismissOnAction) clearAppNotice(id, { reason: `action:${action.textContent.trim()}` });
      runAction();
    });
    actionRow.append(action);
  }
  if (actionRow.childElementCount) notice.append(actionRow);
  if (dismissible) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'app-notice-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.title = 'Dismiss';
    dismiss.append(appNoticeSvg('dismiss', 'app-notice-dismiss-icon', '0 0 10 10'));
    dismiss.addEventListener('click', () => {
      if (appNoticeEntries.get(id)?.notice !== notice) return;
      const onDismiss = appNoticeEntries.get(id).options.onDismiss;
      clearAppNotice(id, { reason: 'user' });
      onDismiss?.();
    });
    head.append(dismiss);
  }
  notice.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  const entry = { notice, timer: null, returnFocus: previous ? previous.returnFocus : document.activeElement, options };
  const expires = kind !== 'error' && !persistent;
  let remaining = kind === 'undo' ? 10_000 : 15_000;
  if (expires) {
    notice.style.setProperty('--notice-expiry', `${remaining}ms`);
    const line = document.createElement('div');
    line.className = 'app-notice-expiry';
    line.setAttribute('aria-hidden', 'true');
    notice.append(line);
  }
  if (previous) previous.notice.replaceWith(notice);
  else container.append(notice);
  appNoticeEntries.set(id, entry);
  layoutAppNotices();
  reportAppNotice(previous ? options.mergeMembers ? 'merge' : 'replace' : 'show', options, notice);
  if (expires) {
    let started;
    let focused = false;
    let hovered = false;
    const resume = () => {
      if (focused || hovered || !notice.isConnected) return;
      delete notice.dataset.paused;
      started = Date.now();
      entry.timer = setTimeout(() => clearAppNotice(id, { reason: 'expired' }), remaining);
    };
    const pause = () => {
      notice.dataset.paused = 'true';
      if (entry.timer === null) return;
      clearTimeout(entry.timer);
      entry.timer = null;
      remaining = Math.max(0, remaining - (Date.now() - started));
    };
    notice.addEventListener('focusin', () => { focused = true; pause(); });
    notice.addEventListener('focusout', event => {
      if (notice.contains(event.relatedTarget)) return;
      focused = false;
      resume();
    });
    notice.addEventListener('mouseenter', () => { hovered = true; pause(); });
    notice.addEventListener('mouseleave', () => { hovered = false; resume(); });
    resume();
  }
  if (focusedButton) {
    const stableClass = className => className.split(' ').filter(name => name && name !== 'app-notice-primary').join(' ');
    const controls = [...notice.querySelectorAll('button, summary')].filter(control => stableClass(control.className) === stableClass(focusedButton.className));
    (controls.find(control => appNoticeControlLabel(control) === focusedButton.label) || controls[0])?.focus();
  }
  return notice;
}
