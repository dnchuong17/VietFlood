import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { AuthServiceModule } from "./auth-service.module";

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
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
  );
  await app.listen();
}
bootstrap();
