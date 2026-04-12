import { NestFactory } from "@nestjs/core";
import { ReportsServiceModule } from "./reports-service.module";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";

async function bootstrap() {
  const rabbitmqUrl =
    process.env.RABBITMQ_URL || "amqp://admin:admin@localhost:5672";

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    ReportsServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
        queue: "reports_queue",
        queueOptions: {
          durable: true,
        },
      },
    },
  );

  await app.listen();
}
bootstrap();
