import { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { NestFactory } from "@nestjs/core";
import { PassportModule } from "@nestjs/passport";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JwtStrategy } from "../auth/strategy/jwt.strategy";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { ChatAuditInterceptor } from "./chat-audit.interceptor";

const chat = {
  reply: vi.fn(async (userId: number) => ({ answer: `User ${userId}`, sessionId: "d42639bf-a048-4e4f-b55f-23ef0f97d207" })),
  listSessions: vi.fn(async (userId: number) => ({ items: [{ sessionId: `owner-${userId}` }], nextCursor: null })),
  listMessages: vi.fn(async (userId: number) => ({ session: { userId }, items: [], nextCursor: null })),
  deleteSession: vi.fn(async () => undefined),
};
const auditLogger = { setServiceName: vi.fn(), info: vi.fn() };

class ChatHttpTestModule {}

Module({
  imports: [PassportModule],
  controllers: [ChatController],
  providers: [JwtStrategy, ChatAuditInterceptor,
    { provide: Reflect.getMetadata("design:paramtypes", ChatAuditInterceptor)[0], useValue: auditLogger },
    { provide: ChatService, useValue: chat },
    { provide: Reflect.getMetadata("design:paramtypes", ChatController)[0], useValue: chat }],
})(ChatHttpTestModule);

describe("Chat HTTP authorization and validation", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;
  let token: string;
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = "integration-test-secret";
    app = await NestFactory.create(ChatHttpTestModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    token = new JwtService({ secret: process.env.JWT_SECRET }).sign({ sub: 7, username: "tester", role: "citizen" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it("rejects missing and invalid JWTs", async () => {
    const missing = await fetch(`${base}/chat/sessions`);
    const invalid = await fetch(`${base}/chat/sessions`, { headers: { Authorization: "Bearer invalid" } });
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("passes only verified JWT identity into history routes", async () => {
    const response = await fetch(`${base}/chat/sessions?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await response.json()).toMatchObject({ items: [{ sessionId: "owner-7" }] });
    expect(chat.listSessions).toHaveBeenCalledWith(7, 20, undefined);
  });

  it("rejects invalid limits, UUIDs and extra chat fields", async () => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await fetch(`${base}/chat/sessions?limit=51`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/chat/sessions?cursor=`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/chat/sessions/not-a-uuid/messages`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/chat`, { method: "POST", headers,
      body: JSON.stringify({ message: "Hello", userId: 8 }) })).status).toBe(400);
  });

  it("deletes using the JWT identity and returns no body", async () => {
    const id = "d42639bf-a048-4e4f-b55f-23ef0f97d207";
    const response = await fetch(`${base}/chat/sessions/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(chat.deleteSession).toHaveBeenCalledWith(7, id);
  });

  it("logs event and request ID without request content or token", async () => {
    const privateText = "private question about my location";
    const response = await fetch(`${base}/chat`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: privateText }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const logged = JSON.stringify(auditLogger.info.mock.calls);
    expect(logged).toContain("requestId");
    expect(logged).not.toContain(privateText);
    expect(logged).not.toContain(token);
  });
});
