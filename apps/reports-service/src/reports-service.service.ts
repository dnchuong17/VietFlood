import {
  BadRequestException,
  Injectable,
  Optional,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  CloudinaryService,
  LoggerService,
  RedisService,
} from "vietflood-common";

import { ReportEntity, type ReportEvidence } from "./entity/report.entity";
import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";
import { IncidentRepository } from "./incidents/incident.repository";
import type { Actor } from "./incidents/incident-domain";
import { ReportStatus } from "./enums/status.enum";

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(ReportEntity)
    private readonly reportRepository: Repository<ReportEntity>,
    private readonly redisHelper: RedisService,
    private readonly logger: LoggerService,
    private readonly cloudinaryService: CloudinaryService,
    @Optional() private readonly incidents?: IncidentRepository,
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
    const lat = this.toFiniteNumber(dto.lat) ?? this.toFiniteNumber(dto.latitude);
    const lng =
      this.toFiniteNumber(dto.lng) ?? this.toFiniteNumber(dto.longitude);

    if (
      lat !== undefined &&
      lng !== undefined &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      coordinates.lat = lat;
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

  async createReport(createReportDto: CreateReportDto, userId: number, requestKey?: string) {
    this.logger.debug("[CREATE REPORT] - Creating new report");

    const {
      evidences: _evidences,
      lat: _lat,
      lng: _lng,
      latitude: _latitude,
      longitude: _longitude,
      ...reportFields
    } = createReportDto;
    const evidences = this.normalizeEvidences(createReportDto.evidences);
    const coordinates = this.normalizeCoordinates(createReportDto);

    const report = this.reportRepository.create({
      description: reportFields.description,
      province: reportFields.province, ward: reportFields.ward, addressLine: reportFields.addressLine,
      isUrgent: reportFields.isUrgent === true || String(reportFields.isUrgent) === "true",
      severity: Number.isFinite(Number(reportFields.severity)) ? Number(reportFields.severity) : 0,
      ...coordinates,
      category: createReportDto.category ?? [],
      evidences,
      images: this.evidenceUrls(evidences),
      userId: userId,
    });

    const savedReport = this.incidents?.ready
      ? await this.incidents.db.transaction(async q => {
          await this.incidents.lock(q);
          const create = async () => {
            const saved = await q.getRepository(ReportEntity).save(report);
            await this.incidents.capture(q, saved);
            return saved;
          };
          return requestKey
            ? this.incidents.idempotent(q, { userId, role: 'citizen' }, 'report.create', requestKey, { ...report, userId }, create)
            : create();
        })
      : await this.reportRepository.save(report);

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

    const rows = await this.reportRepository.find({ order: { createdAt: "DESC" } });
    return this.incidents ? this.incidents.visible(rows) : rows;
  }

  async getAllReportsByUserId(userId: number): Promise<ReportEntity[]> {
    this.logger.debug("[GET ALL REPORTS] - Find all reports");

    const report = await this.reportRepository.find({
      where: { userId: userId },
      order: { createdAt: "DESC" },
    });

    return this.incidents ? this.incidents.visible(report) : report;
  }

  async getRecentVerifiedFloodAreas(): Promise<{
    province: string;
    ward: string;
    reportCount: number;
    latestAt: string;
  }[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.reportRepository
      .createQueryBuilder("report")
      .select("report.province", "province")
      .addSelect("report.ward", "ward")
      .addSelect("COUNT(*)", "reportCount")
      .addSelect("MAX(report.createdAt)", "latestAt")
      .where("report.status = :status", { status: ReportStatus.VERIFIED })
      .andWhere(":category = ANY(report.category)", { category: "flood" })
      .andWhere("report.createdAt >= :since", { since })
      .andWhere("report.province IS NOT NULL AND BTRIM(report.province) <> ''")
      .andWhere("report.ward IS NOT NULL AND BTRIM(report.ward) <> ''")
      .groupBy("report.province")
      .addGroupBy("report.ward")
      .orderBy("latestAt", "DESC")
      .addOrderBy("province", "ASC")
      .addOrderBy("ward", "ASC")
      .take(5)
      .getRawMany<{
        province: string;
        ward: string;
        reportCount: string | number;
        latestAt: Date | string;
      }>();

    return rows.map((row) => ({
      province: row.province,
      ward: row.ward,
      reportCount: Number(row.reportCount),
      latestAt: new Date(row.latestAt).toISOString(),
    }));
  }

  async getRecentVerifiedReportCount(category?: string): Promise<number> {
    const allowedCategories = ["flood", "incident", "infrastructure", "rescue"];
    if (category && !allowedCategories.includes(category)) {
      throw new BadRequestException("Invalid report category");
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const query = this.reportRepository
      .createQueryBuilder("report")
      .select("COUNT(*)", "reportCount")
      .where("report.status = :status", { status: ReportStatus.VERIFIED })
      .andWhere("report.createdAt >= :since", { since });
    if (category) {
      query.andWhere(":category = ANY(report.category)", { category });
    }

    const result = await query.getRawOne<{ reportCount: string | number }>();
    const count = Number(result?.reportCount ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid verified report count result");
    }
    return count;
  }

  async findReportWithID(id: number) {
    if (!id) {
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(`[FIND REPORT] - Finding report via ID: ${id}`);

    if ((await this.incidents?.retained(id))?.archived_at) throw new NotFoundException("Report archived");
    const cacheReport = await this.redisHelper.get(`report:${id}`);
    if (cacheReport) {
      this.logger.debug(`[FIND REPORT] - Found report from cache: ${id}`);
      return JSON.parse(cacheReport);
    }

    const report = await this.reportRepository.findOne({
      where: { id },

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

    if (this.incidents?.ready) return this.updateWithRetention(id, userId, updateReportDto);

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
      latitude: _latitude,
      longitude: _longitude,
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

    if (this.incidents?.ready) {
      await this.incidents.db.transaction(async q => {
        await this.incidents.lock(q);
        const [before] = await q.query('SELECT * FROM public.reports WHERE id=$1 FOR UPDATE', [id]);
        if ((await this.incidents.retained(id,q))?.archived_at) throw new NotFoundException('Report archived');
        await this.incidents.capture(q,before);
        await q.getRepository(ReportEntity).update(id,{status});
        await this.incidents.capture(q,await q.getRepository(ReportEntity).findOneBy({id}));
      });
    } else await this.reportRepository.update(id, { status });

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

  async deleteReport(id: number, userId: number, actor?: Actor) {
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

    if (await this.incidents?.archive(id,userId,actor)) {
      await this.redisHelper.del(`report:${id}`);
      return { success: true, message: "Report archived; incident evidence retained", reportId: id, archived: true };
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
  private async updateWithRetention(id: number, userId: number, dto: UpdateReportDto) {
    const report = await this.incidents.db.transaction(async q => {
      await this.incidents.lock(q);
      const [before] = await q.query('SELECT * FROM public.reports WHERE id=$1 AND "userId"=$2 FOR UPDATE',[id,userId]);
      if (!before || (await this.incidents.retained(id,q))?.archived_at) throw new NotFoundException('Report not found');
      await this.incidents.capture(q,before);
      const fields: any = {};
      for (const field of ['description','province','ward','addressLine','category','isUrgent','severity'])
        if (dto[field] !== undefined) fields[field] = dto[field];
      if(fields.isUrgent !== undefined) fields.isUrgent = fields.isUrgent === true || fields.isUrgent === 'true';
      const evidences = this.mergeEvidences(before.evidences,this.normalizeEvidences(dto.evidences));
      await q.getRepository(ReportEntity).update(id,{...fields,...this.normalizeCoordinates(dto),evidences,images:this.evidenceUrls(evidences)});
      const current = await q.getRepository(ReportEntity).findOneBy({id});
      await this.incidents.capture(q,current);
      return current;
    });
    await this.redisHelper.del(`report:${id}`);
    return {success:true,message:'Update report successfully',reportId:id,evidences:report.evidences,images:report.images,report};
  }

}
