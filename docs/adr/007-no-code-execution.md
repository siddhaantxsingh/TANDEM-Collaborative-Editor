# ADR-007: No code execution on the server

Status: accepted (2026-10).

## Decision
The editor does not run user code. The Run button is present but disabled
with an explanation.

## Why
Executing untrusted code safely needs per-run isolation (micro-VM or
hardened container, no network, CPU/memory/time limits, no access to
secrets or other users' data) and operational care that this deployment does
not have. The brief forbids executing arbitrary code on the application
server without isolation.

## Future
A separate sandbox service (e.g. Firecracker or gVisor) with its own
threat model, never in the application server process.
