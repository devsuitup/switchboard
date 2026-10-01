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
| `bg-agents.js` | Watchers over `~/.claude/jobs/*/state.json`, descriptor subscription, `reconcile()` through `claude agents --json --all`, `runVerb`, `dispatch`, `onChange`; `projectRoot`/`worktreeRoot` on every entry, cached |
| `project-root.js` | `resolveProjectRoots(cwd)`: the `.claude/worktrees` pattern, else one `git rev-parse`; never throws |
| `bg-agents-ipc.js` | `get-bg-agents`, `bg-agent-verb`, `dispatch-bg-agent`, the `bg-agents-changed` push |
| `cli-session-state.js` | `onDescriptorsChanged`, `readAllDescriptors`, `kind`/`jobId` on live-elsewhere |
| `pty-ops.js` | `detachPty` |
| `main.js` | `runClaudeCommand`; the `type: 'attach'` branch of `open-terminal`; detach in `stop-session`; `bgAgents.init` and `bg-agents-ipc` wiring; `bgAgents.stop()` in the window's `closed` handler |
| `public/agents-view.js` | The view; `agentJobIsLive`; `groupAgentEntries` (Group by); `bgAgentSessionIds` for the sidebar badge |
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
`stopped`, `failed`. `blocked` is a live job waiting on input (observed on CLI
2.1.285, 2026-09-30; the first design listed three states). `failed` is a job
that ended in error (observed on CLI 2.1.285, 2026-10-01, two jobs); before it
was in the set such a job parsed as `null` and its row read `?`. `failed` is
finished, like `done` and `stopped`: not live, hidden by the Finished filter,
counted as finished, Respawn and Delete enabled. `agentJobIsLive`
(`public/agents-view.js`) — `working` or `blocked` on a background entry — is
the single live predicate in the renderer, so every state outside those two
is finished without a list to keep in sync.

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
  (`'0'` hides finished sessions); the grouping under
  `localStorage.agentsGroupBy` (see "Group by").
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
- Narrow widths: a row's grid columns add up to ~670 px of minimum width.
  Without `min-width: 0` on `#main` that minimum became `#main`'s own, so
  with a narrow window or a wide sidebar `#main` ran past the window edge
  and the header's right end (New agent) was clipped by `body`'s
  `overflow: hidden`. `#main` now shrinks to the space left, the list
  scrolls sideways, and the header wraps its controls (`flex-wrap`, New
  agent `flex-shrink: 0`) onto extra rows.
- Dispatch dialog height: it reuses `.new-session-dialog`, which has no
  height limit, so on a short screen the bottom (Start / Cancel) left the
  window. The dispatch dialog adds `dispatch-agent-dialog`
  (`max-height: calc(100vh - 32px)`, `overflow-y: auto`) and scrolls inside
  the window. The class is scoped on purpose: the other dialogs share
  `.new-session-dialog` and may hold popovers that an `overflow` would clip.
- Window controls: the frameless window draws the system buttons over the
  top-right corner, and `#agents-viewer-header` is the top row of `#main`.
  It is in the `window-frameless` header lists of `style.css` (right inset
  `--strip-inset-right`, left inset for a collapsed sidebar), and its labels
  are `no-drag`, so New agent stays clear of the controls and a click on
  "Finished" or "Group" does not start a window drag. A new view that
  reaches the top of `#main` must join those lists; see
  [window-frame.md](window-frame.md).

## Group by

The header's `#agents-group-by` select sets `agentsGroupBy` (`none`, `state`,
`project`), persisted under `localStorage.agentsGroupBy`. `readAgentsGroupBy`
wraps the read in try/catch and `normalizeAgentsGroupBy` maps anything else
(unset included) to `state`, the default; an explicitly stored `none` or
`project` is kept. The default is not written back, so it only lands in
storage once the user picks something. The write is wrapped too, so a storage
that throws still lets the choice apply for the session. The `<select>` in
`index.html` marks `state` as `selected` to match before `initAgentsView` runs.

- `groupAgentEntries(entries, mode)` is pure and returns
  `[{ key, label, title, entries }]`, empty groups dropped. It keeps the input
  order inside each group: the renderer passes it the already filtered
  (Finished) and sorted (`sortAgentEntries`) list, so grouping never re-sorts
  rows. `none` returns one unlabelled group; the renderer then skips headers
  entirely, so the flat list is byte-identical to before.
- `AGENT_STATE_META` (key → `{ emoji, label }`) is the single source for the
  state groups' order, their header label and emoji, and the emoji at the
  start of each row's `.agents-row-state` (in every mode). `agentStateMeta`
  (entry → `{ key, emoji, label }`) is the only lookup: interactive entries
  are `external` whatever their state; a background entry whose state is
  `null` or not a key is `unknown`. Order: Working, Blocked, Done, Stopped,
  Failed, External, Unknown. "Blocked" matches the row's own state word.
  Emojis are literals from the map, never data, and sit in their own
  `aria-hidden` span (`.agents-group-emoji`, `.agents-state-emoji`) so the
  label and the state text stay plain text. Project headers carry no emoji.
  A new job state needs an entry here, or its rows fall into Unknown.
- Project groups are keyed by `entry.projectRoot || entry.cwd` (see
  "Project and worktree roots"); the string is used as is (a trailing slash
  or a different case makes a different group); neither is the "No project"
  group. The label is the last path segment (`/` and `\` both split, so
  Windows paths work). Labels shared by several roots become
  `last (parent)`; if still shared, the full path. Order: a group holding any
  `agentIsLive` entry first — interactive sessions count as live, the same
  rank `sortAgentEntries` uses — then by label, case-insensitive
  (`localeCompare`, `sensitivity: 'base'`), with "No project" last in its
  rank.
- Header rows are `.agents-group-header` / `.agents-subgroup-header`, not
  `.agents-row`. The viewer's click handler checks `[data-collapse]` before
  `.agents-row`, so a header click toggles the group and never selects a row;
  the selection (`agentsSelectedKey`) is untouched by a regroup or a
  collapse. The header's `title` (full path) and `data-collapse` go through
  `agentsEscapeAttr` and are read back with `dataset`; the label through
  `escapeHtml`.
- Headers are `position: sticky` in the scrolling `#agents-list`, sized
  `1.2em` of the list's 12px (rows are 12px), weight 600, with more padding
  above than below; the count is weight 400, smaller and `--text-muted`.
- Collapsing: every header (State, Project, worktree sub-group) is
  `role="button"`, `tabindex="0"`, `aria-expanded`, with a `▾`/`▸` chevron in
  an `aria-hidden` span; click, Enter or Space (a `keydown` on the viewer)
  calls `toggleAgentsGroup`. A collapsed header keeps its label and total
  count and renders none of its rows; a collapsed project also hides its
  sub-groups; a collapsed sub-group hides only its rows. Keys
  (`agentsCollapseKey`) are scoped by mode and level — `state:<state>`,
  `project:<projectRoot or cwd>` (`project:` for No project),
  `worktree:<projectRoot>|<worktreeRoot>` — so folding Done in State mode
  folds nothing in Project mode. The set (`agentsCollapsedGroups`, a `Set`
  whose insertion order is the age) is kept in memory across roster pushes,
  regroups, mode switches and the Finished filter, and persisted as a JSON
  array under `localStorage.agentsCollapsedGroups` (read and write in
  try/catch). `parseCollapsedGroups` drops invalid JSON, non-arrays and
  non-strings, de-duplicates, and keeps the newest `AGENTS_COLLAPSE_MAX`
  (200); a toggle that adds past the cap evicts the oldest key. Keys of
  groups that no longer exist stay until evicted. The selected row may sit in
  a collapsed group: the selection and the detail pane stay (and its verbs
  keep working); the row is just not drawn. Nothing collapses in None mode.
- Worktree sub-groups: `#agents-group-worktrees` sets `agentsGroupWorktrees`,
  persisted under `localStorage.agentsGroupWorktrees` (`'0'` off; unset or
  anything else on; read and write in try/catch). It is disabled (kept
  visible, greyed through `:has(input:disabled)`) outside Project mode;
  `renderAgentsView` refreshes `disabled` on every render.
  `groupAgentEntries(entries, 'project', { worktrees: true })` adds
  `children` (`[{ key, label, title, entries }]`) to a project group only
  when its entries span more than one worktree (`worktreeRoot || cwd`): a
  project living in one worktree, even a linked one, stays flat — sub-headers
  there would only repeat the project header. "No project" never gets
  children. Sub-group label: `main` when `key === projectRoot`, else the
  worktree directory's last segment, disambiguated like the project labels
  (`main` excluded). Order: live first, then main, then label. The project
  header's count is the project total; each `.agents-subgroup-header` (1em,
  weight 600, muted, indented, not sticky) shows its own count, title via
  `agentsEscapeAttr`; the rows under it get `.agents-row--nested` (indent
  only). The option is ignored in the other modes.

## Project and worktree roots

`project-root.js` (main process) resolves, for one cwd,
`{ projectRoot, worktreeRoot }`: the git project's main working tree and the
top of the worktree the cwd lives in (the cwd may be a subdirectory).
`derive-project-path.js`'s `resolveWorktreePath` was not reused: it is
synchronous, needs the parent to exist, only takes a cwd that is exactly
`<root>/.claude/worktrees/<name>`, and knows nothing about `git worktree add`
directories elsewhere.

1. Pattern (pure, no fs): `<root>/.claude/worktrees/<name>[/…]`, either
   separator → `projectRoot = <root>`, `worktreeRoot =
   <root>/.claude/worktrees/<name>`; the lazy match takes the outermost
   `.claude/worktrees`. Works for a directory that no longer exists (a
   finished job whose worktree was removed). Only `.claude/worktrees` is a
   pattern; `.worktrees` / `.claude-worktrees` go through git when they exist.
2. Otherwise, if the cwd is an existing directory: one
   `git -C <cwd> rev-parse --git-common-dir --show-toplevel` through
   `execFile` (argv array, no shell, `cwd` option, `GIT_TIMEOUT_MS` = 2 s,
   `GIT_*` variables stripped from the env so an inherited `GIT_DIR` — e.g.
   from a git hook — cannot point it at another repo). `worktreeRoot` = the
   top-level; `projectRoot` = the parent of the common dir when it is named
   `.git`, else (bare repo, submodule whose common dir is
   `.git/modules/<sub>`) the top-level.
3. Anything else — missing directory, not a repository, git missing, timeout,
   a throw — gives `{ cwd, cwd }`. It never throws.

`bg-agents.js` attaches both fields to every roster entry (background and
interactive) in `rebuild()`: a cached value, else the pattern result or the
cwd itself, so the roster renders at once. Then `resolveMissingRoots` queues
every cwd not cached nor pending (at most `ROOT_CONCURRENCY` = 4 resolutions
at a time, never awaited by `reconcile`/`get-bg-agents`). A finished
resolution is cached (`rootCache`, a Map per cwd, `ROOT_CACHE_MAX` = 500,
oldest evicted first) and calls `scheduleRebuild()` only when it differs from
the provisional value, so a cwd that resolves to itself costs no change
event. A failure is cached as the cwd, so git is never re-run for a known
cwd until `stop()` (which clears the cache, the queue, and — through
`generation` — drops resolutions still in flight). The resolver is
injectable (`init({ resolveProjectRoots })`) for tests.

Known limits: the cache is never invalidated while the watchers run — a repo
moved or deleted, a directory that becomes a git repo later, or a git call
that timed out once keeps its first answer until the window's `closed`
handler (or a re-init) calls `stop()`. A submodule is grouped as its own
project, not under its superproject. Two different spellings of one path
(symlink, case on Windows) can still make two groups, since the pattern
branch and the fallback keep the cwd's spelling.

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
  input, and (2026-10-01) a fifth, `failed`, for a job that ended in error.
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
