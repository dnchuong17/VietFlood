import type { DataSource } from "typeorm";
import { authorize, fail, PIPELINE, redact, SEVERITIES, STATUSES, validCoordinates } from "./incident-domain";
import type { Actor, Sql } from "./incident-domain";
import { assessPriority } from "./incident-priority";

export type PriorityAssessment = ReturnType<typeof assessPriority>;
export type SummaryEdit = { id: number; title: string; body: string; reason: string; actorId: number | null; createdAt: string; evidenceVersion: number; pipeline: string; stale: boolean };
export type Analytics = {
  generatedAt: string; filters: Record<string, unknown>;
  totalIncidents: number; totalReports: number; linkedReports: number; ungroupedReports: number; missingGpsReports: number;
  bySeverity: Array<{ key: string; count: number }>;
  byStatus: Array<{ key: string; count: number }>;
  dailyReports: Array<{ date: string; count: number }>;
  topAreas: Array<{ province: string; ward: string; reportCount: number; incidentCount: number }>;
  map: { incidents: Array<{ id: string; title: string; lat: number; lng: number; severity: string; status: string; reportCount: number; isUrgent: boolean; priority: PriorityAssessment }>; density: Array<{ lat: number; lng: number; count: number }>; incidentTotal: number; incidentReturned: number; densityReportTotal: number; limit: number; truncated: boolean };
};
export type IncidentReport = { generatedAt: string; filters: Record<string, unknown>; analytics: Analytics; incidents: Array<Record<string, any> & { priority: PriorityAssessment; sourceReportIds: number[]; summary: Record<string, any> | null; summaryStale: boolean; editorialSummary: SummaryEdit | null }>; coverage: { complete: true; incidentCount: number; maximumIncidents: number } };

const DAY = 86400000;
const VN = 7 * 3600000;
const MAX_INCIDENTS = 1000;
const iso = (value: string | Date) => new Date(value).toISOString();
const vietnamDate = (time: number) => new Date(time + VN).toISOString().slice(0, 10);

function filters(actor: Actor, input: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "invalid_filters", "Filters must be an object");
  const today = vietnamDate(Date.now());
  const date = (value: unknown, end: boolean): number => {
    if (typeof value !== "string") return fail(400, "invalid_date", "Use YYYY-MM-DD or an ISO timestamp with timezone");
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = Date.parse(`${value}T00:00:00+07:00`);
      if (!Number.isFinite(parsed) || vietnamDate(parsed) !== value) return fail(400, "invalid_date", "Invalid calendar date");
      return parsed + (end ? DAY : 0);
    }
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return fail(400, "invalid_date", "Use YYYY-MM-DD or an ISO timestamp with timezone");
    const calendar = value.slice(0, 10);
    if (new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) return fail(400, "invalid_date", "Invalid calendar date");
    return Date.parse(value);
  };
  // Date-only 'to' includes that Vietnam calendar day; timestamp 'to' is exclusive.
  const to = input.to === undefined ? date(today, true) : date(input.to, true);
  const from = input.from === undefined ? Date.parse(`${vietnamDate(to - 1)}T00:00:00+07:00`) - 6 * DAY : date(input.from, false);
  if (to <= from || to - from > 31 * DAY || Date.parse(vietnamDate(to - 1)) - Date.parse(vietnamDate(from)) > 30 * DAY) fail(400, "invalid_date_range", "Choose an ordered range of at most 31 Vietnam calendar days");
  const normalized: Record<string, any> = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), province: null, ward: null, status: null, severity: null, assignedToMe: false, timeZone: "Asia/Ho_Chi_Minh", reportTimeBasis: "source createdAt; from inclusive, to exclusive", incidentTimeBasis: "first/latest reported overlap; from inclusive, to exclusive" };
  for (const key of ["province", "ward"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 200) fail(400, "invalid_area", "Area filters must contain 1–200 characters");
      normalized[key] = input[key].trim();
    }
  for (const [key, allowed] of [["status", STATUSES], ["severity", SEVERITIES]] as const)
    if (input[key] !== undefined) {
      if (!allowed.includes(input[key] as never)) fail(400, `invalid_${key}`, `Invalid ${key}`);
      normalized[key] = input[key];
    }
  if (input.assignedToMe !== undefined) {
    if (![true, false, "true", "false"].includes(input.assignedToMe)) fail(400, "invalid_assignment", "assignedToMe must be a boolean");
    normalized.assignedToMe = input.assignedToMe === true || input.assignedToMe === "true";
  }
  const limit = input.mapLimit === undefined ? 500 : Number(input.mapLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (input.mapLimit !== undefined && !["string", "number"].includes(typeof input.mapLimit))) fail(400, "invalid_map_limit", "mapLimit must be between 1 and 1000");
  const values = [normalized.from, normalized.to, normalized.province ? `%${normalized.province.replace(/[\\%_]/g, "\\$&")}%` : null, normalized.ward ? `%${normalized.ward.replace(/[\\%_]/g, "\\$&")}%` : null, normalized.status, normalized.severity, normalized.assignedToMe ? actor.userId : null, limit];
  return { normalized, values, limit };
}
type Filters = ReturnType<typeof filters>;

// One definition for both read models. Reports include unretained originals, but use
// the current immutable revision for retained reports. Archived reports are excluded.
// Incident-only filters suppress ungrouped reports; area filters apply independently
// to incident location and source-report location, never to an arbitrary list page.
const CTE = `WITH filtered_incidents AS MATERIALIZED (
 SELECT i.* FROM private_incidents.incidents i WHERE i.merged_into IS NULL
 AND i.latest_reported_at >= $1::timestamptz AND i.first_reported_at < $2::timestamptz
 AND ($3::text IS NULL OR i.province ILIKE $3) AND ($4::text IS NULL OR i.ward ILIKE $4)
 AND ($5::text IS NULL OR i.status=$5) AND ($6::text IS NULL OR i.severity=$6)
 AND ($7::int IS NULL OR i.assignee_id=$7)
), source_reports AS MATERIALIZED (
 SELECT p.id AS report_id,COALESCE(r.snapshot,to_jsonb(p)) AS snapshot,m.incident_id
 FROM public.reports p LEFT JOIN private_incidents.retained_reports t ON t.report_id=p.id
 LEFT JOIN private_incidents.report_revisions r ON r.report_id=t.report_id AND r.revision=t.revision
 LEFT JOIN private_incidents.memberships m ON m.report_id=p.id AND m.left_at IS NULL
 WHERE t.archived_at IS NULL
), filtered_reports AS MATERIALIZED (
 SELECT s.*, CASE WHEN jsonb_typeof(snapshot->'lat')='number' AND jsonb_typeof(snapshot->'lng')='number'
 THEN CASE WHEN (snapshot->>'lat')::double precision BETWEEN -90 AND 90 AND (snapshot->>'lng')::double precision BETWEEN -180 AND 180
 THEN (snapshot->>'lat')::double precision END END AS lat,
 CASE WHEN jsonb_typeof(snapshot->'lat')='number' AND jsonb_typeof(snapshot->'lng')='number'
 THEN CASE WHEN (snapshot->>'lat')::double precision BETWEEN -90 AND 90 AND (snapshot->>'lng')::double precision BETWEEN -180 AND 180
 THEN (snapshot->>'lng')::double precision END END AS lng
 FROM source_reports s WHERE (snapshot->>'createdAt')::timestamptz >= $1::timestamptz AND (snapshot->>'createdAt')::timestamptz < $2::timestamptz
 AND ($3::text IS NULL OR snapshot->>'province' ILIKE $3) AND ($4::text IS NULL OR snapshot->>'ward' ILIKE $4)
 AND (EXISTS(SELECT 1 FROM filtered_incidents i WHERE i.id=s.incident_id)
 OR (s.incident_id IS NULL AND $5::text IS NULL AND $6::text IS NULL AND $7::int IS NULL))
)`;
const GPS = "lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180";

const AGGREGATE = `${CTE}, area_counts AS (
 SELECT COALESCE(snapshot->>'province','') AS province,COALESCE(snapshot->>'ward','') AS ward,count(*)::int AS reports,0::int AS incidents FROM filtered_reports GROUP BY 1,2
 UNION ALL SELECT province,ward,0::int,count(*)::int FROM filtered_incidents GROUP BY 1,2
), daily AS (
 SELECT to_char((snapshot->>'createdAt')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS date,count(*)::int AS count FROM filtered_reports GROUP BY 1
), density AS (
 SELECT round(lat::numeric,2)::double precision AS lat,round(lng::numeric,2)::double precision AS lng,count(*)::int AS count FROM filtered_reports WHERE ${GPS} GROUP BY 1,2 ORDER BY count DESC,lat,lng LIMIT $8
)
SELECT (SELECT count(*)::int FROM filtered_incidents) AS "totalIncidents",
 (SELECT count(*)::int FROM filtered_reports) AS "totalReports",
 (SELECT count(*)::int FROM filtered_reports WHERE incident_id IS NOT NULL) AS "linkedReports",
 (SELECT count(*)::int FROM filtered_reports WHERE incident_id IS NULL) AS "ungroupedReports",
 (SELECT count(*)::int FROM filtered_reports WHERE lat IS NULL OR lng IS NULL) AS "missingGpsReports",
 (SELECT count(*)::int FROM filtered_incidents WHERE ${GPS}) AS "incidentTotal",
 (SELECT count(*)::int FROM filtered_reports WHERE ${GPS}) AS "densityReportTotal",
 COALESCE((SELECT jsonb_agg(x ORDER BY key) FROM (SELECT severity AS key,count(*)::int AS count FROM filtered_incidents GROUP BY severity) x),'[]') AS "bySeverity",
 COALESCE((SELECT jsonb_agg(x ORDER BY key) FROM (SELECT status AS key,count(*)::int AS count FROM filtered_incidents GROUP BY status) x),'[]') AS "byStatus",
 COALESCE((SELECT jsonb_agg(x ORDER BY date) FROM (SELECT to_char(day,'YYYY-MM-DD') AS date,COALESCE(d.count,0)::int AS count FROM generate_series(($1::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,(($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,interval '1 day') day LEFT JOIN daily d ON d.date=to_char(day,'YYYY-MM-DD')) x),'[]') AS "dailyReports",
 COALESCE((SELECT jsonb_agg(x ORDER BY "reportCount" DESC,"incidentCount" DESC,province,ward) FROM (SELECT province,ward,sum(reports)::int AS "reportCount",sum(incidents)::int AS "incidentCount" FROM area_counts GROUP BY province,ward ORDER BY "reportCount" DESC,"incidentCount" DESC,province,ward LIMIT 10) x),'[]') AS "topAreas",
 COALESCE((SELECT jsonb_agg(density ORDER BY count DESC,lat,lng) FROM density),'[]') AS density`;

async function evidence(q: Sql, ids: string[]) {
  if (!ids.length) return new Map<string, any[]>();
  const rows = await q.query(`SELECT m.incident_id,t.report_id,t.revision,t.emergency,r.snapshot,a.result
 FROM private_incidents.memberships m JOIN private_incidents.retained_reports t USING(report_id)
 JOIN private_incidents.report_revisions r ON r.report_id=t.report_id AND r.revision=t.revision
 LEFT JOIN private_incidents.analysis a ON a.report_id=t.report_id AND a.revision=t.revision AND a.pipeline=$2
 WHERE m.incident_id=ANY($1::uuid[]) AND m.left_at IS NULL AND t.archived_at IS NULL ORDER BY m.incident_id,t.report_id`, [ids, PIPELINE]);
  const byId = new Map<string, any[]>();
  for (const row of rows) { const list = byId.get(row.incident_id) ?? []; list.push(row); byId.set(row.incident_id, list); }
  return byId;
}

async function analytics(q: Sql, f: Filters, generatedAt: string): Promise<Analytics> {
  const [stats] = await q.query(AGGREGATE, f.values);
  const points = await q.query(`${CTE} SELECT * FROM filtered_incidents WHERE ${GPS} ORDER BY latest_reported_at DESC,id LIMIT $8`, f.values);
  const rows = await evidence(q, points.map((p) => p.id));
  const incidents = points.filter(validCoordinates).map((p) => {
    const sources = rows.get(p.id) ?? [];
    return { id: p.id, title: p.title, lat: p.lat, lng: p.lng, severity: p.severity, status: p.status, reportCount: sources.length, isUrgent: sources.some((s) => s.emergency), priority: assessPriority(sources, p.evidence_version) };
  });
  const { incidentTotal, densityReportTotal, density, ...counts } = stats;
  return { generatedAt, filters: f.normalized, ...counts, map: { incidents, density, incidentTotal, incidentReturned: incidents.length, densityReportTotal, limit: f.limit, truncated: incidents.length < incidentTotal || density.reduce((n: number, p: any) => n + p.count, 0) < densityReportTotal } };
}

async function snapshotRead<T>(db: DataSource, actor: Actor, input: any, read: (q: Sql, f: Filters, at: string) => Promise<T>): Promise<T> {
  authorize(actor);
  const f = filters(actor, input);
  return db.transaction("REPEATABLE READ", async (q) => {
    // Set read-only before the first data query; all queries use this manager.
    await q.query("SET TRANSACTION READ ONLY");
    const [clock] = await q.query('SELECT transaction_timestamp() AS "generatedAt"');
    return read(q, f, iso(clock.generatedAt));
  });
}

export async function readIncidentAnalytics(db: DataSource, actor: Actor, input: any = {}): Promise<Analytics> {
  return snapshotRead(db, actor, input, analytics);
}

// Redact free text recursively without corrupting identifiers, timestamps or GPS.
// Contact-bearing fields are removed even when a legacy summary included them.
function safeOutput(value: any, key = ""): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (/^(?:id|.*[Ii]d|.*[Ii]ds|.*[Aa]t|pipeline|.*[Vv]ersion|status|severity|key|date|from|to|timeZone|provenance|value|code|reasonCodes)$/.test(key)) return value;
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((item) => safeOutput(item, key));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([name]) => !/(?:contact|phone|email|token|password|username|fullName)/i.test(name)).map(([name, item]) => [name, safeOutput(item, name)]));
  return value;
}

export async function readIncidentReport(db: DataSource, actor: Actor, input: any = {}): Promise<IncidentReport> {
  return snapshotRead(db, actor, input, async (q, f, at) => {
    const [count] = await q.query(`${CTE} SELECT count(*)::int AS count FROM filtered_incidents WHERE $8::int>0`, f.values);
    if (count.count > MAX_INCIDENTS) fail(422, "report_too_large", "More than 1000 incidents match. Narrow the date or area filters and retry.");
    const overview = await analytics(q, f, at);
    const selected = await q.query(`${CTE} SELECT * FROM filtered_incidents WHERE $8::int>0 ORDER BY latest_reported_at DESC,id`, f.values);
    const rows = await evidence(q, selected.map((i) => i.id));
    const ids = selected.map((i) => i.id);
    const summaries = ids.length ? await q.query(`SELECT DISTINCT ON (incident_id) incident_id,evidence_version,content FROM private_incidents.summaries WHERE incident_id=ANY($1::uuid[]) ORDER BY incident_id,evidence_version DESC,id DESC`, [ids]) : [];
    const edits = ids.length ? await q.query(`SELECT DISTINCT ON (incident_id) * FROM private_incidents.summary_edits WHERE incident_id=ANY($1::uuid[]) ORDER BY incident_id,id DESC`, [ids]) : [];
    const summaryById = new Map(summaries.map((s) => [s.incident_id, s]));
    const editById = new Map(edits.map((s) => [s.incident_id, s]));
    const incidents = selected.map((i) => {
      const sources = rows.get(i.id) ?? [], summary = summaryById.get(i.id), edit = editById.get(i.id);
      const { centroid, embedding_fingerprint, analysis_complete, ...official } = i;
      return { ...official, reportCount: sources.length, isUrgent: sources.some((s) => s.emergency), needsVerification: i.verified_evidence_version !== i.evidence_version || i.verified_pipeline !== PIPELINE,
        priority: assessPriority(sources, i.evidence_version), sourceReportIds: sources.map((s) => s.report_id), summary: summary?.content ?? null,
        summaryStale: !summary || summary.evidence_version !== i.evidence_version || summary.content?.pipeline !== PIPELINE,
        editorialSummary: edit ? { id: Number(edit.id), title: edit.title, body: edit.body, reason: edit.reason, actorId: edit.actor_id, createdAt: iso(edit.created_at), evidenceVersion: edit.evidence_version, pipeline: edit.pipeline, stale: edit.evidence_version !== i.evidence_version || edit.pipeline !== PIPELINE } : null };
    });
    const report = safeOutput({ generatedAt: at, filters: f.normalized, analytics: overview, incidents, coverage: { complete: true, incidentCount: incidents.length, maximumIncidents: MAX_INCIDENTS } });
    if (Buffer.byteLength(JSON.stringify(report), "utf8") > 2_000_000)
      fail(422, "report_too_large", "Report exceeds 2 MB. Narrow the date or area filters and retry.");
    return report;
  });
}
