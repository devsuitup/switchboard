# Context: terminal-path-links

**Purpose**: a filesystem path printed in the terminal — by an agent's prose,
`git status`, a stack trace, `grep -n`, anything — is a link that opens the
side panel. Only paths the panel may actually open become links.

## Key files

| File | Role |
|---|---|
| `public/terminal-path-links.js` | The matcher, the per-path cache, and the xterm link provider. Dual-mode: a classic `<script>` in the renderer, `require()`-d by `test/terminal-path-links.test.js`. |
| `terminal-path-target.js` | Main-side openability: the one question the provider asks per candidate. |
| `main.js` | `resolve-terminal-path` handler. |
| `public/terminal-manager.js` | Registers the provider per terminal; routes a click to `openFileInPanel`. |
| `public/file-panel.js` | `openFileInPanel(sessionId, path, { line })` — both routes into the panel carry the line. |
| `public/viewer-panel.js` | `revealLine(n)`. |
| `public/codemirror-setup.js` | `window.cmRevealLine(view, n)`. |

## Three decisions this rests on

### A candidate is checked, and the check is "may the panel open this"

xterm asks a link provider for the links on **one hovered line**, not on every
render, so the cost is bounded by what the pointer touches rather than by
output volume. That budget is spent on one question per candidate, asked of
the main process: may the panel open this path?

`resolve-terminal-path` answers it with the guard the file-panel IPCs already
enforce — `isSensitivePath`, on the disk-resolved path — plus regular-file-ness,
the panel's own size bound, and a NUL-byte sniff of the first 4 KB. A path that
fails any of those gets no link at all.

Underlining `.env` and then denying the click would teach the reader to
distrust the underline. A link that does nothing is worse than no link.

### Relative paths resolve main-side, against the session's own cwd

The renderer sends the session id and the matched text. `resolve-terminal-path`
derives the session's real working directory through `resolveGitChangesTarget`
— the same resolution the Changes panel uses — and resolves against it. The
renderer never learns where a session lives; it receives an absolute path only
for a file that has already been accepted, which is what `readFileForPanel`
needs to open it.

A remote session is refused: its paths name files on the far host, and this
check stats the local disk.

### `path:line` and `path:line:col` carry the line into the panel

Compiler output, `grep -n` and stack traces all print it. `openFileInPanel`
takes `{ line }` and both routes honour it:

- an unchanged file opens in the viewer, which scrolls to the line once the
  CodeMirror bundle has resolved;
- a changed file opens its diff, and the line is applied to the editor the
  diff created — unified, side-by-side and plain all show the working-tree
  document, so the line number means the same thing in each;
- a changed file that is **not** editable falls back to a read-only `git diff`
  text, where a working-tree line number has no target. The panel says so in
  its notice rather than dropping the line silently.

## What becomes a candidate

A candidate always contains a path separator. A bare word never becomes a
link, even when a file of that name sits in the session's cwd: prose names
files constantly, and linking every one of them is noise plus an IPC per word.

Two passes over the hovered logical line:

1. **Bare** — `(?:[A-Za-z]:)?(?:SEG)?(?:[/\\]SEG)+(?::\d+(?::\d+)?)?`, with a
   lookbehind that refuses a start inside a longer token. A `scheme://` prefix
   makes every interior position follow a path character or a `:` or `/`, so
   URLs never match and `http`/`https` stays with `WebLinksAddon` and `file://`
   with the existing `linkHandler`.
2. **Quoted** — the inner text of a `` ` ``, `"` or `'` span, only when it
   contains a space. A quote is the only delimiter that makes a space inside a
   path unambiguous. Unquoted, `docs/my file.txt` matches `docs/my`, which then
   fails openability and produces no link — half a path is not linked.

Trailing prose punctuation (`.,;:!?)]}>'"` `` ` ``) is stripped before the
`:line:col` suffix is parsed, so `see /etc/hosts.` links `/etc/hosts`.

The two passes can produce overlapping candidates (a quoted span and the bare
match inside it). Openability decides between them: overlaps are resolved
**after** the answers come back, and the wider one wins only once it has been
accepted. A quoted span that is really prose — the text between two
apostrophes — is refused and leaves the bare link inside it standing.

At most 16 candidates per line.

## The cache

`createTerminalPathResolver` memoises per `sessionId` + matched text, negatives
included, because a pointer swept across the scrollback would otherwise fire one
IPC per line per pass. The in-flight promise is what is stored, so simultaneous
lookups of the same path share one call. Entries live 30 s and the map is capped
at 1000, oldest shed first; `forget(sessionId)` runs when a terminal is
destroyed.

Measured: a 1000-line sweep over a line carrying four distinct candidates costs
**4 IPC calls**, and 0.018 ms per hovered line.

## Bounds

- **The link provider must not touch the write path.** It runs on a pointer
  event, never on a write. Terminal throughput is unchanged: 694.8 MB/s before,
  692.7 MB/s after, through `handleTerminalData` in the jsdom harness.
- The reachable line of a hovered row walks at most 24 wrapped buffer rows.
- `resolve-terminal-path` reads bytes but returns none: its answer is a
  yes/no plus the resolved path.

## What this does not change

`http`/`https` links, the `file://` route into `openFileInPanel`, and the CLI's
own `Read(…)` / `Edit(…)` tool headers all behave exactly as before.

An OSC 8 hyperlink emitted from a tool call still never reaches the terminal:
a tool call's stdout is a file under the session's `tasks/` directory, and
`/dev/tty` cannot be opened from there. Nothing here can change that — which is
why the path in the prose has to be the link.
