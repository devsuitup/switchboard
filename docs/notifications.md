# Status Indicators

Every session row in the sidebar has one status icon, left of its name, so the
sessions that need you stand out while you work in another one.

![Status Notifications](../build/screenshot-notifications.png)

## The icon

When several states hold at once, the first one in this table wins:

| State | Icon | Name colour | Set when | Cleared when |
|---|---|---|---|---|
| Needs your attention | Orange LED, blinking, with a halo | orange | Claude Code sends a notification asking for attention, an approval, a permission, or to enter plan mode, for a session you are not viewing | You open the session |
| Response ready | Blue dot with a glow | blue | Claude finished working in a session you are not viewing | You open the session |
| Working | Light-blue braille spinner | light blue | Claude is working | Claude stops |
| Working, with subagents | The same spinner, violet | light blue | Claude is working and subagents run under it | — |
| Background work running | Static violet ⠿ | — | Claude is at its prompt, with background tasks, such as subagents or a command it started in the background, still running in a local session | The last background task ends |
| Waiting for input | Orange hollow ring | — | Switchboard saw Claude finish a turn in a session open here, a session running elsewhere is at its prompt, or a background job is blocked and idle (including while attached here) | A new turn starts or the session activity changes |
| Idle, open here | Green dot with a small dot below it | — | A terminal is open here, with no higher activity state | Activity changes or the terminal exits |
| Idle | Grey dot | — | No higher activity state | Activity changes |
| Not running | Solid grey dash | — | A finished background job has no live process | Liveness changes |

Remote sessions do not detect background commands.

The two violet states are explained on [Subagents](subagents.md#live-status).

Hover the icon for its activity and lifecycle, for example `Idle · Open here`,
`Running in background`, `Running on <host>` or `Running elsewhere`. A remote
tab open here says `Attached here · runs on <alias>`; a session awaiting restore
says `Not reopened · restores on click`. Job state and CLI details follow
without repeating the same words. These details stay out of the glyph.

A live background session reporting busy supplies Working when its head turn is
open or unknown, even when its job says blocked or done. A closed PTY or transcript
turn wins over that descriptor; a closed working turn keeps its background-work
display. A waiting descriptor, such as a permission dialog, makes the
attention LED blink without a separate notification. A blocked idle job keeps
its Blocked label and waiting ring; a done idle session shows the idle dot.
This reverses #728's rendering. A background idle descriptor never closes a
head turn held open by transcript evidence.

Sessions Switchboard does not run itself have no terminal to read signals
from:

- a local session run by `claude` in another terminal;
- a session on a [remote host](remote-hosts.md#status) with no tab open here.

Their row follows the turn of the conversation's newest part, read from its
transcript, while the CLI's descriptor shows the process alive. It shows the
working spinner while that turn is open; a newer idle descriptor stops it, and
silence alone does not. When Switchboard sees the turn go from open to closed
in a session you are not viewing, the row shows Response ready, as for a
session run here. A live session whose transcript gives no turn state shows
the waiting ring with the tooltip **Turn state unavailable**, unless its
descriptor already reports the prompt.

The animations advance in discrete steps rather than smoothly, to keep the
app's idle CPU use low
([decision 0002](decisions/0002-discrete-steps-sidebar-animations.md)).

Codex tabs use the same Working, Needs your attention and Response ready
indicators. Codex title spinner frames indicate work, **action required**
indicates attention, and **approval requested** notifications ask for attention.
These signals are separate from the Claude signals below.

## Where the states come from

- **Working** follows the turn of the conversation's newest part, read from
  its transcript when the transcript changes: an open turn shows Working while
  the process is alive (a terminal here or a live CLI descriptor). The spinner
  glyph Claude Code puts at the start of the terminal title (OSC 0) and its
  progress reports (OSC 9;4) are only hints: they cannot start Working on their
  own. An idle signal from the terminal or from the CLI's descriptor that is
  newer than the transcript's latest turn evidence ends it.
- **Needs your attention** follows Claude Code's desktop notifications (OSC 9)
  whose text mentions attention, approval, permission, "needs your" or "wants
  to enter". The notification's text also replaces the terminal title in the
  header while the session is on screen.
- **Response ready** is set when Switchboard sees the turn go from open to
  closed while you are looking at another session. The "waiting for your
  input" notification ends the working state too.
- Plain output does not count as work: it only updates the session's last
  activity time.

Local and remote session rows show what the session waits for while its status
is `waiting`, plus the age of that status,
for example `permission prompt · 1m ago`, or `1m ago` without a reason.
The status icon's tooltip and accessible name include the CLI's own status
(`busy`, `idle`, `waiting`, `shell`) and the waiting reason. These come from the
CLI's own session descriptor — see [Session browser](session-browser.md#session-rows).
For both local and remote conversations with several parts, the line and icon
details come from the latest part's descriptor, when available.
A local waiting reason updates even when the status itself stays `waiting`.
Background jobs keep their job activity labels. Grid icon tooltips show the
shared activity label without the sidebar's CLI status detail.

[Debug mode](activity-trace.md) records every one of these signals, and what
the sidebar did with it, when an indicator looks wrong.

## Unexpected errors

An uncaught exception or unhandled promise rejection in Switchboard's main
process does not stop the app. It is written to the application log and shown
in one error notice that groups the five most recent distinct errors, each
followed by its count when it repeated (*(3 occurrences)*). Screen readers
announce a new error once, not each count update. **Open log** opens the
application log and leaves the notice in place. Errors you have not dismissed
are shown again after a window reload; dismissing the notice removes them, and
only a new occurrence brings one back.

## Notice history

Notices and question dialogs record their appearance, dismissals and answers
in the application log. The history is bounded, including an hourly limit for
repeated events. Common credentials are masked; session titles and prompts
are excluded, while project paths remain. Restore and Restart clicks are
identified. Manage old logs in
[Settings → Advanced → Diagnostics](activity-trace.md#deleting-older-log-files).

## Status bar

The bar at the bottom of the window shows `N open here · N sessions · N projects`
(the open-here count only when it is above zero), and transient messages such as
indexing progress and the update status.

On the right, **usage gauges** are grouped under **Claude** and **Codex**.
Claude shows its 5-hour window, week and any per-model limit (such as Fable).
Both groups label windows by duration: **Week** for seven days, **5h** for five
hours, and compact labels such as **24h** or **3d** for other durations. Codex
only shows a 5h gauge when that window is present in its data, regardless of
whether the API calls it primary or secondary. Each gauge shows its percentage;
its tooltip keeps the source label and reset time. Claude figures are fetched every 5 minutes from
Anthropic's usage endpoint with the CLI's own OAuth credentials (the macOS
Keychain, or `~/.claude/.credentials.json`), and are hidden when none are
available. Clicking them opens the [Stats](activity-stats.md) tab.

Enable **Show Codex usage** in Settings → Sessions → CLI Agents to add Codex
gauges in the Codex group, including named model limits. It is off by default;
unavailable Codex usage hides quietly. See [Settings](settings.md#cli-agents-and-codex)
for the credentials and endpoint it uses.

Switching a CLI off in Settings hides its whole group. Turning **Show Codex
usage** off also removes the Codex group immediately. The footer stays on one
fixed-height row, with fixed minimum percentage widths to keep ordinary usage
updates steady. Group labels and gauges use the current light or dark palette.
