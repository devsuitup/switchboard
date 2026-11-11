# Build and release workflow

`.github/workflows/build.yml` runs on version-tag pushes, manual dispatches
and packaging-related PRs to `main`. PRs and dispatches include Windows,
Linux x64 and Linux arm64. Only a `push` whose ref starts with `refs/tags/v`
adds macOS; dispatching on a tag ref still uses the three-job matrix. The
JSON arrays in `matrix.include` must keep the non-mac entries in sync.

The PR path filter covers `package.json`, `package-lock.json`, the requested
root `postinstall.js` path, `scripts/**` and the build workflow itself. The
actual postinstall is `scripts/postinstall.js`; `scripts/**` also covers the
`scripts/after-pack.js` hook and icon generators. `build/**` covers icons, macOS
entitlements and the DMG background. The builder configuration is inline in
`package.json`; there is no separate electron-builder config. Dependencies are
covered by the lockfile. The filter is packaging only: application source
(`*.js`, `src/**`, `workers/**`, `public/**`, `harnesses/**`) and `CHANGELOG.md`
are deliberately absent, so a code PR builds no installers. A packaging break
caused by source surfaces at the tag, where strict publish blocks it (accepted
risk, maintainer decision).

Each matrix job retains `timeout-minutes: 60`. These are parallel jobs, not
dependent stages: the budget must fit installation/native rebuilds, both
viewer bundles and packaging, including macOS arm64+x64 DMG/ZIP and Windows
x64+arm64 NSIS. Retaining the existing hour avoids cutting the tag-build
budget without measured runner timings; it is not a measured duration.
`publish`, the only downstream job (`needs: build`), has a 10-minute bound.

`publish` requires a version-tag **push** and keeps `needs: build` and the
default success gate. A manual dispatch never publishes, even on a tag ref.
A failed or cancelled macOS tag build blocks automatic publication; no partial-publish or
`continue-on-error` path exists. Recovery and manifest consistency requirements
are in [releasing.md](../../docs/releasing.md).

`scripts/publish-release.sh` requires non-empty `GITHUB_REPOSITORY` and
`GITHUB_REF_NAME` before any gh call. The release lookup names the repository
in its API path; draft creation and every upload attempt pass
`--repo "${GITHUB_REPOSITORY}"`, so a clone's gh default cannot redirect writes.
The script tests execute Bash with a fake gh boundary and cover repository
selection, missing configuration, draft guards and upload retries. Manual
recovery downloads the tag run's artifacts, keeps the x64 copy of the colliding
pacman filename, then uses this script; see the release guide for commands.

Windows stays pinned to `windows-2022`: the Server 2025 image behind
`windows-latest` lacks the Visual Studio C++ toolchain needed by node-gyp for
node-pty. Linux stays split by architecture because electron-builder's native
module rebuild between architectures applies only to the first target type;
multiple targets in one multi-architecture invocation can reuse modules from
the wrong architecture (issue #18).

Both workflows group PR runs per PR number (`pr-<number>`) and give every other
run its own group (`github.run_id`), and cancel older runs only for `pull_request`.
Tag pushes, main pushes and dispatches never cancel in-progress runs. Every
upload explicitly retains PR artifacts for 3 days and other artifacts for
14 days. Tag artifacts feed `publish` through `actions/download-artifact` in
the same run, so the 14-day retention does not change that dependency.

`test.yml` has no path filter. PRs run Node 20/Linux and Node 22/Linux+Windows;
main pushes run Node 22/Linux+Windows. Matrix keys remain `node-version`, then
`os`, with no job-name override, retaining contexts such as
`test (22, ubuntu-latest)`. No step depends on a Node 20 or Windows/Node 20
cell. Linux real-bwrap enforcement stays on every Linux test cell; patch
coverage stays on PR Node 22/Linux only. Lint and e2e still run for every PR
and main push; changelog stays PR-only. Test jobs have 25 minutes; lint,
changelog and e2e have 10 each.

Linux runs the full Node suite with coverage. Every non-Linux runner runs
`node scripts/run-tests.js --platform-only` without c8; its matrix and job
name stay unchanged, including `test (22, windows-2022)`. The coverage step
previously had no explicit environment; both test steps retain that inherited
environment. The PR patch gate reads `coverage/lcov.info` only on Node 22/Linux.

`scripts/platform-tests.js` computes rule C from current files, with no stored
allowlist. It strips physical carriage returns before scanning each test for
strong platform markers: platform checks, Windows paths, conpty/node-pty,
Windows shells, links and filesystem errors, Windows environment variables,
escaped CRLF and case-insensitive paths. Real process calls (`spawn`,
`spawnSync`, `execFile`, `execFileSync`, `.kill`) and filesystem identity or
rename markers (`fs.rename`, sync/promises variants, `realpath`, `birthtime`,
`bigint: true`) also select a test. A tmpdir fixture using realpath therefore
stays selected, including on Windows with an 8.3 TEMP path.
The exported `STRONG_MARKERS` retains the study's POSIX/platform variants.
Relative production requires are followed transitively with a per-test visited
set: reaching a production file containing `process.platform` selects the test.
Test helpers are traversed to reach production dependencies. Their
`processes`, `filesystem`, `conpty` and `links` markers also select callers
transitively, as do those markers in production dependencies. Helper-only
`platform` and `winpath` markers do not propagate: `dom-setup.js` must not
select every jsdom caller solely for its platform setup. Other marker categories
remain direct-test checks; production `process.platform` remains transitive.
Node_modules are excluded. Literal requires
resolve files, `.js`, `.cjs` and `index.js`; unresolved literals in test fixtures
are ignored. The read/dependency caches are scoped to one selection call.

Limits: this is a source heuristic, not a JavaScript parser or proof that all
Windows-sensitive behavior is covered. It does not follow dynamic imports,
non-relative packages, worker filenames or source-extraction reads. It can
overselect dead code and mocked calls. Windows bug regressions with no visible
marker must retain the explicit opt-in: `task-review-regressions.test.js`
retains the #650 reader/worker regression family, and
`derive-project-path.test.js` exercises the separator expression in
`resolveWorktreePath` using real tmpdir paths, without a `process.platform`
branch. No production-module exclusion list is applied. The selection is 387
of 570 files at #1029 (379 before the change: 13 added, 5 removed); selection
above roughly 75% requires reporting contributors before considering justified
exclusions.

The FILETIME conversion and comparison live in the pure
`src/main/cli/proc-start.js`, re-exported by `cli-session-state.js`.
`bg-worker-liveness.js` imports the pure module, so roster/UI tests no longer
reach process probes just to compare creation timestamps. With only this split,
selection falls to 341 files; the transitive marker rule brings back 33 and adds
13. `remote-attach.js` still uses `remote-ssh-binary.js` to resolve the actual SSH
executable; its platform-specific executable checks and search paths are not a
pure-helper dependency and remain selected.

To force Windows execution, add a relevant strong marker or the explicit test
source comment `// platform: windows`; extend the exported marker set when a
new category is needed. Physical CRLF endings alone do not opt in. The runner
filters both ordinary and isolated files, prints `platform-only: N of M test
files`, and refuses fewer than 150 selected files or any listed-file read
failure. Empty stages never fall back to Node's implicit test discovery.
Normal mode also refuses a missing `ISOLATED_FILES` inventory entry, naming it
before launching any stage; platform mode may intentionally filter that entry.
`test/platform-test-selection.test.js` pins selection, floor and stage behavior;
`test/build-workflow.test.js` pins coverage and the Windows command.
Its routing guard evaluates every matrix OS plus macOS and an unknown future
OS, requiring exactly one of coverage (`runner.os == 'Linux'`) and platform-only
(`runner.os != 'Linux'`). Matrix JSON, key order and job names stay unchanged.

The fast CLI canary's source harness intercepts the runner's exit expression
before compiling it. The runner retains that expression outside `runSuite()`;
the platform-selection tests read the consumer's interception anchor and check
that it remains present, without executing the locally excluded canary.

The required-check list is documented in [releasing.md](../../docs/releasing.md).
Build is not a required check. JB owns the external settings update that removes
`test (20, windows-2022)` from both ruleset 17240725 (`main-protection`) and the
classic branch protection on `main` (`required_status_checks.contexts`); both
must be updated together whenever the test matrix changes. Changing these
workflows does not update those settings.
This CI-only change takes the `no-changelog` PR label.

To obtain an installer for any branch, dispatch the build and download that
run's artifacts; see [testing-a-pr.md](../../docs/testing-a-pr.md#obtaining-a-pr-installer).
`task test-pr` runs sources and has no artifact dependency.

`test/build-workflow.test.js` parses both actual workflows using `js-yaml`
and evaluates their JSON matrix literals for PRs, pushes and dispatches,
including dispatch on a tag. It checks matrices, timeouts, triggers, retention,
concurrency, unchanged Test gates, failure propagation and strict publish
dependency. It evaluates expressions as JavaScript, not with the Actions
expression engine, so it is a configuration guard only. An Actions run's job
list must verify expression acceptance and context names; the full release
remains a tag-run check. It does not verify runner queue behavior either;
`timeout-minutes` bounds a hung build on a runner, not time spent queued.

Trade-off: the macOS-only "Test postinstall helpers" step now runs on tags
only. Its test files still run on Linux and Windows through `test.yml`; a
darwin-only regression in `postinstall.js` first shows at tag time, where it
blocks `publish`.
