import { Module } from "@nestjs/common";
import { LoggerService } from "vietflood-common";
import { TrackingController } from "./tracking.controller";
import { TrackingGateway } from "./tracking.gateway";
import { TrackingService } from "./tracking.service";

@Module({
  controllers: [TrackingController],
  providers: [TrackingGateway, TrackingService, LoggerService],
})
export class TrackingModule {}
