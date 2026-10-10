// see .ai/contexts/session-cache.md ("Archived projects")

function readRememberedChoice(rememberKey) {
  try { return localStorage.getItem(rememberKey); } catch { return null; }
}

function writeRememberedChoice(rememberKey, checked) {
  try { localStorage.setItem(rememberKey, checked ? '1' : '0'); } catch {}
}

let closeOpenChoiceDialog = null;

/**
 * A modal with optional checkboxes. Resolves to `{ [choice.id]: boolean }` on
 * confirm, null on cancel, and null at once while another one is open, unless
 * `replace` cancels the open one and shows this one. `closeWith`, a promise,
 * closes the dialog with the value it resolves to.
 */
function showChoiceDialog({
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
  if (document.querySelector('.choice-dialog-overlay')) {
    if (!replace || !closeOpenChoiceDialog) return Promise.resolve(null);
    closeOpenChoiceDialog(null);
    if (returnFocus && returnFocus.isConnected === false) returnFocus = document.activeElement;
  }

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
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
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
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...dialog.querySelectorAll('button, input')];
        const at = controls.indexOf(document.activeElement);
        const step = event.shiftKey ? -1 : 1;
        const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0) : (at + step + controls.length) % controls.length;
        controls[next].focus();
      } else if (event.key === 'Enter') {
        if (!overlay.contains(event.target)) return;
        event.preventDefault();
        if (buttons.includes(event.target)) event.target.click();
        else if (!(event.target.matches && event.target.matches('input[type="checkbox"]'))) accept();
      }
    }

    closeBtn.addEventListener('click', () => close(null));
    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', accept);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });

    document.body.appendChild(overlay);
    closeOpenChoiceDialog = close;
    if (closeWith) closeWith.then(close, () => {});
    document.addEventListener('keydown', onKey, true);
    (initialFocus === 'cancel' ? cancelBtn : confirmBtn).focus();
  });
}
