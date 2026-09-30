# Background agents view — design

Date: 2026-09-30. Status: approved in conversation, awaiting implementation plan.

## Purpose

Give Switchboard a graphical replacement for the `claude agents` TUI: one
place to see every session the Claude CLI daemon runs in the background
(`claude --bg`), read what each one is doing, and act on it — attach to it in
a terminal tab, stop it, delete it, respawn it, or dispatch a new one — without
opening a terminal and the TUI.

The user's fleet of agents (the fleet plugin's EM/PM/developer roles) runs
entirely as `--bg` sessions, so this view is their control room.

## What the CLI provides (measured, CLI 2.1.285, Linux, 2026-09-30)

None of this is a documented interface. Every use below is best-effort and
must degrade to silence, exactly as `.ai/contexts/cli-session-state.md`
prescribes for the session descriptors.

- `claude --bg [--name n] [--agent a] [--permission-mode m] [--add-dir d] <prompt>`
  starts a session under the daemon and prints its short id.
- `claude agents --json [--all]` prints a JSON array, no TTY needed, in
  ~0.15 s CPU. Without `--all`: live sessions only (background `working` plus
  every live interactive session, including Switchboard's own). With `--all`:
  also `done` and `stopped` background sessions. Entry shape:
  `{id, sessionId, name, cwd, kind: 'background'|'interactive', startedAt,
  pid?, state?: 'working'|'done'|'stopped', status?: 'busy'|'idle'|'waiting'}`.
- `claude attach <id>` opens the session in the current terminal. Verified in
  a pty: Ctrl+Z detaches, the attach client exits 0, the session stays
  `working`. `claude stop <id>`, `claude rm <id>` (also deletes the worktree
  when safe), `claude respawn <id>`, `claude logs <id>` (raw screen ANSI, not
  used here).
- `~/.claude/jobs/<id>/state.json`, written by the daemon per job:
  `state`, `detail` (one human-readable line), `tempo`, `tokens`, `inFlight`,
  `fan[]` (`{id, kind: 'agent'|'shell', label, startedAt, doneAt}`),
  `children[]` (links the job produced, e.g. merge requests: `{id, href,
  kind}`), `output.result`, `template`, `respawnFlags[]` (the original
  `--agent`, `--model`, `--name`, `--permission-mode`), `intent`,
  `linkScanPath` (the transcript path, which carries the session id).
  `timeline.jsonl` beside it is not read.
- `~/.claude/sessions/<pid>.json` for a background worker carries
  `kind: "bg"`, `jobId` (the short id), `agent`, `name`, `cwd`, `status`,
  `procStart`, `startedAt`. Interactive sessions carry `kind: "interactive"`.
  Switchboard already watches this directory (`cli-session-state.js`).
- A stopped or done background session has no live pid; `claude --resume`
  on it is legitimate (the CLI documents it). A `working` one must never be
  resumed: two CLIs would write one transcript.

## Scope

In:

- A dedicated **Agents view**, a sibling of the grid, listing background
  sessions (all states, with a filter for finished ones) and interactive
  sessions that run outside this Switchboard instance.
- Per session: attach, read the transcript, stop, respawn, delete.
- A dispatch dialog to start a new background session.
- The sidebar's click on a live background session attaches instead of
  asking "Resume anyway?".

Out (deliberately):

- Live terminals inside the view (attach opens a real tab).
- A `claude logs` tail (screen ANSI; the JSONL transcript covers reading).
- Restoring attach tabs across restarts.
- Pre-launch command and sandbox in the dispatch dialog (they wrap a process
  Switchboard holds; here the daemon holds it).
- Configurable sort or grouping; interactive sessions of this instance
  (the sidebar already shows them).
- Any use of the daemon's control socket or `control.key`.

## Architecture

### Main process: `bg-agents.js`

One new module beside `cli-session-state.js`, with one responsibility: keep a
roster of daemon jobs and external interactive sessions, and push it to the
renderer.

Sources:

1. `~/.claude/jobs/`: one `fs.watch` on the directory (new job directories)
   and one per job directory (rewrites of `state.json`). Each read goes
   through a pure `parseJobState(text)` that keeps only what the view shows:
   `state, detail, tempo, tokens, fan, children, result, template, agent,
   model, name` (the last three derived from `respawnFlags`), and `sessionId`
   extracted from `linkScanPath`. An unreadable or truncated file leaves the
   previous value in place and logs at debug.
2. `~/.claude/sessions/<pid>.json`: `cli-session-state.js` gains an
   `onDescriptor(listener)` hook that emits every parsed descriptor it reads
   (`pid, sessionId, kind, jobId, agent, name, cwd, status, startedAt,
   procStart`), without changing its existing matching or transitions.
   `bg-agents.js` keeps `kind: "bg"` descriptors (joined to a job by `jobId`)
   and `kind: "interactive"` descriptors that `ownProcessFilter()` does not
   claim for this instance.

Reconciliation: `claude agents --json --all` via `execFile` (no shell,
5 s timeout), run by every `get-bg-agents` call and after every verb. The
renderer calls `get-bg-agents` when the view opens and every 30 s while it
is visible, so that is the reconciliation cadence. Its list is the authority for which jobs exist and their
`state`; the files supply everything else. A job directory absent from the
CLI's list is not shown. If the CLI fails (missing, no `agents` subcommand,
timeout), the roster is built from files alone and carries
`daemonReachable: false`.

Roster entry:

```
{ id, sessionId, name, cwd, kind: 'background'|'interactive',
  state: 'working'|'done'|'stopped'|null, status: 'busy'|'idle'|'waiting'|null,
  pid, startedAt, agent, model, detail, tempo, tokens, fan, children, result,
  attachedHere: boolean }
```

`mergeRoster(cliList, jobs, descriptors, ownPids)` is pure and unit-tested.

IPC (add to `.ai/contexts/ipc-bridge.md`):

| IPC | Args | Returns |
|---|---|---|
| `get-bg-agents` | — | `{roster: Entry[], daemonReachable}` — snapshot; arms the watchers on first call |
| `bg-agent-verb` | `(verb: 'stop'\|'respawn'\|'rm', id)` | `{ok, error?}` |
| `dispatch-bg-agent` | `({prompt, name, agent, cwd, permissionMode, dangerouslySkipPermissions, addDirs})` | `{ok, id?, error?}` |
| event `bg-agents-changed` | `{roster, daemonReachable}` | coalesced at 250 ms |

Guards: liveness by `process.kill(pid, 0)` and `procStart` reuse from
`cli-session-state`; `MAX_JOBS` (200) bounds the initial scan; watchers are
armed on the first `get-bg-agents` and released in the window's `closed`
handler with the other watchers. Nothing runs before the view is first
opened (ADR 0002: no added steady-state cost).

### Renderer: `agents-view.js`

A plain script like the others. Depends on `escapeHtml`, the roster from
IPC, and two callbacks from `app.js`: open a terminal tab, open the JSONL
viewer. Renders with `morphdom` from an in-memory model so a roster update
keeps the selection and the scroll.

Container `#agents-viewer` inside `#terminal-area`, a sibling of
`#grid-viewer`, shown and hidden the way the grid is (hide the active
terminal, refit on return). Toggle button in the sidebar filter row next to
the grid button; shortcut `agentsToggle` (default Ctrl+Shift+A, Cmd on macOS)
registered in `shortcuts.js` and listed in `docs/keyboard-shortcuts.md`. Open
state persists in `localStorage.agentsViewActive`. Closing the view does not
release the watchers.

Layout: a master list and a detail pane.

```
┌ Agents ──────────────────── 3 running · 2 done ─── [New agent] [Finished ☑] ┐
│ ● em-platform-2026…  fleet:em  working·idle  lvds/…/em-platform  2d 6h  ⋯  │
│ ● fleet-0f           —         working·busy  lvds/internal/fleet  12 min ⋯  │
│ ○ spike-target       —         done          lvds/internal/fleet  1 h    ⋯  │
│ ◌ lvds-1b            external  busy          lvds/.claude/worktr… 3 h       │
├───────────────────────────────────────────────────────────────────────────┤
│ em-platform-20260928075800-49fd                    [Attach] [Transcript]   │
│ backlog reviewed; awaiting !196 merge or apiClient.ts diff                 │
│ 173k tokens · sonnet-5 · started 28/09 07:58 · pid 346590                  │
│ Subagents: Spawn developer for platform squad (26 s, done)                 │
│ Produced: !195 platform-admin-dossiers-nav · !196 …                        │
│ Last result: no new action needed; session idle pending !196 merge…        │
└───────────────────────────────────────────────────────────────────────────┘
```

- List row: state glyph reusing the rungs of `session-state.js` (busy
  spinner, waiting orange, idle green, done/stopped grey, external
  interactive as a hollow circle), name, `--agent`, `state·status`,
  abbreviated project path, age, a `⋯` menu. Sort: `working` first, then
  `startedAt` descending. The "Finished" filter (on by default) shows or
  hides `done`/`stopped`; persisted in `localStorage.agentsShowFinished`.
- Detail pane for the selected row: `detail`, tokens, model, start time,
  pid, `fan[]` with duration and state, `children[]` as clickable links
  (`shell.openExternal`, already exposed), `output.result`. For an external
  interactive session: name, cwd, status, and only the Transcript action.
- `⋯` menu and detail buttons: Attach, Transcript, Stop, Respawn, Delete,
  disabled by state (Stop only when `working`; Delete never when `working`;
  Respawn and Attach never on an interactive session). A verb in flight greys
  the row; its error shows in the detail pane, never in a modal.
- "New agent" opens the dispatch dialog.
- Banner under the header when `daemonReachable` is false: "The daemon is
  not answering; state comes from files only." Verbs other than Transcript
  are disabled then. Empty state: "No background agents. `claude --bg`
  starts one, or New agent."

### Verbs

**Attach.** An ordinary terminal tab whose pty runs `claude attach <id>` in
the session's cwd, through `open-terminal` with `sessionOptions.type =
'attach'` and the `jobId`. The tab is keyed by the session's real
`sessionId`, so the sidebar row (already indexed from the transcript) and
the tab coincide, and `cli-session-state` feeds its busy/idle state from the
daemon worker's descriptor with no change. No `--resume`, no fork, ever.

- Detach: closing the tab writes `\x1a` (Ctrl+Z) to the pty, waits up to
  2 s for the attach client to exit, and kills the pty only as a last
  resort. The terminal header's Stop button reads "Detach" on an attach tab
  and does exactly this; stopping the background session is only offered in
  the Agents view. This is the detach/stop pair `.ai/contexts/session-state.md`
  already defines.
- An attach tab is not part of the restore working set: after a restart it
  does not come back; the Agents view is the way to reopen it.
- If `claude attach` exits at once (the job stopped between the click and the
  spawn), the tab shows the CLI's output and the header goes to "exited",
  like any pty.

**Stop, Respawn, Delete.** `execFile('claude', [verb, id])` in the session's
cwd, 15 s timeout, no shell. Each returns `{ok, error}` (stderr verbatim)
and triggers a reconciliation. Delete asks for confirmation with the CLI's
own wording: the conversation and its worktree go, when that is safe. Stop
or Delete on a session attached here detaches first.

**Dispatch.** `showDispatchAgentDialog()` in `dialogs.js`, built from the
same pieces as the New Session dialog:

| Field | Passed as |
|---|---|
| Prompt (textarea, required) | last positional argument |
| Name | `--name <n>`; empty = the CLI picks one |
| Project (select over the sidebar's projects, preselected to the active session's) | the `cwd` of the `execFile` |
| Agent (free text) | `--agent <a>`; empty = none |
| Permission mode / Dangerous Skip (as in New Session) | `--permission-mode <m>` or `--dangerously-skip-permissions` |
| Additional directories | one `--add-dir` per entry, through the existing `parseAddDirs` |

Command: `claude --bg [options] <prompt>` via `execFile`, never a shell. The
printed id is parsed; on success the roster is reconciled and the new row
selected. If the id does not parse, the result is `{ok: true, id: null}`;
the row appears through the files.

### Sidebar

No roster in the sidebar. The existing resume guard is extended by two
fields: `session-live-elsewhere` and `sessions-live-elsewhere` also return
the descriptor's `kind` and `jobId`. In `guardResume`, `kind === 'bg'` with a
live pid no longer asks "Resume anyway?": the click attaches. A `done` or
`stopped` background session has no live pid, the guard says nothing, and
`--resume` proceeds as today. External interactive sessions keep today's
confirmation. Once the Agents view has been opened at least once, the
`bg-agents-changed` event also reaches the sidebar, which puts a small "bg"
badge on the rows whose session id is in the roster; before that there is no
badge and no cost, and the guard's protection does not depend on it.

## Failure handling

- CLI missing, without `agents`, or timing out: file-only roster, banner,
  verbs disabled except Transcript. Nothing else in the app is affected.
- `state.json` unreadable or mid-rewrite: previous value kept, debug log.
- Dead descriptor pid: same liveness as `cli-session-state`; the entry falls
  back to the CLI's state alone.
- A failing verb: `{ok: false, error}` in the detail pane; the roster is
  reconciled regardless.
- Dispatch whose id does not parse: see above.

## Invariants (to be written to `.ai/contexts/bg-agents.md`, with a row in
`.ai/shared-guidelines.md` and `.ai/contexts/README.md`)

1. Never `--resume` or `--fork-session` a session whose job is `working`.
   `claude attach` is the only path to a live job.
2. Every write to the daemon goes through the CLI with `execFile` and no
   shell. The control socket and `control.key` are never touched.
3. Closing an attach tab detaches; it never kills the session. `claude stop`
   is the only stop.
4. No steady-state cost before the view is first opened (ADR 0002).
5. `jobs/` and the `kind: "bg"` descriptor are undocumented interfaces:
   failure is silence, and a canary test pins their observed shape.

## Testing

`node:test`, as the rest of the suite; renderer tests through
`test/dom-setup.js` and `vm.runInContext`.

- `test/bg-agents-parse.test.js`: `parseJobState()` and `mergeRoster()`.
  Cases: a job with `fan` and `children`; a `done` job without a pid; a bg
  descriptor without a job (ignored); an interactive descriptor owned by this
  instance (excluded); the CLI's `state` winning over the file's; the session
  id extracted from `linkScanPath`.
- `test/bg-agents-watch.test.js`: a temporary `jobs/` directory; creating a
  job directory and rewriting `state.json` yields one coalesced event; `stop()`
  releases the watchers.
- `test/canary-bg-agents-files.test.js`: pins the observed shape of
  `state.json` and of the bg descriptor (fields, `state` and `status`
  vocabularies), with the CLI version and date in the test name.
- `test/dom-agents-view.test.js`: rendering a roster; sort; the Finished
  filter; selection kept across a morphdom update; buttons disabled by state;
  the daemon banner; the empty state.
- `test/resume-guard.test.js`, extended: `kind: 'bg'` with a live pid
  attaches without confirmation; without a live pid the resume path is
  taken.
- `test/dom-dispatch-dialog.test.js`: the fields produce exactly the expected
  argument list (no shell, prompt last, absent options when empty).
- Main-side: `open-terminal` with `type: 'attach'` builds `claude attach
  <id>` in the given cwd, and closing writes `\x1a` before any kill.

Live verification runs against the isolated test instance
(`task test-pr`, see `docs/testing-a-pr.md`) with a `claude --bg` started by
hand.

## Documentation to ship with the change

- `docs/background-agents.md` (new page) and a row in the README's feature
  table and `docs/README.md`.
- `docs/keyboard-shortcuts.md`: the new shortcut.
- `.ai/contexts/bg-agents.md`, and the IPC rows in `.ai/contexts/ipc-bridge.md`.
