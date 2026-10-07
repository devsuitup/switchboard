# Context: window-frame

**Purpose**: the window has no system title bar and no Electron menu bar. Its
first row is a strip the app draws: the sidebar's row of tabs, which carries the
menu button, the tabs, the drag region, and, on Windows and Linux, the window
controls drawn over the top-right corner. The top header of whatever the main
area shows (terminal, grid, settings, stats, transcript, file viewers) extends
the same strip across the rest of the window.

## Key files

| File | Role |
|---|---|
| `window-frame.js` | `windowFrameOptions(platform)` (the `BrowserWindow` options), `applicationMenuTemplate(appName, { onWhatsNew })` (the menu; Help → What's new calls `onWhatsNew`, see `docs/changelog.md`), `KEYBOARD_ROLES`, `STRIP_HEIGHT`, `zoomKey()` and `nextZoomLevel()` (the zoom keys), `menuPopupPoint()` (where the menu button pops the menu up). |
| `main.js` | Spreads `windowFrameOptions(process.platform)` into the `BrowserWindow`; `buildMenu()` installs the template; the `popup-app-menu` IPC opens it under the menu button. |
| `preload.js` | `window.api.popupAppMenu(x, y)`. |
| `public/window-strip.js` | Marks `<body>` with `window-frameless`, `platform-<os>` and, while full screen, `window-full-screen`; wires `#app-menu-btn`. Dual-mode: a classic `<script>`, `require()`-d by the test. |
| `public/style.css` | The "WINDOW STRIP" section: drag regions, the insets that keep content out from under the controls, the `no-drag` exemptions. |
| `test/window-frame.test.js` | Pins the menu roles, the menu installation, the frame options and the CSS contract. |
| `public/header-controls.js` | `HEADER_CONTROLS` (the session header's row, in order), `placeHeaderControl()`, `createHeaderToggle()`, `setHeaderToggle()`. Dual-mode, `require()`-d by `test/header-controls.test.js`. |

## The frame options, per platform

| Platform | Options | Controls |
|---|---|---|
| Windows | `titleBarStyle: 'hidden'`, `titleBarOverlay` | Native caption buttons drawn by Electron over the top-right corner, in the system order (minimise, maximise, close), with Snap Layouts on the maximise button. |
| Linux | `titleBarStyle: 'hidden'`, `titleBarOverlay` | Electron's `OpaqueFrameView` draws minimise, maximise, close at the top-right. The order is fixed in Electron and does not follow `org.gnome.desktop.wm.preferences button-layout`. |
| macOS | `titleBarStyle: 'hidden'`, `trafficLightPosition` | The system traffic lights, moved to sit vertically centred in the strip. |

The overlay's height is `STRIP_HEIGHT` (32 DIP) and its colour is
`--surface-chrome`, so it reads as part of the strip. `--strip-height` in
`style.css` equals `STRIP_HEIGHT`, and the test holds that. The two units
differ under zoom: the overlay stays 32 DIP, while 32 CSS px shrink below
100 %. The strip and the headers therefore take
`--strip-min-height: max(var(--strip-height), env(titlebar-area-height, 0px))`.
`env(titlebar-area-height)` is the overlay's height in CSS px, so it grows as
the zoom shrinks (measured on Linux, Electron 41: 46.98 CSS px at factor 0.69,
39 at 0.83, 32 at 1, 23 at 1.44), and the strip is never shorter than the
controls. Above 100 % the strip keeps its 32 CSS px and is taller than the
controls. On macOS and in full screen the variable is undefined and the strip is
`--strip-height`.

## Keeping content out from under the controls

The controls cover the window's top-right corner. The renderer learns their
size through the Window Controls Overlay CSS environment variables:

```css
--strip-inset-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
```

The variables are in CSS pixels, so the inset follows the zoom level. They
are undefined on macOS and when the window is full screen (the overlay hides
its buttons then), and the fallback makes the inset 0. Every header that can be
the top row of the main area gets `padding-right: calc(16px + var(--strip-inset-right))`.
A new view whose first row reaches the top of `#main` must be added to that
selector list, or its right-hand buttons will sit under the controls.

On macOS the traffic lights cover the top-left corner instead:
`--strip-inset-left` is 72px there, the sidebar strip is padded by it, and, when
the sidebar is collapsed to its 42px column, the main headers take the
remainder and the expand button moves below the strip. `window-full-screen`
resets both insets, because the traffic lights leave with the title bar.

A `.terminal-container` starts at the top of `#terminals`, never above it (its top padding is 3px, the gap the old `-5px` inset left): a negative top inset would put the container under the controls below 100 % zoom, where the header is only as tall as the overlay. The grid card keeps its own `top: -5px`, which sits under no window control.

## Drag regions

`-webkit-app-region: drag` is on `#sidebar-tabs`, on the collapsed sidebar
column (the only piece of the strip left when the sidebar is hidden), and on
the main-area headers listed above. Chromium subtracts `no-drag` boxes from
`drag` boxes whatever their stacking order, so an element that is not `no-drag`
inside a drag region never receives the mouse. `no-drag` is therefore set on:

- every interactive element: `button, input, select, textarea, a, [role="button"], [contenteditable]`;
- the text a user copies from a header, or whose `title` tooltip must show (the
  renderer gets no hover inside a drag region): `#terminal-header-id`,
  every session-header control (`#terminal-header-controls [data-header-kind]`),
  `#jsonl-viewer-session-id`, `.viewer-toolbar-path`;
- every overlay that can open over the strip: `.new-session-popover`,
  `.terminal-context-menu`, `.new-session-overlay`, `.add-project-overlay`, `.whats-new-overlay`,
  `.jsonl-screenshot-fullscreen`, `#update-toast`, `.restore-toast`. A new
  popover, menu or dialog that can reach the top 32 pixels belongs in this list.

A clickable element that is none of these (a `div` or `span` with a click
listener) placed in a drag region needs `no-drag` of its own.

## The session header's controls

The right-hand side of `#terminal-header` is one row, `#terminal-header-controls`,
whose order is declared once in `HEADER_CONTROLS` (`public/header-controls.js`)
and pinned by `test/header-controls.test.js`:

| Kind | Controls, left to right | Look |
|---|---|---|
| `indicator` | `#terminal-header-sandbox`, `#ide-emulation-indicator` | A coloured dot and a word. No border, no background, no hover, `cursor: default`. The tooltip is the only interaction. |
| `toggle` | `#panel-terminal-toggle-btn` (Shell), `#changes-toggle-btn` (Changes) | `.icon-btn`: the sidebar filter row's square outlined button (`#running-toggle` and its siblings share the rule), a 14 px icon, the name in `title` and `aria-label`, and the filter buttons' accent `.active` state with `aria-pressed`. |
| `action` | `#terminal-refresh-btn`, `#terminal-stop-btn` | Refresh is a neutral borderless icon; Stop is red and last, set apart by a gap three times the row's and a hairline divider in it. The divider is a `::before` with `pointer-events: none`, so the gap never counts as a click on Stop. |

Each element carries its kind as `data-header-kind`. The static ones (sandbox,
Refresh, Stop) are written in `index.html` in the declared order. The modules
that build the others (`addMcpToggle` and `addChangesToggle` in `file-panel.js`,
`addPanelTerminalToggle` in `panel-terminal.js`) hand their element to
`placeHeaderControl()`, which inserts it before the next declared control
already in the row, so the order does not depend on which module starts
first. `createHeaderToggle()` builds a toggle and `setHeaderToggle()` sets its
on state. A new control is added to `HEADER_CONTROLS` first: `placeHeaderControl`
throws for an id the list does not declare.

The Changes toggle is on while the panel shows the Changes tab of the session
in the header: `renderTabContent` sets it from the tab it renders, and
`hidePanel` clears it when the panel closes.

The session process's state is not in that row: `#terminal-header-status` is
an 8 px dot right before `#terminal-header-name`, with no text, green with a
glow while running and grey otherwise. `#terminal-header-info` clips its
children (the name's ellipsis), so the dot's 6 px margin on the left, top and
bottom is the room its 6 px glow needs. It is in the no-drag list so its
tooltip shows.

`updateTerminalHeader` (`app.js`) puts the state in words in the dot's `title`
and `aria-label` (`role="img"`), through `terminalStatusLabel()` in
`public/process-exit.js`:

- `Running` while the poll reports the process;
- `Stopped` when the process ended after the user asked for a Stop (the Stop
  itself sends SIGHUP, so it would otherwise read as killed);
- `Killed (SIGKILL)` when a signal ended the process with no Stop asked for;
- `Exited (code N)` when it exited on its own;
- `Stopped` when no exit is known.

`process-exited` carries the exit code, the signal's name and whether a Stop
was asked for: main turns node-pty's signal number into a name with
`ptyExitSignalName()` (`pty-ops.js`), and the `stop-session` and
`remote-stop-session` handlers set `session.stopRequested` before they signal
the process. `openSession` forgets the previous exit before it awaits
`openTerminal`'s answer, so an exit that arrives while the relaunch is still
opening (a pre-launch command that fails at once) is kept.
The renderer records the last exit per session (`noteSessionExit`) and forgets
it when the poll sees the process running again, before `openSession`
relaunches the session, and in `destroySession`, so a relaunch never shows the
exit of the process before it. The session's and the panel shell's exit banners
use the same wording (`exitBannerPhrase`): `session stopped`,
`session killed (SIGKILL)`, `shell exited (code 1)`, dim for a Stop or an exit
with 0 and yellow otherwise.

The header's vertical padding is 2 px around the 26 px buttons, so its content
(31 px with the border) stays under `--strip-min-height` and the header is
exactly as tall as the sidebar's strip. `test/header-controls.test.js` pins
that arithmetic.

The terminal container starts at the header's bottom, so the header's height
decides how many rows fit. When the file panel opens or closes,
`refitActiveTerminal` (`file-panel.js`) refits the session terminal with
`safeFit`, the same clamped fit the container's ResizeObserver applies (see
`clampRowsToContentBox` in `terminal-manager.js`). A raw `FitAddon.fit()` there
counts the container's vertical padding as drawable space: whenever the
container's height modulo the cell height is under that padding, the terminal
is resized to N+1 rows, then back to N by the observer, and a resize while the
panel shell's WebGL context comes up leaves the session terminal painted blank
until its next refresh.

## What the platform does with the drag region

A drag region is a caption area (`HTCAPTION`) to the window manager, so the
behaviours a title bar gives come with it:

- **Double-click** maximises and restores. On Linux, Chromium applies the
  desktop's own setting (`action-double-click-titlebar`); on Windows and
  macOS it is the system's caption behaviour. There is no renderer handler: the
  renderer does not receive mouse events inside a drag region.
- **Right-click** opens the system window menu on Windows and on Linux
  (Chromium asks the compositor for it). `Alt`+`Space` is handled by Windows
  itself and, on GNOME, by the shell's `activate-window-menu` binding.
- **Resizing** from the edges: on Linux the frame view keeps a resize border
  around the window (Wayland reports it in `outerWidth`/`outerHeight`: a
  restored window measures 44 pixels larger than its content, 22 per side);
  Windows keeps its native resize frame; macOS is unchanged.

## The menu and its accelerators

The menu stays installed as the application menu (`Menu.setApplicationMenu`)
even though no platform but macOS draws it. Electron registers a menu's
accelerators with the window's focus manager in `RootView::SetMenu` before it
checks whether the window has a frame, and a frameless window simply gets no
menu bar. `setApplicationMenu(null)`, `win.setMenu(null)` or `win.removeMenu()`
would unregister every accelerator: Undo, Redo, Select All, the three zoom
levels, DevTools and Full Screen. Cut, Copy and Paste are registered with
`registerAccelerator: false` by Electron and handled by the web contents
itself, so they do not depend on the menu, but they stay in it for the menu
button.

`#app-menu-btn` opens the same menu as a popup under itself
(`Menu.popup`, coordinates scaled by the zoom factor; `menuPopupPoint()`
replaces a non-finite coordinate with 0). macOS hides the button:
the system menu bar shows the menu there.

On Windows and Linux the menu has no keyboard route: `Alt` and `F10` do not
open it, and the ☰ button opens it only when it is focused and activated. `F10`
is a terminal key (htop and mc quit on it), and a bare `Alt` tap would need
press/release tracking that `Alt`+`Tab`, `Alt`+drag and focus loss can
mistrigger, so neither is bound.

A synthetic key from `webContents.sendInputEvent` or CDP does not reach the
focus manager, so a menu accelerator cannot be exercised that way; the test
pins the menu instead.

## Zoom keys

The zoom roles' accelerators (`CommandOrControl+Plus`, `CommandOrControl+-`,
`CommandOrControl+0`) are bound to the US key positions: on an AZERTY layout
`-` and `0` are on other keys (`0` needs Shift), and the numeric keypad is never
bound. So main also reads the zoom keys itself, in the `before-input-event`
handler, through `zoomKey()` in `window-frame.js`: the character the key
produced (`+`, `=`, `-`, `0`), the physical `Digit0` key, or the keypad's
`NumpadAdd`, `NumpadSubtract` and `Numpad0`, with Ctrl (Cmd on macOS) held and
Alt not. A match is applied in steps of 0.5, as the roles do, and the event is
prevented, so neither the menu accelerator nor the terminal also receives it.
`Digit0` counts only without Shift: on AZERTY `Ctrl`+`Shift`+`à` produces `0`
and matches by its character, while on a US layout `Ctrl`+`Shift`+`0` produces
`)` and reaches the terminal as before.

The zoom roles themselves do not clamp (`webContents.zoomLevel += 0.5` in
Electron 41), and `setZoomLevel` stores any level. Blink clamps only the
applied factor, to [0.25, 5] (measured: level 10 stores 10 and renders at
factor 5; level −10 renders at 0.25), so a stored level past that range makes
the next presses in the other direction do nothing visible. `nextZoomLevel()`
clamps the level to [−7.5, 8.5], the half-level steps inside Blink's range
(factors 0.25 and 4.71).
The roles stay in the menu for the menu button.

## States the window can be in

`isMovable()`, `isResizable()`, `isMaximizable()`, `isMinimizable()` and
`isFullScreenable()` are all true: nothing in the options turns them off, and
the test forbids setting any of them to `false` in the window options. Leaving
full screen returns to the previous state (maximised or restored) with the
controls back, and the restored window keeps its saved bounds.

If the drag region were unreachable, the window manager's own bindings still
move and resize the window: `Super`+drag on GNOME, `Alt`+`F7`/`Alt`+`F8`, or
`Alt`+`Space` then Move/Size on Windows.
