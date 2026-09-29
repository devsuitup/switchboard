# Context: activitywatch

Switchboard reports session activity to a local [ActivityWatch](https://activitywatch.net)
server, when the user has turned it on in Settings → Activity Reporting. It is
off by default, and off means nothing is sent and no connection is attempted.

## Key files

| File | Role |
|---|---|
| `activitywatch-client.js` | HTTP to the server: bucket creation, heartbeats, explicit events, a probe. Assumes the server is absent. |
| `activitywatch-reporter.js` | Turns focus and session lifecycle into writes to two buckets. Pure; timers and clock injected. |
| `main.js` | Constructs both, feeds the reporter from `open-terminal`, the PTY exit handler and `before-quit`; the `*-activity-reporting-*` and `activity-focus` IPCs. |
| `session-transitions.js` | Calls `rekeyActivity` when a session is re-keyed to its real id, beside `rekeyMcpServer`. |
| `public/app.js` | `reportActivityFocus()` — the renderer owns which session is shown and whether the window has focus. |
| `public/activity-reporting-panel.js` | The Settings section's toggle and status line. |

## Two buckets, two mechanisms

The user's attention and the work that ran are different quantities, and a view
that adds them answers neither question. They are kept apart by bucket **and**
by type:

| | Attention | Running |
|---|---|---|
| id | `aw-watcher-switchboard_<hostname>` | `aw-watcher-switchboard-running_<hostname>` |
| type | `app.editor.activity` | `app.session.running` |
| holds | the one session on screen while the window has focus | every Claude session, start to exit |
| data | `{project, file}` — `file` is the name the sidebar shows | `{session, project, name?}` |
| written by | heartbeat | one explicit event per session |

**The types differ on purpose.** ActivityWatch's web UI selects editor buckets
by type (`bucketsByType(…, "app.editor.activity", true)`), not by id. A running
bucket of the same type would land in the Editor view and be summed with the
attention bucket. With `app.editor.activity` on the attention bucket only, the
Editor view shows time spent on sessions, grouped by `project` and by `file`.

**The mechanisms differ because heartbeats cannot express concurrency.** The
server merges a heartbeat only against the bucket's single most recent event,
and only when `data` is identical. One focused session at a time is exactly the
case that merges: repeated beats of an unchanged focus extend one event.
Several sessions running at once interleave their `data`, and every beat becomes
its own zero-duration event — six interleaved heartbeats for two sessions store
six events of duration 0. So a running session is written once, at its end, as
`POST /events` with the span the main process measured. Overlapping events are
what the query engine expects there: `merge_events_by_keys` gives per-session
totals and `period_union` gives wall-clock time with the overlap counted once.

Busy/idle is not in either bucket. It flips several times per turn, and since
merging is keyed on the whole `data`, a field that changes that often would
fragment every event it sits in.

### Attention

- A beat is sent on every focus change, and a keepalive re-beats the focused
  session every 30 s. `pulsetime` is 60 s, above the keepalive; below it, every
  event would fragment.
- On a switch the **outgoing** session is beaten once more before the incoming
  one. A heartbeat ends its event at its own timestamp, so without that final
  beat the outgoing span would end at its last keepalive, up to 30 s early.
- Window blur is a focus change to nothing: the event ends at the blur.
- The renderer re-reports focus after every project reload, so a name generated
  after the session was focused (a late AI title) reaches the bucket. The
  reporter drops a report identical to the current focus, so this costs nothing
  when nothing changed.

### Running

- Counted: sessions spawned locally that are not plain terminals and not panel
  shells. A shell sitting open is not work running. Remote sessions are not
  counted: their lifecycle belongs to another host.
- A session is timed from its spawn even if reporting was turned on later; the
  span is written at exit only if reporting is on then.
- `name` is the last name the renderer showed for that session, so a session
  never focused has none. It is omitted, not guessed.
- A re-key moves the span and the name to the real id, so the event carries the
  id the rest of the app uses.

## Failure

ActivityWatch runs when the user starts it, which is often not at all. Every
client call resolves to a boolean and never rejects.

- A refused connection starts a cooldown — 5 s, doubling to a 60 s cap — during
  which calls return `false` without touching the network. A success resets it.
- The transitions are logged once each (unreachable, reachable again), never per
  call.
- A 4xx does **not** start a cooldown: it is the server answering, and treating
  a malformed payload as an absent server would hide the bug behind a retry.
- Losing the server forgets which buckets exist: it may come back as a fresh
  database, so each bucket is asserted again.
- **Nothing is queued.** A beat or an event produced while the server is down
  is dropped. The attention bucket loses the time it was down; a session that
  ends during that window loses its running event.
- Requests time out after 2 s.

### Creating a bucket is idempotent

`POST /api/0/buckets/<id>` answers `304` when the bucket already exists. `fetch`
reports `ok` only for 2xx, so a client reading `ok` alone would re-create the
bucket before every beat. The client treats 304 as success.

## Quitting

`before-quit` writes every session still running as a span ending now. It holds
the quit for that write, bounded at 1.5 s, and only when reporting is on and a
session is live — otherwise the quit is not delayed at all. An app that is
killed rather than quit writes nothing for its live sessions.

## The IPC surface

| Channel | Direction | Carries |
|---|---|---|
| `get-activity-reporting-state` | invoke | `{enabled, destination, url, reachable, buckets}`. `reachable` is probed at the call while reporting is on, and `null` while it is off — nothing is contacted then, so there is no answer to give. |
| `set-activity-reporting-enabled` | invoke | a boolean; persists `global.activityReporting`, returns the state. |
| `activity-focus` | send | `{sessionId, name, project}` or `null`. Main checks the id is a string and bounds `name` to 200 and `project` to 1024 characters before anything is forwarded. |

What reaches the server is limited to session ids, project paths and session
names. No transcript content, prompt or command is sent.
