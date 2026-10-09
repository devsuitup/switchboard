# Releasing

A release is a version tag on `main`. The version bump lands through a pull
request first, because `main` is protected.

## Steps

1. **Bump the version and date the changelog** on a branch, and open the PR.
   In [`CHANGELOG.md`](../CHANGELOG.md) (see [Changelog](changelog.md)),
   rename `## Unreleased` to `## v0.1.0 — <today, YYYY-MM-DD>`, and open a new,
   empty `## Unreleased` above it. Read the section once more: it becomes the
   release notes as it stands.

   ```bash
   git checkout -b release/v0.1.0 origin/main
   npm version --no-git-tag-version 0.1.0   # package.json and package-lock.json
   # edit CHANGELOG.md as above
   git commit -am v0.1.0
   git push origin release/v0.1.0
   gh pr create --repo devsuitup/switchboard --base main --title v0.1.0 --fill
   ```

   `test/changelog.test.js` fails when `CHANGELOG.md` has no section for the
   version in `package.json`, so a bump without its section does not pass CI.

   The `main-protection` ruleset requires the checks `lint`,
   `test (20, ubuntu-latest)`, `test (20, windows-2022)`, `test (22, ubuntu-latest)`,
   `test (22, windows-2022)` and `changelog`, and no approving review, so
   `gh pr merge --auto --squash` can be armed as soon as the checks run.

2. **Run the app before tagging.** The tag is what publishes, and nothing
   between the merge and the tag looks at the assembled whole; the test suite
   does not see layout, a control drawn in the wrong colour, or raw tool output
   in a locale. Launch the merged `main` in an isolated instance and use it — see
   [Testing a PR live](testing-a-pr.md) and
   [Live testing with a throwaway HOME](live-testing.md).

3. **Tag the merged commit** and push the tag:

   ```bash
   git fetch origin
   git tag v0.1.0 origin/main
   git push origin v0.1.0
   ```

4. **Wait for the build.** The tag starts `.github/workflows/build.yml`: macOS
   (macos-14), Windows (windows-2022), and Linux x64 and arm64 on separate
   runners. Its publish job then:
   - creates a **draft** release named after the version;
   - uploads each artifact separately, retrying each up to five times — 19
     assets for a full build (dmg, zip and their blockmaps for arm64 and x64; the
     Windows installer and its blockmap; two AppImages, two debs, one pacman
     package; four `latest*.yml` update manifests);
   - writes the release notes: the text of the tag's `CHANGELOG.md` section,
     without its heading (`scripts/changelog-section.js`), then a **Full
     changelog** link comparing the previous tag with this one. It fails
     rather than publish an empty body when the section is missing or empty.
     The fix is then in `CHANGELOG.md`, through a PR; `gh release edit
     --notes-file` can fill in the draft by hand meanwhile.

   Re-running CI while the release is a draft is fine: it completes or replaces
   the draft's assets. CI refuses to publish if it cannot read the releases,
   and never writes to a published release. Once published, add or replace an
   asset by hand with `gh release upload --clobber` (see below), or tag a new
   version. Delete the draft or move the tag only while the release is still a
   draft. The workflow token has `contents: read`; only the publish job has
   `contents: write`, and no checkout persists credentials.

5. **Publish the draft**, after checking its assets:

   ```bash
   gh release view v0.1.0 --repo devsuitup/switchboard --json assets --jq '.assets | length'
   gh release edit v0.1.0 --repo devsuitup/switchboard --draft=false --latest
   ```

   Installed copies with automatic updates on pick the release up from its
   `latest*.yml` manifests; a draft is invisible to them. On their first start
   after the update, the What's new dialog shows this section, and those of
   any version they skipped.

`npm run release` builds for the local platform only and publishes through
electron-builder; it needs `GH_TOKEN` (a token with `repo` scope).

## Fork release-flow gotchas

- **Push with an explicit remote.** A clone whose `main` tracks `upstream`
  (`doctly/switchboard`) sends a bare `git push` there, which fails on
  permissions. `git push origin …` always targets the fork.
- **Direct pushes to `main` are rejected** by the ruleset: the bump goes through
  a PR.
- **Tag the merged commit, never the local bump commit.** A squash merge makes
  a new commit; a tag on the pre-merge commit is not an ancestor of `main`, so
  `git describe --tags` and the release-notes range skip it. If a build already
  started from such a tag, cancel it (`gh run cancel`), delete the tag locally
  and on `origin`, and tag the merged commit.
- **Unsigned macOS builds need `"mac": {"identity": null}` and
  `"notarize": false` in `package.json`.** electron-builder reads a `CSC_LINK`
  that is set but empty as a certificate path; `stat('')` resolves to the
  working directory, and the mac job fails with `… not a file` on tag builds
  only. Setting `CSC_IDENTITY_AUTO_DISCOVERY` according to whether the secret
  exists does not avoid it; `identity: null` does.
- **A single asset upload can fail with a 401** from `uploads.github.com`
  (often a `.blockmap`). The workflow retries each file; if one is still
  missing, upload it by hand:
  `gh release upload v0.1.0 <file> --clobber --repo devsuitup/switchboard`.
