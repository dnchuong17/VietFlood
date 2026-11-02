import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { RedisModule, LoggerService } from "vietflood-common";
import { ReportsModule } from "../reports/reports.module";
import { AuthModule } from "../auth/auth.module";
import {
  IncidentsController,
  IncidentProcessingController,
} from "./incident.controller";
import { IncidentGatewayService } from "./incident.http";
import { IncidentEventsGateway } from "./incident.gateway";

@Module({
  imports: [
    ReportsModule,
    AuthModule,
    JwtModule.register({}),
    RedisModule.forRoot(),
  ],
  controllers: [IncidentsController, IncidentProcessingController],
  providers: [IncidentGatewayService, IncidentEventsGateway, LoggerService],
})
export class IncidentsModule {}
