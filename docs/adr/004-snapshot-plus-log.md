# ADR-004: Snapshot + append-only log with idempotent compaction

Status: accepted (2026-10).

## Decision
`doc_updates` is an append-only log; compaction merges the snapshot and the
log rows it read into a new snapshot and deletes exactly those rows, under a
per-document advisory lock. Loading reads the snapshot and all remaining
rows.

## Why not filter by sequence number
Sequence values are assigned before commit; a row with a lower value can
become visible after a higher one, so `seq > last_seq` can skip committed
data (found in review, regression-tested). Re-applying a row already in the
snapshot is harmless because Yjs updates are idempotent.
