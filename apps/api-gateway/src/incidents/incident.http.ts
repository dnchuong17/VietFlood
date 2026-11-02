import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Inject,
} from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { lastValueFrom, timeout } from "rxjs";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

type IncidentRequest = {
  headers?: Record<string, unknown>;
  user?: { userId: number; role: string };
};

export function incidentRequestId(req: IncidentRequest) {
  const input = req.headers?.["x-request-id"];
  return typeof input === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(input)
    ? input
    : randomUUID();
}
@Catch()
export class IncidentExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp(),
      res = http.getResponse<Response>(),
      requestId = incidentRequestId(http.getRequest<IncidentRequest>());
    const raw = error instanceof HttpException ? error.getResponse() : error;
    const body =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const statusCode =
      error instanceof HttpException
        ? error.getStatus()
        : typeof body.statusCode === "number" &&
            Number.isInteger(body.statusCode) &&
            body.statusCode >= 400 &&
            body.statusCode < 600
          ? body.statusCode
          : 503;
    res.setHeader("X-Request-Id", requestId);
    res.status(statusCode).json({
      statusCode,
      code:
        typeof body.code === "string"
          ? body.code
          : statusCode === 400
            ? "invalid_request"
            : statusCode === 401
              ? "unauthorized"
              : statusCode === 403
                ? "forbidden"
                : "incident_unavailable",
      message:
        statusCode >= 500
          ? "Incident service is unavailable"
          : Array.isArray(body.message) &&
              body.message.every((value) => typeof value === "string")
            ? body.message.join("; ")
            : typeof body.message === "string"
              ? body.message
              : "Request rejected",
      requestId,
    });
  }
}
@Injectable()
export class IncidentGatewayService {
  constructor(
    @Inject("REPORTS_SERVICE") private readonly reports: ClientProxy,
  ) {}
  read(req: IncidentRequest, operation: string, id = "", input: unknown = {}) {
    return this.call("incidents.read", {
      actor: req.user,
      operation,
      id,
      input,
      requestId: incidentRequestId(req),
    });
  }
  mutate(
    req: IncidentRequest,
    operation: string,
    id: string,
    body: unknown,
    key?: string,
  ) {
    return this.call("incidents.mutate", {
      actor: req.user,
      operation,
      id,
      body,
      key,
      requestId: incidentRequestId(req),
    });
  }
  private call(pattern: string, payload: unknown) {
    return lastValueFrom(
      this.reports.send<unknown>(pattern, payload).pipe(timeout(15000)),
    );
  }
}
