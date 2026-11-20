# CLI harness port

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
`sessionIdFromPath(filePath)` is a required filename-identity extractor
(Claude: basename without `.jsonl`), and `needsIdDetection({isNew, options})`
is a required launch predicate. Claude returns true only for `options.forkFrom`,
as upstream does: a fresh ordinary launch accepts `--session-id`, while a fork
mints its own id. Filename identity does not replace the fork parser's synthetic
subagent ids. `assertHarness()` checks the boolean and both method types;
semantic conformance is exercised against isolated storage in contract tests.

#821 must provide Codex's false `groupsByProject`, nullable
`folderForProject`/`deriveProjectPath`, rollout filename `sessionIdFromPath`,
directory-taking `listTranscripts`, authoritative `sessionFile`, and
`needsIdDetection({isNew})` returning true for fresh launches (including forks).
Its launcher must ignore a temporary/pre-assigned id for a fresh Codex launch,
while using the real id for resume. It must also provide the remaining fork
contract methods and capability flags. Main's existing Claude launch behavior
is unchanged here: routing the detection predicate, transcript matching and
identity reconciliation into the lifecycle remains work for #821 before Codex
can be launched. Merely passing `assertHarness()` does not implement that flow.

`assertHarness()` validates metadata, methods, boolean capability flags and
the optional usage provider. Features use `capabilities` (`subagents`,
`continuations`, `liveElsewhere`, `bgJobs`, `ideBridge`, `sandbox`, `schedule`,
`remote`), rather than runtime-name comparisons. These flags describe the CLI
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

No session-cache, sidebar background-session, trigger, schedule or renderer
routing changes here. No Codex adapter is registered in this phase.
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
the new columns on update; populating these fields from other runtimes belongs
to a later phase.

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
  SDK backfills never open a rollout through a Claude path), and
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
- Capabilities: all false, plus `deleteTranscript: false` (new flag, Claude
  true). Activity methods exist for the contract; routing them into main is
  #823.

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
  refuses a rollout whose originator is any `switchboard_` tag.
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
badge shows at once. The picker that starts a fresh Codex session is #824; the
`canLaunch` projection is now `true` for every row.

Tests: `harness-codex-launch.test.js` (argv goldens, tag and env, matching
grades, head reading, the shell binary, the extracted launch block against a
Codex row with and without its rollout, the re-key through
`session-transitions`, two forks of one parent with and without tags);
`codex-launch-ownership.test.js` (a tagged rollout stays with its exited,
removed or already adopted owner; an untagged fork rollout stays pending
before and after the first observation, with one or two forks open).

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

## Picker, toggles and settings (#824, partial)

Port of the picker and toggles of Ali Basiri's `ecd687f0`, `62e10fb9` and
`e0cd4dde`. The usage gauge (`3ca3d19d`, codex-auth of `ee656523`) is **not**
in this branch: it reads `~/.codex/auth.json` and calls an undocumented
chatgpt.com endpoint, and JB decided (2026-10-28) it must be opt-in and off by
default; nothing here fetches it, so no token leaves the machine.

- Settings (`public/setting-defaults.js`): `disabledHarnesses: []` — the
  disabled list, so a CLI added later defaults to on — and `codexSandbox`,
  `codexApproval`, `codexModel`, `codexEffort`, all `''` meaning "leave it to
  codex's own config". `resolveDefaultSessionOptions` copies the non-empty
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
  writer can finish. `set-setting` calls `restartHarnessWatchers` when the list
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
  `harnesses-changed` event: the toggle goes through `set-setting`, which
  already triggers `projects-changed`, and the picker asks on every open.
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
- Settings panel: a global "CLI Agents" section with one toggle per
  registered CLI (lock on the last one, "Not installed here" for an unavailable
  one) and, when Codex is registered, four selects for sandbox, approval,
  model (from `get-harness-models`) and effort. The section is global only;
  project scope keeps its Claude overrides.

Tests: `harness-settings.test.js` (defaults, guard and writer refusal,
disabled CLI hidden and skipped with rows kept, the picker's async entry and
its launch options, the picker without Claude, the IPC and preload wiring). The settings panel's toggle
rendering and save are not covered by a dom test.

### Streaming transcript scan

`jsonl-scan.js` (root, listed in `test/fixtures/root-app-modules.json`) is
upstream's `scanLines(filePath, startByte, onLine, endByte)` / `readHead`. It
holds one 256 KiB chunk plus the current line; `onLine` may return false to
stop. Tool output makes rollouts reach hundreds of MB, and a JS string costs
twice the file size.

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

### The sidebar badge

`buildProjectsFromCache` projects `runtime` (defaulting to `DEFAULT_HARNESS`)
and `runtimeLabel`, null for the default harness and the adapter's `label`
otherwise. `buildSessionItem` (`public/sidebar.js`) and the grid card
(`public/grid-view.js`) prepend a `.runtime-badge` when `runtimeLabel` is set;
the renderer compares nothing to a runtime name.

### Tests

`harness-codex.test.js` (parser, fixtures from upstream plus the AGENTS.md
rule, titles, metrics, folder keys, viewer mapping), `codex-index.test.js`
(`refreshFolder` over a fake `CODEX_HOME`, reconcile listing, projection,
rollup exclusion, scan worker, store columns), `codex-viewer-and-guard.test.js`
(follower transform, delete refusal, badge, main wiring). Running the suite on
a machine with a real `~/.codex` indexes it: point `CODEX_HOME` at an empty
directory first.
