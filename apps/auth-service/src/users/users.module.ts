import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { UserEntity } from "./users.entity";
import { LoggerService } from "vietflood-common";

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  providers: [UsersService, LoggerService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
