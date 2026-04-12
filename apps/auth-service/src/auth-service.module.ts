import { Module } from "@nestjs/common";
import { AuthServiceController } from "./auth-service.controller";
import { AuthService } from "./auth-service.service";
import { ConfigModule } from "@nestjs/config";
import { UsersModule } from "./users/users.module";
import { TypeOrmModule } from "@nestjs/typeorm";
import { typeOrmConfigAsync } from "./config/typeorm.config";
import { LoggerService } from "vietflood-common";
import { JwtModule } from "@nestjs/jwt";
import { UserEntity } from "./users/users.entity";
import { AdminSeed } from "./admin/admin.seed";
import { RefreshTokenModule } from "./refesh_token/refresh_token.module";
import { JwtStrategy } from "./strategy/jwt.strategy";
import { LocalStrategy } from "./strategy/local.strategy";
import { RefreshTokenStrategy } from "./strategy/refreshToken.strategy";
import { RefreshTokenEntity } from "./refesh_token/refresh_token.entity";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync(typeOrmConfigAsync),
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity]),
    UsersModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: "800s" },
    }),
    RefreshTokenModule,
  ],
  controllers: [AuthServiceController],
  providers: [
    AuthService,
    LoggerService,
    AdminSeed,
    JwtStrategy,
    LocalStrategy,
    RefreshTokenStrategy,
  ],
})
export class AuthServiceModule {}
