import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { LoggerService, RedisService } from "vietflood-common";
import { StructuredModelClient } from "../../../../shared/structured-model";
import { IncidentRepository } from "./incident.repository";
import {
  PIPELINE,
  Sql,
  cosine,
  distance,
  geoTemporalMatch,
  hash,
  matchingConfig,
  redact,
  validCoordinates,
} from "./incident-domain";
import {
  renderSummary,
  SUMMARY_INSTRUCTION,
  SUMMARY_SCHEMA,
} from "./incident-summary";

export function automaticAllowed(fingerprint: string) {
  if (process.env.INCIDENT_MATCH_MODE !== "automatic") return false;
  try {
    const result = JSON.parse(
      readFileSync(process.env.INCIDENT_EVALUATION_PATH ?? "", "utf8"),
    );
    return (
      result.pipeline === PIPELINE &&
      result.fingerprint === fingerprint &&
      result.configHash === hash(matchingConfig()) &&
      result.precision >= 0.98 &&
      result.recall >= 0.8 &&
      result.gateViolations === 0 &&
      result.positiveCases >= 30 &&
      result.negativeCases >= 30
    );
  } catch {
    return false;
  }
}

@Injectable()
export class IncidentWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;
  private outboxTimer: ReturnType<typeof setInterval>;
  private busy = false;
  private publishing = false;
  private stopping = false;
  readonly model: StructuredModelClient;
  constructor(
    readonly repo: IncidentRepository,
    private readonly redis: RedisService,
    private readonly logger: LoggerService,
  ) {
    this.model = new StructuredModelClient(logger, () => "incident-worker");
  }
  onModuleInit() {
    matchingConfig();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    this.outboxTimer = setInterval(() => void this.publish(), 500);
    this.outboxTimer.unref();
  }
  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.outboxTimer);
  }
  async claim() {
    const expired = await this.repo.db
      .query(`WITH expired AS (UPDATE private_incidents.jobs SET status='failed',failure_code='lease_expired',updated_at=now()
      WHERE status='running' AND lease_until<now() AND attempts>=5 RETURNING *) SELECT * FROM expired`);
    for (const job of expired)
      if (job.kind === "analyze")
        await this.repo.db.transaction(async (q) => {
          await this.repo.lock(q);
          const t = await this.repo.retained(job.payload.reportId, q);
          if (
            t &&
            t.revision === job.payload.revision &&
            t.review_state === "pending"
          )
            await this.repo.review(
              q,
              t.report_id,
              t.revision,
              "analysis_unavailable",
            );
        });
    const [job] = await this.repo.db.query(
      `WITH next AS (
      SELECT id FROM private_incidents.jobs WHERE ((status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now()))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1), claimed AS (
      UPDATE private_incidents.jobs j SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '180 seconds',updated_at=now()
      FROM next WHERE j.id=next.id RETURNING j.*) SELECT * FROM claimed`,
      [randomUUID()],
    );
    return job;
  }
  private async lease(q: Sql, job: any) {
    const [current] = await q.query(
      "SELECT id FROM private_incidents.jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
      [job.id, job.lease_token],
    );
    return !!current;
  }
  async tick() {
    if (this.busy || this.stopping || !this.repo.enabled) return;
    this.busy = true;
    let job: any;
    try {
      job = await this.claim();
      if (!job) return;
      const started = Date.now();
      const status =
        job.kind === "analyze"
          ? await this.analyze(job)
          : job.kind === "batch"
            ? await this.backfill(job)
            : await this.summarize(job);
      await this.repo.db.query(
        "UPDATE private_incidents.jobs SET status=$3,lease_until=NULL,updated_at=now(),failure_code=NULL,attempts=CASE WHEN $3='pending' THEN 0 ELSE attempts END,available_at=CASE WHEN $3='pending' THEN now()+interval '1 second' ELSE available_at END WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, status],
      );
      this.logger.info("Incident job completed", {
        jobId: job.id,
        kind: job.kind,
        status,
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      const waiting =
        error instanceof Error && error.message === "analysis_pending";
      const reason =
        error instanceof Error ? ((error as any).reason ?? error.message) : "";
      const code = waiting
        ? "analysis_pending"
        : typeof reason === "string" &&
            /^(?:incident_|invalid_incident_|unsupported_|analysis_|source_analysis_|openai_|missing_openai_|invalid_openai_|invalid_model_)[a-z0-9_]{1,70}$/.test(
              reason,
            )
          ? reason
          : error instanceof Error && error.name === "TimeoutError"
            ? "incident_ai_timeout"
            : "incident_processing_failed";
      this.logger.warn("Incident processing requires attention", {
        jobId: job?.id,
        kind: job?.kind,
        code,
        attempt: job?.attempts,
      });
      if (job) {
        try {
          await this.repo.db.query(
            `UPDATE private_incidents.jobs SET status=$3,failure_code=$4,available_at=now()+($5*interval '1 second'),lease_until=NULL,
            attempts=attempts-$6,updated_at=now() WHERE id=$1 AND lease_token=$2`,
            [
              job.id,
              job.lease_token,
              !waiting && job.attempts >= 5 ? "failed" : "pending",
              code,
              waiting ? 10 : Math.min(300, 2 ** job.attempts),
              waiting ? 1 : 0,
            ],
          );
          if (job.kind === "analyze" && job.attempts >= 5 && !waiting)
            await this.repo.db.transaction(async (q) => {
              await this.repo.lock(q);
              const t = await this.repo.retained(job.payload.reportId, q);
              if (
                t &&
                t.revision === job.payload.revision &&
                t.review_state === "pending"
              )
                await this.repo.review(
                  q,
                  t.report_id,
                  t.revision,
                  "analysis_unavailable",
                );
            });
        } catch {
          this.logger.warn("Incident job persistence unavailable", {
            jobId: job.id,
            code: "job_persistence_unavailable",
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async backfill(job: any): Promise<string> {
    const ids: number[] = job.payload.reportIds,
      cursor = job.payload.cursor ?? 0,
      end = Math.min(ids.length, cursor + 25);
    for (let index = cursor; index < end; index++) {
      const valid = await this.repo.db.transaction(async (q) => {
        await this.repo.lock(q);
        if (!(await this.lease(q, job))) return false;
        const [report] = await q.query(
          "SELECT * FROM public.reports WHERE id=$1 FOR UPDATE",
          [ids[index]],
        );
        if (report) {
          await this.repo.capture(q, report, job.id);
          const retained = await this.repo.retained(report.id, q);
          if (retained && retained.review_state !== "excluded") {
            const child = await this.repo.job(
              q,
              "analyze",
              `analyze:${report.id}:${retained.revision}:${PIPELINE}`,
              {
                reportId: report.id,
                revision: retained.revision,
                pipeline: PIPELINE,
              },
              job.id,
            );
            if (child.status === "failed")
              await q.query(
                "UPDATE private_incidents.jobs SET status='pending',attempts=0,available_at=now(),failure_code=NULL WHERE id=$1",
                [child.id],
              );
          }
        }
        await q.query(
          "UPDATE private_incidents.jobs SET payload=jsonb_set(payload,'{cursor}',to_jsonb($3::int)),updated_at=now() WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token, index + 1],
        );
        return true;
      });
      if (!valid) return "obsolete";
    }
    return end < ids.length ? "pending" : "succeeded";
  }
  async analyze(job: any): Promise<string> {
    const { reportId, revision } = job.payload;
    const [r] = await this.repo.db.query(
      "SELECT snapshot FROM private_incidents.report_revisions WHERE report_id=$1 AND revision=$2",
      [reportId, revision],
    );
    const current = await this.repo.retained(reportId);
    if (
      !r ||
      current.revision !== revision ||
      current.review_state === "excluded"
    )
      return "obsolete";
    const report = r.snapshot;
    const base = (process.env.RAG_SERVICE_URL ?? "").replace(/\/+$/, ""),
      token = process.env.RAG_SERVICE_TOKEN;
    if (!base || !token) throw new Error("incident_ai_not_configured");
    const safeReport = {
      description: redact(String(report.description ?? "")),
      province: redact(report.province ?? ""),
      ward: redact(report.ward ?? ""),
      addressLine: redact(report.addressLine ?? ""),
    };
    const response = await fetch(`${base}/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Rag-Token": token },
      body: JSON.stringify({ ...safeReport, requestId: job.id }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw new Error(`incident_analysis_http_${response.status}`);
    const result = await response.json();
    if (
      result.pipeline !== PIPELINE ||
      typeof result.fingerprint !== "string" ||
      !Array.isArray(result.embedding) ||
      result.embedding.length !== 1536 ||
      result.embedding.some(
        (v) => typeof v !== "number" || !Number.isFinite(v),
      ) ||
      !Array.isArray(result.facts) ||
      result.facts.length > 100 ||
      result.facts.some(
        (f) =>
          typeof f.text !== "string" ||
          f.text.length > 6000 ||
          !safeReport.description.normalize("NFC").includes(f.text),
      )
    )
      throw new Error("invalid_incident_analysis");
    return this.repo.db.transaction(async (q) => {
      await this.repo.lock(q);
      if (!(await this.lease(q, job))) return "obsolete";
      const t = await this.repo.retained(reportId, q);
      if (t.revision !== revision || t.review_state === "excluded")
        return "obsolete";
      const { embedding, fingerprint, ...analysis } = result;
      await q.query(
        `INSERT INTO private_incidents.analysis(report_id,revision,pipeline,result,embedding,fingerprint) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          reportId,
          revision,
          PIPELINE,
          JSON.stringify(analysis),
          embedding,
          fingerprint,
        ],
      );
      const [member] = await q.query(
        "SELECT * FROM private_incidents.memberships WHERE report_id=$1 AND left_at IS NULL",
        [reportId],
      );
      if (member) {
        await this.repo.touch(q, member.incident_id);
        return "succeeded"; // Membership changes always require a human after the first attachment.
      }
      if (
        !validCoordinates(report) ||
        !analysis.hasFloodEvidence ||
        analysis.ambiguousLocation
      ) {
        await this.repo.review(
          q,
          reportId,
          revision,
          !validCoordinates(report)
            ? "missing_coordinates"
            : analysis.ambiguousLocation
              ? "ambiguous_location"
              : "insufficient_flood_evidence",
        );
        return "succeeded";
      }
      const config = matchingConfig(),
        latDelta = config.radius / 111000,
        lngDelta =
          config.radius /
          (111000 * Math.max(0.01, Math.cos((report.lat * Math.PI) / 180)));
      const args: any[] = [
        report.lat - latDelta,
        report.lat + latDelta,
        report.lng - lngDelta,
        report.lng + lngDelta,
        report.createdAt,
        config.gapHours,
      ];
      let spatial = "";
      if (this.repo.postgis) {
        args.push(report.lng, report.lat, config.radius);
        const ns = this.repo.postgisNamespace;
        spatial = ` AND ${ns}.ST_DWithin(${ns}.ST_SetSRID(${ns}.ST_MakePoint(lng,lat),4326)::${ns}.geography,${ns}.ST_SetSRID(${ns}.ST_MakePoint($7,$8),4326)::${ns}.geography,$9)`;
      }
      const candidates = await q.query(
        `SELECT * FROM private_incidents.incidents WHERE merged_into IS NULL AND status<>'RESOLVED' AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
        AND latest_reported_at >= $5::timestamptz-($6*interval '1 hour') AND first_reported_at <= $5::timestamptz+($6*interval '1 hour')${spatial} ORDER BY latest_reported_at DESC,id LIMIT 101`,
        args,
      );
      const ranked: any[] = [];
      let incompatible = false;
      for (const candidate of candidates.slice(0, 100)) {
        if (!geoTemporalMatch(report, candidate, config)) continue;
        if (
          !candidate.analysis_complete ||
          candidate.embedding_fingerprint !== fingerprint ||
          !candidate.centroid
        ) {
          incompatible = true;
          continue;
        }
        const score = cosine(embedding, candidate.centroid);
        ranked.push({
          incidentId: candidate.id,
          version: candidate.version,
          title: candidate.title,
          score,
          distanceMeters: Math.round(distance(report, candidate)),
        });
      }
      ranked.sort((a, b) => b.score - a.score);
      const winner = ranked[0],
        runner = ranked[1];
      const high =
        winner &&
        winner.score >= config.similarity &&
        (!runner || winner.score - runner.score >= config.margin) &&
        !incompatible &&
        candidates.length <= 100;
      if (high && automaticAllowed(fingerprint)) {
        await this.repo.attach(q, winner.incidentId, reportId, false);
        await this.repo.audit(
          q,
          winner.incidentId,
          null,
          "report.auto_attached",
          "",
          { reportId, revision, score: winner.score, pipeline: PIPELINE },
        );
      } else if (ranked.length || incompatible || candidates.length > 100) {
        await this.repo.review(
          q,
          reportId,
          revision,
          incompatible
            ? "incompatible_analysis"
            : high
              ? "suggested_match"
              : "ambiguous_match",
          ranked.slice(0, 5),
        );
      } else {
        const id = await this.repo.createIncident(q, report);
        await this.repo.attach(q, id, reportId, false);
        await this.repo.audit(q, id, null, "incident.detected", "", {
          reportId,
          revision,
        });
      }
      return "succeeded";
    });
  }
  async summarize(job: any): Promise<string> {
    const { incidentId, evidenceVersion } = job.payload;
    const [incident] = await this.repo.db.query(
      "SELECT * FROM private_incidents.incidents WHERE id=$1",
      [incidentId],
    );
    if (
      !incident ||
      incident.merged_into ||
      incident.evidence_version !== evidenceVersion
    )
      return "obsolete";
    const rows = await this.repo.ledger(incidentId);
    if (!rows.length) return "obsolete";
    if (rows.some((r) => !r.result)) {
      const [failed] = await this.repo.db.query(
        "SELECT id FROM private_incidents.jobs WHERE kind='analyze' AND status='failed' AND (payload->>'reportId')::int=ANY($1::int[]) LIMIT 1",
        [rows.filter((r) => !r.result).map((r) => r.report_id)],
      );
      if (failed) throw new Error("source_analysis_failed");
      throw new Error("analysis_pending");
    }
    const facts = this.repo.facts(rows);
    // Fixed evidence IDs, extractive claims, and server-rendered quantities prevent invented facts.
    const evidence = [
      ...facts.filter((f) =>
        [
          "depth",
          "emergency",
          "blocked_road",
          "stranded_people",
          "stranded_vehicles",
        ].includes(f.kind),
      ),
      ...facts.slice().reverse(),
    ];
    const bounded = [...new Map(evidence.map((f) => [f.id, f])).values()].slice(
      0,
      120,
    );
    const selection = await this.model.structured<any>(
      SUMMARY_INSTRUCTION,
      {
        facts: bounded,
        emergency: rows.some((r) => r.emergency),
        blockedRoad: rows.some((r) => r.result.blockedRoad),
      },
      SUMMARY_SCHEMA,
      AbortSignal.timeout(125000),
    );
    const summary = {
      ...renderSummary(selection, incident, rows, bounded),
      depths: facts.filter((f) => f.kind === "depth"),
      analyzedFactCount: facts.length,
      modelFactCount: bounded.length,
    };
    return this.repo.db.transaction(async (q) => {
      await this.repo.lock(q);
      if (!(await this.lease(q, job))) return "obsolete";
      const [i] = await q.query(
        "SELECT * FROM private_incidents.incidents WHERE id=$1 FOR UPDATE",
        [incidentId],
      );
      if (i.merged_into || i.evidence_version !== evidenceVersion)
        return "obsolete";
      await q.query(
        `INSERT INTO private_incidents.summaries(incident_id,evidence_version,content,model,job_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING`,
        [
          incidentId,
          evidenceVersion,
          JSON.stringify(summary),
          process.env.OPENAI_CHAT_MODEL ?? "gpt-4.1-nano-2025-04-14",
          job.id,
        ],
      );
      await q.query(
        "UPDATE private_incidents.incidents SET title=$2,updated_at=now() WHERE id=$1",
        [incidentId, summary.title],
      );
      await this.repo.audit(q, incidentId, null, "summary.generated", "", {
        evidenceVersion,
      });
      await this.repo.event(q, "incident.updated", { incidentId });
      return "succeeded";
    });
  }
  async publish() {
    if (this.publishing || !this.repo.ready || this.stopping) return;
    this.publishing = true;
    try {
      await this.repo.db.transaction(async (q) => {
        const rows = await q.query(
          "SELECT * FROM private_incidents.outbox WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 50",
        );
        for (const row of rows) {
          let timer: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([
              this.redis.publish(
                "incidents.events",
                JSON.stringify({
                  id: row.id,
                  event: row.event,
                  ...row.payload,
                }),
              ),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("notification_timeout")),
                  2000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          await q.query(
            "UPDATE private_incidents.outbox SET published_at=now() WHERE id=$1",
            [row.id],
          );
        }
      });
    } catch {
      this.logger.warn("Incident notifications delayed", {
        code: "incident_outbox_unavailable",
      });
    } finally {
      this.publishing = false;
    }
  }
}
