# Flood incidents

The existing reports service owns incident state and background processing. The existing private FastAPI service normalizes and embeds Vietnamese text. The shared model client selects supported evidence for summaries. The Next.js relief workspace provides review, verification, assignment, and correction controls.

## Enable a deployment

1. Deploy the updated report writers and API gateway with `INCIDENTS_ENABLED=false`. All replicas must use the new retention behavior before enabling processing. Build and deploy the existing RAG image from the `VietFlood_RAG` repository root described below. No additional AI service is required.
2. Inspect the target database with `node --env-file=.env scripts/migrate-incidents.js`. This is read-only unless `--apply` is supplied. It reports whether reports/users, the incident schema, and PostGIS exist without exposing connection credentials.
3. Back up the target database, then apply the additive migration with `node --env-file=.env scripts/migrate-incidents.js --apply`. The migration is transactional and repeatable. It does not rewrite original reports or put incident tables under TypeORM synchronization. Optional PostGIS indexes use the extension's actual schema; otherwise matching uses bounded coordinates plus Haversine distance.
   Validate a private backup before applying: check target identity, archive checksum, expected table/data entries, and successful decoding of the archive. Older reports-service builds cache schema readiness at startup; if they started before migration, restart only the affected reports-service replicas after migration and read back the live endpoint results. A successful database preflight is not proof of live service recovery. Do not replace an outage with an empty successful feed.
4. Set `INCIDENTS_ENABLED=true`, `INCIDENT_MATCH_MODE=review`, `RAG_SERVICE_URL`, `RAG_SERVICE_TOKEN`, and the existing `OPENAI_*` configuration on **reports-service**. The Compose files provide these settings only to the services that need them. Recreate all report-service replicas consistently.
5. Check the authenticated `/incidents/overview`, the immediate emergency feed, a new synthetic report, its pending review/incident, and the summary state. Use the dashboard's historical processing form for a selected date window; existing history is not processed automatically.

The source changes do not themselves migrate or enable processing. The configured application database was migrated separately during the authorized 2026-11-03 repair; see the verification record for the backup and live rollout verification. The operator confirms that a source push triggers the production deployment/restart. The feature defaults to processing disabled so deployments can apply migrations before startup. Schema creation does not backfill historical reports or enable new-report retention; those are separate, explicitly authorized operations.

The current local RAG repository is `/Users/macbook/VietFlood_RAG`. The inference extension now lives directly in its repository root; use that root as Docker context. The earlier implementation used a separate recovered checkout in an old OneDrive workspace. Its incident files and subsequent fixes were restored from the implementation session history because macOS still denies reads of the old directory. `VietFlood_RAG/RECOVERY.md` records the transfer; the old directory was left untouched.

## Invariants and processing

- Source revisions and audit events are append-only. Retained reports have restrictive foreign keys; report deletion archives the source and keeps Cloudinary media. Archived sources remain available to authorized incident users. An unresolved emergency is not suppressed by archiving its source.
- Submission, evidence retention, the analysis job, and the emergency event commit together. Cache and AI work do not create incident membership. Internal report-creation retry keys prevent duplicate writes across RabbitMQ retries.
- Historical requests enqueue a batch immediately. The worker retains at most 25 reports per batch pass, committing each independently so live submissions can proceed. Shared analysis jobs are linked to every requesting batch without duplicate processing.
- Jobs have 180-second leases, five bounded attempts, stale-worker checks, and durable failure codes. Expired final leases fail visibly. External AI calls execute outside database transactions. Membership commits and manual corrections share a short advisory lock.
- A report belongs to at most one active incident. Original membership history remains after merge or split. Manual corrections are never automatically undone. Merges retain a survivor and require conflicting assignments/deployments to be reconciled. Splits create an unassigned incident requiring review.
- Matching uses a fixed anchor, a 300-meter radius, a six-hour gap and a 24-hour total span. The cosine threshold is `0.88`, with a `0.05` lead over the next candidate. Missing GPS, ambiguous evidence, incomplete model data and resolved incidents cannot be automatically matched. Incident centroids are cached transactionally and excluded from public responses.
- Summary counts and timestamps come from database evidence. The model selects evidence IDs and allowed recommendation categories; displayed factual text is extractive, and quantities are rendered by the server. Depth descriptions such as “ngập tới đầu gối” are never converted into guessed measurements. Model output cannot write severity, verification, assignment or deployment state.
- Summary jobs publish only for their original evidence version. Failed or stale summaries retain the prior result with a stale indicator. The current source records and deterministic counts remain accessible.
- Emergency classification runs without the model. A durable outbox publishes minimal invalidation events through Redis to a separate authenticated `/incidents` Socket.IO namespace. The UI polls every four seconds to leave a second for fetching and rendering within the five-second visibility target, keeps known emergencies visible during outages, and lists newest urgent reports first.

## Permissions and API contract

All routes use the existing bearer JWT. Current roles are checked again in the reports service. Citizens cannot access incident endpoints. Admins verify, change severity, assign, merge, split, review matches and process history. Relief users can view incidents and record deployment/resolution only for their assignment. Assignment alone never deploys resources. Only administrators reopen resolved incidents.

Routes have no additional `/api` prefix. The complete contract is in `incidents.openapi.json`.

| Operation                                          | Input / response                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /incidents`                                   | Province, ward, date-overlap, severity, status and assigned-to-me filters; `{items,nextCursor}` |
| `GET /incidents/overview`                          | Counts, review queue, failures, queue age and configured mode                                   |
| `GET /incidents/emergencies`                       | Paginated urgent sources independent of clustering                                              |
| `GET /incidents/review`                            | Admin review queue, candidate IDs/versions, ranking scores and reasons                          |
| `GET /incidents/assignees`                         | Admin-only paginated relief IDs and usernames; no citizen directory                             |
| `GET /incidents/:id`                               | Incident state, current evidence, summary, verification and stale status                        |
| `GET /incidents/:id/reports`                       | Paginated sources with current/original snapshots and revision counts                           |
| `GET /incidents/:id/reports/:reportId[/revisions]` | A linked source, or its paginated immutable revisions                                           |
| `GET /incidents/:id/history`                       | Paginated audit events                                                                          |
| `POST /incidents/review/:reportId/resolve`         | `{action:attach\|create\|exclude,expectedRevision,reason,incidentId?,expectedVersion?}`         |
| `POST /incidents/:id/verify`                       | `{expectedVersion,reason,factIds}`; selecting no fact IDs records incident-level review only    |
| `PATCH /incidents/:id/status`                      | `{expectedVersion,reason,status}`; verification uses the separate endpoint                      |
| `PATCH /incidents/:id/severity`                    | `{expectedVersion,reason,severity}`                                                             |
| `PATCH /incidents/:id/assignment`                  | `{expectedVersion,reason,assigneeId:number\|null}`                                              |
| `POST /incidents/:id/regenerate-summary`           | `{expectedVersion,reason}` → `202 {jobId}`                                                      |
| `POST /incidents/merge`                            | `{targetId,expectedVersion,reason,sources:[{id,expectedVersion}]}`                              |
| `POST /incidents/:id/split`                        | `{expectedVersion,reason,reportIds}`; a proper subset only                                      |
| `POST /ai/incidents/process`                       | `{reportIds}` or `{from,to}` → `202 {jobId,reportCount}`; at most 1,000 reports/31 days         |
| `GET /ai/incidents/jobs/:id`                       | Scheduling status, failure code and analysis counts by child-job status                         |

POST actions require `Idempotency-Key` (8–100 letters, digits, underscores or hyphens). Retries with the same input return the same result; changed input returns `409`. Lists default to 25 and cap at 100. Mutation version conflicts return `409`, validation `400`, authentication `401`, and authorization `403`. Errors have `{statusCode,code,message,requestId}`. No raw database/provider errors or contact fields are exposed by incident responses. Free-text originals are accessible only through authorized source views; provider-bound text is redacted.

The lifecycle is `DETECTED`, `UNDER_REVIEW`, `VERIFIED`, `RESCUE_DEPLOYED`, `RESOLVED`. Severity is independently `UNKNOWN`, `LOW`, `MODERATE`, `HIGH`, or `CRITICAL`, and is set only by an administrator. Verification records an evidence version and explicitly chosen facts; new evidence requires renewed review without silently cancelling deployment.

## Evaluation and verification

See [the verification record](incidents-verification.md) for current test results, the failed matching evaluation, and deployment limits.

`test/fixtures/incident-evaluation.json` contains 30 positive and 36 negative **synthetic** Vietnamese cases. It is not field validation. Run `npm run build:reports-service`, then either query the updated private service:

```sh
node --env-file=.env scripts/evaluate-incidents.js test/fixtures/incident-evaluation.json /path/to/evaluation.json
```

or export vectors with the existing Python embedding client and evaluate locally:

```sh
node --env-file=.env scripts/export-incident-benchmark.js /path/to/readable/VietFlood_RAG /path/to/python
INCIDENT_EVALUATION_VECTORS=/private/tmp/vietflood-incident-vectors.json node scripts/evaluate-incidents.js test/fixtures/incident-evaluation.json /path/to/evaluation.json
```

Automatic attachment requires `INCIDENT_MATCH_MODE=automatic` **and** `INCIDENT_EVALUATION_PATH` pointing to a readable result with matching model/pipeline/configuration fingerprints, at least 30 positives and 30 negatives, precision ≥98%, recall ≥80%, and zero geographic/temporal violations. Mount this artifact read-only into the reports-service container when using automatic mode. Missing, incompatible or failing results retain review behavior. Changing thresholds requires a new evaluation; do not tune against the held-out results and describe them as independent validation.

Repeatable checks:

```sh
# Isolated PostgreSQL 18 at localhost:55439, database vietflood_incidents_test.
# This configuration never reads the application's DATABASE_URL.
npx vitest run --config vitest.incidents.config.ts
npm run build:reports-service
npm run build:api-gateway

# In the VietFlood_RAG repository root, using an environment with requirements installed:
python -m unittest test_incidents test_incident_routes -v

# In the Next.js repository:
npm test
npm run build
# Start the app on localhost:3105; NODE_PATH may point to an existing Playwright install.
node docs/qa/incidents.cjs
```

The incident database suite uses real PostgreSQL transactions and real Nest HTTP/JWT validation. Broker delivery, Redis publication and provider responses are explicit doubles. Browser checks use the real UI with isolated fixture APIs and block external requests; they do not prove live service integration. Native incident screens are outside this release; native deletion text now accurately explains retained evidence.

## Operations and rollback

Inspect `queuedJobs`, `failedJobs`, `oldestJobSeconds`, `pendingReviews`, per-job failure codes, and stale summary indicators. Logs record job IDs, decisions, elapsed time and sanitized reasons without report text or credentials. Source revisions and audit history remain the authority after failures.

Set `INCIDENT_MATCH_MODE=review` to disable automatic attachment. Set `INCIDENTS_ENABLED=false` to stop new AI processing while retaining incident reads, source preservation for already-retained reports, audit history and pending jobs. Do not drop the schema or revert to an old report writer that permanently deletes retained media. Restore the feature by re-enabling the flag after dependencies recover; failed jobs can be retried through the process/regeneration actions.
