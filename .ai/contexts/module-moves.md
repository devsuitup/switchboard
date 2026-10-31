# Module-move tooling

`scripts/move-modules.js` plans reference rewrites using `scripts/module-paths.js`.
The migration procedure and manual checks are in [docs/module-moves.md](../../docs/module-moves.md);
the layout is defined by [ADR 0005](../../docs/decisions/0005-main-process-context-layout.md).

Apply refuses pending source moves before scanning or writing. Check can list pending moves.
Every conflicting VM stub key is collected across the scan; any ambiguity prevents all writes.
Static `path.join` expressions are rewritten as a whole. Their trailing segments cannot fall
through to standalone filename rewriting, including dynamic or already-relocated joins.
Skipped segments naming a moved key or basename warn with their file and line for manual review.
Root/dirname joins resolving to unmapped subdirectory modules with a moved basename are also
excluded from rewriting and VM loader inference when their consumer stays in place. A moved
consumer keeps relative rewrites to unmapped files, including workers with the same basename;
`ROOT` anchors retain the root-relative target. Bare moved basenames in standalone literals
(including renderer filename arrays) warn and stay unchanged when another unmapped scanned
file shares the basename. Exact move-map keys and destinations remain supported.
Move maps are copied to null-prototype objects at both public entry points; inherited object
properties never name moves. The scanner excludes its own script and `module-paths.js`.

Source reads associated with static joins are followed through local variable declarations.
Text consumed only by `indexOf` or partial slicing is treated as an excerpt. Warn only when
that source requires a moved module or a key stubbed by the test, resolving rewritten requires
from the source's current location. A sole literal-zero argument
to `slice` or `substring` preserves a full load; unknown `extract*` helpers remain full loads
unless their result is demonstrably excerpted at the call site.
Full evaluations and unknown uses keep conservative ambiguity checking. This is syntactic
inference, not lexical scope or interprocedural analysis; computed loaders and separate VM
contexts still need review. Strings, regex patterns (with escaped punctuation decoded), and
cooked template elements containing quoted moved references warn without changing their
embedded assertions.

`test/move-modules.test.js` uses synthetic sources and disposable fixture trees so a migration
cannot rewrite its own fixture maps into identity maps. Run it after repeated apply/check in
a disposable repository archive when changing the scanner. Check exit 0 only proves that the
scanner has no supported rewrites or moves left; run the full suite after a real move.

Check mode also validates `.git-blame-ignore-revs`: every full SHA must be an ancestor commit
of HEAD or any parent recorded in MERGE_HEAD during a merge, and the last entry (newest move)
must contain only R100 renames with 0/0 numstat. Resolve MERGE_HEAD through Git's per-worktree
path so conflicted merges and multiple incoming parents use the correct history boundary.
It uses Git 2.24-compatible commands. Shallow checkouts, archives without `.git`, and missing Git
print a clear history-validation `SKIP`. The test suite calls the exported `checkBlameIgnore`
on the actual repository root; the full-history CI matrix validates the real entries after rebases.
Malformed or abbreviated entries report that a full 40-hex SHA is required (exit 1); Git command
errors, including failed `git show` reads, report history-validation failures separately (exit 2).
Reachability status 1 is a bad entry; spawn errors (including ENOENT/timeouts), signal termination
and merge-base statuses other than 0/1 throw, producing exit 2 rather than a stale-entry warning.
Both history validation and fixture Git commands strip inherited `GIT_*` and `HUSKY*` variables
to prevent pre-commit environment state from redirecting their repository or index.
Refresh entries after rebases and prefer merging main, as documented in the move procedure.
