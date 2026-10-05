<div align="center">
<h1>Tandem</h1>

<h3>A fault-tolerant, offline-first real-time collaborative code editor.</h3>

<p>
<img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black">
<img src="https://img.shields.io/badge/Monaco-Editor-007ACC?style=for-the-badge">
<img src="https://img.shields.io/badge/Yjs-CRDT-7B2CBF?style=for-the-badge">
<img src="https://img.shields.io/badge/WebSocket-Protocol-111111?style=for-the-badge">
<img src="https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white">
<img src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white">
</p>
**Concurrent editing · offline-first · durable acknowledgements ·
multi-node synchronization · failure recovery**
</div>

------------------------------------------------------------------------

## ✦ The problem

Real-time collaborative editing is deceptively hard.

A demo can synchronize two textareas with a WebSocket in an afternoon.

A useful collaboration system must answer much harder questions:

-   What happens when two users edit the same position?
-   What if messages arrive twice?
-   What if they arrive out of order?
-   What if a client goes offline for ten minutes?
-   What if the server acknowledges an edit and then crashes?
-   What if PostgreSQL is unavailable?
-   What if Redis restarts?
-   What if a node dies during a rolling deployment?
-   What if 1,000 clients reconnect simultaneously?

**Tandem is built around those questions.**

------------------------------------------------------------------------

## 🖥️ Product

![Tandem collaborative editor](docs/screenshot.png)

Tandem provides:

-   Monaco editor
-   file tree and tabs
-   multi-user editing
-   remote cursors
-   presence avatars
-   workspaces
-   OWNER / EDITOR / VIEWER roles
-   offline editing
-   reconnect and state-vector synchronization
-   durable persistence
-   multi-node server architecture

There is intentionally **no server-side code execution**. The project
does not pretend an unsafe `child_process` feature is a sandbox.

------------------------------------------------------------------------

## 🧭 Architecture

``` mermaid
flowchart LR
    A["Browser A<br/>React + Monaco + Yjs"] <-->|"WebSocket v2"| N1["Node A"]
    B["Browser B<br/>React + Monaco + Yjs"] <-->|"WebSocket v2"| N2["Node B"]

    N1 <--> R["Redis Pub/Sub"]
    N2 <--> R

    N1 --> P["PostgreSQL"]
    N2 --> P

    A --> IA["IndexedDB"]
    B --> IB["IndexedDB"]
```

### What belongs where?

  State                   System               Why
  ----------------------- -------------------- --------------------------
  Document state          Yjs / PostgreSQL     correctness + durability
  Snapshots               PostgreSQL           bounded replay
  Append-only updates     PostgreSQL           durable synchronization
  Presence                memory / Redis       ephemeral
  Local offline replica   IndexedDB            survive reload/restart
  Cross-node relay        Redis                node-to-node propagation
  Auth/session limits     PostgreSQL + Redis   shared security state

------------------------------------------------------------------------

## 🧬 Collaboration algorithm

``` mermaid
sequenceDiagram
    participant C as Client
    participant W as WebSocket Node
    participant DB as PostgreSQL
    participant P as Peers

    C->>W: Yjs update
    W->>W: Validate + authorize
    W->>DB: Persist update
    DB-->>W: COMMIT
    W-->>C: ACK
    W-->>P: Relay update
    P-->>P: Apply CRDT update
```

### The durability invariant

> **ACK means PostgreSQL commit.**

Not:

> "The server received the packet."

This is encoded in the architecture and tested during database-outage
scenarios.

------------------------------------------------------------------------

## 🔄 Offline-first synchronization

``` mermaid
stateDiagram-v2
    [*] --> Connected
    Connected --> Editing: local edit
    Editing --> Connected: persist + relay
    Connected --> Offline: socket lost
    Offline --> OfflineEditing: local edits
    OfflineEditing --> Reconnecting: network returns
    Reconnecting --> Syncing: state-vector handshake
    Syncing --> Connected: missing state merged
    Syncing --> Reconnecting: retry
```

Every document replica can survive:

-   socket loss
-   browser reload
-   browser restart
-   temporary server failure

Reconnect uses a state-vector synchronization path rather than replacing
the local document with a stale server copy.

------------------------------------------------------------------------

## 🧠 Why CRDT?

Tandem uses **Yjs / YATA**, not last-write-wins document replacement.

The system explicitly exercises:

-   convergence
-   idempotence
-   commutativity
-   duplicate delivery
-   reordering
-   dropped frames
-   delayed frames
-   stale replicas
-   offline edits
-   reconnect storms

The hardening pass also found a Yjs liveness edge case where pending
items could remain despite their dependencies arriving. A healing apply
is used consistently, and the regression is covered by tests.

------------------------------------------------------------------------

## 🌐 Multi-node design

``` mermaid
flowchart TB
    LB["nginx / load balancer"]
    LB --> N1["Node 1"]
    LB --> N2["Node 2"]

    N1 <--> R["Redis"]
    N2 <--> R

    N1 --> DB["PostgreSQL"]
    N2 --> DB

    DB --> S["Snapshots + Append-only Update Log"]
```

The collaboration nodes are designed to be stateless with respect to
durable document history.

Two-node correctness was tested with Redis relay and shared PostgreSQL.

**Horizontal throughput scaling was not claimed** because both nodes and
the generator shared the same 2-vCPU machine.

------------------------------------------------------------------------

## 🛡️ Security model

Server-side authorization is enforced on HTTP endpoints and WebSocket
joins/updates.

Included:

-   OWNER / EDITOR / VIEWER authorization
-   IDOR protection
-   privilege-escalation tests
-   scrypt password hashing
-   hashed session tokens
-   `httpOnly` cookies
-   CSRF protection
-   cross-site WebSocket origin checks
-   strict CSP
-   rate limiting
-   message and queue limits
-   protected metrics
-   audit logging
-   request IDs
-   graceful shutdown
-   no code execution

### Deliberate security decision

``` text
"Run Code"
     │
     ▼
No safe sandbox available
     │
     ▼
FEATURE DISABLED
```

This is a security feature, not a missing TODO.

------------------------------------------------------------------------

## 🧪 Correctness & failure matrix

  Scenario                       Result
  ------------------------------ --------------------------------------
  Concurrent edits               Converged
  Duplicate frames               Idempotent
  Reordered frames               Converged
  30% silent loss                Recovered via resync
  Offline edits                  Recovered and merged
  1,000-client reconnect storm   All rejoined and converged
  Node SIGKILL                   Recovered
  Redis restart                  Recovered
  PostgreSQL outage              Acks withheld; edits later committed
  Rolling restart                Converged + durable
  Backup / restore               31/31 documents restored

The final hardening pass recorded **88/88 Vitest tests** and **3/3
browser E2E scenarios** passing.

------------------------------------------------------------------------

## 📊 Load testing

All results below are from the recorded 2026-10-05 runs on a **2-vCPU
VM** shared by the server, databases, Redis, nginx where applicable, and
load generator.

### Healthy operating range

At **100 fully active clients**:

-   ≈191 edits/s achieved
-   propagation p99: **95.8 ms**
-   durable ACK p99: **118 ms**
-   server CPU: **19.2%**
-   peak RSS: **119 MiB**

### 1,000 connected / 100 editing

-   ≈193 edits/s
-   propagation p99: **28.4 ms**
-   durable ACK p99: **62 ms**
-   peak RSS: **124 MiB**

### Reconnect storm

At 1,000 simultaneous reconnects:

-   all clients rejoined in ≤ **3.0 s**
-   all offline edits saved + converged in ≤ **3.3 s**

### Important interpretation

At 500--1,000 fully active clients, the load generator saturated the
shared 2-vCPU machine. Those rows demonstrate **correctness under
overload**, not server capacity.

------------------------------------------------------------------------

## 💥 Chaos testing

``` mermaid
flowchart LR
    A["Healthy cluster"] --> B["Inject partition"]
    B --> C["Inject latency"]
    C --> D["Drop / reorder traffic"]
    D --> E["SIGKILL node"]
    E --> F["Restart node"]
    F --> G["Redis restart"]
    G --> H["PostgreSQL outage"]
    H --> I["Heal faults"]
    I --> J["Verify convergence"]
    J --> K["Verify database == replicas"]
```

Recorded chaos:

-   2 runs
-   8 clients
-   2 nodes
-   network partition
-   200 ms latency injection
-   reconnect storm
-   node SIGKILL
-   Redis restart
-   PostgreSQL outage

Across the recorded runs:

> **11,800 inserts · 0 missing · 0 duplicated · converged · DB matched**

------------------------------------------------------------------------

## 🚀 Deployment

The deployment stack includes:

``` text
nginx
  │
  ├── Node 1
  └── Node 2
       │
       ├── Redis
       └── PostgreSQL
```

The production-style smoke test covers:

-   19 deployment checks
-   non-root image
-   read-only root filesystem
-   dropped capabilities
-   health endpoints
-   CSP
-   cookie flags
-   CSRF
-   cross-origin WebSocket rejection
-   IDOR
-   authenticated edit
-   rolling restart
-   backup + restore

The recorded image used a local stand-in for the official Node base
because Docker Hub was blocked in the validation environment. This is
explicitly documented and not presented as an official-base
verification.

------------------------------------------------------------------------

## 🧰 Quick start

``` bash
npm ci
npm run build
npm run typecheck
npx vitest run
npx playwright test
```

Docker:

``` bash
docker compose up --build
```

Useful tools:

``` bash
tools/loadmatrix.sh
tools/chaos.ts
tools/deploy-smoke.sh
tools/pending-check.ts
```

------------------------------------------------------------------------

## 📚 Documentation

  ------------------------------------------------------------------------------------------------
  Area                                Link
  ----------------------------------- ------------------------------------------------------------
  Architecture                        [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

  Protocol                            [`docs/PROTOCOL.md`](docs/PROTOCOL.md)

  Correctness                         [`docs/CORRECTNESS.md`](docs/CORRECTNESS.md)

  Security                            [`docs/SECURITY.md`](docs/SECURITY.md)

  Testing                             [`docs/TESTING.md`](docs/TESTING.md)

  Performance                         [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)

  Deployment                          [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

  Audits                              [`docs/ARCHITECTURE_AUDIT.md`](docs/ARCHITECTURE_AUDIT.md) ·
                                      [`docs/HARDENING_AUDIT.md`](docs/HARDENING_AUDIT.md) ·
                                      [`docs/FINAL_AUDIT.md`](docs/FINAL_AUDIT.md)

  ADRs                                [`docs/adr/`](docs/adr/)
  ------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 🚧 Honest limitations

Not claimed:

-   real production traffic
-   horizontal throughput scaling
-   external penetration testing
-   MFA/password recovery
-   end-to-end encryption
-   semantic conflict detection
-   code execution
-   formal verification

The project's correctness claims are **test-backed guarantees**, not
formal proofs.

------------------------------------------------------------------------

<div align="center">
### A collaborative editor is easy to demo.

### Tandem is about making collaboration converge, persist, recover, and survive failure.
</div>
