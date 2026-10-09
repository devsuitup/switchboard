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

### A session with no transcript yet

A session started with **+**, or one just cleared with `/clear`, has no
conversation until its first prompt: the CLI has nothing to resume, and the
index does not list it. It is saved as a *fresh* entry (`fresh: true`, with
its project). On the next start a fresh entry needs no index: restore starts
a new session in that project, with the project's current defaults for a new
session, except that it never creates a worktree, since the saved project
path already is the folder to start in. Once its first prompt makes it a real
session, the set is saved again with it as an ordinary entry. A session
without a transcript on a remote host is still left out.

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

Within one run of the app, going back to a session whose process still runs is
a reattach: the terminal replays its buffered output onto the same process.
