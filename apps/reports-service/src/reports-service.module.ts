import { Module } from "@nestjs/common";
import { ReportsService } from "./reports-service.service";
import { ReportsController } from "./reports-service.controller";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  CloudinaryModule,
  CloudinaryService,
  LoggerService,
} from "vietflood-common";
import { ReportEntity } from "./entity/report.entity";
import { typeOrmConfigAsync } from "./config/typeorm.config";

@Module({
  imports: [
    CloudinaryModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(typeOrmConfigAsync),
    TypeOrmModule.forFeature([ReportEntity]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService, LoggerService, CloudinaryService],
})
export class ReportsServiceModule {}
