# Managed browser lifecycle (#812, S2)

`src/main/browser/managed-browser.js` exports `createManager` and
`cleanupDataDir`. It is CommonJS and Electron-free. Requiring it or constructing
a manager does no filesystem, socket, HTTP or process work. No renderer, IPC,
settings or session-launch path calls Open/ensureStarted in this slice. There
is no MCP dependency or configuration writer yet; that belongs to S3.

The main process constructs the manager using the directory of DB_PATH.
`shutdownForExit` calls `stopForQuit` synchronously immediately after its
repeat guard and before starting the bounded drain. Only an owner of a verified
child-mode browser with its own matching spawner identity sends SIGTERM there.
Scope/detached browsers and followers receive no quit signal. Source-extraction
fixtures must supply the manager when evaluating this shutdown function.
The quit call is caught and logged so a manager exception cannot prevent the
remaining bounded shutdown or the repeat guard from taking effect.

Operations are queued. Linux starts on explicit Open or ensureStarted only;
other platforms return an unsupported result without touching storage or
spawning. Results include status, role, port, binary, mode, survival, notice
and error. Errors stay recoverable values. Browser-open is best-effort HTTP
activation, with a PUT new-page fallback; compositor focus is unverified.

Discovery accepts an absolute ELF executable or numeric-descending Chromium cache
revisions. Executable launcher scripts are refused with a request to configure
the real Chromium ELF binary, for example `/usr/lib/chromium/chromium`, rather
than `/usr/bin/chromium`. Only the four-byte ELF magic is checked, not the ELF
architecture or browser provenance. An explicit cache root is authoritative.
Symlink hops, directory links and final targets are checked for Snap; no installed-browser fallback,
download, headless-shell or personal profile is used. A private canonical data
directory holds profile, output, state and a per-start truncated log. Directory
modes are 0700, file modes 0600; foreign owners and symlinks are refused.
State writes use unique exclusive temporary files, fsync and rename. Output
pruning covers only ordinary old files directly under output, after ownership
has been acquired. No profile files are pruned.

Failure memo keys include configured paths, cache-root/revision candidates and
binary metadata. Installing a browser or changing the selected binary retries
without waiting sixty seconds. A synchronous spawn refusal clears the pending
reservation; publication failure after spawn terminates only the verified
launch before returning an error. Ambiguous outcomes retain their state.

The owner lock is a Unix listener at a hash-derived path in a private absolute
XDG_RUNTIME_DIR, or a short socket under the managed directory. Live socket
means follower. ECONNREFUSED permits one inode-checked stale unlink/retry.
Long/unsafe/unavailable paths refuse management. Operations retry acquisition
for followers; followers do not write state, prune, start or stop. There remains
a simultaneous stale-takeover check/unlink race: a competing new socket could
replace the checked inode before unlink. The browser profile singleton is the
last backstop, not the locking protocol. Socket close has a similar unavoidable
pathname race. Neither is a cross-user security boundary.

State schema version 1 records a persistent port, canonical profile/binary,
PID/startTime/boot identity, spawner identity, mode, unit and start time. A port
reservation may have no PID. Start time and boot ID, rather than PID existence,
decide whether a recorded browser still exists. A reused PID or another boot
resets the state to a port-only reservation without signalling the replacement.
An owner reconciles a pending ambiguous launch before Start or Stop: in the same
boot, scan for the exact binary/profile/port and adopt a verified match; no
match clears the pending state to a port-only reservation. A different boot
clears it without scanning. Missing boot identity or an adoption verification
failure retains data. Followers cannot reconcile or write pending state. An
exited launcher is also scanned before its pending reservation can be cleared.
Reserve before discovery; reuse across Stop/Open. Foreign occupation replaces the port and returns a
restart-sessions notice. Bind/spawn races are checked against the actual
listener, with at most three allocations in the start budget.

Linux identity uses field 22 from proc stat (index 19 after the final `)`), boot
ID, executable, exact profile/port argv and the listening socket inode in that
PID's fds. TCP6 or wildcard listeners are refused. Joined and NUL argv forms
are supported, with bounded size and exactly one profile and debugging-port
argument. A version HTTP response alone cannot establish ownership.
Listener ownership by a browser child is deliberately unsupported pending real
headful evidence. Source orphan adoption requires a dead start-verified spawner
and records the new one before it can signal at quit.

Packaged starts use systemd-run --user --scope, detached/unref and file-backed
stdio; every command argument doubles dollars. Only a definite missing-user-bus
failure before a browser exists permits one detached fallback. It is marked as
not surviving restart. FATAL/sandbox errors and ambiguous timeouts never cause
a detached or no-sandbox retry. Chromium's sandbox remains enabled.
Dollar handling is NOT verified against real systemd: `--scope` may not perform
the environment expansion that doubling dollars assumes. The escaping behavior
is preserved pending a real systemd check, including literal-dollar paths.

Normal Stop re-verifies the endpoint, sends Browser.close, waits five seconds,
then re-verifies immediately before TERM (three seconds) and KILL (one second).
Descendant ancestry is captured before close, but ancestry alone does not
authorize a signal: a descendant must have the browser executable, an exact
profile argument, or a Chromium `--type=` argument. Start time, boot ID and
these executable/argv markers are checked again immediately before each
positive-PID signal. Unrelated native-messaging hosts and download handlers,
including descendants that exec into them during close, are left alive.
When the browser identity still verifies but its listener has already closed,
Stop skips CDP and waits up to five seconds for exit before the usual verified
TERM/KILL escalation. A listener disappearing during endpoint verification uses
the same path. A foreign listener or identity change still refuses signalling.
Without pidfd, identity-check-to-signal races remain; no process group, name or
scope-wide kill is used. The twenty-second start readiness budget and bounded
HTTP responses do not prove Linux sandbox, cgroup or signed-in survival.

HTTP requests have both a 500 ms total deadline and an inactivity timeout, plus
a 64 KiB response limit. WebSocket uses the existing runtime `ws` dependency so
it also works without a Node global WebSocket. Permission failure during owner
socket setup closes the listener before rejecting acquisition.

`scripts/test-pr.js` captures SWITCHBOARD_DATA_DIR before fixture preparation,
awaits cleanup on launch success/rejection/fixture error, and removes launchCwd
only after confirmed browser exit. A cleanup error retains both paths with a
warning. `cleanWorktree` is now async and stops the browser before unlinking
the dependency junction or removing the worktree/data. It never creates a
manager when no managed-browser directory exists. Windows refuses cleanup of
an unexpected existing browser directory rather than guessing at Linux PIDs.

Tests use real disposable files, fake process/clock/lock boundaries, injected
procfs/net fixtures and a Node HTTP/WebSocket fake browser. Windows tests prove
the unsupported policy; Linux mode/permissions/process behavior still requires
Linux execution. No real browser, Electron or Playwright is needed for S2.

Loopback CDP has no user/session authentication. Other local processes can
control the signed-in browser; this library is not a filesystem or network
isolation boundary. Chromium's own sandbox stays enabled.
