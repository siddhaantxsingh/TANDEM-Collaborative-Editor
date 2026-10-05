# Collaboration correctness

What Tandem guarantees about document state, how, and which test
demonstrates each guarantee. "Demonstrated" means: exercised by an automated
test that passes, with the inputs stated. It is evidence, not a proof; there
is no formal model of the server.

## Algorithm

Tandem uses **Yjs 13.6** (the YATA sequence CRDT), one `Y.Text("content")`
per document. It is not operational transformation, and there is no
last-write-wins anywhere in document content.

- Every inserted item has a unique id `(clientID, clock)` and stores the ids
  of its left and right neighbours at insertion time (its *origins*).
  Concurrent inserts at the same place are ordered deterministically by
  their origins and then by client id, so every replica that has the same
  set of items produces the same text.
- A delete marks items as deleted (a delete set of id ranges; tombstones).
  With `gc: true` the deleted content is dropped but the structure stays,
  so a late insert can still be placed and deleted text cannot come back.
- A replica's knowledge is its **state vector** (highest clock per client).
  Two replicas synchronise by exchanging state vectors and sending each
  other exactly the missing items (Sync1/Sync2); live edits travel as
  incremental updates.
- An update whose origins are not yet known is held as *pending* and
  integrated when they arrive.

### A Yjs liveness quirk, and the fix

Property testing found that plain `Y.applyUpdate` (Yjs 13.6.33) can leave
items pending **forever even though every dependency has arrived**, when
updates arrive out of causal order: the "missing" pointer of the pending
stash can refer to an item that is itself inside the stash. Minimal case
(`packages/protocol/test/crdt.test.ts`, "characterization"): replica 0
inserts three times, replica 1 once, replica 0 twice more; delivering the
six updates in the order 1, 3, 5, 0, 2, 4 shows `"xxx"` instead of
`"xxxxxx"`. Nothing is lost — the pending items are part of the encoded
state, and a fresh document built from it shows all six — but a live replica
(including the server's) would not display them until some later update
happened to unblock the stash.

Tandem applies every remote update with `applyUpdateHealing`
(`packages/protocol/src/client.ts`): after `Y.applyUpdate`, if structs are
still pending, the stash (`store.pendingStructs.update`, a V2-encoded
update) is applied once more with `Y.applyUpdateV2`; re-reading the stash
as a fresh update integrates every struct whose dependencies are present.
With it, the characterization case integrates all six items and
`tools/pending-check.ts` found no incomplete replica in 65,000 random cases
(plain apply: 506 incomplete).

`tools/pending-check.ts` measures how often the quirk occurs:
`docs/results/pending-check-2026-10-05.jsonl` (390 of 50,000 and 116 of
15,000 random delivery orders with plain apply; 0 with healing).

## Invariants

| # | Invariant | Mechanism | Demonstrated by |
| --- | --- | --- | --- |
| I1 | Concurrent valid operations converge | YATA ordering; every replica eventually has the same set of items | `crdt.test.ts` "all replicas converge" (300 random runs of 2–10 replicas, ≤80 ops, random order, 50% duplicates, 10% loss, then state-vector exchange; also asserts no pending structs remain); `convergence.test.ts` 12 randomized cases with 2/5/10 real clients on two nodes |
| I2 | Duplicate operations are idempotent | an item id is integrated at most once | `crdt.test.ts` idempotence (200 runs); `convergence.test.ts` "every document frame duplicated" |
| I3 | Out-of-order operations are handled safely | pending stash + `applyUpdateHealing`; deletes of unknown items wait in `pendingDs` | `crdt.test.ts` commutativity (300 runs) and "deleted text is never resurrected"; `convergence.test.ts` "every Update held back behind the next one"; server: regression P1 (a dependent update is stored before it is acknowledged) |
| I4 | Lost operations are recovered | **client:** an update not acknowledged within `ackTimeoutMs` (30 s) causes a reconnect, whose handshake resends everything the server lacks; a full state-vector resync every `resyncIntervalMs` (60 s). **server:** anti-entropy sweep (DB → in-memory replica, plus a SyncRequest to other nodes) and durability sweep (memory → DB) | `convergence.test.ts` "30% of document frames silently lost (no disconnect)" and the "lossy" profile; regression P4 (an edit lost on Redis pub/sub reaches the other node). Mutation check: with the ack timeout and periodic resync disabled, every lossy case fails |
| I5 | Reconnection restores the correct state | Sync1/Sync2 in both directions on every join; the server acks a client's Sync2 only after persisting it | `sync.test.ts` "stale replica catches up"; `convergence.test.ts` "kills+offline" profile (sockets killed at random); `tools/chaos.ts` reconnect storm and node kills; `tools/loadtest.ts --storm 1` |
| I6 | Offline edits are merged without silent loss | the browser keeps the replica in IndexedDB together with the last server-confirmed snapshot; anything beyond it is shown as unsaved and sent by the next handshake; large offline changes are fragmented (regression P5) | `sync.test.ts` "offline edits on both sides merge"; `convergence.test.ts` "10 clients insert at the same position while offline"; `e2e/offline.spec.ts` (reload while offline, browser restart while offline) |
| I7 | Presence failures never corrupt document state | awareness is a separate channel; the server validates it, rewrites the user identity, never applies it to the document | `convergence.test.ts` "presence garbage, spoofing and floods"; regression P3 |

**Durability rule:** an `Ack` (or the `seq 0` ack of a handshake) is sent
only after the update is committed to PostgreSQL. Updates the server cannot
integrate yet (missing dependencies) are stored raw before the ack
(regression P1). A client clears "unsaved" only on that ack.

**Scope of the claims.** Convergence is for replicas that eventually
exchange state (a partitioned client converges after the partition heals).
Text intent is preserved at character level; there is no semantic merge (two
users renaming the same identifier differently keep both edits). Ordering
of concurrent inserts at one position is deterministic but arbitrary.
Undo is per client.

## Fault model used by the tests

`packages/server/test/faultnet.ts` wraps a real WebSocket with a seeded
PRNG and can, per frame: delay (order-preserving), duplicate (Update, Sync2,
Ack), drop (same types), reorder (an Update held behind the next one), kill
the socket, or take the client offline. Every randomized test name includes
its seed, so a failure replays exactly. The randomized cases also assert that
the faults actually happened (e.g. drops > 0 in the lossy profile).

`tools/chaos.ts` adds process and infrastructure faults: TCP partition
(half-open sockets), added latency, reconnect storm, SIGKILL of nodes,
Redis restart, PostgreSQL outage. Results: `docs/PERFORMANCE.md`.
