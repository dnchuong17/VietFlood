import { Injectable, OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import {
  Actor,
  Sql,
  PIPELINE,
  CLUSTER_LOCK,
  authorize,
  fail,
  hash,
  snapshot,
  urgent,
  validCoordinates,
  page,
  pageResult,
  checkStatus,
  SEVERITIES,
  redact,
} from "./incident-domain";

import { assessPriority } from "./incident-priority";
import { readIncidentAnalytics, readIncidentReport } from "./incident-analytics";

@Injectable()
export class IncidentRepository implements OnModuleInit {
  ready = false;
  postgis = false;
  postgisNamespace = '"public"';
  private readinessRefresh?: Promise<void>;
  constructor(readonly db: DataSource) {}
  async onModuleInit() {
    await this.refreshReadiness();
    if (process.env.INCIDENTS_ENABLED === "true" && !this.ready)
      throw new Error("Run the incident migration before enabling incidents");
  }
  private async refreshReadiness() {
    if (!this.readinessRefresh)
      this.readinessRefresh = this.probeReadiness().finally(() => {
        this.readinessRefresh = undefined;
      });
    await this.readinessRefresh;
  }
  private async probeReadiness() {
    const [row] = await this.db.query(
      "SELECT to_regclass('private_incidents.incidents') IS NOT NULL AS ready, EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS postgis",
    );
    let namespace = '"public"';
    if (row.postgis) {
      const [extension] = await this.db.query(
        "SELECT quote_ident(n.nspname) AS name FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis'",
      );
      namespace = extension.name;
    }
    // Publish readiness only after all capability metadata is available.
    this.postgisNamespace = namespace;
    this.postgis = !!row.postgis;
    this.ready = !!row.ready;
  }
  get enabled() {
    return this.ready && process.env.INCIDENTS_ENABLED === "true";
  }
  async requireReady() {
    if (this.ready) return;
    try {
      await this.refreshReadiness();
    } catch {
      // Connection/catalog errors must not expose database details to callers.
      fail(503, "incidents_unavailable", "Incident storage is not configured");
    }
    if (!this.ready)
      fail(503, "incidents_unavailable", "Incident storage is not configured");
  }
  async intelligenceAvailable(q: Sql = this.db) {
    const [row] = await q.query(`SELECT to_regclass('private_incidents.summary_edits') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='private_incidents' AND table_name='incidents' AND column_name='verified_pipeline') AS available`);
    return row?.available === true;
  }
  async requireIntelligence() {
    if (!(await this.intelligenceAvailable())) fail(503, "incident_intelligence_migration_required", "Run the incident intelligence migration; emergency reads remain available");
  }
  private editorial(row: any, incident: any) {
    return row ? { id: Number(row.id), title: row.title, body: row.body, reason: row.reason, actorId: row.actor_id, createdAt: new Date(row.created_at).toISOString(), evidenceVersion: row.evidence_version, pipeline: row.pipeline, stale: row.pipeline !== PIPELINE || row.evidence_version !== incident.evidence_version } : null;
  }
  private analysisView(result: any) {
    return result ? { pipeline: PIPELINE, normalizedText: result.normalizedText ?? "", matchingText: result.matchingText ?? "", ...(result.normalizationVersion ? { normalizationVersion: result.normalizationVersion } : {}) } : null;
  }
  async lock(q: Sql) {
    await q.query("SELECT pg_advisory_xact_lock($1)", [CLUSTER_LOCK]);
  }
  async job(
    q: Sql,
    kind: string,
    key: string,
    payload: any,
    parentId: string | null = null,
  ) {
    const [job] = await q.query(
      `INSERT INTO private_incidents.jobs(id,kind,dedupe_key,payload,parent_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *`,
      [randomUUID(), kind, key, JSON.stringify(payload), parentId],
    );
    if (parentId)
      await q.query(
        "INSERT INTO private_incidents.batch_jobs(parent_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [parentId, job.id],
      );
    return job;
  }
  async event(q: Sql, event: string, payload: any) {
    await q.query(
      "INSERT INTO private_incidents.outbox(event,payload) VALUES($1,$2)",
      [event, JSON.stringify(payload)],
    );
  }
  async audit(
    q: Sql,
    id: string | null,
    actor: Actor | null,
    action: string,
    reason = "",
    details: any = {},
  ) {
    await q.query(
      "INSERT INTO private_incidents.audit(incident_id,actor_id,action,reason,details) VALUES($1,$2,$3,$4,$5)",
      [id, actor?.userId ?? null, action, reason, JSON.stringify(details)],
    );
  }
  async retained(id: number, q: Sql = this.db) {
    if (!this.ready) return null;
    return (
      (
        await q.query(
          "SELECT * FROM private_incidents.retained_reports WHERE report_id=$1",
          [id],
        )
      )[0] ?? null
    );
  }
  async capture(q: Sql, report: any, parentId: string | null = null) {
    const retained = await this.retained(report.id, q);
    if (!this.enabled && !retained) return;
    if (retained?.archived_at) return;
    const data = snapshot(report),
      digest = hash(data);
    const [last] = await q.query(
      "SELECT content_hash FROM private_incidents.report_revisions WHERE report_id=$1 ORDER BY revision DESC LIMIT 1",
      [report.id],
    );
    if (last?.content_hash === digest) return retained.revision;
    const revision = (retained?.revision ?? 0) + 1,
      emergency = urgent(report);
    await q.query(
      `INSERT INTO private_incidents.retained_reports(report_id,revision,emergency) VALUES($1,$2,$3)
      ON CONFLICT(report_id) DO UPDATE SET revision=$2,emergency=$3,updated_at=now()`,
      [report.id, revision, emergency],
    );
    await q.query(
      "INSERT INTO private_incidents.report_revisions(report_id,revision,snapshot,content_hash) VALUES($1,$2,$3,$4)",
      [report.id, revision, JSON.stringify(data), digest],
    );
    if (this.enabled)
      await this.job(
        q,
        "analyze",
        `analyze:${report.id}:${revision}:${PIPELINE}`,
        { reportId: report.id, revision, pipeline: PIPELINE },
        parentId,
      );
    const [member] = await q.query(
      "SELECT incident_id FROM private_incidents.memberships WHERE report_id=$1 AND left_at IS NULL",
      [report.id],
    );
    if (member) await this.touch(q, member.incident_id);
    await this.event(q, emergency ? "emergency" : "report.updated", {
      reportId: report.id,
      revision,
    });
    return revision;
  }
  async archive(id: number, userId: number, actor: Actor | null = null) {
    if (!this.ready) return false;
    return this.db.transaction(async (q) => {
      await this.lock(q);
      const [report] = await q.query(
        'SELECT * FROM public.reports WHERE id=$1 AND "userId"=$2 FOR UPDATE',
        [id, userId],
      );
      if (!report) return false;
      const retained = await this.retained(id, q);
      if (retained?.archived_at) return true;
      if (!retained) {
        if (!this.enabled) return false;
        await this.capture(q, report);
      }
      await q.query(
        "UPDATE private_incidents.retained_reports SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE report_id=$1",
        [id],
      );
      const [m] = await q.query(
        "SELECT incident_id FROM private_incidents.memberships WHERE report_id=$1 AND left_at IS NULL",
        [id],
      );
      await this.audit(
        q,
        m?.incident_id ?? null,
        actor,
        "report.archived",
        "",
        { reportId: id },
      );
      await this.event(q, "report.archived", { reportId: id });
      return true;
    });
  }
  async visible(reports: any[]) {
    if (!this.ready || !reports.length) return reports;
    const archived = new Set(
      (
        await this.db.query(
          "SELECT report_id FROM private_incidents.retained_reports WHERE archived_at IS NOT NULL AND report_id=ANY($1::int[])",
          [reports.map((r) => r.id)],
        )
      ).map((r) => r.report_id),
    );
    return reports.filter((r) => !archived.has(r.id));
  }
  async idempotent(
    q: Sql,
    actor: Actor,
    operation: string,
    key: string,
    body: any,
    run: () => Promise<any>,
  ) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key ?? ""))
      fail(
        400,
        "idempotency_key_required",
        "Provide an Idempotency-Key of 8–100 letters, digits, hyphens or underscores",
      );
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${actor.userId}:${operation}:${key}`,
    ]);
    const digest = hash(body),
      [existing] = await q.query(
        "SELECT * FROM private_incidents.receipts WHERE actor_id=$1 AND operation=$2 AND key=$3",
        [actor.userId, operation, key],
      );
    if (existing) {
      if (existing.hash !== digest)
        fail(
          409,
          "idempotency_conflict",
          "The idempotency key was already used with different input",
        );
      return existing.response;
    }
    const response = await run();
    await q.query(
      "INSERT INTO private_incidents.receipts(actor_id,operation,key,hash,response) VALUES($1,$2,$3,$4,$5)",
      [actor.userId, operation, key, digest, JSON.stringify(response)],
    );
    return response;
  }
  async incident(q: Sql, id: string, version?: number) {
    const [row] = await q.query(
      "SELECT * FROM private_incidents.incidents WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!row) fail(404, "incident_not_found", "Incident not found");
    if (row.merged_into)
      fail(409, "incident_merged", `Incident merged into ${row.merged_into}`);
    if (version !== undefined && row.version !== version)
      fail(
        409,
        "version_conflict",
        "The incident changed; refresh before retrying",
      );
    return row;
  }
  async touch(q: Sql, id: string) {
    const [i] = await q.query(
      `WITH changed AS (UPDATE private_incidents.incidents SET version=version+1,evidence_version=evidence_version+1,updated_at=now(),
      first_reported_at=COALESCE((SELECT MIN((r.snapshot->>'createdAt')::timestamptz) FROM private_incidents.memberships m JOIN private_incidents.retained_reports t ON t.report_id=m.report_id JOIN private_incidents.report_revisions r ON r.report_id=t.report_id AND r.revision=t.revision WHERE m.incident_id=$1 AND m.left_at IS NULL),first_reported_at),
      latest_reported_at=COALESCE((SELECT MAX(COALESCE(r.snapshot->>'updatedAt',r.snapshot->>'createdAt')::timestamptz) FROM private_incidents.memberships m JOIN private_incidents.retained_reports t ON t.report_id=m.report_id JOIN private_incidents.report_revisions r ON r.report_id=t.report_id AND r.revision=t.revision WHERE m.incident_id=$1 AND m.left_at IS NULL),latest_reported_at)
      WHERE id=$1 RETURNING evidence_version) SELECT * FROM changed`,
      [id],
    );
    // Recompute once when evidence changes; candidate matching reads only one vector per incident.
    await q.query(
      `WITH current_vectors AS (
      SELECT a.embedding,a.fingerprint FROM private_incidents.memberships m
      JOIN private_incidents.retained_reports t USING(report_id)
      LEFT JOIN private_incidents.analysis a ON a.report_id=t.report_id AND a.revision=t.revision AND a.pipeline=$2
      WHERE m.incident_id=$1 AND m.left_at IS NULL
    ), stats AS (SELECT count(*) AS total,count(embedding) AS analyzed,count(DISTINCT fingerprint) AS identities,min(fingerprint) AS fingerprint FROM current_vectors),
    average_vector AS (SELECT array_agg(mean ORDER BY position) AS vector FROM (
      SELECT position,avg(value) AS mean FROM current_vectors CROSS JOIN LATERAL unnest(embedding) WITH ORDINALITY AS e(value,position) GROUP BY position
    ) means)
    UPDATE private_incidents.incidents SET analysis_complete=(stats.total>0 AND stats.analyzed=stats.total AND stats.identities=1),
      embedding_fingerprint=stats.fingerprint,centroid=average_vector.vector FROM stats,average_vector WHERE id=$1`,
      [id, PIPELINE],
    );
    if (this.enabled)
      await this.job(q, "summary", `summary:${id}:${i.evidence_version}:${PIPELINE}`, {
        incidentId: id,
        evidenceVersion: i.evidence_version,
      });
    await this.event(q, "incident.updated", { incidentId: id });
  }
  async createIncident(q: Sql, report: any, status = "DETECTED") {
    const id = randomUUID(),
      coords = validCoordinates(report),
      location = [report.addressLine, report.ward, report.province]
        .filter(Boolean)
        .join(", ");
    await q.query(
      `INSERT INTO private_incidents.incidents(id,title,province,ward,address,lat,lng,status,first_reported_at,latest_reported_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        id,
        `Sự cố tại ${report.ward || report.province || "vị trí chưa xác định"}`,
        report.province ?? "",
        report.ward ?? "",
        location,
        coords ? report.lat : null,
        coords ? report.lng : null,
        status,
        report.createdAt,
      ],
    );
    return id;
  }
  async attach(q: Sql, id: string, reportId: number, manual: boolean) {
    await q.query(
      "INSERT INTO private_incidents.memberships(incident_id,report_id,manual) VALUES($1,$2,$3)",
      [id, reportId, manual],
    );
    await q.query(
      "UPDATE private_incidents.retained_reports SET review_state='linked' WHERE report_id=$1",
      [reportId],
    );
    await q.query("DELETE FROM private_incidents.reviews WHERE report_id=$1", [
      reportId,
    ]);
    await this.touch(q, id);
  }
  async review(
    q: Sql,
    reportId: number,
    revision: number,
    reason: string,
    candidates: any[] = [],
  ) {
    await q.query(
      `INSERT INTO private_incidents.reviews(report_id,revision,reason,candidates) VALUES($1,$2,$3,$4)
      ON CONFLICT(report_id) DO UPDATE SET revision=$2,reason=$3,candidates=$4,updated_at=now()`,
      [reportId, revision, reason, JSON.stringify(candidates)],
    );
    await q.query(
      "UPDATE private_incidents.retained_reports SET review_state='review' WHERE report_id=$1",
      [reportId],
    );
  }
  async ledger(id: string, q: Sql = this.db) {
    return q.query(
      `SELECT t.report_id,t.revision,t.emergency,t.archived_at,r.snapshot,a.result,a.fingerprint,a.embedding,legacy.result AS legacy_result,legacy.pipeline AS legacy_pipeline
      FROM private_incidents.memberships m JOIN private_incidents.retained_reports t ON t.report_id=m.report_id
      JOIN private_incidents.report_revisions r ON r.report_id=t.report_id AND r.revision=t.revision
      LEFT JOIN private_incidents.analysis a ON a.report_id=t.report_id AND a.revision=t.revision AND a.pipeline=$2
      LEFT JOIN LATERAL (SELECT result,pipeline FROM private_incidents.analysis old WHERE old.report_id=t.report_id AND old.revision=t.revision AND old.pipeline<>$2 ORDER BY old.created_at DESC LIMIT 1) legacy ON a.result IS NULL
      WHERE m.incident_id=$1 AND m.left_at IS NULL ORDER BY (r.snapshot->>'createdAt')::timestamptz,t.report_id`,
      [id, PIPELINE],
    );
  }
  facts(rows: any[]) {
    return rows.flatMap((row) =>
      (row.result?.facts ?? []).map((f: any, index: number) => ({
        ...f,
        id: `${row.report_id}:${row.revision}:${PIPELINE}:${index}`,
        reportId: row.report_id,
        revision: row.revision,
        pipeline: PIPELINE, stale: false,
        reportedAt: row.snapshot.updatedAt ?? row.snapshot.createdAt,
        provenance: "citizen_reported",
        text: redact(f.text),
      })),
    );
  }
  private publicIncident(row: any) {
    const result = { ...row };
    delete result.centroid;
    delete result.embedding_fingerprint;
    delete result.analysis_complete;
    return result;
  }
  async detail(id: string) {
    const [i] = await this.db.query(
      "SELECT * FROM private_incidents.incidents WHERE id=$1",
      [id],
    );
    if (!i) fail(404, "incident_not_found", "Incident not found");
    const rows = await this.ledger(id),
      [summary] = await this.db.query(
        "SELECT * FROM private_incidents.summaries WHERE incident_id=$1 ORDER BY evidence_version DESC,id DESC LIMIT 1",
        [id],
      );
    const [lastJob] = await this.db.query(
      "SELECT status,failure_code,updated_at FROM private_incidents.jobs WHERE kind='summary' AND payload->>'incidentId'=$1 ORDER BY created_at DESC LIMIT 1",
      [id],
    );
    const available = await this.intelligenceAvailable();
    const [edit] = available ? await this.db.query("SELECT * FROM private_incidents.summary_edits WHERE incident_id=$1 ORDER BY id DESC LIMIT 1", [id]) : [];
    const facts = this.facts(rows).map((f) => ({
      ...f,
      provenance: i.verified_pipeline === PIPELINE && i.verified_evidence_version === i.evidence_version && i.verified_facts.includes(f.id)
        ? "verified"
        : "citizen_reported",
    }));
    return {
      ...this.publicIncident(i),
      reportCount: rows.length,
      blockedRoadReports: rows.filter((r) => r.result?.blockedRoad === true)
        .length,
      strandedPeopleReports: rows.filter(
        (r) => r.result?.strandedPeople === true,
      ).length,
      strandedVehicleReports: rows.filter(
        (r) => r.result?.strandedVehicles === true,
      ).length,
      isUrgent: rows.some((r) => r.emergency),
      needsVerification: i.verified_pipeline !== PIPELINE || i.verified_evidence_version !== i.evidence_version,
      summary: summary?.content ?? null,
      summaryStale: !summary || summary.content?.pipeline !== PIPELINE || summary.evidence_version !== i.evidence_version,
      priority: assessPriority(rows, i.evidence_version), editorialSummary: this.editorial(edit, i),
      analysisRequired: rows.some(r => !r.result), intelligenceMigrationRequired: !available,
      legacyFacts: rows.flatMap(row => (row.legacy_result?.facts ?? []).map((fact: any, index: number) => ({ ...fact, text: redact(fact.text), id: `${row.report_id}:${row.revision}:${row.legacy_pipeline}:${index}`, reportId: row.report_id, pipeline: row.legacy_pipeline, stale: true, provenance: "citizen_reported" }))),
      summaryJob: lastJob ?? null,
      facts: [...facts, ...rows.flatMap(row => (row.legacy_result?.facts ?? []).map((fact: any, index: number) => ({ ...fact, text: redact(fact.text), id: `${row.report_id}:${row.revision}:${row.legacy_pipeline}:${index}`, reportId: row.report_id, revision: row.revision, reportedAt: row.snapshot.updatedAt ?? row.snapshot.createdAt, pipeline: row.legacy_pipeline, stale: true, provenance: "citizen_reported" })))],
    };
  }
  private filters(input: any, actor: Actor) {
    const values: any[] = [],
      clauses = ["i.merged_into IS NULL"];
    const add = (sql: string, value: any) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    for (const name of ["province", "ward"])
      if (input[name])
        add(
          `i.${name} ILIKE ?`,
          `%${String(input[name]).replace(/[\\%_]/g, "\\$&")}%`,
        );
    for (const name of ["status", "severity"])
      if (input[name]) add(`i.${name}=?`, input[name]);
    if (input.from) add("i.latest_reported_at>=?::timestamptz", input.from);
    if (input.to) add("i.first_reported_at<=?::timestamptz", input.to);
    if (input.assignedToMe === true || input.assignedToMe === "true")
      add("i.assignee_id=?", actor.userId);
    return { values, clauses, add };
  }
  async list(actor: Actor, input: any) {
    const limit = Number(input.limit ?? 25);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail(400, "invalid_limit", "Invalid limit");
    const f = this.filters(input, actor);
    if (input.cursor) {
      let c: any;
      try {
        c = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      } catch {
        fail(400, "invalid_cursor", "Invalid cursor");
      }
      if (!c || typeof c.id !== "string" || !Number.isFinite(Date.parse(c.at)))
        fail(400, "invalid_cursor", "Invalid cursor");
      f.values.push(c.at, c.id);
      f.clauses.push(
        `(i.updated_at,i.id)<($${f.values.length - 1}::timestamptz,$${f.values.length}::uuid)`,
      );
    }
    f.values.push(limit + 1);
    const items = await this.db.query(
      `SELECT i.*, (SELECT count(*)::int FROM private_incidents.memberships m WHERE m.incident_id=i.id AND m.left_at IS NULL) AS "reportCount",
      (i.verified_evidence_version IS DISTINCT FROM i.evidence_version OR to_jsonb(i)->>'verified_pipeline' IS DISTINCT FROM 'incidents-v2') AS "needsVerification",
      EXISTS(SELECT 1 FROM private_incidents.memberships m JOIN private_incidents.retained_reports t ON t.report_id=m.report_id WHERE m.incident_id=i.id AND m.left_at IS NULL AND t.emergency) AS "isUrgent"
      FROM private_incidents.incidents i WHERE ${f.clauses.join(" AND ")} ORDER BY i.updated_at DESC,i.id DESC LIMIT $${f.values.length}`,
      f.values,
    );
    const selected = items.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map((row) => this.publicIncident(row)),
      nextCursor:
        items.length > limit
          ? Buffer.from(
              JSON.stringify({ at: last.updated_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  async overview(actor: Actor, input: any) {
    const f = this.filters(input, actor);
    const [stats] = await this.db.query(
      `SELECT count(*)::int AS "totalIncidents",count(*) FILTER(WHERE severity IN ('HIGH','CRITICAL') OR EXISTS(SELECT 1 FROM private_incidents.memberships m JOIN private_incidents.retained_reports r ON r.report_id=m.report_id WHERE m.incident_id=i.id AND m.left_at IS NULL AND r.emergency))::int AS "highPriority",
      count(*) FILTER(WHERE verified_evidence_version IS DISTINCT FROM evidence_version OR to_jsonb(i)->>'verified_pipeline' IS DISTINCT FROM 'incidents-v2')::int AS "awaitingVerification",count(*) FILTER(WHERE updated_at>=now()-interval '24 hours')::int AS "recentlyUpdated" FROM private_incidents.incidents i WHERE ${f.clauses.join(" AND ")}`,
      f.values,
    );
    const [counts] = await this.db
      .query(`SELECT (SELECT count(*)::int FROM public.reports) AS "totalReports",(SELECT count(*)::int FROM private_incidents.reviews) AS "pendingReviews",
      (SELECT count(*)::int FROM private_incidents.jobs WHERE status='failed') AS "failedJobs",(SELECT count(*)::int FROM private_incidents.jobs WHERE status IN ('pending','running')) AS "queuedJobs",
      (SELECT EXTRACT(EPOCH FROM now()-min(created_at)) FROM private_incidents.jobs WHERE status='pending') AS "oldestJobSeconds"`);
    return {
      ...stats,
      ...counts,
      mode:
        process.env.INCIDENT_MATCH_MODE === "automatic"
          ? "automatic"
          : "review",
      processingEnabled: this.enabled,
    };
  }
  async read(actor: Actor, operation: string, id: string, input: any = {}) {
    authorize(actor);
    await this.requireReady();
    if (operation === "analytics") return readIncidentAnalytics(this.db, actor, input);
    if (operation === "report") {
      await this.requireIntelligence();
      return readIncidentReport(this.db, actor, input);
    }
    if (operation === "list") return this.list(actor, input);
    if (operation === "overview") return this.overview(actor, input);
    if (operation === "detail") return this.detail(id);
    if (operation === "job") {
      authorize(actor, true);
      const [job] = await this.db.query(
        "SELECT id,kind,status,attempts,failure_code,created_at,updated_at FROM private_incidents.jobs WHERE id=$1",
        [id],
      );
      if (!job) fail(404, "job_not_found", "Job not found");
      const children = await this.db.query(
        "SELECT j.status,count(*)::int AS count FROM private_incidents.batch_jobs b JOIN private_incidents.jobs j ON j.id=b.job_id WHERE b.parent_id=$1 GROUP BY j.status",
        [id],
      );
      return { ...job, children };
    }
    const p = page(input);
    if (operation === "assignees") {
      authorize(actor, true);
      return pageResult(
        await this.db.query(
          "SELECT id,username FROM public.users WHERE role='relief' AND id>$1 ORDER BY id LIMIT $2",
          [p.after, p.limit + 1],
        ),
        p.limit,
      );
    }
    if (operation === "review") {
      authorize(actor, true);
      const rows: { report_id: number }[] = await this.db.query(
        `SELECT v.*,r.snapshot,a.result AS analysis FROM private_incidents.reviews v JOIN private_incidents.report_revisions r USING(report_id,revision) LEFT JOIN private_incidents.analysis a ON a.report_id=v.report_id AND a.revision=v.revision AND a.pipeline='incidents-v2' WHERE v.report_id>$1 ORDER BY v.report_id LIMIT $2`,
        [p.after, p.limit + 1],
      );
      return pageResult(rows.map((row: any) => ({ ...row, ...(operation === "review" ? { analysis: this.analysisView(row.analysis) } : {}) })), p.limit, (r) => r.report_id);
    }
    if (operation === "emergencies") {
      const rows: { report_id: number }[] = await this.db.query(
        `SELECT t.report_id,t.revision,r.snapshot,m.incident_id FROM private_incidents.retained_reports t JOIN private_incidents.report_revisions r USING(report_id,revision)
        LEFT JOIN private_incidents.memberships m ON m.report_id=t.report_id AND m.left_at IS NULL LEFT JOIN private_incidents.incidents i ON i.id=m.incident_id
        WHERE t.emergency AND t.review_state<>'excluded' AND (i.status IS NULL OR i.status<>'RESOLVED') AND ($1::int=0 OR t.report_id<$1) ORDER BY t.report_id DESC LIMIT $2`,
        [p.after, p.limit + 1],
      );
      return pageResult(rows, p.limit, (r) => r.report_id);
    }
    if (!["reports", "history", "source", "revisions", "summary-edits"].includes(operation))
      fail(404, "not_found", "Unknown incident operation");
    const [exists] = await this.db.query(
      "SELECT id FROM private_incidents.incidents WHERE id=$1",
      [id],
    );
    if (!exists) fail(404, "incident_not_found", "Incident not found");
    if (operation === "summary-edits") {
      await this.requireIntelligence();
      const [incident] = await this.db.query("SELECT evidence_version FROM private_incidents.incidents WHERE id=$1", [id]);
      const edits = await this.db.query("SELECT * FROM private_incidents.summary_edits WHERE incident_id=$1 AND id>$2 ORDER BY id LIMIT $3", [id, p.after, p.limit + 1]);
      return pageResult(edits.map((row: any) => this.editorial(row, incident)), p.limit);
    }
    if (operation === "history")
      return pageResult(
        await this.db.query(
          "SELECT * FROM private_incidents.audit WHERE incident_id=$1 AND id>$2 ORDER BY id LIMIT $3",
          [id, p.after, p.limit + 1],
        ),
        p.limit,
      );
    if (operation === "source" || operation === "revisions") {
      const [member] = await this.db.query(
        "SELECT id FROM private_incidents.memberships WHERE incident_id=$1 AND report_id=$2 AND left_at IS NULL",
        [id, input.reportId],
      );
      if (!member)
        fail(404, "report_not_found", "Report not linked to this incident");
      if (operation === "revisions")
        return pageResult<{ revision: number }>(
          await this.db.query(
            'SELECT revision,snapshot,created_at AS "createdAt" FROM private_incidents.report_revisions WHERE report_id=$1 AND revision>$2 ORDER BY revision LIMIT $3',
            [input.reportId, p.after, p.limit + 1],
          ),
          p.limit,
          (r) => r.revision,
        );
    }
    const rows = await this.db.query(
      `SELECT m.report_id AS id,m.manual,t.archived_at,r.snapshot,a.result AS analysis,
      t.revision AS "revisionCount",(SELECT snapshot FROM private_incidents.report_revisions v WHERE v.report_id=m.report_id AND v.revision=1) AS "originalSnapshot"
      FROM private_incidents.memberships m JOIN private_incidents.retained_reports t USING(report_id) JOIN private_incidents.report_revisions r USING(report_id,revision)
      LEFT JOIN private_incidents.analysis a ON a.report_id=t.report_id AND a.revision=t.revision AND a.pipeline='incidents-v2'
      WHERE m.incident_id=$1 AND m.left_at IS NULL AND m.report_id>$2 AND ($4::int IS NULL OR m.report_id=$4) ORDER BY m.report_id LIMIT $3`,
      [
        id,
        p.after,
        p.limit + 1,
        operation === "source" ? input.reportId : null,
      ],
    );
    const sources = rows.map((row: any) => ({ ...row, analysis: this.analysisView(row.analysis) }));
    return operation === "source" ? sources[0] : pageResult(sources, p.limit);
  }
  async mutate(
    actor: Actor,
    operation: string,
    id: string,
    body: any,
    key?: string,
  ) {
    authorize(actor, operation !== "status");
    await this.requireReady();
    if (["edit-summary", "verify", "regenerate", "process"].includes(operation)) await this.requireIntelligence();
    if (operation === "edit-summary") {
      if (!key) fail(400, "idempotency_key_required", "Provide an Idempotency-Key");
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
        typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 ||
        typeof body.body !== "string" || !body.body.trim() || body.body.length > 12000 ||
        typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000)
        fail(400, "invalid_summary_edit", "Provide version, title, body and reason within the supported limits");
    }
    return this.db.transaction(async (q) => {
      await this.lock(q);
      const run = async () => {
        if (operation === "process") return this.process(q, actor, body);
        if (operation === "resolve")
          return this.resolve(q, actor, Number(id), body);
        if (operation === "merge") return this.merge(q, actor, body);
        const i = await this.incident(q, id, body.expectedVersion);
        if (operation === "edit-summary") {
          const [edit] = await q.query(`INSERT INTO private_incidents.summary_edits(incident_id,title,body,reason,actor_id,evidence_version,pipeline) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, body.title.trim(), body.body.trim(), body.reason.trim(), actor.userId, i.evidence_version, PIPELINE]);
          await q.query("UPDATE private_incidents.incidents SET version=version+1,updated_at=now() WHERE id=$1", [id]);
          await this.audit(q, id, actor, "summary.edited", body.reason, { editId: Number(edit.id), evidenceVersion: i.evidence_version, pipeline: PIPELINE });
          await this.event(q, "incident.updated", { incidentId: id });
          return this.editorial(edit, i);
        }
        if (operation === "split") return this.split(q, actor, i, body);
        if (operation === "regenerate") {
          if (!this.enabled)
            fail(503, "processing_disabled", "Incident processing is disabled");
          const job = await this.job(
            q,
            "summary",
            `summary:${id}:${i.evidence_version}:${randomUUID()}`,
            { incidentId: id, evidenceVersion: i.evidence_version },
          );
          if (job.status === "failed")
            await q.query(
              "UPDATE private_incidents.jobs SET status='pending',attempts=0,available_at=now(),failure_code=NULL WHERE id=$1",
              [job.id],
            );
          await this.audit(q, id, actor, "summary.requested", body.reason);
          return { jobId: job.id };
        }
        if (operation === "status") {
          checkStatus(actor, i, body.status);
          await q.query(
            "UPDATE private_incidents.incidents SET status=$2,assignee_id=CASE WHEN $2='RESOLVED' THEN NULL ELSE assignee_id END WHERE id=$1",
            [id, body.status],
          );
          if (body.status === "RESOLVED")
            await q.query(
              "UPDATE private_incidents.assignments SET ended_at=now() WHERE incident_id=$1 AND ended_at IS NULL",
              [id],
            );
        } else if (operation === "severity") {
          if (!SEVERITIES.includes(body.severity))
            fail(400, "invalid_severity", "Invalid severity");
          await q.query(
            "UPDATE private_incidents.incidents SET severity=$2 WHERE id=$1",
            [id, body.severity],
          );
        } else if (operation === "assignment") {
          if (i.status === "RESOLVED")
            fail(
              409,
              "resolved_incident",
              "Reopen the incident before assigning it",
            );
          if (body.assigneeId !== null) {
            const [u] = await q.query(
              "SELECT id FROM public.users WHERE id=$1 AND role='relief'",
              [body.assigneeId],
            );
            if (!u)
              fail(
                400,
                "invalid_assignee",
                "Select an existing relief account",
              );
          }
          if (body.assigneeId === null && i.status === "RESCUE_DEPLOYED")
            fail(
              409,
              "deployment_active",
              "Update deployment status before removing the assignment",
            );
          await q.query(
            "UPDATE private_incidents.assignments SET ended_at=now() WHERE incident_id=$1 AND ended_at IS NULL",
            [id],
          );
          if (body.assigneeId !== null)
            await q.query(
              "INSERT INTO private_incidents.assignments(incident_id,assignee_id,actor_id) VALUES($1,$2,$3)",
              [id, body.assigneeId, actor.userId],
            );
          await q.query(
            "UPDATE private_incidents.incidents SET assignee_id=$2 WHERE id=$1",
            [id, body.assigneeId],
          );
        } else if (operation === "verify") {
          const ledger = await this.ledger(id, q);
          if (!ledger.length || ledger.some(row => !row.result)) fail(409, "analysis_required", "Current pipeline analysis is required before verification");
          const facts = new Set(this.facts(ledger).map((f) => f.id));
          if (body.factIds.some((f: string) => !facts.has(f)))
            fail(
              400,
              "invalid_fact",
              "A verified fact must refer to current evidence",
            );
          await q.query(
            "UPDATE private_incidents.incidents SET verified_evidence_version=evidence_version,verified_pipeline='incidents-v2',verified_facts=$2,status=CASE WHEN status IN ('DETECTED','UNDER_REVIEW') THEN 'VERIFIED' ELSE status END WHERE id=$1",
            [id, JSON.stringify(body.factIds)],
          );
        } else fail(404, "not_found", "Unknown incident operation");
        await q.query(
          "UPDATE private_incidents.incidents SET version=version+1,updated_at=now() WHERE id=$1",
          [id],
        );
        await this.audit(q, id, actor, `incident.${operation}`, body.reason, {
          ...body,
          before: {
            status: i.status,
            severity: i.severity,
            assigneeId: i.assignee_id,
          },
        });
        await this.event(q, "incident.updated", { incidentId: id });
        return this.publicIncident(
          (
            await q.query(
              "SELECT * FROM private_incidents.incidents WHERE id=$1",
              [id],
            )
          )[0],
        );
      };
      return key
        ? this.idempotent(q, actor, `${operation}:${id}`, key, body, run)
        : run();
    });
  }
  async process(q: Sql, actor: Actor, body: any) {
    if (!this.enabled)
      fail(503, "processing_disabled", "Incident processing is disabled");
    const rows = body.reportIds?.length
      ? await q.query(
          'SELECT id FROM public.reports WHERE id=ANY($1::int[]) ORDER BY "createdAt",id',
          [body.reportIds],
        )
      : await q.query(
          'SELECT id FROM public.reports WHERE "createdAt">=$1 AND "createdAt"<=$2 ORDER BY "createdAt",id LIMIT 1001',
          [body.from, body.to],
        );
    if (rows.length > 1000)
      fail(
        400,
        "batch_too_large",
        "Choose a smaller date range (maximum 1000 reports)",
      );
    if (body.reportIds && rows.length !== body.reportIds.length)
      fail(404, "report_not_found", "Some requested reports do not exist");
    const batch = await this.job(q, "batch", `batch:${randomUUID()}`, {
      reportIds: rows.map((row) => row.id),
      cursor: 0,
    });
    await this.audit(q, null, actor, "processing.requested", "", {
      jobId: batch.id,
      count: rows.length,
    });
    return { jobId: batch.id, reportCount: rows.length };
  }
  async resolve(q: Sql, actor: Actor, reportId: number, body: any) {
    const t = await this.retained(reportId, q);
    if (!t) fail(404, "report_not_found", "Report not retained");
    if (t.revision !== body.expectedRevision)
      fail(409, "revision_conflict", "Report changed; refresh before deciding");
    if (t.review_state === "linked")
      fail(409, "already_linked", "Use split to move a linked report");
    const [r] = await q.query(
      "SELECT snapshot FROM private_incidents.report_revisions WHERE report_id=$1 AND revision=$2",
      [reportId, t.revision],
    );
    if (body.action === "exclude") {
      await q.query(
        "UPDATE private_incidents.retained_reports SET review_state='excluded' WHERE report_id=$1",
        [reportId],
      );
      await q.query(
        "DELETE FROM private_incidents.reviews WHERE report_id=$1",
        [reportId],
      );
      await this.audit(q, null, actor, "report.excluded", body.reason, {
        reportId,
      });
      return { reportId, excluded: true };
    }
    let target: string;
    if (body.action === "attach") {
      const i = await this.incident(q, body.incidentId, body.expectedVersion);
      if (i.status === "RESOLVED")
        fail(
          409,
          "resolved_incident",
          "Reopen the incident before attaching reports",
        );
      target = i.id;
    } else if (body.action === "create")
      target = await this.createIncident(q, r.snapshot, "UNDER_REVIEW");
    else fail(400, "invalid_action", "Invalid review action");
    await this.attach(q, target, reportId, true);
    await this.audit(q, target, actor, "report.attached", body.reason, {
      reportId,
    });
    return { incidentId: target };
  }
  async merge(q: Sql, actor: Actor, body: any) {
    const target = await this.incident(q, body.targetId, body.expectedVersion);
    if (target.status === "RESOLVED")
      fail(409, "resolved_incident", "Reopen the survivor before merging");
    for (const source of body.sources) {
      if (source.id === target.id)
        fail(400, "invalid_merge", "Source and survivor must differ");
      const other = await this.incident(q, source.id, source.expectedVersion);
      if (other.assignee_id && other.assignee_id !== target.assignee_id)
        fail(
          409,
          "assignment_conflict",
          "Reconcile assignments before merging",
        );
      if (
        other.status === "RESCUE_DEPLOYED" &&
        target.status !== "RESCUE_DEPLOYED"
      )
        fail(
          409,
          "deployment_conflict",
          "Reconcile deployment status before merging",
        );
      const rows = await q.query(
        "SELECT report_id FROM private_incidents.memberships WHERE incident_id=$1 AND left_at IS NULL",
        [other.id],
      );
      await q.query(
        "UPDATE private_incidents.memberships SET left_at=now() WHERE incident_id=$1 AND left_at IS NULL",
        [other.id],
      );
      for (const r of rows)
        await q.query(
          "INSERT INTO private_incidents.memberships(incident_id,report_id,manual) VALUES($1,$2,true)",
          [target.id, r.report_id],
        );
      await q.query(
        "UPDATE private_incidents.assignments SET ended_at=now() WHERE incident_id=$1 AND ended_at IS NULL",
        [other.id],
      );
      await q.query(
        "UPDATE private_incidents.incidents SET merged_into=$2,version=version+1,updated_at=now(),verified_evidence_version=NULL WHERE id=$1",
        [other.id, target.id],
      );
      await this.audit(q, other.id, actor, "incident.merged", body.reason, {
        targetId: target.id,
      });
      await this.audit(
        q,
        target.id,
        actor,
        "incident.merge_source",
        body.reason,
        { sourceId: other.id, reportIds: rows.map((r) => r.report_id) },
      );
    }
    await this.touch(q, target.id);
    return { incidentId: target.id };
  }
  async split(q: Sql, actor: Actor, i: any, body: any) {
    const rows = await this.ledger(i.id, q),
      selected = new Set(body.reportIds);
    if (
      !selected.size ||
      selected.size >= rows.length ||
      [...selected].some((id) => !rows.some((r) => r.report_id === id))
    )
      fail(400, "invalid_split", "Select a proper subset of reports");
    const first = rows.find((r) => selected.has(r.report_id));
    const child = await this.createIncident(q, first.snapshot, "UNDER_REVIEW");
    await q.query(
      "UPDATE private_incidents.memberships SET left_at=now() WHERE incident_id=$1 AND report_id=ANY($2::int[]) AND left_at IS NULL",
      [i.id, body.reportIds],
    );
    for (const reportId of body.reportIds)
      await q.query(
        "INSERT INTO private_incidents.memberships(incident_id,report_id,manual) VALUES($1,$2,true)",
        [child, reportId],
      );
    await this.touch(q, i.id);
    await this.touch(q, child);
    await this.audit(q, i.id, actor, "incident.split", body.reason, {
      childId: child,
      reportIds: body.reportIds,
    });
    await this.audit(q, child, actor, "incident.split_from", body.reason, {
      sourceId: i.id,
    });
    return { incidentId: child, sourceId: i.id };
  }
}
