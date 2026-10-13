// see docs/product/BUILDING-BLOCKS.md (B8)
const appNoticeEntries = new Map();

function clearAppNotice(id) {
  const entry = appNoticeEntries.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.notice.remove();
  appNoticeEntries.delete(id);
}

function showAppNotice({ id, kind = 'info', message, actionLabel, onAction }) {
  clearAppNotice(id);
  let container = document.getElementById('app-notices');
  if (!container) {
    container = document.createElement('div');
    container.id = 'app-notices';
    document.body.append(container);
  }
  const notice = document.createElement('div');
  notice.id = id;
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
  dismiss.addEventListener('click', () => {
    if (appNoticeEntries.get(id)?.notice === notice) clearAppNotice(id);
  });
  notice.append(dismiss);
  container.append(notice);
  const timer = kind === 'error' ? null : setTimeout(() => clearAppNotice(id), kind === 'undo' ? 10_000 : 15_000);
  appNoticeEntries.set(id, { notice, timer });
}
