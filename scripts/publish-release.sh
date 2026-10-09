#!/usr/bin/env bash
set -e

# see docs/releasing.md
if ! draft="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --jq ".[] | select(.tag_name == \"${GITHUB_REF_NAME}\") | .draft")"; then
  echo "::error::could not read the releases of ${GITHUB_REPOSITORY}; refusing to publish blind"
  exit 1
fi
case "$draft" in
  "")
    gh release create "${GITHUB_REF_NAME}" \
      --draft \
      --title "${GITHUB_REF_NAME#v}" \
      --notes ""
    ;;
  true) echo "draft ${GITHUB_REF_NAME} already exists; proceeding to asset upload" ;;
  *$'\n'*) echo "::error::more than one release carries ${GITHUB_REF_NAME}; refusing to pick one"; exit 1 ;;
  *) echo "::error::release ${GITHUB_REF_NAME} is already published; refusing to overwrite its assets"; exit 1 ;;
esac
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
