# Context: bg-agents

**Purpose**: The Agents view — a graphical replacement for the `claude agents`
TUI. Lists the daemon's `--bg` sessions and the external interactive ones,
attaches/stops/respawns/deletes/dispatches through the CLI. Design:
`docs/superpowers/specs/2026-09-30-background-agents-view-design.md`. User
doc: `docs/background-agents.md`.

## Key files

| File | Role |
|---|---|
| `bg-agents-roster.js` | Pure: `parseJobState`, `parseCliList`, `mergeRoster`, `dispatchArgs`, `parseDispatchOutput`, `JOB_STATES`, `JOB_ID_RE` |
| `bg-agents.js` | Watchers over `~/.claude/jobs/*/state.json`, descriptor subscription, `reconcile()` through `claude agents --json --all`, `runVerb`, `dispatch`, `onChange` |
| `bg-agents-ipc.js` | `get-bg-agents`, `bg-agent-verb`, `dispatch-bg-agent`, the `bg-agents-changed` push |
| `cli-session-state.js` | `onDescriptorsChanged`, `readAllDescriptors`, `kind`/`jobId` on live-elsewhere |
| `pty-ops.js` | `detachPty` |
| `main.js` | `runClaudeCommand`; the `type: 'attach'` branch of `open-terminal`; detach in `stop-session`; `bgAgents.init` and `bg-agents-ipc` wiring; `bgAgents.stop()` in the window's `closed` handler |
| `public/agents-view.js` | The view; `agentJobIsLive`; `bgAgentSessionIds` for the sidebar badge |
| `public/resume-guard.js` | A live `kind: 'bg'` descriptor answers `{ attach, cwd }` |
| `public/dialogs.js` | `showDispatchAgentDialog` |
| `public/shortcuts.js` | The rebindable `agentsToggle` (default Primary+Shift+`A`) |

## Invariants

1. Never `--resume` or `--fork-session` a live job. A job is live when its
   state is `working` or `blocked` (see "Job states"). `claude attach` is the
   only path to a live job (`guardResume` turns a `bg` verdict into attach
   options; `open-terminal` builds `claude attach`). Nothing ever resumes one.
2. Every call to the CLI goes through the login shell with an argv quoted by
   `quoteArgvForShell` (`runClaudeCommand`, the scheduler's path). Never a
   command string built by hand. The daemon's control socket and
   `control.key` are never touched.
3. Closing an attach tab detaches (`\x1a`, 2 s grace, then kill —
   `detachPty`). `claude stop` is the only stop.
4. No steady-state cost before the view is first opened: the watchers are
   armed by the first `get-bg-agents`. Closing the view keeps them so the
   sidebar badge stays current; the window's `closed` handler releases them.
5. `jobs/` and the `kind: "bg"` descriptor are undocumented. Failure is
   silence: an unreadable `state.json` keeps the previous value; a CLI that
   fails leaves a file-only roster with `daemonReachable: false`. Canaries:
   `test/canary-bg-agents-files.test.js`, `test/canary-cli-session-state.test.js`.
6. A verb's id is validated against `JOB_ID_RE` before any spawn; a prompt
   starting with `-` is refused by `dispatchArgs`.
7. The attach options are exactly `{ type: 'attach', jobId, cwd }`. Never
   `sandbox`, `preLaunchCmd` or MCP emulation: the attach branch of
   `open-terminal` skips them, and the client only talks to the daemon.

## Job states

`JOB_STATES` in `bg-agents-roster.js` is `working`, `blocked`, `done`,
`stopped`. `blocked` is a live job waiting on input (observed on CLI 2.1.285,
2026-09-30; the first design listed three states). `agentJobIsLive`
(`public/agents-view.js`) — `working` or `blocked` on a background entry — is
the single live predicate in the renderer.

| Verb | Live job | Not live |
|---|---|---|
| Attach | allowed | disabled (a finished session resumes like any other) |
| Stop | allowed | disabled |
| Respawn | refused | allowed |
| Delete (`rm`) | refused | allowed |

The UI disables the buttons (`agentVerbAvailability`); `runVerb` refuses
`respawn`/`rm` on a live roster entry with the same rule, so a stale renderer
cannot bypass it. A blocked row draws as waiting (orange), not as a spinner.

## Data flow

`jobs/<id>/state.json` (fs.watch, per directory) and `sessions/<pid>.json`
(through `cli-session-state`'s flush) both call `scheduleRebuild()`,
coalesced at `FLUSH_MS` (250 ms). `rebuild()` = `mergeRoster(cli, jobs,
readAllDescriptors())`. The CLI list is the authority for which jobs exist
and their `state`; the file supplies `detail`, `tokens`, `fan`, `children`,
`result`, `--agent`/`--model`/`--name`; the descriptor supplies `status`,
`pid`, `agent`. `reconcile()` runs on every `get-bg-agents` (the renderer
calls it on open and every 30 s while visible) and after every verb and
dispatch. The push `bg-agents-changed` carries `{roster, daemonReachable}`.

### Lifecycle

- `reconcile()` is a no-op until `start()`: it returns the current (empty)
  snapshot without spawning the CLI.
- The first `get-bg-agents` calls `start()`, which arms the jobs-directory
  watcher, one watcher per job directory, and the descriptor subscription.
  Later calls find `started` already true and only reconcile.
- Every `get-bg-agents` also re-subscribes the `bg-agents-changed` push
  (`subscribe()` in `bg-agents-ipc.js`). `stop()` clears the listener set; on
  macOS the app outlives its window, the `closed` handler calls `stop()`, and
  the window created next would otherwise never receive an update.
- A `reconcile()` in flight when `stop()` runs is dropped: `stop()` bumps
  `generation`, and the reconcile compares the value it captured before
  awaiting the CLI and returns without touching the (now reset) state.
- `bgAgents.init()` calls `stop()` first, so a re-init starts clean.

## Non-obvious behaviors

- The view is a sibling of `#jsonl-viewer`, shown by hiding
  `#terminal-area` (as the Stats tab does), so the grid's state survives.
  `hideAllViewers()` calls `hideAgentsView({ restore: false })`, as do the
  Agent Files / Work Files tabs, Settings and the grid; only the toggle
  restores the terminal area.
- The view persists `localStorage.agentsViewActive` (`'1'`/`'0'`).
  `initAgentsView()` reads it into `agentsOpenAtStartup`; `app.js` calls
  `restoreAgentsViewAtStartup()` after the working set is restored, so the
  view is shown once the restored sessions are open.
  `agentsShowFinished` persists under `localStorage.agentsShowFinished`
  (`'0'` hides finished sessions).
- `claude --bg` prints its id wrapped in ANSI colour codes (see "Measured
  facts"); `parseDispatchOutput` takes the first standalone eight-hex token,
  which the colour codes do not hide, and `dispatch` reports
  `ok: true, id: null` when there is none — the row then arrives through the
  files.
- `claude agents --json --all` runs through an interactive login shell
  (`runClaudeCommand`), so rc files may print to stdout around the JSON.
  `parseCliList` first tries a strict parse, then the candidate arrays that
  start with `[` at the start of a line and end with `]` at the end of a line
  (at most 32 of each), and returns `null` when none parses. A verb's error
  text goes through `stripShellNoise`, which drops only the leading
  `bash: no job control in this shell` / `cannot set terminal process group`
  lines; the CLI's own stderr is kept verbatim.
- `claude rm` runs from the home directory, never from the job's cwd: that
  directory may be the worktree `rm` deletes, and Windows refuses to remove a
  live process's cwd. `stop` and `respawn` run in the job cwd (respawn's brief
  needs it), falling back to home when it no longer exists.
- An attach tab's `cli-session-state` status comes from the daemon worker's
  descriptor (same `sessionId`), so busy/idle needs no special path.
- When a row is attached here and the user runs Stop or Delete on it, the
  renderer stops the local attach pty first (`stopSession`), so the client
  does not outlive the job.

## The sidebar

`bgAgentSessionIds` (a `Set` of the `sessionId` of every live background job,
`agentJobIsLive`: `working` or `blocked`) is rebuilt by `applyAgentsSnapshot`,
which refreshes the sidebar only when the set changed. `sidebar.js` prefixes a
`bg` badge ("click to attach") to a session row whose id is in it. Two
consequences:

- The set is empty until the first `get-bg-agents` — the badge needs the view
  to have been opened once in this window (`refreshAgentsRoster()` runs at
  open; the push keeps it current afterwards).
- A finished job loses its badge at the next snapshot. Clicking its row
  resumes normally: the attach decision is made by `guardResume` from a live
  descriptor, not from the badge.

## Attach

`guardResume(session, { automatic, api, confirm, live })`:

- `automatic` (restore, reload): a session live elsewhere returns `false`;
  nothing attaches or resumes on its own.
- `live.kind === 'bg'` with a `jobId`: `{ attach: jobId, cwd }`. `app.js`
  turns that into `{ type: 'attach', jobId, cwd }` and marks the entry
  `attach`. Without a `jobId` it refuses (`false`) rather than offering to
  resume.
- Any other live-elsewhere session keeps the confirm dialog.

The Agents view's Attach button builds the same options itself
(`attachBgAgent`, skipping the guard; it is only enabled for a live job).
In `open-terminal`, `type: 'attach'` validates `jobId` against `JOB_ID_RE`,
takes `cwd` from the options, runs `claude attach <jobId>` and skips sandbox,
pre-launch command and MCP emulation. The session is flagged `isAttach` with
`attachJobId`, which `isAttachedHere` (passed to `bgAgents.init`) reads to set
`attachedHere` on the roster entry. Attach tabs are excluded from the working
set (`entry.attach`). After a renderer reload the tab is reopened through the
reattach branch of `open-terminal`, which returns `attach: !!session.isAttach`;
`openSession` sets `entry.attach` from it, so the flag survives the reload.

The view's HTML puts CLI- and file-sourced values (name, cwd, href, session
id) in attributes through `agentsEscapeAttr`, which also escapes `"` and `'`:
`escapeHtml` does not, and a quote would otherwise let a value add a
`data-verb` that a click runs.

## Detach

`stop-session` on an `isAttach` session calls `detachPty` and returns
`{ ok: true, detached: true }`: write `\x1a` (Ctrl+Z, which makes `claude attach` leave and
leaves the session running), wait `graceMs` (2000), then
`killPty` if the client is still there. If the write fails it kills at once.
The header's stop button is labelled **Detach** for such a tab
(`terminalStopBtn.title`). The job is stopped only by `claude stop`, from the
Agents view.

## Known limits

- `runVerb`'s live-guard looks the job up in the roster. When the roster does
  not have it — before the first reconcile, or a job beyond `MAX_JOBS` — the
  guard passes `rm` and `respawn` through and the CLI is left to refuse.
- `MAX_JOBS` (200) truncates the watched job directories by sorted id, not by
  recency; with the daemon answering, the roster still comes from the CLI list.
- The jobs-directory watcher's `error` handler only logs; it does not re-arm
  the watcher, so new job directories are noticed by the next reconcile
  instead.
- Window close and app quit kill attach ptys without `\x1a` first (the
  `closed` handler calls `killPty`). The session survives; the client just
  does not leave politely.
- `parseDispatchOutput` was checked against one measured output (see
  "Measured facts"); a CLI that changes that line may make `dispatch` return
  `id: null`, which only costs the row selection.
- Liveness of interactive descriptors is pid-only (`isProcessAlive`): a
  reused pid shows an external session that is gone.
- A login shell whose rc files print to stdout is tolerated by the tolerant
  list parse, as long as the JSON array stays on its own lines; other noise
  (text on the same line as the JSON, a stray line that happens to parse as
  a JSON array before it) is not, and the view then reports the daemon
  unreachable.
- Whether the CLI itself refuses `claude rm` or `claude respawn` on a live job
  is NOT verified. The UI disables both on a live row and `runVerb` refuses
  them when the roster knows the job is live; outside that (see the first
  item) nothing guards it.

## Measured facts (CLI 2.1.285, Linux, 2026-09-30)

- `claude agents --json --all`: ~0.15 s CPU; array of `{id, sessionId, name,
  cwd, kind, startedAt, pid?, state?, status?}`.
- The daemon reports a fourth job state, `blocked`, for a live job waiting on
  input.
- `claude attach <id>` in a pty: Ctrl+Z detaches, client exits 0, session
  stays `working`.
- `claude logs <id>` prints screen ANSI, unusable without xterm — not used.
- `claude --bg --name plan-check "say hello and stop"` prints
  `backgrounded · <id> · <name>`, then dim hint lines
  `claude agents`, `claude attach <id>`, `claude logs <id>`,
  `claude stop <id>`. The id is 8 hex chars wrapped in ANSI colour codes
  (`ESC[36m` … `ESC[39m`) even when stdout is piped. `parseDispatchOutput`
  returns the id for that text and `null` for a line without an id
  (`test/bg-agents-roster.test.js`).
- In a cwd that is not a trusted workspace the CLI refuses: `Workspace not
  trusted. Run \`claude\` in <dir> once and accept the trust prompt, then
  retry.` A dispatch from a never-trusted project therefore shows that
  message as its error.

## If you change this, also check

- `.ai/contexts/ipc-bridge.md` (the three handlers, the event)
- `.ai/contexts/cli-session-state.md` (the descriptor hooks)
- `docs/background-agents.md`, `docs/keyboard-shortcuts.md`
