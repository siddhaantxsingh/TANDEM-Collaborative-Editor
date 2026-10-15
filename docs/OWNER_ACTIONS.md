# Owner actions

Things only the repository owner can do (accounts, secrets, hardware).

## 1. Build and run the Docker stack locally (not verified in the audit: disk full)

```bash
cp .env.example .env            # set POSTGRES_PASSWORD and METRICS_TOKEN to long random values
docker compose up --build -d
curl -fs http://localhost:8080/health/ready     # success: {"ok":true,...}
docker build -t tandem:latest . && IMAGE=tandem:latest tools/deploy-smoke.sh   # success: all checks PASS
docker compose down -v
```
Needs ~3 GB of free disk for the images.

## 2. Deploy (any VM with Docker, e.g. 2 vCPU / 4 GB)

```bash
git clone https://github.com/siddhaantxsingh/TANDEM-Collaborative-Editor && cd TANDEM-Collaborative-Editor
cp .env.example .env
# set: POSTGRES_PASSWORD, METRICS_TOKEN, PUBLIC_ORIGIN=https://your.domain, COOKIE_SECURE=true
docker compose up --build -d
```
Put TLS in front (Caddy, or a cloud load balancer forwarding to port 8080).
Success: `npx tsx tools/smoke.ts --url https://your.domain --phase write --state s.json`
then, after a restart (`docker compose restart app1 app2`),
`--phase verify --state s.json` passes. Back up with `scripts/backup.sh`.

## 3. Load numbers for the resume

Run on a dedicated machine (not shared), e.g.
`OUT=docs/results/load-dedicated.jsonl SINGLE="50 100" MULTI="50 100" tools/loadmatrix.sh`
and quote p50/p95/p99 from that file. The audit's numbers come from a
heavily shared machine (load average 23-30 on 4 vCPU).

## 4. Correct the resume

* Remove "operational transformation as an alternate merge strategy": there is no OT code.
* "sub-50 ms edit propagation": say "median" and the setup, e.g. "p50 25-44 ms with 50 editors on one node (shared 4-vCPU machine)", or re-measure per item 3.
* "50+ simulated editors": supported (50 active editors, 1 and 2 nodes; 1,000 connected with 50 active).

## 5. Confirm CI

Check the Actions tab for branch `ccr-a6e6c567-y4w7k8`; merge only if green.
