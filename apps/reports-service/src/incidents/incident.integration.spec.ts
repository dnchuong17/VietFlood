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
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IncidentRepository } from "./incident.repository";
import { IncidentWorker } from "./incident.worker";
import { ReportEntity } from "../entity/report.entity";
import { ReportsService } from "../reports-service.service";
import { PIPELINE } from "./incident-domain";
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
      conditionFactIds: [`${reportId}:1:0`],
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
