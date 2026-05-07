import { Module } from "@nestjs/common";
import { LoggerService } from "vietflood-common";
import { TrackingGateway } from "./tracking.gateway";

@Module({
  providers: [TrackingGateway, LoggerService],
})
export class TrackingModule {}
