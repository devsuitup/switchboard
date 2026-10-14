// see docs/product/BUILDING-BLOCKS.md (B8)
const appNoticeEntries = new Map();

function clearAppNotice(id) {
  const entry = appNoticeEntries.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  const restoreFocus = entry.notice.contains(document.activeElement);
  entry.notice.remove();
  appNoticeEntries.delete(id);
  if (restoreFocus && entry.returnFocus?.isConnected) entry.returnFocus.focus();
}

function showAppNotice({ id, kind = 'info', message, actionLabel, onAction }) {
  clearAppNotice(id);
  const container = document.getElementById('app-notices');
  const notice = document.createElement('div');
  if (id !== undefined) notice.dataset.noticeId = id;
  notice.className = 'app-notice';
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'app-notice-message';
  text.textContent = message;
  notice.append(text);
  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'app-notice-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      if (appNoticeEntries.get(id)?.notice !== notice) return;
      clearAppNotice(id);
      onAction();
    });
    notice.append(action);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'app-notice-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => clearAppNotice(id));
  notice.append(dismiss);
  notice.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  container.append(notice);
  const entry = { notice, timer: null, returnFocus: document.activeElement };
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
}
