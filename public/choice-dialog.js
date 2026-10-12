// see .ai/contexts/session-cache.md ("Archived projects")

function readRememberedChoice(rememberKey) {
  try { return localStorage.getItem(rememberKey); } catch { return null; }
}

function writeRememberedChoice(rememberKey, checked) {
  try { localStorage.setItem(rememberKey, checked ? '1' : '0'); } catch {}
}

// see .ai/contexts/app-dialogs.md
const choiceDialogQueue = [];
const choiceDialogIdleWaiters = [];
let choiceDialogActive = false;
let choiceDialogReturnFocus = null;
let closeOpenChoiceDialog = null;

function showChoiceDialog(options = {}) {
  const active = document.activeElement;
  const returnFocus = options.returnFocus || (active?.closest('.choice-dialog-overlay') ? choiceDialogReturnFocus : active);
  return new Promise((resolve) => {
    const entry = { options: { ...options, returnFocus }, resolve };
    if (options.replace && closeOpenChoiceDialog) {
      choiceDialogQueue.unshift(entry);
      closeOpenChoiceDialog(null);
    } else choiceDialogQueue.push(entry);
    drainChoiceDialogs();
  });
}

function whenChoiceDialogsIdle() {
  if (!choiceDialogActive && !choiceDialogQueue.length) return Promise.resolve();
  return new Promise(resolve => choiceDialogIdleWaiters.push(resolve));
}

function drainChoiceDialogs() {
  if (choiceDialogActive) return;
  if (!choiceDialogQueue.length) {
    for (const resolve of choiceDialogIdleWaiters.splice(0)) resolve();
    return;
  }
  choiceDialogActive = true;
  const { options, resolve } = choiceDialogQueue.shift();
  if (options.replace && options.returnFocus && options.returnFocus.isConnected === false) options.returnFocus = document.activeElement;
  choiceDialogReturnFocus = options.returnFocus;
  openChoiceDialog(options).then((value) => {
    choiceDialogActive = false;
    resolve(value);
    drainChoiceDialogs();
  });
}

function openChoiceDialog({
  title,
  message,
  choices = [],
  confirmLabel,
  cancelLabel = 'Cancel',
  initialFocus = 'confirm',
  danger = false,
  returnFocus,
  replace = false,
  closeWith = null,
} = {}) {


  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay choice-dialog-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog choice-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'choice-dialog-title');
    dialog.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'whats-new-header';
    const heading = document.createElement('h2');
    heading.id = 'choice-dialog-title';
    heading.textContent = title || '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'icon-btn choice-dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    header.append(heading, closeBtn);

    const body = document.createElement('div');
    body.className = 'whats-new-body choice-dialog-body';
    const lines = Array.isArray(message) ? message : (message ? [message] : []);
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    const boxes = [];
    for (const choice of choices) {
      const label = document.createElement('label');
      label.className = 'choice-dialog-choice';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.choiceId = choice.id;
      const stored = choice.rememberKey ? readRememberedChoice(choice.rememberKey) : null;
      box.checked = stored === '1' ? true : stored === '0' ? false : !!choice.checked;
      const text = document.createElement('span');
      text.textContent = choice.label;
      label.append(box, text);
      body.appendChild(label);
      boxes.push({ choice, box });
    }

    const actions = document.createElement('div');
    actions.className = 'new-session-actions choice-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'new-session-cancel-btn choice-dialog-cancel';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.hidden = cancelLabel === null;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = (danger ? 'delete-worktree-confirm-btn' : 'new-session-start-btn') + ' choice-dialog-confirm';
    confirmBtn.textContent = confirmLabel || 'OK';
    actions.append(cancelBtn, confirmBtn);

    dialog.append(header, body, actions);
    overlay.appendChild(dialog);

    const buttons = [closeBtn, cancelBtn, confirmBtn];

    let closed = false;
    function close(value) {
      if (closed) return;
      closed = true;
      if (closeOpenChoiceDialog === close) closeOpenChoiceDialog = null;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
      resolve(value);
    }

    function accept() {
      const result = {};
      for (const { choice, box } of boxes) {
        result[choice.id] = box.checked;
        if (choice.rememberKey) writeRememberedChoice(choice.rememberKey, box.checked);
      }
      close(result);
    }

    function onKey(event) {
      const overlays = document.querySelectorAll('.choice-dialog-overlay');
      if (overlays[overlays.length - 1] !== overlay) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.querySelectorAll('button, input')].filter(control => !control.hidden);
        const at = controls.indexOf(document.activeElement);
        const step = event.shiftKey ? -1 : 1;
        const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0) : (at + step + controls.length) % controls.length;
        controls[next].focus();
      } else if (event.key === 'Enter') {
        if (!overlay.contains(event.target)) return;
        event.preventDefault();
        if (buttons.includes(event.target)) event.target.click();
        else if (!danger && !(event.target.matches && event.target.matches('input[type="checkbox"]'))) accept();
      }
    }

    closeBtn.addEventListener('click', () => close(null));
    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', accept);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    closeOpenChoiceDialog = close;
    if (closeWith) closeWith.then(close, () => {});
    (initialFocus === 'cancel' ? cancelBtn : confirmBtn).focus();
  });
}
