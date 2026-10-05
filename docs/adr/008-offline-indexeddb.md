# ADR-008: Offline editing through IndexedDB and state-vector sync

Status: accepted (2026-10).

## Decision
The browser keeps each document's Yjs state in IndexedDB (y-indexeddb). Edits
made offline accumulate locally; on reconnect the Sync1/Sync2 exchange sends
exactly what the server lacks; the UI shows "Offline — changes kept locally".

## Consequences
+ Edits survive reloads and network loss.
- A user who never reconnects from that browser never uploads those edits;
  local data is per browser profile and not encrypted at rest.
