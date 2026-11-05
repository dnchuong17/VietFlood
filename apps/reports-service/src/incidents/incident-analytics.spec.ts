import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";
import { readIncidentAnalytics, readIncidentReport } from "./incident-analytics";
import { PIPELINE } from "./incident-domain";

const admin = { userId: 1, role: "admin" };
const relief = { userId: 2, role: "relief" };
const range = { from: "2026-11-01", to: "2026-11-07" };
const id = "11111111-1111-4111-8111-111111111111";
const clock = "2026-11-07T08:00:00.000Z";
const incident = { id, title: "Ngập tại phường A", province: "Huế", ward: "A", address: "Đường A", lat: 0, lng: 0, severity: "UNKNOWN", status: "DETECTED", evidence_version: 3, verified_evidence_version: 3, verified_pipeline: PIPELINE, first_reported_at: new Date("2026-11-01T00:00:00Z"), latest_reported_at: new Date("2026-11-07T00:00:00Z"), centroid: [1, 2], embedding_fingerprint: "private", analysis_complete: true };
const source = { incident_id: id, report_id: 7, revision: 2, emergency: true, snapshot: { description: "cần cứu hộ", createdAt: "2026-11-01T00:00:00Z" }, result: null };
const emptyStats = () => ({ totalIncidents: 0, totalReports: 0, linkedReports: 0, ungroupedReports: 0, missingGpsReports: 0, bySeverity: [], byStatus: [], dailyReports: [], topAreas: [], incidentTotal: 0, densityReportTotal: 0, density: [] });

// Query fixtures: these test SQL construction and read-model behavior, NOT real
// PostgreSQL execution. The core-owned integration suite must verify SQL results.
function queryFixture(options: { stats?: Record<string, any>; incidents?: any[]; points?: any[]; sources?: any[]; summaries?: any[]; edits?: any[]; count?: number } = {}) {
  const stats = { ...emptyStats(), ...options.stats };
  const query = vi.fn(async (sql: string, values?: any[]) => {
    if (sql === "SET TRANSACTION READ ONLY") return [];
    if (sql.includes("transaction_timestamp()")) return [{ generatedAt: new Date(clock) }];
    if (sql.includes('AS "totalIncidents"')) return [stats];
    if (sql.includes("SELECT count(*)::int AS count FROM filtered_incidents")) return [{ count: options.count ?? options.incidents?.length ?? 0 }];
    if (sql.includes("SELECT * FROM filtered_incidents WHERE lat BETWEEN")) return options.points ?? [];
    if (sql.includes("SELECT * FROM filtered_incidents WHERE $8")) return options.incidents ?? [];
    if (sql.includes("SELECT m.incident_id,t.report_id")) return options.sources ?? [];
    if (sql.includes("FROM private_incidents.summaries WHERE")) return options.summaries ?? [];
    if (sql.includes("FROM private_incidents.summary_edits WHERE")) return options.edits ?? [];
    throw new Error(`Unexpected fixture query: ${sql} ${JSON.stringify(values)}`);
  });
  const transaction = vi.fn(async (isolation, callback) => { expect(isolation).toBe("REPEATABLE READ"); return callback({ query }); });
  const outsideQuery = vi.fn(() => { throw new Error("Read escaped snapshot"); });
  const db = { query: outsideQuery, transaction } as unknown as DataSource;
  return { db, query, transaction, outsideQuery };
}
afterEach(() => vi.useRealTimers());

describe("incident analytics/report query-fixture input and authorization", () => {
  it.each([readIncidentAnalytics, readIncidentReport])("denies citizens and unauthenticated actors before any transaction", async (read) => {
    const f = queryFixture();
    await expect(read(f.db, { userId: 3, role: "citizen" }, range)).rejects.toMatchObject({ statusCode: 403 });
    await expect(read(f.db, { userId: 0, role: "admin" }, range)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([
    [{ from: "2026-02-30" }, "invalid_date"],
    [{ from: "2026-01-01", to: "2026-02-01" }, "invalid_date_range"],
    [{ from: "2026-11-08", to: "2026-11-07" }, "invalid_date_range"],
    [{ from: "2026-11-01T00:00:00" }, "invalid_date"],
    [{ severity: "SEVERE" }, "invalid_severity"],
    [{ status: "DELETED" }, "invalid_status"],
    [{ assignedToMe: "yes" }, "invalid_assignment"],
    [{ province: ["Huế"] }, "invalid_area"],
    [{ ward: "   " }, "invalid_area"],
    [{ mapLimit: 1001 }, "invalid_map_limit"],
    [{ mapLimit: [2] }, "invalid_map_limit"],
  ])("rejects malformed or oversized input %j", async (input, code) => {
    const f = queryFixture();
    await expect(readIncidentAnalytics(f.db, admin, { ...range, ...input })).rejects.toMatchObject({ statusCode: 400, code });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("defaults to seven Vietnam calendar days rather than UTC days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T18:15:00Z")); // Nov 7 in Vietnam.
    const f = queryFixture();
    const result = await readIncidentAnalytics(f.db, relief, {});
    expect(result.filters).toMatchObject({ from: "2026-10-31T17:00:00.000Z", to: "2026-11-07T17:00:00.000Z", timeZone: "Asia/Ho_Chi_Minh" });
    expect(result.generatedAt).toBe(clock);
  });
  it("accepts exactly 31 calendar days and preserves explicit timestamp boundaries", async () => {
    const f = queryFixture();
    const result = await readIncidentAnalytics(f.db, relief, { from: "2026-10-01", to: "2026-10-31" });
    expect(result.filters).toMatchObject({ from: "2026-09-30T17:00:00.000Z", to: "2026-10-31T17:00:00.000Z" });
    const timestamp = await readIncidentAnalytics(f.db, relief, { from: "2026-11-01T00:00:00+07:00", to: "2026-11-02T00:00:00+07:00" });
    expect(timestamp.filters.to).toBe("2026-11-01T17:00:00.000Z");
  });
  it("rejects intervals touching 32 calendar days even when shorter than 31 elapsed days", async () => {
    const f = queryFixture();
    await expect(readIncidentAnalytics(f.db, admin, { from: "2026-10-01T23:59:00+07:00", to: "2026-11-01T00:01:00+07:00" })).rejects.toMatchObject({ code: "invalid_date_range" });
  });
});

describe("incident analytics query-fixture aggregates and coverage", () => {
  it("uses one read-only repeatable snapshot, aggregate SQL and parameterized shared filters", async () => {
    const f = queryFixture();
    await readIncidentAnalytics(f.db, relief, { ...range, province: "Huế%_'", ward: "A", severity: "HIGH", status: "VERIFIED", assignedToMe: "true", mapLimit: "2", limit: 1 });
    expect(f.outsideQuery).not.toHaveBeenCalled();
    expect(f.query.mock.calls[0][0]).toBe("SET TRANSACTION READ ONLY");
    const [sql, args] = f.query.mock.calls.find(([sql]) => sql.includes('AS "totalIncidents"'))!;
    expect(args).toEqual(["2026-10-31T17:00:00.000Z", "2026-11-07T17:00:00.000Z", "%Huế\\%\\_'%", "%A%", "VERIFIED", "HIGH", 2, 2]);
    expect(sql).not.toContain("Huế");
    expect(sql).toContain("i.latest_reported_at >= $1::timestamptz AND i.first_reported_at < $2::timestamptz");
    expect(sql).toContain("i.merged_into IS NULL");
    expect(sql).toContain("i.assignee_id=$7");
    expect(sql).toContain("snapshot->>'createdAt')::timestamptz >= $1");
    expect(sql).toContain("s.incident_id IS NULL AND $5::text IS NULL AND $6::text IS NULL AND $7::int IS NULL");
    expect(sql).toContain("FROM public.reports p LEFT JOIN");
    expect(sql).toContain("COALESCE(r.snapshot,to_jsonb(p))");
    expect(sql).toContain("t.archived_at IS NULL");
    expect(sql).toContain("m.left_at IS NULL");
    expect(sql).toContain("GROUP BY severity");
    expect(sql).toContain("GROUP BY status");
    expect(sql).toContain("generate_series");
    expect(sql).toContain("AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    expect(sql).toContain("jsonb_typeof(snapshot->'lat')='number'");
    expect(sql).toContain("THEN CASE WHEN"); // Guard unsafe casts on unknown GPS.
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE public|DELETE FROM)/);
  });
  it("does not derive totals from bounded map points; retains 0,0 and current-source priority", async () => {
    const f = queryFixture({ stats: { totalIncidents: 50, totalReports: 90, linkedReports: 70, ungroupedReports: 20, missingGpsReports: 10, incidentTotal: 49, densityReportTotal: 80, bySeverity: [{ key: "UNKNOWN", count: 50 }], byStatus: [{ key: "DETECTED", count: 50 }], dailyReports: [{ date: "2026-11-01", count: 90 }], topAreas: [{ province: "Huế", ward: "A", reportCount: 90, incidentCount: 50 }], density: [{ lat: 0, lng: 0, count: 80 }] }, points: [incident], sources: [source] });
    const result = await readIncidentAnalytics(f.db, admin, { ...range, mapLimit: 1 });
    expect(result).toMatchObject({ totalIncidents: 50, totalReports: 90, linkedReports: 70, ungroupedReports: 20, missingGpsReports: 10, bySeverity: [{ key: "UNKNOWN", count: 50 }], byStatus: [{ key: "DETECTED", count: 50 }], dailyReports: [{ date: "2026-11-01", count: 90 }], topAreas: [{ province: "Huế", ward: "A", reportCount: 90, incidentCount: 50 }] });
    expect(result.map).toMatchObject({ incidentTotal: 49, incidentReturned: 1, densityReportTotal: 80, limit: 1, truncated: true });
    expect(result.map.incidents[0]).toMatchObject({ lat: 0, lng: 0, severity: "UNKNOWN", reportCount: 1, isUrgent: true, priority: { value: "HIGH", sourceReportIds: [7], evidenceVersion: 3, provenance: "estimate", requiresHumanDecision: true } });
    const [evidenceSql, evidenceArgs] = f.query.mock.calls.find(([sql]) => sql.includes("SELECT m.incident_id,t.report_id"))!;
    expect(evidenceSql).toContain("a.pipeline=$2");
    expect(evidenceArgs).toEqual([[id], PIPELINE]);
  });
  it("marks density truncation independently and does not fabricate missing-GPS locations", async () => {
    const f = queryFixture({ stats: { totalIncidents: 4, totalReports: 20, missingGpsReports: 5, densityReportTotal: 15, density: [{ lat: 0, lng: 0, count: 9 }] } });
    const result = await readIncidentAnalytics(f.db, admin, { ...range, mapLimit: 1 });
    expect(result.map).toMatchObject({ incidents: [], incidentReturned: 0, incidentTotal: 0, densityReportTotal: 15, truncated: true });
    expect(result.missingGpsReports).toBe(5);
  });
  it("does not call evidence or invent narrative for an empty complete map", async () => {
    const f = queryFixture();
    const result = await readIncidentAnalytics(f.db, relief, range);
    expect(result.map).toEqual({ incidents: [], density: [], incidentTotal: 0, incidentReturned: 0, densityReportTotal: 0, limit: 500, truncated: false });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("SELECT m.incident_id,t.report_id"))).toBe(false);
  });
});

describe("incident report query-fixture consistency, redaction and overflow", () => {
  it("rejects overflow with an actionable 4xx before loading data; never silently truncates", async () => {
    const f = queryFixture({ count: 1001 });
    await expect(readIncidentReport(f.db, relief, range)).rejects.toMatchObject({ statusCode: 422, code: "report_too_large", message: expect.stringContaining("Narrow") });
    expect(f.query).toHaveBeenCalledTimes(3);
  });
  it("returns original existing summaries, stale provenance and source IDs with contacts redacted", async () => {
    const content = { pipeline: "incidents-v1", title: "Gọi 0912345678 hoặc help@example.com", conditions: [{ id: "7:2:incidents-v1:0", text: "SĐT 0912345678", reportId: 7 }], contactPhone: "0912345678", nested: { email: "help@example.com", text: "tôi tên: Nguyễn Văn A, nước dâng" } };
    const f = queryFixture({ count: 1, incidents: [{ ...incident, title: "Gọi 0912345678", verified_pipeline: "incidents-v1" }], sources: [source], summaries: [{ incident_id: id, evidence_version: 3, content }], edits: [{ incident_id: id, id: "9", title: "Gọi 0912345678", body: "mail help@example.com", actor_id: 1, created_at: new Date(clock), evidence_version: 3, pipeline: "incidents-v1" }] });
    const report = await readIncidentReport(f.db, relief, range);
    expect(report).toMatchObject({ generatedAt: clock, coverage: { complete: true, incidentCount: 1, maximumIncidents: 1000 } });
    expect(report.generatedAt).toBe(report.analytics.generatedAt);
    expect(report.filters).toEqual(report.analytics.filters);
    expect(report.incidents[0]).toMatchObject({ id, severity: "UNKNOWN", sourceReportIds: [7], summaryStale: true, needsVerification: true, summary: { pipeline: "incidents-v1", conditions: [{ id: "7:2:incidents-v1:0", reportId: 7 }] }, editorialSummary: { id: 9, actorId: 1, evidenceVersion: 3, pipeline: "incidents-v1", stale: true, createdAt: clock }, priority: { sourceReportIds: [7], evidenceVersion: 3 } });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("0912345678");
    expect(serialized).not.toContain("help@example.com");
    expect(serialized).not.toContain("Nguyễn Văn A");
    expect(serialized).not.toContain("contactPhone");
    expect(serialized).not.toContain("centroid");
    expect(serialized).not.toContain("embedding_fingerprint");
    expect(serialized).not.toContain("snapshot");
    expect(content.title).toContain("0912345678"); // Redaction never mutates originals.
    const selections = f.query.mock.calls.filter(([sql]) => sql.startsWith("WITH filtered_incidents"));
    for (const [, args] of selections) expect(args).toEqual(selections[0][1]);
    expect(selections.at(-1)![0]).not.toContain("LIMIT");
  });
  it("keeps evidence-stale summaries and editorial edits distinct from current pipeline", async () => {
    const f = queryFixture({ incidents: [incident], sources: [source], summaries: [{ incident_id: id, evidence_version: 2, content: { pipeline: PIPELINE, title: "Existing AI summary" } }], edits: [{ incident_id: id, id: 10, title: "Admin summary", body: "Evidence has changed", actor_id: 1, created_at: clock, evidence_version: 2, pipeline: PIPELINE }] });
    const report = await readIncidentReport(f.db, admin, range);
    expect(report.incidents[0]).toMatchObject({ summary: { title: "Existing AI summary" }, summaryStale: true, editorialSummary: { title: "Admin summary", stale: true }, needsVerification: false });
  });
  it("does not mark current evidence and pipeline stale", async () => {
    const f = queryFixture({ incidents: [incident], summaries: [{ incident_id: id, evidence_version: 3, content: { pipeline: PIPELINE, title: "Existing" } }], edits: [{ incident_id: id, id: 11, title: "Admin", body: "Confirmed", actor_id: null, created_at: clock, evidence_version: 3, pipeline: PIPELINE }] });
    const report = await readIncidentReport(f.db, admin, range);
    expect(report.incidents[0]).toMatchObject({ summaryStale: false, editorialSummary: { stale: false } });
  });
  it("accepts the exact 1000-incident boundary and returns complete data without prose fallback", async () => {
    const incidents = Array.from({ length: 1000 }, (_, n) => ({ ...incident, id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}` }));
    const f = queryFixture({ incidents, count: 1000, stats: { totalIncidents: 1000 } });
    const report = await readIncidentReport(f.db, admin, range);
    expect(report.coverage).toEqual({ complete: true, incidentCount: 1000, maximumIncidents: 1000 });
    expect(report.incidents).toHaveLength(1000);
    for (const row of report.incidents) expect(row).toMatchObject({ sourceReportIds: [], summary: null, summaryStale: true, editorialSummary: null, priority: { value: "UNKNOWN", factIds: [], sourceReportIds: [] } });
  });
  it("propagates transaction failures instead of returning partial success", async () => {
    const f = queryFixture({ incidents: [incident] });
    f.query.mockImplementationOnce(async () => { throw new Error("snapshot setup failed"); });
    await expect(readIncidentReport(f.db, admin, range)).rejects.toThrow("snapshot setup failed");
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("rejects UTF-8 report payloads over 2 MB even below the incident-count limit", async () => {
    const f = queryFixture({ incidents: [incident], summaries: [{ incident_id: id, evidence_version: 3, content: { pipeline: PIPELINE, title: "Lớn", conditions: [{ text: "ậ".repeat(700000) }] } }] });
    await expect(readIncidentReport(f.db, admin, range)).rejects.toMatchObject({ statusCode: 422, code: "report_too_large" });
  });
});
