// see .ai/contexts/app-dialogs.md
async function appConfirm({ title = 'Confirm', message, confirmLabel = 'OK', danger = false, sessions, messageParts, titleParts } = {}) {
  return (await showChoiceDialog({
    title, message: appDialogMessage(message), confirmLabel, danger, sessions, messageParts, titleParts,
    initialFocus: danger ? 'cancel' : 'confirm',
  })) !== null;
}
async function appAlert({ title = 'Switchboard', message, sessions, messageParts, titleParts } = {}) {
  await showChoiceDialog({ title, message: appDialogMessage(message), confirmLabel: 'OK', cancelLabel: null, sessions, messageParts, titleParts });
}

async function appChoose({ title = 'Choose', message, options = [], selectedId, confirmLabel = 'Open', sessions, messageParts, titleParts } = {}) {
  return showChoiceDialog({ title, message: appDialogMessage(message), options, selectedId, confirmLabel, sessions, messageParts, titleParts });
}

function appDialogMessage(message) {
  return typeof message === 'string' ? message.split('\n') : message;
}
