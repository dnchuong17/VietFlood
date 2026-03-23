import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  CloudinaryService,
  LoggerService,
  RedisService,
} from "@dnchuong17/vietflood-common";

import { ReportEntity } from "./entity/report.entity";
import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(ReportEntity)
    private readonly reportRepository: Repository<ReportEntity>,
    private readonly redisHelper: RedisService,
    private readonly logger: LoggerService,
    private readonly cloudinaryService: CloudinaryService,
  ) {
    this.logger.setServiceName(ReportsService.name);
  }

  async createReport(createReportDto: CreateReportDto) {
    this.logger.debug("[CREATE REPORT] - Creating new report");

    const evidences =
      createReportDto.evidences?.map((item) => ({
        url: item.url,
        publicId: item.publicId,
        resourceType: item.resourceType,
      })) ?? [];

    const report = this.reportRepository.create({
      ...createReportDto,
      category: createReportDto.category ?? [],
      evidences,
      images: evidences.map((item) => item.url),
    });

    const savedReport = await this.reportRepository.save(report);

    await this.redisHelper.set(
      `report:${savedReport.id}`,
      JSON.stringify(savedReport),
    );

    this.logger.debug(
      `[CREATE REPORT] - Report created successfully: ${JSON.stringify({
        id: savedReport.id,
      })}`,
    );

    return {
      success: true,
      message: "Create report successfully",
      reportId: savedReport.id,
      category: savedReport.category,
      evidences: savedReport.evidences,
      images: savedReport.images,
    };
  }

  async getAllReports() {
    this.logger.debug("[GET ALL REPORTS] - Find all reports");

    return this.reportRepository.find({
      order: { createdAt: "DESC" },
    });
  }

  async getAllReportsByUserId(userId: number) {
    this.logger.debug("[GET ALL REPORTS] - Find all reports");

    return this.reportRepository.find({
      where: { userId: userId },
      order: { createdAt: "DESC" },
    });
  }

  async findReportWithID(id: number) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(`[FIND REPORT] - Finding report via ID: ${id}`);

    const cacheReport = await this.redisHelper.get(`report:${id}`);
    if (cacheReport) {
      this.logger.debug(`[FIND REPORT] - Found report from cache: ${id}`);
      return JSON.parse(cacheReport);
    }

    const report = await this.reportRepository.findOne({
      where: { id },
      relations: ["user"],
    });

    if (!report) {
      throw new NotFoundException(`Report not found for ID: ${id}`);
    }

    await this.redisHelper.set(`report:${id}`, JSON.stringify(report));

    return report;
  }

  async updateReport(
    id: number,
    userId: number,
    updateReportDto: UpdateReportDto,
    files?: Express.Multer.File[],
  ) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(`[UPDATE REPORT] - Updating report with ID: ${id}`);

    const existedReport = await this.reportRepository.findOne({
      where: { id },
    });

    if (!existedReport) {
      throw new NotFoundException(`Report not found for ID: ${id}`);
    }

    const uploadedFiles = files?.length
      ? await Promise.all(
          files.map((file) =>
            this.cloudinaryService.uploadBuffer(file.buffer, {
              folder: "vietflood/reports",
              resource_type: "auto",
            }),
          ),
        )
      : [];

    const newEvidences = uploadedFiles.map((item) => ({
      url: item.secure_url,
      publicId: item.public_id,
      resourceType: item.resource_type,
    }));

    const mergedReport = {
      ...existedReport,
      ...updateReportDto,
      evidences:
        newEvidences.length > 0
          ? [...(existedReport.evidences ?? []), ...newEvidences]
          : existedReport.evidences,
    };
    await this.reportRepository.update(id, mergedReport);

    const updatedReport = await this.reportRepository.findOne({
      where: { id },
    });

    await this.redisHelper.del(`report:${id}`);

    if (updatedReport) {
      await this.redisHelper.set(`report:${id}`, JSON.stringify(updatedReport));
    }

    return {
      success: true,
      message: "Update report successfully",
      reportId: id,
      evidences: updatedReport?.evidences ?? [],
    };
  }

  async deleteReport(id: number, userId: number) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(`[DELETE REPORT] - Deleting report with ID: ${id}`);

    const report = await this.reportRepository.findOne({
      where: { id },
    });

    if (!report) {
      throw new NotFoundException(`Report not found for ID: ${id}`);
    }

    const publicIds =
      report.evidences
        ?.map((item) => item.publicId)
        .filter((item): item is string => !!item) ?? [];

    if (publicIds.length > 0) {
      await this.cloudinaryService.deleteMany(publicIds, "image");
    }

    await this.reportRepository.delete({ id });
    await this.redisHelper.del(`report:${id}`);

    return {
      success: true,
      message: "Delete report successfully",
      reportId: id,
    };
  }
}
