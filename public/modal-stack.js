// see .ai/contexts/app-dialogs.md
const modalStack = [];
const modalQuestions = [];
const modalIdleQuestions = [];
let modalQuestionActive = false;
let modalIdleTimer = null;

function hasOpenModal() {
  return modalStack.length > 0;
}

function focusModal(modal) {
  const focused = modal.lastFocused;
  const target = focused?.isConnected && modal.overlay.contains(focused) && !focused.matches(':disabled')
    ? focused : modal.overlay.querySelector('[role="dialog"], .modal-dialog, .new-session-dialog') || modal.overlay;
  if (target !== focused) target.tabIndex = -1;
  target.focus();
}

function registerModal({ overlay, cancel, enter, bodyEnter = false, restoreFocus = true }) {
  const opener = document.activeElement;
  const previousZIndex = overlay.style.zIndex;
  const top = modalStack[modalStack.length - 1];
  overlay.style.zIndex = String(Math.max(Number(getComputedStyle(overlay).zIndex) || 0,
    Number(top?.overlay.style.zIndex) || 0) + 1);
  const modal = { overlay, cancel, enter, bodyEnter, lastFocused: overlay.contains(opener) ? opener : null };
  modalStack.push(modal);
  if (!overlay.contains(opener)) focusModal(modal);
  return () => {
    const index = modalStack.indexOf(modal);
    if (index === -1) return;
    modalStack.splice(index, 1);
    overlay.style.zIndex = previousZIndex;
    const remaining = modalStack[modalStack.length - 1];
    if (remaining && restoreFocus) {
      if (!remaining.overlay.contains(document.activeElement)) focusModal(remaining);
    } else if (!remaining && restoreFocus) {
      let restored = false;
      if (opener?.isConnected && opener !== document.body && opener !== document.documentElement && !opener.matches(':disabled')) {
        opener.focus();
        restored = document.activeElement === opener;
      }
      if (!restored && typeof activeSessionId !== 'undefined' && typeof openSessions !== 'undefined') {
        const entry = activeSessionId && openSessions.get(activeSessionId);
        if (entry && !entry.closed) entry.terminal.focus();
      }
    }
    drainModalQuestions();
  };
}

function modalControls(overlay, backward = false) {
  return [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[hidden], [inert]'))
    .filter(control => {
      for (let element = control; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
    })
    .filter((control, _, controls) => {
      if (!control.matches('input[type="radio"]') || !control.name) return true;
      const group = controls.filter(other => other.matches('input[type="radio"]') && other.name === control.name && other.form === control.form);
      return control === (group.find(radio => radio.checked) || (backward ? group[group.length - 1] : group[0]));
    });
}

function routeModalKey(event) {
  const modal = modalStack[modalStack.length - 1];
  if (!modal) return;
  const inside = modal.overlay.contains(event.target);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    modal.cancel();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const controls = modalControls(modal.overlay, event.shiftKey);
    if (!controls.length) { modal.overlay.focus(); return; }
    const active = document.activeElement;
    let at = controls.indexOf(active);
    if (at === -1 && active?.matches?.('input[type="radio"]') && active.name) {
      at = controls.findIndex(control => control.matches('input[type="radio"]') && control.name === active.name && control.form === active.form);
    }
    const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0)
      : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next].focus();
  } else if (event.key === 'Enter') {
    event.stopImmediatePropagation();
    if (event.defaultPrevented) return;
    if (!inside && !(modal.bodyEnter && event.target === document.body)) { event.preventDefault(); return; }
    if (modal.enter?.(event)) event.preventDefault();
    else if (event.target.matches?.('button:not(:disabled)')) {
      event.preventDefault();
      event.target.click();
    }
  } else if (!inside) {
    if (typeof matchShortcut === 'function' && typeof SHORTCUT_DEFS !== 'undefined' &&
        [...SHORTCUT_DEFS.map(def => def.id), ...Object.keys(typeof FIXED_SHORTCUTS === 'undefined' ? {} : FIXED_SHORTCUTS)]
          .some(id => matchShortcut(id, event, typeof isMac === 'undefined' ? false : isMac,
            typeof appShortcuts === 'undefined' ? {} : appShortcuts))) event.preventDefault();
    event.stopImmediatePropagation();
  }
}

document.addEventListener('keydown', routeModalKey, true);
document.addEventListener('focusin', event => {
  const modal = modalStack[modalStack.length - 1];
  if (!modal) return;
  if (modal.overlay.contains(event.target)) modal.lastFocused = event.target;
  else focusModal(modal);
}, true);

for (const type of ['paste', 'beforeinput', 'input']) {
  document.addEventListener(type, event => {
    if (!hasOpenModal() || !event.target.matches?.('.xterm-helper-textarea')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function hasActiveModalQuestion() {
  return modalQuestionActive;
}

function enqueueModalQuestion(open, { whenIdle = false, front = false, settleWith = null } = {}) {
  return new Promise((resolve, reject) => {
    const queue = whenIdle ? modalIdleQuestions : modalQuestions;
    const question = { open, resolve, reject };
    queue[front ? 'unshift' : 'push'](question);
    if (settleWith) {
      settleWith.then((value) => {
        const index = queue.indexOf(question);
        if (index === -1) return;
        queue.splice(index, 1);
        resolve(value);
      }, () => {});
    }
    drainModalQuestions();
  });
}

function openModalQuestion(question) {
  modalQuestionActive = true;
  let result;
  try { result = question.open(); } catch (error) { result = Promise.reject(error); }
  Promise.resolve(result).then(value => finish(null, value), error => finish(error));
  function finish(error, value) {
    modalQuestionActive = false;
    if (error) question.reject(error);
    else question.resolve(value);
    drainModalQuestions();
  }
}

function drainModalQuestions() {
  if (modalQuestionActive) return;
  if (modalQuestions.length) {
    openModalQuestion(modalQuestions.shift());
    return;
  }
  if (modalIdleTimer !== null) return;
  modalIdleTimer = setTimeout(() => {
    modalIdleTimer = null;
    if (modalQuestionActive || modalQuestions.length) { drainModalQuestions(); return; }
    if (modalIdleQuestions.length) {
      openModalQuestion(modalIdleQuestions.shift());
    }
  }, 0);
}
