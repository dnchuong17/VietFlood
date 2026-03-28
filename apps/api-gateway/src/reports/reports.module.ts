import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { JwtStrategy } from "../auth/strategy/jwt.strategy";
import { CloudinaryService, LoggerService } from "@dnchuong17/vietflood-common";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    ClientsModule.register([
      {
        name: "REPORTS_SERVICE",
        transport: Transport.RMQ,
        options: {
          urls: ["amqp://admin:admin@localhost:5672"],
          queue: "reports_queue",
          queueOptions: {
            durable: true,
          },
          persistent: true,
        },
      },
      {
        name: "AUTH_SERVICE",
        transport: Transport.RMQ,
        options: {
          urls: ["amqp://admin:admin@localhost:5672"],
          queue: "auth_queue",
          queueOptions: {
            durable: true,
          },
          persistent: true,
        },
      },
    ]),
    AuthModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService, JwtStrategy, LoggerService, CloudinaryService],
  exports: [ClientsModule],
})
export class ReportsModule {}
