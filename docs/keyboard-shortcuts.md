# Keyboard Shortcuts

"Primary" below is `Cmd` on macOS and `Ctrl` on Windows and Linux.

## Rebindable: sessions, grid, agents and tools

| Action | Default | Effect |
|---|---|---|
| Navigate sessions / grid | Primary+Shift+↑/↓/←/→ | In the grid, move between cards in two dimensions; in single view, ← and ↑ go to the previous session, → and ↓ to the next |
| Previous / next session | Primary+Shift+`[` / `]` | Cycle through the sessions |
| Toggle grid view | Primary+Shift+`G` | Show or hide the [grid](grid-overview.md) |
| Toggle agents view | Primary+Shift+`A` | Show or hide the [background agents](background-agents.md) view |
| Toggle Changes | Primary+Shift+`E` | Show the working tree changes |
| Show pending Diff | Primary+Shift+`D` | Return to a proposed diff; with none, the key goes to the terminal |
| Toggle Touched | Primary+Shift+`T` | Show this session's touched files |
| Toggle Shell | Primary+Shift+`S` | Open or close the panel shell |

These work with the focus in a terminal, where they are caught before the
program sees them, and anywhere else in the window. Shift, not Alt, avoids the
terminal's word jumps (`Ctrl+←/→`) and the `Ctrl+Alt+arrow` workspace switch of
many Linux desktops.

### Rebinding

In **Global Settings → Keyboard → Keyboard Shortcuts**:

1. Click the button showing the current binding. It reads *Press keys…*.
2. Press the new combination. At least one modifier (Cmd/Ctrl, Option/Alt or
   Shift) is required; the arrow and bracket shortcuts keep their keys and only
   take new modifiers.
3. Esc, or clicking elsewhere, cancels. Clicking the button again while it waits
   resets it to the default.
4. **Save Settings**. The bindings apply at once.

They are global only, stored as `shortcuts`.

## Terminal

From a terminal, `F6` moves focus to the active session row in the sidebar, or its first visible,
enabled control when that row is unavailable. `Shift+F6` returns focus to the
active terminal from the sidebar or body. Neither acts while a dialog is open.
These fixed shortcuts work in single view, grid terminals and
the panel shell; they are not sent to the running program and cannot be rebound.

| Keys | Effect |
|---|---|
| Primary+`F` | Find in the scrollback; Enter / Shift+Enter for next / previous, Esc to close |
| `Shift+Enter`; also `Ctrl+Enter` on Windows and Linux | New line in Claude's prompt, without submitting |
| `Ctrl+C` with a selection (Windows, Linux) | Copy; without a selection it is the interrupt |
| Primary+`V`, `Shift+Insert` | Paste; an image in the clipboard is passed to Claude Code — see [Terminal](terminal.md#copy-and-paste) |
| `F11` | Toggle full screen |
| `Ctrl+R` | Goes to the program (a shell's reverse search) |

## Editors

In Agent Files, the Changes and Touched editors and the diff
views (CodeMirror):

| Keys | Effect |
|---|---|
| Primary+`F` | Find |
| Primary+`G` | Go to line |
| Primary+`S` | Save, where the view can save |

## Schedules

This section applies to the [Schedules tab](schedules.md), on by default.

Tab reaches **New schedule** before the project cards. Each card then offers its
fold arrow and its **+**, which opens the same form on that project. Enter or Space opens its form
with Project focused. Tab and Shift+Tab cycle through its fields, Cancel and
Create; Escape cancels and restores focus to the button that opened the form. Enter in a
text field does not submit; Enter in either multiline field inserts a newline.
Focus Create and press Enter or Space to submit. During submission the controls
are disabled and Escape waits for the result. Rejected fields receive focus
and an inline error; their values stay available for correction.

Tab reaches the on/off switch, **Run now**, **Open**, **Delete** and the last
result, which opens the history, in each schedule row. Enter or Space activates
the focused control. Delete opens a confirmation naming the file and
explaining that past runs stay in Sessions. Cancel receives initial focus;
Escape cancels and Tab stays inside the confirmation while it is open.

The list refreshes every minute and after schedule changes. A refresh keeps
keyboard focus on the same control: New schedule, a card's or a row's button, its
history toggle, or Retry. While a Retry is loading, focus waits on the list or
the row and returns to the new Retry, or to New schedule when the list
loaded; if you move focus elsewhere meanwhile, it stays where you put it. An
open creation form keeps its fields and focus during a refresh.

## Window

| Keys (Windows, Linux) | Keys (macOS) | Effect |
|---|---|---|
| `Ctrl` + `+` / `=` / numpad `+` | `Cmd` + the same | Zoom in |
| `Ctrl` + `-` / numpad `-` | `Cmd` + the same | Zoom out |
| `Ctrl` + `0` / numpad `0` | `Cmd` + the same | Actual size |
| `F11` | `Ctrl+Cmd+F` | Toggle full screen |
| `Ctrl+Shift+I` | `Alt+Cmd+I` | Developer tools |

Quit is `Cmd+Q` on macOS and `Ctrl+Q` on Linux; on Windows the item reads
**Exit** and has no key. The other menu items — Hide, Undo, Redo, Cut, Copy,
Paste, Select All — carry Electron's default keys for their roles. There is no reload shortcut: `Cmd+R` and `Ctrl+Shift+R` are blocked. See
[Window](window.md).

## Message viewer

In **View messages**, Ctrl+F (Cmd+F on macOS) opens search. Enter moves to
the next match, Shift+Enter to the previous one, and Escape closes search.
The search keeps its position while a live transcript updates.

## Settings navigation

Tab enters the selected Settings page button. Up/Down select the previous or next
page; Left/Right do the same in both layouts. Home/End select the
first/last page. Enter or Space activates a page button. Tab then enters the
page's first enabled control, followed by its remaining controls and the footer.
Shift+Tab moves back through the controls. The two explanatory disclosure blocks
open with Enter or Space. In **Filter settings…**, Escape clears the filter
and returns to the selected page. Escape does not close Settings; use Cancel
or close.

## Dialogs

The project and worktree **New session (+)** menus focus the first item when
opened. Up/Down wrap between items, Home/End select the edges, and Enter or
Space activates the focused item. Escape closes the menu and returns focus to
its + button. Tab and Shift+Tab close the menu, return focus to its + button,
then continue through the window's normal tab order from there. Moving focus
outside the menu or clicking outside also closes it.

The **New Session** dialog focuses the selected permission-mode control whenever
opened, including from the + menu. Choosing another mode keeps focus on that
mode. Enter in a text input or select list does not start a session.
Escape, Cancel and clicking outside return focus to the control that opened
it (the + button for the menu). If that control has disappeared, focus goes to
its replacement project or worktree +,
the visible session terminal, or Add Project. Start and Enter start the session
with the selected mode and focus its terminal. Enter in a text input does not
start; Enter on Cancel cancels and returns focus to the opener.

Resume focuses the selected Claude permission mode, or the first Codex list.
Escape, Cancel and clicking outside return focus to its opener, with the same
fallbacks as New Session. Enter in an input or list does not resume.
Add Project focuses its folder field and does not yet restore focus to its
opener when closed. Esc cancels it, and Enter confirms Add Project.

Tool shortcuts act on the shown terminal or focused grid card and are inactive
in other views. If a tool chord conflicts with an existing session, grid or
agents binding, the existing binding takes precedence.
