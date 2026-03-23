import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { lastValueFrom, of } from "rxjs";
import { catchError, retry, timeout } from "rxjs/operators";
import { CloudinaryService, LoggerService } from "@dnchuong17/vietflood-common";

import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";

@Injectable()
export class ReportsService {
  constructor(
    @Inject("REPORTS_SERVICE")
    private readonly reportsClient: ClientProxy,
    private readonly logger: LoggerService,
    private readonly cloudinaryService: CloudinaryService,
  ) {
    this.logger.setServiceName(ReportsService.name);
  }

  async createReport(
    createReportDto: CreateReportDto,
    userId: number,
    files?: Express.Multer.File[],
  ) {
    this.logger.debug("[CREATE REPORT][GATEWAY] - Start upload files");

    const uploadedEvidences = files?.length
      ? await Promise.all(
          files.map(async (file) => {
            const uploaded = await this.cloudinaryService.uploadBuffer(
              file.buffer,
              {
                folder: "vietflood/reports",
                resource_type: "auto",
              },
            );

            return {
              url: uploaded.secure_url,
              publicId: uploaded.public_id,
              resourceType: uploaded.resource_type,
            };
          }),
        )
      : [];

    const payload: CreateReportDto = {
      ...createReportDto,
      category: Array.isArray(createReportDto.category)
        ? createReportDto.category
        : [],
      evidences: [...(createReportDto.evidences ?? []), ...uploadedEvidences],
      userId,
    };

    const data = await lastValueFrom(
      this.reportsClient.send("create", payload).pipe(
        timeout(10000),
        retry(3),
        catchError((error) =>
          of({
            error: "reports service error!",
            details: error?.message ?? error,
          }),
        ),
      ),
    );

    return data;
  }

  async getAllReports() {
    const data = await lastValueFrom(
      this.reportsClient.send("", {}).pipe(
        timeout(5000),
        retry(3),
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

  async getAllReportsById(userId: number) {
    const data = await lastValueFrom(
      this.reportsClient.send("get_all_by_users", { userId }).pipe(
        timeout(5000),
        retry(3),
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
    userId: number,
    updateReportDto: UpdateReportDto,
    files?: Express.Multer.File[],
  ) {
    const payload = {
      id,
      userId,
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
        retry(3),
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

  async updateReportByUser(
    id: number,
    userId: number,
    updateReportDto: UpdateReportDto,
    files?: Express.Multer.File[],
  ) {
    const payload = {
      id,
      userId,
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

  async deleteReport(id: number, userId: number) {
    const data = await lastValueFrom(
      this.reportsClient.send("delete", { id, userId }).pipe(
        timeout(5000),
        retry(3),
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
