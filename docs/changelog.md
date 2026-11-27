# Changelog

[`CHANGELOG.md`](../CHANGELOG.md) at the repository root says what changes for
a user in each release. It is the body of each GitHub release
([Releasing](releasing.md)) and the content of the What's new dialog the app
shows after an update.

## The file

```markdown
# Changelog

One line of introduction.

## Unreleased

### New
- …

## v0.0.85 — 2026-10-01

### New
- …
### Changed
- …
### Fixed
- …

---

Older versions: see [GitHub Releases](…).
```

- One `## Unreleased` section, then one `## vX.Y.Z — YYYY-MM-DD` section per
  version, newest first. The separator is an em dash (`—`), and the heading
  has nothing after the date.
- A beta has its own `## vX.Y.Z-beta.N — YYYY-MM-DD` section, holding what
  changed since the previous beta. When the final `vX.Y.Z` is cut, its betas'
  sections are folded into one `## vX.Y.Z — YYYY-MM-DD` section and their
  headings deleted, so the file never holds a beta beside its final
  ([Releasing](releasing.md)). `test/changelog.test.js` and the release tag
  check enforce it.
- Versions are tagged on `release/X.Y`, each branch with its own
  `## Unreleased`. After each release the release branch is merged back into
  `main` ([Branches](branching.md#port-back)), bringing its dated section;
  an entry that section contains leaves `main`'s `## Unreleased`: an entry
  that shipped from a release branch never stays there, or the next beta would
  announce it again. Before each cut, the older dated sections of the bump
  branch and the release branch must be identical, except the beta sections
  a final folds: an entry merged on `main` after a cut can land under that
  cut's heading ([Branches](branching.md#pitfalls)). A port-back adds the
  release's section to `main` and keeps `main`'s own, newer ones.
- Up to three groups per version, in this order: `### New`, `### Changed`,
  `### Fixed`. A group with no entry is left out.
- The `---` line closes the last section: the pointer to GitHub Releases below
  it belongs to no version.
- A second-level heading of any other shape makes the file unreadable to the
  app, which then shows no dialog. `test/changelog.test.js` parses the
  repository's file and fails first.
- Under `## Unreleased`, only `### New`, `### Changed` and `### Fixed` are
  allowed. `test/changelog.test.js` enforces this on the repository file in
  CI's test job using `parseChangelog(text, { strict: true })`, rejecting
  headings such as `### Added`. The app and release-note extraction use the
  default lenient parser: unknown third-level Unreleased headings do not hide
  released sections or prevent the What's new dialog from opening.
  Historical version bodies and text after the closing rule retain their
  existing interpretation.

## Writing an entry

Every PR that changes what a user sees or can do adds its entry under
`## Unreleased`, in the group it belongs to.

- One or two plain sentences, on what the user sees or can now do, not on the
  code that does it.
- A backport to a release branch carries the same entry, under that branch's
  `## Unreleased`; `main` keeps its own until the release is ported back.
- Two open PRs that both add an entry conflict on `CHANGELOG.md`: merge
  `origin/main` into the later one and keep both entries.
- The PR or issue ref at the end: `(#338)`, or `(#337, #343)`.
- If the change needs a caveat or an action from the user, say it in one
  sentence.
- Leave out tests, CI, refactors, docs-only changes and internals.
- The renderer reads bold (`**…**`), inline code (`` `…` ``) and `https`
  links (`[text](https://…)`). Anything else, HTML included, shows as the
  text it is.

## The CI check

The `changelog` job of `.github/workflows/test.yml` runs on every pull request.
It is a required check of the `main-protection` and `release-protection`
rulesets, so a PR to `main` or `release/*` that it fails cannot be merged. It fails when the PR changes app code and not
`CHANGELOG.md`. App code is what electron-builder ships: the `*.js` files at
the root (`eslint.config.js` excepted), `public/`, `workers/`, `src/`, `harnesses/` and
`scripts/claude-sandbox.sh`.

The PR is judged on its whole diff: `git diff <base>...<head>`, from the PR's
base SHA to its head SHA through their merge base, so every commit of the PR
counts and changes merged in from its base branch (`main` or `release/X.Y`) do not.

A PR whose app change users do not see (a refactor, a log line) takes the
`no-changelog` label instead. The script reads the labels through `gh api`
when it runs, not from the event that started the job: after adding the label,
re-run the failed job (`gh run rerun <run-id> --repo devsuitup/switchboard --failed`, or **Re-run failed
jobs** on the checks page).

The YAML only invokes `scripts/check-changelog.js`:

```bash
node scripts/check-changelog.js --base <sha> --head <sha> --repo <owner/name> --pr <number>
node scripts/check-changelog.js --base <sha> --head <sha> --labels '["no-changelog"]'
```

It exits 0 when the check passes, 1 when it fails, and 2 on missing arguments
or when git or gh cannot answer. `test/check-changelog.test.js` runs it end to
end on a temporary repository.

## Documentation in the same PR

Every PR that changes behaviour updates the affected user documentation in
`docs/` (or `README.md`) and agent documentation in `.ai/contexts/` in that
same PR. Name the files in the PR body's Docs section. If either category
needs no update, explain why. If neither needs an update, write
`no docs: <reason>` and apply the `no-docs` label. The PR template also asks
for the summary, changelog entry or `no-changelog` waiver, and test results.

The PR-only `docs` job in `.github/workflows/test.yml` invokes the
dependency-free `scripts/check-docs.js`. It shares the changelog check's app
path classification: root JavaScript except `eslint.config.js`, `src/`,
`public/`, `workers/`, `harnesses/`, and `scripts/claude-sandbox.sh`.
An app change must include at least one changed path under `docs/` or
`.ai/contexts/`, or `README.md`, unless it has the exact `no-docs` label.
Test-only, CI-only, tooling-only and docs-only changes pass automatically.
`CHANGELOG.md` and `.ai/shared-guidelines.md` alone do not satisfy this gate.

Like the changelog check, it reads the whole merge-base PR diff with renames
disabled and reads current labels through `gh api`. After adding `no-docs`,
re-run the failed job. This waiver is independent of `no-changelog`.

```bash
node scripts/check-docs.js --base <sha> --head <sha> --repo <owner/name> --pr <number>
node scripts/check-docs.js --base <sha> --head <sha> --labels '["no-docs"]'
```

Exit codes are 0 for a pass, 1 for missing docs, and 2 for invalid arguments,
invalid labels or a git/gh failure. `test/check-docs.test.js` covers the rule
and CLI wiring, substituting only the git/gh command boundary.
The check detects paths, not documentation quality or relevance; it does not
parse the PR body or require both documentation categories mechanically.
Reviewers still check that each affected document is updated and named.
Repository label creation and required-check settings are maintained separately
from this workflow.

## What's new in the app

On startup the renderer asks the main process (`whats-new-startup`), which
compares `app.getVersion()` with the `lastSeenVersion` stored in the global
settings (default `null`, in `public/setting-defaults.js`):

| Stored `lastSeenVersion` | What happens |
|---|---|
| none, or not an `X.Y.Z` or `X.Y.Z-beta.N` version, on a fresh install | No dialog; the running version is recorded |
| none, or not an `X.Y.Z` or `X.Y.Z-beta.N` version, on an existing install | As if the stored version were `0.0.84` (`VERSION_BEFORE_WHATS_NEW` in `changelog.js`), the last release without the dialog, which never recorded one |
| the running version or a later one | No dialog |
| an earlier version | The dialog lists every section after the stored version, up to the running one, newest first, skipped versions included. The running version is recorded when the dialog closes |
| an earlier version, but no section in that range | No dialog; the running version is recorded |

Versions compare numerically, part by part: `0.0.100` is after `0.0.99`. A
beta comes after the previous final and before its own: `0.0.109` <
`0.1.0-beta.1` < `0.1.0-beta.10` < `0.1.0`. A beta install updated to the
final is therefore shown the final section, which repeats what its betas
said. No other pre-release form (`-rc.1`, `-beta`) is a version here.

An install is existing when, as `main.js` loads and before this run writes
anything, the database already holds a `global` settings row or the
initial-scan marker (`INSTALL_PREDATES_LAUNCH`). A previous run leaves at least
one of them: `global` is written whenever the window is moved, resized or
closed, and the marker once the first index of `~/.claude/projects` completes.
A fresh install has a database created by this launch, which holds neither.

`CHANGELOG.md` is read main-side from the app's own directory, inside
`app.asar` in a packaged build (it is in `build.files` in `package.json`), so
the dialog needs no network. If the file is missing or cannot be parsed, the
app shows nothing, logs a `[whats-new]` warning to the main log, and records
nothing, so the next start tries again.

**Help → What's new** shows the running version's section. With no section
for that version (a build from an unreleased branch), it logs the same warning
and shows nothing.

The dialog (`public/whats-new.js`) closes on its × button, on Escape and on a
click outside it. A link opens in the system browser. The markdown is rendered
by a parser of the subset above that escapes every piece of text with
`escapeHtml`, and makes a link only of an `http` or `https` URL with no quote
or angle bracket in it.
