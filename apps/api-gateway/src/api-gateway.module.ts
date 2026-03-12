import { Module } from "@nestjs/common";
import { ApiGatewayController } from "./api-gateway.controller";
import { AuthModule } from "./auth/auth.module";
import { ApiGatewayService } from "./api-gateway.service";
import { LoggerService } from "@dnchuong17/vietflood-common";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
  ],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService, LoggerService],
})
export class ApiGatewayModule {}
