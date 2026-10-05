# ADR-003: Acknowledge edits only after they are durable

Status: accepted (2026-10).

## Decision
The server broadcasts an update immediately (low latency) but acknowledges
it to its author only after the PostgreSQL INSERT commits. Failed writes are
retried with backoff and never acknowledged meanwhile.

## Consequences
+ "All changes saved" in the UI means committed to the database.
+ A crash between broadcast and write loses nothing: the author still holds
  the edit as unacknowledged and resends it through the sync handshake.
- Ack latency includes a database round trip (batched).
