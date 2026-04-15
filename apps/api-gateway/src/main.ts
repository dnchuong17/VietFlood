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
    origin: "*",
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
  });
  await app.listen(port);

  logger.info(`API Gateway running on http://localhost:${port}`);
}

bootstrap();
