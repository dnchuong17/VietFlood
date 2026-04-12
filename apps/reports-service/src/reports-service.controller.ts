import { Controller } from "@nestjs/common";
import { MessagePattern, Payload, RpcException } from "@nestjs/microservices";
import { LoggerService } from "vietflood-common";
import { ReportsService } from "./reports-service.service";

@Controller()
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly logger: LoggerService,
  ) {
    logger.setServiceName(ReportsController.name);
  }

  @MessagePattern("create")
  async create(@Payload() payload: any) {
    try {
      this.logger.debug(`[CREATE REPORT] - Creating report`);
      return this.reportsService.createReport(payload, payload.userId);
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("")
  async getAll() {
    try {
      this.logger.debug(`[GET ALL REPORTS] - Fetching all reports`);
      return this.reportsService.getAllReports();
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("get_all_by_users")
  async getAllById(@Payload() payload: any) {
    try {
      this.logger.debug(`[GET ALL REPORTS] - Fetching all reports`);
      return this.reportsService.getAllReportsByUserId(payload.userId);
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("update")
  async update(@Payload() payload: any) {
    try {
      this.logger.debug(`[UPDATE REPORT] - ID: ${payload.id}`);
      return this.reportsService.updateReport(
        payload.id,
        payload.userId,
        payload.dto,
      );
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("delete")
  async delete(@Payload() payload) {
    try {
      this.logger.debug(`[DELETE REPORT] - ID: ${payload}`);
      return this.reportsService.deleteReport(payload.id, payload.userId);
    } catch (error) {
      throw new RpcException(error);
    }
  }
}
