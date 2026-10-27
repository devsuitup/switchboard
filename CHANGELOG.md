# Changelog

What changes for you in each release of Switchboard. How to write an entry: [docs/changelog.md](docs/changelog.md).

## Unreleased

### New
- Automation trigger results now say whether anything was typed into the session: `wrote` is false only when Switchboard can prove nothing reached it, so a script knows when a retry is safe. (#787)

### Changed
- Background sessions that are working now show as working, a finished one as idle, and a dialog waiting for you blinks; the orange waiting ring no longer stands for all three. Reverses the rendering of #728. (#785)

### Fixed
- Send to background on a session that already has a background job relaunches that job instead of starting a new one, so the session keeps its name and never gains a (2) suffix. When Switchboard cannot tell whether that job's worker is still running, it refuses before typing anything. (#785)
- After a reboot or restart, any tab attached to a background job, including one opened from the Agents view, comes back as the same job, with the same name, and is re-attached; other saved tabs keep restoring as indexing finishes, in their saved order. An unreadable job record or a worker that cannot be classified leaves the tab held with a reason, and a failed attachment lets the other tabs finish restoring. (#785)
- On Windows, a respawned background job can be respawned again or deleted once Switchboard verifies that it has stopped; on Linux and macOS, an unverified job still refuses these actions with a notice. A refused Respawn no longer tells you to retry Delete. (#785)
- A local session with a command still running in the background now shows the background-work icon instead of the orange waiting ring, including commands sent there with Ctrl+B or after a timeout, and returns to its usual icon when the command ends. Remote sessions are not covered. (#791)

## v0.0.100 — 2026-10-25

### New
- An automation trigger can send one Escape to a local session tab waiting on a dialog: a question, a permission prompt or another CLI dialog. The observed writer must belong to the target session and still be waiting when the key is sent; this is unavailable on macOS, for plain terminals or for remote sessions. (#780)

### Changed
- In the Agents view, Attach reads Go to tab when the agent is already open in a tab, and goes to that tab. (#546)
- A remote session open in a terminal can now be detached: Detach closes the terminal and leaves the session running on its host, and it reads Detached instead of Stopped. (#546)
- Background agents now have separate Detach and Stop buttons on their sidebar row, grid card and terminal header. Detach leaves the agent running without asking, as before; Stop ends the agent after a confirmation, as in the Agents view, whether or not it is open here. The stop button is called Stop session everywhere. (#546)
- Quit (Exit on Windows), Restart to update and window close offer to move eligible sessions to the background and stop the rest, waiting up to 10 minutes for working sessions to finish their turn. Moved sessions reattach at the next start; if one cannot move or the moved sessions cannot be saved, Switchboard stays open and stops nothing. (#546)
- Quit (Exit on Windows), Restart to update and window close now name the local sessions, plain terminals and panel shells that will stop, with Stop and Cancel choices. Unsaved edits are handled first; attached background jobs and remote sessions are identified as continuing. (#546, #562)

### Fixed
- On Windows, automation commands addressed by an earlier session ID or found through the session's state file reach their tab again when several sessions are open. (#780)
- Files outside a Git repository open from Touched when the system language is not English. Local Git errors are shown in English, and locked worktrees can be removed in any system language. (#754)
- Sessions resumed interactively no longer keep a background badge or appear as running background jobs because of an old daemon job file. (#764)

## v0.0.99 — 2026-10-21

### Changed
- The session header shows the same status icon as the sidebar row; hover it for what the session is doing and where it runs. (#563)
- Session tooltips say Open here, Attached here, Running in background, Running on a host or Running elsewhere; sessions awaiting restore say Not reopened · restores on click. The status bar and filter say open here, and Idle, Idle open here and Not running now differ by shape. (#563)
- A session's line in the sidebar no longer repeats the CLI's own status word (busy, idle, waiting, shell); hover the status icon to see it. Local and remote sessions show the waiting reason and status age on the line; for both, conversations with several parts use the latest part's status on the line and in the tooltip. (#563)
- The Agents view shows job states as Active, Blocked, Idle, Done, Stopped, Failed, External or Unknown, and screen readers announce each row's activity. Finished background rows in Agents, the sidebar and the grid now have tooltips that say Not running instead of Stale; jobs say Liveness unknown when neither a finished job state nor a live descriptor is available. (#563)
- Delete on a conversation that is running in Switchboard is now refused before its confirmation; stop it first. Delete, Delete worktree and Change path say why they cannot proceed before their confirmation, not after you confirm. (#565)

### Fixed
- Detaching from a background session now reads Detached, in its terminal and on its grid card, instead of Stopped: the session keeps running. A session whose process is gone without an exit Switchboard saw reads Not running, not Stopped. (#563)
## v0.0.98 — 2026-10-20

### New
- The Agents view can resume a conversation running outside Switchboard (External). It opens the conversation's latest part and asks first, as the sidebar does. (#567)
- A conversation made of several transcripts now shows N parts, and its menu lists the parts with View messages and Copy id for each. (#564)

### Changed
- Stop in the Agents view now asks first and says which job ends. Delete in the Agents view says why it cannot proceed before asking, not after. (#565)
- Archive folder names the sessions it would stop, local and remote, and says before its dialog when a background job keeps it from archiving. When it stopped running sessions, a notice offers Undo for about 10 seconds: it brings back the folder and its sessions and turns back on the schedules the Archive turned off; stopped processes stay stopped. An empty folder archives without a dialog and offers Undo. (#565)
- Archive on a session or a group of sessions now asks first when it would stop something running, and says what. Archiving sessions that are not running happens at once. Either way a notice offers Undo for about 10 seconds; processes it stopped stay stopped. (#565, #564)
- Detaching from a background session no longer asks first. A notice offers Undo for about 10 seconds, which attaches it again. (#565)
- Archive Project, in Project Settings and on a worktree, no longer asks first. A notice offers Undo for about 10 seconds. (#565)
- Stop on a conversation made of several parts now stops every running part after one confirmation that says how many run and where. Every Stop confirmation says what ends and that the conversation is kept; a part running as a background job keeps running and is stopped from the Agents view. (#565, #564)
- Switchboard remembers which part of a branched conversation you open, across restarts. It follows that part when it continues, and asks again only when a new part appears or your choice is gone. Choose part to open in the row's menu changes it; if there are no longer any parts to choose from, a notice says so. (#567)
- When a conversation continued in more than one place, one dialog lists each conversation once by the name, last activity and message count of the latest part it opens, the newest preselected, instead of asking once per session id. Choosing a conversation already open here shows its tab; otherwise, opening it checks whether any part is running elsewhere. (#567)
- Opening a session that is already running elsewhere, including one its scheduled task is running right now, says where it runs (pid, folder, start time, schedule name) and offers Resume anyway or Cancel. A background session Switchboard cannot attach to is refused with a notice that says why. (#567)
- A conversation the CLI continued under a new id now stays on one row when there is only one way it went. (#564)
- A conversation made of several parts now stays listed while any part is unarchived and is pinned when any part is pinned. Archive, Pin and Rename apply to every part at once, and its subagents are hidden only when the whole conversation is archived. (#564)
- Sessions are grouped by name only for scheduled tasks; other sessions are listed one per row. Scheduled runs from before v0.0.90 are listed one per row. (#564)
- Remote session rows no longer offer Delete, which could only be refused after opening its confirmation. (#566, #565)
- Disabled Respawn and Delete buttons in Agents now tell you to use the conversation's sidebar Stop or end its other process, according to where it is running. (#566)

### Fixed
- Background conversations keep their available activity and their parts together through temporary gaps in the daemon listing or session descriptors. Refreshes no longer replace a newer conversation list with an older result. (#719)
- Background conversations in worktrees keep their parts together, finished jobs clear older task activity, and blocked jobs keep their label in Agents and the grid. (#719)
- Automated command chains now recognize a recorded step and continue even when Claude keeps writing large API requests after it during a long turn. (#730)
- The sidebar keeps updating other projects when one project cannot be read. (#718)
- A session moved to the background with a typed `/bg` keeps one sidebar row and its name after a restart, including when its original transcript is written again. An already-open background tab keeps the conversation's name, pin and archive settings. (#718)
- A conversation whose only continuation no longer exists on disk opens directly, with a short notice, instead of asking or waiting. (#567)
- Reloading the window now names the session that was active when it cannot reopen because it is running elsewhere, needs a continuation choice, has continuations that could not be checked or is still missing after indexing finishes. New sessions and running terminals are no longer reported missing; a continuation check awaiting an automatic retry says so. (#729)
- If the project list cannot be loaded at startup, session restore waits and runs when a delayed retry succeeds. (#729)
- A restored conversation now reopens at its latest part and is no longer held with a notice when its apparent alternatives are its own parts. Real branches still wait for a choice from the sidebar. (#722)
- A conversation stays held during startup restore when an older part is running in the background, instead of attaching to that older part's job. A background job on its latest part still attaches. (#722)
- A blocked background job now shows the static orange waiting ring in the sidebar, grid and Agents view, including while attached, and keeps its Blocked label and tooltip. It still blinks when Claude separately asks for your attention. (#726)
- On Linux, Switchboard restarted by an update could no longer install the next update or open links in snap applications such as Firefox; it now restarts through your desktop session's service manager, so it keeps the rights the application menu gives it. (#590)
- A session open in Switchboard shows its green dot again, in the sidebar and the grid, while it is at rest; the orange waiting ring appears once Switchboard has seen Claude finish a turn in it. A plain terminal keeps its green glow. (#714)
- Search now finds a compacted conversation by text from any of its parts, and the subagents of its later parts are listed under it instead of under Orphan subagents. (#564)
- On a compacted conversation, Fork, Resume with config and View messages now use its latest part. (#564)
- Deleting a compacted conversation now deletes all of its parts, so newer parts cannot reappear as sessions; Delete asks you to retry if its parts changed after the preview. If a file cannot be removed, the conversation stays listed with its remaining parts and a message reports what was deleted. (#564)
- Run now on a schedule shows Launched! only after its shell starts. A refused launch or shell spawn failure leaves a dismissible notice saying why and how to retry; later command failures remain in the main log. (#566)
- A restore retry cancelled during indexing, even when indexing finishes during the restore, or blocked by a failed reload, now leaves a persistent notice telling you to open the session from the sidebar to retry restoring. A failed retry lists only the sessions that are still not open, and the "waiting for indexing" notice goes away once nothing is left to retry. (#666, #566)
- A session you send to the background after Switchboard restarts keeps its single sidebar row and its name, instead of showing a second row titled with the conversation's generated title. (#715)

## v0.0.97 — 2026-10-17

### Changed
- A background session's sidebar row no longer repeats its working status under its title; activity details are in the icon's tooltip. Only Needs attention (also when its activity details are unavailable), idle, blocked, finished, stopped, failed or unavailable states are written out. (#702)

### Fixed
- Sessions on a remote host show again whether they are working or waiting for you, instead of "Turn state unavailable". (#698)
- Typing in a terminal no longer stalls while other sessions or subagents are working: their last-activity times in the sidebar now update at most every 30 seconds, while new sessions and renames still appear right away. (#694)
- A session sent to the background no longer takes back an old name over one you gave it more recently. (#685)
- A session whose Claude process crashed no longer reappears in the sidebar as running after Windows reuses its process number. (#687)

## v0.0.96 — 2026-10-17

### New
- Markdown previews now render Mermaid diagrams in Agent Files, Work Files and the file editor. Invalid diagrams keep their source visible with an inline error; unchanged diagrams stay visible while the document refreshes. Newly rendered Gantt diagrams fit the current panel width. (#663)
- **Send to background**, in a running session's header and right-click menu, moves it to the Claude daemon and keeps it open as an attached tab, reattached after each restart. Remote, sandboxed and pre-launch-command sessions cannot move, and a busy session must be idle first; running subagents require confirmation because Claude may stop them. (#546)
- **Restore Sessions on Startup** has a new **Restore on click** option: the sessions open when Switchboard last closed are marked in the sidebar with an outlined dot, and each one is resumed only when you open it, by a click or with the previous/next session keys, instead of starting a `claude` process for every one at launch. **Don't restore** in a marked session's right-click menu removes it without starting it. (#441)

### Changed
- Remote hosts now use the label you choose in Settings in project headers, session badges, dialogs and messages. Hosts without a label show their SSH alias. (#677)
- Quitting Switchboard or installing an update gives pending settings and index changes up to 1.5 seconds to finish saving. A failed save cannot block quitting, and a failed update install keeps the app usable. (#616)
- Conversations now show the number of running subagents below their title, even when their child list is collapsed or filtered, replacing the green dots on child rows and collapsed carets. The grid shows the same count in place of coloured pills; no count appears when none are running or activity is unknown. (#627)
- The notice saying an archived remote session could not be stopped now stays until you dismiss it. Notices that close on their own wait while you point at or tab into them. (#566)
- Confirmations and error messages now use Switchboard’s own dialog, matching the rest of the app. Only the top dialog receives keys and keeps focus, with terminal typing, paste and app shortcuts paused while it is open; closing it gives focus back to the control that opened it when that control is still there. The unsaved-edits guard waits for pending questions, opens over other dialogs, and keeps its Save/Discard/Cancel layout: Enter saves, Escape cancels, and Tab or Shift+Tab moves between its buttons. (#585)
- **Archive Project** now keeps your settings and suspends schedules until you restore it from Settings → **Archived projects**. A separate **Delete Project** confirms the removal of settings, cache and schedule registration, while keeping your folders and files. (#568)
- Triggers reaching the same terminal run one at a time: a different id waits its turn and can expire as `not sent`, with ids matched case-insensitively. A cleared conversation is refused when its replacement is identifiable; a conversation continued into an unattached background job reports that it is not attached here, replaced terminals cause chains to be refused, and chains containing `/resume X` stop after the resume. (#592)
- Markdown previews now show a file's frontmatter as a readable header above its content, including its name, description and metadata. (#593)
- Closing the window (the close button, `Alt`+`F4`) asks for confirmation first, with Cancel selected; a window that is busy at that moment asks once it is free. Quitting from the ☰ menu (Quit, or Exit on Windows) does not ask again, and a quit from outside (a logout, an update install) is not stopped by the question. On macOS it asks "Close the window?": Switchboard stays in the Dock, but its sessions stop. If the window has stopped responding, a single close waits, and closing it again a few seconds later ends it; never while one of its own confirmation boxes waits for an answer. A window closed while it is still starting asks once it has loaded. (#478)

### Fixed
- A background session that watches an artifact shows its activity instead of "Activity unavailable"; an activity Switchboard does not know yet is named as unknown in the activity tooltip. (#684)
- A background session waiting for your next message keeps its bg badge and can still be attached or stopped from the Agents view. (#682)
- Renaming a session no longer reverts to an earlier name such as "name (3)" when its transcript refreshes. A later rename in the session itself can still update the displayed name. (#680)
- Starting Switchboard from a terminal inside Claude Code no longer makes its tabs take that session's name or write metadata into its transcript. Scheduled runs and background launches also start with their own session identity. (#670)
- In builds from main, completed subagents no longer remain in the running count, and subagent activity no longer causes continuous high CPU use and delayed terminal updates. (#667)
- Reopening or revealing a terminal no longer sends delayed terminal identification, status or colour replies into the conversation prompt. (#668)
- Failed Stop, Detach, Delete, Archive, Unarchive, Archive folder, background handoff and session restore actions now leave a dismissible message naming what happened, the reason and what to do next. Partial results say what succeeded, automatic indexing retries stay informational, and holds needing your choice stay visible. Later failures join their existing group; retrying one action keeps other errors visible. Failed manual background attachments keep your saved tabs unchanged. (#566)
- An attached tab left open when its background job finishes shows **Job done**, **Job stopped** or **Job failed** with the finished indicator. A resumed background conversation's status line shows its current activity instead of an old status and its age. (#654)
- On Windows, replacing a conversation transcript no longer leaves reopening or restoring it following an outdated continuation, or prevents Send to background from confirming its new destination. (#656)
- On Windows, automation triggers stop following an outdated conversation continuation when its transcript is replaced. (#652)
- Background conversations show their current turn and tasks in the sidebar and Agents view even before Agents is opened; outdated statuses no longer leave them marked as working, and resumed tabs keep their own activity. Blocked jobs show **! Needs your attention**, including while attached; background Agents rows no longer add `· busy` or `· idle`, and the sidebar shows activity alongside the job state, or simply **Job done**, **Job stopped** or **Job failed**, with the local job update time on hover. (#628)
- On Windows, replacing a local transcript no longer reports new activity for the conversation or its subagents. (#648)
- On Windows, running subagent counts update correctly when a conversation transcript is replaced, so finished tasks no longer remain shown as running. (#650)
- Grid cards now show the same activity glyph, attention, response-ready state and blue unread title as the sidebar, alongside the shared running-subagent count and violet tint while a busy head has running agents. A session running elsewhere is no longer labelled stopped just because this window has no terminal attached, and a terminal that exits keeps its exit reason in the footer. (#629)
- Conversation titles stay blue until you see their newly written output. Spinners, timer updates, redraws and restored history no longer make a title blue, and terminal output already visible stays seen when its transcript update arrives later. Visible output counts even without keyboard focus; selecting a conversation with hidden output, a scrolled-up terminal or a clipped grid card preserves unseen activity. A transcript viewer preserves unseen output written after it opened. Large tool results count too. (#626)
- Diagnostics traces summarize historical subagents separately from recent activity and distinguish inferred completion from recorded task completion, including when the parent session exits with agents still open. (#630)
- A conversation's spinner now animates while its current agent is in a turn. At the prompt, running background agents, shells, monitors or scheduled work use a static spinner; interruptions, errors and task notifications at rest no longer leave it spinning. The grid follows the same turn state, and older parts of a compacted conversation cannot animate its current part. (#625)
- The sidebar and Agents view keep attention and unseen responses ahead of the spinner. Waiting dialogs in Agents show **!**, and a live session whose turn cannot be determined says **Turn state unavailable**. Remote turn changes appear after the mirror refresh (about 15 seconds with the host watch, otherwise the configured pull interval). (#625)
- Waiting indicators clear when newer activity or transcript evidence arrives, including attached remote sessions whose clock differs from this computer's. Older activity and end-of-turn metadata writes keep the waiting indicator. Chained triggers wait for an ordinary stopped response to finish before sending the next step. (#625)
- Sending a conversation to the background keeps its existing row, original name, response-ready indicator, turn spinner, file panel and shell, including when the terminal exits before the background job appears. Its background badge appears on that same row, without a second conversation or a numbered collision name; reopening the original conversation keeps its own terminal, and its name, star and archive survive when the job finishes. (#639)
- Running subagents stay visible during long, silent tool calls when Claude records their launch, and disappear as soon as it records their completion. The sidebar and grid share the same running tasks; file activity remains the fallback for older records. Failed attempts to message a finished subagent no longer leave it shown as running, including overlapping attempts. (#624)
- When several subagents work under one conversation, each now shows its own activity, including the final update during a burst, for both local and remote sessions. (#622)
- Memory and Work Files lists open without blocking the window while sessions stream, and show their files before search indexing finishes, including when you reopen a list while its previous indexing is still running. Search indexing errors retry in the background without interrupting a list that is still loading. If loading fails, the previous list stays visible and a notice explains how to retry by reopening the tab. (#616)
- Reading old transcripts no longer marks sessions as Working or makes historical subagents appear active. Transcript writes still update activity, including a newly created transcript's first write and a final write during a burst. (#621)
- Background sessions appear in the sidebar before their first new turn, show a **bg** marker without opening Agents, and use the name you gave them in Claude Code unless you renamed them in Switchboard. A proven continuation stays on its conversation's row while the background job is live; finished jobs lose their marker even if their process remains open. Job progress avoids unnecessary sidebar reloads, and background updates continue after closing and reopening the macOS window. (#620)
- Opening or closing a session tab no longer clears running subagents reported by another session. After closing an attached background tab, its running subagents stay visible for up to a minute; closing a remote tab keeps its subagents visible while remote activity continues. (#623)
- Refresh screen holds the temporary resize longer so the running CLI redraws a garbled screen, and the replay of a hidden or reattached tab no longer answers stale terminal queries. (#603)
- Opening a compacted conversation that is not open now resumes its latest part, not the transcript from before the compaction. When both parts have open tabs, clicking the conversation shows the latest part's tab. (#564)
- The sidebar project list reloads without blocking the window. (#616)
- On Windows, opening a project with different letter case no longer makes its scheduled tasks run twice. Existing duplicate registrations are cleaned up automatically. (#607)
- Quitting while startup is restoring sessions no longer opens an extra new session on the next start or forgets a conversation being reattached in the background. (#550)
- On Windows, a `/compact` sent by an automation trigger is no longer reported as done because of a transcript file that was replaced while it waited. (#601)
- A session sent to the background is reattached at every restart, not only the first. (#546)
- Archiving a merged remote conversation now stops its live members even when the visible session is no longer running. Archiving a remote session whose host has not synced yet in this run (attached, or listed from the saved copy after a restart) now asks the host first, with the button busy, for up to 20 seconds. If the host does not answer, the session is still archived and a notice says it was not stopped and may still be running; archiving a folder or a group works the same way. A row whose host is disabled or removed archives as before. (#556)
- On Windows and Linux, automation triggers follow a running conversation when its id changes, except in WSL or the Linux sandbox. (#579)
- The New Session dialog now opens with focus on the selected permission mode, and Enter starts the session with that mode. Cancelling returns focus to the + button that opened the dialog; starting moves it to the new terminal. (#583)
- Tab and Shift+Tab now close the New session (+) menu and move on from its + button, instead of leaving the menu open with no way to close it from the keyboard. (#582)
- A quit that arrives just as a reload of the window is confirmed now waits for the open sessions to be saved before Switchboard closes, so the next start restores them. (#479)

## v0.0.95 — 2026-10-12

### New
- Global Settings now lets you receive beta versions before they reach the stable channel. Turn on **Receive beta versions** and save; turning it off keeps your installed version until a newer stable release is available, except a beta already downloaded, which still installs at the next quit. (#549)

### Fixed
- F6 moves focus out of the terminal to the sidebar, and Shift+F6 returns to the active terminal. The New session (+) menu now works from the keyboard, with arrow navigation and Escape to close. (#574)
- A session whose process has ended now stops showing as running without a manual refresh, including when it shares a merged row. A late transcript write from an ended session no longer leaves it showing Waiting for input. (#576)
- Buttons that appear only on hover now also appear with a focus ring when you reach them with the keyboard, in the sidebar, the grid and the file panel. (#574)
- Sessions running outside Switchboard, including remote sessions, keep their activity indicators when the sidebar refreshes or you toggle Show archived sessions. (#573)
- A session waiting for your input now shows an orange ring instead of the same grey dot as an idle one. In the Agents view, live jobs show green and finished ones dim. (#563)

## v0.0.94 — 2026-10-11

### Fixed
- Restoring sessions at startup reopens saved conversations that share a web-session row in the sidebar, keeping the saved conversation and its active tab. (#558)

## v0.0.93 — 2026-10-11

### New
- With Sandbox on, `SWITCHBOARD_SANDBOX_RW_SKILLS=1` or `SWITCHBOARD_SANDBOX_RW_AGENTS=1` in the Pre-launch Command lets the session create and edit skills or agents, in `~/.claude` and the project's `.claude`. Both are off by default: what the session writes there is loaded, and run, by later sessions outside the sandbox. (#483)

### Fixed
- Merged web conversations show their continuations' activity and focus the open tab on click, Refresh and Stop target the open or live continuation, Archive handles running parts and ended tabs, Delete stops a running representative but refuses open or live merged members, and remote sessions confirmed stopped no longer appear alive because of a stale descriptor. (#547)
- Switching terminal tabs no longer freezes the window for about two seconds, a regression introduced in v0.0.91. (#541)
- Switching to a hidden terminal tab no longer disposes and recreates its graphics context every time, which blocked the window for several seconds. The three most recently shown terminals keep theirs, and a context that has to be recreated is made once the tab is shown. (#526)
- In a sandboxed session, a repository or a `.claude` folder below an Additional Directory that is a symbolic link now has its Git config, hooks and Claude settings read-only, like one below a plain directory. Before, they were writable from inside the sandbox. Such a directory holding a `.claude` that is itself a symbolic link, or a repository Git cannot read, now refuses to start the session (status 125), as a plain directory already did, instead of starting it unprotected. (#538)
- A double click on a session in the sidebar opens it once, instead of sometimes starting two terminals that resume the same conversation. (#539)
- Closing the window or quitting no longer leaves Switchboard running when its window has stopped responding: the window closes as before, and once the system reports it not responding, about 5 seconds after the close, or once you close it again, it is closed anyway. A window still busy at that point is closed too, and its last unsaved changes to the list of open sessions are lost; one that recovers sooner closes normally. (#540)
- Archiving or deleting a session no longer fails with "cannot tell whether a background job is running this session" while a background job that has not received its first prompt yet is live. (#553)
- On Linux and Windows, `/clear` (or `/reset`, `/new`) in a session keeps the open terminal on its sidebar row, which now follows the new conversation, instead of listing that conversation as a separate session. The cleared conversation stays in the list as a past session, and a session quit after `/clear` before its first prompt comes back on restore as a new session in the same project. On macOS the new conversation is still listed apart. (#477)
- Quitting or closing the window saves the open sessions right away, so the next start restores the sessions that were open, not an empty or out-of-date list. (#479)

## v0.0.92 — 2026-10-10

### Fixed
- The Agents view shows a finished job whose conversation is still running as one live session, keeps its job id and state, and keeps jobs open here out of External. Respawn and Delete check whether the conversation is still held; Stop checks this only for a known finished job and keeps an attached tab open if refused. Transcript checks its file when clicked and explains when it is missing or not indexed yet. (#522)
- Conversations sharing a web session now keep their own older messages when another conversation continues later. Continuations stay with the conversation they continue, and previously missing local and remote conversations return after upgrading without blocking the interface while their history is indexed. (#524)
- On Windows, writing to a terminal that is closing no longer raises an uncaught main-process exception, including when closing an attached agent tab. (#517)
- Restoring a conversation that continued under another id now opens its continuation and saves the new id, waits and retries when indexing finishes, and keeps live continuations available before their first transcript is saved. Unrelated damaged or oversized records no longer block restore; multiple or unresolved continuations, including when process status cannot be read, stay saved with a notice to open the old session and choose a continuation or explicitly reopen the original. (#518)
- On Windows, a session running in one of Switchboard's own tabs no longer shows as an External session in the Agents view, and opening it no longer reports it as running in another process. The Agents header now also counts the External sessions it lists. (#521)

## v0.0.91 — 2026-10-09

### New
- Remote sessions now have a Touched list and can open its files read-only, with their HEAD diff inside the session's repository. The list stays visible with unknown disk states when the host cannot be reached. Password databases and private keys on the host are refused. (#454)

### Changed
- Changes, a pending Diff, Touched and Shell move to a vertical bar on the right, with rebindable Ctrl/Cmd+Shift+E/D/T/S shortcuts; Refresh and Stop sit beside the session id. Switching tools keeps your edits and an unanswered Diff while the CLI is connected, forking keeps Changes open, the shell stays below every tool, and narrow windows keep the bar and session id visible while restoring your chosen widths when there is room. (#506)

## v0.0.90 — 2026-10-09

### New
- An Agents view lists the sessions the Claude daemon runs in the background (`claude --bg`) and the interactive sessions running outside Switchboard, grouped by state or by project and worktree. Open it from the people icon in the sidebar or with Ctrl+Shift+A (Cmd+Shift+A on macOS); attach to a live one by double click, stop, respawn or delete one, and start a new one with New agent. A background session that is running shows a `bg` badge in the sidebar and is attached instead of resumed. (#374)
- **Archive folder** on a project header opens a dialog that archives the folder's sessions and disables its enabled schedules, each optional, and hides the folder with its worktrees. The folder comes back, with its settings, when you add it again or a new session starts in it, and then offers to turn back on the schedules the archive disabled. (#473)
### Changed
- New scheduled task runs appear under a header named after their schedule, even with only one visible run. Schedules that use the same prompt stay separate; older runs keep their existing grouping. An old expansion choice is inherited only when it identifies one schedule across projects and hosts. (#489)
- Markdown files open formatted in Touched, with a toggle back to the source that is remembered. (#472)
- Clicking a file in the terminal, or a file Claude opens, shows it in Touched, at the top of the list as opened when the file tools did not touch it, with its diff against HEAD when it changed. A `path:line` link opens the source at that line, symbolic links open read-only, and files Claude opens get the panel's checks, which refuse credential paths, binary files and files over 2 MB. (#472)
- Sessions a program started through the Claude Agent SDK, such as headless runs or review agents, no longer fill the sidebar and grid. Turn off **Hide SDK-launched Sessions** in Global Settings to list them again. Sessions you have open, scheduled tasks and sessions you continued by typing in them stay listed, and the activity heatmap still counts the hidden ones. (#486)
### Fixed
- The New background agent dialog keeps fields inside their rows and aligns Project, Name and Agent. Permissions offer Accept Edits, Auto, Plan and Bypass, preselecting the project's mode when it is one of them and Accept Edits otherwise; additional directories use one path per line, preserving commas in paths. (#501)
- Automation triggers to a running background session now report `background session, not attached here` with its job id when no attach tab is open. Attach it from the Agents view to deliver the trigger through that tab. (#495)
- Opening a session while its scheduled task is running asks you to wait instead of starting a second process on the same transcript. Automatic restores skip it until the run finishes. (#484)
- A `/compact` trigger waits for compaction evidence before reporting confirmation, including when retained records follow it; a chain resumes once the session is ready, or stops without resuming if evidence misses its deadline. (#488)
- When the Claude CLI reports a session's id in a different letter case, the subagents that session started or finished during a turn now show up when the turn ends. (#487)
- A session that moves into a worktree while it runs stays in the sidebar, under its project, instead of disappearing while its terminal keeps running. A running session also stays listed when its transcript leaves its folder for any other reason. (#485)
- Worktree folders from another host, or whose repository is not listed, show in the sidebar instead of being nested under the wrong folder or not shown at all. The worktrees of a repository hidden with Hide Project stay hidden. (#473)
- Remote triggers refuse commands containing invisible format characters, default-ignorable characters or braille blanks, including joined emoji, emoji with variation selectors (such as hearts), soft hyphens and right-to-left marks. Fullwidth slash, exclamation and number-sign prefixes are refused too. (#440)

## v0.0.89 — 2026-10-04

### New
- Refresh a session's screen from the terminal header or its sidebar context menu. Returning to a solo tmux attachment refreshes it automatically; shared attachments redraw locally on demand without changing another client's window size. (#446)
- Back to list and Escape from a diff restore the Changes list with its scroll position and selection. (#444)
### Changed
- Touched keeps its file list above the editor with a resizable split, moves its explanation into an info dialog, and shares the Settings sort-control style. Settings selects gain the same hover and focus styles, and file and diff headers keep filenames visible when paths are shortened. (#467)
- File panels refuse to open or save paths inside `.git` (Windows short names included) and files that are not valid UTF-8, instead of rewriting their bytes, and no longer save through a symlink. This applies to files opened from terminal links too. (#450)
- Touched files open in the same editor as Changes, with a diff against HEAD when available and the same layout without a diff otherwise. Switching between Touched and Changes keeps each file's unsaved edits. (#450)
- Buttons and scrollbars throughout the app now match the dark theme, including file panel lists, file contents, and the Touched history controls. (#448)
- Touched opens on the last day's files, shows when each was last touched, and sorts by time or path. Show 10 more days extends the history, and reopening the tab reuses unchanged transcripts. (#444)
### Fixed
- Remote terminals recover normal resizing and refresh on return after other clients leave, and clear lingering connections after a restart within the same app profile. Separate dev and test instances keep each other's live terminals attached. (#452)

## v0.0.88 — 2026-10-03

### New
- Single triggers can send prompts to unattached remote sessions when the global `remoteTriggers` setting is enabled; it defaults to off and has no Settings control yet. (#437)
- A session's **Touched** tab, next to Changes in the terminal header, lists the files its file tools (Edit, Write, MultiEdit, NotebookEdit) touched, its subagents' included, with what is on disk now (present, gone, unreadable) and the tools and agents behind each. It works outside any git repository. It is not the complete set of files the session changed: files changed through Bash commands or scripts are not listed, and the tab says so. Local sessions only. (#309)
- With Debug mode on, the activity trace now records how hard each terminal is being drawn: once a second per session, how many writes reached it, how large they were and how often its glyph atlas was rebuilt, to tell a legitimately busy terminal from a runaway one. (#175)
- On a remote host with `tmux`, the project's `+` now starts a new Claude session there: pick or type a directory on the host, choose a permission mode, and Switchboard starts it in a tmux session and attaches to it. The directory must already exist on the host, `claude` must be on the PATH of an ssh command, and signing in is done on the host. (#218, #222)
- Each remote host in Settings has a **Check host** button: it reports whether the host is reachable, has `claude` (with its version), `tmux` and a `~/.claude`, and whether the account is logged in. For anything missing it shows the command to run on the host, with a copy button. It does not install, log in or write anything itself, and never copies or reads credentials. A login it cannot tell is shown as unknown, not as logged out. Linux hosts only. (#222)
### Changed
- A single trigger is no longer typed into a dialog such as a permission prompt or a question: with `wait: "none"` (write now, the default) it holds while the CLI shows a dialog, and with `wait: "idle"` until the CLI is at its prompt, up to its `timeout_ms`; then it fails `not sent` with a `reason` that says a dialog is open instead of being written into it. `wait: "none"` still writes at once while the CLI is busy. Without a readable CLI descriptor it is written as before. Input you type yourself in the terminal is never held back. (#379)
- Switchboard now checks once per host, at the first successful refresh and then every six hours (every 30 minutes while one is missing), whether `tmux` and `inotifywait` are installed. A host with `tmux` and no session running no longer shows attach as missing; a host without `tmux` no longer offers to attach to a session and opens its transcript, saying why in the tooltip; and the host's tooltip says when live updates are off because `inotifywait` is missing. On a remote host, the new-session button's tooltip now gives the reason, and Send a prompt… is disabled, with the reason, while no live session on the host reports a messaging socket. Stop is never disabled. (#218)
- A trigger that gave up waiting for a session now says, in its result file's `reason`, when the session was blocked on a dialog such as a permission prompt or a question: for a single trigger, a chain's first wait, and a chain step whose turn never finished. Without a dialog the result is as before. (#379)
### Fixed
- A trigger chain no longer stops after its first step while background agents are running: when the CLI keeps reporting itself busy but the session transcript shows the turn finished, with no new write for 3 seconds and no dialog open, the next step is sent, and the step's `ready_source` / `idle_source` in the result file says `transcript`. A step typed while the CLI reports busy, such as `/compact`, is confirmed once the transcript shows it and its turn finished (`confirm_source` says `transcript`), up to the step's deadline; past it, or after 30 seconds for a step other than `/compact` that never shows, the chain stops with `step not confirmed` and nothing more is typed. Give a chain that starts with `/compact` a `timeout_ms` of 600000. (#360)
- The Changes panel no longer shows `fatal: .git/index: index file open failed: Permission denied` now and then on Windows: a session's local changes are read one git call at a time instead of three at once. (#421)
- On Windows, closing or resizing a terminal at the moment its shell exits should no longer crash the whole app: a known cause is fixed in the terminal library. (#409)

## v0.0.87 — 2026-10-02

### New
- A remote host's project header now shows what the host supports: hover its status dot to see the highest capability reached (observe, liveness, inject, attach) and, for each one above it, why it is missing. (#218)
- A session's Changes panel also lists the changes in the worktrees its subagents are working in, under a header naming the agent and its branch. Those rows open as read-only diffs; a subagent that works in the session's own directory adds nothing. (#303)
- A live session on a remote host that is not open in a terminal has a Send a prompt… button on its row: type a text and it is written to the running session as a new prompt, without attaching. It needs `ncat` or an OpenBSD `nc` on the host, and is refused for a Windows host. The dialog says "Sent": the session's own status shows whether it picked the prompt up. (#219)
- A remote session that is not open in a tab and waits on a dialog on its host, such as a permission prompt or a question, shows the orange attention state, and its status line says what it waits for. It appears and clears with the next refresh of the host. (#394)
### Changed
- After three failed refreshes of a remote host in a row, a row that would have attached opens its transcript and says why in its tooltip, instead of failing when clicked. Stop is never disabled: it runs its own ssh. (#218)
### Fixed
- A step of a trigger chain, the first one included, is no longer typed while the CLI reads busy or waiting on a dialog: it waits for the CLI to be at its prompt, up to the step's deadline, then fails cleanly with a reason instead of being written; a step whose Enter did not start a turn is retried once, or stops the chain when that retry is withheld because the CLI is busy (for a local session, after waiting for the step to show in the transcript) or waiting on a dialog, or you have typed input pending, and is reported as "not confirmed submitted" instead of "sent". Without a readable CLI descriptor a step is still written as before, but no longer once its own deadline has passed. Single triggers are not covered. (#407, #360)
- After an upgrade, schedules keep running in a project that has settings of its own and in a git checkout that already holds a schedule; any other project, opened before the upgrade or not, runs no schedule until you open a session in it or add it. (#385)
- Stopping a terminal twice in quick succession, or resizing it while it is being stopped, no longer closes the Windows pseudo console twice, which could kill the whole app with no error. (#405)
- A sandboxed session, or a sandboxed schedule, whose Additional Directories include a `.claude` or `.git` directory, or a path inside one, is now refused instead of binding it read-write over its read-only protection; add the project directory instead. A session started in a `.claude` or `.git` directory is refused too, except below `.claude/worktrees`, and Additional Directories naming your home directory or a parent of it are refused however the path is written. A relative `add-dirs` entry in a schedule is taken from the schedule's directory. (#385)
- A session that has exited no longer keeps a busy dot in the sidebar, and the status bar's running count drops as soon as the session ends instead of waiting for the next refresh. (#375)
- Quitting, closing the window or reloading while a file in the file panel has unsaved edits now asks first, in any session, kept-aside tabs included: Save writes them (a file that changed on disk is not overwritten), Discard drops them, Cancel stays. If Switchboard does not answer within a few seconds, it closes anyway. (#373)
- The IDE Emulation label in a session's terminal header now says whether the CLI is connected: it reads "IDE Emulation" only while it is, "IDE Emulation: waiting for CLI" when Switchboard is listening but the CLI has not connected, and "IDE Emulation: failed" when it could not start for that session, with the reason in its tooltip. A session whose IDE Emulation port was already taken no longer shows the label as if it worked. (#320)
- On Windows, the file panel no longer opens or saves a credential file (such as one under `.ssh`) through its 8.3 short name or a `\\?\` path. (#390)

## v0.0.86 — 2026-10-01

### New
- A session that has a claude.ai bridge shows an Open on claude.ai button in its sidebar row, which opens that session on claude.ai; a session without one shows nothing. (#213)
- A schedule with `catch-up: true` in its front matter runs once, as soon as Switchboard starts or the machine wakes up, when it fell due while Switchboard was closed or the machine asleep, however many runs were missed in the last seven days. Without it, a missed run is still skipped. (#334)

### Changed
- Without `SWITCHBOARD_SSH_PATH`, the terminal attached to a remote session now runs the `ssh` found on your `PATH` before `/usr/bin/ssh` or the Windows system client, like every other remote operation. `SWITCHBOARD_SSH_PATH` must be an absolute path: a relative one is ignored, with a warning in the log. (#359)

### Fixed
- Hovering terminal output no longer freezes Switchboard when the session's working directory is on a slow network drive: the paths on the line are checked a few at a time without blocking the app. (#322)
- A sandboxed session can no longer leave behind something that runs outside the sandbox later: in `~/.claude` and in every `.claude` of the project, worktrees included, only the session's own state (its transcripts, todos, credentials) stays writable, each repository's config and hooks are read-only, other sessions' shell snapshots and session hooks are out of its reach, and its changes to `~/.claude.json`, where the MCP servers are, are dropped when it ends. A new `.git/commondir`, or a repository or worktree the session creates, still carries config and hooks git will follow. Change settings, permissions, plugins and MCP servers outside the sandbox; the Sandbox indicator's tooltip lists what stays writable. (#358)
- A schedule runs only in a project where Switchboard launched a session, or that you added with Add project; open a session once in a project whose schedules it never ran. Schedules you already have keep running if they are in a git checkout (or a project with settings of its own). A sandboxed schedule is sandboxed by the nearest project setting above it, and one whose `add-dirs` include a directory under your home that is not such a project is skipped, with the reason in the main log. (#358)
- A project that gets its first schedule after this change does not run it until you have opened a session in that project or added it with Add project; a schedule is no longer picked up just because its file appears in a project Switchboard has never recorded. (#372)
- The podman socket is no longer bound into the sandbox by default: through it a session can mount any host path into a container. Put `SWITCHBOARD_SANDBOX_PODMAN=1` in the Pre-launch Command to bind it. (#358)
- A sandboxed session reaches the API when `/etc/resolv.conf` links into `/run`, as with systemd-resolved on Ubuntu. (#367)
- The "Finishing indexing before restoring N sessions" bar no longer stays up when a saved session is not in the index: once indexing is over the session is dropped from the restore and a notice names it. (#376)
- A filter or a search no longer files the subagents of a hidden session under "Orphan subagents". With the starred, running or today filter on, they are hidden with their session; a search hit inside a subagent shows it under its session. The group keeps only subagents whose session is gone. (#356)
- A session started from a Switchboard that was itself launched inside a Claude Code session is now a top-level session: it saves its transcript and no longer inherits the parent session's id, socket or IDE link. `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` and provider switches are kept. (#378)
- A file with unsaved edits in the panel is no longer discarded when the session opens another file, proposes an edit, or a link opens Changes. It is kept aside, named above the file shown, and comes back when the diff or Changes closes, with a notice if the file changed on disk. (#364)
- Saving a file in the panel before its editor has finished loading no longer empties the file on disk; Save stays disabled until the file is shown. (#369)
- `SWITCHBOARD_SSH_PATH` now applies to every connection to a remote host, not only the attached terminal: the pulls, the copy of transcripts, the watch connection, stop and the Changes view use it too. Transcripts are copied with the `scp` beside it, or with `SWITCHBOARD_SCP_PATH` when set. (#359)
- The New Session and Resume Session dialogs no longer grow taller than a short window: they stay below the title strip, the title and the Start or Resume and Cancel buttons stay visible, and the options in between scroll. (#377)

## v0.0.85 — 2026-09-30

### New
- After an update, a "What's new" dialog lists the changes of every version since the one you last ran. Help → What's new opens it again for the current version. (#363)
- An untracked file's line counts show in the Changes list without opening it, and count in the header total. A row that cannot be counted says why: binary, too large, not counted, or count on open for a remote session. (#350)

### Changed
- The session header's controls sit in one row with one look: Sandbox and IDE Emulation are plain indicators, Shell and Changes are icon buttons that show when they are on, and Stop comes last. (#348)
- Whether the session runs is a dot before its name, and its tooltip says how the process ended: stopped, killed, or exited with a code. (#348)
- The Changes panel and its editor use the app's own look: icon buttons, the dark surfaces of the sidebar, a badge for each file's state, and softer diff colours. (#351)

### Fixed
- Saving from the file panel, the Memory panel or the MCP diff tab no longer overwrites a file that changed on disk since you opened it. You are told, and asked before your edits replace it. (#355)
- When an open file changes on disk, the panel reloads it if you have no unsaved edits, and otherwise keeps them and offers Reload or Keep my edits. It keeps noticing changes after the file is replaced, deleted or recreated. (#355)
- Switching tabs or sessions no longer drops a file tab's unsaved edits. (#355)
- A save that fails says "Save failed" instead of failing silently, including one that finishes after you switched to another tab. (#355)
- Once an MCP diff has been accepted or rejected, its tab's Save button is disabled, and its tooltip says why. (#355)
- Undo no longer brings back an edit made in another file, or before the file was reloaded. (#355)
- The Changes panel works when a session's directory is below the repository root; tracked files' diffs came back empty there. (#350)
- A file with a merge conflict is badged `U` (Unmerged) in the Changes list, instead of Added or Deleted. (#351)
- A plain terminal no longer types its `claude` shim into the shell, so the line stays out of your shell history and off the screen. (#352)
- Archiving a session no longer moves its subagents into "Orphan subagents". (#354)

## v0.0.84 — 2026-09-29

### New
- The window draws its own title bar: the sidebar's top row holds a ☰ menu button, and the window controls sit in the top-right corner. The window gains the height the frame took, and every menu shortcut still works. (#338, #341)
- Ctrl+- and Ctrl+0 zoom on any keyboard layout, AZERTY included, and so do the numeric keypad's +, - and 0. (#338)

### Fixed
- A session running in another process, another Switchboard or a CLI in a terminal, is no longer resumed automatically on a reload or a restore. A notice names the process, and opening the session by hand asks first. (#337, #343)

## v0.0.83 — 2026-09-29

### New
- Switchboard can report to a local ActivityWatch server the session you are looking at and every session that runs, without any prompt or transcript content. It is off by default: turn it on in Settings → Activity Reporting. (#326)

### Fixed
- A right-click in a session's terminal no longer pastes the clipboard into Claude Code's prompt outside Native mode, and the terminal keeps its focus. (#330)
- On Windows, the activity trace no longer leaves a rotated file behind. (#328)

## v0.0.82 — 2026-09-22

### New
- A path or a filename in terminal output is a link that opens the file in the side panel, at the line for `path:line`. Only a file the panel can open is underlined. (#319)

### Fixed
- The settings panel shows the value a new session gets. IDE Emulation showed as on while sessions started with it off. (#317)

## v0.0.81 — 2026-09-18

### New
- Click a file in the Changes list to edit it in place, under the list, with the diff updated as you type: inline, side by side, or plain. A save onto a file that changed underneath you is refused, not merged. (#302)
- A shell under the Changes list runs in the session's own directory, worktree included. It is not a session: it never shows in the sidebar. (#300, #305)
- Untracked files are listed in Changes with a real diff and line counts. (#298)

### Changed
- The Changes panel always opens, and says "No changes" or that the directory is not a git repository, instead of showing git's own error. (#305, #310)

### Fixed
- An exited plain terminal reopens as a terminal, not as a Claude session with no transcript. (#305)
- The sidebar no longer overflows the window by the status bar's height, which could clip the top row of icons until a reload. (#306)

## v0.0.80 — 2026-09-17

### Changed
- A `schedule-*.md`, a `CLAUDE.md` or a memory note reached through a symlink is listed in the brain tab, and a linked schedule can be run from it. (#294)
- A project-root `CLAUDE.md`, `GEMINI.md` or `agents.md` that links to a file outside every open project and outside `~/.claude` is no longer listed. To list it again, move the link's target into a directory you have opened as a project. (#296)

### Fixed
- A FIFO, a socket or a device named `CLAUDE.md` in a project no longer freezes the app. (#296)
- A file reached through a symlink is checked against the credential denylist before it is read, so a linked key or `.env` no longer reaches the search index. (#294, #296)
- An unreadable file in a scanned directory no longer hides the files listed after it. (#296)
- An attached remote session's row shows the session's title. (#293)

---

Older versions: see [GitHub Releases](https://github.com/devsuitup/switchboard/releases).
