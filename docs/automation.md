# Automation

Two mechanisms run Claude without you at the keyboard:

- **Schedules** — recurring headless runs, defined as Markdown files and fired
  by a scheduler inside the app.
- **Triggers** — one-shot text typed into a session that is already open,
  requested by dropping a JSON file in a directory. Meant for scripts and
  harnesses.

Both live in the running app: when Switchboard is not running, nothing fires. A
schedule can ask to [catch up](#catching-up-a-missed-run) a run it missed.

## Schedules

A schedule is a file named `schedule-<something>.md` in a project's
`.claude/commands/` directory, with front matter:

```markdown
---
name: Morning audit
cron: 0 9 * * 1-5
enabled: true
slug: morning-audit
catch-up: true
cli:
  permission-mode: auto
  allowed-tools: Bash,Read,Glob,Grep
  model: sonnet
  max-budget-usd: 2
  append-system-prompt: Keep the report under 50 lines.
  add-dirs: /srv/data, /srv/logs
---

The full, self-contained prompt Claude runs each time.
```

| Field | Meaning | Default |
|---|---|---|
| `name` | Display name, in logs and in [ActivityWatch](activitywatch.md) | the file name |
| `cron` | When to run — see below | required |
| `enabled` | Exactly `false` disables the schedule; any other value, or none, leaves it on. [Archiving the folder](session-browser.md#archive-a-folder) can write `enabled: false` | on |
| `slug` | Groups the runs in the sidebar (they share this slug) | the file name without `schedule-` and `.md` |
| `catch-up` | `true` runs once, late, a run missed while Switchboard was closed or the machine asleep — see [Catching up a missed run](#catching-up-a-missed-run) | off |
| `cli.permission-mode` | `--permission-mode` | `auto` |
| `cli.allowed-tools` | `--allowedTools` | `Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch` |
| `cli.model` | `--model` | none |
| `cli.max-budget-usd` | `--max-budget-usd`; must be a number | none |
| `cli.append-system-prompt` | `--append-system-prompt` | none |
| `cli.add-dirs` | one `--add-dir` per comma-separated entry | none |

The body after the front matter is the prompt; a file with an empty body or no
`cron` is skipped. The front matter is read as flat `key: value` lines with one
level of nesting under `cli:`, not as full YAML. The file must use LF line
endings: with CRLF the front matter is not recognised and the file is skipped.
A value containing a control character makes the run fail.

### Which files are scheduled

Every minute, on the minute, the scheduler rereads the `schedule-*.md` files
directly in `<project>/.claude/commands/` for every project Switchboard knows
from `~/.claude/projects/`. Edits apply within a minute, without a restart. A
`schedule-*.md` in the global `~/.claude/commands/` is not scheduled.

### Cron syntax

Five fields — minute, hour, day of month, month, day of week — in local time.
Each field accepts `*`, a number, a range `a-b`, a list `a,b,c` (of numbers or
ranges), or a step over the whole range `*/n`.

Not supported: a step on a range or a start (`0-30/5`, `5/15`), names (`MON`,
`JAN`), `7` for Sunday (Sunday is `0`), and aliases such as `@daily`. An
expression that does not parse never matches, and no error is reported. There
is no daylight-saving handling. A run missed while the app was closed or the
machine asleep is skipped, unless the schedule has `catch-up: true`.

### A run

When the expression matches, Switchboard:

1. writes a new transcript in the project's `~/.claude/projects/` folder whose
   first message is `Scheduled Task: <prompt>`, with the schedule's slug;
2. runs `claude --resume <that id> -p "Run the scheduled task" --permission-mode … --allowedTools …`
   and the other `cli.*` flags, through the **Shell Profile** shell, in the
   project directory, with `FORCE_COLOR=0`;
3. discards the output, and writes the exit code and any stderr to the main log
   (`[schedule]` lines). No notification is shown.

The run appears as a session in the project, grouped with the schedule's other
runs under its slug; open it to read the result.

- One run at a time per slug and project: a tick that matches while the previous
  run is still going is skipped (logged at info level).
- The [sandbox](sandbox.md) setting applies — global, then project. On a
  platform other than Linux a schedule with the sandbox on is skipped and an
  error logged. With the sandbox on, `add-dirs` entries are bound read-write,
  and a run whose `add-dirs` include a directory under your home that is not a
  project, or inside one, is skipped with an error in the main log — see
  [Sandbox](sandbox.md#schedules).
- A schedule runs only in a project Switchboard has launched a session in, or
  that you added with **Add project**. A project with schedules that it never
  opened runs none until you open a session in it once. Schedules you
  already have keep running if they are in a project that has settings of its
  own or in a git checkout (a directory with a `.git`): the list is seeded, on
  first use, with those projects. A project outside both is not in it. See [Sandbox](sandbox.md#schedules).
- The Pre-launch Command and IDE emulation do not apply to scheduled runs.

### Catching up a missed run

A minute that passes while Switchboard is closed, or while the machine is
suspended, is not seen by the scheduler, and a schedule due in that minute does
not run. With `catch-up: true`, Switchboard records when the schedule last ran,
and checks at startup, after the machine wakes up, and every minute: if the
cron expression matched at least one minute since that run, the task runs
**once**, however many runs were missed. Three missed days of a daily task give
one run.

- `true` may be written in any case and in quotes (`True`, `"true"`). Any
  other value, and any other spelling of the key (`catch_up`, `catchup`), is
  ignored without a warning, and the schedule does not catch up.
- A schedule seen for the first time does not catch up: its record starts at
  that moment. If that moment is a minute its cron matches, it runs on time.
- Only the last seven days are looked at. A run due longer ago is not caught up.
- A catch-up run is logged as `[schedule] Catching up: <name> (<cron>), due <time>`,
  and the first message of its session reads
  `Scheduled Task (catch-up: due <time>, started <time>): <prompt>`, both times
  in UTC (ISO 8601). A run in its own minute is logged as `Triggering:` as usual.
- While the previous run is still going, a catch-up is skipped like a tick, and
  that minute counts as handled: it does not run when the previous run ends.
- The record lives in `~/.switchboard/schedule-state/`, one small file per
  schedule, never in the schedule file, so a schedule kept under version control
  does not change when it runs.
- Catch-up is off in an instance started with `SWITCHBOARD_DATA_DIR` set,
  whatever its value: `task dev`, `task test-pr`, and any run from a checkout,
  which sets it to `~/.switchboard-dev`. Such an instance runs every schedule on
  its cron minute only, `catch-up: true` included, keeps no record, and logs
  `catch-up is off` once at startup. It never catches up a run the installed app
  has already made (see
  [Testing a PR](testing-a-pr.md#3-schedules--check-before-you-launch)).
- The minute is recorded when the run starts. A run whose `claude` fails to
  start, or that is cut short by Switchboard exiting, is not caught up again.
- If the recorded minute is ahead of the clock (the clock was set back, or was
  fast and then corrected), a warning is logged and the record starts again
  from the current minute, so the schedule runs at its next matching minute.
- A schedule is known by its file path. Renaming or moving the file makes it a
  new schedule, seen for the first time: it catches up only the runs missed
  after that.
- A schedule turned off with `enabled: false` is not looked at; turned back on,
  it catches up a run it missed in the meantime, within the seven days.
- Archiving a folder with **Disable the enabled schedules** ticked writes
  `enabled: false` into each of its schedule files, which live in the
  project's repository. A file reached through a symbolic link is not changed.
  When the folder shows again, a notice in its group offers to turn them back
  on — see [Archive a folder](session-browser.md#archive-a-folder).
- **Run now** does not count as a run for the record.
- If the record cannot be read or written, the schedule runs on its cron minute
  as if it had no `catch-up`, and a warning is logged.

### Creating a schedule

**Create scheduled task** (the clock) on a project header opens an interactive
Claude session primed to write a schedule file: describe the task and when it
should run, and it writes `.claude/commands/schedule-<slug>.md`. Its
instructions come from `~/.claude/commands/create-switchboard-schedule.md`,
which Switchboard writes at startup when the file is missing and never
overwrites afterwards — edit it to change how schedules are created, delete it
to get the current template back.

Writing the file by hand works the same. Being in `.claude/commands/`, a
schedule is also a slash command: `/schedule-<name>` runs its prompt in any
session.

### Run now

The **Agent Files** tab lists the schedule files with a clock icon and a **Run
now** button, which starts a run at once. **Run now** ignores `cron` and
`enabled`, and does not wait for a run of the same schedule that is still going.
The button shows a check mark once the run is launched; a launch failure is only
logged.

## Triggers

The trigger watcher lets a script type into an open session's terminal. Drop a
JSON file into `~/.switchboard/triggers/` (or `SWITCHBOARD_TRIGGERS_DIR`):

```json
{
  "sessionId": "abc-123-def",
  "command": "/compact",
  "wait": "idle",
  "timeout_ms": 120000
}
```

- `sessionId` — the target; it must be open in Switchboard, with a live process.
  Any open session qualifies, plain terminals included.
- `command` — written to the terminal, followed by a separate Enter keypress. At
  most 4 KB, and no CR, LF, NUL or ESC.
- `wait` — `"none"` (the default) writes now: it does not wait for the session
  to stop being busy, and a prompt written while the CLI is busy is queued by
  the CLI. It holds in two cases only, each up to `timeout_ms`: the prompt holds
  unsubmitted input — see
  [Politeness](#politeness-switchboard-never-types-over-you) — or the CLI shows
  a dialog (a permission prompt, a question), which would swallow the text. At
  the deadline it fails `not sent`. `"idle"` waits for the CLI to be at its
  prompt first, and is the value for anything that must not interrupt a
  response being written; a session held busy by background agents never gets
  there, so it fails `not sent` at the deadline.
- `timeout_ms` — optional bound on all the waiting: idle **and** politeness. A
  positive integer up to 600 000; default 300 000. On a `chain` it is the
  deadline for the **whole chain** — see below.
- `expectedCwd` — optional; see [Target guard](#target-guard).

The directory is created at startup. Only names ending in `.json` are read, and
a file is picked up when its name appears in the directory; rewriting an
existing file in place does not fire it again. Write the trigger under another
name (`abc.tmp`) and rename it to `abc.json`, so the watcher never reads a
half-written file. A trigger must be a regular file (not a symbolic link) of at
most 64 KB; one that fails to parse is retried once 50 ms later. Triggers
already in the directory when the app starts are processed at startup.

`wait` accepts `idle` and `none` and nothing else. A missing field means `none`;
any other value — an empty string, `null`, `"idel"` — is refused before anything
is written, with a `reason` naming the value received. Sending at once on a typo
would type into a session that asked to be waited for.

**A trigger file older than the staleness limit is refused unread.** Its age is
its `mtime` against the moment the watcher picks it up, including after waiting
in the watcher's queue: a `/compact` written six hours ago no longer targets the
same session state. The refusal is an ordinary result — `{"ok": false,
"submitted": "no", "error": "not sent"}`, with the age in `reason`. A trigger
written while Switchboard was closed runs at the next launch if it is still
inside the limit.

### Chains

Instead of `command`, a `chain` of up to 20 steps is typed one after the other,
each submitted and verified before the next:

```json
{
  "sessionId": "abc-123-def",
  "chain": [{ "command": "/compact" }, { "command": "Continue with the plan." }],
  "timeout_ms": 600000
}
```

`command` and `chain` are mutually exclusive, and an empty chain is refused.

**A chain's deadline is one budget for every step.** `timeout_ms`, or its
300 000 ms default, is one deadline taken at the start and shared by the initial
idle wait, every step's politeness wait, every submit verification, and the wait
for the session to finish between steps. It is not restarted per step. A step
may narrow its share with its own `timeout_ms` but never extend it past the
chain's deadline; a per-step value above 600 000 is refused, taking the whole
trigger with it.

The 600 000 cap applies to the `timeout_ms` field only. Without the field, the
budget is `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS`, which is not capped.

Size the budget by what the steps do, not by how many there are. A chain that
compacts and then resumes spends most of it waiting for the session to go idle
after `/compact`: `{"chain": [{"command": "/compact"}, {"command": "…"}],
"timeout_ms": 600000}` is the shape that fits. A session busy for another reason
spends the same budget. Keep `timeout_ms` at 600 000 for a chain that starts
with `/compact` while background agents keep the CLI busy: the step is
confirmed only when compaction ends, and the 82 manual compactions measured
on one machine took from under a second to 332 s from the Enter, median
129 s.

### Environment overrides

| Variable | Meaning | Default |
|---|---|---|
| `SWITCHBOARD_TRIGGERS_DIR` | The watched directory | `~/.switchboard/triggers` |
| `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` | Budget when a trigger has no `timeout_ms` | 300 000 |
| `SWITCHBOARD_TRIGGER_QUIET_MS` | The politeness quiet window | 3 000 |
| `SWITCHBOARD_TRIGGER_MAX_AGE_MS` | The staleness limit | 300 000 |
| `SWITCHBOARD_SUBMIT_ENTER_DELAY_MS` | Delay between the text and its Enter | 50 |
| `SWITCHBOARD_PENDING_OWN_ENTRY_MS` | How long a chain step written while the CLI reads `busy` may take to show in the transcript (not `/compact`) | 30 000 |
| `SWITCHBOARD_SUBMIT_VERIFY_MS` | How long a submission is watched for a turn | 2 000 |
| `SWITCHBOARD_BUSY_FALL_SETTLE_MS` | How long "not busy" must hold between chain steps | 300 |

The triggers directory does not move with `SWITCHBOARD_DATA_DIR`: an instance
run from source watches the same directory as an installed one unless
`SWITCHBOARD_TRIGGERS_DIR` is set — see [Testing a PR live](testing-a-pr.md).

`fs.watch` on a directory whose path contains a Windows 8.3 short name
(`JEAN-B~1`) makes the process abort; use the long path.

### Politeness: Switchboard never types over you

**Nothing is written into a session whose prompt holds input typed and not
submitted.** A trigger arriving while you are mid-sentence waits; if the prompt
is never free before its deadline, it gives up rather than splice its text into
yours.

This is also what makes slash commands work: Claude Code submits `/compact`
through its completion menu, which opens only when the `/` is the first
character of an empty prompt. Typed into a non-empty prompt, a slash command
stays there, unsubmitted.

**How Switchboard knows.** Every keystroke the renderer sends to a terminal goes
through one IPC channel, and `composer-state.js` keeps a copy of the text it
believes is in the prompt, with a cursor. `pending` is that text's length in
code points.

| Input | Effect on the model |
|---|---|
| printable bytes, pasted bytes, `ESC [ 200 ~` … `ESC [ 201 ~` content | inserted at the cursor — a paste's carriage returns are text, and do **not** clear the prompt |
| Enter, newline, Ctrl+U, Ctrl+C | clears |
| Backspace / DEL, `ESC [ 3 ~` (Delete) | removes one code point behind / ahead of the cursor |
| Ctrl+W, Alt+Backspace | removes the word before the cursor |
| Ctrl+K | removes from the cursor to the end |
| Left / Right (`ESC [ C`, `ESC O C`, …), Ctrl+A, Ctrl+E, Home, End | move the cursor; a modified Left/Right moves by a word |
| bare Up (`ESC [ A`, `ESC O A`), Ctrl+V, an unparseable escape | insert one opaque placeholder — the content is unknown, so it counts as one |
| kitty Enter **with** a modifier (`ESC [ 13;2 u`, `ESC [ 13;5 u`) | inserts a line break |
| kitty Enter **without** one (`ESC [ 13 u`), modified Up, OSC, other escapes | nothing |
| SGR mouse reports (`ESC [ < b ; x ; y M`/`m`), focus reports (`ESC [ I`, `ESC [ O`) | nothing, **and the quiet clock does not move**: these are the terminal talking, not the user |

An escape sequence split across two IPC chunks is joined before it is read, so
half a sequence never counts as text. A sequence that cannot be parsed counts
as input: **doubt resolves to busy**.

The prompt is free only when `pending` is zero **and** nothing has arrived on
that channel for `SWITCHBOARD_TRIGGER_QUIET_MS` (3 000 ms). The quiet window
covers the case the model cannot: an Enter that validates a completion empties
the model while the CLI refills the prompt.

**Where the model is blind:**

- It sees only bytes coming from the renderer. Input reaching the PTY another
  way is invisible to it.
- It is a line editor's model, not the CLI's: it knows nothing of wrapping,
  multi-line navigation, or bindings beyond the table. An unmodelled editing
  key leaves `pending` too high — the safe direction, the trigger gives up — and
  it stays so until the next Enter, Ctrl+U or Ctrl+C.
- Ctrl+U is taken to clear the whole prompt, which holds with the cursor at the
  end. Used mid-line, where the CLI may clear only up to the cursor, it would
  under-count.
- Only SGR mouse reports and parameterless focus reports are exempt from the
  quiet clock. A near-miss — a parameter too many or too few, another final
  byte, a report cut by a chunk boundary — counts as input. xterm.js's own
  replies (OSC colour replies, XTWINOPS size replies, DA1, CPR) count as input
  too, and each can cost a trigger up to one quiet window.
- In the alternate screen with mouse tracking off, xterm.js turns the wheel into
  arrow keys: each notch up is a bare Up, one placeholder. Three notches put
  `pending` at 3, and every trigger for that session gives up until the next
  Enter, Ctrl+U or Ctrl+C.
- On Claude Code 2.1.258, Escape does not clear the prompt, and Shift+Up,
  Alt+Up and Ctrl+Up leave it unchanged, so the model treats them as neutral. A
  CLI release that gave them a meaning would make the model under-count, which
  reads a full prompt as free.
- A prompt filled by the CLI itself — a queued message, a restored draft — was
  never typed and is not counted.

The guard applies to every write, including the bare recovery Enter the watcher
sends when no turn started — on a half-typed sentence, that Enter would submit
it. When politeness never allows a write, the result is `{ "ok": false,
"submitted": "no", "error": "not sent", "reason": "…" }`.

**What this costs `wait: "none"`.** It writes now unless the prompt is
non-empty or the CLI shows a dialog; in those cases it waits, bounded only by
`timeout_ms`. All that time the
trigger holds one of the watcher's 8 concurrent slots (`MAX_INFLIGHT`), so a few
triggers aimed at sessions whose user walked away mid-sentence can stall the
queue for everyone. Give triggers that would rather give up a short
`timeout_ms`.

**Two triggers naming the same session never run at once.** The second waits
until the first's result is written before it looks at the session — while
still holding one of the 8 slots. Triggers aimed at different sessions run in
parallel.

### Target guard

A valid `sessionId` naming an open session looks the same whether the writer
chose it correctly or picked up the wrong one — two sessions writing their
transcripts at the same instant, for instance. The optional `expectedCwd`
states the working directory the writer believes the target has, and is checked
before anything is written:

```json
{ "sessionId": "abc-123-def", "command": "/compact", "expectedCwd": "C:\\Projects\\my-worktree" }
```

- **Absent** — nothing is checked.
- **Matches** the session's working directory — the trigger proceeds.
- **Differs** — refused before any write:
  `{ "ok": false, "submitted": "no", "error": "not sent", "targetMismatch": true, "expectedCwd": "...", "observedCwd": "..." }`.
- **The session's directory is unknown** — refused the same way, with
  `targetCwdUnknown: true` instead of `targetMismatch`. A check that let the
  trigger through when it cannot verify would defeat itself.
- **Not a non-empty string** — refused with `not sent`.

Both sides are compared after `path.normalize` and the removal of one trailing
separator. On Windows, case is also folded and the `\\?\` prefix removed; on
macOS and Linux the comparison is case-sensitive and `\` is not a separator.

The comparison is by directory: two sessions in the same directory are not told
apart. 8.3 short names, `subst` drives, junctions and symbolic links are not
resolved; two spellings of one directory count as a mismatch.

### Remote trigger targets

Set the global `remoteTriggers` setting to `true` to allow a single trigger to
send a prompt to an unattached remote session. It defaults to `false` and has
no UI yet; enabling it is maintainer-only for now. The value is the JSON
property `"remoteTriggers": true` in the SQLite `settings` table's row whose
`key` is `global`; the row's `value` holds the global settings object
(`db.js`, `getSetting`/`setSetting`). Preserve its other properties when
changing it. Changes take effect without a restart. With it off, an unattached
remote id gives `session not found`.

Use the same `sessionId`, `command`, `wait` (`none` or `idle`), `timeout_ms`
and optional `expectedCwd` fields. A live local or tmux-attached terminal takes
precedence and follows the existing terminal path. An exited pane can fall
through to the socket. Enabled hosts are checked at trigger time and on every
poll; an id listed by more than one enabled host is refused with both aliases
in the reason. Trigger fields such as `host` cannot choose a host. An id
started since the last pull is not found until the next pull. A remote chain
is refused, with `steps_total` set to its length. `expectedCwd` compares the
descriptor's cwd using POSIX normalization, including on Windows: case matters,
a trailing slash does not, and a missing cwd refuses the write.

`wait: none` needs a completed pull no older than twice the host's refresh
interval; a missing or older pull refuses the write and the reason includes
the last refresh error. It does not require a readable status.

`wait: idle` polls the descriptors from the normal refresh cycle; it never
forces a refresh. Only the second distinct completed pull after the wait began
can establish readiness: the first may have fetched its descriptors before the
wait began. `idle` permits the send, `busy`, `waiting` and `shell` keep waiting,
and an absent or unknown fresh status refuses the send. At the deadline the
reason distinguishes busy, a dialog, a shell command and fewer than two fresh
pulls. Losing the descriptor or disabling the host during the wait gives
`session exited during wait`. Attaching a terminal during the wait aborts it.

This may need about two refresh cycles: about two minutes at the 60-second
floor or ten minutes at the default 300 seconds, plus pull latency. At the
default interval, use `timeout_ms: 600000` (the cap); it can still expire before
two pulls finish. The idle read is at most one cycle plus pull latency and one
poll old, and does not prove the session is idle at the moment of sending.
Host status timestamps are never compared with the local clock. A target
also cannot move to another host during the wait; that change refuses
the send rather than combining pulls from different hosts. The per-session
lock remains held throughout the idle wait and the bounded 15-second send;
another trigger for that id queues behind it.

The socket queues text without typing into the composer, so no composer check,
dialog hold, Enter retry or transcript confirmation runs on this path. Windows
hosts are refused with the key-file reason. Before prefix handling or waiting,
the whole command is refused if it contains a Unicode format character
(`\p{Cf}`), a default-ignorable code point (`\p{Default_Ignorable_Code_Point}`),
U+2800 (braille blank), U+034F (combining grapheme joiner), a variation selector
(U+FE00–U+FE0F or U+E0100–U+E01EF), or a tag-block character (U+E0000–U+E007F),
anywhere in the text. These characters are refused rather than stripped. This
includes Hangul fillers, joined emoji, emoji with variation selectors such as
hearts, soft hyphens and right-to-left marks.

For remaining commands, only leading and trailing whitespace is trimmed for
the prefix check. Only exact `/compact` and `/clear` are allowed slash commands;
their constant text is sent. Other leading-slash commands, arguments and case
variants are refused. A first non-whitespace `!` (bash mode) or `#` (memory) is
also refused. Fullwidth `／` (U+FF0F), `！` (U+FF01) and `＃` (U+FF03) prefixes
receive the corresponding ASCII refusal; `／compact` and `／clear` are refused
too. Plain prompts retain their original text, including ASCII and fullwidth
punctuation in the middle. Plain emoji without refused characters still pass.
An ordinary combining mark before `/`, U+2215 (division slash) and U+FF0E
(fullwidth full stop) still go out as plain text. The CLI's parsing of these
forms is unmeasured.
Local PTY and live tmux-attached delivery keep their existing behavior. Each
refusal returns `error: "not sent"`, `submitted: "no"` and its own reason:

| Command content or prefix | `reason` |
|---|---|
| Refused invisible character or blank anywhere | `the command contains an invisible format character or blank that cannot be sent to a remote session; nothing was written` |
| Unsupported `/` or any `／` | `a slash command other than /compact and /clear cannot be sent to a remote session; nothing was written` |
| `!` or `！` | `a bash-mode command cannot be sent to a remote session; nothing was written` |
| `#` or `＃` | `a memory command cannot be sent to a remote session; nothing was written` |

**The effect of `/compact` and `/clear` over the socket is UNVERIFIED**;
they may execute as commands or arrive as plain text. Whether a prompt during
a permission dialog is queued or lost is also unverified.

Successful socket results add `channel: "socket"`, `host` and
`descriptor: { status, status_updated_at, pulled_at }`, captured before the
write; absent status fields are `null`. `pulled_at` is local epoch milliseconds,
while `status_updated_at` is the host's timestamp. Success is always
`submitted: "assumed"`, `submit_retries: 0`. Ordinary commands omit
`submit_confirmed`; `/compact` reports `submit_confirmed: false` under the
[compact evidence contract](#compact-evidence-contract). The channel has no
reply and can silently drop a prompt. Compare a later status
timestamp from the same host to confirm the effect yourself.

The Send dialog and triggers share the adapter's 30-second dedupe and a bucket
of 30 prompts per host and session, refilling one token every two seconds.
Identical text repeated within 30 seconds is refused before any send; a timeout
also holds that dedupe reservation. A definite failure refunds its bucket token;
an uncertain write keeps it. Other non-zero exits retain the existing dedupe
release behavior. The server can still silently drop a prompt.

### Reading a result

Every outcome — success, refusal, timeout, missing session — writes
`<triggers dir>/processed/<trigger name without .json>.result.json` (through a
temporary file and a rename) and then deletes the trigger file. A chain writes
its result once, when it ends. A trigger file still in the directory without a
result is therefore normally **in flight**. Not always: if the watcher failed to
start, or could not read a name, both logged, no result ever comes. A caller
that polls for a result needs a bound of its own.

```json
{ "ok": true,  "submitted": "activity", "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320, "submit_retries": 0, "steps_total": 1 }
{ "ok": false, "submitted": "no", "error": "not sent", "reason": "4 byte(s) of input are sitting unsubmitted in the composer" }
```

**`submitted` is the field to read, not `ok`.** Text written into a prompt is
not a message received. Four values, compared by strict equality, ordered
`no` < `assumed` < `activity` < `confirmed`:

| Value | Meaning |
|---|---|
| `confirmed` | for `/compact`, a new manual compaction boundary was observed after its Enter; for other commands, transport verification observed a turn after a clean write (or a CLI descriptor reaction) |
| `activity` | the session was seen busy after the write, but either the prompt read-back could not rule out interference, or the session was already busy when the text was written |
| `assumed` | written, no failure seen, nothing observed afterwards |
| `no` | nothing was written, or it was written and not submitted |

A chain's top-level `submitted` is the **weakest** value any step reached; each
entry of `steps[]` carries its own `submitted` on the same scale. Read the last
entry to know whether the final step — a resume prompt after `/compact`, say —
was itself confirmed.

**What `confirmed` proves, and what it does not.** It means the three checked
facts for ordinary commands, nothing more. The turn check is a level probe over the
verification window, not an edge tied to this write: any busy transition in the
window satisfies it — a human typing, another process. Triggers aimed at the
same session are serialized, so a second trigger cannot cause it, but an actor
outside the watcher can. A caller that must not act twice on one intent still
checks the effect itself — a smaller context, a new transcript, a file on disk.
Take `confirmed` as "the hand-off went through cleanly", `activity` as
"something happened, unattributed". A slash command that misses the completion
menu is sent as an ordinary message starting with `/`, and produces a turn too.

#### Compact evidence contract

**`/compact` waits for its effect.** A generic turn or descriptor update is
insufficient. The session transcript must contain a new main-thread manual
`compact_boundary` stamped at or after the command's Enter. A pre-write cursor
reads appended records in bounded chunks, so retained records after the boundary
cannot hide it outside the normal transcript tail. Compaction keeps
the existing step deadline (and the chain's global cap); it returns as soon as
the evidence is observed, then retains the existing readiness checks for the
next step, carrying the observed turn into the idle settle gate without waiting
for another busy rise. No recovery Enter is sent while awaiting compaction. Without
evidence by the deadline, `ok: false`, `error: "step not confirmed"`,
`submit_confirmed: false`, `compaction_observed: false` and an explanatory
`reason` are returned. `submitted` is `activity` or `assumed`, because bytes
were written; it is never `confirmed`. The chain stops and does not send the
resume step. This also applies to a compact as the final or only step.

A successful compact carries `compaction_observed: true`,
`submit_confirmed: true` and `confirm_source: "compact_boundary"`. For a chain,
top-level `compaction_observed` is true only when **all requested compacts**
were observed, including any unsent tail. PTY command/step fields `written`
and `turn_observed` distinguish fully written text/Enter from an observed turn;
an observed compaction also sets `turn_observed: true`.
Activity does not establish causality. Chain results add `steps_written` and
`steps_with_turn_observed`, while `steps_completed` excludes an unconfirmed
compact. Other commands keep their existing contract and omit
`compaction_observed`. Absent observation fields do not mean success.

An inaccessible transcript (including a tmux-attached remote session) cannot
confirm compaction. Socket sends retain assumed delivery and report
`compaction_observed: false`; socket chains remain unsupported. Missing
evidence does not prove that retrying is safe. The boundary proves that manual
compaction occurred after the write; it cannot identify who requested it if a
human also requested compaction at the same time.

**`error` is compared by strict equality**, so explanations are in `reason`,
never in `error`: `not sent: input pending` is not `not sent`.

| `error` | What it promises | What to do |
|---|---|---|
| `not sent` | **not one byte reached the session**: no idle came, politeness never allowed a write, or the trigger was refused before any write (stale, bad `wait`, bad `expectedCwd`, target guard) | nothing happened; it is safe to send again |
| `send unconfirmed` | a socket write timed out or returned an unclassified non-zero exit; the line may have reached the session; `written` is `unknown` and `submitted` is `no` | check the session before retrying; a timeout reserves identical text for 30 seconds |
| `background session, not attached here` | a live local CLI descriptor identifies a background session, but this instance has no attach tab for it; nothing was written, `submitted` is `no`, and `jobId` and `sessionId` identify the target | attach the job in the Agents view before retrying |
| `chain timeout` | at least one step **was written**, and the expected effect was not observed before the deadline | assume the written steps landed |
| `step not confirmed` | text **was written** and nothing more was typed. For a single or chained `/compact`, its boundary evidence was not observed before the deadline; see the [compact evidence contract](#compact-evidence-contract). For an ordinary chain step, submission was not confirmed and recovery Enter was withheld by a busy/waiting descriptor or pending input. A readable local transcript under `busy` allows up to 30 s for the step's own entry, then up to the step deadline for its turn to finish; `reason` identifies the failed wait | inspect the session before retrying: the step may be unsubmitted, queued, running, or completed without readable evidence |
| anything else | free text: `session not found`, `target process not running`, `missing required field`, `invalid timeout_ms`, `command and chain are mutually exclusive`, `trigger too large (max 64 KB)`, `command too long (max 4 KB)`, `trigger must be a regular file`, `pty write failed: …` | read `submitted` to know whether anything landed |

A trigger to a live local background session without an attach tab returns
`{ ok: false, submitted: "no", error: "background session, not attached here", jobId, sessionId }`.
The error string is a contract compared by strict equality. No headless attach
is started. Once its attach tab is open, the trigger uses that tab's PTY and
the background session's descriptor for readiness; `/compact` also needs
evidence from the background session's transcript. Unknown ids and unresolved
remote targets still return `session not found`; resolved remote socket targets
keep their existing delivery path.

The two reserved values mean opposite things:

- A chain whose first step landed and whose second was held back by politeness
  reports `chain timeout`, never `not sent`.
- A `wait: "idle"` that expires before the session goes idle reports `not sent`,
  with `reason` *timeout waiting for idle; nothing was written* for a `command`,
  and *timed out waiting for the session to go idle; nothing was written* plus
  `partial: false` for a `chain`. A session reports itself busy for as long as
  any subagent runs, so `idle` is often unreachable; `not sent` there tells the
  caller the payload never left.
- A single `command` with `wait: "idle"` is held like a chain step: after the idle
  wait and the politeness wait, it is not written until the CLI's descriptor
  reads `idle`, up to `timeout_ms`. An `idle` stamped before the settle window
  is ready at once; a more recent one settles for at most the time left. If it
  still reads `waiting` then, the result is `not sent` with `reason` *the CLI
  reports a dialog open (waiting); nothing was written into it*; `busy` gives
  *the CLI still reported a turn running (busy) at the deadline; nothing was
  written*, and a session whose background agents keep the parent descriptor
  `busy` (#360) always ends so: use `wait: "none"` for it. An `idle` that
  never held long enough to settle gives *the CLI was idle only briefly before
  the deadline; it never held long enough to settle; nothing was written*. Without a readable
  descriptor at the first read nothing is waited for.
- A single `command` with `wait: "none"` keeps its write-now meaning: `busy`,
  `idle` or an unreadable descriptor write at once, with no settle. The only
  hold is a dialog: while the descriptor reads `waiting`, nothing is written,
  and at `timeout_ms` the result is `not sent` with the dialog reason above. A
  descriptor lost after it read `waiting` keeps the hold.
- Every single `command` is also never written once its `timeout_ms` has passed
  (`not sent`, *the step deadline passed before it could be written; nothing
  was written*). Keystrokes typed in the terminal are never held back: they are
  how a dialog is answered.
- A chain step is held until the CLI's descriptor reads `idle`, up to the step's deadline. If it still reads `busy` or `waiting` (or any status other than `idle`) then, the step is not written: `not sent` for the first step, `chain timeout` for a later one, with the cause in `reason`. A session with delegated agents running keeps the parent descriptor `busy`, so such a chain fails cleanly instead of typing into a busy composer. Without a readable descriptor at the first read nothing is waited for, but a step is never written once its own deadline has passed (it then fails `not sent` or `chain timeout`).
- When the wait ends because the session never got there and the CLI's
  descriptor read `waiting` (a dialog is open: a permission prompt or a
  question) at any sample in the last few hundred milliseconds of it, `reason`
  says so: *the CLI reports a dialog open (waiting); nothing was written into
  it* for a `command` or a chain's initial wait, in place of the plain timeout
  reason. A chain whose turn was still awaited after a step was written ends
  `chain timeout` with `reason` *the CLI reports a dialog open (waiting) while
  the turn was awaited; the step had been written*; without a dialog, that
  result carries no `reason`. Without a readable descriptor, results are as
  before. The result file is the only place this is reported: answer the dialog
  in the session.
- A session that exits during that initial wait reports `submitted: "no"` and a
  `reason` saying nothing was written (`partial: false` on a chain).

### `waited_ms` / `total_waited_ms`

Both count every wait the trigger spent, at different scopes:

- A `command` result carries `waited_ms`: the `wait: "idle"` wait (0 with
  `wait: "none"` or an idle session), plus the politeness wait, plus the
  readiness wait (for `wait: "idle"`, the time spent until the descriptor read
  idle; for `wait: "none"`, the time a dialog held it, else 0), plus the
  submission verification and its retry, if any.
- A `chain` result carries `total_waited_ms` for the whole chain, and a
  `waited_ms` in each `steps[]` entry: that step's politeness wait, its
  verification, and — for every step but the last — the wait for the session to
  finish before the next step. `total_waited_ms` is the initial idle wait plus
  the sum of the entries, **except** when the chain stops before a step starts
  because the session exited or the deadline passed: that last partial wait
  counts in `total_waited_ms` but belongs to no entry.

### A truncated chain

`steps_completed` counts steps whose wait **completed**. A step that was written
and then timed out waiting has an entry in `steps[]` but is not counted: a chain
that sent `/compact` and timed out waiting for the session reports
`steps_completed: 0` with one entry. Read as "nothing went out", that would send
`/compact` twice.

Read `steps[]`, not the count. It holds the steps the chain **reached**. A step
whose politeness wait never found a free prompt has an entry too, with
`submitted: "no"` — the only way a step entry carries that value, and the mark
of a step that was never written. With `steps_total` (on every result):

- when the last entry's `submitted` is `"no"`, that step was **not** sent, and
  the unsent tail starts at its `idx`;
- otherwise the last entry was sent, and the tail starts at `max(steps[].idx) + 1`;
- the tail runs to `steps_total - 1`;
- with no entry at all, the whole chain is the tail.

Taking `max(steps[].idx) + 1` in every case loses a resume prompt that
politeness held back. An empty `steps: []` and a missing `steps` both mean
nothing went out; read them as `(result.steps || []).length === 0`.

### Failures in the watcher itself

**An exception while deciding a trigger's fate** — a body that is valid JSON but
not a usable shape, such as `null` or a non-object chain step — still ends in a
result and a deletion: `{ "ok": false, "error": "internal error: <message>",
"internal": true }`. Only this path sets `internal: true`, so "the watcher
broke" can be told from "the trigger was refused" without parsing `error`.

**When deleting the trigger fails** (permissions, a locked file, a non-regular
entry), the file stays, the result is still written, the failure is logged, and
the name is remembered for the life of the process, so a later event on it never
runs the command twice. A name that has a result in `processed/` has been
processed, whatever the directory still shows.

**`processed/` is never pruned.** Callers that write many triggers clean it
themselves.

The main use is context-management harnesses: a hook that sees a full context
window and injects `/compact`, then a resume prompt, into its own session.
