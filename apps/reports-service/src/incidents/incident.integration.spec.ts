import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { DataSource } from "typeorm";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { IncidentRepository } from "./incident.repository";
import { IncidentWorker } from "./incident.worker";
import { ReportEntity } from "../entity/report.entity";
import { ReportsService } from "../reports-service.service";
import { PIPELINE, hash, matchingConfig } from "./incident-domain";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PassportModule } from "@nestjs/passport";
import { JwtService } from "@nestjs/jwt";
import { defer } from "rxjs";
import { JwtStrategy } from "../../../api-gateway/src/auth/strategy/jwt.strategy";
import {
  IncidentsController,
  IncidentProcessingController,
} from "../../../api-gateway/src/incidents/incident.controller";
import { IncidentGatewayService } from "../../../api-gateway/src/incidents/incident.http";
import { IncidentRpcController } from "./incident.controller";
import { ReportsController as ReportHttpController } from "../../../api-gateway/src/reports/reports.controller";
import { ReportsService as ReportGatewayService } from "../../../api-gateway/src/reports/reports.service";
import { ReportsController as ReportRpcController } from "../reports-service.controller";

const url = process.env.INCIDENT_TEST_DATABASE_URL;
const admin = { userId: 1, role: "admin" },
  relief = { userId: 2, role: "relief" };
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  setServiceName: vi.fn(),
};
const redis = { set: vi.fn(), get: vi.fn(), del: vi.fn(), publish: vi.fn() };
const cloud = { deleteMany: vi.fn() };
describe.skipIf(!url)("incident PostgreSQL transactions", () => {
  let db: DataSource,
    repo: IncidentRepository,
    reports: ReportsService,
    worker: IncidentWorker;
  let app: Awaited<ReturnType<typeof NestFactory.create>>, base: string;
  const signing = new JwtService({
    secret: "isolated-incidents-http-test-secret",
  });
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
      parsed.port !== "55439" ||
      parsed.pathname !== "/vietflood_incidents_test"
    )
      throw new Error("Tests require the isolated incident database");
    db = new DataSource({
      type: "postgres",
      url,
      entities: [ReportEntity],
      synchronize: false,
      extra: { max: 8 },
    });
    await db.initialize();
    await db.query(`CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,role text NOT NULL);
     CREATE TABLE IF NOT EXISTS public.reports(id serial PRIMARY KEY,category text[],description text NOT NULL,images text[],evidences jsonb DEFAULT '[]',province text NOT NULL,ward text NOT NULL,"addressLine" text NOT NULL,
     lat double precision,lng double precision,status text DEFAULT 'pending',"createdBy" text,"isUrgent" boolean DEFAULT false,severity int DEFAULT 0,"userId" int NOT NULL,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());`);
    await db.query(
      readFileSync("db/migrations/20261101_incidents.sql", "utf8"),
    );
    await db.query(readFileSync("db/migrations/20261106_incident_intelligence.sql", "utf8"));
    repo = new IncidentRepository(db);
    await repo.onModuleInit();
    reports = new ReportsService(
      db.getRepository(ReportEntity),
      redis as never,
      logger as never,
      cloud as never,
      repo,
    );
    worker = new IncidentWorker(repo, redis as never, logger as never);
    process.env.JWT_SECRET = "isolated-incidents-http-test-secret";
    const rpc = new IncidentRpcController(repo);
    const gateway = new IncidentGatewayService({
      send: (pattern: string, payload: any) =>
        defer(async () => {
          try {
            return await (pattern === "incidents.read"
              ? rpc.read(payload)
              : rpc.mutate(payload));
          } catch (e) {
            throw e.getError?.() ?? e;
          }
        }),
    } as never);
    const reportRpc = new ReportRpcController(reports, logger as never);
    const reportGateway = new ReportGatewayService(
      {
        send: (_pattern: string, payload: unknown) =>
          defer(() => reportRpc.delete(payload)),
      } as never,
      logger as never,
      cloud as never,
      {} as never,
    );
    class HttpModule {}
    Module({
      imports: [PassportModule],
      controllers: [
        IncidentsController,
        IncidentProcessingController,
        ReportHttpController,
      ],
      providers: [
        JwtStrategy,
        { provide: IncidentGatewayService, useValue: gateway },
        { provide: ReportGatewayService, useValue: reportGateway },
      ],
    })(HttpModule);
    app = await NestFactory.create(HttpModule, {
      logger: false,
      abortOnError: false,
    });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  }, 20000);
  beforeEach(async () => {
    vi.stubEnv("INCIDENTS_ENABLED", "true");
    vi.stubEnv("INCIDENT_MATCH_MODE", "review");
    vi.stubEnv("RAG_SERVICE_URL", "http://127.0.0.1:8001");
    vi.stubEnv("RAG_SERVICE_TOKEN", "test-only");
    await db.query(
      "TRUNCATE private_incidents.receipts,private_incidents.outbox,private_incidents.audit,private_incidents.jobs,private_incidents.summaries,private_incidents.assignments,private_incidents.reviews,private_incidents.memberships,private_incidents.analysis,private_incidents.report_revisions,private_incidents.retained_reports,private_incidents.incidents,public.reports,public.users RESTART IDENTITY CASCADE",
    );
    await db.query(
      "INSERT INTO users VALUES(1,'admin'),(2,'relief'),(3,'citizen'),(4,'relief')",
    );
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: any) => {
        const input = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            pipeline: PIPELINE,
            fingerprint: "fixture-model",
            normalizedText: input.description, matchingText: input.description, normalizationVersion: "fixture-v2",
            embedding: [1, ...new Array(1535).fill(0)],
            facts: [{ kind: "condition", text: input.description }],
            hasFloodEvidence: true,
            ambiguousLocation: false,
            blockedRoad: false,
            strandedPeople: false,
            strandedVehicles: false,
          }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });
  const input = (extra: any = {}) => ({
    description: "Đường ngập 50 cm",
    category: ["flood"],
    province: "Đà Nẵng",
    ward: "Hải Châu",
    addressLine: "12 đường A",
    lat: 16.047,
    lng: 108.206,
    ...extra,
  });
  async function create(extra: any = {}) {
    return (await reports.createReport(input(extra), 3, randomUUID())).reportId;
  }
  async function analyzeOne() {
    const job = await worker.claim();
    expect(job.kind).toBe("analyze");
    const status = await worker.analyze(job);
    await db.query("UPDATE private_incidents.jobs SET status=$2 WHERE id=$1", [
      job.id,
      status,
    ]);
    return job;
  }
  async function link(reportId: number) {
    const t = await repo.retained(reportId);
    return (
      await repo.mutate(
        admin,
        "resolve",
        String(reportId),
        {
          action: "create",
          expectedRevision: t.revision,
          reason: "Đã xem bằng chứng",
        },
        randomUUID(),
      )
    ).incidentId;
  }
  const range = () => ({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
  });
  function http(path: string, actor: any = admin, method = "GET", body?: any, key?: string) {
    return fetch(base + path, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${signing.sign({ sub: actor.userId, role: actor.role, username: "isolated-fixture" })}` } : {}),
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  it("recovers HTTP reads and database mutations after migration without restarting", async () => {
    vi.unstubAllGlobals();
    vi.stubEnv("INCIDENTS_ENABLED", "false");
    const migration = readFileSync(
      "db/migrations/20261101_incidents.sql",
      "utf8",
    );
    const headers = {
      Authorization: `Bearer ${signing.sign({ sub: relief.userId, role: relief.role, username: "fixture" })}`,
    };
    // The suite validates the isolated localhost database URL before connecting.
    await db.query("DROP SCHEMA private_incidents CASCADE");
    const writer = new IncidentRepository(db);
    try {
      await repo.onModuleInit();
      await writer.onModuleInit();
      expect(repo.ready).toBe(false);
      for (const path of ["/incidents/emergencies", "/incidents/overview"]) {
        const response = await fetch(base + path, { headers });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          statusCode: 503,
          code: "incidents_unavailable",
          message: "Incident service is unavailable",
          requestId: expect.any(String),
        });
      }
      await db.query(migration);
      const feed = await fetch(base + "/incidents/emergencies", { headers });
      expect(feed.status).toBe(200);
      expect(await feed.json()).toEqual({ items: [], nextCursor: null });
      const overview = await fetch(base + "/incidents/overview", { headers });
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({
        totalIncidents: 0,
        processingEnabled: false,
      });
      expect(repo.enabled).toBe(false);
      expect(
        await db.query("SELECT * FROM private_incidents.jobs"),
      ).toHaveLength(0);
      vi.stubEnv("INCIDENTS_ENABLED", "true");
      const reportId = await create({
        description: "Có người mắc kẹt, cứu với!",
      });
      vi.stubEnv("INCIDENTS_ENABLED", "false");
      const populated = await fetch(base + "/incidents/emergencies", {
        headers,
      });
      expect(populated.status).toBe(200);
      expect((await populated.json()).items).toMatchObject([
        { report_id: reportId },
      ]);
      expect(writer.ready).toBe(false);
      await expect(
        writer.mutate(admin, "resolve", String(reportId), {
          action: "exclude",
          expectedRevision: 1,
          reason: "Isolated recovery test",
        }),
      ).resolves.toMatchObject({ reportId, excluded: true });
      expect(writer.ready).toBe(true);
      expect(
        (
          await db.query(
            "SELECT review_state FROM private_incidents.retained_reports WHERE report_id=$1",
            [reportId],
          )
        )[0].review_state,
      ).toBe("excluded");
      expect(
        (
          await (
            await fetch(base + "/incidents/emergencies", { headers })
          ).json()
        ).items,
      ).toEqual([]);
    } finally {
      await db.query(migration);
      await db.query(readFileSync("db/migrations/20261106_incident_intelligence.sql", "utf8"));
      await repo.onModuleInit();
    }
  });
  it("retains reports and media through edits and archival", async () => {
    const id = await create({
      evidences: [
        { url: "https://example.test/a.jpg", publicId: "evidence-a" },
      ],
    });
    await reports.updateReport(id, 3, { description: "Nước đã rút còn 20 cm" });
    const rows = await db.query(
      "SELECT snapshot FROM private_incidents.report_revisions WHERE report_id=$1 ORDER BY revision",
      [id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].snapshot.description).toBe("Đường ngập 50 cm");
    expect(rows[1].snapshot.evidences).toEqual(rows[0].snapshot.evidences);
    await expect(reports.deleteReport(id, 3)).resolves.toMatchObject({
      archived: true,
    });
    expect(await reports.getAllReports()).toHaveLength(0);
    expect(cloud.deleteMany).not.toHaveBeenCalled();
    expect(
      await db.query("SELECT id FROM reports WHERE id=$1", [id]),
    ).toHaveLength(1);
    await expect(
      db.query(
        "UPDATE private_incidents.report_revisions SET content_hash='changed' WHERE report_id=$1",
        [id],
      ),
    ).rejects.toThrow("append-only");
  });
  it("attributes archival to the authenticated actor across all report deletion routes", async () => {
    vi.unstubAllGlobals();
    for (const actor of [admin, relief, { userId: 3, role: "citizen" }]) {
      const id = await create();
      const path =
        actor.role === "admin"
          ? `/reports/update/${id}/admin/3`
          : actor.role === "relief"
            ? `/reports/relief/${id}/user/3`
            : `/reports/${id}`;
      const token = signing.sign({
        sub: actor.userId,
        role: actor.role,
        username: "fixture",
      });
      const response = await fetch(base + path, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ archived: true });
      const [event] = await db.query(
        "SELECT actor_id FROM private_incidents.audit WHERE action='report.archived' AND details->>'reportId'=$1",
        [String(id)],
      );
      expect(event.actor_id).toBe(actor.userId);
      await reports.deleteReport(id, 3, actor);
      expect(
        await db.query(
          "SELECT id FROM private_incidents.audit WHERE action='report.archived' AND details->>'reportId'=$1",
          [String(id)],
        ),
      ).toHaveLength(1);
    }
    const legacy = await create();
    await reports.deleteReport(legacy, 3);
    const [event] = await db.query(
      "SELECT actor_id FROM private_incidents.audit WHERE action='report.archived' AND details->>'reportId'=$1",
      [String(legacy)],
    );
    expect(event.actor_id).toBeNull();
  });
  it("deduplicates concurrent report creation and enqueues one analysis", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reports.createReport(input(), 3, key)),
    );
    expect(new Set(results.map((r) => r.reportId)).size).toBe(1);
    expect(await db.query("SELECT * FROM reports")).toHaveLength(1);
    expect(
      await db.query(
        "SELECT * FROM private_incidents.jobs WHERE kind='analyze'",
      ),
    ).toHaveLength(1);
  });
  it("surfaces emergencies before analysis even when AI is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const started = Date.now(),
      id = await create({ description: "Có người mắc kẹt, cứu với!" });
    const feed = await repo.read(relief, "emergencies", "");
    expect(feed.items[0].report_id).toBe(id);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(
      await db.query("SELECT * FROM private_incidents.incidents"),
    ).toHaveLength(0);
    redis.publish.mockRejectedValueOnce(
      new Error("socket_delivery_unavailable"),
    );
    await worker.publish();
    expect(
      (await db.query("SELECT published_at FROM private_incidents.outbox"))[0]
        .published_at,
    ).toBeNull();
    expect(
      (await repo.read(relief, "emergencies", "")).items[0].report_id,
    ).toBe(id);
    await worker.publish();
    expect(redis.publish).toHaveBeenCalledWith(
      "incidents.events",
      expect.stringContaining("emergency"),
    );
  });
  it("creates a singleton and holds nearby reports for review", async () => {
    const first = await create();
    await analyzeOne();
    const second = await create({ description: "duong ngap nuoc 50cm" });
    await db.query(
      "UPDATE private_incidents.jobs SET status='obsolete' WHERE kind='summary'",
    );
    await analyzeOne();
    const incidents = await repo.list(admin, {});
    expect(incidents.items).toHaveLength(1);
    expect(incidents.items[0].reportCount).toBe(1);
    const pending = await repo.read(admin, "review", "");
    expect(pending.items[0]).toMatchObject({
      report_id: second,
      reason: "suggested_match",
    });
    expect(pending.items[0].candidates[0].score).toBeCloseTo(1);
    expect(
      (await repo.read(admin, "reports", incidents.items[0].id)).items[0].id,
    ).toBe(first);
  });
  it("never guesses missing GPS", async () => {
    const id = await create({ lat: undefined, lng: undefined });
    await analyzeOne();
    expect((await repo.read(admin, "review", "")).items[0]).toMatchObject({
      report_id: id,
      reason: "missing_coordinates",
    });
  });
  it("preserves membership history on merge and split and rejects stale versions", async () => {
    const a = await create(),
      b = await create(),
      ia = await link(a),
      ib = await link(b);
    const one = await repo.detail(ia),
      two = await repo.detail(ib);
    await repo.mutate(
      admin,
      "merge",
      "",
      {
        targetId: ia,
        expectedVersion: one.version,
        sources: [{ id: ib, expectedVersion: two.version }],
        reason: "Cùng một điểm ngập",
      },
      randomUUID(),
    );
    expect((await repo.detail(ia)).reportCount).toBe(2);
    expect((await repo.detail(ib)).merged_into).toBe(ia);
    await expect(
      repo.mutate(admin, "severity", ia, {
        expectedVersion: one.version,
        severity: "HIGH",
        reason: "Kiểm tra",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const merged = await repo.detail(ia);
    const split = await repo.mutate(
      admin,
      "split",
      ia,
      {
        expectedVersion: merged.version,
        reportIds: [b],
        reason: "Khác vị trí",
      },
      randomUUID(),
    );
    expect(await repo.detail(split.incidentId)).toMatchObject({
      status: "UNDER_REVIEW",
      assignee_id: null,
      reportCount: 1,
    });
    expect((await repo.detail(ia)).reportCount).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM private_incidents.memberships WHERE report_id=$1",
          [b],
        )
      )[0].count,
    ).toBe(3);
  });
  it("serializes simultaneous merge and split decisions and preserves manual memberships on reprocessing", async () => {
    const a = await create(),
      b = await create(),
      c = await create();
    const target = await link(a),
      source = await link(c);
    await repo.mutate(
      admin,
      "resolve",
      String(b),
      {
        action: "attach",
        expectedRevision: 1,
        reason: "Cùng vị trí",
        incidentId: target,
        expectedVersion: (await repo.detail(target)).version,
      },
      randomUUID(),
    );
    const version = (await repo.detail(target)).version;
    const decisions = await Promise.allSettled([
      repo.mutate(
        admin,
        "merge",
        "",
        {
          targetId: target,
          expectedVersion: version,
          reason: "Cùng vị trí",
          sources: [
            {
              id: source,
              expectedVersion: (await repo.detail(source)).version,
            },
          ],
        },
        randomUUID(),
      ),
      repo.mutate(
        admin,
        "split",
        target,
        {
          expectedVersion: version,
          reportIds: [b],
          reason: "Khác vị trí",
        },
        randomUUID(),
      ),
    ]);
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(decisions.find((r) => r.status === "rejected")).toMatchObject({
      reason: { statusCode: 409 },
    });
    const members = await db.query(
      "SELECT report_id,incident_id,manual FROM private_incidents.memberships WHERE left_at IS NULL ORDER BY report_id",
    );
    expect(members.map((r) => r.report_id)).toEqual([a, b, c]);
    const correction = members.find((r) => r.report_id === b);
    expect(correction.manual).toBe(true);
    await reports.updateReport(b, 3, { description: "Nước đã rút còn 20 cm" });
    await db.query(
      "UPDATE private_incidents.jobs SET status='obsolete' WHERE kind<>'analyze' OR payload->>'reportId'<>$1 OR payload->>'revision'<>'2'",
      [String(b)],
    );
    await analyzeOne();
    const [current] = await db.query(
      "SELECT incident_id,manual FROM private_incidents.memberships WHERE report_id=$1 AND left_at IS NULL",
      [b],
    );
    expect(current).toMatchObject({
      incident_id: correction.incident_id,
      manual: true,
    });
    expect(
      await db.query(
        "SELECT * FROM private_incidents.report_revisions WHERE report_id=$1",
        [b],
      ),
    ).toHaveLength(2);
  });
  it("enforces admin-only controls and assignment-scoped relief progress", async () => {
    const id = await link(await create());
    let i = await repo.detail(id);
    await expect(
      repo.mutate(relief, "severity", id, {
        expectedVersion: i.version,
        severity: "CRITICAL",
        reason: "test",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await repo.mutate(admin, "assignment", id, {
      expectedVersion: i.version,
      assigneeId: 2,
      reason: "Điều phối",
    });
    i = await repo.detail(id);
    expect(i.status).toBe("UNDER_REVIEW");
    await expect(
      repo.mutate({ userId: 4, role: "relief" }, "status", id, {
        expectedVersion: i.version,
        status: "RESCUE_DEPLOYED",
        reason: "Đã đến",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await repo.mutate(relief, "status", id, {
      expectedVersion: i.version,
      status: "RESCUE_DEPLOYED",
      reason: "Đã điều động",
    });
    expect((await repo.detail(id)).status).toBe("RESCUE_DEPLOYED");
  });
  it("claims each job once and recovers an expired lease without letting the old worker commit", async () => {
    await create();
    const jobs = await Promise.all([worker.claim(), worker.claim()]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const original = jobs.find(Boolean);
    await db.query(
      "UPDATE private_incidents.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [original.id],
    );
    const replacement = await worker.claim();
    expect(replacement.id).toBe(original.id);
    expect(replacement.lease_token).not.toBe(original.lease_token);
    expect(await worker.analyze(original)).toBe("obsolete");
    expect(await worker.analyze(replacement)).toBe("succeeded");
  });
  it("rejects old summary work after new evidence arrives", async () => {
    const reportId = await create();
    await analyzeOne();
    const job = await worker.claim();
    expect(job.kind).toBe("summary");
    await reports.updateReport(reportId, 3, {
      description: "Ngập tăng lên 60 cm",
    });
    expect(await worker.summarize(job)).toBe("obsolete");
  });
  it("protects citizen access and rolls back a partially invalid merge", async () => {
    await expect(
      repo.read({ userId: 3, role: "citizen" }, "list", ""),
    ).rejects.toMatchObject({ statusCode: 403 });
    const ia = await link(await create()),
      ib = await link(await create());
    const a = await repo.detail(ia),
      b = await repo.detail(ib);
    await expect(
      repo.mutate(
        admin,
        "merge",
        "",
        {
          targetId: ia,
          expectedVersion: a.version,
          sources: [
            { id: ib, expectedVersion: b.version },
            { id: randomUUID(), expectedVersion: 1 },
          ],
          reason: "Kiểm tra rollback",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await repo.detail(ib)).merged_into).toBeNull();
    expect((await repo.detail(ia)).reportCount).toBe(1);
  });
  it("serializes simultaneous related arrivals into one incident with review suggestions", async () => {
    await Promise.all(Array.from({ length: 8 }, () => create()));
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => worker.claim()),
    );
    await Promise.all(jobs.map((j) => worker.analyze(j)));
    expect((await repo.list(admin, {})).items).toHaveLength(1);
    expect((await repo.read(admin, "review", "")).items).toHaveLength(7);
  });
  it("regenerates summaries and keeps operator severity independent", async () => {
    const reportId = await create();
    await analyzeOne();
    const job = await worker.claim();
    const id = job.payload.incidentId;
    const selection = {
      titleKind: "FLOOD",
      conditionFactIds: [`${reportId}:1:${PIPELINE}:0`],
      updateFactIds: [],
      suggestedSeverity: "MODERATE",
      recommendedActions: ["VERIFY_ON_SITE"],
    };
    const mock = vi
      .spyOn(worker.model, "structured")
      .mockResolvedValue(selection);
    try {
      expect(await worker.summarize(job)).toBe("succeeded");
      await db.query(
        "UPDATE private_incidents.jobs SET status='succeeded' WHERE id=$1",
        [job.id],
      );
      let detail = await repo.detail(id);
      expect(detail.summary.totalReports).toBe(1);
      expect(detail.severity).toBe("UNKNOWN");
      const response = await repo.mutate(
        admin,
        "regenerate",
        id,
        { expectedVersion: detail.version, reason: "Đánh giá lại" },
        randomUUID(),
      );
      const regen = await worker.claim();
      expect(regen.id).toBe(response.jobId);
      expect(await worker.summarize(regen)).toBe("succeeded");
      expect(
        await db.query(
          "SELECT * FROM private_incidents.summaries WHERE incident_id=$1",
          [id],
        ),
      ).toHaveLength(2);
      detail = await repo.detail(id);
      expect(detail.summaryStale).toBe(false);
    } finally {
      mock.mockRestore();
    }
  });
  it("validates real HTTP requests, authenticated roles, errors and idempotent decisions", async () => {
    vi.unstubAllGlobals();
    const token = (actor: any) =>
      signing.sign(
        { sub: actor.userId, username: "test-only", role: actor.role },
        { expiresIn: "1h" },
      );
    const request = (
      path: string,
      actor: any,
      method = "GET",
      body?: any,
      key?: string,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}),
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await request("/incidents", null)).status).toBe(401);
    expect(
      (await request("/incidents", { userId: 3, role: "citizen" })).status,
    ).toBe(403);
    expect((await request("/incidents?limit=100000", admin)).status).toBe(400);
    const reportId = await create();
    const body = {
      action: "create",
      expectedRevision: 1,
      reason: "Kiểm tra HTTP",
    };
    expect(
      (
        await request(
          `/incidents/review/${reportId}/resolve`,
          admin,
          "POST",
          body,
        )
      ).status,
    ).toBe(400);
    const key = randomUUID(),
      first = await request(
        `/incidents/review/${reportId}/resolve`,
        admin,
        "POST",
        body,
        key,
      );
    expect(first.status).toBe(200);
    const result = await first.json();
    const repeated = await request(
      `/incidents/review/${reportId}/resolve`,
      admin,
      "POST",
      body,
      key,
    );
    expect(await repeated.json()).toEqual(result);
    const detail = await (
      await request(`/incidents/${result.incidentId}`, admin)
    ).json();
    expect(
      (
        await request(
          `/incidents/${result.incidentId}/severity`,
          relief,
          "PATCH",
          {
            expectedVersion: detail.version,
            severity: "CRITICAL",
            reason: "Không được phép",
          },
        )
      ).status,
    ).toBe(403);
    const conflict = await request(
      `/incidents/${result.incidentId}/severity`,
      admin,
      "PATCH",
      { expectedVersion: 999, severity: "HIGH", reason: "Dữ liệu cũ" },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "version_conflict",
      statusCode: 409,
      requestId: expect.any(String),
    });
    const invalid = await request(
      `/incidents/${result.incidentId}/status`,
      admin,
      "PATCH",
      {
        expectedVersion: detail.version,
        status: "RESOLVED",
        reason: "Kiểm tra",
        actor: { role: "admin" },
      },
    );
    expect(invalid.status).toBe(400);
  });
  it("queues historical processing immediately and captures sources in resumable small transactions", async () => {
    await db.query(`INSERT INTO reports(description,province,ward,"addressLine","userId",lat,lng)
      SELECT 'Ngập 50 cm','Đà Nẵng','Hải Châu','Đường A',3,16.047,108.206 FROM generate_series(1,40)`);
    const ids = (await db.query("SELECT id FROM reports ORDER BY id")).map(
      (r) => r.id,
    );
    const result = await repo.mutate(
      admin,
      "process",
      "",
      { reportIds: ids },
      randomUUID(),
    );
    expect(
      await db.query("SELECT * FROM private_incidents.retained_reports"),
    ).toHaveLength(0);
    const first = await worker.claim();
    expect(first.kind).toBe("batch");
    expect(await worker.backfill(first)).toBe("pending");
    expect(
      await db.query("SELECT * FROM private_incidents.retained_reports"),
    ).toHaveLength(25);
    await create({ description: "Báo cáo mới trong khi xử lý lịch sử" });
    await db.query(
      "UPDATE private_incidents.jobs SET status='pending',available_at=now() WHERE id=$1",
      [first.id],
    );
    const resumed = await worker.claim();
    expect(resumed.id).toBe(result.jobId);
    expect(resumed.payload.cursor).toBe(25);
    expect(await worker.backfill(resumed)).toBe("succeeded");
    expect(
      await db.query("SELECT * FROM private_incidents.retained_reports"),
    ).toHaveLength(41);
    const progress = await repo.read(admin, "job", result.jobId);
    expect(progress.children).toEqual([{ status: "pending", count: 40 }]);
  });
  it("does not suppress an unresolved emergency when its source is archived", async () => {
    const id = await create({
      description: "Người mắc kẹt trong nhà ngập, cứu với!",
    });
    await reports.deleteReport(id, 3);
    expect(
      (await repo.read(relief, "emergencies", "")).items[0].report_id,
    ).toBe(id);
    const job = await worker.claim();
    expect(await worker.analyze(job)).toBe("succeeded");
    const incident = (await repo.list(admin, {})).items[0];
    expect(incident).not.toHaveProperty("centroid");
    expect(await repo.detail(incident.id)).not.toHaveProperty(
      "embedding_fingerprint",
    );
    expect(
      (await repo.read(admin, "source", incident.id, { reportId: id }))
        .archived_at,
    ).toBeTruthy();
  });
  it("executes calibrated automatic attachment and exposes normalization/relation without changing originals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-calibration-"));
    try {
      const evaluation = join(dir, "evaluation.json");
      writeFileSync(evaluation, JSON.stringify({ pipeline: PIPELINE, fingerprint: "fixture-model", configHash: hash(matchingConfig()), precision: 0.99, recall: 0.9, gateViolations: 0, positiveCases: 30, negativeCases: 30 }));
      vi.stubEnv("INCIDENT_MATCH_MODE", "automatic");
      vi.stubEnv("INCIDENT_EVALUATION_PATH", evaluation);
      const a = await create();
      await analyzeOne();
      await db.query("UPDATE private_incidents.jobs SET status='obsolete' WHERE kind='summary'");
      const b = await create();
      await analyzeOne();
      const [incident] = (await repo.list(admin, {})).items;
      expect(incident.reportCount).toBe(2);
      expect((await repo.read(admin, "review", "")).items).toEqual([]);
      expect(await db.query("SELECT manual FROM private_incidents.memberships WHERE report_id=$1", [b])).toEqual([{ manual: false }]);
      const sources = await repo.read(admin, "reports", incident.id);
      expect(sources.items[0]).toMatchObject({ id: a, snapshot: { description: "Đường ngập 50 cm", lat: 16.047, lng: 108.206 }, analysis: { pipeline: PIPELINE, normalizedText: "Đường ngập 50 cm", matchingText: "Đường ngập 50 cm" } });
      vi.stubEnv("INCIDENT_MATCH_MODE", "review");
      await db.query("UPDATE private_incidents.jobs SET status='obsolete' WHERE kind='summary'");
      await create();
      await analyzeOne();
      expect((await repo.read(admin, "review", "")).items[0].candidates[0]).toMatchObject({ relation: "possible_duplicate", matchingReportIds: [a, b], distanceMeters: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["missing GPS", "negated evidence", "different time", "different location", "different model", "invalid calibration"])("blocks automatic matching for %s", async (gate) => {
    const dir = mkdtempSync(join(tmpdir(), "incident-calibration-gates-"));
    try {
      const evaluation = join(dir, "evaluation.json");
      writeFileSync(evaluation, JSON.stringify({ pipeline: PIPELINE, fingerprint: "fixture-model", configHash: hash(matchingConfig()), precision: gate === "invalid calibration" ? 0.5 : 0.99, recall: 0.9, gateViolations: 0, positiveCases: 30, negativeCases: 30 }));
      vi.stubEnv("INCIDENT_MATCH_MODE", "automatic");
      vi.stubEnv("INCIDENT_EVALUATION_PATH", evaluation);
      await create(); await analyzeOne();
      const [target] = (await repo.list(admin, {})).items;
      await db.query("UPDATE private_incidents.jobs SET status='obsolete' WHERE kind='summary'");
      if (gate === "different time") await db.query("UPDATE private_incidents.incidents SET first_reported_at=now()-interval '7 days',latest_reported_at=now()-interval '7 days' WHERE id=$1", [target.id]);
      const second = await create(gate === "missing GPS" ? { lat: undefined, lng: undefined } : gate === "different location" ? { lat: 17.047 } : gate === "negated evidence" ? { description: "Không có ngập" } : {});
      if (gate === "different model" || gate === "negated evidence") {
        const original = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async (...args: any[]) => {
          const response = await (original as any)(...args), result = await response.json();
          return { ok: true, json: async () => ({ ...result, ...(gate === "different model" ? { fingerprint: "other-model" } : { hasFloodEvidence: false }) }) };
        }));
      }
      await analyzeOne();
      expect((await repo.detail(target.id)).reportCount).toBe(1);
      expect(await db.query("SELECT id FROM private_incidents.audit WHERE action='report.auto_attached' AND details->>'reportId'=$1", [String(second)])).toEqual([]);
      if (["missing GPS", "negated evidence", "different model", "invalid calibration"].includes(gate)) expect((await repo.read(admin, "review", "")).items[0].report_id).toBe(second);
      else expect((await repo.list(admin, {})).items).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps Admin edits append-only, idempotent and stale after evidence changes while AI regeneration preserves them", async () => {
    const reportId = await create(); await analyzeOne();
    const job = await worker.claim(), id = job.payload.incidentId;
    const mock = vi.spyOn(worker.model, "structured").mockResolvedValue({ titleKind: "FLOOD", conditionFactIds: [`${reportId}:1:${PIPELINE}:0`], updateFactIds: [], suggestedSeverity: "LOW", recommendedActions: [] });
    try {
      await worker.summarize(job);
      await db.query("UPDATE private_incidents.jobs SET status='succeeded' WHERE id=$1", [job.id]);
      const original = (await repo.detail(id)).summary;
      vi.unstubAllGlobals();
      const body = { expectedVersion: (await repo.detail(id)).version, title: "Admin xác nhận", body: "Bằng chứng cần kiểm tra. ".repeat(240), reason: "Đã kiểm tra nội dung" };
      const key = randomUUID();
      for (const actor of [relief, { userId: 3, role: "citizen" }]) expect((await http(`/incidents/${id}/summary-edits`, actor, "POST", body, key)).status).toBe(403);
      expect((await http(`/incidents/${id}/summary-edits`, admin, "POST", body)).status).toBe(400);
      const first = await http(`/incidents/${id}/summary-edits`, admin, "POST", body, key);
      expect(first.status).toBe(200);
      const edit = await first.json();
      expect(edit).toMatchObject({ title: body.title, body: body.body.trim(), reason: body.reason, actorId: 1, pipeline: PIPELINE, stale: false });
      expect(await (await http(`/incidents/${id}/summary-edits`, admin, "POST", body, key)).json()).toEqual(edit);
      expect((await http(`/incidents/${id}/summary-edits`, admin, "POST", { ...body, title: "Khác nội dung" }, key)).status).toBe(409);
      expect((await http(`/incidents/${id}/summary-edits`, admin, "POST", body, randomUUID())).status).toBe(409);
      expect((await (await http(`/incidents/${id}/summary-edits`, relief)).json()).items).toHaveLength(1);
      await expect(db.query("UPDATE private_incidents.summary_edits SET body='changed' WHERE incident_id=$1", [id])).rejects.toThrow("append-only");
      await expect(db.query("DELETE FROM private_incidents.summary_edits WHERE incident_id=$1", [id])).rejects.toThrow("append-only");
      expect((await repo.detail(id)).summary).toEqual(original);
      await repo.mutate(admin, "regenerate", id, { expectedVersion: (await repo.detail(id)).version, reason: "Kiểm tra tạo lại" }, randomUUID());
      expect(await worker.summarize(await worker.claim())).toBe("succeeded");
      expect((await repo.detail(id)).editorialSummary.id).toBe(edit.id);
      await reports.updateReport(reportId, 3, { description: "Có người bất tỉnh, cần cứu hộ ngay" });
      expect(await repo.detail(id)).toMatchObject({ severity: "UNKNOWN", summaryStale: true, editorialSummary: { id: edit.id, stale: true }, priority: { value: "CRITICAL", sourceReportIds: [reportId], factIds: [] } });
    } finally { mock.mockRestore(); }
  });
  it("upgrades legacy verification/analysis without promoting facts, reprocessing history or destroying originals", async () => {
    const reportId = await create(), id = await link(reportId);
    await db.query("INSERT INTO private_incidents.analysis(report_id,revision,pipeline,result,embedding,fingerprint) VALUES($1,1,'incidents-v1',$2,$3,'old-model')", [reportId, JSON.stringify({ facts: [{ kind: "condition", text: "Đường ngập 50 cm" }] }), [1]]);
    const content = { pipeline: "incidents-v1", title: "Tóm tắt cũ", conditions: [] };
    await db.query("INSERT INTO private_incidents.summaries(incident_id,evidence_version,job_id,content,model) SELECT id,evidence_version,$2,$3,'old-model' FROM private_incidents.incidents WHERE id=$1", [id, randomUUID(), JSON.stringify(content)]);
    await db.query("UPDATE private_incidents.incidents SET verified_evidence_version=evidence_version,verified_facts=$2 WHERE id=$1", [id, JSON.stringify([`${reportId}:1:0`])]);
    await db.query("TRUNCATE private_incidents.jobs CASCADE");
    await db.query("DROP TABLE private_incidents.summary_edits; ALTER TABLE private_incidents.incidents DROP COLUMN verified_pipeline");
    try {
      const fixtureFetch = globalThis.fetch;
      vi.unstubAllGlobals();
      expect((await http("/incidents/report?" + new URLSearchParams(range()))).status).toBe(503);
      const require = createRequire(import.meta.url);
      const { applyIncidentMigrations } = require("../../../../scripts/migrate-incidents.js");
      const { Pool } = require("pg"), pool = new Pool({ connectionString: url, max: 1 });
      try { await applyIncidentMigrations(pool); await applyIncidentMigrations(pool); } finally { await pool.end(); }
      const detail = await repo.detail(id);
      expect(detail).toMatchObject({ needsVerification: true, analysisRequired: true, summary: content, summaryStale: true, facts: [{ pipeline: "incidents-v1", stale: true, provenance: "citizen_reported" }] });
      expect(await db.query("SELECT id FROM private_incidents.jobs")).toEqual([]);
      await expect(repo.mutate(admin, "verify", id, { expectedVersion: detail.version, factIds: [`${reportId}:1:0`], reason: "Cũ" }, randomUUID())).rejects.toMatchObject({ code: "analysis_required" });
      const queued = await repo.mutate(admin, "process", "", { reportIds: [reportId] }, randomUUID());
      const batch = await worker.claim(); expect(batch.id).toBe(queued.jobId);
      await worker.backfill(batch);
      expect(await db.query("SELECT pipeline FROM private_incidents.analysis")).toEqual([{ pipeline: "incidents-v1" }]);
      expect(await db.query("SELECT payload->>'pipeline' AS pipeline FROM private_incidents.jobs WHERE kind='analyze'")).toEqual([{ pipeline: PIPELINE }]);
      vi.stubGlobal("fetch", fixtureFetch);
      await analyzeOne();
      const current = await repo.detail(id);
      const currentId = `${reportId}:1:${PIPELINE}:0`;
      expect(current.facts.find((fact: any) => fact.id === currentId)).toMatchObject({ provenance: "citizen_reported", stale: false });
      await expect(repo.mutate(admin, "verify", id, { expectedVersion: current.version, factIds: [`${reportId}:1:0`], reason: "Mã cũ không hợp lệ" }, randomUUID())).rejects.toMatchObject({ code: "invalid_fact" });
      await repo.mutate(admin, "verify", id, { expectedVersion: current.version, factIds: [currentId], reason: "Xác minh bằng chứng hiện tại" }, randomUUID());
      expect((await repo.detail(id)).facts.find((fact: any) => fact.id === currentId).provenance).toBe("verified");
      expect((await repo.detail(id)).needsVerification).toBe(false);
      await reports.updateReport(reportId, 3, { description: "Nước đã rút" });
      expect((await repo.detail(id)).needsVerification).toBe(true);
      expect(await db.query("SELECT pipeline FROM private_incidents.analysis ORDER BY pipeline")).toEqual([{ pipeline: "incidents-v1" }, { pipeline: PIPELINE }]);
    } finally { await db.query(readFileSync("db/migrations/20261106_incident_intelligence.sql", "utf8")); }
  });
  it("computes real filtered analytics across pages, preserves ungrouped/missing GPS and bounds map coverage", async () => {
    for (let n = 0; n < 4; n++) {
      const id = await link(await create());
      await db.query("UPDATE private_incidents.incidents SET severity=$2,status=$3,assignee_id=$4 WHERE id=$1", [id, n < 2 ? "HIGH" : "LOW", n < 2 ? "VERIFIED" : "UNDER_REVIEW", n < 2 ? 2 : 4]);
    }
    await create(); await create({ lat: undefined, lng: undefined });
    await create({ province: "Huế" });
    const archived = await create(); await reports.deleteReport(archived, 3);
    // An original that has never been captured is counted too.
    await db.query(`INSERT INTO reports(description,province,ward,"addressLine","userId") VALUES('Chưa xử lý','Đà Nẵng','Hải Châu','A',3)`);
    vi.unstubAllGlobals();
    const q = new URLSearchParams({ ...range(), province: "Đà Nẵng", mapLimit: "1" });
    const response = await http("/incidents/analytics?" + q, relief);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ totalIncidents: 4, totalReports: 7, linkedReports: 4, ungroupedReports: 3, missingGpsReports: 2, map: { incidentTotal: 4, incidentReturned: 1, densityReportTotal: 5, truncated: true, limit: 1 } });
    expect(result.dailyReports.reduce((n: number, d: any) => n + d.count, 0)).toBe(7);
    let cursor: string | null = null; const ids: string[] = [];
    do {
      const query = new URLSearchParams({ province: "Đà Nẵng", limit: "1" });
      if (cursor) query.set("cursor", cursor);
      const list = await (await http("/incidents?" + query)).json();
      ids.push(...list.items.map((i: any) => i.id)); cursor = list.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(4);
    const assigned = await (await http("/incidents/analytics?" + new URLSearchParams({ ...range(), province: "Đà Nẵng", ward: "Hải Châu", severity: "HIGH", status: "VERIFIED", assignedToMe: "true" }), relief)).json();
    expect(assigned).toMatchObject({ totalIncidents: 2, totalReports: 2, ungroupedReports: 0, missingGpsReports: 0 });
    for (const path of ["analytics", "report", "report.pdf"]) {
      expect((await http(`/incidents/${path}?${q}`, null)).status).toBe(401);
      expect((await http(`/incidents/${path}?${q}`, { userId: 3, role: "citizen" })).status).toBe(403);
    }
    expect((await http("/incidents/analytics?mapLimit=1001")).status).toBe(400);
    expect((await http("/incidents/report?from=2026-01-01&to=2026-03-01")).status).toBe(400);
  });
  it("uses a real repeatable-read report snapshot despite a concurrent evidence write", async () => {
    const id = await link(await create());
    const originalTransaction = db.transaction.bind(db);
    let inserted = false;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (isolation: any, callback?: any) => {
      if (typeof isolation === "function") return originalTransaction(isolation);
      return originalTransaction(isolation, async (manager) => {
        const originalQuery = manager.query.bind(manager);
        manager.query = (async (sql: string, parameters?: any[]) => {
          const result = await originalQuery(sql, parameters);
          if (!inserted && sql.includes('AS "totalIncidents"')) {
            inserted = true;
            await db.query(`INSERT INTO reports(description,province,ward,"addressLine","userId") VALUES('Sau khi chốt','Đà Nẵng','Hải Châu','A',3)`);
            await db.query("INSERT INTO private_incidents.incidents(id,title,first_reported_at,latest_reported_at) VALUES($1,'Sự cố sau khi chốt',now(),now())", [randomUUID()]);
          }
          return result;
        }) as any;
        return callback(manager);
      });
    });
    try {
      const report = await repo.read(admin, "report", "", range());
      expect(inserted).toBe(true);
      expect(report.analytics.totalReports).toBe(1);
      expect(report.analytics.totalIncidents).toBe(1);
      expect(report.incidents.map((i: any) => i.id)).toEqual([id]);
      expect(report.generatedAt).toBe(report.analytics.generatedAt);
      expect(report.filters).toEqual(report.analytics.filters);
      expect((await db.query("SELECT count(*)::int AS count FROM reports"))[0].count).toBe(2);
      expect((await db.query("SELECT count(*)::int AS count FROM private_incidents.incidents"))[0].count).toBe(2);
    } finally { spy.mockRestore(); }
  });
  it("rejects real report/PDF overflow rather than silently truncating and enforces UTF-8 payload size", async () => {
    await db.query(`INSERT INTO private_incidents.incidents(id,title,first_reported_at,latest_reported_at) SELECT md5('overflow-' || n)::uuid,'Kiểm tra giới hạn',now(),now() FROM generate_series(1,1001) n`);
    vi.unstubAllGlobals();
    for (const path of ["report", "report.pdf"]) {
      const response = await http(`/incidents/${path}?${new URLSearchParams(range())}`, relief);
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "report_too_large" });
    }
    await db.query("TRUNCATE private_incidents.incidents CASCADE");
    const id = await link(await create());
    await db.query("INSERT INTO private_incidents.summaries(incident_id,evidence_version,job_id,content,model) VALUES($1,1,$2,$3,'fixture')", [id, randomUUID(), JSON.stringify({ pipeline: PIPELINE, title: "Nội dung lớn", conditions: [{ text: "ậ".repeat(700000) }] })]);
    const response = await http(`/incidents/report?${new URLSearchParams(range())}`);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: "report_too_large" });
  });
  it("serves an authenticated Vietnamese multi-page PDF from the local DB/HTTP report API", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) {
      const reportId = await create({ description: "Có người bất tỉnh, cần cứu hộ ngay" });
      const id = await link(reportId); ids.push(id);
      await repo.mutate(admin, "edit-summary", id, { expectedVersion: (await repo.detail(id)).version, title: `Ngập lụt tại Hải Châu ${n + 1}`, body: "Đã ghi nhận nước dâng và người cần hỗ trợ. Cần xác minh tại hiện trường. ".repeat(10) + " Gọi 0912345678 hoặc secret@example.com", reason: "Tổng hợp bằng chứng tiếng Việt" }, randomUUID());
      if (n === 0) {
        await db.query("INSERT INTO private_incidents.summaries(incident_id,evidence_version,job_id,content,model) SELECT id,evidence_version,$2,$3,'fixture-legacy' FROM private_incidents.incidents WHERE id=$1", [id, randomUUID(), JSON.stringify({ pipeline: "incidents-v1", title: "Tóm tắt AI cũ", conditions: [{ id: `${reportId}:1:incidents-v1:0`, reportId, text: "Có người bất tỉnh, cần cứu hộ ngay" }], recommendations: [] })]);
        await reports.updateReport(reportId, 3, { description: "Có người bất tỉnh, cần cứu hộ ngay. Nước đang dâng." });
      }
    }
    vi.unstubAllGlobals();
    const query = new URLSearchParams({ ...range(), province: "Đà Nẵng" });
    const json = await (await http("/incidents/report?" + query, relief)).json();
    expect(json).toMatchObject({ coverage: { complete: true, incidentCount: 12 }, analytics: { totalIncidents: 12, totalReports: 12 } });
    expect(json.generatedAt).toBe(json.analytics.generatedAt);
    expect(json.incidents[0].priority.value).toBe("CRITICAL");
    expect(json.incidents.find((incident: any) => incident.id === ids[0])).toMatchObject({ summaryStale: true, editorialSummary: { stale: true }, summary: { pipeline: "incidents-v1" } });
    expect(JSON.stringify(json)).not.toMatch(/0912345678|secret@example.com/);
    const response = await http("/incidents/report.pdf?" + query, relief);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("/FontFile2");
    const directory = mkdtempSync(join(tmpdir(), "incident-intelligence-http-"));
    writeFileSync(join(directory, "report.pdf"), bytes);
    writeFileSync(join(directory, "report.json"), JSON.stringify(json, null, 2));
    writeFileSync(join(directory, "evidence.json"), JSON.stringify({ boundary: "real PostgreSQL + local Nest HTTP/JWT; in-process RPC transport; model/broker not contacted", reportIds: ids, bytes: bytes.length, pdfStatus: response.status, font: "assets/fonts/NotoSans-Regular.ttf" }, null, 2));
    console.log(`INCIDENT_PDF_EVIDENCE=${directory}`);
  });
  it("dead-letters repeatedly abandoned work instead of retrying forever", async () => {
    const id = await create();
    const job = await worker.claim();
    await db.query(
      "UPDATE private_incidents.jobs SET attempts=5,lease_until=now()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    expect(await worker.claim()).toBeUndefined();
    expect(await repo.read(admin, "job", job.id)).toMatchObject({
      status: "failed",
      failure_code: "lease_expired",
    });
    expect((await repo.read(admin, "review", "")).items[0]).toMatchObject({
      report_id: id,
      reason: "analysis_unavailable",
    });
  });
});
