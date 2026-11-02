import { Injectable } from "@nestjs/common";
import { LoggerService } from "vietflood-common";
import { StructuredModelClient } from "../../../../shared/structured-model";
import { requestId } from "./chat-trace";
export type { ChatActionIntent } from "../../../../shared/structured-model";

@Injectable()
export class OpenAIChatService extends StructuredModelClient {
 constructor(logger: LoggerService) { super(logger, requestId); }
}
