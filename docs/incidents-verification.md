# Incident implementation verification

Initial implementation checks below were recorded on 2026-11-02 before the first source commits. Subsequent pushes preserve the pre-existing report/chat/mobile work; no production migration or automatic-mode activation was performed.

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

- The Python source-access blocker was resolved by reconstructing the original writes and subsequent fixes from implementation session history into the correct repository, `/Users/macbook/VietFlood_RAG`. Fresh verification there passed **29 tests**: `python -m unittest test_incidents test_incident_routes test_embeddings test_retrieval_readiness -v`. This includes the final diacritic-preserving embedding input, existing private-token authentication, strict input validation, provider-error sanitization, and retrieval/embedding regressions. Providers and Qdrant were not exercised live; the old OneDrive copy remains unreadable and untouched.
- The broader backend incident ESLint check is **not clean**. Remaining errors are concentrated in dynamic SQL/RPC/worker `any` boundaries, plus test files excluded by the repository's ESLint project configuration. Focused domain, summary, DTO, HTTP error and socket checks pass. Compilation and runtime checks do not replace resolving this lint debt.
- RabbitMQ delivery, Redis, and provider responses in the database tests are doubles; browser APIs are fixtures. The separate configured-model smoke test does not prove the full live pipeline. PostGIS acceleration was not exercised; the tested database and target both use the coordinate/distance fallback.
- Native changes are limited to archival confirmation copy; native builds were not rerun.

Follow [the runbook](incidents.md) for backup, additive migration, RAG repository deployment, and enabling `INCIDENTS_ENABLED=true` with `INCIDENT_MATCH_MODE=review`. Re-evaluate the final Python embedding pipeline before considering any automatic attachment. Keep processing disabled until the migration and service configuration are ready. Rollback retains evidence and audit history.
