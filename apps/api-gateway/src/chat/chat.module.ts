import { Module } from "@nestjs/common";
import { LoggerService, RedisModule } from "vietflood-common";

import { ReportsModule } from "../reports/reports.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";

@Module({
  imports: [ReportsModule, RedisModule.forRoot()],
  controllers: [ChatController],
  providers: [ChatService, QdrantKnowledgeService, LoggerService],
})
export class ChatModule {}
