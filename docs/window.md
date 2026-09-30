# Window

## The strip

The window has no system title bar and no menu bar. Its first row is a strip
drawn by the app: the sidebar's row of tabs on the left, continued across the
window by the top header of whatever the main area shows (terminal, grid,
settings, stats, a viewer).

- **Window controls.** On Windows and Linux, minimise, maximise and close are
  drawn by Electron over the top-right corner. On macOS the traffic lights sit
  at the top left, centred in the strip.
- **Moving the window.** Drag any empty part of the strip. Double-click it to
  maximise or restore. On Windows and Linux, right-click it for the system's
  window menu.

## The menu

On Windows and Linux, **☰** at the left of the strip opens the application
menu under the button. On macOS the same menu is in the system menu bar and
**☰** is hidden.

| Menu | Items |
|---|---|
| Switchboard | About, Hide, Hide Others, Unhide, Quit |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All |
| View | Toggle Developer Tools, Actual Size, Zoom In, Zoom Out, Toggle Full Screen |

The menu is installed on every platform, so its keyboard shortcuts work
everywhere, whether or not it is on screen. Alt and F10 do not open it.

## Zoom

| Keys (Windows, Linux) | Keys (macOS) | Effect |
|---|---|---|
| `Ctrl` + `+`, `Ctrl` + `=`, `Ctrl` + numpad `+` | `Cmd` + the same | Zoom in |
| `Ctrl` + `-`, `Ctrl` + numpad `-` | `Cmd` + the same | Zoom out |
| `Ctrl` + `0`, `Ctrl` + numpad `0` | `Cmd` + the same | Actual size |

Each step is half a Chromium zoom level, between −7.5 and +8.5. The keys are
handled before the page and the terminal see them, and do nothing with `Alt`
held.

## Full screen

**View → Toggle Full Screen**: `F11` on Windows and Linux, `Ctrl+Cmd+F` on
macOS. `F11` pressed in a terminal toggles full screen too, on every platform,
and the terminal keeps the focus.

## Reload

The page has no reload shortcut: `Cmd+R` and `Ctrl+Shift+R` are blocked, and
`Ctrl+R` goes to the terminal (a shell's reverse search).
