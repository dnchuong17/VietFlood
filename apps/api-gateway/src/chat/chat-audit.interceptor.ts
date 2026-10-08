import { randomUUID } from "node:crypto";
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { LoggerService } from "vietflood-common";

@Injectable()
export class ChatAuditInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName(ChatAuditInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    const event = `${request.method} ${request.route?.path ?? "chat"}`;
    this.logger.info("Chat API request", { event, requestId });
    return next.handle();
  }
}
