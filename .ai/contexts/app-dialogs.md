# Renderer confirmations and messages

Use async `appConfirm({ title, message, confirmLabel, danger })` and `appAlert({ title, message })` from `public/app-dialogs.js`. Native `confirm`, `alert`, and `prompt` (bare or on `window`) are forbidden by ESLint throughout `public/**`.

The adapter uses `showChoiceDialog`. All choice dialogs share a FIFO queue, including existing checkbox dialogs, so a busy dialog never becomes a cancellation. Confirm resolves to a boolean; an alert offers OK. Escape, the close button, and the backdrop dismiss the current dialog. Enter activates the focused button and never accepts a checkbox. Tab stays inside the dialog. Destructive confirmations focus Cancel; other dialogs focus the first action. Closing returns focus to the connected opener.

Every caller must await the decision before its side effect. The Changes and Touched discard paths are async, including close, back, row switch, toggle, and reload. The quit/reload IPC already awaits `askAboutUnsavedEdits`, acknowledges immediately, and returns the decision only after the existing Save/Discard/Cancel guard. The beforeunload veto and main-process protocol are unchanged.

Main-process Electron dialogs remain outside this renderer rule.

The quit/reload guard ACKs immediately, then waits on `appDialogsIdle()` before showing its Save/Discard/Cancel controls and recollects the current buffers. It does not hold the choice queue while saving; a foreground message can therefore be dismissed without deadlock. Each dialog owns keys originating in its overlay. The unsaved guard focuses Cancel, traps Tab, and restores its connected opener.
