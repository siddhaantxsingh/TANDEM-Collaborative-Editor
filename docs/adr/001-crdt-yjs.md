# ADR-001: Use a CRDT (Yjs) for document state

Status: accepted (2026-10).

## Context
Concurrent edits must converge without losing anybody's changes; the brief
forbids last-write-wins and prefers a CRDT.

## Decision
Yjs (YATA sequence CRDT) for document text, with its binary update format as
the unit of synchronization and persistence.

## Alternatives
* Operational transformation: needs a central sequencer and transformation
  functions that are notoriously hard to get right; offline editing is harder.
* Own CRDT: high correctness risk; no benefit for this project.
* Automerge: comparable guarantees; Yjs has a mature Monaco binding and
  awareness protocol.

## Consequences
+ Convergence for any delivery order, duplicates harmless, offline natural.
- Tombstones make documents grow with history (mitigated by Yjs GC and
  compaction); the server must validate updates it cannot "understand".
