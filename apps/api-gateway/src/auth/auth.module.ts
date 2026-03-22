import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./strategy/jwt.strategy";
import { RefreshTokenStrategy } from "./strategy/refreshToken.strategy";

@Module({
  imports: [
    ClientsModule.register([
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
    PassportModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, RefreshTokenStrategy],
  exports: [ClientsModule, AuthService],
})
export class AuthModule {}
