import { NestFactory } from "@nestjs/core";
import { ApiGatewayModule } from "./api-gateway.module";
import { LoggerService } from "vietflood-common";

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  const logger = await app.resolve(LoggerService);
  const port = Number(process.env.API_GATEWAY_PORT);
  logger.setServiceName("Api-gateway");
  logger.info("API Gateway is starting...");
  app.enableCors({
    origin: [
      "http://172.16.25.252:3000",
      "http://172.16.25.252:3001",
      "http://localhost:3000",
      "http://localhost:3001",
      "https://vietflood-fe.vercel.app",
      "https://viet-flood-app.vercel.app",
    ],
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
  });
  await app.listen(port);

  logger.info(`API Gateway running on http://localhost:${port}`);
}

bootstrap();
