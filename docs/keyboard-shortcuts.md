# Keyboard Shortcuts

"Primary" below is `Cmd` on macOS and `Ctrl` on Windows and Linux.

## Rebindable: sessions and grid

| Action | Default | Effect |
|---|---|---|
| Navigate sessions / grid | Primary+Shift+↑/↓/←/→ | In the grid, move between cards in two dimensions; in single view, ← and ↑ go to the previous session, → and ↓ to the next |
| Previous / next session | Primary+Shift+`[` / `]` | Cycle through the sessions |
| Toggle grid view | Primary+Shift+`G` | Show or hide the [grid](grid-overview.md) |

These work with the focus in a terminal, where they are caught before the
program sees them, and anywhere else in the window. Shift, not Alt, avoids the
terminal's word jumps (`Ctrl+←/→`) and the `Ctrl+Alt+arrow` workspace switch of
many Linux desktops.

### Rebinding

In **Global Settings → Keyboard Shortcuts**:

1. Click the button showing the current binding. It reads *Press keys…*.
2. Press the new combination. At least one modifier (Cmd/Ctrl, Option/Alt or
   Shift) is required; the arrow and bracket shortcuts keep their keys and only
   take new modifiers.
3. Esc, or clicking elsewhere, cancels. Clicking the button again while it waits
   resets it to the default.
4. **Save Settings**. The bindings apply at once.

They are global only, stored as `shortcuts`.

## Terminal

| Keys | Effect |
|---|---|
| Primary+`F` | Find in the scrollback; Enter / Shift+Enter for next / previous, Esc to close |
| `Shift+Enter`; also `Ctrl+Enter` on Windows and Linux | New line in Claude's prompt, without submitting |
| `Ctrl+C` with a selection (Windows, Linux) | Copy; without a selection it is the interrupt |
| Primary+`V`, `Shift+Insert` | Paste; an image in the clipboard is passed to Claude Code — see [Terminal](terminal.md#copy-and-paste) |
| `F11` | Toggle full screen |
| `Ctrl+R` | Goes to the program (a shell's reverse search) |

## Editors

In Agent Files, the side-panel file viewer, the Changes editor and the diff
views (CodeMirror):

| Keys | Effect |
|---|---|
| Primary+`F` | Find |
| Primary+`G` | Go to line |
| Primary+`S` | Save, where the view can save |

## Window

| Keys (Windows, Linux) | Keys (macOS) | Effect |
|---|---|---|
| `Ctrl` + `+` / `=` / numpad `+` | `Cmd` + the same | Zoom in |
| `Ctrl` + `-` / numpad `-` | `Cmd` + the same | Zoom out |
| `Ctrl` + `0` / numpad `0` | `Cmd` + the same | Actual size |
| `F11` | `Ctrl+Cmd+F` | Toggle full screen |
| `Ctrl+Shift+I` | `Alt+Cmd+I` | Developer tools |

The other menu items — Quit, Hide, Undo, Redo, Cut, Copy, Paste, Select All —
carry Electron's default keys for their roles. There is no reload shortcut: `Cmd+R` and `Ctrl+Shift+R` are blocked. See
[Window](window.md).

## Dialogs

In the New Session, Resume and Add Project dialogs, Enter confirms and Esc
cancels (Enter inside a text field does not start a session).
