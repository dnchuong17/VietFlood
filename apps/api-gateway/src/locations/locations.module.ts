import { Module } from "@nestjs/common";
import { LoggerService, RedisModule } from "vietflood-common";

import { AuthModule } from "../auth/auth.module";
import { JwtStrategy } from "../auth/strategy/jwt.strategy";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";

@Module({
  imports: [AuthModule, RedisModule.forRoot()],
  controllers: [LocationsController],
  providers: [LocationsService, JwtStrategy, LoggerService],
  exports: [LocationsService],
})
export class LocationsModule {}
