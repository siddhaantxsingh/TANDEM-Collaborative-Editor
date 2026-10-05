# ADR-005: Authorization is decided and enforced only on the server

Status: accepted (2026-10).

## Decision
Roles are looked up from `memberships` on join, kept per connection, pushed on
change (also across nodes), and checked for every incoming update and sync
payload. The client's role is informational (read-only editor), never
trusted. Non-members receive "not found".

## Consequences
+ A modified client cannot write as a viewer (tested with a raw socket).
- Role changes cost one control message per affected connection.
