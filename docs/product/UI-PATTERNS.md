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

**Domain model (one).** `public/session-state.js:4` orders the rungs
`attention > responseReady > busy > agentsBusy > waitingForInput > idle > stale > archived`;
`ICON_BY_RUNG` (`session-state.js:7-16`) gives each rung a slot class, a glyph
and a title: `Needs your attention`, `Response ready`, `Working`,
`Subagents running`, `Waiting for input`, `Idle`, `Stale`, `Archived`.
`renderSessionIcon` projects a snapshot onto one rung. The sole DOM writer of
the row classes is `public/session-activity-dom.js` (header comment, line 1).

**Merged rows (since #547/#551).** A sidebar row may stand for several
transcripts (`mergedMemberIds`). Its state is the OR of the members' flags,
and it is alive if any member is (`session-activity-dom.js:27-36`); the row
is built from that merged snapshot (`sidebar.js:1661-1673, 1694-1697`).

**Static rung mapping (issue #563, step 1).** Sidebar session/subagent slots
and Agents rows show waiting as an orange hollow ring in a fixed 6px box, using
`content: attr(data-glyph)`. Idle keeps the base filled dot: grey without
`.running`, green with it. The ring and filled dot differ in shape without
relying on colour or opacity. No animation is added.

| State | Slot class | Sidebar | Agents view |
|---|---|---|---|
| Waiting for input | `session-icon--waiting` | orange hollow `○`, no halo | same |
| Idle | `session-icon--idle` | base grey filled dot; green with `.running` | green filled dot for a live idle job |
| Stale | `session-icon--stale` | not produced | base grey filled dot at 0.5 opacity for a job that is not live |
| Archived | `session-icon--archived` | reserved, unused | reserved, unused; same rule as stale |

`--state-waiting` is in `:root` and is shared with the attention orange.
Terminal light/dark themes do not change these slots. Grid cards use
`.grid-card-dot`, so their Running/Stopped projection remains separate.

**Projections (several).**

| Surface | Mark | Busy | Waiting for input | Attention | Response ready | Open here / alive | Ended | Text |
|---|---|---|---|---|---|---|---|---|
| Sidebar row | `.session-icon` slot (`sidebar.js:1693-1697`) | light-blue braille spinner, animated `content` (`style.css:1025-1054`) | orange hollow `○` | orange blinking LED, 1 Hz, endless (`style.css:1318-1328`) | cyan glowing dot (`style.css:1297-1316`) | green filled dot with `.running` when a PTY is open here (`sidebar.js:1694`); idle has no override | base grey idle dot; stale/archived not produced | raw CLI status word + reason + age, e.g. `waiting · <reason> · 3 min` (`sidebar.js:1721-1727`) |
| Sidebar row with live subagents | same slot | violet static `⠿` (`style.css:1072-1090`); JS glyph is `◆` (`session-state.js:11`) | — | — | — | — | — | — |
| Slug-group header | `.slug-group-dot` (`sidebar.js:545`) | — | — | — | — | **pulsing green** when any child has a PTY (`style.css:875-881`) | hidden | `N sessions` + time |
| Agents view row | `.session-icon` slot **+** emoji **+** word (`agents-view.js:224-227`) | spinner | orange hollow `○`; a `blocked` job is mapped to this rung (`agents-view.js:140-149`) | not mapped | not mapped | green filled dot for a live idle job (`.running`) | dim grey filled dot (`stale`) | `⚙️ working · busy`, `🖥️ external · idle`, `?` |
| Agents group header | emoji + label (`agents-view.js:46-54, 266-271`) | `⚙️ Working` | `✋ Blocked` | — | — | — | `✅ Done`, `⏹️ Stopped`, `❌ Failed` | Title case + count |
| Grid card | `.grid-card-dot` (`grid-view.js:178-180`) | **pulsing green**, from local `sessionBusyState` only (`app.js:1199-1201`, `style.css:1839-1843`) | not shown | not shown | not shown | static green with glow | grey `#6a6a80` (`style.css:1837`) | footer `Running` / `Stopped`, from `activePtyIds` only (`app.js:1203`) |
| Terminal header | 8 px dot (`app.js:1215`) | not shown | not shown | not shown | not shown | green | grey | **no visible text**; `title`/`aria-label` only: `Running`, `Stopped`, `Killed (SIG…)`, `Exited (code N)` (`app.js:1214-1217`, `process-exit.js:18-28`) |
| Terminal banner (in the xterm) | text | — | — | — | — | — | dim or yellow | `── session stopped — re-click this session in the sidebar to relaunch, or click another to dismiss ──` (`app.js:681`) |
| Remote host dot | `.remote-host-dot` (`style.css:4615-4630`) | — | — | — | — | green | red error; amber unknown; **pulsing amber** connecting | title |
| Status bar | text | — | — | — | — | `N running` (`app.js:1873-1875`) | — | `N running · N sessions · N projects` |

**Divergences.**

1. *Busy* is a blue spinner (sidebar, Agents), a pulsing green dot (grid),
   nothing (header). *Pulsing green* means "busy" in the grid and "has an
   open PTY" on a slug-group header.
2. Four text vocabularies for one concept: rung titles (`Working`), raw CLI
   status (`busy`), job state (`working`, `blocked`), PTY status (`Running`,
   `Stopped`). An Agents row prints two of them side by side
   (`⚙️ working · busy`, `agents-view.js:227`).
3. The grid and the terminal header ignore attention, response-ready and
   waiting: a card or tab that needs the user looks like any running one.
4. After a **Detach** of a background attach tab, the main process sets
   `stopRequested` (`main.js:1789-1791`), so the exit banner says `session
   stopped … to relaunch` (`process-exit.js:19`, `app.js:681`) and the grid
   card footer says `Stopped` (`app.js:1203`) while the job keeps running.
   The terminal header does not show it: a successful stop or detach of the
   session on screen hides the header (`app.js:1074-1077`), and the grid
   hides it too (`grid-view.js:403`).
5. The word "Running" covers two populations: a local PTY (filter
   `Show running only`, `sidebar.js:684`; grid footer; status bar) and a live
   job (Agents header `N running`, `agents-view.js:360,365`). A third, a
   process alive anywhere, decides whether the Stop button shows
   (`has-running-pty` **or** `is-alive`, `style.css:1270-1273`; grid
   `app.js:1206`) without being called "Running".
6. **Resolved (#564, S14).** A merged row shows `N parts` beside the head's
   short id. Its Parts menu lists every transcript newest first, with its
   own name and last-active date, View messages and Copy id. Missing metadata
   reads `Untitled conversation` and `last active unknown`. Local and remote
   rows use the same menu (`public/sidebar.js`, `buildSessionItem` and
   `appendSessionPartsMenu`).
7. Colour is the only cue for the header dot, the grid dot and the
   slug-group dot (WCAG 1.4.1). Endless motion (LED, spinners, three
   `pulse-dot` cadences) has no `prefers-reduced-motion` path: `style.css`
   has **0** `@media` rules (WCAG 2.2.2).

**Proposed convergence.**
- One mark (B1, `renderSessionIcon`) on every surface that shows a session:
  sidebar row, Agents row, grid card header, terminal header. The grid and
  header dots become B1.
- Keep the static rung mapping above when extending B1 to other surfaces.
- One label table (B2) for text, from the glossary's state names; the raw
  CLI word moves to a tooltip or detail line. The state ladder itself is a
  product-model decision (CONCEPT-MAP, M5); this section only requires that whatever
  ladder is chosen is drawn the same way everywhere.
- Liveness/location ("here", "background", "remote", "elsewhere") shown as a
  badge, not as a state colour.
- Detach writes a `Detached` exit label and banner, not `Stopped`.
- A merged row shows its part count (e.g. `2 parts`) next to the head's short id,
  with the individual transcripts in its Parts menu (resolved, S14).
- A `@media (prefers-reduced-motion: reduce)` block stops the spinner, LED and
  pulses (static marks instead); every dot that carries meaning has a text
  or shape companion.

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
| Row Stop | `sidebar.js` row handler | `Stop session` | red square | `confirmAndStopSession` (`app.js`): stop every running part in the row; kill local PTYs or remote processes; **detach** attached background-job tabs. Jobs and outside processes stay running and are named | One `appConfirm(plan.confirmText)`, naming the count, locations and process loss, and saying the conversation is kept and can be resumed. A single-part session uses its display name and “this session”. Retry confirms only failed targets; an empty plan shows a notice |
| Grid Stop | `grid-view.js` | `Stop session` | red square | Same routes, targeting only the card's tab | One confirmation naming this session, its display name, location and process loss; an attach tab says it detaches and keeps running |
| Header Stop | `index.html`, `app.js` | `Stop process`, or `Detach (the session keeps running)` on an attach tab | **same red square** in both cases | Same routes, targeting only the header's tab | Same as Grid Stop |
| Agents Stop | `agents-view.js:340, 421-436` | `Stop` | text button | `claude stop` on the job | **none** |
| Agents Attach | `agents-view.js:340, 386-395`; dblclick `563-569` | `Attach` | text | open an attach tab; if a tab is already open for the row, shows it (`app.js:1502-1506`) | none |
| Row click | `sidebar.js:1431-1439` | none | none | subagent → transcript; remote not attachable → transcript; else open/resume/attach; already-open member → show it (`app.js:1502-1506`); a second click while the first open is in flight joins it (`app.js:1481-1496`) | continuation and live-elsewhere prompts (§5) |
| Remote Detach | — | **no control** | — | happens only on close/eviction paths | — |

**Divergences.**
1. One red square, three effects (kill, detach, remote kill), one of three
   surfaces says which (H2, H4). Row and card say `Stop session` even when
   the click detaches.
2. A reversible verb (detach) shares the destructive verb's icon and colour.
3. Agents Stop is the only Stop without a confirmation.
4. `Attach` keeps its label when the click only goes to an open tab.

**Proposed convergence.**
- Two verbs, two controls, the same everywhere:
  **Stop** (red square, confirm naming what ends and where) and **Detach**
  (neutral eject icon, no confirm, reversible), offered wherever a view can
  be let go without ending the process (bg attach, remote attach).
- Agents Stop goes through the same confirmation as every Stop.
- Keep merged-row Stop as one confirmation naming all targets and exclusions;
  grid and header Stop keep targeting only their tab.
- `Attach` reads `Go to tab` when an attach tab is already open (audit
  proposal, not yet decided).

### 2.2 Archive, Delete

| Control | Where | Label | Effect | Confirmation |
|---|---|---|---|---|
| Row Archive | `sidebar.js:1570-1587`, button `1778-1781` | `Archive` / `Unarchive` | **stops** the session first, then archives (`stop-session-ui.js:39-71`): on a remote row every open or live member; on a local row every member with a PTY or an open tab, refused when a background job is live on a member (`stop-session-ui.js:57-69`) | **none** |
| Slug-group Archive | `sidebar.js:1359-1381` | — (archive icon) | stops + archives every session of the group | **none** |
| Folder Archive | `sidebar.js:1143-1235` | `Archive folder` | stops + archives sessions, disables schedules | `showChoiceDialog` (`sidebar.js:1190-1197`), names the hosts where sessions are stopped (`1174-1179`) |
| Row Delete | `sidebar.js:1525-1568`, button `1798-1801`, dialog `1881-1945` | `Delete session (removes the transcript from disk)` → `Delete permanently` | stop then delete transcript; refused up front on a merged row with a live member (`1529-1533`) | custom modal with preview of what goes |
| Agents Delete | `agents-view.js:340, 421` | `Delete` | `claude rm` (conversation + worktree when safe) | `window.confirm` |
| Worktree Delete | `sidebar.js:1337-1352`, dialog `1949-2017` | `Delete anyway` | `git worktree remove` | custom modal with dirty-file list |
| Worktree Archive project | `sidebar.js` (`worktree-hide-btn`) | `Archive Project` | removes the row, keeps settings and cache, suspends schedules; reversible from Settings | `showChoiceDialog` states what is kept |
| Project Archive | `settings-panel.js` (`sv-archive-btn`) | `Archive Project` | same | `showChoiceDialog` states what is kept |
| Project Delete | `settings-panel.js` (`sv-delete-btn`) | `Delete Project` | drops settings, cache, search index and schedule registration; no file on disk is deleted | `showChoiceDialog`, danger style, focus on Cancel |
| File delete (Agent Files / Work Files) | `viewer-panel.js:283` | — | delete file | `confirm('Delete "<name>"?\n\nThis cannot be undone.')` |
| Trace file delete | `activity-trace-panel.js:120` | — | delete file | same wording |

**Divergences.**
1. Archive is reversible but the stop it performs is not; the row and
   slug-group Archive stop without asking while the folder Archive asks and
   the Stop button asks (H5).
2. Three delete confirmations: custom modal with preview (session, worktree),
   OS `confirm` (Agents, files). The confirm button says `Delete permanently`,
   `Delete anyway`, or `OK`.

**Proposed convergence.**
- Archive of a non-running session stays instant (undo = Unarchive). Archive
  of a running one, at row and group level, asks with B5 using the folder
  Archive's wording (`running ones are stopped first (on <host>)`).
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
| Stop | `Stop session` / `Stop process` / `Stop` | `sidebar.js:1766`, `app.js:1457`, `agents-view.js:340` |
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
once and removes the notice. Archive/Detach wiring follows in S6/S8; restore
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
| `showChoiceDialog` | **1 use**: folder Archive (`sidebar.js:1190`) | `role="dialog"`, `aria-modal`, `aria-labelledby`, focus trap, Escape, Enter, return focus, `danger` variant, verb-labelled confirm, remembered checkboxes (`choice-dialog.js:15-135`) |
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
