import { Controller } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { LoggerService } from "@dnchuong17/vietflood-common";
import { ReportsService } from "./reports-service.service";

@Controller()
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly logger: LoggerService,
  ) {}

  @MessagePattern("create")
  async create(@Payload() payload: any) {
    this.logger.debug(`[CREATE REPORT] - Creating report`);
    return this.reportsService.createReport(payload, payload.userId);
  }

  @MessagePattern("")
  async getAll() {
    this.logger.debug(`[GET ALL REPORTS] - Fetching all reports`);
    return this.reportsService.getAllReports();
  }

  @MessagePattern("get_all_by_users")
  async getAllById(@Payload() payload: any) {
    this.logger.debug(`[GET ALL REPORTS] - Fetching all reports`);
    return this.reportsService.getAllReportsByUserId(payload);
  }

  @MessagePattern("update")
  async update(@Payload() payload: any) {
    this.logger.debug(`[UPDATE REPORT] - ID: ${payload.id}`);

    const files =
      payload.files?.map((file: any) => ({
        ...file,
        buffer: Buffer.from(file.buffer.data ?? file.buffer),
      })) ?? [];

    return this.reportsService.updateReport(
      payload.id,
      payload.userId,
      payload.dto,
      files,
    );
  }

  @MessagePattern("delete")
  async delete(@Payload() payload) {
    this.logger.debug(`[DELETE REPORT] - ID: ${payload}`);
    return this.reportsService.deleteReport(payload.id, payload.userId);
  }
}
