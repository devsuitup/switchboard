# Context: terminal-path-links

**Purpose**: a filesystem path or bare filename printed in the terminal — by an
agent's prose, `git status`, a stack trace, `grep -n`, anything — is a link that
opens the side panel. Only what the panel has established it can open becomes a
link.

## Key files

| File | Role |
|---|---|
| `public/terminal-path-links.js` | The matcher, the per-path cache, and the xterm link provider. Dual-mode: a classic `<script>` in the renderer, `require()`-d by `test/terminal-path-links.test.js`. |
| `terminal-path-target.js` | Main-side openability: the one question the provider asks per candidate. |
| `main.js` | `resolve-terminal-paths` handler. |
| `public/terminal-manager.js` | Registers the provider per terminal; routes a click to `openFileInPanel`. |
| `public/file-panel.js` | `openFileInPanel(sessionId, path, { line })` — both routes into the panel carry the line. |
| `public/viewer-panel.js` | `revealLine(n)`. |
| `public/codemirror-setup.js` | `window.cmRevealLine(view, n)`. |

## Three decisions this rests on

### A candidate is checked, and the check is "may the panel open this"

**Only a path the panel has established it can open becomes a link.** The
underline is not a claim about what the text looks like; it is the result of
the open having already been decided, which is why the matcher may be widened
and the check may not be moved to the click.

xterm asks a link provider for the links on **one hovered line**, not on every
render, so the cost is bounded by what the pointer touches rather than by
output volume. That budget is spent on one question per candidate, asked of
the main process: may the panel open this path?

`resolve-terminal-paths` answers it with the guard the file-panel IPCs already
enforce — `isSensitivePath`, on the disk-resolved path — plus regular-file-ness,
the panel's own size bound, and a NUL-byte sniff of the first 4 KB. A path that
fails any of those gets no link at all.

Regular-file-ness is load-bearing rather than tidy: a FIFO answers `statSync`
and then blocks `openSync` and `readFileSync` until a writer appears, which on
the main process means no IPC served, no PTY pumped and no window response
until the app is killed. `read-file-for-panel` therefore makes the same check
on the other side of the click. The two are separate resolutions of the same
string — the openability answer is cached for 30 s and the user still has to
click — so the name can become a FIFO in between, and only the check the reader
makes itself protects the read it is about to do.

Nothing else filters. Shape decides only what is worth asking about: a bare
word is a candidate, so the check is the whole of what stands between arbitrary
scrollback text and an opened file. Linking on shape and refusing on click
reads as a simplification and is the defect this is built against — it teaches
the reader that an underline means nothing.

The existence check runs **first**, because on a line of prose most candidates
are not files and a path that is not there is refused whatever the denylist
says. Everything that does exist still passes `isSensitivePath` before anything
else is decided, so the set of checks a linked path has survived is unchanged;
only the refusal reason differs for a path that is both missing and
credential-shaped. Measured: 45 µs per candidate with the denylist first, 14 µs
with the stat first.

### Relative paths resolve main-side, against the session's own cwd

The renderer sends the session id and the matched texts. `resolve-terminal-paths`
derives the session's real working directory through `resolveGitChangesTarget`
— the same resolution the Changes panel uses — and resolves against it. The
renderer never learns where a session lives; it receives an absolute path only
for a file that has already been accepted, which is what `readFileForPanel`
needs to open it.

A remote session is refused: its paths name files on the far host, and this
check stats the local disk. So is a session whose working directory cannot be
resolved at all — an unresolved cwd is not "no cwd", which would still admit
absolute paths and `~/…` against the local disk and the local home. A panel
shell resolves through the session that owns it, the same way its spawn does.

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

**Existence and openability are the filter, not a guess about what the writer
meant.** A token with no separator is a candidate too: if a file of that exact
name is really in the session's working directory and the panel would open it,
it becomes a link. `README.md` in prose is clickable when that file is there.

Extensionless names are included — `Makefile`, `Dockerfile`, `LICENSE` are real
files people name in prose, and a list of "filename-shaped" extensions would be
exactly the guess about intent this rule refuses. The cost is main-side only and
is stated under "The cache".

The consequence is accepted rather than worked around: a sentence using an
ordinary word that happens to name a file in the cwd — "we should **plan** the
work", with a file called `plan` next to it — links that word.

Two passes over the hovered logical line:

1. **Bare** — `(?:[A-Za-z]:)?(?:SEG(?:[/\]SEG)*|(?:[/\]SEG)+)(?::\d+(?::\d+)?)?`,
   with a lookbehind that refuses a start inside a longer token. A candidate
   followed by `://` is dropped, and every interior position of a URL follows a
   path character, a `:` or a `/`, so `http`/`https` stays with `WebLinksAddon`
   and `file://` with the existing `linkHandler`.
2. **Quoted** — the inner text of a `` ` ``, `"` or `'` span, only when it
   contains a space. A quote is the only delimiter that makes a space inside a
   name unambiguous. Unquoted, `my file.txt` matches `my`, which then fails
   openability and produces no link — half a name is not linked.

No component may exceed 255 characters, which is what a filename component can
be, not a judgement about shape. Trailing prose punctuation
(`.,;:!?)]}>'"` `` ` ``) is stripped before the `:line:col` suffix is parsed, so
`see /etc/hosts.` links `/etc/hosts`.

The two passes can produce overlapping candidates (a quoted span and the bare
match inside it). Openability decides between them: overlaps are resolved
**after** the answers come back, and the wider one wins only once it has been
accepted. A quoted span that is really prose — the text between two
apostrophes — is refused and leaves the bare link inside it standing.

At most 64 candidates per line.

## The cache

A line's unknown candidates go out in **one** call, and `createTerminalPathResolver`
memoises the answers per `sessionId` + text, refusals included. The in-flight
promise is what is stored, so a second hover of the same line while the first is
still out adds nothing. Entries live 30 s and the map is capped at 4096;
`forget(sessionId)` runs when a terminal is destroyed.

### The memo evicts least-recently-used

A `Map` sheds its oldest insertion, so a hit re-inserts its entry before
returning it. Without that, eviction is insertion order: the moment a sweep's
distinct-candidate count passes 4096 the reuse rate falls to zero in one step
rather than degrading, and a log with near-unique tokens per row pays the full
price on every pass. The prose sweep below carries 3225 distinct candidates —
79 % of the cap — so the cliff is within reach of ordinary input, and re-insertion
is what keeps the cap from being load-bearing.

Measured, against real prose (this repository's own context docs, 200 columns
wide):

| | calls | paths carried | wall |
|---|---|---|---|
| one 13-word sentence, first hover | 1 | 13 | — |
| the same sentence, hovered again | 0 | 0 | — |
| 1000-line sweep, first pass | 883 | 3225 | 135 ms (0.135 ms/line) |
| 1000-line sweep, second pass | 0 | 0 | 32 ms (0.032 ms/line) |

Without the batch those 3225 paths would be 3225 calls. The batch is what keeps
the call count at one per line no matter how many words the line has, and the
memo is what takes the second pass to zero.

Of those 3225 distinct candidates, 211 contain a dot and 3014 do not. Admitting
the extensionless ones therefore costs 40 µs per hovered line of dense prose,
once, and nothing thereafter — which is what the decision to include them rests
on.

## Bounds

- **The link provider must not touch the write path.** It runs on a pointer
  event, never on a write: `handleTerminalData` and the flush path have no call
  into it, which is what makes terminal throughput unchanged by construction.
- The reachable line of a hovered row walks at most 24 wrapped buffer rows.
- `resolve-terminal-paths` reads bytes but returns none: its answer is a
  yes/no plus the resolved path, and it accepts at most 64 paths per call.
- The handler is synchronous, so one call occupies the main process for as long
  as its paths take: 14 µs each, and at most 64 of them — under a millisecond in
  the worst case, and 50 µs for the 3.65-path average measured over the prose
  sweep. It stops entirely once a region of the scrollback has been hovered.
  Those figures are CPU against a local disk; the cost is one `stat` of latency
  per path, so a session whose cwd is on a network filesystem blocks the main
  process for the batch's whole round-trip rather than for its CPU.

## What this does not change

`http`/`https` links, the `file://` route into `openFileInPanel`, and the CLI's
own `Read(…)` / `Edit(…)` tool headers all behave exactly as before.

An OSC 8 hyperlink emitted from a tool call still never reaches the terminal:
a tool call's stdout is a file under the session's `tasks/` directory, and
`/dev/tty` cannot be opened from there. Nothing here can change that — which is
why the path in the prose has to be the link.
