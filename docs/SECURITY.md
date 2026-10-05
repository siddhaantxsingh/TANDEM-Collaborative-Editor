# Security

## Threat model

Attackers: anonymous internet users, authenticated users exceeding their
role, malicious web pages visited by logged-in users, malformed or flooding
clients. Out of scope: a compromised server or database host.

## Controls

| Threat | Control | Evidence |
| --- | --- | --- |
| Password theft from the database | scrypt (N=2^15, r=8, p=1, 16-byte salt), constant-time compare; login timing equalized with a dummy hash for unknown emails | `auth.test.ts` (hash format, salts differ, no plaintext stored) |
| Session theft from the database | tokens are 256-bit random values; only SHA-256 hashes are stored; expiry enforced in SQL | `auth.ts` |
| Brute force | per-IP and per-email limits on login, per-IP limit on registration; **shared across nodes through Redis** (fixed window, `MULTI INCR`+`PEXPIRE`), falling back to a local limiter if Redis is unavailable | `auth.test.ts` (429 after repeated failures), `security.test.ts` "login attempts are counted across nodes" |
| Spoofed client address | `TRUST_PROXY=true` (only behind the shipped nginx) takes the **last** `X-Forwarded-For` entry, the one the proxy appended; otherwise the header is ignored | `security.test.ts` "TRUST_PROXY" |
| CSRF | `SameSite=Lax` httpOnly cookie **and** `Origin` check on every state-changing request | `auth.test.ts` (cross-origin POST → 403) |
| Cross-site WebSocket hijacking | `Origin` check on the upgrade | `auth.test.ts` (foreign origin → 403) |
| Privilege escalation via the client | roles never come from the client: looked up on join, pushed on change; every update checked; viewers' updates and non-empty sync payloads rejected before applying | `auth.test.ts` (raw-socket viewer sends Update and Sync2: rejected, not stored, not broadcast) |
| Stale permissions | role changes and removals are broadcast (also across nodes) and applied to live connections immediately | `auth.test.ts`, `multinode.test.ts` |
| IDOR / enumeration | every endpoint looks up the caller's role for the *target* resource; "not found" for both missing and inaccessible workspaces/documents/members; WebSocket `Join` answers NotFound alike | `security.test.ts` authorization matrix: every endpoint × {owner, editor, viewer, non-member, anonymous} × {own workspace id, another workspace's id}; WebSocket join refusal |
| Presence impersonation | server rewrites the user identity in awareness states; a connection may only set its own client ids (max 4) | `sync.test.ts` |
| Malformed input | strict protocol decoder (fuzzed); Yjs updates structurally validated before applying; JSON body size limit; path validation (no `..`, absolute paths, control characters) | `codec.test.ts`, `limits.test.ts`, `auth.test.ts` |
| Denial of service | per-connection message, byte and **document-operation** rate limits; frame/document size limits; byte- and count-bounded inbound queue; flow-controlled outbound queue with per-socket and global budgets; reassembly budget; handshake timeout; channel and per-document connection caps; server-wide connection cap; HTTP timeouts | `limits.test.ts`, `regressions.test.ts` (operation rate, inbound bytes, handshake timeout) |
| Accountability | `audit_log` table: register, login, failed login, logout, workspace create, member add/role change/remove, document create/rename/delete (actor, target, IP, request id); membership changes written in the same transaction; readable by workspace owners at `GET /api/workspaces/:id/audit` | `security.test.ts` "audit log" |
| Information leakage via metrics | `/metrics` requires `Authorization: Bearer $METRICS_TOKEN` when set, otherwise only loopback requests; nginx does not expose it | `security.test.ts` "metrics need the bearer token" |
| Stale sessions | expired sessions deleted every `SESSION_CLEANUP_MS` (1 h) | `security.test.ts` "expired sessions are deleted" |
| XSS | React escaping; strict `Content-Security-Policy` (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`; user names rendered as text, presence colors validated | `http.ts` |
| **Remote code execution** | **There is no code execution feature.** Running user code safely needs strong isolation (separate VM/container per run, no network, CPU/memory/time limits, no secrets), which this deployment does not provide; the Run button is disabled and explains why | ADR-007 |

## Not provided (known gaps)

* No email verification, password reset or MFA.
* No end-to-end encryption: the server sees document content.
* TLS is expected to be terminated by the load balancer; set
  `COOKIE_SECURE=true` and `ALLOWED_ORIGINS` in production.
* WebSocket message/operation rate limits are per connection (by design);
  a user may open several connections, bounded by `MAX_CONNECTIONS_PER_DOC`
  and the server-wide cap.
* Secrets come from the environment (`.env`, never committed; compose refuses
  to start without `POSTGRES_PASSWORD`). There is no secret manager
  integration.
* No external penetration test or dependency audit beyond `npm audit` was
  performed.
