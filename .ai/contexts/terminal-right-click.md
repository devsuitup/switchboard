# Context: terminal-right-click

**Purpose**: what the right mouse button does inside a session's terminal. The
**Terminal Right-Click** setting (`terminalRightClick`, default `'menu'`) owns
it: `menu` shows Switchboard's context menu, `paste` pastes the clipboard,
`none` does nothing, `default` leaves the button to xterm and to the
application running in the terminal.

## Key files

| File | Role |
|---|---|
| `public/terminal-context-menu.js` | `setupTerminalContextMenu` (the two listeners below), the menu's items and actions. Dual-mode: a classic `<script>` in the renderer, `require()`-d by `test/terminal-context-menu.test.js`. |
| `public/terminal-manager.js` | Calls `setupTerminalContextMenu` on the container it passes to `terminal.open()`; the link handler ignores non-left buttons. |
| `public/app.js` | `window._applyTerminalRightClick` — applies the setting live. |
| `public/setting-defaults.js` | The default mode. |

## One right-click is two events, and xterm acts on both

A right-click reaches xterm as a `mousedown` and a `contextmenu`, and xterm has
a listener on its own element for each:

- **`contextmenu`** — `rightClickHandler` moves xterm's hidden textarea under
  the pointer and fills it with the selection, which on Linux surfaces as a
  stray paste.
- **`mousedown`** — when the application has turned mouse tracking on
  (`CSI ?1000h` and its siblings), xterm reports the press to the PTY as a
  mouse event (`ESC [ < 2 ; col ; row M` in SGR encoding), whatever the button.
  It also registers the document-level `mouseup` listener that reports the
  release, so a press it never sees is never released either.

Outside `default`, `setupTerminalContextMenu` takes both away from xterm: a
capture-phase `mousedown` listener stops propagation of button 2, and a
capture-phase `contextmenu` listener calls `preventDefault` and
`stopPropagation` before applying the mode. Both sit on the container, an
ancestor of every element xterm listens on, so capture phase reaches them first.
Left and middle presses are not touched: the application still gets them.

## Why the press must not reach the application

Claude Code's fullscreen TUI turns mouse tracking on, and it answers a
right-button press itself: with no selection, on Linux, Windows or WSL, it
reads the system clipboard and pastes it into the prompt (2.1.284). It skips
that only for a terminal it recognises as VS Code, or as xterm.js through
XTVERSION — and xterm.js 6.0.0 does not answer XTVERSION. A forwarded press
therefore makes `menu` open the menu **and** paste, and makes `paste` paste
twice.

The menu's own **Paste** item is not what fires: the release lands on the menu
container rather than on the item, and a right button produces `auxclick`,
never `click`.

## Consequences of stopping the press

- xterm's `mousedown` listener is also what calls `preventDefault()` and
  `focus()` on every press, before any mouse-tracking branch. Without it, the
  browser's default for a press on non-focusable content blurs xterm's
  textarea, and the keys typed after a right-click go nowhere. The guard
  therefore calls both itself; `preventDefault` on a `mousedown` does not
  suppress the `contextmenu` that follows.
- The guard acts only on a press inside xterm's own element. The container
  also holds the find bar, whose input keeps its focus on a right press.
- A right-button `mousedown` inside a terminal does not bubble to `document`,
  so a document-level bubble listener (for example the new-session popover's
  click-outside close in `public/dialogs.js`) does not see it. Capture-phase
  document listeners, such as the context menu's own click-outside close, still
  do.
- xterm's link service records the link under a `mousedown`; without it, a
  right-click cannot activate a link on release.
- `default` keeps xterm's behaviour exactly, including the forwarded press and
  whatever the application does with it.

## Tests

`test/terminal-context-menu.test.js` opens a real `@xterm/xterm` Terminal in
jsdom (with a fixed element box so xterm can measure a cell), turns mouse
tracking on through `terminal.write`, and dispatches `mousedown` on
`.xterm-screen`. It asserts on the mouse reports `onData` emits: none for a
right press in `menu`, `paste` and `none`; one in `default`; left and middle
presses still reported in `menu`.
