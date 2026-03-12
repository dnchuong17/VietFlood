import { Injectable } from "@nestjs/common";
import { LoggerService } from "@dnchuong17/vietflood-common";

@Injectable()
export class ApiGatewayService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName("Api-gateway");
  }
}
