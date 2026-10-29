# Module-move tooling

`scripts/move-modules.js` plans reference rewrites using `scripts/module-paths.js`.
The migration procedure and manual checks are in [docs/module-moves.md](../../docs/module-moves.md);
the layout is defined by [ADR 0005](../../docs/decisions/0005-main-process-context-layout.md).

Apply refuses pending source moves before scanning or writing. Check can list pending moves.
Every conflicting VM stub key is collected across the scan; any ambiguity prevents all writes.
Static `path.join` expressions are rewritten as a whole. Their trailing segments cannot fall
through to standalone filename rewriting, including dynamic or already-relocated joins.
Skipped segments naming a moved key or basename warn with their file and line for manual review.
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
