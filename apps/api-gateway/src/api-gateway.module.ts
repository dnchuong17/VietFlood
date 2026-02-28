import {MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { UsersModule } from './users/users.module';
import { LoggerModule } from './logger/logger.module';
import {LoggerService} from "./logger/logger.service";
import {TraceMiddleware} from "./logger/middleware";

@Module({
  imports: [UsersModule, LoggerModule],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService, LoggerService],
})
export class ApiGatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
