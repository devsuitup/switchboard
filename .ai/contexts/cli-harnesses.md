# CLI harness port

## Isolated developer launchers (#1314)

`scripts/launcher-env.js` owns `buildLaunch` for `scripts/test-pr.js`,
`isolatedEnv` for `e2e/fixtures.js`, and test-pr's `writeRefusingStubs`.
It has no Electron or Playwright dependency, so the environment boundary can
be tested with plain `require` without executing either launcher.

Both isolated modes set `CODEX_HOME` to `<temporary HOME>/.codex` and drop
inherited spellings case-insensitively. The default test-pr mode keeps the
user's Codex home. The audit of `harnesses/` and `src/` found no further
harness-state override: `CODEX_HOME` also controls Codex usage credentials and
full-read roots; `SWITCHBOARD_DATA_DIR` and `SWITCHBOARD_TRIGGERS_DIR` already
point inside the disposable home. Claude paths derive from that home, and
`CLAUDE*` overrides are dropped. `XDG_RUNTIME_DIR` selects a managed-browser
socket location, not a harness history root, and stays available to desktop
runtime services.

Both isolated modes also drop inherited `ZDOTDIR`, `BASH_ENV`, `ENV`,
`PROMPT_COMMAND` (an exported `. ~/.bashrc` reloads it before each prompt) and
`INPUTRC` (an absolute path to the user's Readline file), which would make a
plain terminal's zsh or bash read the user's real shell config
(the generated rcfile / `ZDOTDIR` logic in `plain-terminal-shell.js` falls back
to the disposable `HOME` when `ZDOTDIR` is absent), and point `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` inside the disposable
home. The default test-pr mode keeps all of them.

Test-pr installs refusing Codex stubs (shell, cmd, PowerShell) in its first
PATH entry. `ALLOW_CLAUDE=1` omits only the Claude stub, keeping Codex refused
and the temporary home isolation intact. E2E fixtures do not install stubs.
Their drop rule matches the `CLAUDE` and `GIT_` prefixes and the exact names
`CODEX_HOME`, `HISTFILE`, `ELECTRON_RUN_AS_NODE`, `ZDOTDIR`, `BASH_ENV`, `ENV`,
`PROMPT_COMMAND`, `INPUTRC` and the four `XDG_*_HOME` roots case-insensitively.

`test/launcher-env.test.js` covers both builders, inherited/unset and mixed-case
Codex homes, default-mode preservation, and stub lookup with both Claude modes.
`buildLaunch` does not take `allowClaude`; only stub installation varies with
that option. `test/test-pr.test.js` checks the `main()` launch environment
and Codex stub files in both isolated Claude modes, including an inherited
`CODEX_HOME` sentinel outside the disposable home.
This is a unit boundary: live launchers, Electron and Playwright remain CI
validation, not part of this local proof. See `docs/testing-a-pr.md` and
`docs/e2e.md`. Developer tooling only: no-changelog.

## Custom launch arguments (#1202)

`SETTING_DEFAULTS` owns empty `customArgs` and `codexCustomArgs`, and exports
`validateCustomArgs` for the Settings renderer and main-process command builders.
It rejects non-strings, C0/C1 controls, DEL and Unicode line/paragraph separators.
The fields are textareas so pasted newlines remain visible to validation rather
than being silently stripped by HTML single-line inputs. Save validates before
writing either scope; dirty tracking includes textareas.

Claude inherits project then global, with an explicit empty project value
disabling inheritance. Codex follows the existing global-only Codex controls.
`customArgsForLaunch` resolves launch options first, then the applicable stored
scopes, using the resolved cwd. Dialogs forward effective Claude options; main
also resolves settings for schedules. Remote launches read only global arguments,
ignoring both local project settings and forwarded custom-argument overrides.
The remote adapter currently launches Claude; Codex's separate field remains
global-only. `codexCommand` fixes its binary to Codex and delegates the
shell encoding to `claudeCommand`; each receives only its own selected field.

Custom text is raw shell syntax appended after generated argv, before prefix/cwd
and SSH/tmux transport wrapping. It is not one argv token. PowerShell's helper
receives the shell-parsed custom tokens and preserves its native argv encoding;
command-length checks include the suffix. Custom text is appended after the
generated argv, behind a bare `--`: `__switchboard_launch '<program>' '<token>'...
-- <custom text>`. The helper declares no `param()` block and takes the program
from `$args[0]`, shifting the rest (`$__sbCmd=$args[0];$args=@($args|Select-Object
-Skip 1)`): a named parameter could be bound by an abbreviated flag in custom
text (`-__s x` replaced the launched program). PowerShell consumes the first bare
`--` of any function call as its end-of-parameters marker, even without
`param()`, so the generated `--` is the one consumed and a `--` typed in custom
text reaches the program, as it does when PowerShell runs a native command
directly. Both measured on Windows PowerShell 5.1. A `-name:value` token is still
split in two by PowerShell's parser before the helper runs.
Windows cmd/PowerShell schedules split literal quoted custom tokens, append them
to generated argv and keep the existing direct executable/npm target resolution
(see `schedule-runner.md`, "Windows launches"). Sandbox replacement commands
append the same validated text. Remote scripts keep the validated base command's
space join, append nonempty custom text as typed for the remote POSIX shell,
then apply the existing `shellSingleQuote` layers. No command-preview surface exists.

Attaching to an already running daemon/remote process and internal Claude
management commands do not receive session arguments. Background `--bg` dispatch
through `runClaudeCommand` deliberately does not receive custom arguments.
No CLI or shell is
executed to validate the text. Tests: `custom-session-args`, `dom-settings-nav`,
and the existing launch/extraction suites; live transports remain a separate
qualification boundary.

## Codex startup observations (#1152)

`listFolders({ strict: true })` and `listTranscripts(dir, { strict: true })`
retain ENOENT/ENOTDIR as absence and propagate other enumeration failures.
Ordinary callers keep their permissive behavior. `readTitleSnapshot()` returns
the effective title Map with its source observation only after a complete,
stable read; an unknown observation returns null. `matchesTitleSnapshot()`
checks both the current home and the full source observation. Last valid title
entries and blank-to-null semantics are unchanged.

`readSessionFile(file, folder, { startup: true, outcome, titleSnapshot })`
finishes the selected rollout and supplies an outcome of row, excluded,
deferred, absent or failed. Stable exclusions are persisted as Codex-only
negative observations in folder metadata (#1195), without a session row.
Unindexed subagents retain their bounded header read; the worker validates
the source observation before recording that exclusion. Non-startup parser
output is unchanged.
Startup body selection does not restrict watcher/adoption candidates or change
launch tags, fork ownership or resume UUIDs. See session-cache.md for the
day selector, metadata-only name repair and root relocation contracts.

Issue #820 adds `harnesses/index.js`, `harnesses/claude.js` and
`harnesses/contract.js` at the upstream paths, before ADR 0005's context move.
The design follows Ali Basiri's upstream commits `ac72985f` and `f5e38a75`;
the fork's transcript and lifecycle implementations remain in place.

The contract defines TranscriptStore, TranscriptParser, Launcher and
ActivityClassifier on one flat adapter, with optional UsageProvider.
Store arguments follow upstream: `listFolders()` returns folder keys,
`folderPath(key)` resolves a key to an absolute directory, and
`listTranscripts(dir)` takes that directory and returns absolute transcript
paths. This replaces the initial fork's key-taking signature so #821 can port
the upstream Codex enumerator without an argument translation. Claude still
enumerates parent, preferred subagent and legacy subagent transcripts through
the fork helper. `folderForProject(projectPath)` may return null when a store
does not group by project.

`groupsByProject` is a required boolean (Claude: true),
`sessionIdFromPath(filePath)` is a required cache-identity extractor
(Claude: basename without `.jsonl` for parents; `sub:<parent>:<agent>` for
subagent transcripts under its configured projects root), and
`needsIdDetection({isNew, options})`
is a required launch predicate. Claude returns true only for `options.forkFrom`,
as upstream does: a fresh ordinary launch accepts `--session-id`, while a fork
mints its own id. Claude reuses `classifyTranscriptPath` and `subagentSessionId`
to match the parser's preferred and legacy subagent identities (#869).
The fourth `readSessionFile` argument is adapter-specific options, including
Claude's `parentSessionId` and deduplication options; it is not a previous row.
`assertHarness()` checks the boolean and both method types;
semantic conformance is exercised against isolated storage in contract tests.

The Codex adapter (below) supplies false `groupsByProject`, nullable
`folderForProject`/`deriveProjectPath`, rollout filename `sessionIdFromPath`,
directory-taking `listTranscripts`, authoritative `sessionFile`, and
`needsIdDetection({isNew})` returning true for fresh launches (including forks).
Its launcher ignores a temporary/pre-assigned id for a fresh Codex launch and
uses the real id for resume. Merely passing `assertHarness()` does not make a
CLI launchable: the detection predicate, transcript matching and identity
reconciliation are routed into the lifecycle by "Launching through the
harness" below.

`assertHarness()` validates metadata, methods, boolean capability flags and
the optional usage provider. Features use `capabilities` (`subagents`,
`continuations`, `liveElsewhere`, `bgJobs`, `ideBridge`, `sandbox`, `schedule`,
`remote`, `deleteTranscript`; `CAPABILITIES` in `harnesses/contract.js`), rather than runtime-name comparisons. These flags describe the CLI
integration; existing platform, host and settings checks still decide whether
a feature is usable for a particular launch.

The registry retains upstream names and Claude fallback for absent/unknown
runtime values. `harnessForFolder()` first calls `parseFolderKey()` so a
remote alias is removed before matching a runtime folder prefix. It selects
an adapter only; it does not resolve a remote mirror or change remote policy.
`transcriptPath()` respects an explicit `sessionFile`; the Claude fallback
delegates subagent-aware resolution to `read-session-file.js`.

Claude delegates to the fork's transcript parser/enumerator, project-path
derivation, encoder, continuation resolver, CLI live-state reader, cached
background-job reader, Windows binary resolver and title activity classifier.
Requiring an adapter starts no watchers, processes or database connections.
`createClaudeHarness({projectsDir})` supports isolated transcript roots without
changing global state. Filesystem methods read only when called. Job and
live-state readers retain their existing module initialization requirements.

`main.js` calls the pure `buildLaunchArgs({sessionId, isNew, options})` after
resolving whether a transcript exists and filtering worktree requests for a
non-git spawn directory. `isNew` here is the resolved `startsFresh` decision,
including the existing fork precedence. Git detection, actual cwd selection,
attach, sandbox wrapping, pre-launch shell prefix, shell quoting and MCP/IDE
startup stay in main. Characterization tests run the shipped argv block with
the same golden arrays before and after extraction.
The sandbox bind list delegates to the adapter's shared `parseAddDirs()` so
the two consumers keep identical comma-splitting and whitespace handling.

Browser settings compatibility uses the shared non-mutating
normalizer from `public/setting-defaults.js`. Claude's pure builder emits
`--chrome` only for `claude-in-chrome`, including an old exact `chrome: true`
option when no explicit mode exists. Off, invalid and Managed modes emit no
browser flag; an explicit mode always wins over legacy Chrome. The managed
value is parsed but not offered. There is no MCP configuration, browser process
or browser capability contract. Main calls the builder synchronously at the
existing launch extraction anchors.

The registry (`harnesses/index.js`) holds the Claude and Codex adapters.
`harnesses/**` ships in `build.files`, receives Node ESLint rules and is
included in the module-layout resolver. No new top-level JS file is added,
so `test/fixtures/root-app-modules.json` remains unchanged.

The writer's existing writable column reconcile adds
`runtime TEXT DEFAULT 'claude'` and `sessionFile TEXT`. This addition does not
set `mustReindex`, clear rows or change numbered migrations. Readonly opens
perform no schema changes, so `session-index-store.js` prepares its
`cacheUpsert` statement on first use: a readonly open of a pre-#820 store has
no `runtime` column yet, and preparing the statement eagerly would fail the
open. Existing named-column upserts retain their old arguments and preserve
the new columns on update. Codex rows fill both (`runtime: 'codex'`,
`sessionFile`; "Codex adapter" below).

Tests: `harness-contract.test.js`, `harness-launch.test.js`,
`harness-schema.test.js`, `module-layout.test.js`, `session-launch-guards.test.js`.
The schema test uses `test/fixtures/conversation-store.cjs`, loading unwrapped
production source with a filename. The fixture tries native SQLite and falls
back to `node:sqlite` when the local better-sqlite3 binary targets Electron.
It accepts readonly opens so the schema regression can verify that they never
migrate. Tests skip when neither backend is supported, including Node 20 with
an incompatible native ABI. The SDK-entrypoint migration also uses this fixture
instead of launching Electron. These tests exercise real SQLite and the
writable-store reconciliation, not the worker transport or Electron's binding.

## Codex adapter (#821)

`harnesses/codex.js` is a port of Ali Basiri's upstream adapter (doctly/switchboard
`896783ba`, `e71e6f0c`, the title index of `fe7fba01`, the viewer half of
`966715db`, the argv builder of the final `upstream/main:harnesses/codex.js`),
re-shaped for the fork's contract. Measured against 237 rollouts on
2026-11-19 (codex-cli 0.160.0), which settled the deviations from upstream.

- Store: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Folder
  key `codex/YYYY/MM/DD`; `groupsByProject` false; the project is
  `session_meta.payload.cwd`, read per transcript and trusted as is (the #385
  cwd check is Claude's folder-name check and cannot apply to a date folder).
  `folderPath(key)` accepts the key with or without the prefix and returns
  null for anything that is not exactly `YYYY/MM/DD`, so a stored key can never
  resolve outside the sessions root. `watchFolderKey(parts)` maps a watcher's
  relative path to its folder key, null for anything shallower than
  `Y/M/D/rollout-*.jsonl`.
- Identity: the file name's uuid (`sessionIdFromPath`). `session_meta.session_id`
  is the lineage root repeated by every resume. `transcriptPath(row)` is
  `row.sessionFile` or null: a Codex path cannot be rebuilt from an id.
- Parser: only `response_item` messages count (older versions duplicate them as
  `event_msg`); developer-role messages and injected user turns are skipped.
  Injected means tag-wrapped (`<environment_context>`, `<recommended_plugins>`,
  `<turn_aborted>`, `<transcript>`) **or** starting with
  `# AGENTS.md instructions` — 237/237 rollouts here open with that record and
  upstream's tag rule alone would make it every summary. Subagent rollouts
  (`thread_source==='subagent'`, `parent_thread_id`, `agent_path`,
  `agent_nickname`) return null: Codex refuses to resume them. `created` and
  `modified` come from conversation records, not settings or usage records
  (`e71e6f0c`). The row carries `runtime: 'codex'`, `sessionFile`, `fileSize`,
  `customTitle: ''` and `entrypoint: ''` (known-empty, so the Claude title and
  SDK backfills never open a rollout through a Claude path) — except that a
  rollout whose `session_meta.payload.originator` is `codex_exec` (a
  non-interactive `codex exec` run; 285/285 rollouts of 2026-11 on JB's
  workstation, all automation) carries `entrypoint: 'sdk-codex-exec'`, so
  `hiddenSdkSessionIds` hides it under the same `hideSdkSessions` setting as a
  Claude Agent SDK session, with the same open-tab and working-set exemptions
  (#1145). `codex_cli_rs`, `switchboard_*` and any other originator stay `''`.
  Rows indexed before #1145 hold `''` for every rollout: on first open the
  store (`codex_exec_entrypoint_version`) nulls `fileMtime` on `runtime =
  'codex'` rows and nulls `indexMtimeMs` on the `codex/` folder meta, keeping
  the folder inventory discoverable. The next reconciliation re-reads existing
  rollouts once and stamps the mark; if a date directory or the sessions root
  disappeared while the app was closed, it removes the stale rows and search
  entries through the normal missing-folder path. The
  mark is read from the header only: a `codex exec` thread later resumed
  interactively keeps its originator and stays hidden. And
  `dailyMetrics` per date × model from `turn_context.payload.model` and
  `token_usage_record.payload.usage` (`cached_input_tokens` → cacheRead,
  `cache_write_input_tokens` → cacheCreation; tool calls counted from
  `custom_tool_call`/`function_call`), so Codex sessions count in the heatmap
  and stats (decided by JB, 2026-10-28). The file is scanned one line at a
  time through `jsonl-scan.js` (`scanLines`), never read whole.
- Titles: `$CODEX_HOME/session_index.jsonl` (`{id, thread_name, updated_at}`,
  newest record wins, an empty newest clears). The adapter writes the name into
  `aiTitle` at read time so a Switchboard rename still wins; `titleIndexMtimeMs()`
  joins the folder freshness stamp so a `/rename` with no transcript change is
  picked up by the next reconcile pass, not by the watcher (the index sits
  outside the sessions root).
- Capabilities: all false, including `deleteTranscript` (Claude true)
  (`harnesses/codex.js`, `capabilities`). Its activity methods are routed into
  main as described in "Busy and attention per harness" below.

## Launching through the harness (#822)

Port of Ali Basiri's `7fe005eb`, `89440a33`, the fork part of `966715db`, the
Codex part of `632dc9d5` and the argv rules of `809b7546`, on the fork's
launch site.

`open-terminal` resolves `launchHarness` once, from `sessionOptions.runtime`
(a fork or a picker choice) or the cached row of the session being resumed or
forked (`getCachedSession(resumeSourceId).runtime`), Claude when neither says.
Everything downstream reads the adapter, never a runtime name:

- `resolveSessionRealCwd` and the pre-spawn snapshot of `.jsonl` files
  (`projectFolder`, `knownJsonlFiles`, `continuationSnapshot`) run only for a
  `groupsByProject` store; a Codex session has `projectFolder: null`, which
  keeps it out of `detectSessionTransitions`' fork and continuation detection.
  On resume or fork, a non-project-folder harness uses the source cached row's
  raw `projectPath` as `spawnCwd`; its sidebar project group may be the parent
  repository. Both harnesses refuse a missing recorded directory with
  "its worktree <path> no longer exists" instead of falling back to the group.
  `pendingLaunch.projectPath` remains `spawnCwd`, so grouping never changes
  Codex's cwd-based launch ownership evidence.
- "Start instead of resume" checks the transcript through the adapter: Claude's
  `sessionTranscriptExists`, otherwise `fs.existsSync(transcriptPath(row))` on
  the row's `sessionFile`. A Codex row whose rollout vanished launches fresh.
- `launchHarness.buildLaunchArgs(...)` builds the argv and
  `claudeCommand(shell, argv, { binary: launchHarness.binary })` names the
  binary (`powershellLaunch` takes it too; the PowerShell preamble resolves
  whatever `Get-Command` finds — measured on this machine: `codex` is
  `codex.ps1`, and `__switchboard_launch 'codex' '--version'` returns
  `codex-cli 0.160.0` in 5.9 s).
- `launchSandbox` is `sessionOptions.sandbox && capabilities.sandbox`; MCP/IDE
  emulation needs `capabilities.ideBridge`; both are simply off for Codex and
  the sandbox badge follows `session.sandbox`. The bg `attach` path is reached
  only from Claude job rows. The trigger watcher's idle wait is unchanged: it
  reads the busy state `wireSessionPty` derives from the terminal, which #823
  teaches to read Codex titles.
- `launchHarness.launchEnv(sessionId)` is merged into the PTY environment for
  every non-resume launch (Codex: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, Claude
  has none).

The session record carries `runtime` and, when `needsIdDetection` says so and
the adapter has `matchesLaunch`, a `pendingLaunch`
`{ tag, forkFrom, projectPath: spawnCwd, spawnedAt }`.

### Launching: a session that learns its id afterwards

Codex refuses a pre-assigned id and writes nothing until the first turn, so a
new or forked Codex session runs under the renderer's temporary uuid until its
rollout appears. `session-transitions.js` owns the adoption:

- `resolvePendingLaunches(harness, candidatePaths)` reads each candidate's head
  once (`readLaunchSignals`), skips a transcript already live in another tab,
  and grades every (pending session, candidate) pair with
  `matchesLaunch(signals, pendingLaunch)`, which returns `'tag'` when the
  originator is the launch's own tag, `'cwd'` for the cwd plus start-time
  fallback of a fresh launch, `false` otherwise. A fork launch (`forkFrom`
  set) is graded by its own tag only: `forked_from_id`, the start time, the
  parent's inherited tag or a sibling's tag are never fork evidence (decision
  of 2026-11-20: no guessing for a fork; a guess once donated a rollout to the
  sibling of a fork that exited before the first detection). Whether `codex
  fork` honours `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is not measured; if it
  copies the parent's originator instead, a fork stays under its temporary id
  for the tab's lifetime, which is the accepted outcome. The cwd fallback
  refuses a rollout whose originator is any `switchboard_` tag, and a rollout
  whose header declares `forked_from_id`: such a rollout belongs to some fork,
  so a fresh launch open beside an untagged fork in the same cwd cannot take
  the fork's rollout (round-5 review of #1132: before this rule the fork
  refused it and the fresh tab adopted it). The fork stays pending. A resume
  has no `pendingLaunch` at all (`launchMode !== 'resume'` in main's launch
  block), so there is no resume-side fallback to guard.
- Adoption is exact first: a candidate graded `'tag'` by a pending session goes
  to that session, and nothing else may take it. `session-transitions.js` keeps,
  per candidate id, every pending launch the candidate ever matched
  (`launchMatches`, reset by `init`). A remaining candidate is adopted by the
  cwd fallback only when it has only ever matched one launch, that launch is
  open, and that launch matches exactly one such candidate. A rollout that was
  once ambiguous between two fresh launches is latched for its lifetime: a
  sibling exiting, its tab being closed, or the other rollout vanishing never
  makes it adoptable, because uniqueness among the sessions still open is not
  ownership evidence. The latch starts at the first observation: a fresh launch
  in the same cwd that exits before the first detector run is not in it, so the
  cwd fallback can still hand its rollout to the sibling (known, not closed;
  the fork case is closed by the tag-only rule above). Untagged forks stay
  under their temporary ids for the tabs' lifetime (the 3 s sweep keeps
  running while they are open); a tagged rollout settles its own side.
- A match goes through `rekeySession(tempId, realId, session, [], kind)` with
  `kind` `'new'` or `'fork'` — the same path as a Claude fork. Main's metadata
  callback calls the writer only for `kind === 'background'`; these Codex
  adoptions do not persist a metadata rekey. `publishRekey` moves `activeSessions`, status
  generations, MCP, activity, trigger ownership and sends `session-forked`,
  which the renderer handles by re-keying the tab, pending row, restore set
  and task records. `publishRekey` skips the continuation snapshot when the
  session has no `projectFolder`.
- The harness watcher (`startHarnessWatchers` in `main.js`) resolves pending
  launches against the folder's transcripts before indexing it, so the row and
  the re-key land in the same beat; `armLaunchSweep()` runs
  `sweepPendingLaunches()` every 3 s while something is pending (rollouts with
  an mtime within a minute of the spawn), as a backstop for a dropped watch
  event, and stops itself.

`liveElsewhere`: Codex has no `~/.claude/sessions/<pid>.json` equivalent. The
process scan finds nothing for a Codex id, so the IPCs answer "no live process
known" and the sidebar shows the row's liveness as unknown, the same wording a
Claude row without a descriptor gets; `capabilities.liveElsewhere` is false and
the delete guard refuses the row before that check.

Renderer: `forkSession` passes `runtime` and `runtimeLabel` of the forked row
in the options; `launchNewSession` copies them onto the pending row so the
badge shows at once. A fresh entry of the saved working set carries the
pending row's `runtime` (`persistWorkingSet`, including held entries), and
`runRestore` passes it back with the label from `get-harnesses` when it starts
such an entry anew: a fresh Codex tab quit before its first prompt restarts
on Codex, not on the default CLI (`restore-fresh-runtime.test.js`). The picker that starts a fresh Codex session is #824; the
`canLaunch` projection is now `true` for every row.

Tests: `harness-codex-launch.test.js` (argv goldens, tag and env, matching
grades, head reading, the shell binary, the extracted launch block against a
Codex row with and without its rollout, the re-key through
`session-transitions`, two forks of one parent with and without tags);
`codex-launch-ownership.test.js` (a tagged rollout stays with its exited,
removed or already adopted owner; an untagged fork rollout stays pending
before and after the first observation, with one or two forks open, and is
not donated to a fresh launch open in the same cwd).

## Busy and attention per harness (#823)

Port of Ali Basiri's `eddc0d60` and the activity half of `e0cd4dde`. The
contract now requires `classifyNotification(message)` →
`'attention' | 'idle' | null` next to `classifyTitleActivity`, whose result may
carry `attention: true`.

- `wireSessionPty` (`main.js`) resolves `const sessionHarness =
  getHarness(session.runtime)` once per data chunk that contains an OSC and
  classifies the OSC 0 title through it. Claude's classifier is the fork's
  `classify-title-activity.js` unchanged (idle glyph, spinner ranges, the
  fallback a plain terminal does not get). Codex's reads the `activity` item
  the launch pins into the title: a braille frame is busy, "Action Required"
  is attention, anything else is idle; there is no idle glyph.
- Attention from a title is forwarded on its rising edge only
  (`session._titleAttention`) as `terminal-notification(id, title,
  'attention')`, so a title that repeats every frame raises one notification.
  An attention title is neither busy nor idle, so the busy state it interrupts
  stays as it was until the next spinner or plain title.
- OSC 9: the `9;4` progress branch is unchanged and harness-agnostic, and
  `4;0` stays ignored (decided by JB, 2026-10-28; Codex emits no `9;4`,
  assumed from upstream, not measured). Any other OSC 9 is sent as
  `terminal-notification(id, message, kind)` with `kind =
  sessionHarness.classifyNotification(message)`. Claude's rule is the
  renderer's historical regex (`attention|approval|permission|needs your|wants
  to enter` → attention, `waiting for your input` → idle, else null); Codex's
  is `Approval requested…` → attention, anything else → idle, because Codex
  sends exactly those two kinds (its final message when a turn completes).
- `preload.js` forwards the third argument. The renderer's
  `terminalNotificationState(message, kind)` (`public/app.js`) takes an
  explicit kind first and falls back to the regex when main sent none, so an
  older main or a Claude message without a kind behaves as before; `attention`
  sets `setAttention` when the session is not the active one, `idle` marks it
  response-ready through `setActivity(false)`. The activity trace records
  `kind` on `osc.notify` and `attention` on `osc.title`.
- The trigger watcher's idle wait reads the same `_cliBusy` state, so a Codex
  session's busy/idle now reaches it without further work.

Tests: `harness-activity.test.js` (title and notification tables for both
adapters, the renderer function through `loadAppFunctions`, the extracted
`wireSessionPty` fed Codex titles and OSC 9 messages).

## Picker, toggles and settings (#824)

Port of the picker and toggles of Ali Basiri's `ecd687f0`, `62e10fb9` and
`e0cd4dde`. The Codex usage gauge is a separate, opt-in feature (#1139, off by
default, `showCodexUsage`): `src/main/usage/codex-usage.js` reads
`$CODEX_HOME/auth.json` (default `~/.codex`) and calls a chatgpt.com endpoint only when the setting
is on, behind the `get-codex-usage` IPC. It does not go through the contract's
optional `usageProvider`. See ipc-bridge.md, "Opt-in Codex usage (#1139)",
for the fetch, backoff and footer grouping (#1209).

- Settings (`public/setting-defaults.js`): `disabledHarnesses: []` — the
  disabled list, so a CLI added later defaults to on — and `codexSandbox`,
  `codexApproval`, `codexModel`, `codexEffort`, all `''` meaning "leave it to
  codex's own config", and `showCodexUsage: false`. `resolveDefaultSessionOptions` copies the non-empty
  Codex keys into the launch options; the Codex builder validates them and the
  Claude builder ignores them.
- Guard: `assertHarnessSettings(fields)` (`harnesses/index.js`) refuses a
  `disabledHarnesses` that is not a string list or that leaves no registered
  CLI on (`code: 'HARNESS_GUARD'`). It runs inside the writer, on
  `patchGlobal` (`session-index-commands.js`) and on a raw
  `setSetting('global', …)` (`workers/session-index-writer.js`), so no
  forwarded read-modify-write can switch everything off (ADR 0004). The panel
  also locks the last checked toggle.
- Effects of a switched-off CLI: `prefixedHarnesses(disabledIds)` drops a
  non-default CLI from reconciliation, cold scan and harness watchers. Claude
  has explicit enabled-state checks before listing its projects in the cold
  worker and in reconciliation; `scanFoldersViaWorker` passes
  `disabledHarnesses` too, so the subset scans (bridge repair, remote hosts) walk
  nothing while Claude is off. A remote host's sessions are Claude sessions and
  follow the Claude switch: their rows are hidden with it and not rescanned until
  it is back on. The projects watcher keeps running while Claude is off, because
  it is the only detector of /clear, continuation and fork re-keys and of local
  transcript activity for the Claude tabs still open: its flush still calls
  `detectSessionTransitions` for each changed folder, but skips the workflow
  snapshot reads, `writer.refreshFolder` and `dropFolderRows`, re-checking the
  enabled state between awaited folder writes. Work already submitted to the
  writer can finish. `set-setting('global')` and `merge-global-settings`
  (both through main's `writeGlobalSettings`) call `restartHarnessWatchers` when the list
  changes: it restarts the harness watchers and opens the projects watcher only
  if none is running, so toggling Codex never drops the Claude watcher's queued
  batch.
  `buildProjectsFromCache`
  hides its rows (`exclude(row, 'harness-off')`) and the picker skips it. Its
  cached rows are kept, so switching it back on costs one incremental
  reconcile. `prefixedHarnesses` filters on the setting only, not on
  `available()`: an enabled CLI whose sessions root is gone lists no folders,
  so its cached folders are reconciled and their rows dropped (the watcher
  checks the root itself; the cold scan walks nothing).
- IPC: `get-harnesses` and `get-harness-models(runtime)` (generic names
  rather than upstream's `get-codex-models`; see ipc-bridge.md). No
  `harnesses-changed` event: the toggle goes through `merge-global-settings`
  (global Settings Save), which already triggers `projects-changed`, and the picker asks on every open.
- Picker: `showNewSessionPopover` renders the Claude entries at once and, when
  `getHarnesses` answers, inserts one `popover-option[data-runtime]` per
  enabled non-default CLI before Terminal (keyboard order follows), then
  removes both Claude entries when the default CLI is switched off — focus
  moves to the first remaining entry first, so the focus-out close does not
  fire. The entry launches with `runtime` and `runtimeLabel` in the options,
  which `open-terminal` resolves (#822) and the pending row badges (#821).
  `resolveDefaultSessionOptions` copies the non-empty Codex settings into the
  same options bag; the Codex builder validates them, Claude's ignores them.
  The settings panel locks the last checked toggle; the writer refuses an
  all-off patch anyway.
- Settings panel: a global "CLI Agents" section on the Sessions page
  (Settings → Sessions) with one toggle per registered CLI (lock on the last
  one, "Not installed here" for an unavailable one) and, when Codex is
  registered, the **Show Codex usage** toggle and a "Codex" group of four
  selects for sandbox, approval, model (from `get-harness-models`) and effort. The section is global only;
  project scope keeps its Claude overrides.

Tests: `harness-settings.test.js` (defaults, guard and writer refusal,
disabled CLI hidden and skipped with rows kept, the picker's async entry and
its launch options, the picker without Claude, the IPC and preload wiring). The settings panel's toggle
rendering and save are not covered by a dom test.

### Streaming transcript scan

`jsonl-scan.js` (root, listed in `test/fixtures/root-app-modules.json`) is
upstream's `scanLines(filePath, startByte, onLine, endByte)` / `readHead`. It
holds one 256 KiB chunk plus at most 64 MiB for the current line; `onLine` may
return false to stop. Above the exported `MAX_LINE_BYTES` cap, it discards the
record through the next newline without converting it to a string. An oversized
unterminated tail is omitted and marked in the optional witness. The cap is
shared by full readers, bridge signature scans and incremental message counts;
tests lower the exported cap. A zero-byte read before the observed EOF throws
`ERR_JSONL_SHORT_READ`, a retryable startup deferral. Tool output makes rollouts
reach hundreds of MB, and a JS string costs twice the file size.

### Harness folders in the index

`session-cache.js` keeps Claude's `refreshFolder` untouched and dispatches on
`harnessForFolder(folder).folderPrefix`: a prefixed key goes to
`refreshHarnessFolder(harness, folder)`. See `.ai/contexts/session-cache.md`
("Harness folders") for the scan, watcher and reconcile paths.

### The message viewer

`read-session-jsonl` resolves the row with `getCachedSession`, takes
`harness.transcriptPath(row)` when the row has a `sessionFile` and the Claude
path otherwise, and maps records through the harness: `toViewerEntries(entries)`
for the whole-file read, `toViewerEntry` handed to
`createTranscriptFollower().open(id, file, checkpoint, transform)` for the
follow/next modes, where it runs before the visibility filter and survives a
park/resume. Claude's mapping is identity. Codex's rewrites a message into a
`text` block, a `reasoning` summary into `thinking`, `custom_tool_call` /
`function_call` into `tool_use` keyed by `call_id`, and their outputs into
`tool_result` with the same id; developer messages and injected user turns are
dropped. The renderer never learns which CLI wrote the file.

### Deleting a transcript

`delete-session-guard.js` takes a `transcriptRefusal(id)` hook, built by
`harnessTranscriptRefusal(getCachedSession, getHarness)`: a row whose harness
has `deleteTranscript: false` is refused before any live check, naming the
sessions root to clean by hand. `delete-session-target.js` is Claude-layout
code and never sees a Codex row.

### Capabilities in the renderer

`get-harnesses` returns each adapter's `capabilities` as a plain copy beside
`id` and `label`. `initTerminalBackgroundControl` (`public/app.js`) reads that
list once at startup into `window._harnesses` (a `Map` keyed by id) and
repaints the header. `harnessBackgroundReason` looks up the open tab's
`session.runtime` there, and `backgroundActionReason` returns its answer: a
harness with `bgJobs: false` makes Send to background disabled, in the header,
the sidebar menu and the exit dialog, with "<label> sessions cannot be sent to
the background" (#1234). In the exit dialog that reason comes before the row's
`reason` from main's inventory, which for a Codex tab is the unreadable-state
refusal ("wait for its state to appear") because Codex writes no Claude state;
main's reason stays the fallback for every other row. A session
with no `runtime`, an unknown runtime, or a listing that failed or has not
answered yet keeps the action enabled; main's `sendToBackground` stays the
second line and refuses a session whose state it cannot read. Tests:
`send-to-background-renderer.test.js` R16 (Codex disabled, Claude unchanged),
R17 (a capability, not a runtime name, decides) and R18 (the exit dialog,
over a refused row from the real `inventory` and `backgroundRefusal`).

### The sidebar badge

`buildProjectsFromCache` projects `runtime` (defaulting to `DEFAULT_HARNESS`)
and `runtimeLabel`, null for the default harness and the adapter's `label`
otherwise. `buildSessionItem` (`public/sidebar.js`) and the grid card
(`public/grid-view.js`) prepend a `.runtime-badge` when `runtimeLabel` is set;
the renderer compares nothing to a runtime name.

### Tests

`harness-codex.test.js` (parser, fixtures from upstream plus the AGENTS.md
rule, the `codex_exec` mark against other originators, titles, metrics, folder
keys, viewer mapping), `codex-index.test.js` (`refreshFolder` over a fake
`CODEX_HOME`, reconcile listing, projection, the exec rollout hidden / listed /
open-tab exemption, the one-shot re-read of a pre-#1145 store, rollup
exclusion, scan worker, store columns), `codex-viewer-and-guard.test.js`
(follower transform, delete refusal, badge, main wiring). Running the suite on
a machine with a real `~/.codex` indexes it: point `CODEX_HOME` at an empty
directory first.
