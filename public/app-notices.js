// see docs/product/BUILDING-BLOCKS.md (B8)
const appNoticeEntries = new Map();

window.showProjectArchiveUndo = function (entry, name) {
  const id = `archive-project:${entry}`;
  showAppNotice({
    id, kind: 'undo', message: `Project "${name}" archived. Its settings and cached sessions are kept; schedules resume on unarchive.`,
    actionLabel: 'Undo',
    onAction: async () => {
      try {
        const result = await window.api.unarchiveProject(entry);
        if (!result?.ok) throw new Error(result?.error || 'The backend returned no result');
        await Promise.resolve(loadProjects()).catch(error => { if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error); });
      } catch (error) {
        showAppNotice({ id, kind: 'error', message: `Could not unarchive project "${name}": ${error.message}` });
      }
    },
  });
};

function sessionActionNoticeId(operation, session) {
  return `${operation}:${session?.remoteAlias || 'local'}:${session?.sessionId || session?.projectPath || 'unknown'}`;
}

function sessionActionDescription(session) {
  const rawName = session?.name || session?.aiTitle || session?.summary;
  const name = typeof cleanDisplayName === 'function' ? cleanDisplayName(rawName) : rawName;
  const identity = name ? `"${name}"${session?.sessionId ? ` (${session.sessionId})` : ''}`
    : session?.sessionId ? `"${session.sessionId}"` : 'folder';
  const location = [session?.remoteAlias && remoteHostLabel(session.remoteAlias), session?.projectPath || session?.cwd].filter(Boolean).join(':') || 'location unavailable';
  return `${identity} at ${location}`;
}

function showSessionActionFailure(operation, session, error, recovery, onRetry, { headline = `${operation} failed`, kind = 'error' } = {}) {
  const reason = error?.message || error || 'The backend is unavailable or returned no result';
  showAppNotice({
    id: sessionActionNoticeId(operation, session), kind,
    message: `${headline} for ${sessionActionDescription(session)}: ${reason}.${recovery ? ' ' + recovery : ''}`,
    actionLabel: onRetry ? 'Retry' : undefined, onAction: onRetry, dismissOnAction: false,
  });
}

function clearAppNotice(id, { membersOnly = false, exceptGroup } = {}) {
  const entry = appNoticeEntries.get(id);
  if (entry && !membersOnly) {
    clearTimeout(entry.timer);
    const restoreFocus = entry.notice.contains(document.activeElement);
    entry.notice.remove();
    appNoticeEntries.delete(id);
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

function showAppNotice(options) {
  const previous = appNoticeEntries.get(options.id);
  if (options.mergeMembers) {
    options = { ...options, members: [...new Map([...(previous?.options.members || []), ...options.members].map(member => [member.id, member])).values()] };
  }
  const { id, kind = 'info', message, members, actionLabel, onAction, dismissOnAction = true, dismissible = true } = options;
  clearTimeout(previous?.timer);
  const focusedButton = previous?.notice.contains(document.activeElement) ? document.activeElement.className : null;
  const container = document.getElementById('app-notices');
  const notice = document.createElement('div');
  if (id !== undefined) notice.dataset.noticeId = id;
  notice.className = 'app-notice';
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'app-notice-message';
  text.textContent = typeof message === 'function' ? message(members) : message;
  notice.append(text);
  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'app-notice-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      if (appNoticeEntries.get(id)?.notice !== notice) return;
      if (dismissOnAction) clearAppNotice(id);
      onAction();
    });
    notice.append(action);
  }
  if (dismissible) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'app-notice-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => clearAppNotice(id));
    notice.append(dismiss);
  }
  notice.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  const entry = { notice, timer: null, returnFocus: previous ? previous.returnFocus : document.activeElement, options };
  if (previous) previous.notice.replaceWith(notice);
  else container.append(notice);
  appNoticeEntries.set(id, entry);
  if (kind !== 'error') {
    let remaining = kind === 'undo' ? 10_000 : 15_000;
    let started;
    let focused = false;
    let hovered = false;
    const resume = () => {
      if (focused || hovered || !notice.isConnected) return;
      started = Date.now();
      entry.timer = setTimeout(() => clearAppNotice(id), remaining);
    };
    const pause = () => {
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
  if (focusedButton) [...notice.querySelectorAll('button')].find(button => button.className === focusedButton)?.focus();
}
