# Moving main-process modules

Follow [ADR 0005](decisions/0005-main-process-context-layout.md) and check open work before moving a context.
The preparatory source map is deliberately empty. For a viewer pilot, set `scripts/source-map.json` to:

```json
{
  "file-lists-path.js": "src/main/viewer/file-lists-path.js"
}
```

Create the destination directory and make a pure `git mv` commit first. Keep that commit's full SHA
for `.git-blame-ignore-revs`, then run:

```sh
node scripts/move-modules.js --check
node scripts/move-modules.js
node scripts/move-modules.js --check
```

The first check reports each pending reference and exits 1 until the references are rewritten.
Check mode never writes. Apply mode updates references only; it never moves files or runs git.
It plans all edits before writing and rejects invalid maps, renames and ambiguous VM stub mappings.
Keep the map for the move until verification finishes; a second apply must produce no changes.
Use `--root <repository>` to exercise a disposable copy without modifying the working checkout.

The scanner reads root JavaScript, workers, src, scripts, public, test (including fixtures), e2e,
and Markdown/JSON context documents under .ai and docs. It updates literal relative requires,
static `path.join(__dirname, ...)` and `path.join(ROOT, ...)` expressions, literal file paths and
VM stub specifiers inferred from the source files the test loads. Qualified documentation paths
change; bare filenames remain valid. It does not evaluate code or computed path expressions.
Review dynamic paths manually, especially interpolated worker paths and source strings inside tests.

Shrink `test/fixtures/root-app-modules.json` manually after a move. Root inventory equality rejects
both new root modules and stale allow-list entries. Run the resolver and affected tests, lint, the
full suite and CI checks prescribed by the ADR. No installation or native rebuild is needed to run
the codemod. Never copy writable node_modules into a disposable test checkout.
