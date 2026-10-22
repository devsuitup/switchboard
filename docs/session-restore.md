# Session Restore

Switchboard can reopen, at launch, the sessions that were open when it last
closed.

## The setting

**Global Settings → Application → Restore Sessions on Startup**:

| Option | Behaviour |
|---|---|
| **Don't restore** | Nothing is reopened |
| **Ask on startup** (default) | A bar asks *Restore N session(s) from last time?*, with **Restore** and **Dismiss** |
| **Restore on click** | Nothing is started; the sessions are marked in the sidebar, and each is resumed when you click it — see [Restore on click](#restore-on-click) |
| **Restore automatically** | The sessions are reopened without asking |

The setting is read at launch; a change applies from the next start.

## What is saved

Each time a session is opened or closed, Switchboard saves the open set — each
session's id and project, and which one was active — in its global settings
(`openWorkingSet`).

### A session with no transcript yet

A session started with **+**, or one just cleared with `/clear`, has no
conversation until its first prompt: the CLI has nothing to resume, and the
index does not list it. It is saved as a *fresh* entry (`fresh: true`, with
its project). Restore waits for indexing to finish before it treats a fresh
entry as having no transcript: one whose first prompt landed before the quit
is indexed by then and is resumed like any other session. A fresh entry that
is still not in the index then is started anew: a new session in that project,
with the project's current defaults for a new session, except that it never
creates a worktree, since the saved project path already is the folder to
start in. Once its first prompt makes it a real session, the set is saved
again with it as an ordinary entry. A session without a transcript is still
left out when it runs on a remote host, or was started as a fork or in a new
worktree: starting it anew would not give back the same thing. In **Restore on
click** mode a fresh entry not in the index is dropped instead, since that
mode starts nothing by itself and the entry has no row to click.

## Closing the app

Quit, Restart to update and window close can move eligible conversations to
the background before stopping the remaining local work. Switchboard waits
up to ten minutes for a working conversation to finish its turn, with Cancel
available throughout. Confirmed moves keep their tab positions and reopen as
attach tabs at the next start; no attach starts during a successful exit.

This choice checks that the saved set was read and that the final write
succeeded, with a two-second bound. A failed move or save keeps Switchboard
open, stops nothing and reattaches the confirmed moves. A failed recovery
attach remains saved for retry from the sidebar. A new process appearing
before commit renews consent without attaching the already moved sessions.
External OS exits flush unchecked and do not recover tabs. Confirmed jobs are
marked; an unresolved handoff is not saved as confirmed and is found through
the old conversation's continuation on the next start. Untagged macOS Dock
Quit and logout can bypass the session choice; force termination can bypass
the save entirely.

The saved set is written on each open and close half a second later, so
the last change before quitting could be lost, and so could the whole set:
quitting stops every session, and each of those exits was itself a "session
closed" that saved the set again — empty, if the app took longer than that
half second to go away.

Once a close or quit is confirmed (the window's close, ☰ → Quit, an update
install; see the unsaved-edits guard in `.ai/contexts/viewer-panel.md`), the
renderer writes the set at once, before it answers main (`flushStateForExit`
in `public/app.js`, called by the `unsaved-check` handler in
`public/file-panel.js`, bounded to 2 s; Move stays open on a failed write,
while Stop keeps its best-effort save), and stops saving it for the next 10 s. Main stops sending
`process-exited` once `before-quit` starts killing the sessions
(`appQuitting`), so the shutdown cannot record them as closed. A reload is
not an exit and does neither. A quit or close that arrives while a reload's
question is still open joins it, and main tells the renderer the question is
now an exit (`unsaved-check-reason`), so the answer still waits for the write,
and the page is not reloaded before the quit. If the page had already answered
the reload when the upgrade reaches it, it writes the set then, and main waits
for it to report the write done (`unsaved-check-reason-done`, bounded to
2.5 s, and not at all once the page has crashed) before quitting; the page
sends that report at once when it has nothing to write then. A close or quit
that arrives during that wait joins it rather than asking again.

The write keeps the saved sessions that are not open yet: those the index has
not reached, those offered by the Restore prompt and not answered, and those
the restore is still starting (`pendingRestoreEntries`). So quitting during a
cold index, before answering the prompt, or in the middle of a restore keeps
them for the next start, while a session you stopped during the restore is
left out. The saved active marker stays on its session until the restore has
opened it, and passes to the replacement of a fresh entry while that one opens. An entry still awaiting consent that you attach by hand is saved during the ask window. An exit before the saved set has even been read writes nothing.

If the exit is cancelled, invalidated or the installer fails to start, saving
resumes immediately and writes any work skipped during the exit. The 10 s
grace remains a fallback for exits that disappear without explicit invalidation.

A Windows logoff or shutdown (`query-session-end`, `session-end`) does not
ask about unsaved edits; main sends `exit-flush` instead, and the renderer
writes the set without waiting for an answer. That write is best effort:
Windows may end the app before it lands. Main also starts a coalesced, bounded,
non-destructive drain without closing the database or stopping PTYs/services.
A query expires after 60 s; user Quit, X and Restart always ask independently
of this external approval, including within that window.

User Quit (Exit on Windows), Restart to update and window close ask about
unsaved edits first, then name the local work that will stop in a separate
Stop/Cancel question. Only both approvals permit the final renderer write.
A late reload-to-exit upgrade also asks before writing. On macOS, Dock Quit
and logout arrive as untagged external before-quit events: with no unsaved
edits they can stop local sessions without the Stop question. JB accepted
this residual on 2026-10-21; app-menu Cmd+Q asks. Force termination bypasses
questions and flushing. Scheduled children are outside this inventory, with
no guarantee of survival across every OS exit.

## What restore does

If both initial attempts to load the project list fail, all startup restore is
deferred. Switchboard makes up to three delayed retries; a successful retry runs
startup restore, including reopening the active session and restoring the Agents
view.

When several conversations share one web-session row in the sidebar, restore
also finds saved members of that row. It reopens and saves each member under
its own id, checks that member for continuations and processes live elsewhere,
and shows its running and active state on the shared sidebar row. This applies
to both automatic restore and the startup Restore prompt.

Restore is a respawn, not a reattach: a session's process is a child of the
app and ends when the app quits. Each restored Claude session is started again
with `claude --resume <id>` and the project's **current** effective settings —
permission mode, sandbox, pre-launch command and the rest — not the options of
its previous launch. Sessions reopen one after another, half a second apart.

- A session that is no longer in the index (transcript deleted, worktree
  removed) is skipped.
  Once indexing is over, a saved session that is still missing is dropped from
  the restore, the bar goes away, and a notice names it: *Not restored:
  &lt;name&gt; is not in the index*.
- A session live in another process — another Switchboard, or `claude` in a
  terminal — is skipped, and a notice names it for 15 seconds:
  *Not reopened: &lt;name&gt; is live in pid N*. It stays in the saved set, so a
  later start can reopen it. See
  [Launching sessions](launching-sessions.md#sessions-live-in-another-process).
- On a first launch, while the index is still being built, restore waits for
  indexing to finish; in **Ask** mode the bar says *Finishing indexing before
  restoring N session(s) from last time…*.
- Opening a session yourself while restore is running cancels the rest of it.

Reloading the renderer with a remembered active session reopens that session and
cancels the working-set planner, so it does not ask to restore or reopen the
other saved entries. A manual open also cancels held continuation retries;
an automatic remembered open does not cancel those retries.
If the saved session that was active is still missing after indexing finishes
and the projects load succeeds, reload shows the same dismissible notice as
startup restore, including when restore is off, with steps to check the
transcript, reindex and retry from the sidebar; both passes list it only once.
A new session with no transcript is not reported missing: its running terminal
is reattached, or its saved fresh entry follows the startup restore setting.
Other live terminals are reattached too. An exited terminal outside the saved
working set or a session in a hidden project is not reported missing. If the
startup projects load fails, restore waits for a successful load.

If a conversation continued under another id, restore follows its continuation
chain and saves the final id with the saved entry's project and active state.
One final id is selected automatically. A target absent from the index, the
transcripts on disk and live CLI processes is ignored when its parent has another existing
continuation. A transcript present on disk but not yet indexed still holds
restore with a waiting-for-indexing notice; held entries retry once when indexing
finishes. Its pending notice clears after the retry has run. If you opened a
session manually during indexing, the automatic retry is cancelled; if the
final reload fails twice, it cannot start. In either case, a persistent notice
names the held sessions and says **Open it from the sidebar to retry restoring**.
Their saved working-set entries are kept.
If process status cannot be checked, a missing target remains unresolved
instead of being discarded. When every continuation target is proven absent
and nothing else is unresolved, restore opens the saved part directly. A
15-second notice says that its continuation no longer exists on disk, so it
was opened as it was. Manual opening follows the same rule.
Several final ids without a valid remembered choice, a cycle or a malformed continuation record hold the saved entry
without launching it. A non-blocking notice names the held conversation and
asks you to open it from the sidebar to choose; other saved sessions continue
restoring. Automatic restore never displays a continuation confirmation dialog.

Opening a row with continuations outside that row shows one **Open which part?**
dialog. It lists the candidates and the part you clicked by name, last activity,
message count when known, and where each is running. The newest available part
is preselected; **Open** has focus and Enter opens it. **Cancel** opens nothing.
A background part without an identifiable job is disabled with its reason.
A scheduled part remains selectable and then asks **Resume anyway**.
An incomplete list says so, as does a failure to check which parts are running.
With no known candidate, a failed lookup or unresolved continuation offers
**Open as it was** or **Cancel**, with the reason. Switchboard remembers choices
across restarts when the continuation graph can be checked. It opens the chosen
part directly while it remains available and no new part appears. An unchosen
part disappearing does not ask again. If the chosen part continues linearly,
Switchboard follows it; a new branch or a vanished choice asks again. Choosing
the clicked part remembers that conversation, including its latest part.
Incomplete or failed checks never use or store a choice. If saving fails, an
error notice says so while the part still opens.

To change a remembered choice, right-click its row and select **Choose part to
open…**. The saved choice is preselected when still listed; **Cancel** keeps it.
Deleting a part removes its saved choice. After startup indexing, Switchboard
also removes choices for rows that are no longer in its cache; it keeps them
while the initial scan is incomplete.

Automatic restore holds ambiguous entries without a valid choice and never shows the chooser. Reload also
holds an ambiguous entry and shows the same dismissible notice naming it and
asking you to open it from the sidebar to choose. If restore and reload both
hold it, the notice lists it only once.
If the continuation lookup fails, reload and restore instead say that Switchboard
could not check the conversation's continuations. While an automatic retry is
scheduled, the notice says restore will retry when indexing finishes; otherwise
it asks you to open the session from the sidebar to retry checking and restoring,
without asking for a continuation choice.
A proven linear chain or same-row bridge alternative needs no choice.
Ordinary malformed lines that mention continuations, unrelated incomplete tails
and oversized records do not block opening the original session. Large transcripts
are indexed in yielded chunks without a total byte limit.

A live continuation remains a candidate even before its first transcript record
exists. A live background continuation uses the existing attach path and its final id
is saved with `bg: true`, so every later restore reattaches it while the job is
live. A saved entry without that mark still skips a session live elsewhere.

## Restore on click

No `claude` process is started at launch. Each saved session that is in the
index gets an outlined dot in the sidebar and stays visible there whatever the
visible-session count and age limit say. The grid starts empty, and no session
is selected, the last active one included.

- Clicking a marked session resumes it, like any other click. It stays marked
  until it is open: if it is live in another process and you decline to resume
  it, or its terminal fails to start, it is still marked and still saved. One
  whose conversation continued under another id is resumed there, and the new
  id takes its place in the saved set; if that continuation is already open,
  it is shown and the marked session is simply dropped from the saved set. A
  continuation declined or failing to start stays marked and saved under the
  new id, also when you open it before the marking has reached it. A saved
  session you click while the marking is still running is marked too until it
  is open, so it stays saved if it fails to start.
- **Don't restore**, in a marked session's right-click menu, removes it from
  the saved set without starting it. So does deleting the session.
- A marked session never clicked stays in the saved set, so the next start
  marks it again. A saved session not yet marked, because indexing has not
  reached it, is kept too when the set is saved before then.
- Opening another session does not stop the marking, which goes on until
  indexing is over.
- A project folded because its sessions are old opens when it holds a marked
  session.
- The previous/next session keys stop on marked sessions too, and resume the
  one they land on. Holding a key down skips them: the repeats cycle through
  the open sessions only, so they never resume a row of marked sessions one
  after another. The grid has no card for a marked session, so in the grid
  they skip it.
- A saved session that is a member of a merged web-session row marks that
  row. Clicking the row resumes its newest marked member, or shows the member
  already open; either way the row is open, so every member of it is dropped
  from the marked and saved sessions. A second click, or the session keys,
  while a member is still starting wait for that start: if it fails, the row's
  marked members stay marked and saved. **Don't restore** and deleting the row drop every
  marked member of it, and the session keys resume a marked member under its
  own id, or show the member already open. After a reload, a member whose row
  already has a running member is not marked, whatever its place in the saved
  set: the row is open.
- Reloading the window starts nothing. A saved session whose process is still
  running is reattached, the selected one included; the others are marked. A
  process that ends during the reload is not started again. Reattaching never
  changes the selected session, so a session you open meanwhile stays shown.
  A running member of a merged row whose reattach waited for another member you
  opened meanwhile is marked if that open fails.

Within one run of the app, going back to a session whose process still runs is
a reattach: the terminal replays its buffered output onto the same process.
