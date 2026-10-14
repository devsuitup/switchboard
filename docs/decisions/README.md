# Architecture Decision Records

Short records of decisions with a real cost/benefit tradeoff behind them — the kind of thing that gets re-litigated ("why don't we just rewrite this in Go?") if it isn't written down once.

Format: lightweight — Status, Context, Decision, Consequences. No fixed template enforced; keep each record focused on one decision.

## Index

- [0001 — No full Go rewrite; Go backend sidecar only, if ever](0001-no-full-go-rewrite.md)
- [0002 — Steady-state indicator animations must be discrete (`steps()`), never smooth 60fps](0002-discrete-steps-sidebar-animations.md)
- [0003 — Deliver triggers under one tab lock and a per-write ownership check](0003-trigger-delivery-per-tab.md)
- [0004 — Update the session index incrementally through one writer and bind the display with deltas](0004-session-index-single-writer.md)
  - [Supporting study — session index reads, writes and display refreshes](0004-session-index-study.md), including local CLI title-record structure and read-then-write command inventory. The decision uses title-value changes for rename precedence, keeps unread in renderer memory, and separates projection parity (3a) from bounded delta transport (3b).
