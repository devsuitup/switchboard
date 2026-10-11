# Product model

This folder describes Switchboard **as a user meets it**: its concepts, their
names, their states, the actions on them, and the rules that tie them together.
It describes the product as it is at the version named in each file, not as it
should be. Where the product is inconsistent, these files say so and point to
the finding; they do not paper over it.

| File | What it holds | Owner |
|---|---|---|
| [GLOSSARY.md](GLOSSARY.md) | One entry per user-facing concept: canonical name, one-sentence definition, words not to use, the code identifiers that implement it | product model |
| [CONCEPT-MAP.md](CONCEPT-MAP.md) | One section per concept: states (exact UI words), actions and their exact labels per surface, where it appears (`file:line`), the rules between concepts, and the known incoherences | product model |
| [UI-PATTERNS.md](UI-PATTERNS.md) | How a concept is shown and acted on: the recurring UI shapes | interface patterns |
| [BUILDING-BLOCKS.md](BUILDING-BLOCKS.md) | The reusable UI pieces those patterns are built from | interface patterns |

## Rules

- **Every new issue names the concept it extends**, by its glossary name. An
  issue that needs a concept the glossary does not have justifies it in the
  issue, and the glossary and the map are updated in the same PR as the
  feature.
- A user-facing word that is not in the glossary is either added (with a
  reason) or replaced by the glossary's word.
- A change to a state name, an action label or a rule between concepts updates
  CONCEPT-MAP.md in the same PR.
- Every claim carries evidence (`file:line`, a UI string, a doc line). A claim
  that was inferred and not read in the code is marked **supposed**.
- `file:line` references are valid for the version named at the top of each
  file. They drift; re-anchor them when a section is touched.

## Where the findings come from

The "Known incoherences" in CONCEPT-MAP.md come from the product-coherence
audit of v0.0.94 (2026-10-11). Its finding numbers (M1–M6 major, m1–m8 minor)
are reused here so an issue can cite them. The audit report itself is a working
file, not versioned; the list in CONCEPT-MAP.md is the versioned summary.
