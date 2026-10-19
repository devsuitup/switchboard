// see .ai/contexts/app-dialogs.md
async function appConfirm({ title = 'Confirm', message, confirmLabel = 'OK', danger = false } = {}) {
  return (await showChoiceDialog({
    title, message: appDialogMessage(message), confirmLabel, danger,
    initialFocus: danger ? 'cancel' : 'confirm',
  })) !== null;
}
async function appAlert({ title = 'Switchboard', message } = {}) {
  await showChoiceDialog({ title, message: appDialogMessage(message), confirmLabel: 'OK', cancelLabel: null });
}

async function appChoose({ title = 'Choose', message, options = [], selectedId, confirmLabel = 'Open' } = {}) {
  return showChoiceDialog({ title, message: appDialogMessage(message), options, selectedId, confirmLabel });
}

function appDialogMessage(message) {
  return typeof message === 'string' ? message.split('\n') : message;
}
