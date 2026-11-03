# Concept map

Switchboard as it is at **v0.0.94** (f596e28), not as it should be. One
section per concept: its **states** (exact words shown to the user), its
**actions** with their exact labels per surface, **where** it appears, and the
**rules** that tie it to other concepts. Names follow
[GLOSSARY.md](GLOSSARY.md).

Evidence: `file:line` against v0.0.94. **V** = read in the code or doc;
**V\*** = read during the audit, not re-read for this file;
**S** = supposed (inferred, not executed). Nothing here was observed in a
running app.

Surfaces named in the tables:

| Surface | Where |
|---|---|
| Row | sidebar session row, hover buttons (`public/sidebar.js:1763-1818`) |
| Row menu | right-click on a row (`public/sidebar.js:1444-1448`, `1621-1640`) |
| Group header | slug group header (`public/sidebar.js:524-552`) |
| Project header | project and worktree headers (`public/sidebar.js:896-1001`) |
| Header | terminal header (`public/index.html:111-113`; `public/app.js:1451-1470`) |
| Card | grid card (`public/grid-view.js:180-210`) |
| Agents | Agents view detail pane (`public/agents-view.js:308-345`) |
| Keyboard | rebindable shortcuts (`public/shortcuts.js:15-60`; `docs/keyboard-shortcuts.md`) |
| Tool bar | session tool bar (`public/tool-bar.js:5-8`) |

---

## 1. Sidebar row

A row stands for one conversation: an original transcript plus
`mergedMemberIds`. Its head (`headSessionId`) is its newest-modified part;
the original part owns the row identity. The conversation is pinned when any
part is pinned and archived only when every part is archived. Its name is the
newest user rename on any part, otherwise the original part's name
(`public/session-activity-dom.js` `rowHeadId`, `docs/session-browser.md`).

**States**

- Icon (one slot, highest rung wins, `public/session-state.js:4-16`):
  **Needs your attention** · **Response ready** · **Working** · **Background work
  running** · **Waiting for input** · **Idle** · **Not running** · **Archived**.
  Waiting for input uses an orange hollow ring; Idle a filled dot; Not running
  an opaque grey dash. Idle open here adds a small dot below the filled dot.
  Finished background jobs without a live descriptor read
  Not running; without a terminal job state or live descriptor, they read
  Liveness unknown (`public/agents-view.js`, `projectBackgroundActivity`).
- Green dot class `running` on the icon when a member has a PTY open here;
  activity labels include the ranked lifecycle (`public/session-activity-dom.js`,
  `rowLifecycleLabel`; `public/process-exit.js`, `lifecycleLabel`).
- Foreground status text: waiting reason plus age (`permission prompt · 1m ago`),
  or age alone (`1m ago`). The CLI descriptor word (`busy`, `idle`, `waiting`,
  `shell`) and reason appear in the icon tooltip and accessible name
  (`public/sidebar.js`, `public/session-activity-dom.js`).
- Badges: `bg` "Background session run by the claude daemon — click to
  attach" (`public/sidebar.js:1746`); host alias, tooltip "Live session on
  <alias> — click to attach" / "… attach unavailable: <reason>, click to read
  its transcript" / "… no live process, click to read its transcript"
  (`public/sidebar.js:1733-1739`); terminal badge for a plain terminal.
- Pinned / not pinned; archived / not archived.

**Actions**

| Action | Row | Row menu | Header | Card | Agents | Keyboard |
|---|---|---|---|---|---|---|
| Open (show / attach / resume) | click (`public/sidebar.js:1430-1438`) | — | — | click / double-click header (`public/grid-view.js:264`) | **Attach**, double-click | Primary+Shift+arrows, `[` `]` |
| Stop | **Stop session** (`:1766`) | — | **Stop session** (`public/app.js`, `terminalStopBtn`); **Detach (the session keeps running)** is a separate button (`#terminal-detach-btn`) | **Stop session** (`public/grid-view.js:192`) | **Stop** (`public/agents-view.js:340`) | — |
| Send a prompt (remote) | **Send a prompt…** (`:1771`) | — | — | — | — | — |
| Fork | **Fork session** (`:1785`) | — | — | — | — | — |
| Read transcript | **View messages** (`:1790`) | — | — | — | **Transcript** | — |
| Toggle unread reminder | **Mark as unread** / **Mark as read**, targeting the head's Response ready slot; renderer memory only | — | — | — | — | — |
| Archive older rows | **Archive all older sessions** beside the older-list toggle; eligible count and names, kept/refused names with reasons, lists capped at ten plus `+N more` | — | — | — | — | — |
| Find in messages | — | — | **View messages**: literal case-insensitive matches, counter capped at 10000+, Previous/Next, Escape to close; streaming keeps the active match without scrolling | — | — | Ctrl+F / Cmd+F when the viewer owns focus; configured shortcuts take precedence |
| Open on claude.ai | **Open on claude.ai** (`:1795`), only with a bridge id | — | — | — | — | — |
| Archive / Unarchive | **Archive** / **Unarchive** (`:1780`); asks only when it would stop something, then offers Undo (#565) | — | — | — | — | — |
| Resume with options | **Resume with config** (`:1805`), hidden while a PTY runs (`public/style.css:1283`) | — | — | — | — | — |
| Delete | **Delete session (removes the transcript from disk)** (`:1800`) → dialog **Delete permanently** (`:1905`) | — | — | — | **Delete** (job) | — |
| Rename | double-click the name (`:1462`) | — | — | — | — | — |
| Pin | pin glyph (`:1450-1457`) | — | — | — | — | — |
| Refresh screen | — | **Refresh screen** (`:1628`), disabled with "Open this session in a terminal to refresh its screen" | **Refresh screen** (`public/index.html:111`) | — | — | — |

Plain-terminal rows show Stop only; subagent rows have no buttons
(`public/sidebar.js:1808-1818`, `1441`).

**Where**: `public/sidebar.js` `buildSessionItem` (1655-1827) and
`rebindSidebarEvents` (1420-1590); `docs/session-browser.md:86-110`.

**Rules (as implemented)**

- R1.1 A row's activity is the OR of its members' activity; it is alive if any
  member is alive (V, `public/session-activity-dom.js:27-36`).
- R1.2 Identity, name, pin, archive flag, `bg` badge, status text and short id
  come from the representative only (V, `public/sidebar.js:1716-1747`).
- R1.3 Clicking a row shows its head's non-closed open tab, then the other
  members newest first, then the representative. The head (`headSessionId`)
  is the part with the newest own modification time; ties follow
  `mergedMemberIds` order, with the representative last. With no open part,
  the sidebar passes the head to continuation resolution, the live-elsewhere
  guard and attach or resume (V, `session-cache.js` `buildProjectsFromCache`,
  `public/session-activity-dom.js` `rowOpenId`, `public/sidebar.js`
  `rebindSidebarEvents`, `public/app.js` `openSessionNow`).
- R1.4 Stop on a row stops every running part after one confirmation naming
  the count, locations and process loss; the conversation is kept. Grid and
  header Stop target only their tab. A background job running a part, attached
  here or not, is stopped through the daemon once its job id is checked; a job
  the daemon no longer hosts only detaches its tab. Processes outside this
  window stay running and are named (#777, #778). Retry confirms
  only the failed targets (V, `public/stop-session-ui.js` `planSessionStop`,
  `public/app.js` `confirmAndStopSession`, `public/sidebar.js`).
- R1.5 Single-row Archive stops first; a failure refuses the archive. On a remote row it
  stops every open or live member on its host; on a local row it stops every
  member with a local PTY or an open tab, and refuses up front when a
  background job is live on any member (V, `public/sidebar.js:1572-1585`;
  `public/stop-session-ui.js:39-71`).
- R1.6 Delete refuses before its dialog while any merged member is live or
  open, with a persistent notice naming the reason and recovery. Remote rows
  offer no Delete; the server-side read-only guard remains (`public/sidebar.js`,
  `main.js`).
- R1.7 "Show running only" keeps rows with a member in local `activePtyIds`
  only; an alive remote or unattached background row is filtered out
  (V, `public/sidebar.js:684`).
- R1.8 Fork session, Resume with config and View messages target the head.
  A remote row opened as a transcript uses the head too
  (`public/sidebar.js` `rebindSidebarEvents`). Agents Transcript opens the
  job's own transcript: a job is not a sidebar row.
- R1.9 **Mark as unread** sets a head reminder until reading or fresh activity,
  including idle, attention or a new open head. It survives sidebar rebuilding
  in renderer memory, using the existing Response ready slot.
- R1.10 The older-list count includes displayed conversation rows inside slug
  groups and excludes subagents. Its bulk Archive keeps active sessions, every
  tab open here including closed tabs, sessions live elsewhere and remote
  sessions alive on their host, including merged parts. The confirmation
  counts only eligible rows and names kept/refused rows with reasons. Cancel
  produces no preflight notice; with nothing eligible there is one notice and
  no confirmation, and the archive action is disabled. Slug groups and rows
  remain locked through confirmation and execution.

## 2. Merged web-session row

**States**: as a row (R1.1). Not marked as merged anywhere in the UI (S: no
badge or count found in `buildSessionItem`).

**Actions**: as a row, with per-member rules R1.3–R1.6 and R1.8. Search matches
the representative id only (V, audit `public/sidebar.js:484-489`); View messages
shows the head's transcript (`public/sidebar.js` `rebindSidebarEvents`).

**Where**: user doc, one sentence (`docs/session-restore.md:84`); semantics
only in `.ai/contexts/session-cache.md:106-131`.

**Rules**

- R2.1 Members are transcripts sharing a `bridgeSessionId`: a `/compact` mirror
  or a claude.ai bridge mirror (`.ai/contexts/session-cache.md:106-112`).
- R2.2 Restore saves and reopens each member under its own id and shows it on
  the shared row (`docs/session-restore.md:84-88`).

## 3. Conversation lineage: /compact, /clear, continuation, fork

No row-level concept unifies these; each follows its own rule (M4).

| CLI event | Row result | Evidence |
|---|---|---|
| `/compact` | one merged row (§2) | `.ai/contexts/session-cache.md:106-112` |
| `/clear` (Linux, Windows) | the open terminal's row follows the new transcript; the old one becomes a past row | `CHANGELOG.md:25` |
| `/clear` (macOS) | new transcript listed as a separate row | `CHANGELOG.md:25` |
| Continuation | one root row for a proven local linear chain, opening its newest-modified head; ambiguous, branching, remote or cross-project paths stay separate and retain open-time choice | `session-continuations.js:continuationRollup`, `public/resume-guard.js` |
| **Fork session** | new row, new id, original unchanged | `docs/launching-sessions.md:98-105` |

## 4. Slug group

**States**: count "N sessions", green dot when a member has a local PTY
(`public/sidebar.js:541-545`); collapsed / expanded (remembered,
`public/sidebar.js:514-516`).

**Actions**: expand/collapse (click header); **Archive all sessions in group**
(`public/sidebar.js:549`): it asks once when it would stop running members,
then stops and archives each member in turn and offers Undo (#565); a member that fails to stop
is skipped and flashes **Failed** on its row (`docs/session-browser.md:172-176`).

**Rules**: R4.1 only scheduled runs are grouped, using the same non-empty
`scheduleSlug` within a project and host. Other conversations stay in separate
rows even when their CLI `slug` matches (`public/sidebar.js` `renderProjects`,
`docs/session-browser.md`, "Groups inside a project"). Group Archive still
stops and archives the scheduled runs in turn.

## 5. Subagent

**States**: the parent shows `1 subagent running` / `N subagents running`
below its title, with no line at zero or unknown and no count on remote rows.
The parent's status icon distinguishes its working turn from background work;
child rows and collapsed carets have no green running dots
(`docs/subagents.md`, "Live status").

**Actions**: click opens the read-only transcript (`public/sidebar.js:1430-1436`).
Nothing else (`docs/subagents.md:32`). Grid: the same running count beneath
the card header (`docs/grid-overview.md`, "A card").

**Rules**: R5.1 follows the parent's archive state; parent not found →
**Orphan subagents** group (`docs/subagents.md:23-31`). R5.2 deleting a session
deletes its subagent transcripts (`docs/session-browser.md:227-229`).

## 6. Project and worktree

**States**: expanded / collapsed; missing ("Project path no longer exists — use
"Change path" to fix", `public/sidebar.js:1419`); archived (folder);
archived (project, listed in Settings → Archived projects). Remote: host dot green / grey / amber / red / pulsing
amber (`docs/remote-hosts.md:149-157`).

**Actions**

| Action | Project header | Worktree header | Elsewhere |
|---|---|---|---|
| New session | `+` → **Claude** / **Claude (Configure...)** / **Terminal** (`public/sidebar.js:942`; `docs/launching-sessions.md:17-23`) | **New session in worktree** (`:1001`) | Remote: "New session on <alias>" (`:934`) |
| Create scheduled task | clock, **Create scheduled task** (`:903`) | — | — |
| Project settings | **Project settings** (`:909`) | — | — |
| Archive folder | **Archive folder** → options for sessions and schedules; names running sessions and places; danger only with processes to stop; background-job refusal before the dialog; empty-options Archive is immediate | **Undo** for about 10 seconds after stopping processes or archiving an empty folder; restores the folder, this click's sessions and disabled schedules; processes stay stopped | **Turn back on** / **Dismiss** notice when schedules disabled by an earlier Archive are offered again |
| Change project path | **Change project path** (`:922`), confirm "Remap <name> to: <path>?" (`:1302`) | — | — |
| Archive project | — | **Archive project**, no confirmation, 10-second Undo notice (`public/sidebar.js`) | Settings: **Archive Project** (`public/settings-panel.js`), same Undo notice; settings/cache are kept and schedules suspended; also reversible from Settings → Archived projects |
| Unarchive project | — | — | Global Settings → **Archived projects** → **Unarchive**, including legacy hidden entries |
| Delete | — | **Delete worktree from disk** (`:994`) → dialog "Delete worktree "<name>"?" (`:1949-1961`) | Settings: **Delete Project**, destructive in-app confirmation lists settings, cache/search and schedule registration; keeps all disk files |
| Reconnect (remote) | "Reconnect <alias> now" (`:896`) | — | — |
| Add | — | — | **Add project** (`public/index.html:31`) |

**Rules**

- R6.1 A worktree is nested under its repository only when that repository is
  listed for the same host (`docs/session-browser.md:68-73`).
- R6.2 Archive folder keeps settings and comes back on new activity or Add
  Project. Archive Project keeps settings, cache and schedule registration,
  suspends schedules and returns through explicit Unarchive or Add Project.
  Delete Project drops settings, cache/search and schedule registration,
  while keeping disk files (`docs/settings.md`, `main.js`).
- R6.3 The worktree Archive project control passes its host-qualified folder
  key to `archive-project-settings`; it uses the same reversible project action.

## 7. Open session (terminal view)

**States**: the header uses the sidebar's shared activity slot, including
attention, response-ready, Working, Waiting for input and Not running. Its
tooltip and accessible name read `<activity> · <lifecycle>`; lifecycle uses
the ranked `lifecycleLabel`, including Open here, Attached here, Detached,
recorded exits and Liveness unknown (`public/session-activity-dom.js`,
`paintTerminalHeaderStatus`; `public/process-exit.js`). Activity updates repaint
the header with the row, without waiting for a poll. Exit banners retain
Stopped, Exited (code N) and Killed (SIG); Detach reads "session detached — it
keeps running in the background" (`public/app.js`, `applyProcessExit`).

**Actions**

| Action | Header | Tool bar | Keyboard | Terminal menu |
|---|---|---|---|---|
| Stop / Detach | **Stop session** (`public/app.js`, `terminalStopBtn`) and, as a separate button, **Detach (the session keeps running)** (`#terminal-detach-btn`); hidden when not running (`:1218`) | — | — | — |
| Refresh screen | **Refresh screen** (`public/index.html:111`), disabled when not running | — | — | — |
| Changes / Diff / Touched / Shell | — | **Changes**, **Diff**, **Touched**, **Shell** (`public/tool-bar.js:5-8`) | Primary+Shift+E / D / T / S | — |
| Copy / paste / links | — | — | Primary+F find | **Copy**, **Paste**, **Select all**, **Open in panel**, **Open in system editor**, **Copy path**, **Open in browser**, **Copy link** (`public/terminal-context-menu.js:48-58`) |
| Close | — no control (V\*) | — | — | — |

**Rules**

- R7.1 A Claude session stays mounted after exit with its banner; a plain
  terminal is destroyed and its row removed (V, `public/app.js:686-707`).
- R7.2 An open session is identified by one transcript id; a merged row can
  have several open at once (V\*, m6).
- R7.3 Quit, Restart, an update and a window close name the local processes
  they would end and ask first; eligible sessions can move to the background
  instead. Background and remote processes survive (`session-exit.js`; the exit
  question in `public/file-panel.js`; #562, #546; M1 resolved).

## 8. Grid card

**States**: the same activity slot as the sidebar and terminal header. The
footer uses the ranked lifecycle: Open here, Attached here, Running in
background, Running on <alias>, Running elsewhere, job outcomes, Not running,
Detached, recorded exits, Not reopened or Liveness unknown. Process liveness
and attachment are separate from activity (`public/grid-view.js`,
`updateGridCardActivity`; `public/process-exit.js`, `lifecycleLabel`).

**Actions**: focus (click header, footer or terminal); double-click header →
single view (`public/grid-view.js:264`); **Stop session** shown while the
process is alive anywhere (`public/app.js:1204-1206`); **Group by project**
toggle (`public/index.html:120`); **Session overview** toggle
(`public/app.js:1770`, Primary+Shift+G).

**Rules**: R8.1 one card per open session, not per row; the header count "N
sessions" counts cards (`public/grid-view.js:422`) (m6).

## 9. Plain terminal and panel shell

**Plain terminal** — states: as an open session, row icon only. Actions:
`+` → **Terminal**; row **Stop session**. Rule: inside it, `claude` prints
"To start a Claude session, use the + button in the sidebar." (`docs/launching-sessions.md:109-112`);
removed on exit (R7.1).

**Panel shell** — states: none shown. Actions: **Shell** toggle
(`public/tool-bar.js:8`, Primary+Shift+S); toggling off kills it with no
confirmation (V\*). Rule: runs in the owning session's working directory
(`docs/worktrees.md:52-53`); does not stop when an owning Claude session stops (V\*); stops when an owning
plain terminal's shell exits (`public/app.js:689-690`).

## 10. Background agent (job)

**States** (`public/agents-view.js`, `AGENT_STATE_META`): ⚙️ **Active** · ✋ **Blocked** ·
💤 **Idle** · ✅ **Done** · ⏹️ **Stopped** · ❌ **Failed** · 🖥️ **External** · ❓ **Unknown**;
row text `<state> · <status>` (`:227`); row icon from the session-state ladder
(`:140-149`). Header "N running · N finished · N external" (`:365`). Banner
"The daemon is not answering; state comes from files only." (`:367`).

**Actions** (`public/agents-view.js:151-161`, `340`)

| Action | Agents label | Available | Confirm | Elsewhere |
|---|---|---|---|---|
| Attach | **Attach** (**Go to tab** when already open here, #779), or double-click row | live and daemon reachable | none | row click on a `bg` row; the header then offers the separate **Detach (the session keeps running)** button next to **Stop session** |
| Transcript | **Transcript** | transcript exists | none | row **View messages** |
| Stop | **Stop** (`claude stop`) | live and reachable | After the fresh check: job name and id; its process ends, the conversation is kept | row, card and header **Stop session** stop the job too after the same check; **Detach** leaves it running (#777) |
| Respawn | **Respawn** | finished, no live conversation | none | Send to background on a session with a job; restore of a saved background tab whose worker is dead (#785) |
| Delete | **Delete** (`claude rm`) | finished, no live conversation | After the fresh check: "Delete this background session? Its conversation goes, and its worktree when that is safe." | row **Delete session** refused: "background job <id> is still running this session — use Stop session on its sidebar row first"; if the row cannot stop that job, "stop it from the Agents view first" (`liveBackgroundJobRefusal`, `public/stop-session-ui.js`) |
| New | **New agent** (`public/index.html:91`) | — | — | — |
| View options | **Finished**, Group **None / State / Project**, **Worktrees** (`public/index.html:82-90`) | — | — | Primary+Shift+A toggles the view |

**Rules**

- R10.1 A live job's session id gets the `bg` badge on its sidebar row once the
  Agents view has loaded the roster (`public/agents-view.js:186-196`;
  `docs/background-agents.md:132-136`).
- R10.2 Saved background tabs are restored: a live worker is attached, a dead
  one respawned as the same job and then attached (`docs/session-restore.md`,
  "Background sessions"; #785).
- R10.3 Stop on a row, card or header stops the job through the daemon
  (`confirmAndStopSession`, `planSessionStop` with `jobStop`); a job no longer
  hosted only detaches the tab. Detach is the separate control that leaves the
  job running (#777, #778).

## 11. External session and live elsewhere

**States**: Agents 🖥️ **External**; sidebar: an ordinary row with descriptor
status text.

**Actions**: Agents: **Resume** and **Transcript**; Respawn/Delete disabled with
the pid and "Stop it from its sidebar row first" for a conversation open here,
or "End that process first" for another process (`public/agents-view.js`,
`renderAgentDetail`).
Sidebar click: per kind (`public/resume-guard.js:20-44`):

| Live in | Click result |
|---|---|
| a scheduled run | Resume anyway / Cancel, naming the schedule when known, with the second-writer warning |
| a background job | attach; without a job id, an error notice explains why it cannot attach |
| anything else | Resume anyway / Cancel with the conversation name, pid, folder and start time when known |
| (automatic restore) | skipped, named in a notice |

**Rule**: R11.1 Resume on an External Agents row follows the same manual-open
path as the sidebar: the shared live-elsewhere question asks before starting
a second writer. A conversation already open here is shown directly
(`docs/background-agents.md`, M3).

## 12. Remote host session

**States**: row icon from transcript activity (spinner until 20 s of silence,
never Response ready) and descriptor dialogs (orange attention)
(`docs/remote-hosts.md:192-203`); host dot (§6).

**Actions**: click → attach through tmux, or read-only transcript (badge
tooltip says which, `public/sidebar.js:1733-1739`); **Stop session** → "Stop
this session on <alias>?" then kill on host (`public/stop-session-ui.js:6-7`;
`docs/remote-hosts.md:274-278`); **Send a prompt…** → dialog "Send a prompt —
<alias>", **Send** / **Close**, "Sent. The session reads it when it is next
free." (`public/dialogs.js:561-603`); Archive stops first; no Delete (m2).

**Rules**: R12.1 Detach on an attached remote row, grid card or terminal header
ends the local ssh client only; the session keeps running on the named host.
It asks nothing, reads Detached and offers Undo for 10 s when attachable
(`docs/remote-hosts.md`, "Stop, archive, delete"). R12.2 no panel shell, IDE emulation or path links
(`docs/remote-hosts.md:245-247`).

## 13. Working set and restore

**States**: setting **Don't restore** / **Ask on startup** / **Restore
automatically** (`docs/session-restore.md:8-14`).

**Actions**: toast "Restore N session(s) from last time?" **Restore** /
**Dismiss** (`public/app.js:420-421`); notice "Not restored: …"
(`public/app.js:480-481`).

**Rules**: R13.1 one entry per open session, plus *fresh* entries for sessions
with no transcript yet (`docs/session-restore.md:18-38`). R13.2 restore
resumes an ordinary session and attaches a saved background tab, respawning a
dead job first (#785); other sessions live elsewhere are skipped
(`docs/session-restore.md:90`; `.ai/contexts/session-cache.md`, "Neither the
working-set restore…").

## 14. Schedule

**States**: enabled / disabled (`enabled:` front matter); no per-run state of
its own (`docs/automation.md:41-55`).

**Actions**: **Create scheduled task** (project header); **Run now** (Agent
Files tab, `docs/automation.md:173-179`); disable via Archive folder;
**Turn back on** notice. A run: row in a slug group; open → info-only dialog
(§11); no Stop that works (m7, S for the "Failed" flash).

**Rules**: R14.1 fires only while the app runs; optional catch-up
(`docs/automation.md:11-12`, `108-158`).

## 15. Trigger

**States**: result file fields (`ok`, `submitted`, `error`: e.g. `not sent`)
(`docs/automation.md:503-545`). No UI.

**Actions**: none in the UI; a JSON file in `~/.switchboard/triggers/`
(`docs/automation.md:181-233`).

**Rules**: R15.1 target must be open with a live process, plain terminals
included (`docs/automation.md:196-197`). R15.2 Switchboard never types over
unsubmitted input (`docs/automation.md:291`).

---

## Cross-concept rules (as implemented, none written as a product rule)

1. A row's state is the OR of its members; its identity is its
   representative's (R1.1, R1.2).
2. The square stop control's effect depends on where the process runs: kill
   locally, kill on the host, or stop the background job through the daemon
   (`public/stop-session-ui.js`, `resolveSessionStop`, `planSessionStop`).
   Detach is a separate control (#777).
3. The word "Running" covers two populations: a local PTY (`activePtyIds`) in
   the sidebar, the grid and the status bar; a live job in the Agents header.
   A third, a process alive anywhere (`is-alive`), decides whether the Stop
   control shows on a row or card without being called "Running"
   (`public/style.css:1270-1273`; `public/app.js:1206`).
4. Archive confirms before stopping live parts. Delete refuses any live part,
   including the representative, before its dialog and never stops it. Both
   check background jobs before asking (`public/stop-session-ui.js`,
   `delete-session-guard.js`, `public/sidebar.js`).
5. Quitting asks before ending local processes, can move eligible sessions to
   the background, and leaves background and remote ones running (R7.3).

## Known incoherences

From the product-coherence audit of v0.0.94 (2026-10-11). Severity: **major**
= a user can lose work, act on the wrong object, or cannot predict the
result; **minor** = confusing but recoverable.

| # | Severity | Incoherence | Sections |
|---|---|---|---|
| M1 | resolved (#546) | Quit, update and window close name what stops and can move eligible sessions to background first, with a cancellable ten-minute busy wait. Failure keeps the app open and stops nothing; background and remote sessions keep running. Untagged external OS exits retain their documented bypass. | §7 R7.3 |
| M2 | resolved (#546, #563, #565) | Row, grid and header have separate Stop session and Detach controls for background and remote attach tabs. Stop confirms what ends; Detach asks nothing, keeps the process running and reads Detached. Agents Stop confirms, and Attach reads Go to tab when already open here, finding the tab by job id. | §1, §7, §10, §12 |
| M3 | major (partly resolved, #567) | Sidebar live-elsewhere questions share Resume anyway, including scheduled runs; the Agents view still forbids resume | §11 |
| M4 | major | No definition of a row; `/compact`, `/clear`, continuations and slug groups follow four rules; verbs act on representative or one member | §1, §2, §3, §4 |
| M5 | resolved (#563) | Sidebar, grid, terminal header and Agents share the activity slot; labels distinguish activity from ranked lifecycle. The CLI word is in the tooltip; Agents uses Title Case job states and counts live jobs, while the status bar counts terminals open here. Waiting, Idle, Idle open here and Not running have distinct shapes. | §1, §7, §8, §10, GLOSSARY "State words" |
| M6 | resolved (#568) | Project Archive is reversible through Settings and preserves settings/cache while suspending schedules; destructive Delete is separate. Archive folder still returns on new activity. | §6 |
| m1 | minor | Delete means transcript, job+worktree, or worktree, with three different confirmations; remote rows no longer offer Delete (m2) | §1, §6, §10 |
| m2 | resolved (#566) | Refusals name Stop on the sidebar row here, or ending the other process; remote rows offer no Delete | §1 R1.6, §11 |
| m3 | resolved (#647, #563) | An alive unattached grid card describes where it runs; Stopped requires a recorded Stop, and Detach reads Detached while the job keeps running. | §8 |
| m4 | minor | Two permission-mode lists ("Plan Mode" vs "Plan", `public/utils.js:26-33` vs `public/dialogs.js:691-696`) and two Additional Directories formats | — |
| m5 | minor | "Resume with config" may be silently ignored on an open member (reachability S) | §1 |
| m6 | minor | The grid counts open terminals and calls them sessions | §8 |
| m7 | minor | A scheduled run can be neither stopped nor attached | §14 |
| m8 | minor | "agent", "terminal", "tab", "profile" each carry 3–4 meanings; "session" carries three | GLOSSARY |
