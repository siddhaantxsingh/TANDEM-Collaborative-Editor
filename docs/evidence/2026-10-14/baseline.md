# Baseline, 2026-10-14 (commit 1a4d7df, before any change)

Machine: shared Linux container, 4 vCPU, 15 GiB RAM. Other agents ran
builds and tests at the same time; load averages are in each log.
Services started locally: PostgreSQL 16 (`pg_ctlcluster 16 main start`),
Redis 7.0.15 (`redis-server --port 6379`). Node v22.22.0.

| Step | Command | Result | Log |
| --- | --- | --- | --- |
| Install | `npm ci` | PASS, 0 vulnerabilities | `baseline-npm-ci.log` |
| Build | `npm run build` | PASS | `baseline-build.log` |
| Typecheck | `npm run typecheck` | PASS | `baseline-typecheck.log` |
| Lint | `npm run lint` | PASS. Note: this is `tsc --noEmit`; there is no ESLint | `baseline-lint.log` |
| Unit/integration | `TEST_DATABASE_ADMIN_URL=... TEST_REDIS_URL=... npx vitest run` | 87/88 passed, 1 failed (metrics test). Back-to-back runs also failed the cross-node login-limit test. Both are test-isolation flakes, fixed in ffd97bc | `baseline-vitest.log`, `flaky-security-before.log`, `flaky-security-after.log` |
| E2E | `npx playwright test` | FAILED 0/3: @playwright/test 1.63 expects Chromium build 1243, the machine has 1194 | `baseline-playwright.log` |
| E2E | `CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell npx playwright test` | PASS 3/3 | `baseline-playwright-chromium-path.log` |
| Docker | `docker build` | NOT RUN: the shared disk was 98-100 % full during this session | - |

README claims checked against this baseline: "88/88 Vitest tests" reproduced
as 87/88 (flaky), "3/3 browser E2E" reproduced with `CHROMIUM_PATH`.
