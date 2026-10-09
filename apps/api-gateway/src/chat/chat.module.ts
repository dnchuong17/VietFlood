import { Module } from "@nestjs/common";
import { LoggerService, RedisModule } from "vietflood-common";

import { ReportsModule } from "../reports/reports.module";
import { ChatController } from "./chat.controller";
import { ChatCryptoService } from "./chat-crypto.service";
import { ChatAuditInterceptor } from "./chat-audit.interceptor";
import { ChatHistoryRepository } from "./chat-history.repository";
import { ChatService } from "./chat.service";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
import { GeminiChatService } from "./gemini-chat.service";

@Module({
  imports: [ReportsModule, RedisModule.forRoot()],
  controllers: [ChatController],
  providers: [ChatService, ChatCryptoService, ChatHistoryRepository, QdrantKnowledgeService, GeminiChatService,
    LoggerService,
    { provide: ChatAuditInterceptor,
      useFactory: (logger: LoggerService) => new ChatAuditInterceptor(logger),
      inject: [LoggerService] }],
})
export class ChatModule {}
