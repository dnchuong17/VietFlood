import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RefreshTokenController } from "./refresh_token.controller";
import { RefreshTokenEntity } from "./refresh_token.entity";
import { RefreshTokenService } from "./refresh_token.service";
import { RefreshTokenStrategy } from "../strategy/refreshToken.strategy";
import { JwtModule } from "@nestjs/jwt";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshTokenEntity]),
    JwtModule.register({
      global: true,
      secret: `${process.env.SECRETEKEY}`,
      signOptions: { expiresIn: "800s" },
    }),
    UsersModule,
  ],
  providers: [RefreshTokenService, RefreshTokenStrategy],
  controllers: [RefreshTokenController],
  exports: [RefreshTokenService],
})
export class RefreshTokenModule {}
