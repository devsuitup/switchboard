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

No session-cache, sidebar background-session, trigger, schedule or renderer
routing changes here. No Codex adapter is registered in this phase.
`harnesses/**` ships in `build.files`, receives Node ESLint rules and is
included in the module-layout resolver. No new top-level JS file is added,
so `test/fixtures/root-app-modules.json` remains unchanged.

The writer's existing writable column reconcile adds
`runtime TEXT DEFAULT 'claude'` and `sessionFile TEXT`. This addition does not
set `mustReindex`, clear rows or change numbered migrations. Readonly opens
perform no schema changes. Existing named-column upserts retain their old
arguments and preserve the new columns on update; populating these fields
from other runtimes belongs to a later phase.

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
