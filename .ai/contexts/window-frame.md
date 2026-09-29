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
| `window-frame.js` | `windowFrameOptions(platform)` (the `BrowserWindow` options), `applicationMenuTemplate(appName)` (the menu), `KEYBOARD_ROLES`, `STRIP_HEIGHT`. |
| `main.js` | Spreads `windowFrameOptions(process.platform)` into the `BrowserWindow`; `buildMenu()` installs the template; the `popup-app-menu` IPC opens it under the menu button. |
| `preload.js` | `window.api.popupAppMenu(x, y)`. |
| `public/window-strip.js` | Marks `<body>` with `window-frameless`, `platform-<os>` and, while full screen, `window-full-screen`; wires `#app-menu-btn`. Dual-mode: a classic `<script>`, `require()`-d by the test. |
| `public/style.css` | The "WINDOW STRIP" section: drag regions, the insets that keep content out from under the controls, the `no-drag` exemptions. |
| `test/window-frame.test.js` | Pins the menu roles, the menu installation, the frame options and the CSS contract. |

## The frame options, per platform

| Platform | Options | Controls |
|---|---|---|
| Windows | `titleBarStyle: 'hidden'`, `titleBarOverlay` | Native caption buttons drawn by Electron over the top-right corner, in the system order (minimise, maximise, close), with Snap Layouts on the maximise button. |
| Linux | `titleBarStyle: 'hidden'`, `titleBarOverlay` | Electron's `OpaqueFrameView` draws minimise, maximise, close at the top-right. The order is fixed in Electron and does not follow `org.gnome.desktop.wm.preferences button-layout`. |
| macOS | `titleBarStyle: 'hidden'`, `trafficLightPosition` | The system traffic lights, moved to sit vertically centred in the strip. |

The overlay's height is `STRIP_HEIGHT` (32 DIP) and its colour is
`--surface-chrome`, so it reads as part of the strip. Both the overlay and the
CSS take the height from one number: `--strip-height` in `style.css` must equal
`STRIP_HEIGHT`, and the test holds that.

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

## Drag regions

`-webkit-app-region: drag` is on `#sidebar-tabs`, on the collapsed sidebar
column (the only piece of the strip left when the sidebar is hidden), and on
the main-area headers listed above. Chromium subtracts `no-drag` boxes from
`drag` boxes whatever their stacking order, so an element that is not `no-drag`
inside a drag region never receives the mouse. `no-drag` is therefore set on:

- every interactive element: `button, input, select, textarea, a, [role="button"], [contenteditable]`;
- the text a user copies from a header: `#terminal-header-id`, `#jsonl-viewer-session-id`, `.viewer-toolbar-path`;
- every overlay that can open over the strip: `.new-session-popover`,
  `.terminal-context-menu`, `.new-session-overlay`, `.add-project-overlay`,
  `.jsonl-screenshot-fullscreen`, `#update-toast`, `.restore-toast`. A new
  popover, menu or dialog that can reach the top 32 pixels belongs in this list.

A clickable element that is none of these (a `div` or `span` with a click
listener) placed in a drag region needs `no-drag` of its own.

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
(`Menu.popup`, coordinates scaled by the zoom factor). macOS hides the button:
the system menu bar shows the menu there.

A synthetic key from `webContents.sendInputEvent` or CDP does not reach the
focus manager, so a menu accelerator cannot be exercised that way; the test
pins the menu instead.

## States the window can be in

`isMovable()`, `isResizable()`, `isMaximizable()`, `isMinimizable()` and
`isFullScreenable()` are all true: nothing in the options turns them off, and
the test forbids setting any of them to `false` in the window options. Leaving
full screen returns to the previous state (maximised or restored) with the
controls back, and the restored window keeps its saved bounds.

If the drag region were unreachable, the window manager's own bindings still
move and resize the window: `Super`+drag on GNOME, `Alt`+`F7`/`Alt`+`F8`, or
`Alt`+`Space` then Move/Size on Windows.
