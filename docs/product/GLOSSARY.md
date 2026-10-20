# Glossary

Switchboard as it is at **v0.0.94** (f596e28). One entry per user-facing
concept. Each entry gives:

- **Definition** — one sentence, describing what the product does today.
- **Don't say** — words that must not be used for this concept in UI text, docs
  or issues.
- **Code** — the identifiers that implement it.
- **Today** — where the product uses two words for this concept, or this word
  for two concepts. Finding numbers (M1–M6, m1–m8) refer to
  [CONCEPT-MAP.md § Known incoherences](CONCEPT-MAP.md#known-incoherences).

`file:line` references are against v0.0.94. **V** = read in the code or doc;
**V\*** = read during the audit, not re-read for this file; **S** = supposed
(inferred, not read or not executed).

---

## Conversations and their files

### Conversation

- **Definition**: the exchange between the user and Claude that the `claude`
  CLI records and can resume, possibly spread over several transcripts
  (after `/compact`, after a continuation).
- **Don't say**: "session" when the point is the content rather than a process
  or a row; "chat".
- **Code**: no single identifier. Approximated by a `sessionId` plus
  `mergedMemberIds` (`public/session-activity-dom.js:3-5`) or by a
  `bridgeSessionId` group (`session-cache.js`, `mergeBridgeGroups`).
- **Today**: the product has no word for it. The UI says "session" for it, for
  the process and for the row (m8, M4). The only UI strings that say
  "conversation" include the continuation chooser's Untitled conversation
  fallback (`public/resume-guard.js`), "Delete this background session? Its
  conversation goes…" (`public/agents-view.js:421`).

### Transcript

- **Definition**: one `.jsonl` file the CLI writes under
  `~/.claude/projects/<encoded path>/`, identified by its session id.
- **Don't say**: "log", "history file", "JSONL" in UI text (the button says
  "View messages").
- **Code**: `session_cache` row; `read-session-file.js`;
  `enumerateSessionFiles`.
- **Today**: shown to the user through **View messages**
  (`public/sidebar.js:1790`) and, in the Agents view, **Transcript**
  (`public/agents-view.js:340`) — two labels for the same read-only viewer
  (`showJsonlViewer`, `public/jsonl-viewer.js:737`). The viewer shows one
  transcript only, not a merged row's members (V,
  `.ai/contexts/session-cache.md:113`).

### Session id

- **Definition**: the UUID of one transcript, shown as its first segment on the
  row and in full in the terminal header.
- **Don't say**: "session" alone when the id is meant.
- **Code**: `sessionId` everywhere; `.session-short-id`
  (`public/sidebar.js:1716-1719`); `terminalHeaderId` (`public/app.js:1454`).

### Continuation

- **Definition**: a transcript the CLI continued a conversation into under a
  new session id, detected when the user opens the original.
- **Don't say**: "fork" (a fork is user-initiated), "mirror" (that is the
  `/compact` case).
- **Code**: `resolveResumeSession` (`public/resume-guard.js:46-75`);
  `session-continuations.js`.
- **Today**: proven local linear chains share a row. Real alternatives outside
  the row use one **Open which part?** chooser on manual opens, showing names,
  last activity, known message counts and locations, plus the clicked part.
  Choices are not remembered yet. Automatic restore holds ambiguity with a
  notice; reload never prompts. A same-bridge alternative is not a branch.

### `/clear`

- **Definition**: the CLI command that starts a new transcript in the same
  terminal; Switchboard moves the open terminal's row onto the new transcript
  and leaves the old one as a past row.
- **Don't say**: "reset session", "new session" (the sidebar's "New session"
  is a launch).
- **Code**: `clearOwner` (`.ai/contexts/cli-session-state.md:417-463`).
- **Today**: Linux and Windows re-key the row; macOS still lists the new
  conversation as a separate row (V, `CHANGELOG.md:25`). Third grouping rule
  next to `/compact` and continuations (M4).

### Fork

- **Definition**: a new conversation started from a copy of an existing one,
  under a new session id, the original left unchanged.
- **Don't say**: "branch", "clone", "duplicate".
- **Code**: `forkSession` (`public/dialogs.js:27`); `--fork-session`.
- **Today**: label **Fork session** (`public/sidebar.js:1785`). Kept separate
  from **Respawn** on purpose (different result).

---

## The sidebar

### Sidebar row (session row)

- **Definition**: one entry in a project's session list, standing for one
  transcript plus the transcripts merged into it, with one icon, one name and
  one set of buttons.
- **Don't say**: "tab", "card" (a card is the grid's), "item".
- **Code**: `buildSessionItem` (`public/sidebar.js`, row built at 1655-1827);
  `.session-item`; `rowSessionIds` (`public/session-activity-dom.js:3`).
- **Today**: no doc defines what a row represents; `docs/session-browser.md:86-110`
  describes it as "the session". Users meet it as "session" (M4).

### Merged web-session row

- **Definition**: a sidebar row whose representative transcript carries
  `mergedMemberIds`, the other transcripts that share its `bridgeSessionId`
  (a `/compact` mirror or a claude.ai bridge mirror), plus the parts of a proven
  local linear continuation chain. Branching, remote and cross-project chains
  stay separate.
- **Don't say**: "group" (that is the slug group), "linked sessions".
- **Code**: `mergedMemberIds`, `mergedIntoSessionId`, `bridgeSessionId`
  (`.ai/contexts/session-cache.md:106-131`); `mergedRowSnapshot`
  (`public/session-activity-dom.js:27-36`).
- **Today**: the user-facing name "web-session row" appears in one user doc
  sentence only (`docs/session-restore.md:84`). Activity is OR-ed over members,
  and the live background projection supplies its `bg` badge and head id.
  Pin, name and archive belong to the conversation: any pinned part pins it,
  every part must be archived to hide it, and its newest user rename wins,
  falling back to the representative's name. Each metadata action writes all
  parts together.

### Slug group

- **Definition**: a collapsible header in a project that folds the rows whose
  transcripts carry the same `slug` (the runs of one schedule share it), with a
  count "N sessions".
- **Don't say**: "folder", "merged row".
- **Code**: `buildSlugGroup` (`public/sidebar.js:492`); `.slug-group`;
  `scheduleSlug`.
- **Today**: its only action is **Archive all sessions in group**
  (`public/sidebar.js:549`). Its green dot means "a member has a local PTY"
  (`public/sidebar.js:541-545`).

### Subagent row

- **Definition**: a read-only row nested under its parent session for a
  transcript a Task subagent wrote.
- **Don't say**: "agent" alone (collides with background agent and Agent
  Files, m8), "child session".
- **Code**: `parentSessionId`; `item.dataset.subagent`
  (`public/sidebar.js:1441`); `docs/subagents.md`.
- **Today**: click opens the transcript; no pin, rename, stop, fork, archive
  or delete (`docs/subagents.md:30-32`).

### Pin

- **Definition**: a per-row flag that sorts the row first and keeps it out of
  `+ N older`.
- **Don't say**: "star", "favourite" in UI text.
- **Code**: `starred`, `setStar` (`public/sidebar.js`), `setStarred` (`session-index-store.js`);
  `#star-toggle` "Show pinned only" (`public/index.html:26`).
- **Today**: the code says "star", the UI says "pin" (internal only, nit).

---

## Projects and folders

### Project

- **Definition**: a folder whose sessions the sidebar lists under one header,
  keyed by its path (and by host for a remote project).
- **Don't say**: "repo" (not every project is a git repository), "workspace".
- **Code**: `projectPath`; project header buttons `public/sidebar.js:896-1001`;
  `project:<path>` settings.
- **Today**: also called "folder" in **Archive folder**
  (`public/sidebar.js:915`) and its dialog "Archive <path>?"
  (`public/sidebar.js:1190-1196`); the two words mean the same thing (nit).

### Worktree

- **Definition**: a git worktree of a listed repository, shown as a nested
  header under that repository's project.
- **Don't say**: "branch", "sub-project".
- **Code**: `resolveWorktreePath()` (`derive-project-path.js`);
  `public/worktree-nesting.js`; worktree header buttons
  `public/sidebar.js:988-1001`.
- **Today**: actions **Archive project**, **Delete worktree from disk**,
  **New session in worktree**. The Agents view groups by worktree
  separately (`docs/background-agents.md:43-50`).

---

## Processes and views

### Session

- **Definition (as used today)**: the word the UI uses for a conversation, its
  sidebar row, and the `claude` process running it, without distinguishing
  them.
- **Don't say**: — (this is the overloaded word itself).
- **Code**: `sessionMap` (rows, renderer), `openSessions` (open terminals,
  renderer), `activeSessions` (PTYs, `main.js:240`), `session_cache` (index).
- **Today**: three concepts, one name (m8, M4). Proposed split for future
  changes: **conversation** (content), **row** (sidebar), **process** (what
  runs). Until a change decides, use "session" only where the UI already does.

### Open session (terminal view)

- **Definition**: a session Switchboard has mounted in a terminal view, with or
  without a live process behind it, shown one at a time in the main area.
- **Don't say**: "tab" — there is no tab strip and no close control (V\*,
  audit); "window".
- **Code**: `openSessions` entry (`entry.closed`, `entry.attach`);
  `createTerminalEntry`, `showSession` (`public/terminal-manager.js:1375`),
  `destroySession` (`public/terminal-manager.js:1322`).
- **Today**: docs say "tab" ("attach tab" and
  "terminal tab", both `docs/background-agents.md:125`) and the code says "tab"
  (`rowOpenId`, "non-closed tab"). The user cannot close one; it goes away when
  its process exits (plain terminal) or when another session is opened over it
  (S). → m8.

### Terminal header

- **Definition**: the bar above the open session's terminal: name, id, shell
  profile, sandbox indicator, Refresh screen, Stop/Detach, process status.
- **Code**: `showTerminalHeader`, `updateTerminalHeader`
  (`public/app.js:1451-1470`, `1210-1225`); `public/index.html:111-113`.

### Grid card

- **Definition**: one open session's live terminal shown as a card in the grid
  ("Session Overview").
- **Don't say**: "session" for the card count — but the grid does (m6).
- **Code**: `public/grid-view.js`; `gridCards`; `.grid-card-stop-btn`
  (`public/grid-view.js:191-198`).
- **Today**: "N sessions" in the grid header counts cards, i.e. open
  terminals, not rows (`public/grid-view.js:422`; m6).

### Plain terminal

- **Definition**: a shell (not `claude`) started from **Terminal** in a
  project's `+` menu, listed as a row with a terminal badge, removed when its
  shell exits.
- **Don't say**: "shell session", "console".
- **Code**: `type: 'terminal'`; `plain-terminal-shell.js`;
  `public/app.js:686-707` (removed on exit).
- **Today**: its only row action
  is Stop (`public/sidebar.js:1808-1818`).

### Panel shell

- **Definition**: a shell under the file panel, opened with **Shell** on the
  session tool bar, in the owning session's working directory.
- **Don't say**: "terminal" alone (m8).
- **Code**: `public/panel-terminal.js` (internally also `type: 'terminal'`,
  summary `'Shell'`, `public/panel-terminal.js:251`).
- **Today**: toggling Shell off kills it with no confirmation (audit, V\*).

---

## Lifecycle verbs

### Open (click a row)

- **Definition**: clicking a row shows its open terminal if it has one,
  otherwise attaches to a live background or remote process, otherwise
  resumes the conversation with `claude --resume`, after the continuation and
  live-elsewhere checks.
- **Don't say**: "launch" (that is a new session), "connect".
- **Code**: `openSession` / `openSessionNow` (`public/app.js:1484-1560`);
  `guardResume` (`public/resume-guard.js:20-44`).
- **Today**: one gesture, five outcomes (show, attach bg, attach remote,
  resume, read-only transcript for a remote without tmux); the row does not
  say which in advance except through badge tooltips
  (`public/sidebar.js:1733-1747`).

### Resume

- **Definition**: start a new `claude --resume <id>` process on an existing
  conversation, in its recorded directory.
- **Don't say**: "reopen", "restart", "reattach".
- **Code**: `resumeOptions` (`public/app.js:1551-1553`); **Resume with config**
  (`public/sidebar.js:1805`, `showResumeSessionDialog`
  `public/dialogs.js:421`).
- **Today**: restore is documented as "a respawn, not a reattach"
  (`docs/session-restore.md:90`) — a third verb for the same resume.

### Attach

- **Definition**: connect a terminal view to a process that keeps running
  outside Switchboard's own PTY — a background job (`claude attach <id>`) or a
  remote tmux pane (`ssh -tt`).
- **Don't say**: "resume", "open", "connect".
- **Code**: `attachBgAgent` (`public/agents-view.js:386-394`);
  `entry.attach` (`public/app.js:1553`); `remote-attach.js`.
- **Today**: **Attach** is a button only in the Agents view
  (`public/agents-view.js:340`); elsewhere attach is what a row click does,
  announced only by tooltips: "Background session run by the claude daemon —
  click to attach" (`public/sidebar.js:1746`), "Live session on <alias> —
  click to attach" (`public/sidebar.js:1734`). Attach on an already-attached
  job goes to the open view, without saying so.

### Detach

- **Definition**: leave an attached process running and end only Switchboard's
  client of it.
- **Don't say**: "stop", "close".
- **Code**: `detachPty` via `stop-session` when `session.isAttach`
  (`main.js:1784-1793`); `resolveSessionStop({attach:true})`
  (`public/stop-session-ui.js:9-11`).
- **Today**: offered only for a background attach, only under the label of the
  Stop control; the terminal header reads "Detach (the session keeps
  running)" (`public/app.js:1457`), the row and the grid card still read
  "Stop session". A successful detach of the session on screen hides the
  terminal header (`public/app.js:1074-1077`), so the header never shows the
  result; the recorded header status and grid footer read **Detached**, and
  the banner reads "session detached — it keeps running in the background"
  (`public/process-exit.js`, `public/app.js`, `applyProcessExit`). New liveness
  or job evidence replaces Detached in the footer: **Running in background**,
  **Job done**, **Job stopped**, **Job failed**, or **Not running**. A remote attach
  has a detach in the protocol (`docs/remote-hosts.md:234`) but no control
  (M2).

### Stop

- **Definition (as implemented)**: the square stop control, which ends a local
  process, ends a remote process on its host, or detaches from a background
  job, depending on the session.
- **Don't say**: "kill" in UI text; "close".
- **Code**: `confirmAndStopSession` (`public/app.js:1051-1080`);
  `resolveSessionStop` (`public/stop-session-ui.js:4-13`); `stop-session`
  (`main.js:1784-1797`), `remote-stop-session` (`main.js:1801`); Agents view
  `bgAgentVerb('stop')` (`public/agents-view.js:424-428`).
- **Today**: one word, three behaviours, three labels — "Stop session" (row,
  grid card), "Stop process" (terminal header, `public/index.html:112`,
  `public/app.js:1457`), "Detach (the session keeps running)" (header on an
  attach). The Agents view "Stop" checks for refusals before confirming the
  job name and id, saying its process ends and the conversation is kept,
  then runs `claude stop`. → M2.

### Kill

- **Definition**: not a user verb; the result shown when a process ended on a
  signal: "Killed (SIGNAL)".
- **Code**: `killPty`; `processExitLabel` (`public/process-exit.js:18-23`).
- **Today**: quitting the app kills every local PTY with no confirmation
  beyond unsaved editor edits (`unsavedGuard.beforeQuit`, `main.js:3518`;
  kill loop `main.js:3545-3550`) (M1).

### Archive / Unarchive

- **Definition**: hide a row from the normal list (stopping its process first)
  while keeping its transcript; **Unarchive** brings it back.
- **Don't say**: "hide" (Archive project is a different, project-level action), "delete".
- **Code**: `archived` flag; `archive-session` (`main.js:2291`);
  `stopBeforeArchive` (`public/stop-session-ui.js:39`); row button
  `public/sidebar.js:1780`, handler `1570-1585`.
- **Today**: single-row and slug-group Archive ask once when parts would be
  stopped, naming those parts and their locations; with no stop target they
  run immediately. A background-job refusal precedes the dialog for the
  whole action. Both offer a ten-second Undo for exactly the rows archived;
  stopped processes stay stopped. Folder Archive keeps an idle options dialog
  as configuration without Undo. With nothing to configure it archives at once
  with Undo; after stopping processes its Undo restores the folder, this click's
  sessions and disabled schedules, keeping stopped processes stopped.
  "Archive" also applies to a folder (**Archive folder**,
  `public/sidebar.js:915`), which in addition disables schedules and comes
  back on new activity — kept as one word on purpose (shared filter **Show
  archived sessions**, `public/index.html:28`).

### Delete

- **Definition**: permanently remove something from disk.
- **Don't say**: "remove" for a transcript, "rm" in UI text.
- **Code**: sidebar `delete-session` (`main.js:2230`),
  `showDeleteSessionDialog` (`public/sidebar.js:1881-1905`); Agents view
  `bgAgentVerb('rm')`; `delete-worktree` (`main.js:886`).
- **Today**: three objects — a transcript ("Delete session (removes the
  transcript from disk)", dialog **Delete permanently**,
  `public/sidebar.js:1800`, `1905`), a background job with its conversation
  and worktree ("Delete", native confirm "Delete this background session?
  Its conversation goes, and its worktree when that is safe.",
  `public/agents-view.js:421`), and a worktree ("Delete worktree from disk",
  `public/sidebar.js:994`). Remote rows show the dialog then refuse (m1).

### Archive project / Delete project

- **Definition**: **Archive project** removes a project or a worktree from the
  sidebar and suspends its schedules, keeping its settings, cached sessions and
  schedule registration; **Unarchive** (Settings, Archived projects) restores
  it. **Delete project** drops the project's settings, cache, search index and
  schedule registration; files on disk are never deleted, and the project
  returns only through Add project, with default settings.
- **Don't say**: "hide", "remove".
- **Code**: `archive-project-settings`, `unarchive-project` and
  `remove-project` (`main.js`); **Archive Project** and **Delete Project**
  (`public/settings-panel.js`); worktree **Archive project**
  (`public/sidebar.js`).
- **Today**: Archive runs without asking and offers Undo for about 10 seconds
  in Settings and on a worktree header. Delete confirms in an in-app dialog
  that states what is dropped. A deleted project is not listed under Archived projects.

### Respawn

- **Definition**: restart a finished background job (`claude respawn <id>`).
- **Code**: `public/agents-view.js:155-161`, `340`.
- **Today**: Agents view only. Kept separate from Fork and Resume on purpose.

### Send a prompt

- **Definition**: deliver one prompt to a live remote session through its
  messaging socket, without attaching.
- **Code**: `showSendPromptDialog` (`public/dialogs.js:553-605`);
  `remote-send.js`.
- **Today**: row button **Send a prompt…** on remote rows only
  (`public/sidebar.js:1771`, `1809`). Close in purpose to a trigger, which is
  file-driven and local (S: no shared code read).

---

## Where a session runs

### Background agent (job)

- **Definition**: a `claude --bg` session run by the claude daemon, listed in
  the Agents view with its job id and job state.
- **Don't say**: "agent" alone (m8); "subagent"; "bg session" in UI text (the
  badge says `bg`).
- **Code**: `public/agents-view.js` (`agentsEntryKey` `bg:<jobId>`, line 23);
  `bg-agents.js`, `bg-agents-roster.js`; `bgAgentSessionIds`.
- **Today**: called "background agent" (view toggle "Background agents",
  `public/app.js:1778`), "background session" (badge and confirm,
  `public/sidebar.js:1746`, `public/agents-view.js:421`), "agent" (**New
  agent**, `public/index.html:91`) and "job" (detail meta "job <id>",
  `public/agents-view.js:322`).

### External session

- **Definition**: a live interactive `claude` process that Switchboard did not
  start, seen through the CLI's `~/.claude/sessions/<pid>.json` descriptor.
- **Don't say**: "foreign", "unmanaged".
- **Code**: Agents entry `kind: 'interactive'` → state `external`
  (`public/agents-view.js:60-64`); `cli-session-state.js`.
- **Today**: "External" is a state in the Agents view (🖥️) but a location in
  fact; the sidebar shows the same session as an ordinary row (M3, M5).

### Live elsewhere

- **Definition**: the condition of a session whose conversation is already
  being run by another process (another Switchboard, a terminal outside, a
  background job, a scheduled run).
- **Don't say**: "locked", "busy".
- **Code**: `getSessionLiveElsewhere`; `guardResume`
  (`public/resume-guard.js:20-44`); `.ai/contexts/cli-session-state.md`
  ("Live elsewhere").
- **Today**: scheduled runs and other processes share **Resume anyway** / Cancel,
  with name, pid, folder, start time and schedule name when known; bg: attach
  with a job id, otherwise refused by an error notice; automatic restore:
  skipped. The Agents view's Resume on an External row asks the same question
  (M3).

### Remote host / remote session

- **Definition**: a host declared by ssh alias whose sessions are mirrored
  into the sidebar under the alias badge, attached through tmux when possible,
  read as a transcript otherwise.
- **Don't say**: "server", "SSH session".
- **Code**: `remoteAlias`; `remote-*.js`; `remoteSessionStates`;
  `docs/remote-hosts.md`.
- **Today**: host status dot (green / grey / amber / red, pulsing amber;
  `docs/remote-hosts.md:149-157`); Stop kills on the host after "Stop this
  session on <alias>?" (`public/stop-session-ui.js:6-7`); Delete refused after
  the dialog (m1).

---

## Persistence and automation

### Working set / restore

- **Definition**: the list of open sessions (and which was active) that
  Switchboard saves while it runs and offers to reopen at the next launch.
- **Don't say**: "workspace", "tabs", "layout".
- **Code**: `openWorkingSet` global setting; `persistWorkingSet`
  (`public/app.js:183`); `runRestore` (`public/app.js:267`);
  `public/restore-plan.js`.
- **Today**: "working set" is internal; the UI says "Restore N session(s) from
  last time?" with **Restore** / **Dismiss** (`public/app.js:420-421`) and
  "Not restored: …" (`public/app.js:480-481`). It saves one entry per open
  terminal, not per row (V\*, audit). Attach views are not restored
  (`docs/background-agents.md:128`).

### Schedule (scheduled task)

- **Definition**: a `schedule-<name>.md` file in a project's
  `.claude/commands/` whose cron fires headless `claude -p` runs while the app
  is running.
- **Don't say**: "cron job", "routine", "automation" alone.
- **Code**: `schedule-runner.js`, `schedule-ipc.js`, `run-schedule-now-target.js`;
  `docs/automation.md:14-180`.
- **Today**: "Create scheduled task" (`public/sidebar.js:903`), "schedule" in
  docs and the archive dialog ("Disable the N enabled schedules",
  `public/sidebar.js:1184`), **Run now** in Agent Files. A run is a session
  row in a slug group; it cannot be stopped or attached (m7).

### Trigger

- **Definition**: a JSON file dropped in `~/.switchboard/triggers/` that makes
  Switchboard type a command into an open session's terminal, optionally
  waiting for it to be idle.
- **Don't say**: "hook", "message", "inject" in user docs.
- **Code**: `trigger-watcher.js`, `trigger-context.js`; `docs/automation.md:181-700`.
- **Today**: no UI; `remoteTriggers` is a setting with no UI either
  (`docs/automation.md:406-409`).

---

## State words

The product shows session state through four vocabularies at once (M5). Each
word is listed with the surface that shows it and its source.

| Word (exact) | Surface | Source | Meaning |
|---|---|---|---|
| **Needs your attention** | sidebar icon tooltip | OSC 9 notification text, or a remote descriptor dialog | Claude asked for approval / attention in a session not on screen (`public/session-state.js:8`; `docs/notifications.md:12-14`) |
| **Response ready** | sidebar icon tooltip | working ended while another session was on screen | an unseen result (`public/session-state.js:9`) |
| **Working** | activity icon tooltip | OSC 0 spinner / OSC 9;4, or shared head-turn evidence | Claude is producing a turn (`public/session-state.js`, `renderSessionIcon`) |
| **Active** | Agents state and group (⚙️) | job `working` | the job is active; its turn activity is shown separately by the glyph (`public/agents-view.js`, `AGENT_STATE_META`) |
| **Background work running** | activity icon tooltip | shared task evidence | at the prompt, background tasks still run (`public/session-state.js`, `ICON_BY_RUNG.agentsBusy`) |
| **Waiting for input** | activity icon tooltip | a live session at its prompt, or job `blocked` | a blocked job keeps Blocked in its tooltip and state column (`public/agents-view.js`, `projectBackgroundActivity`, `backgroundActivityLabel`) |
| **Idle** | activity icon tooltip; Agents state and group (💤) | no higher activity rung; done job with a live descriptor (Agents) | the Agents word names a hosted done job, whose activity glyph still follows the shared projection (`public/agents-view.js`, `agentStateGroupKey`) |
| **Not running** | finished background row tooltip in sidebar, grid and Agents; terminal header and grid footer | finished job without a live descriptor (activity); dead liveness without a recorded exit, or after Detached (footer); no PTY and no recorded exit (header) | no user Stop is implied (`public/session-state.js`, `public/agents-view.js`, `public/process-exit.js`) |
| **Liveness unknown** | sidebar and grid icon labels; background row tooltip and accessible name in Agents; grid footer | no terminal job state and no live descriptor (activity); no liveness, exit or dormant evidence (lifecycle) | missing data does not establish process death (`public/agents-view.js`, `projectBackgroundActivity`; `public/process-exit.js`, `lifecycleLabel`) |
| `busy` / `idle` / `waiting` / `shell` | foreground status icon tooltip and accessible name | CLI session descriptor | the CLI's own word and waiting reason; the visible row keeps only reason plus age (`public/sidebar.js`, `public/session-activity-dom.js`) |
| Waiting reason plus age | foreground sidebar row status text | CLI descriptor `waitingFor` when `status` is `waiting`, and `statusUpdatedAt` | `permission prompt · 1m ago`, or `1m ago` alone without a reason; the status slot stays present when empty |
| **Blocked** | Agents state (✋) | daemon job file | job waiting for input (`public/agents-view.js`, `AGENT_STATE_META`) |
| **Done** / **Stopped** / **Failed** | Agents state (✅ ⏹️ ❌) | daemon job file | finished job; Done requires no live background descriptor (`public/agents-view.js`, `agentStateGroupKey`) |
| **External** / **Unknown** | Agents state (🖥️ ❓) | interactive session / missing or unknown job state | a location, and an absence of data, shown as states (`public/agents-view.js`, `agentStateMeta`); the column omits raw descriptor words |
| **Open here** / **Attached here** | sidebar and grid icon labels; grid footer; header (Open here); status bar and filter (open here) | PTY here, ordinary or attached | attached local tabs add "keeps running in the background"; remote tabs add "runs on <alias>" (`public/process-exit.js`, `lifecycleLabel`) |
| **Running in background** / **Running on <alias>** / **Running elsewhere** | sidebar and grid icon labels; grid footer | live job, live remote process, or another live process without a PTY here | job liveness uses the same hosted background contract as `agentJobIsLive` (`public/process-exit.js`, `lifecycleLabel`) |
| **Job done** / **Job stopped** / **Job failed** | sidebar and grid icon labels; grid footer | finished job that is no longer live | wins over an older Detached exit (`public/process-exit.js`, `lifecycleLabel`) |
| **Detached** | recorded terminal header status; grid footer; exit banner | user Detach of an attach client only | the background session keeps running; Agents Stop/Delete reads Stopped instead; finished job or dead liveness replaces Detached on the grid (`public/app.js`, `applyProcessExit`; `public/process-exit.js`) |
| **Stopped** | terminal header; grid footer; exit banner "session stopped" | recorded user Stop of an ordinary process, or local attach client exit after a successful Agents Stop/Delete | neither a Detach nor missing exit evidence (`public/process-exit.js`, `processExitLabel`; `public/agents-view.js`, `runAgentVerb`) |
| **Exited (code N)** / **Killed (SIG)** / **Exited** | terminal header; grid footer; exit banner | recorded process exit | preserved ahead of dead liveness (`public/process-exit.js`, `processExitLabel`, `lifecycleLabel`) |
| **Not reopened · restores on click** | dormant sidebar icon labels; grid footer | dormant entry with no stronger lifecycle evidence | restoring it is a separate action (`public/process-exit.js`, `lifecycleLabel`) |
| `running` / `finished` / `external` | Agents header count | job liveness | "N running · N finished · N external" (`public/agents-view.js:365`) |

Use the sidebar icon words for activity. The grid footer uses the ranked
lifecycle words above; Stopped requires a recorded Stop. Row icon labels carry
the same lifecycle without repeating job or activity words. Idle is a filled
dot, Idle open here adds a small dot below it, and Not running is a dim dash;
waiting and dormant restoration keep their hollow rings.
