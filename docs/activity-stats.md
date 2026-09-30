# Stats

The **Stats** tab summarises the activity recorded in every indexed
transcript. It is computed when the tab is opened.

## What it shows

- **Rate Limits**: the Claude plan's usage — the 5-hour window, the week, and
  any per-model limit — with percentages and reset times. It is fetched from
  Anthropic's usage endpoint with the CLI's OAuth credentials (the macOS
  Keychain, or `~/.claude/.credentials.json`). **Refresh usage** fetches it
  again. The same figures are the gauges in the [status bar](notifications.md#status-bar).
- **Cards**: Total Sessions, Total Messages, Total Tokens, Tool Calls, Current
  Streak and Longest Streak (in days), and one token count per model.
- **Last 30 days**: a bar per day; hovering one shows its tokens, messages and
  tool calls.
- **Heatmap**: 52 weeks, one cell per day, shaded by the number of messages that
  day.

A day's messages are the user and assistant messages whose own timestamps fall
on it (UTC date); a user entry that only carries a tool result is not counted.

## Data source

Everything but the rate limits comes from Switchboard's own SQLite database,
filled by indexing the transcripts under `~/.claude/projects` — and the mirrored
transcripts of [remote hosts](remote-hosts.md). Claude Code's
`~/.claude/stats-cache.json` is not read. The footer says when the figures were
last computed.
