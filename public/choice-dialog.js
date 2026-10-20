// see .ai/contexts/session-cache.md ("Archived projects")

function readRememberedChoice(rememberKey) {
  try { return localStorage.getItem(rememberKey); } catch { return null; }
}

function writeRememberedChoice(rememberKey, checked) {
  try { localStorage.setItem(rememberKey, checked ? '1' : '0'); } catch {}
}

// see .ai/contexts/app-dialogs.md
let choiceDialogReturnFocus = null;
let closeOpenChoiceDialog = null;
let choiceDialogOptionId = 0;

function showChoiceDialog(options = {}) {
  const active = document.activeElement;
  const returnFocus = options.returnFocus || (active?.closest('.choice-dialog-overlay') ? choiceDialogReturnFocus : active);
  if (options.replace && closeOpenChoiceDialog) closeOpenChoiceDialog(null);
  else if (options.replace && hasActiveModalQuestion()) {
    choiceDialogReturnFocus = returnFocus;
    return openChoiceDialog({ ...options, returnFocus });
  }
  return enqueueModalQuestion(() => {
    const restore = options.replace && returnFocus && returnFocus.isConnected === false ? document.activeElement : returnFocus;
    choiceDialogReturnFocus = restore;
    return openChoiceDialog({ ...options, returnFocus: restore });
  }, { front: !!options.replace, settleWith: options.closeWith || null });
}

function openChoiceDialog({
  title,
  message,
  choices = [],
  options = null,
  selectedId,
  confirmLabel,
  cancelLabel = 'Cancel',
  initialFocus = 'confirm',
  danger = false,
  returnFocus,
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
    const radios = [];
    if (options) {
      const group = document.createElement('div');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', heading.id);
      const selected = options.find(option => option.id === selectedId && !option.disabled) || options.find(option => !option.disabled);
      for (const option of options) {
        const row = document.createElement('div');
        row.className = 'choice-dialog-choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.id = `choice-dialog-option-${++choiceDialogOptionId}`;
        radio.name = 'choice-dialog-option';
        radio.dataset.choiceId = option.id;
        radio.disabled = !!option.disabled;
        radio.checked = option === selected;
        const text = document.createElement('span');
        const label = document.createElement('label');
        label.htmlFor = radio.id;
        label.textContent = option.label;
        text.appendChild(label);
        const description = [option.detail, option.disabled && option.disabledReason].filter(Boolean).join(' · ');
        if (description) {
          const detail = document.createElement('span');
          detail.id = `${radio.id}-detail`;
          detail.className = 'choice-dialog-detail';
          detail.textContent = description;
          radio.setAttribute('aria-describedby', detail.id);
          text.appendChild(detail);
        }
        row.append(radio, text);
        row.addEventListener('click', (event) => {
          if (!radio.disabled && event.target !== radio && !label.contains(event.target)) radio.click();
        });
        group.appendChild(row);
        radios.push({ option, radio });
      }
      body.appendChild(group);
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
      text.textContent = typeof choice.label === 'function' ? choice.label(box.checked) : choice.label;
      label.append(box, text);
      body.appendChild(label);
      boxes.push({ choice, box, text });
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
    let isDanger;
    function updateChoices() {
      const values = Object.fromEntries(boxes.map(({ choice, box }) => [choice.id, box.checked]));
      isDanger = typeof danger === 'function' ? danger(values) : danger;
      confirmBtn.className = (isDanger ? 'delete-worktree-confirm-btn' : 'new-session-start-btn') + ' choice-dialog-confirm';
      for (const { choice, box, text } of boxes) {
        if (typeof choice.label === 'function') text.textContent = choice.label(box.checked);
      }
    }
    for (const { box } of boxes) box.addEventListener('change', updateChoices);
    updateChoices();
    confirmBtn.textContent = confirmLabel || 'OK';
    confirmBtn.disabled = !!options && !radios.some(({ radio }) => radio.checked && !radio.disabled);
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
      unregister();
      if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
      resolve(value);
    }

    function accept() {
      const selected = radios.find(({ radio }) => radio.checked && !radio.disabled);
      if (options && !selected) return;
      const result = {};
      if (selected) result.choice = selected.option.id;
      for (const { choice, box } of boxes) {
        result[choice.id] = box.checked;
        if (choice.rememberKey) writeRememberedChoice(choice.rememberKey, box.checked);
      }
      close(result);
    }

    function enter(event) {
      if (buttons.includes(event.target)) event.target.click();
      else if (!isDanger && !event.target.matches('input[type="checkbox"]')) accept();
      return true;
    }

    closeBtn.addEventListener('click', () => close(null));
    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', accept);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });

    document.body.appendChild(overlay);
    const unregister = registerModal({ overlay, cancel: () => close(null), enter, restoreFocus: false });
    closeOpenChoiceDialog = close;
    if (closeWith) closeWith.then(close, () => {});
    (initialFocus === 'cancel' ? cancelBtn : confirmBtn).focus();
  });
}
