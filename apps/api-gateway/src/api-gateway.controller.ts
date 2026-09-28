import { Controller, Get } from "@nestjs/common";
import { ApiGatewayService } from "./api-gateway.service";

@Controller()
export class ApiGatewayController {
  constructor(private readonly apiGatewayService: ApiGatewayService) {}

  @Get()
  root() {
    return {
      status: "ok",
      service: "vietflood-api-gateway",
      message: "VietFlood API is running",
    };
  }
}
