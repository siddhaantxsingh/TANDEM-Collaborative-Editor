# Phase 0 — Architecture audit

Date: 2026-10-05. Written before any implementation code.

## Starting state

The repository was empty. There was no code, schema, protocol, test or
deployment to preserve, so the audit is a risk analysis of the system to be
built and the decisions taken to address each risk.

## Requirements distilled from the brief

* Real-time collaborative editing of code files by several users, with
  convergence and **no silently lost edits**; **no last-write-wins**.
* Explicit, versioned WebSocket protocol; reconnect; offline editing.
* PostgreSQL persistence with snapshots and an operation log.
* Presence (who is here, cursors/selections).
* Monaco-based UI with workspaces and a file tree.
* Authentication with hashed passwords; OWNER / EDITOR / VIEWER enforced on
  the server; never trust client-supplied roles.
* No arbitrary code execution on the server.
* Rate limiting, backpressure, single-node and multi-node (Redis pub/sub).
* Observability (logs, metrics, health live/ready), load, property, fuzz
  and chaos testing, Docker (non-root), CI, deployment and backup docs.

## Risks and decisions

| # | Risk | Decision |
| --- | --- | --- |
| 1 | Concurrent edits diverge or overwrite each other | Use a **CRDT** (Yjs, a mature sequence CRDT). Every replica converges regardless of delivery order; no LWW anywhere in document content. Own CRDT not written: correctness risk too high for no benefit (ADR-001). |
| 2 | Edits lost on disconnect / crash | Client persists its replica in IndexedDB; on reconnect, a state-vector handshake sends exactly the missing updates both ways. Server acknowledges an update only **after** it is committed to PostgreSQL; clients show "unsaved" until acked. |
| 3 | Unbounded op log | Append-only `doc_updates`; periodic compaction merges a prefix into a `doc_snapshots` row inside one transaction under an advisory lock. |
| 4 | Ad-hoc protocol bugs | Binary protocol with a version byte, typed messages, a single codec shared by client and server, strict validation of every field and size limits; fuzz-tested decoder. |
| 5 | Authorization bypass (client claims a role, viewer sends edits) | Role is looked up server-side on join and enforced on **every** incoming update; viewers' updates are rejected and never applied or broadcast; role changes are pushed to live connections. |
| 6 | Credential storage | `scrypt` (Node built-in) with per-password salt and constant-time compare; session tokens are random 256-bit values stored only as SHA-256 hashes. |
| 7 | CSRF / cross-site WebSocket hijacking | `SameSite=Lax` httpOnly cookie, `Origin` check on WebSocket upgrade and on state-changing HTTP requests. |
| 8 | Remote code execution | No "run code" feature on the server: there is no isolation that would make it safe here. The UI says so (ADR-007). |
| 9 | Abuse / overload | Token-bucket rate limits per connection (messages, bytes) and per IP (login); message size limit; per-document connection cap; backpressure: a client whose send buffer grows beyond a bound is disconnected and resynchronizes (nothing is dropped silently). |
| 10 | Horizontal scale | Each node keeps in-memory replicas only of documents with local clients; updates are fanned out through Redis pub/sub; any node may persist (Yjs updates are idempotent); compaction is serialized by a PostgreSQL advisory lock. Single-node mode needs no Redis. |
| 11 | Operability | JSON logs with request/connection ids, Prometheus-format `/metrics`, `/health/live` and `/health/ready` (DB and Redis). |
| 12 | Verifying convergence | Property tests with random concurrent edits, random message reordering/duplication and disconnects; load test checks every client converges to identical text and the database agrees; chaos tests restart the server and Redis mid-session. |

## Technology choices

TypeScript everywhere (shared protocol code between browser and server):
Node.js 22, `ws`, `pg`, `ioredis`, Yjs; React + Vite + Monaco + y-monaco +
y-indexeddb in the browser; Vitest + fast-check for tests; Playwright for an
end-to-end browser test; Docker multi-stage image running as a non-root
user; GitHub Actions with PostgreSQL and Redis service containers.

## Out of scope for this version

Code execution, language servers / IntelliSense across files, file
uploads, OAuth/SSO, end-to-end encryption, per-file permissions finer than
the workspace.
