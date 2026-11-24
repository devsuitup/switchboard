Perform a release for this project, following [docs/releasing.md](../../docs/releasing.md). Always push with an explicit remote (`git push origin …`): a clone whose `main` tracks `upstream` would send a bare `git push` to `doctly/switchboard`.

Every version ships as one or more **betas** `v{X.Y.Z}-beta.{N}` (GitHub pre-releases, beta channel only), then a **final** `v{X.Y.Z}` rebuilt from a commit that differs from the last beta only by `package.json`, `package-lock.json` (their version fields) and `CHANGELOG.md`. CI refuses any other tag shape (`-rc.N` included) and, once a version has a beta tag, any other final; a final with no beta of its version is checked for shape and version only. Ask the user which one to cut when they do not say. `{version}` below is the full version, `0.1.0-beta.1` or `0.1.0`.

1. Find the most recent version tag with `git fetch origin --tags && git describe --tags --abbrev=0 origin/main`, and read the commits since it: `git log {prev_tag}..origin/main --format="%B---"`.
   - **Beta:** check that every user-visible change among them has its entry under `## Unreleased` in `CHANGELOG.md` (the rule is in [docs/changelog.md](../../docs/changelog.md)); if one is missing, show the user the entry you would add and add it in the bump PR.
   - **Final:** `{prev_tag}` must be the last beta of this version, and the log must be empty: if anything was merged since that beta, stop and cut a new beta instead. `## Unreleased` must be empty too.
2. Bump the version on a release branch, never on `main` (the ruleset rejects direct pushes):
   ```bash
   git checkout -b release/v{version} origin/main
   npm version --no-git-tag-version {version}   # package.json and package-lock.json, nothing else
   ```
   In `CHANGELOG.md`:
   - **Beta:** rename `## Unreleased` to `## v{version} — {today, YYYY-MM-DD}` and open a new, empty `## Unreleased` above it.
   - **Final:** fold every `## v{X.Y.Z}-beta.N` section into one `## v{X.Y.Z} — {today}` section (merge the entries by group, drop entries about problems only a beta had, delete the beta headings). Show the user the folded section before committing.
   ```bash
   git commit -am "chore(release): v{version}"
   git push origin release/v{version}
   ```
   Do **not** tag this commit: a squash merge replaces it, and a tag on it would not be on `main`.
3. Open the PR and merge it once the required checks pass:
   ```bash
   gh pr create --repo devsuitup/switchboard --base main --head release/v{version} --title "chore(release): v{version}" --fill
   gh pr merge --repo devsuitup/switchboard --squash --auto release/v{version}
   ```
   Wait until `gh pr view --repo devsuitup/switchboard release/v{version} --json state` reports `MERGED`.
4. Update the local `main` to the merged commit:
   ```bash
   git checkout main
   git fetch origin
   git reset --hard origin/main
   ```
5. **Run the app before tagging.** The tag is what publishes. Launch the merged `main` in an isolated instance and ask the user to use it — see [docs/testing-a-pr.md](../../docs/testing-a-pr.md) and [docs/live-testing.md](../../docs/live-testing.md). Tag only once they confirm.
6. Tag the merged commit and push the tag alone (never `--tags`, which would push every local tag):
   ```bash
   git tag v{version} origin/main
   git push origin v{version}
   ```
   Pushing the tag starts `.github/workflows/build.yml`. Its `release-tag` job checks the tag shape, the `package.json` version and, for a final, the diff from the last beta; publish waits for it.
7. Watch the build: `gh run list --repo devsuitup/switchboard --workflow build.yml --limit 1`, then `gh run watch <id> --repo devsuitup/switchboard`. Its publish job creates a draft release (flagged pre-release for a beta), uploads the assets, and writes the release notes: the tag's `CHANGELOG.md` section, then a full-changelog compare link. It fails if that section is missing or empty. If `release-tag` failed, read its message: a final that differs from its beta needs a new beta, not a fix to the check.
8. Check that all 20 assets are on the draft (11 when macOS was not built) and its pre-release flag (`gh release view v{version} --repo devsuitup/switchboard --json assets,isPrerelease --jq '{assets: (.assets | length), isPrerelease}'`): `true` for a beta, `false` for a final. Check both `switchboard-doctly-{version}-x64.pacman` and `switchboard-doctly-{version}-aarch64.pacman`; verify that each Linux update manifest references its own package with matching size and hash. Upload any missing asset with `gh release upload v{version} <file> --clobber --repo devsuitup/switchboard`.
9. Keep the notes the workflow wrote: they are the changelog section the installed apps show in their What's new dialog, and the two must say the same thing. Check the body (`gh release view v{version} --repo devsuitup/switchboard --json body --jq .body`); a wording to change is changed in `CHANGELOG.md`, through a PR. If the notes step failed, add the missing section through a PR, then fill in the draft by hand: `node scripts/changelog-section.js v{version} > notes.md` on the merged `main`, and `gh release edit v{version} --repo devsuitup/switchboard --notes-file notes.md`.
10. **Beta:** publish the draft as a pre-release: `gh release edit v{version} --repo devsuitup/switchboard --draft=false --prerelease`. Then `gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name` must not contain `-`; if it does, re-flag that release `--prerelease` at once and mark the previous final `--latest`, then tell the user.
11. **Final**, only on the maintainer's go, after at least 24 hours of use on the last beta and with no open issue labelled `regression` for it. List the open regressions (`gh issue list --repo devsuitup/switchboard --state open --label regression --limit 1000`) and inspect which version each affects. Then steps 1–9 with `{X.Y.Z}`, and publish the draft as the latest release: `gh release edit v{X.Y.Z} --repo devsuitup/switchboard --draft=false --prerelease=false --latest`. `gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name` must print `v{X.Y.Z}`.

## Withdraw a stable release

On the maintainer's go, run `gh release edit v{version} --repo devsuitup/switchboard --prerelease`, then mark the previous stable release `--latest` (`gh release edit v{previous} --repo devsuitup/switchboard --latest`). Stable installs stop being offered the withdrawn version and new installs get the previous one; an install that already downloaded it still installs it at its next quit. Never downgrade an installed copy: the SQLite cache only migrates forward. Fix forward with a beta of the next version, then its final through the same gate. Beta installs can still receive the withdrawn release, now a pre-release.

If a build started from a wrong tag, cancel it (`gh run cancel <id> --repo devsuitup/switchboard`), delete the tag locally and on `origin`, and tag the merged commit.
