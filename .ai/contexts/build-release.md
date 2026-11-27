# Build and release workflow

## Advisory PR title check

`.github/workflows/pr-title.yml` runs on PRs to `main` and `release/*` when opened, edited,
synchronized or reopened. Its separate workflow refreshes title diagnostics
on edits without restarting the test/build workflows. It cancels older runs
for the same PR, uses Node 22, read-only contents permission, no persisted
checkout credentials and no dependency install. The job has a five-minute
timeout and `continue-on-error: true`; no required checks or repository
protection settings change.

`scripts/lint-pr-title.js` enforces `type(area): subject`. Allowed types are
`feat fix perf refactor docs test build ci chore revert`; the area is a
non-empty token without whitespace or parentheses, and the subject starts
with a non-whitespace character after the colon and space. Titles must be
one line. `type(area)!: subject` marks a breaking change. The former
`(area): subject` format is invalid. Release titles use
`chore(release): v0.1.0` (or a candidate such as `v0.1.0-beta.1`).

The workflow passes the title through `PR_TITLE`, never a shell expression.
`node scripts/lint-pr-title.js --advisory` exits zero on an invalid title,
writes a warning annotation and appends guidance to `GITHUB_STEP_SUMMARY`.
Valid titles also get a summary. Diagnostics contain fixed guidance rather
than the untrusted title, preventing command or Markdown injection. Job-level
continue-on-error also keeps operational failures advisory. Running without
`--advisory` exits one on an invalid title; exported `lintPrTitle(title)`
returns `null` or a diagnostic so a future commit-msg hook can share the rule.
No hook is installed by this change. This dependency-free check implements
the agreed format while commitlint tooling remains a later integration.

`test/lint-pr-title.test.js` loads the actual module, exercises its CLI entry
in a VM without source wrapping, and parses the actual workflow. It covers
valid/invalid titles, missing input, breaking markers, warning/summary output
and advisory versus strict exit codes. It does not prove GitHub's check-run
UI or repository settings; those need verification on a real PR. The
maintainer recorded `PR_TITLE` squash-title selection in issue #1199.
Making the check required is a separate maintainer decision after rollout.

## Beta and final tags (#1199)

Tags are `vX.Y.Z-beta.N` or `vX.Y.Z`; the procedure and the channel mechanics
are in [releasing.md](../../docs/releasing.md) ("Betas and finals", "The tag
check", "Update channels"). The trigger stays `tags: ['v*']`: GitHub's glob
already matches `v0.1.0-beta.1`, and the shape is enforced by the check, which
fails with a message instead of silently not starting a run.

`release-tag` is a separate tag-push-only job (same `if` as `publish`,
Node 22, full-history checkout without credentials, 10 minutes) running
`scripts/check-release-tag.js`. It runs beside the matrix rather than before
it, so a refused tag costs a build but adds no latency to an accepted one;
`publish` needs `[build, release-tag]`. The beta comparison (diff, package
and lock comparison, fold check) applies only when a `vX.Y.Z-beta.N` tag of
the final's own version exists; without one the final passes on release-branch
provenance, tag shape and `package.json` version and the log says no beta was
compared. This keeps the
plain `v0.0.N` path releasable: an unconditional "final needs a beta" rule
blocked the next plain release (review F1 of #1231). `readFileAt` verifies the
ref as a commit first, so an unknown tag exits 2 rather than reporting a null
version. The script is dependency-free and
reuses `src/main/app/changelog.js` for the fold check. The `package.json` and
lock comparison strips `version` (and the lock's `packages[""].version`) and
compares the rest as JSON, so a dependency change hidden in a "bump" fails.
That is stricter than the file list the maintainer decided; it can be dropped
without touching the file-list rule.

`scripts/publish-release.sh` derives the pre-release flag from the tag (any
`-` means pre-release), passes `--prerelease=<bool>` on create and on an
existing draft, then re-reads the release list and uploads nothing unless the
tag's release reads `true <flag>` (draft, pre-release). The read-back uses the
same `gh api` listing as the first read, because the tag endpoint does not
return drafts. The read-back is retried up to five times, 3 s apart
(`READ_BACK_DELAY`), when it fails or finds nothing: the new draft can take a
moment to be listed. Publishing the draft stays manual.

The release-notes step compares a final with the previous final
(`git describe --exclude '*-*'`) and a beta with the previous tag of any kind.

`src/main/app/changelog.js` accepts `-beta.N` (N from 1) in versions and
headings and orders a beta after the previous final and before its own
(the fourth compared part is the beta number, `Infinity` for a final). Any
other pre-release form still throws, as every pre-release did before.

Unverified until a real tag push: GitHub's acceptance of the new job and
`needs` list, `gh release create/edit --prerelease=<bool>` on a draft keeping
it a draft, the read-back output shape, `git describe --exclude` on the
runner, and that electron-builder packages a `-beta.N` version on every target
(names derive from `${version}`; deb/rpm versions use `~`, pacman `_`, NSIS
`0.1.0.0`, per app-builder-lib's `LinuxTargetHelper.getSanitizedVersion` and
`AppInfo.getVersionInWeirdWindowsForm`).

## Release branches (#1199)

The maintainer decided on 2026-11-25 that `main` never freezes: releases are
cut from `release/X.Y` ([releasing.md](../../docs/releasing.md#release-branches)).
The workflow side is the trigger list `[main, 'release/*']` in `test.yml`
(PR and push), `build.yml` (PR) and `pr-title.yml` (PR); tag pushes are not
filtered by branch. `*` does not cross `/`, so `release/*` matches
`release/0.1` and not `release/0.1/x`; the ruleset `release-protection` uses
the same pattern, and a working branch named `release/vX` falls under both.

The changelog and documentation jobs receive the PR's base and head
SHAs and diff through the merge base, patch coverage compares with
`origin/${{ github.base_ref }}` after fetching it (a base with a slash is an
ordinary ref name), and `check-release-tag.js` compares trees and tags,
whatever the branch. `docs` is not a required check on either base.

Bootstrap: `pull_request` workflows are read from the PR's merge commit, so a
PR to a release branch runs CI only if the base or the PR carries the
triggers. `release/0.1` was cut at `v0.1.0-beta.2` without them; they reach it
with a backport that ships in its next beta, because the tag check refuses a
final differing from its last beta by a workflow file.

Known limit: the notes' compare link uses `git describe` on the tag's own
history. Finals tagged on one release branch are not ancestors of the next
line, so a new line's `X.Y.0` compares with an older final; the link is
corrected by hand in the draft.

The triggers are pinned by `test/build-workflow.test.js` and
`test/lint-pr-title.test.js`. Not covered: GitHub starting the runs, which the
first PR to a release branch shows.

## Release provenance (2026-11-27)

`scripts/check-release-provenance.js` exports `checkTagProvenance`,
`checkReleaseProvenance` and `createGitReaders`. The checks take injected
readers; the CLI exits 0/1/2 for success/rule failure/input or Git failure.
No SQLite, Electron or npm dependencies are involved; the PR job uses Node 20.

Both provenance jobs fetch `origin/main` and extract its checker with
`git show origin/main:scripts/check-release-provenance.js` into
`$RUNNER_TEMP/check-release-provenance.js`. They execute that copy with the
checkout as cwd, so changing the PR/tag copy of the script cannot bypass
the check. The script requires only Node built-ins; no repository modules
or npm resolution from the temporary directory are needed. Main must
contain the checker before rollout; extraction errors fail the job.

The tag-push-only `release-tag` job also explicitly fetches the release refspec,
then requires the peeled tag commit to be contained by an
`origin/release/*` branch, before the existing version/beta check.
`publish` still needs both `build` and `release-tag`.

`.github/workflows/release-provenance.yml` runs only on PRs to `release/*`,
with read-only contents permission and a full-history checkout. It fetches
main and all release branches and passes the actual PR head SHA via an
environment variable, not the synthetic merge SHA. The range is
`origin/<base>..<head>`, not first-parent history or a tree diff.
Each commit must be on main, a merge, a nonempty bump touching only the
three root release files, or an `-x` backport with its full source SHA on
main. A bump can change `CHANGELOG.md` freely, but parsed `package.json`
must equal its parent after deleting only `version`; for the lock, only
root `version` and `packages[""].version` are deleted. Missing or invalid
package JSON is not a bump. Scripts and dependencies require main provenance.
NUL-delimited paths and disabled rename detection retain deletions
when code is renamed into an allowed file. Missing refs fail closed.
The check validates recorded provenance, not patch equivalence; merge
resolutions and changelog contents are exempt by policy.

`test/check-release-provenance.test.js` requires production code directly,
uses real temporary Git histories, parses both workflows and executes the
CLI in a VM with a filename and no source wrapping. It covers annotated
ancestor tags, off-release tags, valid backports, missing source/main refs,
merge-parent offenders, disguised renames, CLI errors and workflow wiring.
A real Git fixture reproduces #1312: release-only bump and merge commits on
the base, a head merging that base tip, and subsequent version bumps. It
accepts that history and rejects unported code brought by another head merge.
Package script/dependency and lock dependency changes are rejected.
The procedure and maintainer settings are documented in
[The tag check](../../docs/releasing.md#the-tag-check); `docs/branching.md`
does not exist on this base. Release branches use merge commits to preserve
the checked ancestry and `-x` lines; `v*` tags are admin-only.
Requiring the new check is a separate GitHub setting, and older release
branches need a backport of the workflow. GitHub-side execution and settings
remain unverified locally.

## Packaging and test workflows

`.github/workflows/build.yml` runs on version-tag pushes, manual dispatches
and packaging-related PRs to `main` or `release/*`. PRs and dispatches include Windows,
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
`publish`, the only downstream job (`needs: [build, release-tag]`), has a 10-minute bound, as does `release-tag`.
Runners: `windows-2022`, `ubuntu-latest` (Linux x64), `ubuntu-24.04-arm`
(Linux arm64) and, on tag pushes, `macos-15`.

`publish` requires a version-tag **push** and keeps `needs: [build, release-tag]` and the
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
recovery downloads the tag run's artifacts, keeps both architecture-specific
pacman packages, then uses this script; see the release guide for commands.

The pacman `artifactName` in `package.json` includes `${arch}` so publish's
`merge-multiple: true` cannot overwrite one Linux package with the other.
electron-builder's pacman artifact macro expands to `x64` and `aarch64`
(the latter is the arm64 job), producing `switchboard-doctly-<v>-x64.pacman`
and `switchboard-doctly-<v>-aarch64.pacman`. The package name remains
`switchboard-doctly`. A full release has 20 assets (measured on v0.1.0-beta.3, 2026-11-27), 9 of
them macOS, so a release drafted without macOS has 11; both pacman
packages are among them; each Linux update manifest must reference its own package and hash.
`test/build-workflow.test.js` loads the real package configuration and builder
macro helpers to check that both matrix entries retain distinct filenames.
This guard does not build packages or generate manifests; verify those in the
tag build before publishing.

Windows stays pinned to `windows-2022`: the Server 2025 image behind
`windows-latest` lacks the Visual Studio C++ toolchain needed by node-gyp for
node-pty. Linux stays split by architecture because electron-builder's native
module rebuild between architectures applies only to the first target type;
multiple targets in one multi-architecture invocation can reuse modules from
the wrong architecture (issue #18).

Both workflows group PR runs per PR number (`pr-<number>`) and give every other
run its own group (`github.run_id`), and cancel older runs only for `pull_request`.
Tag pushes, branch pushes and dispatches never cancel in-progress runs. Every
upload explicitly retains PR artifacts for 3 days and other artifacts for
14 days. Tag artifacts feed `publish` through `actions/download-artifact` in
the same run, so the 14-day retention does not change that dependency.

`test.yml` has no path filter. PRs run Node 20/Linux and Node 22/Linux+Windows;
pushes to `main` and `release/*` run Node 22/Linux+Windows. Matrix keys remain `node-version`, then
`os`, with no job-name override, retaining contexts such as
`test (22, ubuntu-latest)`. No step depends on a Node 20 or Windows/Node 20
cell. Linux real-bwrap enforcement stays on every Linux test cell; patch
coverage stays on PR Node 22/Linux only. Lint and e2e still run for every PR
and push to these branches; changelog and docs stay PR-only. Test jobs have 25 minutes; lint,
changelog, docs and e2e have 10 each.

The `docs` job invokes `scripts/check-docs.js` with the PR base/head SHAs and
repository/PR number, full checkout history and `GH_TOKEN`. It reuses
`check-changelog.js`'s app-path classification and label validation, reads a
NUL-delimited `git diff --name-only --no-renames <base>...<head>`, and fetches
current labels via `gh api`. App changes need a changed `docs/`, `.ai/contexts/`
or `README.md` path, or the exact `no-docs` label; non-app changes pass.
Errors reading inputs fail closed with exit 2; missing docs exits 1.
`test/check-docs.test.js` loads the real script with plain require and a VM
with a filename, substituting only command execution for the CLI checks.
The rule and PR-body requirements are in [changelog.md](../../docs/changelog.md#documentation-in-the-same-pr).
The gate does not assess relevance, require both doc categories, or parse the
PR body. Adding the label requires a job rerun, as for `no-changelog`.
Creating the label and making `docs` a required check are separate repository
administration actions; this workflow does neither.

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
`processes`, `filesystem`, `conpty`, `links` and `sqlite` markers also select callers
transitively, as do those markers in production dependencies. Helper-only
`platform` and `winpath` markers do not propagate: `dom-setup.js` must not
select every jsdom caller solely for its platform setup. Other marker categories
remain direct-test checks; production `process.platform` remains transitive.
SQLite binding names (`better-sqlite3` and `node:sqlite`) select both direct
tests and callers through relative helpers. This keeps real-store tests in
Windows CI even when the helper loads the store through a VM rather than a
literal relative require. The fixture fallback regression names the binding
directly, so its source-extraction load is also selected. Node 20 keeps the
fixture callers' existing visible unsupported-runtime skips.
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
branch. No production-module exclusion list is applied. Selection above
roughly 75% requires reporting contributors before considering justified
exclusions.

At #1220, adding the SQLite marker selects 632 of 707 files (622 before),
with no removals. Five of the ten additions use `fixtures/conversation-store.cjs`:
the fixture fallback, pin metadata, harness schema, writer BUSY short retry,
and writer chunk wall-time suites. The other additions are db-fts-contentless,
db-search-query-bound, db-session-metrics, search-worker-db-failure and
worker-exit-grace. All 40 fixture consumers are now selected. The regression
in `platform-test-selection.test.js` discovers these consumers by reading
sources and checks their inclusion without executing them; it also exercises
direct and transitive selection for each binding. The existing heuristic
limits still apply to other test families; this is not an all-suite guarantee.

The FILETIME conversion and comparison live in the pure
`src/main/cli/proc-start.js`, re-exported by the root `cli-session-state.js`.
`src/main/bg-agents/bg-worker-liveness.js` imports the pure module, so roster/UI
tests no longer reach process probes just to compare creation timestamps.
`src/main/remote/remote-attach.js` still uses `src/main/remote/remote-ssh-binary.js` to resolve the actual SSH
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
must be updated together whenever the test matrix changes, with the
`release-protection` ruleset (28112036, `refs/heads/release/*`), which requires
the same six checks. Changing these
workflows does not update those settings.

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
