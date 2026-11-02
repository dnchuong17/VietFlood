# Incident implementation verification

Checked on 2026-11-02. Changes remain local and preserve the pre-existing report/chat/mobile work. No production migration, deployment, commit, or push was performed.

| Check | Result |
| --- | --- |
| Backend regression: `npx vitest run` | 258 passed, 33 skipped (opt-in suites) |
| Incident database/HTTP/socket tests: `npx vitest run --config vitest.incidents.config.ts` | 28 passed; isolated PostgreSQL at `127.0.0.1:55439/vietflood_incidents_test` |
| Reports service and API gateway production builds | Passed |
| Frontend: `npm test` | 214 passed |
| Frontend incident lint and Next.js production build | Passed |
| Browser: `node docs/qa/incidents.cjs` | 16 checks passed against the production build with fixture APIs; external services blocked |
| Configured structured model: `node --env-file=.env scripts/check-incident-summary.js` | Valid schema and evidence references; two reports, one grounded condition, one recommendation; no automatic deployment |
| Target database read-only preflight | Reports/users present; incident schema and PostGIS absent |
| Diff whitespace and OpenAPI parsing | Passed; 20 documented paths |

The database suite covers concurrent submissions and delivery deduplication; expired leases and terminal failures; stale summaries; source revisions/media retention; administrative review; assigned-relief restrictions; manual grouping preservation; competing merge/split operations; and notification retries. Archive audit attribution is verified through real HTTP/JWT requests for administrator, relief and citizen delete routes. Legacy internal calls without an actor record an unknown actor instead of falsely attributing the report owner. Repeated archival does not duplicate audit entries.

Browser coverage includes geography/date/severity/status filters, review confirmations, original revisions, keyboard-driven map selection, assignment without deployment, verification, merge/split, assignment pages, mobile overflow and citizen/relief restrictions. The final emergency polling measurement was **4,387 ms** from a fixture commit with sockets blocked; `/private/tmp/vietflood-incidents-qa/results.json` records the result. The four-second polling cadence leaves one second for fetching/rendering against the five-second target. This controlled check is not a production latency guarantee.

## Matching remains in review mode

The recorded synthetic Vietnamese benchmark in `incident-evaluation.json` has 30 positive and 36 negative cases: zero accepted matches, 30 false negatives, zero false positives and zero geographic/temporal gate violations. Recall is 0%; precision is not estimable without positive predictions (the evaluator stores 0). It fails the required 98% precision / 80% recall gate. Automatic attachment remains disabled. These are synthetic cases, not field validation; do not tune against this set and call it independent validation.

## Open verification and deployment limits

- OneDrive now returns `Operation not permitted` for the recovered Python directory, including outside the sandbox. A fresh Python run and the final `RECOVERY.md` edit were blocked. The prior handoff recorded 12 passing Python tests, but that is not fresh evidence for the latest embedding-text change. Restore readable local access and run `python -m unittest test_incidents test_incident_routes -v` before deploying the recovered service. `test_incident_routes.py` covers the existing private token, strict input validation, embedding client reuse, and sanitized provider errors.
- The broader backend incident ESLint check is **not clean**. Remaining errors are concentrated in dynamic SQL/RPC/worker `any` boundaries, plus test files excluded by the repository's ESLint project configuration. Focused domain, summary, DTO, HTTP error and socket checks pass. Compilation and runtime checks do not replace resolving this lint debt.
- RabbitMQ delivery, Redis, and provider responses in the database tests are doubles; browser APIs are fixtures. The separate configured-model smoke test does not prove the full live pipeline. PostGIS acceleration was not exercised; the tested database and target both use the coordinate/distance fallback.
- Native changes are limited to archival confirmation copy; native builds were not rerun.

Follow [the runbook](incidents.md) for backup, additive migration, recovered-source deployment, and enabling `INCIDENTS_ENABLED=true` with `INCIDENT_MATCH_MODE=review`. Re-evaluate the final Python embedding pipeline before considering any automatic attachment. Keep processing disabled until the migration and service configuration are ready. Rollback retains evidence and audit history.
