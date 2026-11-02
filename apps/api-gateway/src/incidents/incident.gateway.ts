import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { RedisService, LoggerService } from "vietflood-common";
import { Server, Socket } from "socket.io";
import { IncidentGatewayService } from "./incident.http";

@WebSocketGateway({
  namespace: "/incidents",
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://vflood.vercel.app",
      "https://viet-flood-app.vercel.app",
    ],
    credentials: true,
  },
})
export class IncidentEventsGateway
  implements OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer() server: Server;
  private subscriber: ReturnType<RedisService["getClient"]>;
  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly api: IncidentGatewayService,
    private readonly logger: LoggerService,
  ) {}
  async onModuleInit() {
    this.subscriber = this.redis.getClient().duplicate();
    this.subscriber.on("error", () =>
      this.logger.warn("Incident event subscriber unavailable", {
        code: "incident_events_unavailable",
      }),
    );
    this.subscriber.on("message", (_channel, body) => {
      try {
        const event = JSON.parse(body) as Record<string, unknown>;
        if (!event || typeof event !== "object") return;
        this.server?.to("operations").emit("incidents.changed", {
          id: event.id,
          event: event.event,
          incidentId: event.incidentId,
          reportId: event.reportId,
        });
      } catch {
        // Invalid notifications cannot affect the independent HTTP emergency feed.
      }
    });
    await this.subscriber.subscribe("incidents.events");
  }
  async onModuleDestroy() {
    await this.subscriber?.quit();
  }
  async handleConnection(socket: Socket) {
    try {
      const token: unknown = socket.handshake.auth?.token;
      if (typeof token !== "string" || token.length > 8192)
        throw new Error("invalid_token");
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(
        token,
        {
          secret: process.env.JWT_SECRET,
        },
      );
      if (
        typeof payload.sub !== "number" ||
        !Number.isSafeInteger(payload.sub) ||
        typeof payload.role !== "string" ||
        !["admin", "relief"].includes(payload.role) ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp * 1000 <= Date.now()
      )
        throw new Error("invalid_identity");
      const user = { userId: payload.sub, role: payload.role };
      // RPC verifies current account role as well as the signed token.
      await this.api.read({ user, headers: {} }, "overview");
      if (!socket.connected) return;
      await socket.join("operations");
      const expiry = setTimeout(
        () => socket.disconnect(true),
        Math.min(2147483647, payload.exp * 1000 - Date.now()),
      );
      expiry.unref();
      socket.once("disconnect", () => clearTimeout(expiry));
    } catch {
      socket.disconnect(true);
    }
  }
}
