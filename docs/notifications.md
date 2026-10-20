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
| Background work running | Static violet ⠿ | — | Claude is at its prompt, background tasks still run under it | The last background task ends |
| Waiting for input | Orange hollow ring | — | Switchboard saw Claude finish a turn in a session open here, a session running elsewhere is at its prompt, or a background job is blocked (including while attached here) | A new turn starts or the job leaves blocked |
| Running | Green dot | — | Switchboard holds a live process for the session and has not seen a turn end since that process started or since the last turn began | Claude finishes a turn, or the process exits |
| — | Grey dot | — | Anything else | — |

The two violet states are explained on [Subagents](subagents.md#live-status).

A blocked background job keeps its Blocked label and tooltip. Blocking alone
does not request attention. When Claude separately asks for your attention,
such as with a permission prompt, the blinking LED takes priority.

Sessions Switchboard does not run itself have no terminal to read signals
from. Their row shows the working spinner while their transcript is being
written, until 20 seconds of silence, and never "response ready":

- a local session run by `claude` in another terminal;
- a session on a [remote host](remote-hosts.md#status).

The animations advance in discrete steps rather than smoothly, to keep the
app's idle CPU use low
([decision 0002](decisions/0002-discrete-steps-sidebar-animations.md)).

## Where the states come from

- **Working** follows the spinner glyph Claude Code puts at the start of the
  terminal title (OSC 0), and its progress reports (OSC 9;4). Switchboard does
  not poll the transcript for this.
- **Needs your attention** follows Claude Code's desktop notifications (OSC 9)
  whose text mentions attention, approval, permission, "needs your" or "wants
  to enter". The notification's text also replaces the terminal title in the
  header while the session is on screen.
- **Response ready** is set when the working state ends while you are looking
  at another session. The "waiting for your input" notification ends the
  working state too.
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

## Status bar

The bar at the bottom of the window shows `N running · N sessions · N projects`
(the running count only when it is above zero), and transient messages such as
indexing progress and the update status.

On the right, **usage gauges** show the Claude plan's rate limits: the 5-hour
window, the week, and any per-model weekly limit, each with its percentage and,
in its tooltip, when it resets. They are fetched every 5 minutes from
Anthropic's usage endpoint with the CLI's own OAuth credentials (the macOS
Keychain, or `~/.claude/.credentials.json`), and are hidden when none are
available. Clicking them opens the [Stats](activity-stats.md) tab.
