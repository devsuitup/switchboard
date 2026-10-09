# Session Restore

Switchboard can reopen, at launch, the sessions that were open when it last
closed.

## The setting

**Global Settings → Application → Restore Sessions on Startup**:

| Option | Behaviour |
|---|---|
| **Don't restore** | Nothing is reopened |
| **Ask on startup** (default) | A bar asks *Restore N session(s) from last time?*, with **Restore** and **Dismiss** |
| **Restore automatically** | The sessions are reopened without asking |

The setting is read at launch; a change applies from the next start.

## What is saved

Each time a session is opened or closed, Switchboard saves the open set — each
session's id and project, and which one was active — in its global settings
(`openWorkingSet`).

## What restore does

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

If a conversation continued under another id, restore follows its continuation
chain and saves the final id with the saved entry's project and active state.
One final id is selected automatically. A target absent from the index, the
transcripts on disk and live CLI processes is ignored when its parent has another existing
continuation. A transcript present on disk but not yet indexed still holds
restore with a waiting-for-indexing notice; held entries retry once when indexing
finishes. If process status cannot be checked, a missing target remains unresolved
instead of being discarded. If all of a node's targets are missing,
restore stays unresolved rather than reopening that node automatically.
Several final ids, a cycle or a malformed continuation record hold the saved entry
without launching it. A non-blocking notice names the held conversation and
asks you to open it from the sidebar to choose; other saved sessions continue
restoring. Automatic restore never displays a continuation confirmation dialog.

Clicking an old sidebar row offers its continuations, listing each id and its
last activity. After declining the candidates, you can explicitly choose
**Open the original session** or cancel. An unresolved continuation also offers
this explicit original-session choice, with a warning and any known candidates.
The original id is never silently selected when continuation information exists.
Ordinary malformed lines that mention continuations, unrelated incomplete tails
and oversized records do not block opening the original session. Large transcripts
are indexed in yielded chunks without a total byte limit.

A live continuation remains a candidate even before its first transcript record
exists. A live background continuation uses the existing attach path and its final id
stays in the saved working set for a later restore.

Within one run of the app, going back to a session whose process still runs is
a reattach: the terminal replays its buffered output onto the same process.
