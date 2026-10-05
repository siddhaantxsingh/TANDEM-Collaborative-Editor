# ADR-006: Multi-node via Redis pub/sub, no sticky sessions

Status: accepted (2026-10).

## Decision
Every node can serve every document. Nodes exchange updates, presence and
sync requests through Redis channels; on loading a document a node
subscribes before reading the database and then asks peers for unpersisted
state; after Redis reconnects it re-requests. A durability sweep persists
anything only held in memory.

## Alternatives
* Sticky routing by document (consistent hashing): fewer messages, but
  needs a smarter load balancer and complicates failover.
* Database LISTEN/NOTIFY: payload size limits and extra database load.

## Consequences
+ Simple load balancing and failover (tested by killing nodes).
- Every node holding a document applies every update (CPU proportional to
  nodes × activity).
