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
} from "vietflood-common";

import { ReportEntity } from "./entity/report.entity";
import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";
import { ReportStatus } from "./enums/status.enum";

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

  private toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private normalizeCoordinates(dto: Partial<CreateReportDto>) {
    const coordinates: Pick<ReportEntity, "lat" | "lng"> = {} as Pick<
      ReportEntity,
      "lat" | "lng"
    >;
    const lat = this.toFiniteNumber(dto.lat);
    const lng = this.toFiniteNumber(dto.lng);

    if (lat !== undefined) {
      coordinates.lat = lat;
    }
    if (lng !== undefined) {
      coordinates.lng = lng;
    }

    return coordinates;
  }

  private normalizeEvidences(
    evidences?: CreateReportDto["evidences"],
  ): ReportEvidence[] {
    const uniqueEvidences = new Map<string, ReportEvidence>();

    for (const evidence of evidences ?? []) {
      const url = evidence?.url?.trim();
      const publicId = evidence?.publicId?.trim();
      if (!url || !publicId || uniqueEvidences.has(url)) {
        continue;
      }

      uniqueEvidences.set(url, {
        url,
        publicId,
        resourceType: evidence.resourceType,
      });
    }

    return Array.from(uniqueEvidences.values());
  }

  private mergeEvidences(
    existing: ReportEvidence[] | undefined,
    incoming: ReportEvidence[],
  ): ReportEvidence[] {
    return this.normalizeEvidences([...(existing ?? []), ...incoming]);
  }

  private evidenceUrls(evidences: ReportEvidence[]): string[] {
    return evidences.map((item) => item.url);
  }

  async createReport(createReportDto: CreateReportDto, userId: number) {
    this.logger.debug("[CREATE REPORT] - Creating new report");

    const {
      evidences: _evidences,
      lat: _lat,
      lng: _lng,
      ...reportFields
    } = createReportDto;
    const evidences = this.normalizeEvidences(createReportDto.evidences);
    const coordinates = this.normalizeCoordinates(createReportDto);

    const report = this.reportRepository.create({
      ...reportFields,
      ...coordinates,
      category: createReportDto.category ?? [],
      evidences,
      images: this.evidenceUrls(evidences),
      userId: userId,
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

  async getAllReportsByUserId(userId: number): Promise<ReportEntity[]> {
    this.logger.debug("[GET ALL REPORTS] - Find all reports");

    const report = await this.reportRepository.find({
      where: { userId: userId },
      order: { createdAt: "DESC" },
    });

    return report;
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
  ) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    if (!userId) {
      throw new BadRequestException("Invalid userId");
    }

    this.logger.debug(
      `[UPDATE REPORT] - Updating report with ID: ${id}, userId: ${userId}`,
    );

    const existedReports = await this.getAllReportsByUserId(userId);

    if (!existedReports) {
      throw new NotFoundException(`Reports not found for user: ${userId}`);
    }

    const existedReport = existedReports.find((report) => report.id === id);

    if (!existedReport) {
      throw new NotFoundException(
        `Report with ID ${id} not found for user ${userId}`,
      );
    }

    const {
      evidences: _evidences,
      lat: _lat,
      lng: _lng,
      ...updateFields
    } = updateReportDto;
    const incomingEvidences = this.normalizeEvidences(updateReportDto.evidences);
    const coordinates = this.normalizeCoordinates(updateReportDto);

    const mergedEvidences =
      incomingEvidences.length > 0
        ? this.mergeEvidences(existedReport.evidences, incomingEvidences)
        : (existedReport.evidences ?? []);

    const mergedCategory =
      updateReportDto.category !== undefined
        ? Array.isArray(updateReportDto.category)
          ? updateReportDto.category
          : []
        : existedReport.category;

    const mergedReport = {
      ...existedReport,
      ...updateFields,
      ...coordinates,
      category: mergedCategory,
      evidences: mergedEvidences,
      images: this.evidenceUrls(mergedEvidences),
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
      images: updatedReport?.images ?? [],
      report: updatedReport,
    };
  }

  async updateReportStatus(id: number, status: ReportStatus) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(
      `[UPDATE STATUS] - Updating status of report ID: ${id} to "${status}"`,
    );

    const report = await this.reportRepository.findOne({ where: { id } });

    if (!report) {
      throw new NotFoundException(`Report not found for ID: ${id}`);
    }

    await this.reportRepository.update(id, { status });

    await this.redisHelper.del(`report:${id}`);

    const updatedReport = await this.reportRepository.findOne({ where: { id } });

    if (updatedReport) {
      await this.redisHelper.set(`report:${id}`, JSON.stringify(updatedReport));
    }

    return {
      success: true,
      message: "Update report status successfully",
      reportId: id,
      status: updatedReport?.status,
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

    if (report.userId != userId) {
      throw new NotFoundException(`Report not found for user: ${userId}`);
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
