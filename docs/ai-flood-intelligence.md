# AI Flood Intelligence — implementation and verification matrix

Scope: approved rev-8 plan, separate from the earlier emergency-feed 503 release. The user subsequently authorized scoped publication and read-only production Playwright checks, then explicitly authorized private backup and the additive production migration. Automatic matching activation, operational writes and historical processing remain excluded.

## Eight functions

| Function | Implementation surfaces | Verification required before acceptance |
|---|---|---|
| 1. Vietnamese normalization | RAG `incident_processing.py`, analyze route and exporter | Preserve citizen original/numbers/GPS; handle abbreviations, spelling, accents and negation; incidents-only normalization fingerprint |
| 2. Related/possibly duplicate reports | `incident-matching.ts`, worker and review UI | Tentative relation, distance/time/source IDs; similarity is not probability; no source deletion |
| 3. Incident grouping | Existing locks/manual merge/split, v2 worker and evaluation gate | Positive automatic path only with compatible passing artifact; block missing GPS, contradictory/negated evidence, distant locations/times and incompatible models; manual decisions retained |
| 4. Evidence summaries | `incident-summary.ts`, ledger/versioned facts | No fabricated missing summary; counts from data, evidence IDs include pipeline; old analyses preserved and labeled stale |
| 5. Suggested priority | `incident-priority.ts`, current evidence and UI | LOW/MODERATE/HIGH/CRITICAL estimates never overwrite official severity; critical requires explicit life threat, not vague flood depth |
| 6. Analytics and maps | `incident-analytics.ts`, analytics/map web components | Totals independent of pagination; same filters, Vietnam date semantics, ungrouped/missing GPS visible, bounded map coverage and attribution |
| 7. On-demand daily/weekly/area report and PDF | JSON/PDF routes, report-period/export UI, PDFKit/NotoSans | Same read-only consistent snapshot; Vietnamese multipage output, source/provenance/stale labels, size/range refusal, no contact/token leakage; no scheduler |
| 8. Admin editorial and human control | Append-only summary edits, DTO/API/editor UI | Author/reason/evidence/pipeline history, optimistic version and idempotency, role denial, AI regeneration preserves human editions |

## Compatibility and operation

- Analysis pipeline is `incidents-v2`; knowledge-base fingerprint must remain unchanged. Old v1 analysis/summary records are not deleted or silently promoted. Reprocessing requires an explicit Admin request.
- Apply `20261101_incidents.sql` then additive `20261106_incident_intelligence.sql` through the migration runner only in an authorized deployment. Both are packaged in service artifacts; gateway also packages the licensed Vietnamese font. The present task must not apply either migration to production.
- Verification validity includes evidence version and pipeline. Existing verification lacking the new pipeline is stale, not automatically renewed. Editorial history does not overwrite AI JSON or original report evidence.
- Admin controls editorial, verification, severity, grouping and assignment. Relief can read/export and update rescue progress only for its active assignment. Citizen has neither API nor UI access.
- Date-only filters refer to Asia/Ho_Chi_Minh. Report submission dates and incident overlap are distinct. Map density is reported evidence, not a verified inundation boundary.
- Reports reject overlarge selections instead of silently limiting an export. Map limits are different: map coverage/truncation is explicit while analytical totals cover all filtered records.

## Evidence boundaries

Backend parent verification passed 305 tests (47 opt-in skips), plus 86 incident tests with isolated PostgreSQL/HTTP; both service builds and TypeScript passed. RAG parent verification passed 45 tests. A real local authenticated API generated a seven-page Vietnamese PDF whose text/font/footer and first/last rendered pages were checked. Browser verification is still being completed; final browser and deployment evidence belongs in `incidents-verification.md`, not inferred from file existence.

PostgreSQL/HTTP fixture integration uses only `127.0.0.1:55439/vietflood_incidents_test`; broker/model/provider/Redis fixtures are not production integration. Local browser runners intercept APIs and block production writes. Production Playwright checks must use the actual APIs read-only and report empty-state or unavailable responses honestly. No synthetic clustering result establishes field precision or production automatic-mode eligibility.

The separately authorized production migration was backed up and read back on 2026-11-06 (Vietnam time): 14 RLS-enabled incident tables, new editorial table/verification pipeline present, all 26 original reports unchanged, and incident/job/retention counts unchanged. No historical processing or automatic-mode change occurred. The private backup manifest records checksum/catalog/archive-decode validation; no full restore drill was performed.
