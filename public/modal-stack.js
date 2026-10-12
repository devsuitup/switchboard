// see .ai/contexts/app-dialogs.md
const modalStack = [];
const modalQuestions = [];
const modalIdleQuestions = [];
const modalQuestionIdleWaiters = [];
let modalQuestionActive = false;
let modalIdleTimer = null;

function hasOpenModal() {
  return modalStack.length > 0;
}

function registerModal({ overlay, cancel, enter, bodyEnter = false }) {
  const previousZIndex = overlay.style.zIndex;
  const top = modalStack[modalStack.length - 1];
  overlay.style.zIndex = String(Math.max(Number(getComputedStyle(overlay).zIndex) || 0,
    Number(top?.overlay.style.zIndex) || 0) + 1);
  const modal = { overlay, cancel, enter, bodyEnter };
  modalStack.push(modal);
  return () => {
    const index = modalStack.indexOf(modal);
    if (index !== -1) {
      modalStack.splice(index, 1);
      overlay.style.zIndex = previousZIndex;
    }
    drainModalQuestions();
  };
}

function modalControls(overlay) {
  return [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[hidden], [inert]'))
    .filter(control => {
      for (let element = control; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
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
    const controls = modalControls(modal.overlay);
    if (!controls.length) { modal.overlay.focus(); return; }
    const at = controls.indexOf(document.activeElement);
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
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

document.addEventListener('keydown', routeModalKey, true);

function enqueueModalQuestion(open, { whenIdle = false } = {}) {
  return new Promise((resolve, reject) => {
    (whenIdle ? modalIdleQuestions : modalQuestions).push({ open, resolve, reject });
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
      if (!hasOpenModal()) openModalQuestion(modalIdleQuestions.shift());
      return;
    }
    for (const resolve of modalQuestionIdleWaiters.splice(0)) resolve();
  }, 0);
}

function whenModalQuestionsIdle() {
  return new Promise(resolve => {
    modalQuestionIdleWaiters.push(resolve);
    drainModalQuestions();
  });
}
