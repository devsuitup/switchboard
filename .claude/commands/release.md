Perform a release for this project, following [docs/releasing.md](../../docs/releasing.md). Always push with an explicit remote (`git push origin …`): a clone whose `main` tracks `upstream` would send a bare `git push` to `doctly/switchboard`.

Releases are tagged on `release/{X.Y}`; `main` never freezes and keeps taking PRs throughout. The branch model is in [docs/branching.md](../../docs/branching.md). A **beta** is cut from `main`: its bump branch starts at `origin/main` and its PR to `release/{X.Y}` is merged **with a merge commit**, so `main` stays an ancestor of the release branch. The **final** is cut from `release/{X.Y}` itself, because it may differ from the last beta only by version and changelog. After each release, a port-back PR from a branch at the tag to `main`, also merged with a merge commit, keeps `release/{X.Y}` an ancestor of `main`. Fixes reach a release line through the next beta cut from `main`; a cherry-picked `backport/…` PR to `release/{X.Y}` is for a fix that must ship while `main` carries something the line must not. Never squash a cut or a port-back, never push to `main` or `release/*` directly. `{base}` below is `origin/main` for a beta and `origin/release/{X.Y}` for a final; `{branch}` is `release/{X.Y}`. The one exception is the first beta of a new minor line: `{branch}` is `main` for its bump PR, and `release/{X.Y}` is then created at its tag (step 6). Never name a working branch `release/…`: the `release-protection` ruleset would match it.

Every version ships as one or more **betas** `v{X.Y.Z}-beta.{N}` (GitHub pre-releases, beta channel only), then a **final** `v{X.Y.Z}` rebuilt from a commit that differs from the last beta only by `package.json`, `package-lock.json` (their version fields) and `CHANGELOG.md`. CI refuses any other tag shape (`-rc.N` included) and, once a version has a beta tag, any other final; a final with no beta of its version is checked for shape and version only. Ask the user which one to cut when they do not say. `{version}` below is the full version, `0.1.0-beta.1` or `0.1.0`.

1. Find the most recent version tag with `git fetch origin --tags && git describe --tags --abbrev=0 origin/{branch}`, and read the commits since it: `git log {prev_tag}..{base} --format="%B---"`.
   - **Beta:** check that `git merge-base --is-ancestor origin/{branch} origin/main` succeeds; if it fails, the last port-back was squashed and step 2 merges `origin/{branch}` into the bump branch. Then check that every user-visible change among them has its entry under `## Unreleased` in `CHANGELOG.md` (the rule is in [docs/changelog.md](../../docs/changelog.md)); if one is missing, show the user the entry you would add and add it in the bump PR.
   - **Final:** `{prev_tag}` must be the last beta of this version, and the log must be empty: if anything was merged to `{branch}` since that beta, stop and cut a new beta instead. `## Unreleased` must be empty too.
2. Bump the version on a `bump/…` branch (the rulesets reject direct pushes to `main` and `release/*`):
   ```bash
   git checkout -b bump/v{version} {base}
   npm version --no-git-tag-version {version}   # package.json and package-lock.json, nothing else
   ```
   In `CHANGELOG.md`:
   - **Beta:** rename `## Unreleased` to `## v{version} — {today, YYYY-MM-DD}` and open a new, empty `## Unreleased` above it.
   - **Final:** fold every `## v{X.Y.Z}-beta.N` section into one `## v{X.Y.Z} — {today}` section (merge the entries by group, drop entries about problems only a beta had, delete the beta headings). Show the user the folded section before committing.

   Then `git diff origin/{branch} -- CHANGELOG.md`: every dated section older than the new one must be identical on both sides. An entry merged on `main` after the previous cut can sit under that cut's heading although the release does not contain it (the `#513` sandbox entry under `v0.1.0-beta.3`); move it to the new section.
   ```bash
   git commit -am "chore(release): v{version}"
   git merge origin/{branch}   # a beta only: "Already up to date." unless the last port-back was squashed; resolve on the bump side
   git push origin bump/v{version}
   ```
   Do **not** tag this commit: the merge commit is what lands on `{branch}`.
3. Open the PR and merge it once the required checks pass:
   ```bash
   gh pr create --repo devsuitup/switchboard --base {branch} --head bump/v{version} --title "chore(release): v{version}" --body-file <file>
   gh pr view bump/v{version} --repo devsuitup/switchboard --json headRefOid,mergeable,mergeStateStatus
   gh pr merge bump/v{version} --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
   ```
   Say in the body that the PR is merged with a merge commit, not a squash, and why. Never `--squash`. Wait until `gh pr view --repo devsuitup/switchboard bump/v{version} --json state,mergeCommit` reports `MERGED`; `{merged}` below is its `mergeCommit.oid`. If no check starts on a PR to `{branch}`, neither that branch nor the PR carries the `release/*` workflow triggers: backport them first, in a beta ("Release branches" in docs/releasing.md).
4. Fetch the merged commit: `git fetch origin`; `git rev-parse origin/{branch}` must print `{merged}` unless the branch moved since. No local branch needs to move; the tag names `{merged}`.
5. **Run the app before tagging.** The tag is what publishes. Launch `{merged}` in an isolated instance and ask the user to use it — see [docs/testing-a-pr.md](../../docs/testing-a-pr.md) and [docs/live-testing.md](../../docs/live-testing.md). Tag only once they confirm.
6. Tag the merged commit and push the tag alone (never `--tags`, which would push every local tag):
   ```bash
   git tag v{version} {merged}
   git push origin v{version}
   ```
   For the first beta of a new minor line, then cut its branch: `git push origin 'v{version}^{commit}:refs/heads/release/{X.Y}'`.
   Pushing the tag starts `.github/workflows/build.yml`. Its `release-tag` job checks the tag shape, the `package.json` version and, for a final, the diff from the last beta; publish waits for it.
7. Watch the build: `gh run list --repo devsuitup/switchboard --workflow build.yml --limit 1`, then `gh run watch <id> --repo devsuitup/switchboard`. Its publish job creates a draft release (flagged pre-release for a beta), uploads the assets, and writes the release notes: the tag's `CHANGELOG.md` section, then a full-changelog compare link. It fails if that section is missing or empty. If `release-tag` failed, read its message: a final that differs from its beta needs a new beta, not a fix to the check.
8. Check that all 20 assets are on the draft (11 when macOS was not built; both counts measured on v0.1.0-beta.3) and its pre-release flag (`gh release view v{version} --repo devsuitup/switchboard --json assets,isPrerelease --jq '{assets: (.assets | length), isPrerelease}'`): `true` for a beta, `false` for a final. Check both `switchboard-doctly-{version}-x64.pacman` and `switchboard-doctly-{version}-aarch64.pacman`; verify that each Linux update manifest references its own package with matching size and hash. Upload any missing asset with `gh release upload v{version} <file> --clobber --repo devsuitup/switchboard`.
9. Keep the notes the workflow wrote: they are the changelog section the installed apps show in their What's new dialog, and the two must say the same thing. Check the body (`gh release view v{version} --repo devsuitup/switchboard --json body --jq .body`); a wording to change is changed in `CHANGELOG.md`, through a PR to `{branch}`. If the notes step failed, add the missing section through a PR, then fill in the draft by hand: `node scripts/changelog-section.js v{version} > notes.md` on the merged `{branch}`, and `gh release edit v{version} --repo devsuitup/switchboard --notes-file notes.md`.
10. **Beta:** publish the draft as a pre-release: `gh release edit v{version} --repo devsuitup/switchboard --draft=false --prerelease`. Then `gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name` must not contain `-`; if it does, re-flag that release `--prerelease` at once and mark the previous final `--latest`, then tell the user.
11. **Final**, only on the maintainer's go, after at least 24 hours of use on the last beta and with no open issue labelled `regression` for it. List the open regressions (`gh issue list --repo devsuitup/switchboard --state open --label regression --limit 1000`) and inspect which version each affects. Then steps 1–9 with `{X.Y.Z}`, and publish the draft as the latest release (a final of a line older than the newest final takes `--latest=false` instead, and `releases/latest` must not change): `gh release edit v{X.Y.Z} --repo devsuitup/switchboard --draft=false --prerelease=false --latest`. `gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name` must print `v{X.Y.Z}`.
12. **Port the release back to `main`**, after every beta and final tagged on a release branch, from a branch created **at the tag**, merged **with a merge commit**:
   ```bash
   git fetch origin
   git checkout -b bump/port-back-v{version} v{version}
   git merge origin/main
   git push origin bump/port-back-v{version}
   gh pr create --repo devsuitup/switchboard --base main --head bump/port-back-v{version} --title "chore(release): port v{version} back to main" --body-file <file>
   gh pr merge bump/port-back-v{version} --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
   git fetch origin && git merge-base --is-ancestor origin/{branch} origin/main && echo ancestor
   ```
   On a `CHANGELOG.md` conflict, keep under `## Unreleased` the entries `main` took after the cut and the dated sections as the release branch has them (for a final, without the beta sections it folds); keep the release's version unless `main`'s is higher. Never cut the port-back branch from `main` and repeat the bump in it, and never squash it: #1293 did both, `release/0.1` stopped being an ancestor of `main`, and the next cut (#1312) came up conflicting. The last command must print `ancestor`.

## Withdraw a stable release

On the maintainer's go, run `gh release edit v{version} --repo devsuitup/switchboard --prerelease`, then mark the previous stable release `--latest` (`gh release edit v{previous} --repo devsuitup/switchboard --latest`). Stable installs stop being offered the withdrawn version and new installs get the previous one; an install that already downloaded it still installs it at its next quit. Never downgrade an installed copy: the SQLite cache only migrates forward. Fix forward with a beta of the next version, then its final through the same gate, both from that version's release branch. Beta installs can still receive the withdrawn release, now a pre-release.

If a build started from a wrong tag, cancel it (`gh run cancel <id> --repo devsuitup/switchboard`), delete the tag locally and on `origin`, and tag the merged commit.
