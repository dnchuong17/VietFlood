import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { lastValueFrom, of } from "rxjs";
import { catchError, retry, timeout } from "rxjs/operators";
import { LoggerService } from "@dnchuong17/vietflood-common";

import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";

@Injectable()
export class ReportsService {
  constructor(
    @Inject("REPORTS_SERVICE")
    private readonly reportsClient: ClientProxy,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(ReportsService.name);
  }

  async createReport(
    createReportDto: CreateReportDto,
    files?: Express.Multer.File[],
  ) {
    const payload = {
      ...createReportDto,
      files:
        files?.map((file) => ({
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        })) ?? [],
    };

    const data = await lastValueFrom(
      this.reportsClient.send("create", payload).pipe(
        timeout(10000),
        retry(2),
        catchError((error) => {
          return of({
            error: "reports service error!",
            details: error,
          });
        }),
      ),
    );

    return data;
  }

  async getAllReports() {
    const data = await lastValueFrom(
      this.reportsClient.send("", {}).pipe(
        timeout(5000),
        retry(2),
        catchError((error) => {
          return of({
            error: "reports service error!",
            details: error,
          });
        }),
      ),
    );

    return data;
  }

  async updateReport(
    id: number,
    updateReportDto: UpdateReportDto,
    files?: Express.Multer.File[],
  ) {
    const payload = {
      id,
      dto: updateReportDto,
      files:
        files?.map((file) => ({
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        })) ?? [],
    };

    const data = await lastValueFrom(
      this.reportsClient.send("update", payload).pipe(
        timeout(10000),
        retry(2),
        catchError((error) => {
          return of({
            error: "reports service error!",
            details: error,
          });
        }),
      ),
    );

    return data;
  }

  async deleteReport(id: number) {
    const data = await lastValueFrom(
      this.reportsClient.send("delete", id).pipe(
        timeout(5000),
        retry(2),
        catchError((error) => {
          return of({
            error: "reports service error!",
            details: error,
          });
        }),
      ),
    );

    return data;
  }
}
