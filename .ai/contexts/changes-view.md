# Context: changes-view

**Purpose**: A read-only, git-status-sourced view of a session's working
tree, in the same right-hand file panel IDE Emulation already uses — for
local and remote sessions alike. Issue #251. User-facing behavior:
`docs/changes-view.md`. IPC names and the path-guard table entry:
`.ai/contexts/ipc-bridge.md` ("Changes panel"). The panel's tab-type
integration: `.ai/contexts/viewer-panel.md` ("Changes mode").

## Key files

| File | Role |
|---|---|
| `git-changes.js` | Pure parser — no electron, no DOM, no fs. `require()`-d from `main.js` and from tests, same pattern as `remote-hosts.js` / `derive-project-path.js`. |
| `git-changes-runner.js` | Runs the git commands, local or remote, behind one interface. |
| `git-changes-target.js` | cwd resolution for the two IPCs, extracted out of `main.js` for testability (same rationale as `delete-session-target.js`). |
| `public/file-panel.js` | Renderer: the `'changes'` tab type, its rows, and the fallback diff-line renderer. |
| `public/session-activity.js` | `onSessionIdle()` — the no-polling refresh hook. |

## Parser (`git-changes.js`)

- `parseStatusPorcelainV2(text)` → `{branch:{head,upstream,ahead,behind}, files:[{path,origPath,staged,unstaged,untracked,renamed,state}]}`. Record types `1` (ordinary), `2` (rename/copy — `origPath` and `renamed:true`), `u` (unmerged), `?` (untracked, `state:'?'`). Type `!` (ignored) and any future/unrecognized record type are dropped rather than thrown on.
- `parseNumstat(text)` → `{[path]: {added, deleted}}`. Binary files report `-` in git's own output; that becomes `null` here, not `0`, so a caller can tell "no lines changed" apart from "line count unknown".
- `mergeChanges(status, numstatStaged, numstatUnstaged)` → the panel's model: each file gets `added`/`deleted` summed across whichever of the two numstat maps have an entry for it (a file modified in both the index and the worktree has two independent diffs; a file already staged and now edited again is a real, common case, not an edge case). An untracked file's counts stay `null` — `git diff` never reports untracked files at all. `totals` sums only the known (non-null) counts.
- **Both parsers consume `-z` (NUL-separated) output — see "Quoting rule" below.** They walk an explicit index into `String(text).split('\0')` rather than a plain `for...of` over lines, because a rename/copy record spans TWO tokens instead of one:
  - **Status** (`2 <xy> ... <score> <path>\0<origPath>\0`): the origPath is the very next token — no tab embedded in the first one the way non-`-z` porcelain v2 does it.
  - **Numstat** (`<added>\t<deleted>\t\0<oldpath>\0<newpath>\0`): an EMPTY path field (immediately followed by NUL) signals a rename; the actual paths are the next two tokens, old then new — never the `old => new` / `dir/{old => new}/suffix` arrow spellings numstat emits without `-z`.
  - Both record regexes carry the `s` (dotAll) flag so a raw, unquoted embedded newline in a path — `-z` never quotes anything, unlike the default porcelain/numstat output — still falls inside `.` instead of truncating the match.

## Runner interface (`git-changes-runner.js`)

`createGitChangesRunner({kind, cwd, alias, exec, timeoutMs})` → `{status(), diff(path, {staged})}`. `status()` runs three commands in parallel (`git status --porcelain=v2 --branch -z`, `git diff --numstat -z`, `git diff --cached --numstat -z`) and merges them. `diff()` runs `git diff [--cached] -- <path>`, capped at 512 KB (`MAX_DIFF_BYTES`) measured in UTF-8 bytes and cut on a line boundary, with a `truncated` flag.

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

Given (5), `isSafeShellArg`/`isSafeCwd`/`isSafeGitPath` stay a **denylist** (control characters, any `..` segment, and now a leading `:`) rather than a positive character allowlist. Git paths and cwds legitimately contain almost any byte — spaces, unicode, punctuation, even a literal backtick or `$` in a filename — and an allowlist narrow enough to catch every shell metacharacter would also reject a lot of real filenames for no safety gain, since the metacharacters are already neutralized by the quoting, not by the character check. This mirrors the `open-terminal` `preLaunchCmd` guard's own documented lesson (`.ai/contexts/ipc-bridge.md`, "IPC path-guard inventory"): a denylist proved incomplete there because that string is deliberately raw shell; here the string is never raw shell in the first place, so closing by quoting is available and preferred over closing by enumeration.

`buildRemoteGitCommand`/`shQuote` never emit a backtick for any input, proven in `test/git-changes-runner.test.js` including adversarial cwd/path values containing backtick, `$(...)`, and an embedded single quote.

**Measured, not assumed** (`test/git-changes-runner-real-git.test.js`, a real `git init`-ed temp repo, no injected `exec`): an absolute pathspec that resolves outside the repository is refused by git itself (`fatal: ... is outside repository`, exit 128, empty stdout) — with or without `--literal-pathspecs` — so no code here needs its own absolute-path rejection on top of that. An absolute pathspec *inside* the repo still works normally. A `~`-prefixed pathspec is never shell-expanded (no shell in the local path; a shell exists on the remote path but the value sits inside single quotes, and tilde expansion does not apply inside single quotes either way) — it just resolves to a literal, almost-certainly-nonexistent relative path.

### Remote transport stdout cap (`remote-attach.js` `defaultRunRemoteCommand`)

`defaultRunRemoteCommand(alias, command, {timeoutMs, maxStdoutBytes, spawnFn})` counts accumulated stdout in UTF-8 bytes as each chunk arrives (`Buffer.byteLength`, works for both a real Buffer chunk and a test's plain-string chunk). Crossing `maxStdoutBytes` (default `DEFAULT_MAX_STDOUT_BYTES` = 8 MB when the caller doesn't pass one) SIGKILLs the child and resolves `{code: -1, stdout: '', stderr: 'stdout exceeded <n> bytes'}` — the same `{code, stdout, stderr}` shape every other path already returns, so `git-changes-runner.js`'s existing `firstError()`/`ok:false` handling surfaces it as `{ok: false, error: 'stdout exceeded <n> bytes'}` with no special-casing. `git-changes-runner.js` passes an explicit cap on every call — `STATUS_MAX_STDOUT_BYTES` (2 MB) for each of the three `status()` commands, `DIFF_MAX_STDOUT_BYTES` (`MAX_DIFF_BYTES` + 64 KB slack) for `diff()`, so a diff just over the panel's own display cap still arrives whole and gets truncated locally instead of being killed by the transport first. The tmux probe/restore calls in `remote-attach.js` and `remote-stop.js`'s kill command never pass `maxStdoutBytes` and fall back to the 8 MB default — their own output is a handful of bytes, nowhere near either cap (verified: `test/remote-attach.test.js` and `test/remote-stop.test.js` pass unmodified).

`opts.spawnFn` is dependency injection for tests only (`test/remote-run-command-stdout-cap.test.js`, a fake `child_process`-shaped `EventEmitter` with `stdout`/`stderr`/`kill`) — production code never passes it, and the lazy `require('child_process')` stays the real default.

## cwd resolution (`git-changes-target.js`)

`resolveGitChangesTarget(sessionId, deps)`, in order:

0. **`isValidChangesSessionId(sessionId)`** — refused before any dependency runs, including `getCachedFolder`. Accepts a plain CLI-issued id (`/^[A-Za-z0-9._-]+$/`, excluding the bare `.`/`..` — same shape and rationale as `isValidSessionId` in `delete-session-target.js`, since a local id ultimately reaches `resolveSessionRealCwd` → `path.join(projectsDir, folder, sessionId + '.jsonl')`) or a remote descriptor-only placeholder id, `pid:<positive integer>` (`remote-index.js` `buildPlaceholderSession` — a live descriptor with no CLI-issued session id yet is keyed on its pid instead). Everything else — a `/` or `\`, a `..` segment, a bare `sub:<parent>:<agent>` subagent id — is refused: `main.js` never routes a subagent id to either `git-changes-status` or `git-changes-diff` (subagents render as a read-only transcript, not a Changes-panel-bearing session), so that shape is out of scope rather than silently accepted.
1. **Remote folder** → the host's live descriptor list (`remoteIndexer.getRemoteSessions(alias)`), matched by `sessionId`. No PTY/attach required — issue #251's acceptance criteria is "works without attaching".
2. **Local, live in this app** → the session's own recorded `.cwd` (may be a worktree) — short-circuits the disk scan below.
3. **Local, not live here** → `resolveSessionRealCwd()`, the same disk scan `open-terminal`'s resume path uses ("For a Claude resume, spawn in the session's real recorded cwd…", `main.js`), so Changes and `claude --resume` never disagree about which directory a session's cwd really is. Refused if the resolved path no longer exists on disk.

Extracted out of the two IPC handlers into its own module, fully dependency-injected, so this order is unit-tested without booting Electron (`test/git-changes-target.test.js`) — same rationale `delete-session-target.js` and `run-schedule-now-target.js` already document for their own handlers. Step 0's whole point is to be provably reachable *before* the disk-scanning fallback (step 3): `test/git-changes-target.test.js` asserts `resolveSessionRealCwd` is never called for `"../../x"`.

`filePath` on `git-changes-diff` is a git pathspec relative to that cwd, not an absolute filesystem path, so `ipc-path-validator.js`'s allowlist/denylist helpers (which assume an absolute path under a known root) don't fit — it's validated by the runner's own `isSafeGitPath` instead (see "Quoting rule" above).

## Refresh triggers (no polling)

`refreshChanges(sessionId)` in `public/file-panel.js` runs only from three places: opening the tab, the panel's own Refresh button, and a subscriber registered with `onSessionIdle()` (`public/session-activity.js`) inside `initFilePanel()`.

`onSessionIdle(cb)` is a plain callback registry — not a DOM class writer, so it's outside the four-class enforcement `.ai/contexts/session-state.md` documents. `setActivity()` fires it only on a genuine busy→idle **edge** — `wasActive && !active`, where `wasActive` is `sessionBusyState`'s value from before this call overwrote it — never on every call where `active` is merely falsy. That distinction matters for a caller that legitimately re-asserts idle more than once with nothing busy in between: a remote row's decay/detach path calls `setActivity(id, false, via, {armReady: false})` (`.ai/contexts/session-cache.md`, "Remote hosts — busy spinner") specifically so idle does *not* arm response-ready — but that opt-out also means the pre-existing response-ready-lock dedup (an idle call is dropped early when `responseReadySessions.has(sessionId)`) never engages for it either, since that lock is only armed when `armReady` is true. Before this fix, two such `armReady:false` idle calls in a row (no intervening busy) each independently called `notifySessionIdle`, double-firing the panel's refresh. The edge check subsumes both cases: an ordinary duplicate idle already covered by the response-ready lock still reads `wasActive:false` on the second call (harmless overlap, not a conflict), and the `armReady:false` case that the lock never covered is now caught by the same line. A session with no Changes tab open is a no-op lookup (`filePanelState.get(sessionId)` misses); a session whose tab is a different type is skipped by the `currentTab.type === 'changes'` check. Proven in `test/dom-file-panel-changes.test.js`: zero `gitChangesStatus` calls while busy, one refresh per busy→idle edge (including the `armReady:false` path), and none for an unrelated session's idle transition.

`file-panel.js` references `onSessionIdle` even though `session-activity.js` loads *after* it in `index.html` — safe because the reference lives inside `initFilePanel()`'s body, which only runs once `app.js` (the last script) calls it, by which point every script has already evaluated. Same reasoning `.ai/contexts/session-state.md` documents for `session-activity-dom.js`'s own out-of-order cross-file references.

## Renderer: why not `ViewerPanel` for the diff

`public/file-panel.js`'s Changes mode is a third tab type (`'changes'`), alongside the pre-existing `'file'` and `'diff'` (MCP) types, on the same per-session `filePanelState` — opening one replaces whatever the other was showing. It does not route the diff through `ViewerPanel`'s CodeMirror editor or the MCP diff tab's merge-view: both expect an old/new content pair, and a `git diff` result is a unified-diff text blob. The bundled CodeMirror also has no diff/patch language mode to color it with. The fallback is deliberately plain: one `<div class="changes-diff-line">` per line, classed by its `+`/`-`/`@@` prefix (`classifyDiffLine()`), set via `textContent` (no HTML injection risk from diff content, which can contain arbitrary user code).

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
