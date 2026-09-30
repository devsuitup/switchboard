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
- Up to three groups per version, in this order: `### New`, `### Changed`,
  `### Fixed`. A group with no entry is left out.
- The `---` line closes the last section: the pointer to GitHub Releases below
  it belongs to no version.
- A second-level heading of any other shape makes the file unreadable to the
  app, which then shows no dialog. `test/changelog.test.js` parses the
  repository's file and fails first.

## Writing an entry

Every PR that changes what a user sees or can do adds its entry under
`## Unreleased`, in the group it belongs to.

- One or two plain sentences, on what the user sees or can now do, not on the
  code that does it.
- The PR or issue ref at the end: `(#338)`, or `(#337, #343)`.
- If the change needs a caveat or an action from the user, say it in one
  sentence.
- Leave out tests, CI, refactors, docs-only changes and internals.
- The renderer reads bold (`**…**`), inline code (`` `…` ``) and `https`
  links (`[text](https://…)`). Anything else, HTML included, shows as the
  text it is.

## The CI check

The `changelog` job of `.github/workflows/test.yml` runs on every pull request.
It fails when the PR changes app code and not `CHANGELOG.md`. App code is what
electron-builder ships: the `*.js` files at the root (`eslint.config.js`
excepted), `public/`, `workers/` and `scripts/claude-sandbox.sh`.

A PR whose app change users do not see (a refactor, a log line) takes the
`no-changelog` label instead. The job reads the labels when it runs, not when
the PR was pushed: after adding the label, re-run the failed job
(`gh run rerun <run-id> --failed`, or **Re-run failed jobs** on the checks
page).

The logic is `scripts/check-changelog.js`, tested by
`test/check-changelog.test.js`.

## What's new in the app

On startup the renderer asks the main process (`whats-new-startup`), which
compares `app.getVersion()` with the `lastSeenVersion` stored in the global
settings (default `null`, in `public/setting-defaults.js`):

| Stored `lastSeenVersion` | What happens |
|---|---|
| none, or not an `X.Y.Z` version (a fresh install) | No dialog; the running version is recorded |
| the running version or a later one | No dialog |
| an earlier version | The dialog lists every section after the stored version, up to the running one, newest first, skipped versions included. The running version is recorded when the dialog closes |
| an earlier version, but no section in that range | No dialog; the running version is recorded |

Versions compare numerically, part by part: `0.0.100` is after `0.0.99`.

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
