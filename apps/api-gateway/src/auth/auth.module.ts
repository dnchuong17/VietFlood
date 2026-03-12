import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";

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
  providers: [AuthService],
  exports: [ClientsModule, AuthService],
})
export class AuthModule {}
