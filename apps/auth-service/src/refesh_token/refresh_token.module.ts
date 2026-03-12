import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RefreshTokenController } from "./refresh_token.controller";
import { RefreshTokenEntity } from "./refresh_token.entity";
import { RefreshTokenService } from "./refresh_token.service";
import { RefreshTokenStrategy } from "../strategy/refreshToken.strategy";

@Module({
  imports: [TypeOrmModule.forFeature([RefreshTokenEntity])],
  providers: [RefreshTokenService, RefreshTokenStrategy],
  controllers: [RefreshTokenController],
  exports: [RefreshTokenService],
})
export class RefreshTokenModule {}
