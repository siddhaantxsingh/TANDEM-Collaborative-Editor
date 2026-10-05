# ADR-002: An explicit, versioned binary protocol instead of y-websocket

Status: accepted (2026-10).

## Decision
Own message set (Join/Joined/Leave, Sync1/Sync2, Update with sequence numbers,
Ack, Awareness, Error, RoleChanged, Ping/Pong), multiplexed channels, version
byte on every frame, one codec shared by client and server, strict
validation.

## Why not y-websocket as is
It has no acknowledgements tied to durability, no per-message authorization,
no explicit error model, and one socket per document.

## Consequences
+ The client can show "saved" truthfully; the server can reject edits per
  role; the decoder is fuzzable.
- More code to maintain than the stock provider.
