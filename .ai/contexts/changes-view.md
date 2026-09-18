# Context: changes-view

**Purpose**: A git-status-sourced view of a session's working tree, in the
same right-hand file panel IDE Emulation already uses — for local and remote
sessions alike, and editable in place on a local one. Issue #251.
User-facing behavior:
`docs/changes-view.md`. IPC names and the path-guard table entry:
`.ai/contexts/ipc-bridge.md` ("Changes panel"). The panel's tab-type
integration: `.ai/contexts/viewer-panel.md` ("Changes mode").

## Key files

| File | Role |
|---|---|
| `git-changes.js` | Pure parser — no electron, no DOM, no fs. `require()`-d from `main.js` and from tests, same pattern as `remote-hosts.js` / `derive-project-path.js`. |
| `git-changes-runner.js` | Runs the git commands, local or remote, behind one interface. |
| `git-changes-target.js` | cwd resolution for the panel's IPCs, extracted out of `main.js` for testability (same rationale as `delete-session-target.js`). |
| `git-changes-file.js` | The content pair and the write target behind the editable diff: the `<rev>:<path>` guard, the repository-containment check, the read and the write. |
| `git-changes-watch.js` | The registry behind `git-changes-watch`: arms `fs.watch`, debounces, re-arms after a rename, and reports the repo-relative path. |
| `public/file-panel.js` | Renderer: the `'changes'` tab type, its rows, the editor, and the read-only diff-line renderer. |
| `public/session-activity.js` | `onSessionIdle()` — the no-polling refresh hook. |

## Parser (`git-changes.js`)

- `parseStatusPorcelainV2(text)` → `{branch:{head,upstream,ahead,behind}, files:[{path,origPath,staged,unstaged,untracked,renamed,state}]}`. Record types `1` (ordinary), `2` (rename/copy — `origPath` and `renamed:true`), `u` (unmerged), `?` (untracked, `state:'?'`). Type `!` (ignored) and any future/unrecognized record type are dropped rather than thrown on.
- `parseNumstat(text)` → `{[path]: {added, deleted}}`. Binary files report `-` in git's own output; that becomes `null` here, not `0`, so a caller can tell "no lines changed" apart from "line count unknown".
- `mergeChanges(status, numstatStaged, numstatUnstaged)` → the panel's model: each file gets `added`/`deleted` summed across whichever of the two numstat maps have an entry for it (a file modified in both the index and the worktree has two independent diffs; a file already staged and now edited again is a real, common case, not an edge case). An untracked file's counts stay `null` at this stage — `git diff --numstat` never reports untracked files at all, and status makes no per-file call to find out (see "Untracked files" below). `totals` sums only the known (non-null) counts.
- `diffHeaderNamesPath(content, path)` → whether a diff's `diff --git a/<p> b/<p>` first line names exactly `path`, in either the verbatim or the C-quoted spelling. The containment layer that needs no filesystem — see "Untracked files".
- `countNewFileDiffAdditions(text)` → the added-line count of a new-file unified diff, or `null` when the diff is binary (`Binary files … differ`). It counts only lines *after* the first `@@` hunk header, so a file whose own content starts with `+++ ` or `@@ ` is counted like any other line — a plain "starts with `+` but not `+++`" test miscounts exactly there.
- **Both parsers consume `-z` (NUL-separated) output — see "Quoting rule" below.** They walk an explicit index into `String(text).split('\0')` rather than a plain `for...of` over lines, because a rename/copy record spans TWO tokens instead of one:
  - **Status** (`2 <xy> ... <score> <path>\0<origPath>\0`): the origPath is the very next token — no tab embedded in the first one the way non-`-z` porcelain v2 does it.
  - **Numstat** (`<added>\t<deleted>\t\0<oldpath>\0<newpath>\0`): an EMPTY path field (immediately followed by NUL) signals a rename; the actual paths are the next two tokens, old then new — never the `old => new` / `dir/{old => new}/suffix` arrow spellings numstat emits without `-z`.
  - Both record regexes carry the `s` (dotAll) flag so a raw, unquoted embedded newline in a path — `-z` never quotes anything, unlike the default porcelain/numstat output — still falls inside `.` instead of truncating the match.

## Runner interface (`git-changes-runner.js`)

`createGitChangesRunner({kind, cwd, alias, exec, timeoutMs, fsOps})` → `{status(), diff(path, {staged, untracked}), isWorkTree()}`. `status()` runs three commands in parallel (`git status --porcelain=v2 --branch -uall -z`, `git diff --numstat -z`, `git diff --cached --numstat -z`), merges them, and reports `untrackedCollapsed` (see "Untracked files"). `diff()` runs `git diff [--cached] -- <path>` — or, with `untracked: true`, `git diff --no-index -- /dev/null <path>` (see "Untracked files") — capped at 512 KB (`MAX_DIFF_BYTES`) measured in UTF-8 bytes and cut on a line boundary, with a `truncated` flag.

- **Local** (`kind: 'local'`): `child_process.execFile('git', args, {cwd, timeout, maxBuffer})` — cwd is `execFile`'s own option, never a `-C` argument. No shell is invoked, so argument content cannot be interpreted as a command regardless of what it contains; timeout 10s.
- **Remote** (`kind: 'remote'`): the same ssh transport `remote-attach.js` already uses for the tmux probe/restore calls (`buildRemoteCommandArgs`, `defaultRunRemoteCommand`) — `ssh -o BatchMode=yes -o ConnectTimeout=5 -n <alias> "git -C '<cwd>' '--literal-pathspecs' 'diff' '--' '<path>' ..."`. Timeout 20s. This command string DOES run through a shell on the far end.
- **`invoke(args, remoteOpts)`** is the single choke point both `status()` and `diff()` go through: it prepends `--literal-pathspecs` (`buildGitArgs`, see "Quoting rule") to every argv/command, and threads `remoteOpts.maxStdoutBytes` to the remote transport only (the local path's `execFile` `maxBuffer` already bounds it).

### Quoting rule: literal pathspecs, `-z`, a stdout cap, and single-quote escaping — not an allowlist

Four independent defenses, added after an adversarial review of the first cut of this panel (issue #251):

1. **`--literal-pathspecs` on every invocation** (`buildGitArgs`, prepended before the subcommand for both the local argv and the remote command string). Without it, a path starting with `:` (`:(exclude)x`, `:/`, `:(top)`) is interpreted by git as pathspec magic even after `--`. This flag disables all such magic globally, so a path is always taken literally as a path — belt-and-suspenders with the next point, not a replacement for it (a refactor that stops calling `buildGitArgs` should not silently reopen the hole).
2. **`isSafeGitPath` also rejects a leading `:`** directly, independent of the flag above.
3. **`-z` instead of relying on `core.quotepath`** — see "Parser" above. Git's *default* porcelain v2 / numstat output C-quotes a path with embedded quotes and octal-escapes non-ASCII bytes (`café.txt` → `"caf\303\251.txt"`) whenever `core.quotepath` is on (the git default) — a user's own git config, not something this app controls. That escaped spelling does not round-trip back into a working `git diff -- <path>` pathspec, and status/numstat could in principle escape the same path two different ways. `-z` never quotes anything — NUL-separated records instead of LF-terminated, quoted lines — so status and numstat always correlate on the exact same path bytes, and the path handed back to `diff()` is exactly the path git will accept.
4. **A capped stdout on the remote transport** (`defaultRunRemoteCommand`'s `maxStdoutBytes`, default 8 MB) — see "Remote transport stdout cap" below. Independent of the pathspec-safety points above; this one bounds memory/time on a huge or runaway response instead of trusting stderr's existing 4096-byte cap to also apply to stdout (it never did).
5. **`shQuote()`** (unchanged from the original design) — standard POSIX single-quote escaping (close the quote, insert a literal quote via `'\''`, reopen) around `cwd` and every arg before they're interpolated into the remote command string. This is what actually makes the remote command injection-safe: a correctly single-quoted string cannot be broken out of by any byte sequence except an embedded NUL, and NUL can't appear in a shell token or a JS string used as one to begin with.

One operand does not get this treatment: the filesystem path handed to
`git diff --no-index` for an untracked file. `--no-index` drops git's own
repository-boundary check, so that operand is guarded by `isSafeNoIndexPath`
*and* resolved on disk (local) or checked against git's own untracked listing
(remote) before it is used. See "Untracked files" below.

Given (5), `isSafeShellArg`/`isSafeCwd`/`isSafeGitPath` stay a **denylist** (control characters, a `..` path segment, a leading `:`) rather than a positive character allowlist. The `..` test is on segments, split on both separators, not on the raw string: `..` is a traversal only as a whole segment, and a substring test refuses ordinary filenames — `has..dots.txt`, `v1..v2.diff`, `archive..2024.tar` — that git lists and the panel must therefore be able to open. Git paths and cwds legitimately contain almost any byte — spaces, unicode, punctuation, even a literal backtick or `$` in a filename — and an allowlist narrow enough to catch every shell metacharacter would also reject a lot of real filenames for no safety gain, since the metacharacters are already neutralized by the quoting, not by the character check. This mirrors the `open-terminal` `preLaunchCmd` guard's own documented lesson (`.ai/contexts/ipc-bridge.md`, "IPC path-guard inventory"): a denylist proved incomplete there because that string is deliberately raw shell; here the string is never raw shell in the first place, so closing by quoting is available and preferred over closing by enumeration.

`buildRemoteGitCommand`/`shQuote` never emit a backtick for any input, proven in `test/git-changes-runner.test.js` including adversarial cwd/path values containing backtick, `$(...)`, and an embedded single quote.

**Measured, not assumed** (`test/git-changes-runner-real-git.test.js`, a real `git init`-ed temp repo, no injected `exec`): an absolute pathspec that resolves outside the repository is refused by git itself (`fatal: ... is outside repository`, exit 128, empty stdout) — with or without `--literal-pathspecs` — so no code here needs its own absolute-path rejection on top of that. An absolute pathspec *inside* the repo still works normally. A `~`-prefixed pathspec is never shell-expanded (no shell in the local path; a shell exists on the remote path but the value sits inside single quotes, and tilde expansion does not apply inside single quotes either way) — it just resolves to a literal, almost-certainly-nonexistent relative path.

### Untracked files

An untracked file is a first-class row: one row per file, a real diff on click,
and line counts that reach the header total. Four decisions hold that up, each
measured against real git (git 2.53, `test/git-changes-runner-real-git.test.js`).

**1. `status` runs with `-uall`, with a floor under it.** Git's default
`--untracked-files=normal` reports a wholly-untracked directory as a single
entry (`? newdir/`) and never descends, so a brand-new directory is one row
whose `path` is a directory — unopenable, uncountable. `-uall` lists every file
individually (`? newdir/a.txt`, `? newdir/sub/b.txt`), which is what makes "no
row's `path` is ever a directory" an invariant rather than a hope.

The cost is volume, and it is bounded at both ends. Measured on a synthetic
repo, 20 000 untracked files: ~570 KB of porcelain and ~70 ms (against ~8 ms
and 81 bytes for the same repo without `-uall`) — time is a non-issue even on
every busy→idle edge, volume is not. At ~28 bytes per row for short paths, and
2–3× that for realistic ones, the remote transport's
`STATUS_MAX_STDOUT_BYTES` (2 MiB) cap is reached somewhere around 25 000–35 000
untracked files. That cap is a **hard error** (`stdout exceeded …`, empty
stdout), so taking it at face value would blank the whole panel — including the
tracked changes, which cost nothing and are usually the reason the panel is
open. So a `-uall` status that fails **that specific way** is retried once with
git's default untracked mode; if the retry succeeds the result comes back
`untrackedCollapsed: true` and the panel renders the tracked rows, the collapsed
`? dir/` rows, and a note saying the untracked listing is coarse.

The retry is gated on the failure signature (`isStdoutCapFailure`: the remote
transport's own `stdout exceeded <n> bytes`, or `execFile`'s
`stdout maxBuffer length exceeded` — both non-localized, one ours and one
Node's). Any other failure returns its own error untouched: retrying on every
non-zero exit would tell a user whose repository is unreadable
(`could not read directory: Permission denied`) that they have too many
untracked files, and discard the real message on the way. If the retry itself
fails, the original error is returned unchanged — a broken repository is still
an error, not a degraded listing.

The renderer holds the other end: `MAX_CHANGES_ROWS` (500) in
`public/file-panel.js` caps how many rows are built, with a `+N more files not
shown` note for the remainder. Every row is a DOM node plus its own click
listener, rebuilt from scratch on every refresh, and `refreshChanges` runs on
every busy→idle edge — an unbounded list would put tens of thousands of node
constructions on the Electron UI thread at exactly the moment a turn ends. 500
is a reading limit, not a memory one: the panel is a viewer, and a list longer
than that is not scanned, it is searched — which this panel does not offer.
Porcelain v2 emits the ordinary/rename/unmerged records before the untracked
ones (measured), so the rows dropped by the cap are untracked ones first; the
header total keeps counting every file, capped or not.

**2. The empty side of the diff is the literal string `/dev/null`.**
`git diff --no-index -- /dev/null <path>` produces exactly the new-file diff
the panel wants, with no index mutation. The portability question — this repo is
also checked out on Windows, where `/dev/null` does not exist — resolves in
git's favour: git does not `stat()` that operand, it compares the string.
Measured: `git diff --no-index -- /dev/null /dev/zero` fails with
`unsupported file type` (git *did* stat `/dev/zero`, an existing character
device), while `/dev/null` on the same side succeeds; and `nul`, git's Windows
spelling for the same thing, is refused on Linux. Both observations match git's
own `diff-no-index.c`, where the `/dev/null` string is special-cased
unconditionally and `nul` only under `GIT_WINDOWS_NATIVE`. **Git for Windows
accepts it**: `test/git-changes-runner-real-git.test.js` drives real
`git diff --no-index -- /dev/null <path>` invocations, it runs on the
`windows-2022` CI leg alongside Linux, and its untracked cases pass
there — so this is executed evidence on the platform in question, not an
argument from git's source. So `/dev/null` is the portable spelling, and the two
alternatives are worse: creating an empty
temp file means writing into a repository under test (and cleaning it up on
every error path, remote included), and `git add -N` mutates the index of a
repository the user is actively working in, which a read-only viewer must never
do.

**3. Exit code 1 is success here.** `git diff --no-index` exits 1 whenever the
two inputs differ — i.e. on every successful untracked diff. The shared
`result.code !== 0` check that every other command in this file uses would turn
every untracked row into a red error row, so this call has its own rule:
**0 and 1 are both success, anything else is an error**. Exit 1 is also how
`--no-index` reports an inaccessible operand (`error: Could not access 'x'`,
exit 1, empty stdout) — distinguished by the second half of the rule: empty
stdout plus a message on stderr is an error. A successful `--no-index` against
`/dev/null` always writes at least a `diff --git`/`new file mode` header, even
for an empty file.

**4. A `--no-index` operand is a filesystem path, so containment is resolved,
never inferred from the string.** The pathspec guard (`isSafeGitPath`) can
afford to be a denylist because git itself enforces the repository boundary: an
absolute pathspec outside the repo is refused with `fatal: … is outside
repository` (measured; see below). **`--no-index` has no containment check at
all** — measured: raw `git diff --no-index -- /dev/null /tmp/…/outside-secret.txt`
from inside the repo prints the file. Nothing downstream stops it, so the runner
does, in two layers:

- **Syntactic** (`isSafeNoIndexPath`): `isSafeGitPath` (control characters, a
  `..` path segment, a leading `:`) **plus** no absolute path (leading `/`,
  leading `\`, `X:` drive prefix) and no leading `-` (the operand sits where git
  parses options; `--` separation is belt-and-braces, not the only defense). A
  repo-root-level file whose name starts with `-` is therefore not diffable from
  the panel — an accepted, narrow loss.
- **Resolved** — the layer that actually enforces containment, because a
  syntactic check cannot: a symlink *inside* the repo pointing at a directory
  *outside* it yields an operand with no `..`, not absolute, that reads anything
  under that directory (measured: raw git prints the out-of-repo file for
  `link-to-dir/outside-secret.txt`). What each transport can do about it differs:
  - **Local** (`resolveLocalNoIndexOperand`): `fs.realpathSync.native` on the
    cwd and on the operand's **parent directory**, and the parent must be the
    resolved root or below it (`path.relative`, not a string prefix — a sibling
    named `/repo-evil` shares the prefix but is not inside `/repo`). The parent
    rather than the leaf, because git treats the leaf differently depending on
    what it is (see the next bullet). An `lstat` on the leaf then requires a
    regular file or a symlink, which also keeps a FIFO — where
    `git diff --no-index` blocks until the timeout — away from git. This is the
    `resolveOnDisk` + realpath-containment shape `ipc-path-validator.js`
    documents, including its TOCTOU rule: what git receives is the **guard's**
    operand (relative to the resolved root), never the caller's string.
  - **A leaf symlink is only safe when it points at a file.** Measured: git
    `lstat`s a symlink to a *file*, so the diff is `new file mode 120000` plus
    the link target *string* — the target's content never appears, and the row
    stays openable. Git **follows** a symlink to a *directory*, and
    `--no-index` then pairs the two operands by basename, so `/dev/null` ↔
    `<dirlink>/null`: a symlink pointing anywhere with a file called `null` in
    it reads that file. `git status -uall` lists such a symlink as a row of its
    own, so this needs no crafted path — only a click. The leaf therefore gets a
    `stat()` as well as an `lstat()`, and a symlink whose target is not a
    regular file is refused. A dangling symlink is allowed: there is nothing for
    git to follow, and it renders as its target string like any other link.
  - **The diff must name the file that was asked for** (`diffHeaderNamesPath` in
    `git-changes.js`) — the layer that does not need a filesystem, and therefore
    the one that covers the remote transport. Every `--no-index` diff opens with
    `diff --git a/<path> b/<path>`, including a binary one (which has no `+++`
    line at all) and an empty new file (which has neither `+++` nor a hunk). The
    operand-pairing case says `a/dirlink/null b/dirlink/null` for a requested
    `dirlink`, so comparing that line against the requested path catches it
    wherever it happens. The call runs under `-c core.quotepath=false`, which
    leaves non-ASCII verbatim, so the comparison is against two candidate
    spellings — the verbatim one and git's C-quoted one (`gitQuotePath`, for a
    name containing a quote, a backslash or a control character). A line
    matching neither is a refusal, not an empty diff.
  - **Remote**: with no local filesystem to resolve against, git's own view of
    the repository is the first oracle —
    `git ls-files --others --exclude-standard -z -- <path>` must return exactly
    that path before any diff is sent. Measured: it lists a genuine untracked
    file, and returns nothing for a path *behind* a symlinked directory (git's
    traversal does not descend symlinks), for a tracked file, or for a FIFO. It
    does list a symlink *itself*, so on this transport the header check above is
    what closes the directory-symlink case. Cost: one extra ssh round-trip per
    untracked row click, sequential (running it alongside the diff would mean
    the far host had already read the file).
  - `fsOps` (`{realpath, lstat, stat}`) is dependency injection for tests only,
    the same seam `remote-attach.js` uses for `spawnFn`; production always takes
    the real fs. `resolveLocalNoIndexOperand` takes a fourth `pathOps` argument
    for the same reason — see "Path arithmetic across platforms" below.

#### Path arithmetic across platforms

The local containment check is `path` arithmetic, and `path` means win32 rules
on the machine whose primary checkout is Windows. Three points decide whether
it works there:

- **The operand handed to git is git-spelled.** `path.relative` returns
  `newdir\a.txt` on Windows; git writes `newdir/a.txt` in every diff header it
  emits, and the header check compares against it. The guard converts on the way
  out (`toGitPath`), so the operand, the requested path and the header all agree
  on one spelling whatever the platform.
- **An empty `path.relative` means "the same directory", not "outside".** Two
  spellings of one directory — a drive-less root like `/repo` against the
  `\repo` that `path.resolve` produces from it, a trailing separator, a
  different case — compare unequal as strings while `path.relative` correctly
  returns `''`. Reading that as an escape refuses every untracked diff whose
  file sits directly in the repository root.
- **A test fixture path is platform-specific.** `/repo` is drive-relative on
  Windows, so a fake `realpath` returning it verbatim describes a directory the
  operand never resolves into, and the guard refuses — the tests then pass or
  fail for reasons that have nothing to do with what they assert. The fixtures
  build their roots with `path.resolve('/repo')`, which is `/repo` on POSIX and
  `<drive>:\repo` on Windows.

`path.win32` and `path.posix` exist on every platform, so both flavours are
injected through `pathOps` and asserted from whichever machine runs the suite
(`test/git-changes-runner.test.js`, the `PATH_FLAVOURS` loop): a legitimate
path resolves and comes back forward-slashed, traversal and an out-of-tree
symlink (another drive, on Windows) are refused, a sibling sharing the root's
string prefix is refused, and the leaf type rules hold under either separator.

A symlink row is diffed, not rendered as a `symbolic link → target` widget of
its own: `new file mode 120000` plus the target as the single added line is
git's own rendering of a symlink, this panel is a git viewer, and the two
guards above mean the only symlinks that reach git are the ones for which that
rendering is the whole truth.

The untracked calls go through the same `invoke()` →
`buildRemoteGitCommand`/`shQuote` path as every other command, so `/dev/null`
and the path are each their own single-quoted token and the "never emits a
backtick outside a quoted token" property holds for both of them (asserted in
`test/git-changes-runner.test.js` with a path containing a backtick and `$(…)`).

#### Why the counts arrive on click, not with status

`git diff --numstat` genuinely never reports an untracked file, and there is no
single git invocation that yields line counts for *all* untracked files:
`--no-index` takes exactly two operands, and pointing it at a directory does not
help (measured: `git diff --no-index -- /dev/null <dir>` errors with
`Could not access '<dir>/null'` — git pairs the operands by basename rather than
walking the tree). The options were therefore one invocation per untracked file
during `status()` — unacceptable on a repo with hundreds of untracked files,
and multiplied by an ssh round-trip on a remote session — or no counts at all.

Neither is needed, because the click already fetches the whole diff: the runner
counts additions from the stdout it has just read (`countNewFileDiffAdditions`),
at zero extra process cost, and returns `{added, deleted: 0}` alongside the
content. The renderer writes them onto that file's record in the open tab and
re-derives the header totals (`applyUntrackedCounts` in `public/file-panel.js`),
so an untracked row looks exactly like a tracked one from the moment its diff
has been opened once, and the totals grow as rows are visited. A refresh
re-reads status and the counts go back to unknown — correct, since the file may
have changed. Counts are deliberately `null`, never `0`, for a binary file and
for a diff truncated at the 512 KB cap: both are "unknown", and `mergeChanges`'s
totals only sum known counts. Counting locally from the filesystem was rejected
for the same reason the whole runner exists — it would not work for a remote
session, and local and remote must not disagree about what the panel shows.

A `--no-index` diff's file-header lines are `--- /dev/null` and `+++ b/<path>`
(not the `a/<path> b/<path>` pair a tracked diff carries). `classifyDiffLine()`
keys on the `---`/`+++`/`@@`/`+`/`-` prefixes only, so both land on
`changes-diff-file-header` exactly as a tracked diff's do.
`test/dom-file-panel-changes.test.js` pins that, so a "classify by the
`a/`…`b/` pair" refactor cannot silently render `--- /dev/null` as a deleted
line.

A count is only ever written back onto the status result it was computed
against: `applyUntrackedCounts` takes that result and returns early unless
`tab.data` is still the same object. `refreshChanges` replaces `tab.data` but
leaves `tab.selectedFile` alone, so the in-flight guard on the diff response
(`currentTab`/`selectedFile` identity) does not catch a refresh that landed
mid-flight — and the row a stale count would be stamped on is re-found by path,
which may by then be a *tracked* file carrying git's own authoritative numstat
counts.

### Remote transport stdout cap (`remote-attach.js` `defaultRunRemoteCommand`)

`defaultRunRemoteCommand(alias, command, {timeoutMs, maxStdoutBytes, spawnFn})` counts accumulated stdout in UTF-8 bytes as each chunk arrives (`Buffer.byteLength`, works for both a real Buffer chunk and a test's plain-string chunk). Crossing `maxStdoutBytes` (default `DEFAULT_MAX_STDOUT_BYTES` = 8 MB when the caller doesn't pass one) SIGKILLs the child and resolves `{code: -1, stdout: '', stderr: 'stdout exceeded <n> bytes'}` — the same `{code, stdout, stderr}` shape every other path already returns, so `git-changes-runner.js`'s existing `firstError()`/`ok:false` handling surfaces it as `{ok: false, error: 'stdout exceeded <n> bytes'}` with no special-casing. `git-changes-runner.js` passes an explicit cap on every call — `STATUS_MAX_STDOUT_BYTES` (2 MB) for each of the three `status()` commands, `DIFF_MAX_STDOUT_BYTES` (`MAX_DIFF_BYTES` + 64 KB slack) for `diff()`, so a diff just over the panel's own display cap still arrives whole and gets truncated locally instead of being killed by the transport first. The tmux probe/restore calls in `remote-attach.js` and `remote-stop.js`'s kill command never pass `maxStdoutBytes` and fall back to the 8 MB default — their own output is a handful of bytes, nowhere near either cap (verified: `test/remote-attach.test.js` and `test/remote-stop.test.js` pass unmodified).

`opts.spawnFn` is dependency injection for tests only (`test/remote-run-command-stdout-cap.test.js`, a fake `child_process`-shaped `EventEmitter` with `stdout`/`stderr`/`kill`) — production code never passes it, and the lazy `require('child_process')` stays the real default.

## Not a repository

A session's working directory need not be inside a git work tree, and when it
is not, the Changes affordance is not offered: `#changes-toggle-btn` is
`display: none` for that session. The panel never renders a refusal for this
case, because there is nothing to refuse — the button that would produce it is
not there.

**The detection is an exit code, never a message.** `git rev-parse
--is-inside-work-tree` answers `128` outside any repository, `0` with `true`
inside a work tree, and `0` with `false` in a bare one; git translates every
one of its diagnostics (this project's own host runs it in French), so matching
text is not an option. `isWorkTree()` in `git-changes-runner.js` is the single
implementation, goes through the same `invoke()` as every other command, and
therefore answers identically for a local and a remote session. It returns
`{ok: true, isRepo}` only when git actually answered: a transport failure
(ssh's own exit `255`), a thrown exec, and a `0` exit with neither `true` nor
`false` printed all come back `{ok: false, error}`, which is *not* an answer and
withdraws nothing. An ssh connection refused must never read as "you have no
repository".

`isRepo: false` covers a bare repository as well as a directory outside any
repository: neither has a work tree, so neither has changes to show.

**Who asks, and when.** Two paths reach the same conclusion, and `status()` is
the cheaper of them:

- `git-changes-available` runs the probe once per `switchPanel()` into a
  session. The answer is cached on that session's `filePanelState` entry
  (`changesAvailable`), applied to the button before the round trip so a known
  answer never flashes a button that does not work, and re-asked on the next
  switch — which is how a `git init` (or an `rm -rf .git`) mid-session is
  picked up without polling anything.
- `status()` returns `{ok: false, reason: 'not-a-repo'}` when a command failed
  **and** the probe then confirms there is no work tree. The renderer treats
  that exactly like an `isRepo: false` availability answer: it withdraws the
  button and closes the open tab rather than reporting into it. That covers the
  window between a switch and the repository disappearing under a running
  session, and it means a click landing before the availability answer arrives
  is handled too.

The probe is a **diagnosis, not a precondition**: a session that is in a
repository pays for three commands per refresh, the same three as before, and
`test/git-changes-runner.test.js` pins that (`calls.length === 3`). Adding a
fourth invocation to every refresh would cost a process spawn locally (measured
~1.8 ms, git 2.53) and a whole ssh round-trip remotely, on every busy→idle edge
of every session, to answer a question that is almost always the same.

## Bounded error messages

`firstError()` puts every unexpected git failure through `boundErrorMessage()`:
at most `MAX_ERROR_LINES` (5) lines and `MAX_ERROR_CHARS` (500) characters, with
a trailing `…` when anything was dropped. Git's `diff --no-index` usage page is
over 150 lines and git prints it on a plain exit-129 misuse; unbounded, that
page is what the panel would display. The bound is the first lines rather than a
flat character cut because git's own diagnosis is on the first line and the
noise is below it.

A genuine failure — a permission error, a corrupt repository, a transport
problem — is still reported, in git's own words and in whatever language git
chose. Only the volume is capped.

## cwd resolution (`git-changes-target.js`)

`resolveGitChangesTarget(sessionId, deps)`, in order:

0. **`isValidChangesSessionId(sessionId)`** — refused before any dependency runs, including `getCachedFolder`. Accepts a plain CLI-issued id (`/^[A-Za-z0-9._-]+$/`, excluding the bare `.`/`..` — same shape and rationale as `isValidSessionId` in `delete-session-target.js`, since a local id ultimately reaches `resolveSessionRealCwd` → `path.join(projectsDir, folder, sessionId + '.jsonl')`) or a remote descriptor-only placeholder id, `pid:<positive integer>` (`remote-index.js` `buildPlaceholderSession` — a live descriptor with no CLI-issued session id yet is keyed on its pid instead). Everything else — a `/` or `\`, a `..` segment, a bare `sub:<parent>:<agent>` subagent id — is refused: `main.js` never routes a subagent id to either `git-changes-status` or `git-changes-diff` (subagents render as a read-only transcript, not a Changes-panel-bearing session), so that shape is out of scope rather than silently accepted.
1. **Remote folder** → the host's live descriptor list (`remoteIndexer.getRemoteSessions(alias)`), matched by `sessionId`. No PTY/attach required — issue #251's acceptance criteria is "works without attaching".
2. **Local, live in this app** → the session's own recorded `.cwd` (may be a worktree) — short-circuits the disk scan below.
3. **Local, not live here** → `resolveSessionRealCwd()`, the same disk scan `open-terminal`'s resume path uses ("For a Claude resume, spawn in the session's real recorded cwd…", `main.js`), so Changes and `claude --resume` never disagree about which directory a session's cwd really is. Refused if the resolved path no longer exists on disk.

Extracted out of the two IPC handlers into its own module, fully dependency-injected, so this order is unit-tested without booting Electron (`test/git-changes-target.test.js`) — same rationale `delete-session-target.js` and `run-schedule-now-target.js` already document for their own handlers. Step 0's whole point is to be provably reachable *before* the disk-scanning fallback (step 3): `test/git-changes-target.test.js` asserts `resolveSessionRealCwd` is never called for `"../../x"`.

`filePath` on `git-changes-diff` is a git pathspec relative to that cwd, not an absolute filesystem path, so `ipc-path-validator.js`'s allowlist/denylist helpers (which assume an absolute path under a known root) don't fit — it's validated by the runner's own `isSafeGitPath` instead (see "Quoting rule" above).

## Editing a changed file (`git-changes-file.js`)

A changed file of a **local** session is edited in place in the panel, with the
diff recomputed as the user types. Two IPCs carry that — `git-changes-file`
(the content pair) and `git-changes-save` (the write); both take the same
repo-relative path the rows already carry, and neither returns an absolute
path. The renderer never learns where the repository is: the session's cwd is
re-resolved through `resolveGitChangesTarget` on **every** call, the absolute
path is built from it, used, and discarded main-side.

`git-changes-file` returns `{ok, original, current, version, binary, truncated}`.
`original` is the side `git diff` itself compares against, so the diff the
panel draws and the diff `git diff` would print cannot disagree: the index
(`:<path>`) for the unstaged view, `HEAD:<path>` for the staged one. A path
absent from that tree exits **128** — that is the untracked/new-file case, and
it alone yields `original: ''`. Every other exit code is an error
(`reason: 'git'`): a timeout, a killed child, a missing binary and an unreadable
object are not "this file is new", and rendering them as an all-additions diff
would contradict the panel's own contract that what it marks as changed is what
git would report.

### `git cat-file blob`, not `git show`

Both print the blob for a well-formed `<rev>:<path>`. They differ on
everything else, and the difference is the whole guard:

| Operand | `git show` | `git cat-file blob` |
|---|---|---|
| `:/<text>` | exit 0, prints a **commit** (`:/text` is commit-message search magic) | exit 128, `Not a valid object name` |
| `HEAD:` or a directory path | exit 0, prints a **tree listing** | exit 128, `bad file` |
| `HEAD` | exit 0, prints a commit with its diff | exit 128 |
| a path not in that tree | exit 128 | exit 128 |

Measured against git 2.53 and pinned in `test/git-changes-file-real-git.test.js`.
`git show` is content-type-polymorphic: hand it something that is not a blob
and it prints *something else* with exit 0, which would land in the editor as
"the original side of this file". `cat-file blob` is type-constrained — a
non-blob is an error, never output — so a guard bug downstream degrades into a
refusal instead of into the wrong content.

### `<rev>:<path>` is not a pathspec, and does not reuse the pathspec guard

`--literal-pathspecs` does not apply to a revision operand, `--` cannot
separate it from options, and `isSafeGitPath`'s leading-`:` rejection was
written for pathspec magic (`:(exclude)`, `:/`, `:(top)`), which is a different
syntax from revision magic. So the operand carries its own pair of guards
(`git-changes-file.js`):

- `isSafeRepoRelativePath` — non-empty, ≤ 4096 chars, no control characters
  (NUL, newline, carriage return included), not absolute (`/`, `\`, `X:`), no
  leading `-`, no leading `:`, and no `..` or `.git` **segment**. This is what
  `git-changes-save` uses, because its operand is a filesystem path and nothing
  else. Both segment rules are split on `/` and `\` rather than matched as
  substrings: `a..b.txt` and `dotgit.md` are ordinary filenames, while `a/../b`
  and `.git/config` are not paths this panel will touch.

  This check reads the string the renderer sent, so it is a cheap pre-filter and
  **not** the guarantee: `gitlink/config`, where `gitlink` is a symlink to
  `.git`, carries no `.git` segment at all. The guarantee is in
  `resolveTargetInsideRepo`, which applies the same segment rule to the
  **resolved** path and additionally refuses anything inside the directories
  `git rev-parse --absolute-git-dir --git-common-dir` reports (`reason:
  'git-dir'`). That covers a linked worktree, whose git directory is not under
  the worktree root at all. `.git/config` carries `core.pager`,
  `core.fsmonitor` and `[alias]`, so writing it is command execution the next
  time any git command runs there.
- `isSafeRevPathOperand` — the above **plus** no `^[0-9]+:` prefix, which would
  turn `:<path>` into `:<n>:<path>`, git's conflict-stage syntax. A file
  literally named `1:f.txt` is therefore not editable from the panel: an
  accepted, narrow loss against a second layer of revision syntax hiding inside
  what the renderer called a file path.

Rejecting a leading `/` is what closes `:/<text>`, since the search magic is
reachable only through an operand that starts with a slash after the colon.

### Containment, and which path the write runs on

The boundary is the repository root (`git rev-parse --show-toplevel`), not the
session cwd: the paths in a row come from `git status`, which reports them
relative to the root, and a session whose cwd is a subdirectory of the repo
must still open its own repository's files. The root is computed by git from
the already-resolved cwd — it is never a renderer-supplied string.

`resolveTargetInsideRepo` `lstat`s `path.join(root, relPath)` first and refuses
a **symbolic link** outright (`reason: 'symlink'`): a symlink's content in a git
working tree is its target string, so the pair would be the link text against
the target's content, and a save would land on a file the row does not name.
A **hard link** is the one escape realpath cannot see: a second name for the
same inode, whose real path *is* the in-repo name, so containment has nothing
to object to and a write through it changes the file outside as well. The
shared guard therefore refuses any target with `stat.nlink !== 1`
(`reason: 'hardlink'`), on the read as well as the write, so the panel says so
when the file is opened rather than when the save fails. Measured cost before
choosing: **0 of 38 561 git-tracked files across 12 real repositories** have a
link count above one, and the hard links package managers create live in
`node_modules`, which is ignored and so never a row. The rule is on the link,
not on where the other name is: a link between two files inside the repository
is refused too, because "which of the two names did the user mean" has no
answer the panel can defend.

It then resolves both the root and the joined path **on disk**
(`resolveOnDisk`) and runs **every remaining check against the resolved path**:
containment in the repository root (which catches an escape through a symlinked
*directory*, whose last component is an ordinary file), the `.git` segment rule
and the git-directory containment above, `isSensitivePath`, and a regular-file
check. The ordering is the rule this codebase keeps relearning: a guard that
tests the literal string the renderer sent is defeated by a symlinked directory
component; resolve first, check the resolved path, and use the value the guard
returns. It returns
that single resolved path, and the read and the write run on **that** value —
the TOCTOU rule `ipc-path-validator.js` documents for
`resolveAllowedMemoryPath`: two independent resolutions of the same string are
two chances for a symlink swap in between, one resolution reused cannot
diverge from itself. A symlink inside the repository pointing outside it is
refused by exactly that check (measured, both for the read and for the write).

`save-file-for-panel`, the neighbouring write handler, has no containment check
at all — it takes an absolute path from an OSC 8 terminal hyperlink and checks
only `isSensitivePath`. A handler whose entire input is a *relative* path from
the renderer has no such excuse, so it does not inherit that shape.

### Saving over a file that moved

The premise of this panel is that it sits beside a session writing the same
files, so "the file changed since it was read" is the normal case, not an edge
case. Two independent layers:

1. **A version token.** `git-changes-file` returns `version` — the SHA-1 of the
   bytes it read, plus their length — as opaque data. `git-changes-save`
   requires it back, re-reads the file, and refuses with `reason: 'stale'` when
   it no longer matches; the write never happens. A save with no token at all is
   refused the same way (`reason: 'invalid-version'`), so a caller that forgets
   it cannot clobber anything. Every successful save returns the token of the
   bytes it just wrote, which is what the next save must carry. The hash, rather
   than an mtime, is what makes two writes inside the same clock tick
   distinguishable.
2. **A watcher.** `git-changes-watch` resolves the same guard and hands the
   resolved path to `git-changes-watch.js`'s registry, which `fs.watch`es it and
   sends `git-changes-file-changed(sessionId, relPath)` — never an absolute
   path. The renderer re-reads on it, so the user is told (or the clean buffer
   is refreshed) as it happens, rather than at the next busy→idle edge. The
   watch is keyed by session + repo-relative path and is dropped when the file
   is closed, the tab is closed, or another file is opened.

   The registry is a module rather than a closure in `main.js` for the same
   reason `git-changes-target.js` is: `main.js` cannot be required from a test,
   and the half of the watcher that detects the change is the half worth
   pinning. Its own rule: **a `rename` event re-arms the watch.** `fs.watch`
   follows the inode, and an atomic replacement (`git checkout`, `git stash
   pop`, `sed -i`, an editor saving via rename) delivers one event and then
   silence, so the entry closes its watcher and re-arms on the same path before
   reporting. The version token means the consequence of a missed event is a
   missing warning, never a lost file, which is why this is a quality-of-signal
   fix rather than a safety one.

### Caps, line endings and encoding

Same two limits the other panel reads use (`PANEL_FILE_MAX_BYTES`, 2 MB, and a
NUL byte anywhere means binary), applied to both sides of the pair, and the
refusal says **which** limit it was (`reason: 'binary'` vs `'too-large'`) so
the panel can explain itself and fall back to the read-only unified diff.
Neither side is ever truncated: a truncated buffer in an editor that can save is
a data-loss device, not a preview.

Two more properties of the round trip, both belonging main-side because the
editor cannot preserve them:

- **Line endings.** CodeMirror normalises `\r\n` *and a lone `\r`* to `\n`
  when it builds a document, and joins with `\n` on the way out, so any file not
  already LF-only would come back rewritten. The read returns LF-only text —
  `toLf` folds both forms, or the buffer never compares equal to what was read
  and is treated as dirty forever — and the write re-applies the file's own
  ending, measured from the very bytes the version token was computed from.
  A file that **mixes** endings is refused (`reason: 'mixed-eol'`) rather than
  normalised to the majority: no editor whose document type carries one
  separator can preserve per-line endings, and silently rewriting the minority
  lines is the manufactured diff this rule exists to prevent. Uniform CRLF,
  uniform LF, uniform lone-CR and a file with no line ending at all all
  round-trip byte-identically.
- **Encoding.** The binary gate is NUL bytes, which Latin-1 text does not
  contain: decoded as UTF-8 it becomes U+FFFD and would be written back as
  those replacement bytes, irreversibly. Both sides are therefore decoded
  strictly (`TextDecoder` with `fatal: true`) and a file that is not valid UTF-8
  is refused with `reason: 'encoding'`, not repaired. The write refuses the same
  thing from the other direction: a JavaScript string may hold an **unpaired
  surrogate**, which `Buffer.from(…, 'utf8')` would silently write as U+FFFD —
  the very substitution the read exists to prevent — so `hasLoneSurrogate`
  rejects it with the same reason before any bytes are produced. The same decoder is given
  `ignoreBOM: true`, because its default is to **consume** a leading U+FEFF: the
  BOM is stripped from what the editor sees, so it cannot be typed over or
  counted as a diff, and re-applied on write when the bytes on disk carried
  one.

### Remote sessions are refused

Both IPCs refuse a session whose target is remote. There is no file-write path
to a remote host anywhere in this app, and the working-tree side of the pair is
read with `fs.readFileSync` from a path that only means anything on this
machine. The renderer never calls them for a remote session either — it keeps
the read-only unified-diff renderer — so the refusal is the second line, not
the only one.

## Refresh triggers (no polling)

`refreshChanges(sessionId)` in `public/file-panel.js` runs only from three places: opening the tab, the panel's own Refresh button, and a subscriber registered with `onSessionIdle()` (`public/session-activity.js`) inside `initFilePanel()`.

`onSessionIdle(cb)` is a plain callback registry — not a DOM class writer, so it's outside the four-class enforcement `.ai/contexts/session-state.md` documents. `setActivity()` fires it only on a genuine busy→idle **edge** — `wasActive && !active`, where `wasActive` is `sessionBusyState`'s value from before this call overwrote it — never on every call where `active` is merely falsy. That distinction matters for a caller that legitimately re-asserts idle more than once with nothing busy in between: a remote row's decay/detach path calls `setActivity(id, false, via, {armReady: false})` (`.ai/contexts/session-cache.md`, "Remote hosts — busy spinner") specifically so idle does *not* arm response-ready — but that opt-out also means the pre-existing response-ready-lock dedup (an idle call is dropped early when `responseReadySessions.has(sessionId)`) never engages for it either, since that lock is only armed when `armReady` is true. Before this fix, two such `armReady:false` idle calls in a row (no intervening busy) each independently called `notifySessionIdle`, double-firing the panel's refresh. The edge check subsumes both cases: an ordinary duplicate idle already covered by the response-ready lock still reads `wasActive:false` on the second call (harmless overlap, not a conflict), and the `armReady:false` case that the lock never covered is now caught by the same line. A session with no Changes tab open is a no-op lookup (`filePanelState.get(sessionId)` misses); a session whose tab is a different type is skipped by the `currentTab.type === 'changes'` check. Proven in `test/dom-file-panel-changes.test.js`: zero `gitChangesStatus` calls while busy, one refresh per busy→idle edge (including the `armReady:false` path), and none for an unrelated session's idle transition.

`file-panel.js` references `onSessionIdle` even though `session-activity.js` loads *after* it in `index.html` — safe because the reference lives inside `initFilePanel()`'s body, which only runs once `app.js` (the last script) calls it, by which point every script has already evaluated. Same reasoning `.ai/contexts/session-state.md` documents for `session-activity-dom.js`'s own out-of-order cross-file references.

## Renderer: two ways to show a file

`public/file-panel.js`'s Changes mode is a third tab type (`'changes'`), alongside the pre-existing `'file'` and `'diff'` (MCP) types, on the same per-session `filePanelState`. Opening one replaces whatever the other was showing. It does not route anything through `ViewerPanel`, which owns one file and one path; a Changes tab owns a list, a selection, and a session.

A **local** session's selected file is a live editor over the content pair from `git-changes-file` — `createMergeViewer` (side-by-side, original read-only on the left, working tree editable on the right), `createUnifiedMergeViewer` (inline) or `createEditableViewer` (plain, no diff decoration), cycled by one button and persisted under `localStorage.changesDiffMode`. CodeMirror recomputes the diff on every keystroke by construction, so "live update" is a property of using the merge view at all, not a feature built on top of it.

A **remote** session, and any file the main process refuses to open for editing (binary, over the cap, outside the repository), fall back to the unified-diff text from `git-changes-diff`: one `<div class="changes-diff-line">` per line, classed by its `+`/`-`/`@@` prefix (`classifyDiffLine()`), set via `textContent` (no HTML injection risk from diff content, which can contain arbitrary user code). The bundled CodeMirror has no diff/patch language mode to colour that blob with, which is why the fallback is deliberately plain. The panel says which of the two it is in, in its notice line, and the refusal's `reason` is what that line reports.

### The list and the editor

The list is never hidden. A selected file opens *below* it — summary, list, a drag handle, then the editor region — and the current row carries `.selected`. Reviewing a set of files is then click, read, click, which is the whole point of the layout; there is no navigation step to undo, so the editor's first button is **Close** (close the file, keep the list) rather than Back.

The split uses `createSplitter` (`public/splitter.js`, shared with the panel's shell region) and the height model that region settled on: `changesListDesiredHeight` stores what the drag asked for, `clampChangesListHeight` narrows it only for display against the space actually available, and only the desired value is persisted (`localStorage.changesListHeight`). A transient shrink — a short panel, the shell open — therefore never ratchets the stored height down. The list has a floor of its own (`MIN_CHANGES_LIST_HEIGHT`, 96px, about four rows) so it cannot collapse to nothing, and the editor keeps `MIN_CHANGES_EDITOR_HEIGHT` (120px, the same floor the shell region uses for the content above it). Below that the list scrolls; nothing overlaps and nothing is clipped out of reach.

Switching rows is an exit like Back, the tab toggle and the panel's close button: it asks `confirmDiscardChangesEdits` when the buffer is dirty and returns without touching anything if the answer is no. Clicking the row that is already open is not a switch and asks nothing. The row cap (`MAX_CHANGES_ROWS`) and the idle refresh are unchanged by the layout — a refresh rebuilds the list while the editor keeps its instance and its DOM node, which the editor-host MutationObserver test pins with the list now rebuilding alongside it.

### File links

`openFileInPanel` is the terminal's entry point (OSC 8 `file://` and the context menu) and it hands the renderer an **absolute** path. The renderer never turns that into a pathspec: `git-changes-locate` does, main-side, against the repo root `resolveRepoDirs` computes from the session's own cwd — the same root the read and the write use. It resolves the path on disk, requires containment, runs it through `resolveTargetInsideRepo` so a link cannot reach what a row cannot, and answers with `{relPath, changed, staged, untracked}`.

A symlink is where locate and the row guard deliberately differ. Opening the **row** `innerlink` is refused (`reason: 'symlink'`): a symlink's content in a working tree is its target string, which the editor cannot represent, and a save would land on a file the row does not name. A **link** to `innerlink` is not that case — it resolves to `src/a.js` and locate answers with *that* row. Nothing is smuggled in: the answer is the target's own repo-relative path, so the title, the save, the watch and the version token all name the same file, and every file reachable this way is already reachable by clicking its own row. The asymmetry is between "edit the link" (refused) and "follow the link to a file" (an ordinary row), not between two spellings of the same operation.

"Changed" is one `git status --porcelain=v2 -uall -z -- <relPath>`, scoped to that one path: **measured on a 20 000-file repository with no untracked files, 14–17 ms against 117–126 ms for the unscoped status the panel runs on open**. Scoping is not universally cheaper: with untracked files present it can be slower than the unscoped run, and the worst case measured is around 60 ms. Either way it is cheap enough per click that the renderer does not need to cache or consult its last status, and correct even when no Changes tab is open. An untracked file counts as changed (it is a legitimate row, and the editor handles an empty original). An unmodified file, a path outside the repository and a remote session all answer "not a row" and the link falls back to the plain `ViewerPanel`, which is also what happens if the IPC is missing or throws.

### The render path is not a teardown

The Changes tab re-renders on every busy→idle edge (see "Refresh triggers"), so a render that rebuilt its own DOM would destroy the editor under the user's cursor and discard unsaved edits once per turn the session finishes. Two rules prevent that:

- The diff view's chrome — title, Back, mode button, Save, notice line, editor host — is **built once**, in `initFilePanel()`. A render updates text and visibility; it never clears `#changes-diff-view`.
- The editor instance lives on the tab (`tab.editorView`, keyed by `tab.editorKey` = path + staged, and `tab.editorMode`) and is **reused** whenever those still match. It is destroyed on Back, on closing the tab, on a mode change, and when a clean buffer is reloaded — nowhere else. `destroyCurrentTab()` carries a `'changes'` branch for the same reason the `'diff'` branch exists.

Both are pinned by tests that go red if a render clears the host (a `MutationObserver` on the host records zero child mutations across an idle refresh) or rebuilds the instance.

### A dirty buffer is never overwritten, and never lied to

A refresh — from a busy→idle edge, the Refresh button, or the watcher — always re-reads the file, and what it does with the answer depends on the buffer:

- **Clean**: the selection is first re-pointed at its own row in the new status payload, so a file the session has just staged is compared against `HEAD` from then on rather than against an index that now equals the working tree. The pair is then replaced, and the editor rebuilt, only when the content actually differs.
- **Dirty**: nothing in the buffer is touched. The notice line says the file changed on disk *only when the version token says it did* — a warning that fires on every refresh, whether or not anything happened, is one the user learns to ignore.

A file that stops being readable (deleted, or refused) and a status refresh that fails are both reported in that same notice line while a file is open; the file list's own error branch is not reachable from the diff view.

The Save button is disabled while the buffer is clean and while a write is in flight. It follows the buffer rather than the render: the three editor factories take an `onChange` and install a CodeMirror `updateListener`, so typing, pasting, undo and a programmatic edit all reach it, which a DOM `input` listener would not. The keyboard path does not consult the `disabled` attribute, so `handleChangesSave` keeps the same two guards itself.

The default mode is **inline**. The panel is a narrow column — at its 450px default a side-by-side merge view gives each side about 225px, which clips code mid-token; inline gives the full width to one column. The MCP diff tab keeps `side-by-side` under its own key, because it is not confined to this panel.

Saving is `gitChangesSave(sessionId, path, content, version)` from the Save button or from the `cm-save` event the bundle dispatches for `Cmd/Ctrl+S`; on success it refreshes the status so the row's counts follow the write. A save does not change what the diff is against: the original side stays the index (or `HEAD`), because the write touched the working tree and neither of those. The status refresh that follows drops an untracked row's counts — they are click-derived, and a fresh status has none — so the save re-applies them from the bytes it just wrote, against the status payload current at that moment. Otherwise the user watches a number they obtained by opening the file disappear as a result of their own save, while git still reports the file as changed. A save is refused while another is in flight (`tab.saving`, which also disables the button), so a double press cannot put two writes in the air with the filesystem deciding the order. A refusal for `reason: 'stale'` keeps the buffer and turns the notice into "reload before saving"; **Reload** re-reads the file, after a confirm when there are unsaved edits.

The buffer is read back from `view.b.state.doc` for side-by-side and from `view.state.doc` for inline and plain — the same asymmetry the MCP diff tab navigates.

Back, closing the tab and closing the panel all ask before discarding unsaved edits (`window.confirm`, as `ViewerPanel` already does for its own destructive action). `confirmDiscardChangesEdits` asks and does nothing else; what happens to the buffer is decided by the exit. The exit that tears down through `destroyCurrentTab` passes `{stash: false}`, so a confirmed discard cannot hand the buffer to the stash below and get it back on the next open; the other two tear down inline and never stash.

Nothing else clears the stash, deliberately. A stash exists only while a non-Changes tab is showing — it is created when a Changes tab is replaced and consumed the moment one is opened — so an exit reached *from* the Changes tab always sees a null stash, and an exit reached from the session's own tab (the panel's close button) has asked the user nothing and has no instruction to act on. Clearing there is what turns "your edits are kept" into silent loss. The two failures are mirror images and both come from deciding the stash's lifetime somewhere other than at the user's answer: keeping work against an explicit discard, and discarding work nobody was asked about.

A tab replaced by an MCP-driven open (`openDiffTab` / `openFileTab`) cannot ask — the session is acting, not the user, and the diff it is opening is waiting for an answer. It **stashes** the buffer instead (`stashChangesEdits` → `state.changesStash`: the selected file, the edited content, the pair it was based on and its version token), and reopening the Changes tab restores it with a notice naming that cause (`restoreChangesEdits`); the notice never claims a takeover for a buffer the user kept some other way. The stash is per session, holds only a dirty buffer, and is consumed on restore. The version token travels with it, so a restored buffer that has gone stale meanwhile is still refused at save time rather than overwriting whatever arrived in between. This is the same failure the version token addresses, pointing the other way: the session's activity destroying the user's work instead of the user's save destroying the session's.

**Reload** re-arms the watch as well as re-reading, because "this file was replaced on disk" is both the usual reason to press it and the way a watch goes deaf. A save whose IPC rejects outright (the channel is gone, the handler threw outside its own try/catch) is caught and reported in the notice line like any other failure, rather than escaping as an unhandled rejection and leaving the Save button disabled until the next render.

One host element holds one editor: another session's tab keeps its instance, detached, and `mountChangesEditor` removes any foreign child before attaching. Without that, switching between two sessions with files open stacks both editors in the same column, and a user typing into the visible-but-not-current one has the keystrokes read from the other buffer on save.

Inline mode asks for `mergeControls: false`. The default `unifiedMergeView` renders Accept/**Reject** buttons per chunk, and Reject restores the original side into the document — reverting a working-tree change, which this panel does not do.

An untracked file's added-line count comes from the pair rather than a second git call: its original side is empty, so its additions are its own lines (`countAddedLines`). The read-only fallback still takes the count from the diff (`countNewFileDiffAdditions`).

## What's untested for remote

The real ssh child process (`remote-attach.js`'s `defaultRunRemoteCommand` actually calling `spawn('ssh', ...)`) is exercised only by construction in `git-changes-runner.test.js` (`kind: 'remote'` with no `exec` override — asserts `runner.kind`/`runner.alias`, makes no network call), consistent with the hard rule against ssh-ing to a real host from tests. `defaultRunRemoteCommand`'s own internal logic (byte counting, the overflow kill, the resolved shape) IS unit-tested, via `opts.spawnFn` injecting a fake `child_process`-shaped `EventEmitter` (`test/remote-run-command-stdout-cap.test.js`) rather than a real `ssh` process — still no network, no real host. Everything downstream of the transport — command shape, quoting, parsing, the IPC handlers, cwd resolution — is fully tested with injected fakes.

## Local exec and inherited git environment

`defaultLocalExec` strips the repo-location variables (`GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_PREFIX`,
`GIT_NAMESPACE`) from the child's environment: the session's cwd is the only
thing that decides which repository a Changes command reads. Measured
2026-09-13: with those inherited (the test suite running under the pre-commit
hook), the scratch-repo test wrote `tracked.txt` into the outer repository's
index and rewrote its local `user.email`; the test helper now drops `GIT_*` /
`HUSKY*` for the scratch repo and disables its hooks, and the runner no longer
trusts them either.
