#!/usr/bin/env bash
set -e

# A published release is never overwritten; a missing one is created below.
is_draft="$(gh release view "${GITHUB_REF_NAME}" --json isDraft --jq .isDraft 2>/dev/null || true)"
if [ "$is_draft" = false ]; then
  echo "::error::release ${GITHUB_REF_NAME} is already published; refusing to overwrite its assets"
  exit 1
fi
# Create the draft once. Tolerate "already exists" so a re-run after a
# partial failure still proceeds to (re-)upload the assets.
gh release create "${GITHUB_REF_NAME}" \
  --draft \
  --title "${GITHUB_REF_NAME#v}" \
  --notes "" \
  || echo "release already exists — proceeding to asset upload"
# Upload each asset individually with retries. A single whole-batch
# `gh release create ... dist/*` aborts entirely when uploads.github.com
# returns an intermittent 401 on one asset (typically a .blockmap),
# leaving a partial release. Per-file + retry makes publishing reliable.
rc=0
for f in "${DIST_DIR:-dist}"/*; do
  [ -f "$f" ] || continue
  ok=0
  for i in 1 2 3 4 5; do
    if gh release upload "${GITHUB_REF_NAME}" "$f" --clobber; then ok=1; break; fi
    echo "::warning::upload $(basename "$f") attempt $i failed; retrying in ${RETRY_DELAY:-10}s"
    sleep "${RETRY_DELAY:-10}"
  done
  if [ "$ok" != 1 ]; then echo "::error::failed to upload $(basename "$f") after retries"; rc=1; fi
done
exit $rc
