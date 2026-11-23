// see .ai/contexts/app-dialogs.md
async function appConfirm({ title = 'Confirm', message, confirmLabel = 'OK', danger = false, sessions } = {}) {
  return (await showChoiceDialog({
    title, message: appDialogMessage(message), confirmLabel, danger, sessions,
    initialFocus: danger ? 'cancel' : 'confirm',
  })) !== null;
}
async function appAlert({ title = 'Switchboard', message, sessions } = {}) {
  await showChoiceDialog({ title, message: appDialogMessage(message), confirmLabel: 'OK', cancelLabel: null, sessions });
}

async function appChoose({ title = 'Choose', message, options = [], selectedId, confirmLabel = 'Open', sessions } = {}) {
  return showChoiceDialog({ title, message: appDialogMessage(message), options, selectedId, confirmLabel, sessions });
}

function appDialogMessage(message) {
  return typeof message === 'string' ? message.split('\n') : message;
}
