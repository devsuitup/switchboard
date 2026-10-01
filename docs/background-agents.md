# Background agents

The Agents view is Switchboard's replacement for the `claude agents` TUI: it
lists the sessions the Claude CLI daemon runs in the background
(`claude --bg`) and the interactive `claude` sessions running outside this
Switchboard, and acts on them without a terminal.

## Opening it

The people icon in the sidebar's filter row, or `Ctrl+Shift+A` (`Cmd+Shift+A`
on macOS; [rebindable](keyboard-shortcuts.md)). The same toggle closes it and
brings back whatever was there: the grid, the active session, or the
placeholder. Opening any other view (Agent Files, Work Files, Settings, the
grid, Stats) closes it. Whether the view is open is remembered across
restarts.

## The list

One row per session: a state glyph (the same rungs as the sidebar: spinner
while busy, orange while waiting, green when idle, grey when finished), its
name, its `--agent`, its state emoji then `state · status` (see the table
below), its directory, and its age. Working
and blocked sessions and external interactive sessions come first, newest
first. **Finished** shows or hides `done`, `stopped` and `failed` sessions;
the choice is remembered. The list refreshes when the daemon's files change,
and is re-read from the CLI every 30 seconds while the view is open.

**Group**, next to Finished, splits the list into sections with a header
each (its name and how many rows it holds):

- **State** (the default): Working, Blocked, Done, Stopped, Failed, then
  External for the interactive sessions running outside Switchboard, then
  Unknown. Each header starts with the state's emoji.
- **None**: one flat list.
- **Project**: one section per directory, named after its last folder (hover
  the header for the full path; two projects with the same folder name show
  their parent folder too). Projects with something running come first, then
  the rest alphabetically; sessions without a directory go under No project.

Rows keep their usual order inside a section, the Finished filter applies
first (a section left empty is not shown), and the choice is remembered.

A job is in one of five states: `working`, `blocked` (live, waiting for
input), `done`, `stopped` or `failed` (ended in error). `working` and
`blocked` both count as live; the other three are finished.

The same emoji marks a state in the State headers and at the start of every
row's state column, whatever the grouping:

| Emoji | State |
|---|---|
| ⚙️ | Working |
| ✋ | Blocked (waiting for input) |
| ✅ | Done |
| ⏹️ | Stopped |
| ❌ | Failed |
| 🖥️ | External (an interactive session outside Switchboard) |
| ❓ | Unknown |

Selecting a row opens its detail: the daemon's one-line status, tokens,
model, start time, pid, the subagents it ran, the links it produced (merge
requests open in the browser), its last result, and the verbs:

| Verb | Runs | Available |
|---|---|---|
| Attach | `claude attach <id>` in a terminal tab | while the session is live (`working` or `blocked`) |
| Transcript | the read-only transcript viewer | whenever the transcript exists |
| Stop | `claude stop <id>`; the conversation is kept | while live |
| Respawn | `claude respawn <id>` | a background session that is not live |
| Delete | `claude rm <id>`, after confirmation; the worktree goes too when that is safe | a background session that is not live |

An external interactive session offers Transcript only. A live session is
never resumed: attach is the only way into it. To respawn or delete one, stop
it first.

## Attaching

An attach tab is an ordinary terminal tab running `claude attach`. Its stop
button reads **Detach**: closing the tab sends Ctrl+Z, the attach client
leaves, and the session keeps running under the daemon. Stopping the session
is only offered in the Agents view. Attach tabs are not reopened by
[session restore](session-restore.md). Quitting Switchboard or closing its
window ends the attach client without the Ctrl+Z; the session still keeps
running.

A click in the sidebar on a session the daemon is running attaches to it
instead of asking to resume it. Once the Agents view has been opened, such a
row carries a `bg` badge while the job is live; the badge goes when the job
finishes, and a finished background session resumes like any other.

## New agent

**New agent** opens a dialog: prompt, project, name (`--name`), agent
(`--agent`), permission mode or Dangerous Skip, additional directories. It
runs `claude --bg …` in the project directory and selects the new row. A
prompt starting with `-` is refused, since the CLI would read it as a flag.

## When the daemon does not answer

The view reads two files the CLI writes for itself, `~/.claude/jobs/<id>/state.json`
and `~/.claude/sessions/<pid>.json`, and asks `claude agents --json --all`
which sessions exist. When that command fails, a banner says so, the list
comes from the files alone, and every verb but Transcript is disabled.
Neither file is a documented interface; a CLI upgrade may change them, and
`test/canary-bg-agents-files.test.js` says so when it happens.

At most 200 job directories are watched; in that file-only mode the list
shows only the jobs among them.
