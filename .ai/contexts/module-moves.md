# Module-move tooling

`scripts/move-modules.js` plans reference rewrites using `scripts/module-paths.js`.
The migration procedure and manual checks are in [docs/module-moves.md](../../docs/module-moves.md);
the layout is defined by [ADR 0005](../../docs/decisions/0005-main-process-context-layout.md).

Apply refuses pending source moves before scanning or writing. Check can list pending moves.
Every conflicting VM stub key is collected across the scan; any ambiguity prevents all writes.
Static `path.join` expressions are rewritten as a whole. Their trailing segments cannot fall
through to standalone filename rewriting, including dynamic or already-relocated joins.

Source reads associated with static joins are followed through local variable declarations.
Text consumed only by `indexOf`, slicing or `extract*` helpers is treated as an excerpt:
warn for manual review rather than infer stub mappings from the whole source module.
Full evaluations and unknown uses keep conservative ambiguity checking. This is syntactic
inference, not lexical scope or interprocedural analysis; computed loaders and separate VM
contexts still need review. Source-text literals containing quoted moved references warn
without changing their embedded assertions.

`test/move-modules.test.js` uses synthetic sources and disposable fixture trees so a migration
cannot rewrite its own fixture maps into identity maps. Run it after repeated apply/check in
a disposable repository archive when changing the scanner. Check exit 0 only proves that the
scanner has no supported rewrites or moves left; run the full suite after a real move.
