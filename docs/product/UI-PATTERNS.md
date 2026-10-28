# UI patterns

How Switchboard shows a concept and lets the user act on it, **as it is at
v0.0.94 (f596e28)**. One section per recurring job. Each section lists every
place that implements the job (`file:line`, valid at f596e28), then the
divergences between those places, then a clearly marked **Proposed
convergence**. Concept names follow [GLOSSARY.md](GLOSSARY.md); where the
glossary and a UI string differ, the UI string is quoted exactly.

Evidence rules: every claim is read in the code at the cited line unless it is
marked **supposed**. The app was not run for this document: no screenshot, no
measured contrast, no measured frame cost. Rendering costs quoted from issues
are the issues' measurements, not re-measured here.

The bricks named below (B1, B2, ...) are defined in
[BUILDING-BLOCKS.md](BUILDING-BLOCKS.md).

References used to judge a pattern: Nielsen's ten usability heuristics (cited
as H1–H10), WCAG 2.2 AA success criteria (cited by number), Windows desktop
conventions, and the internal-consistency rule "one job, one pattern".

---

## 1. State display

### 1.1 The session state

This section reflects #563's shared status vocabulary. Other sections retain
the audit snapshot named at the top of this document.

**Domain model (one).** `public/session-state.js` orders the rungs
`attention > responseReady > busy > agentsBusy > waitingForInput > idle > stale > archived`.
`renderSessionIcon` chooses the activity; `writeIconSlot` in
`public/session-activity-dom.js` writes its classes, glyph, tooltip,
`role="img"` and accessible name. Activity labels are Needs your attention,
Response ready, Working, Background work running, Waiting for input, Idle,
Not running and Archived. Missing evidence can instead read Turn state
unavailable, Activity unavailable or Liveness unknown.

**Merged rows.** The head supplies turn and descriptor evidence. Attention,
background work and liveness can come from other members (`mergedRowSnapshot`).
Sidebar, grid and terminal header use the shared projection rather than a
second busy/liveness vocabulary. A background job's Active state does not by
itself mean that a head turn is open.

**Shared shapes.** All activity slots use `.session-icon` and its rung classes
from `public/style.css`. The header keeps the 6px slot with margins for glyphs
and halos; it adds no separate dot colours or animations.

| State | Slot class | Shared appearance |
|---|---|---|
| Needs your attention | `session-icon--attention` | orange filled LED and halo, blinking at 1 Hz; no visible `!` |
| Response ready | `session-icon--response-ready` | cyan filled dot and glow |
| Working | `session-icon--busy` | animated light-blue braille spinner; violet with busy subagents |
| Background work running | `session-icon--agents-busy` | static violet `⠿` |
| Waiting for input | `session-icon--waiting` | static orange hollow `○`, using `content: attr(data-glyph)`, with no halo |
| Idle | `session-icon--idle` | grey filled dot; green with a small dot below it when `.running` marks a PTY open here |
| Not running (internal rung `stale`) | `session-icon--stale` | opaque grey dash; finished background jobs without a live descriptor produce it in sidebar, grid and Agents, and in the header when selected |
| Archived | `session-icon--archived` | reserved, unused; base dot at 0.5 opacity |

A dormant sidebar row keeps its hollow green restoration ring. Waiting, Idle,
Idle open here and Not running have distinct shapes, beyond colour or opacity.
On Agents rows, `.running` follows the job's live flag rather than a PTY here.
A background job with neither a terminal state nor a live descriptor reads
Liveness unknown instead of asserting that it is Not running.

**Activity and lifecycle.** Sidebar, grid and terminal header icon labels read
`<activity> · <lifecycle>` through `lifecycleLabel` in `public/process-exit.js`.
The ranked lifecycle distinguishes Open here, Attached here (with local or
remote location), finished job outcomes, Running in background, Running on
<alias>, Running elsewhere, Not running, Detached, recorded exits, Not reopened
and Liveness unknown. A finished job or known dead liveness replaces an older
Detached record. A missing PTY alone does not prove process death. Duplicate
words are omitted. The sidebar alone adds the raw CLI word and waiting reason
in a `CLI status:` tooltip/accessible-name suffix; visible foreground text
keeps reason plus age, or age alone.

| Surface | Mark | Words and updates |
|---|---|---|
| Sidebar row | shared activity slot (`public/sidebar.js`, `buildSessionItem`) | activity and ranked lifecycle in tooltip and accessible name; reason plus age on foreground rows, job detail on background rows |
| Agents row | shared activity slot plus job-state emoji and word (`public/agents-view.js`, `renderAgentRow`) | activity in tooltip and accessible name; Title Case state Active, Blocked, Idle, Done, Stopped, Failed, External or Unknown; a blocked job keeps Blocked in its waiting label |
| Grid card | `.grid-card-dot.session-icon` (`public/grid-view.js`, `updateGridCardActivity`) | activity and lifecycle in icon labels; ranked lifecycle in footer; Stop depends separately on liveness |
| Terminal header | `#terminal-header-status.session-icon` (`public/session-activity-dom.js`, `paintTerminalHeaderStatus`) | activity and lifecycle in tooltip and accessible name, no visible text; repaints with the active row, including merged-member updates, without waiting for a poll; also works when that row is filtered out |
| Terminal banner | text (`public/app.js`, `applyProcessExit`) | recorded Stopped, Exited (code N) or Killed (SIG); Detach says the session keeps running in the background |
| Agents group/header | emoji and Title Case label; counts (`public/agents-view.js`) | Active/Blocked/Idle/Done/Stopped/Failed/External/Unknown groups; N running · N finished · N external |
| Status bar/filter | text (`public/app.js`, `public/index.html`) | N open here · N sessions · N projects; Show sessions open here only |
| Slug-group header | `.slug-group-dot` (`public/sidebar.js`) | separate pulsing green mark when any child has a PTY; N sessions and time |
| Remote host | `.remote-host-dot` (`public/style.css`) | separate reachability mark: green, red error, amber unknown, pulsing amber connecting |

**Convergence delivered (#563).** The four session surfaces share the activity
slot. Lifecycle/location is a separate label, CLI words stay in the tooltip,
and Detach has its own exit wording. M5 and the grid's Stopped-with-Stop
incoherence m3 are resolved. Separate Detach/Stop controls followed in #546
(M2 resolved, §2.1); the remaining reduced-motion and host/group indicator
questions are outside this change.

**Open divergence — WCAG 1.4.1 (Use of Color).** The slug-group dot is
colour-only: its green mark distinguishes a group with a PTY, without a
non-colour cue for that state. The session count and time do not express it.

### 1.2 Other states shown with a mark

| Concept | Where | Mark | Text |
|---|---|---|---|
| Changes file state | Changes panel (`.ai/contexts/changes-view.md:859`) | porcelain letter badge on `--control-surface`, coloured | state name in tooltip — letter kept so colour is not the only cue |
| Diff waiting for an answer | tool bar Diff (`tool-bar.js:74-80`) | `data-badge="pending"` | `aria-description="Claude is waiting for your answer"` |
| Sandbox | terminal header (`index.html:113`) | text chip `Sandbox` | ~900-character tooltip |
| Archived row | sidebar (`style.css:1291-1292`) | row opacity 0.55 | none |
| Missing project | sidebar (`sidebar.js:1416-1421`) | `.disabled` row | `Project path no longer exists — use "Change path" to fix` |

The Changes badge is the one place that already meets "never colour alone".

---

## 2. Actions — verbs, placement, availability

### 2.1 Lifecycle verbs on a session

| Control | Where | Label (title) | Icon | Effect | Confirmation |
|---|---|---|---|---|---|
| Row Stop | `sidebar.js` row handler | `Stop session` | red square | `confirmAndStopSession` (`app.js`): stop every eligible part, including background jobs attached here or not; local PTYs and remote processes keep their routes | Fresh job checks before one danger confirmation naming the count, locations, job ids and process loss, with the conversation kept. Refusals and unknown checks explain exclusions; Retry targets only failures; an empty plan shows a notice |
| Grid Stop | `grid-view.js` | `Stop session` | red square | Same routes, targeting only the card's tab; an attached background agent ends | One confirmation naming this session and what ends |
| Header Stop | `index.html`, `app.js` | `Stop session` | red square | Same routes, targeting only the header's tab | Same as Grid Stop |
| Row / Grid / Header Detach | `sidebar.js`, `grid-view.js`, `app.js` | `Detach (the session keeps running)` | neutral eject | `detachSession`: detach open background attach clients; row gathers every attached part, card and header target only their tab | None; each successful detach offers Undo for 10 s |
| Agents Stop | `agents-view.js` `runAgentVerb` | `Stop` | text button | `claude stop` on the job | Fresh refusal check, then danger `appConfirm` naming the job and id, the process ending and the conversation kept |
| Agents Attach | `agents-view.js` `attachBgAgent`; button or double-click | `Attach` / `Go to tab`; title = aria-label | text | open an attach tab; when already attached here, find the open tab by job id and show it, including when its key differs from the roster session id | none |
| Row click | `sidebar.js:1431-1439` | none | none | subagent → transcript; remote not attachable → transcript; else open/resume/attach; already-open member → show it (`app.js:1502-1506`); a second click while the first open is in flight joins it (`app.js:1481-1496`) | continuation and live-elsewhere prompts (§5) |
| Remote Detach | sidebar row, grid card, terminal header | `Detach (the session keeps running on <host label>)`; title = aria-label | neutral eject | `stopSession` detaches the local tmux attach client; exit reads Detached and names the host | None; Undo for 10 s if remoteAttachable, through the row-click opening path; otherwise information only |

**Divergences.**
1. Background Stop and Detach now have separate controls and accessible names
   on row, grid and header. If the daemon reports an attached job as not hosted,
   Stop explains before confirmation that only its tab detaches; it reads Detached.
   A detach-only plan uses a non-danger `Detach tab?` dialog with a `Detach`
   button, including Retry after the job stopped. A mixed plan keeps the danger
   `Stop session?` dialog and `Stop` button.
2. Detach uses a neutral eject icon and no confirmation; Stop uses a red square
   and one confirmation everywhere. Remote Detach names the host on all three surfaces.

**Proposed convergence.**
- Two verbs, two controls, the same everywhere:
  **Stop** (red square, confirm naming what ends and where) and **Detach**
  (neutral eject icon, no confirm, reversible), offered wherever a view can
  be let go without ending the process (bg attach, remote attach).
- Agents Stop goes through the same confirmation as every Stop (implemented).
- Keep merged-row Stop as one confirmation naming all targets and exclusions;
  grid and header Stop keep targeting only their tab.
- `Attach` reads `Go to tab` when an attach tab is already open (implemented,
  decision 2026-10-22, #546). The same button and `data-verb="attach"` survive
  roster renders; only its label and accessible name change.

### 2.2 Archive, Delete

| Control | Where | Label | Effect | Confirmation |
|---|---|---|---|---|
| Row Archive | `sidebar.js` (`session-archive-btn`, `archiveSessionRows`) | `Archive` / `Unarchive` | checks every part for background jobs, stops planned targets, then archives; Undo restores the row, leaving stopped processes stopped | one danger confirmation naming targets and locations when there are targets; otherwise instant; ten-second Undo either way |
| Slug-group Archive | `sidebar.js` (`slug-group-archive-btn`, `archiveSessionRows`) | — (archive icon) | checks the whole group before any dialog; archives eligible rows; Undo restores exactly this click's successful rows | one danger confirmation for the whole group when there are targets; otherwise instant; ten-second Undo either way |
| Folder Archive | `sidebar.js:1143-1235` | `Archive folder` | stops + archives sessions, disables schedules | `showChoiceDialog` (`sidebar.js:1190-1197`), names running sessions and places, refuses background jobs before the dialog, and offers Undo after stopping processes or archiving an empty folder |
| Row Delete | `sidebar.js:1525-1568`, button `1798-1801`, dialog `1881-1945` | `Delete session (removes the transcript from disk)` → `Delete permanently` | stop then delete transcript; refused up front on a merged row with a live member (`1529-1533`) | custom modal with preview of what goes |
| Agents Delete | `agents-view.js` `runAgentVerb` | `Delete` | `claude rm` (conversation + worktree when safe) | Fresh refusal check, then danger `appConfirm`; refusal stays in the detail without a dialog |
| Worktree Delete | `sidebar.js:1337-1352`, dialog `1949-2017` | `Delete anyway` | `git worktree remove` | custom modal with dirty-file list |
| Worktree Archive project | `sidebar.js` (`worktree-hide-btn`) | `Archive Project` | removes the row, keeps settings and cache, suspends schedules; reversible from Settings | no confirmation; 10-second Undo notice |
| Project Archive | `settings-panel.js` (`sv-archive-btn`) | `Archive Project` | same | no confirmation; 10-second Undo notice |
| Project Delete | `settings-panel.js` (`sv-delete-btn`) | `Delete Project` | drops settings, cache, search index and schedule registration; no file on disk is deleted | `showChoiceDialog`, danger style, focus on Cancel |
| File delete (Agent Files / Work Files) | `viewer-panel.js:284` | — | delete file | danger `appConfirm`, `Delete "<name>"?` / `This cannot be undone.`, button `Delete` |
| Trace file delete | `activity-trace-panel.js:120` | — | delete file | same wording |

**Divergences.**
1. Row and slug-group Archive now distinguish reversible archiving from
   stopping processes: only the latter asks first. Folder Archive retains
   an options dialog, naming running local and remote sessions and places.
   It is danger only when processes could be stopped; an idle configuration
   dialog has no Undo. Empty-options Archive runs immediately with Undo.
   After stopping processes, Undo restores the folder, this click's sessions
   and schedules disabled; stopped processes stay stopped.
2. Two delete confirmations: custom modal with preview (session, worktree),
   and `appConfirm` (Agents, files; the OS `confirm` is banned since #589).
   The confirm button says `Delete permanently`, `Delete anyway`, or `Delete`.

**Proposed convergence.**
- Row and slug-group Archive use B5 for planned stops and B8 for Undo;
  background-job refusals precede the dialog. Undo never restarts processes.
- Every destructive confirmation uses B5 (`danger`), names the object, says
  what goes and what is kept, and labels the confirm button with the verb
  (`Delete`, `Stop`), never `OK`.

### 2.3 Other verbs

| Job | Names in use | Where |
|---|---|---|
| Read a transcript | `View messages` | `sidebar.js:1790` |
| | `Transcript` | `agents-view.js:340` |
| | `click to read its transcript` | `sidebar.js:1736-1737` (remote badge) |
| Delete | `Delete session (…)` / `Delete permanently` | `sidebar.js:1800, 1905` |
| | `Delete` | `agents-view.js:340` |
| Stop | `Stop session` / `Stop` | `sidebar.js:1766`, `app.js` (`terminalStopBtn`), `agents-view.js:340` |
| Resume with options | `Resume with config` | `sidebar.js:1805` |
| Fork | `Fork session` | `sidebar.js:1785` |
| Respawn | `Respawn` | `agents-view.js:340` |
| Send to a remote session | `Send a prompt…` | `sidebar.js:1771` |
| Open on the web | `Open on claude.ai` | `sidebar.js:1795` |
| Refresh screen | `Refresh screen` | `index.html:111`, `sidebar.js:1628` |

`Agent Files` (sidebar tab, `index.html:18`) sits next to the `Agents` view:
two different concepts named by one word (CONCEPT-MAP m8).

**Proposed convergence.** One verb table, owned here and aligned with the
glossary: `Transcript` everywhere for reading a transcript; `Delete` with the
same dialog; `Stop` / `Detach` per §2.1. The `Agent Files` rename is a
product-model decision.

### 2.4 Unavailable actions: hidden or disabled, and why

| Control | Unavailable when | Treatment | Reason shown? |
|---|---|---|---|
| Header Refresh | no PTY | disabled + `aria-disabled` (`app.js:1219-1222`) | yes: `Open this session in a terminal to refresh its screen` |
| Context-menu Refresh | no open tab for the row or a member | disabled (`sidebar.js:1629-1631`) | yes, same text |
| Remote New session | launch tier unavailable | disabled (`sidebar.js:936-939`) | yes: `New session unavailable on <host>: <reason>` |
| Remote Send | send blocked | disabled (`sidebar.js:1773-1776`) | yes: `Send unavailable: <reason>` |
| Agents Respawn / Delete | conversation live in a pid | disabled (`renderAgentDetail`, `agents-view.js`) | pid and recovery: Stop on its sidebar row here, or end the other process |
| Agents Respawn / Delete | job live | disabled | **no** (`reason()` returns `''`, `agents-view.js:317`) |
| Agents Attach / Stop | job finished or daemon unreachable | disabled (`agents-view.js:157-158`) | **no** (the daemon banner covers only the second case, `agents-view.js:366-369`) |
| Agents Transcript | none available | disabled | yes |
| Tool bar Changes / Diff / Touched / Shell | no owning session | disabled (`tool-bar.js:70-71`) | **no** — title stays `<Tool> (<shortcut>)` (`tool-bar.js:73`) |
| Tool bar Diff | no diff open or pending | **hidden** (`tool-bar.js:75`) | — |
| Agents `Worktrees` checkbox | group ≠ Project | disabled (`agents-view.js:364`) | **no** (opacity, `style.css:1742`) |
| Changes Save | read-only, saving, or clean | disabled (`file-panel.js:1908`) | **no** |
| Row Stop | not running/alive | **hidden** (`style.css:1266-1273`) | — |
| Grid Stop | not running/alive | **hidden** (`app.js:1206`, `grid-view.js:195`) | — |
| Header Stop | no PTY | **hidden** (`app.js:1218`) | — |
| Row Delete on a merged row with a live member | a member is live | refused before its confirmation (`sidebar.js`) | persistent B8 notice naming the reason and recovery |
| Row Delete on a remote session | always | **not appended**; context menu offers no Delete | main retains the read-only guard for direct requests |
| Row Send | not alive or attached | hidden (`style.css:1275-1281`) | — |
| Row Resume with config | PTY running | hidden (`style.css:1283-1285`) | — |

**Divergences.** No rule decides hide vs disable; disabled controls give a
reason in some places and not in others; one control is enabled only to be
refused on click.

**Proposed convergence.** Rule: in a fixed action set (detail panel, header,
tool bar, dialog), **disable with a reason** (`title` = why + what to do), as
Refresh does. In an action bar revealed by hover or keyboard focus (`:focus-visible`), **hide**. A control that will refuse is
disabled up front, never enabled-then-refused. Refusal texts name an existing
control.

---

## 3. Feedback

Since #589 (after this document's baseline) the renderer has no native
`confirm`, `alert` or `prompt`: ESLint forbids them (`eslint.config.js`,
`no-restricted-globals`) and every question goes through `appConfirm`,
`appAlert` or `appChoose` (`public/app-dialogs.js`) over `showChoiceDialog`.
Hand-built modals register with the modal stack (`registerModal`,
`public/modal-stack.js`), which gives them initial focus, a Tab trap, Escape
and return focus. The `window.alert` and `window.confirm` rows below, and §4's
focus notes, record the v0.0.94 baseline; see `.ai/contexts/app-dialogs.md`
for the current dialogs.

**Shared notices (#566, S3).** `public/app-notices.js` provides B8 through
`showAppNotice({ id, kind, message, actionLabel, onAction })` and
`clearAppNotice(id)`. Notices stack at the bottom right, wrap long text and
replace only an earlier notice with the same id. Errors use `role="alert"`
and persist until Dismiss, their action or an explicit clear; information
uses `role="status"` and expires after 15 s. The #604 `Archived, but not
stopped` notice now uses this persistent error variant, with its wording
unchanged and no console-only duplicate.

Stop, Detach, Delete and Archive failures use B8 and clear only the successful
action's own notice. Run now reports success only after an `ok` reply; a refusal,
rejected IPC or absent result restores the button and leaves a B8 error naming
the schedule, reason and how to retry. Restore's pending indexing notice clears
after its retry runs; an early return moves held members into persistent
`Restore:batch`, with "Open it from the sidebar to retry restoring" (#666).

The Undo variant (`kind: 'undo'`) lasts 10 s and uses `role="status"`. Its
caller supplies the undo callback, `actionLabel: 'Undo'`, and text explaining
the completed action. Undo and Dismiss are keyboard-reachable native buttons
with visible focus; the notification does not take focus. The action runs
once and removes the notice. Detach Undo reopens the captured job in its original
attach cwd, waiting for the local client's exit if needed. Archive wiring follows
in S8; restore
and update toasts remain separate until #441's follow-up. The table below
records the other feedback mechanisms from the measured baseline.

| Mechanism | Where | Notes |
|---|---|---|
| B8 persistent action failure | Stop/Detach, Delete, Archive and restore (`app.js`, `sidebar.js`) | reason and recovery stay visible after pointer leave; successful actions clear their own member |
| B8 persistent Run now failure | `buildMemoryItem` (`memory-workfiles-view.js`) | restores the play button; no success check mark or Launched! on failure |
| Button flash success | `flashButtonText` (`viewer-toolbar.js:28-39`): `Saved!` (`file-panel.js:446, 2089`, `viewer-toolbar.js:266`), `✓` / `Copied!` (`viewer-toolbar.js:271, 276`) | on `.icon-btn` it always flashes **green**, whatever the text; today no `Failed` caller is an `.icon-btn` (verified from the caller list) |
| `window.alert` | 12 sites: `sidebar.js:1158, 1225, 1227, 1230, 1305, 1349`; `viewer-panel.js:290, 293`; `file-panel.js:448, 451`; `activity-trace-panel.js:70, 133` | blocking, OS-styled |
| Inline error, persistent | Agents (`agents-view.js:349`, `.agents-detail-error`); dialog error lines (Add project `dialogs.js:647-665`, New agent `dialogs.js:803-875`); worktree dialog `.dwt-error` (`sidebar.js:1985, 1999`) | stays until the next attempt |
| Toast / notice | `.restore-toast`: restore ask (`app.js:418-443`), cold-cache wait (`447-455`), `showRestoreNotice` (`457-472`, 15 s, `LIVE_ELSEWHERE_NOTICE_MS`, `app.js:156`) used by Not restored (`474-483`) and Not reopened (`485-498`); `#update-toast` (`index.html:127-131`, `app.js:1968-1982`) | two toasts with copy-pasted CSS (`style.css:78-96` and `137-154`) at the same position (bottom 32 px, right 12 px): they can overlap (supposed). `.restore-toast-msg { white-space: nowrap }` (`style.css:154`) on multi-part notices (supposed overflow). No `role="status"` / `aria-live` anywhere |
| Banner | indexing (`index.html:40-43`, dismissible); Agents daemon banner (`agents-view.js:366-369`, orange text) | |
| Status bar text | info (`app.js:1870-1879`), activity from main (`1881-1890`), updater (`1947-1950`, e.g. `Update check failed`, 5 s) | |
| Text in the terminal | exit banner (`app.js:681`) | wording assumes a kill (§1.1 divergence 6) |
| Empty-or-error panel text | `.plans-empty` used for both (`jsonl-viewer.js:758` error, `789` empty) | |

**Divergences.** Five ways to report a failure, two of them effectively
invisible (console-only; a flash inside a hidden bar). Success and failure
share one flash helper that colours by class, not by outcome.

**Proposed convergence.**
- Failure next to the thing that failed, persistent until the next attempt
  (B9) where a panel exists; otherwise a notice (B8) with the reason and
  what to do. Never console-only, never a hover-only flash, never a success
  colour.
- One notice brick (B8) for restore, update and errors, stacked (not
  overlapping), wrapping text, `role="status"` (info) or `role="alert"`
  (error).
- The 12 `alert()` calls migrate to B9 or B8.

---

## 4. Dialogs and prompts

| Implementation | Instances | Semantics and focus |
|---|---|---|
| `window.confirm` | **17**: `app.js:1054`; `resume-guard.js:33, 42, 56, 62, 68, 72`; `agents-view.js:421`; `sidebar.js:1302, 1332`; `settings-panel.js:704`; `viewer-panel.js:283, 473, 594`; `file-panel.js:438, 1456`; `activity-trace-panel.js:120` | OS dialog, buttons always OK / Cancel |
| `.new-session-overlay` hand-built modals | `dialogs.js:180, 334, 425, 555, 717`; `sidebar.js:1888, 1955` | no `role="dialog"`, no initial focus, no focus trap, no return focus; Escape via a document listener (`dialogs.js:314, 415, 546, 614, 684, 892`; `sidebar.js:1942, 2012`); overlay click closes |
| `.add-project-overlay` | `dialogs.js:624`; `file-panel.js:642` | same |
| `showChoiceDialog` | **1 use** at v0.0.94: folder Archive (`sidebar.js:1190`); since #589 also every `appConfirm` / `appAlert` / `appChoose` (`app-dialogs.js`) | `role="dialog"`, `aria-modal`, `aria-labelledby`, focus trap, Escape, Enter, return focus, `danger` variant, verb-labelled confirm, remembered checkboxes (`choice-dialog.js:15-135`) |
| `.modal-overlay` | Touched info (`touched-files-view.js:133-134`), What's new (`whats-new.js:60`) | `role="dialog"`, `aria-modal` |
| Popover menu | session context menu (`sidebar.js:1620-1644`), terminal context menu | `role="menu"` / `menuitem`, Escape, outside click |
| New session popover | project and worktree + buttons (`dialogs.js`, `showNewSessionPopover`) | `role="menu"` / `menuitem`; opener has `aria-haspopup="menu"` and `aria-expanded`; first item focused on open; Up/Down wrap, Home/End select edges, Enter/Space activate; Escape closes and refocuses +; focusout to outside and outside click close |

**Prompt rules as they are.**
- Continuations: one B6 radio chooser with names, last activity, known message
  counts and location words, newest enabled part preselected. Open has focus;
  Cancel opens nothing. The clicked part is an option. Unknown data is stated,
  and a background part without an identifiable job is disabled with a reason.
  A manual open asks again every time (the `resolutions` cache is used only
  for automatic opens, `resume-guard.js:50-53`; `app.js:1507-1509`). Since
  #539 a double click runs one open, not two (`app.js:1481-1496`), and an
  open tab of the row or a member is shown without any prompt
  (`app.js:1502-1506`).
- `resume-guard.js:33` uses `confirm` as an information message: OK and
  Cancel do the same thing.
- Cancel wording: `Cancel` everywhere except the Send prompt dialog, `Close`
  (`dialogs.js:573`).
- Default focus: `showChoiceDialog` focuses the confirm button by default
  (`choice-dialog.js:21, 133`), including for the folder Archive
  (`sidebar.js:1195`); the hand-built modals set none.

**Divergences.** Several hand-built dialogs still coexist with the shared shell.
Continuation selection now uses the shared accessible radio chooser rather than
one yes/no question per candidate.

**Proposed convergence.**
- One dialog shell (B5's) for every modal: confirmation, form (B7), chooser
  (B6).
- Continuation choice: B6 is now used on manual opens. Remembering and
  revalidating a choice across opens and restarts remains future work.
- An information-only case is a notice (B8), not a `confirm`.
- Default focus: Cancel for `danger`, confirm otherwise.
- `Cancel` for every dismiss button of a dialog that can change something;
  `Close` only for a dialog that only shows.

---

## 5. Lists and rows

| List | Row anatomy, in order | Selection / open | Keyboard | Grouping, folding | Empty state |
|---|---|---|---|---|---|
| Sidebar sessions (`buildSessionItem`, `sidebar.js:1655-1827`) | pin · state slot · [badges `terminal` / `bg` / remote alias] name · meta (`time · N msgs`, short id, status) · action bar revealed by hover or keyboard focus (`:focus-visible`) (up to 8 icon buttons, `1808-1818`) | click opens/resumes/attaches/reads (`1431-1439`); active row highlighted; dblclick on name renames (`1460-1463`); right-click menu (`1444-1448`) | **none on rows**; action buttons tabbable, visible while a button has keyboard focus (`:focus-visible`), with a focus ring on that button (`style.css`, `.session-actions:has(:focus-visible)`, `:where(button:focus-visible)`); a shortcut cycles open sessions (`grid-view.js:560-575`) | project → worktree → slug group (`buildSlugGroup`, `sidebar.js:492`) → subagents; slug-group header click toggles, not focusable (`1382-1386`); rows with a PTY promoted to the top of a group (`563-570`) | `Select a session from the sidebar to begin.` (`index.html:54`, main area) |
| Agents (`renderAgentRow`, `agents-view.js:213-231`) | state slot · name · agent · emoji + state word · cwd · age | click selects; dblclick attaches (`563-569`) | group headers focusable, Enter/Space (`270, 570-576`); **rows not focusable**; verbs need a selected row | none / state / project, worktree sub-groups, persisted collapse | `No background agents. claude --bg starts one, or New agent.` even when rows are only hidden by the Finished filter (`374-376`) while the header counts them (`365`) |
| Grid cards (`grid-view.js:170-215`) | dot · name · project · Stop · terminal · footer (`Running`/`Stopped`, date) | mousedown focuses; dblclick header → single view | arrows via shortcut | grouped by project or flat (`index.html:120`, `aria-pressed`); a merged row with two open members gives **two** cards (`grid-view.js:338-355`) | — |
| Changes, Touched | file rows with state badge | click opens diff | see `.ai/contexts/changes-view.md` | | `No changes` / `No changes in the session directory` (`file-panel.js:1505`); `No files touched by the file tools` (`touched-files-view.js:387`) |
| Transcript viewer | messages | — | — | — | `No messages found in this session.` (`jsonl-viewer.js:789`); error in the same style (`758`) |

**Divergences.**
1. Three markups for the same name/state/project triple (sidebar row, Agents
   row, grid card).
2. Folding: Agents headers are buttons with `aria-expanded`; sidebar slug
   and project headers are clickable `div`s, not focusable.
3. Empty states: some say why and what to do (Agents, Stats), one is wrong
   when a filter hides rows (Agents), errors share the empty style.
4. Filter toggles (`index.html:25-28`) show state by `.active` only
   (`app.js:822-838`); the grid toggle and tool toggles set `aria-pressed`
   (`index.html:120`, `header-controls.js:62-67`).
5. A merged row in the grid becomes one card per open member: the grid
   counts terminals, not rows (CONCEPT-MAP m6).

**Proposed convergence.**
- One row brick (B3) with variants; Agents rows and grid card headers use its
  name/state/project part.
- Rows focusable (roving `tabindex`), Enter opens/selects.
- Every folding header is B10 (Agents' model).
- Every list has three states: empty (why + next action, filter-aware),
  loading, error (distinct style).
- Every toggle is B13 with `aria-pressed`.

---

## 6. Layout, tokens, rendering

**Tokens.** 21 custom properties in `:root` (11 colour, 10 size; `style.css:5-26`),
`var(--` used 257 times; **118 distinct hard-coded hex colours**. State
colours are literals, repeated: `#3ecf5a` (green), `#e05070` (red),
`#6a6a80` (grey), `#4fc3f7` (busy blue), `#f0a050` (attention orange). One
helper hard-codes green inline (`viewer-toolbar.js:31-32`). The chrome is
dark only; terminal themes live apart (`terminal-themes.js`).

**Buttons.** At least six button styles: `.icon-btn` (shared with the filter
toggles, `style.css:2132-2160`), `.control-btn` / `.fp-toolbar-btn`
(`2189-2215`), `.new-session-start-btn` / `.new-session-cancel-btn`,
`.delete-worktree-confirm-btn` (danger), `.popover-option` (`4528`), the
row-action buttons (`.session-*-btn`, `1181-1290`), `.restore-toast-btn`
(no CSS rule of its own: `grep -c '\.restore-toast-btn' style.css` → 0).
`showChoiceDialog` borrows `whats-new-header`, `new-session-actions` and
`delete-worktree-confirm-btn` from other dialogs (`choice-dialog.js:38, 74,
81`).

**Focus.** Base ring `:where(button:focus-visible)` (`style.css:50-53`);
`outline: none` on 7 selectors, none of them a button. Action buttons retain
the shared ring on keyboard focus (`:focus-visible`), including
`.session-launch-config-btn`.

Fixed `F6` moves focus from any terminal (single view, grid or panel shell) to
the active sidebar row, or the first visible enabled sidebar control. The row
is made programmatically focusable without adding a Tab stop. `Shift+F6`
returns from the sidebar or body to the visible active terminal. Neither acts
while a dialog is open. Both are intercepted in the renderer
before xterm writes to the PTY; see `docs/keyboard-shortcuts.md`.

**Motion.** Braille spinner animating `content` (`style.css:1032-1054`),
LED blink (`1321`), `pulse-dot` at 2 s (`880`), 1.5 s (`1842`) and 1 s
(`4629`), four rotating spinners (`504`, `2629`, `2731`, `3388`),
`loading-pulse` (`352`), toast slide-in (`93`, `152`). No reduced-motion
path.

**Hot paths.** Open at f596e28 (`gh issue view`, all OPEN; measurements are
the issues'): #543 whole-sidebar rebuild on every `projects-changed`
(0.6–0.7 s at 900 sessions; each row builds its SVG buttons by `innerHTML`,
`sidebar.js:1764-1806`); #544 the braille spinner animates `content`, forcing
style and layout; #545 every grid card refits on undebounced `resize`/`focus`.
`transition: all` ×40 (supposed small cost). `:has()` handles the disabled
Agents worktree toggle and reveals the session and file-panel action bars
on keyboard focus (`:focus-visible`).

**Proposed convergence.**
- State and text-tier colours as tokens (`--state-busy`, `--state-attention`,
  `--state-ready`, `--state-live`, `--state-idle`, `--state-agents`,
  `--danger`, `--text-secondary`), replacing the repeated literals; secondary
  text raised to 4.5:1 and icon buttons to 3:1 against `--surface-chrome`
  (contrast computed from CSS only, not rendered).
- One button brick (B4) with variants (icon, text, primary, danger, toggle).
- One spinner (B12) animating `transform` only, paused under reduced motion;
  attention becomes a static high-contrast mark.
- B3 rows built from a cloned `<template>` (the brick-level part of #543).
