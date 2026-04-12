import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { AuthServiceModule } from "./auth-service.module";

async function bootstrap() {
  const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
  
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
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
