# Fast pre-commit check

`scripts/check-fast.js` is the common entry point for `task check:fast` and
the hook's fallback when Task is absent. `SKIP_TESTS` with any nonempty value
skips tests, retaining staged-JS lint in both routes. `task check` and the full
suite runner remain unchanged and are the required gate before a PR.

The script reads `git diff --cached --name-only --diff-filter=ACMR -z`, so
deleted paths are excluded and spaces survive. The exported pure `selectTests`
maps a supplied staged list and test-directory inventory; filesystem discovery
uses regular files in `test/`, without shell globbing. It normalizes Windows
separators, selects staged test files themselves, matches ordinary basename
prefixes, adds `dom-` prefixes for `public/`, and sorts/deduplicates results.
Non-JS changes select nothing; unmatched JS still receives lint.

ESLint and tests run using `process.execPath`, without a shell. Selected tests
run one file per process using `--test --test-concurrency=1` and a 120-second
timeout, preserving the full runner's Node test invocation while bounding the
hook's work. Git, lint, spawn and test failures fail the check. The script
checks working-tree content for the staged paths, as conventional hooks do;
it does not reconstruct partially staged blobs. Naming matches are heuristic;
required CI and `task check` cover unrelated regressions.

`--files <file> ...` bypasses Git discovery for an honest timing run, retaining
real lint and test execution and leaving files and the index untouched.
`test/check-fast.test.js` exercises mapping, orchestration, errors and wiring;
external command spawning is replaced only at its process boundary.
