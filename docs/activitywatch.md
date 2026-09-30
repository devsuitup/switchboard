# ActivityWatch

Switchboard can report the time spent on Claude sessions to
[ActivityWatch](https://activitywatch.net), the local time tracker, at
`http://localhost:5600`.

It is **off by default**; off, nothing is sent and no connection is attempted.
Turn it on in **Global Settings → Activity Reporting → Send session activity to
ActivityWatch**. The switch applies at once, without **Save Settings**, and is
remembered across launches (`activityReporting`). Nothing leaves the machine.

Below the switch, a status line says whether the server answers. While it does
not, nothing is queued: Switchboard retries on its own, backing off to once a
minute, and writes again once the server is back.

## Two buckets

The time you spent on a session and the time it ran are different quantities,
so they go to separate buckets:

| | Your attention | What ran |
|---|---|---|
| Bucket | `aw-watcher-switchboard_<hostname>` | `aw-watcher-switchboard-running_<hostname>` |
| Type | `app.editor.activity` | `app.session.running` |
| Holds | the session whose terminal is on screen | every Claude session, from start to exit |
| Shown in | ActivityWatch's **Editor** view, by project and by session | queries and custom views; sessions overlap there, as they did |

**Attention** counts a session while its terminal is on screen, the window has
focus, and there has been input in the last 3 minutes. It stops while Settings,
Agent Files, Work Files, Stats or a transcript viewer replaces the terminals.

**What ran** counts every Claude session launched by Switchboard, scheduled runs
included (named `Scheduled: <schedule name>`), whether or not you looked at it.
Each running session is written when it starts, every minute, and when it ends,
so a crash loses at most its last minute. Plain terminals and panel shells are
not counted, nor are sessions on remote hosts.

## What is sent

Each event carries the session's id, its project (name and path) and its name —
the one you gave it, or the title Claude generated; a session with neither is
sent under its id. No prompt, command or transcript content is sent — not even
the first prompt the sidebar shows for an untitled session.
