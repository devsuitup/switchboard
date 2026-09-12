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
- `parseNumstat(text)` → `{[path]: {added, deleted}}`. Binary files report `-` in git's own output; that becomes `null` here, not `0`, so a caller can tell "no lines changed" apart from "line count unknown". Handles both rename spellings numstat can emit — `old => new` (keyed on the new path) and `prefix/{old => new}/suffix` (partial common-directory rename).
- `mergeChanges(status, numstatStaged, numstatUnstaged)` → the panel's model: each file gets `added`/`deleted` summed across whichever of the two numstat maps have an entry for it (a file modified in both the index and the worktree has two independent diffs; a file already staged and now edited again is a real, common case, not an edge case). An untracked file's counts stay `null` — `git diff` never reports untracked files at all. `totals` sums only the known (non-null) counts.
- No `-z`/NUL-terminated output is used for either command, so a path needing `core.quotepath` escaping (embedded quotes, some non-ASCII) can, in principle, fail to correlate between the status and numstat outputs. Not hit by the acceptance criteria; not fixed here — flag it if it comes up.

## Runner interface (`git-changes-runner.js`)

`createGitChangesRunner({kind, cwd, alias, exec, timeoutMs})` → `{status(), diff(path, {staged})}`. `status()` runs three commands in parallel (`git status --porcelain=v2 --branch`, `git diff --numstat`, `git diff --cached --numstat`) and merges them. `diff()` runs `git diff [--cached] -- <path>`, capped at 512 KB with a `truncated` flag.

- **Local** (`kind: 'local'`): `child_process.execFile('git', args, {cwd, timeout, maxBuffer})` — cwd is `execFile`'s own option, never a `-C` argument. No shell is invoked, so argument content cannot be interpreted as a command regardless of what it contains; timeout 10s.
- **Remote** (`kind: 'remote'`): the same ssh transport `remote-attach.js` already uses for the tmux probe/restore calls (`buildRemoteCommandArgs`, `defaultRunRemoteCommand`) — `ssh -o BatchMode=yes -o ConnectTimeout=5 -n <alias> "git -C '<cwd>' 'diff' '--' '<path>' ..."`. Timeout 20s. This command string DOES run through a shell on the far end.

### Quoting rule: denylist + single-quote escaping, not an allowlist

`cwd` and the diff `path` are the two values that reach the remote command string. Both are wrapped with `shQuote()` — standard POSIX single-quote escaping (close the quote, insert a literal quote via `'\''`, reopen) — before they're interpolated. That one function is what actually makes the remote path safe: a correctly single-quoted string cannot be broken out of by any byte sequence except an embedded NUL, and NUL can't appear in a shell token or a JS string used as one to begin with.

Given that, `isSafeShellArg`/`isSafeCwd`/`isSafeGitPath` are a **denylist** (reject control characters and, for the path, any `..` segment) rather than a positive character allowlist. The reasoning: git paths and cwds legitimately contain almost any byte — spaces, unicode, punctuation, even a literal backtick or `$` in a filename — and an allowlist narrow enough to catch every shell metacharacter would also reject a lot of real filenames for no safety gain, since the metacharacters are already neutralized by the quoting, not by the character check. The character check exists only to catch the one thing quoting can't fix (NUL/newline) and, for paths, to keep `..` from walking outside the repo. This mirrors the `open-terminal` `preLaunchCmd` guard's own documented lesson (`.ai/contexts/ipc-bridge.md`, "IPC path-guard inventory"): a denylist proved incomplete there because that string is deliberately raw shell; here the string is never raw shell in the first place, so closing by quoting is available and preferred over closing by enumeration.

`buildRemoteGitCommand`/`shQuote` never emit a backtick for any input, proven in `test/git-changes-runner.test.js` including adversarial cwd/path values containing backtick, `$(...)`, and an embedded single quote.

## cwd resolution (`git-changes-target.js`)

`resolveGitChangesTarget(sessionId, deps)`, in order:

1. **Remote folder** → the host's live descriptor list (`remoteIndexer.getRemoteSessions(alias)`), matched by `sessionId`. No PTY/attach required — issue #251's acceptance criteria is "works without attaching".
2. **Local, live in this app** → the session's own recorded `.cwd` (may be a worktree) — short-circuits the disk scan below.
3. **Local, not live here** → `resolveSessionRealCwd()`, the same disk scan `open-terminal`'s resume path uses ("For a Claude resume, spawn in the session's real recorded cwd…", `main.js`), so Changes and `claude --resume` never disagree about which directory a session's cwd really is. Refused if the resolved path no longer exists on disk.

Extracted out of the two IPC handlers into its own module, fully dependency-injected, so this order is unit-tested without booting Electron (`test/git-changes-target.test.js`) — same rationale `delete-session-target.js` and `run-schedule-now-target.js` already document for their own handlers.

`filePath` on `git-changes-diff` is a git pathspec relative to that cwd, not an absolute filesystem path, so `ipc-path-validator.js`'s allowlist/denylist helpers (which assume an absolute path under a known root) don't fit — it's validated by the runner's own `isSafeGitPath` instead (see "Quoting rule" above).

## Refresh triggers (no polling)

`refreshChanges(sessionId)` in `public/file-panel.js` runs only from three places: opening the tab, the panel's own Refresh button, and a subscriber registered with `onSessionIdle()` (`public/session-activity.js`) inside `initFilePanel()`.

`onSessionIdle(cb)` is a plain callback registry — not a DOM class writer, so it's outside the four-class enforcement `.ai/contexts/session-state.md` documents — fired once per `setActivity(sessionId, false, …)` call, for that `sessionId` only (`notifySessionIdle`, called at the end of `setActivity` when `active` is falsy). A session with no Changes tab open is a no-op lookup (`filePanelState.get(sessionId)` misses); a session whose tab is a different type is skipped by the `currentTab.type === 'changes'` check. Proven in `test/dom-file-panel-changes.test.js`: zero `gitChangesStatus` calls while busy, on a duplicate idle signal with no new transition (swallowed upstream by `setActivity`'s own response-ready lock), or for an unrelated session's idle transition.

`file-panel.js` references `onSessionIdle` even though `session-activity.js` loads *after* it in `index.html` — safe because the reference lives inside `initFilePanel()`'s body, which only runs once `app.js` (the last script) calls it, by which point every script has already evaluated. Same reasoning `.ai/contexts/session-state.md` documents for `session-activity-dom.js`'s own out-of-order cross-file references.

## Renderer: why not `ViewerPanel` for the diff

`public/file-panel.js`'s Changes mode is a third tab type (`'changes'`), alongside the pre-existing `'file'` and `'diff'` (MCP) types, on the same per-session `filePanelState` — opening one replaces whatever the other was showing. It does not route the diff through `ViewerPanel`'s CodeMirror editor or the MCP diff tab's merge-view: both expect an old/new content pair, and a `git diff` result is a unified-diff text blob. The bundled CodeMirror also has no diff/patch language mode to color it with. The fallback is deliberately plain: one `<div class="changes-diff-line">` per line, classed by its `+`/`-`/`@@` prefix (`classifyDiffLine()`), set via `textContent` (no HTML injection risk from diff content, which can contain arbitrary user code).

## What's untested for remote

The real ssh transport (`remote-attach.js`'s `defaultRunRemoteCommand`) is exercised only by construction in `git-changes-runner.test.js` (`kind: 'remote'` with no `exec` override — asserts `runner.kind`/`runner.alias`, makes no network call), consistent with the hard rule against ssh-ing to a real host from tests. Everything downstream of the transport — command shape, quoting, parsing, the IPC handlers, cwd resolution — is fully tested with injected fakes.
