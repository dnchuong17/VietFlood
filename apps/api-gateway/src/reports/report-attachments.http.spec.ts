import "reflect-metadata";
import { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { defer } from "rxjs";
import { DataSource, Repository } from "typeorm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtStrategy } from "../auth/strategy/jwt.strategy";
import { ChatController } from "../chat/chat.controller";
import { ChatService } from "../chat/chat.service";
import { ChatActionService } from "../chat/chat-action.service";
import { ChatAuditInterceptor } from "../chat/chat-audit.interceptor";
import { ChatCryptoService } from "../chat/chat-crypto.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportsService as PersistenceService } from "../../../reports-service/src/reports-service.service";
import { ReportsController as RpcController } from "../../../reports-service/src/reports-service.controller";
import { ReportEntity } from "../../../reports-service/src/entity/report.entity";

// Real loopback HTTP, Multer, validation, JWT, ChatService, ChatActionService,
// AES-GCM, gateway upload mapping and reports microservice/controller logic.
// Cloudinary, RPC transport, Redis and chat history are explicit doubles.
// Default: repository double. Opt-in: actual TypeORM/PostgreSQL repository,
// using only an owned unique schema in the allowlisted disposable local DB.
// Opt in: REPORT_ATTACHMENTS_TEST_DATABASE_URL=postgresql://macbook@127.0.0.1:53132/report_attachments_test
// npm test -- apps/api-gateway/src/reports/report-attachments.http.spec.ts --reporter=verbose
const databaseUrl = process.env.REPORT_ATTACHMENTS_TEST_DATABASE_URL;
describe(`Report attachments HTTP/create/read contract (${databaseUrl ? "REAL PostgreSQL repository; external services doubled" : "in-memory repository; external services doubled"})`, () => {
  let database: DataSource | undefined;
  const schema = `qa_report_attachments_${randomUUID().replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;
  let token: string;
  const rows: ReportEntity[] = [];
  const values = new Map<string, string>();
  const sessions = new Set<string>();
  const locks = new Set<string>();
  const logger = { setServiceName: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const repositoryDouble = {
    create: vi.fn((value) => Object.assign(new ReportEntity(), value)),
    save: vi.fn(async (value) => {
      const saved = { ...value, id: rows.length + 1, status: "pending" };
      rows.push(structuredClone(saved));
      return structuredClone(saved);
    }),
    find: vi.fn(async (options) => structuredClone(options.where ? rows.filter(row => row.userId === options.where.userId) : rows)),
  };
  let repository: typeof repositoryDouble | Repository<ReportEntity> = repositoryDouble;
  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); return "OK"; }),
    del: vi.fn(async (key: string) => Number(locks.delete(key) || values.delete(key))),
    getClient: () => ({
      multi: () => {
        const transaction = { incr: () => transaction, expire: () => transaction, exec: async () => [[null, 1]] };
        return transaction;
      },
      set: async (key: string) => { if (locks.has(key)) return null; locks.add(key); return "OK"; },
    }),
  };
  const upload = vi.fn(async (_buffer: Buffer) => ({
    secure_url: "https://qa.invalid/static-qa-image.png",
    public_id: "QA_ONLY/static-image", resource_type: "image",
  }));
  const history = {
    access: async (_user: number, session: string) => sessions.has(session) ? "owned" : "missing",
    recent: async () => [],
    create: async (_user: number, session: string) => { sessions.add(session); },
    append: async () => true,
  };
  const model = { isConfigured: () => false };
  // Static labeled PNG (1x1 pixel); never a public flood report or real upload.
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
  const oldEnvironment = { JWT_SECRET: process.env.JWT_SECRET, CHAT_KEYRING_B64: process.env.CHAT_KEYRING_B64, CHAT_KEY_CURRENT: process.env.CHAT_KEY_CURRENT, CHAT_HISTORY_ENABLED: process.env.CHAT_HISTORY_ENABLED };

  beforeAll(async () => {
    process.env.JWT_SECRET = "qa-only-attachments-http-secret";
    process.env.CHAT_KEY_CURRENT = "qa";
    process.env.CHAT_KEYRING_B64 = Buffer.from(JSON.stringify({ qa: Buffer.alloc(32, 42).toString("base64") })).toString("base64");
    process.env.CHAT_HISTORY_ENABLED = "true";
    if (databaseUrl) {
      const target = new URL(databaseUrl);
      if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || target.port !== "53132" || target.pathname !== "/report_attachments_test") {
        throw new Error("Refusing database outside the explicitly approved disposable local attachment-test database");
      }
      database = new DataSource({ type: "postgres", url: databaseUrl, schema, entities: [ReportEntity], synchronize: false, logging: false });
      await database.initialize();
      await database.query(`CREATE SCHEMA "${schema}"`);
      await database.synchronize();
      repository = database.getRepository(ReportEntity);
      // Call-through spy observes writes; no mocked DB results or operations.
      vi.spyOn(repository, "save");
    }
    const persistence = new PersistenceService(repository as never, redis as never, logger as never, {} as never);
    const rpc = new RpcController(persistence, logger as never);
    const client = {
      send: vi.fn((pattern: string, payload: any) => defer(async () => {
        // JSON roundtrip models a serialized broker boundary, not a live broker.
        const input = JSON.parse(JSON.stringify(payload));
        const output = pattern === "create" ? await rpc.create(input)
          : pattern === "get_all_by_users" ? await rpc.getAllById(input)
          : pattern === "" ? await rpc.getAll() : undefined;
        if (output === undefined) throw new Error(`Unexpected RPC pattern: ${pattern}`);
        return JSON.parse(JSON.stringify(output));
      })),
    };
    const reports = new ReportsService(client as never, logger as never, { uploadBuffer: upload } as never, {} as never);
    const actions = new ChatActionService(redis as never, reports, {} as never, model as never, logger as never, new ChatCryptoService());
    const chat = new ChatService(redis as never, reports, {} as never, history as never, logger as never, model as never, actions, {} as never);
    class AttachmentHttpModule {}
    Module({
      imports: [PassportModule], controllers: [ChatController, ReportsController],
      providers: [JwtStrategy, ChatAuditInterceptor,
        { provide: Reflect.getMetadata("design:paramtypes", ChatAuditInterceptor)[0], useValue: logger },
        { provide: ChatService, useValue: chat },
        { provide: Reflect.getMetadata("design:paramtypes", ChatController)[0], useValue: chat },
        { provide: ReportsService, useValue: reports },
        { provide: Reflect.getMetadata("design:paramtypes", ReportsController)[0], useValue: reports },
      ],
    })(AttachmentHttpModule);
    app = await NestFactory.create(AttachmentHttpModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    token = new JwtService({ secret: process.env.JWT_SECRET }).sign({ sub: 7, username: "QA_ONLY", role: "citizen" });
  });
  beforeEach(async () => {
    rows.length = 0; values.clear(); sessions.clear(); locks.clear(); vi.clearAllMocks();
    if (database?.isInitialized) await database.getRepository(ReportEntity).clear();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (database?.isInitialized) {
      await database.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.destroy();
    }
    for (const [key, value] of Object.entries(oldEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  async function postChat(body: Record<string, unknown> | FormData) {
    const response = await fetch(`${base}/chat`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function draft(location: Record<string, unknown> = {}) {
    const result = await postChat({ message: "Tạo báo cáo; loại: sự cố; mô tả: QA_ONLY static attachment contract; tỉnh: QA_ONLY; phường: QA_ONLY; địa chỉ: QA_ONLY isolated test", ...location });
    expect(result.status).toBe(200);
    expect(result.body.action.status).toBe("awaiting_confirmation");
    expect(rows).toHaveLength(0);
    return result.body;
  }
  function confirmation(proposal: any, location: Record<string, string> = {}, withImage = true) {
    const body = new FormData();
    for (const [key, value] of Object.entries({ message: "Xác nhận", sessionId: proposal.sessionId, actionId: proposal.action.id, actionDecision: "confirm", ...location })) body.append(key, String(value));
    if (withImage) body.append("files", new Blob([image], { type: "image/png" }), "QA_ONLY.png");
    return body;
  }
  async function readBack() {
    const response = await fetch(`${base}/reports/user`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return await response.json() as any[];
  }
  function expectEvidence(report: any) {
    expect(report.images).toEqual(["https://qa.invalid/static-qa-image.png"]);
    expect(report.evidences).toEqual([{ url: report.images[0], publicId: "QA_ONLY/static-image", resourceType: "image" }]);
  }

  it("preserves GPS and actual multipart bytes through chat confirmation and read-back", async () => {
    const proposal = await draft();
    const result = await postChat(confirmation(proposal, { latitude: "16.0544", longitude: "108.2022" }));
    expect(result.status).toBe(200);
    expect(result.body.action.status).toBe("completed");
    expect(upload).toHaveBeenCalledExactlyOnceWith(image, { folder: "vietflood/reports", resource_type: "auto" });
    const [report] = await readBack();
    expect(report).toMatchObject({ lat: 16.0544, lng: 108.2022, userId: 7 });
    expectEvidence(report);
    expectEvidence(JSON.parse(values.get(`report:${report.id}`)!));
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("retains GPS selected during a previous chat turn when confirmation only sends a photo", async () => {
    const proposal = await draft({ latitude: 0, longitude: 0 });
    const result = await postChat(confirmation(proposal));
    expect(result.status).toBe(200);
    const [report] = await readBack();
    expect(report).toMatchObject({ lat: 0, lng: 0 });
    expectEvidence(report);
  });

  it("clears previously selected GPS only when explicitly requested, without dropping the photo", async () => {
    const proposal = await draft({ latitude: 16, longitude: 108 });
    const result = await postChat(confirmation(proposal, { clearLocation: "true" }));
    expect(result.status).toBe(200);
    const [report] = await readBack();
    expect(report.lat ?? undefined).toBeUndefined(); expect(report.lng ?? undefined).toBeUndefined();
    expectEvidence(report);
  });

  it("rejects incomplete GPS before uploading or creating a report", async () => {
    const proposal = await draft();
    const result = await postChat(confirmation(proposal, { latitude: "16" }));
    expect(result.status).toBe(200);
    expect(result.body.action.status).toBe("collecting");
    expect(upload).not.toHaveBeenCalled(); expect(repository.save).not.toHaveBeenCalled();
  });

  it("supports confirming without optional attachments", async () => {
    const proposal = await draft();
    const result = await postChat(confirmation(proposal, {}, false));
    expect(result.status).toBe(200);
    expect(result.body.action.status).toBe("completed");
    const [report] = await readBack();
    expect(report.images).toEqual([]); expect(report.evidences).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not create a partial report when the external upload fails, and allows retry", async () => {
    const proposal = await draft();
    upload.mockRejectedValueOnce(new Error("QA_ONLY upload unavailable"));
    const failed = await postChat(confirmation(proposal, { latitude: "16", longitude: "108" }));
    expect(failed.status).toBe(500);
    expect(repository.save).not.toHaveBeenCalled();
    expect(values.has(`chat:pending-action:7:${proposal.sessionId}`)).toBe(true);
    const retry = await postChat(confirmation(proposal, { latitude: "16", longitude: "108" }));
    expect(retry.status).toBe(200);
    expect(retry.body.action.status).toBe("completed");
    expect(repository.save).toHaveBeenCalledTimes(1);
    const [report] = await readBack();
    expectEvidence(report);
    expect(report).toMatchObject({ lat: 16, lng: 108 });
  });

  it("rejects non-image multipart data before reaching upload/persistence", async () => {
    const proposal = await draft();
    const body = confirmation(proposal, {}, false);
    body.append("files", new Blob(["QA_ONLY not an image"], { type: "text/plain" }), "QA_ONLY.txt");
    const result = await postChat(body);
    expect(result.status).toBe(400);
    expect(upload).not.toHaveBeenCalled(); expect(repository.save).not.toHaveBeenCalled();
  });

  it("does not treat multipart clearLocation=false as a request to discard GPS", async () => {
    const proposal = await draft({ latitude: 16, longitude: 108 });
    const result = await postChat(confirmation(proposal, { clearLocation: "false" }));
    expect(result.status).toBe(200);
    const [report] = await readBack();
    expect(report).toMatchObject({ lat: 16, lng: 108 });
    expectEvidence(report);
  });

  it("returns GPS and photos from direct multipart create as well as report read-back", async () => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ "category[]": "incident", description: "QA_ONLY direct contract", province: "QA_ONLY", ward: "QA_ONLY", addressLine: "QA_ONLY", latitude: "16.0544", longitude: "108.2022" })) body.append(key, value);
    body.append("files", new Blob([image], { type: "image/png" }), "QA_ONLY.png");
    const response = await fetch(`${base}/reports/create`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    const [report] = await readBack();
    expectEvidence(created); expectEvidence(report);
    expect(report).toMatchObject({ lat: 16.0544, lng: 108.2022 });
    expect(created).toMatchObject({ reportId: report.id, lat: report.lat, lng: report.lng });
  });
});
