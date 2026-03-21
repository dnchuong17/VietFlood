"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ReportsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const vietflood_common_1 = require("@dnchuong17/vietflood-common");
const report_entity_1 = require("./entity/report.entity");
let ReportsService = ReportsService_1 = class ReportsService {
    constructor(reportRepository, redisHelper, logger, cloudinaryService) {
        this.reportRepository = reportRepository;
        this.redisHelper = redisHelper;
        this.logger = logger;
        this.cloudinaryService = cloudinaryService;
        this.logger.setServiceName(ReportsService_1.name);
    }
    async createReport(createReportDto, files) {
        this.logger.debug("[CREATE REPORT] - Creating new report");
        const uploadedFiles = files?.length
            ? await Promise.all(files.map((file) => this.cloudinaryService.uploadBuffer(file.buffer, {
                folder: "vietflood/reports",
                resource_type: "auto",
            })))
            : [];
        const evidences = uploadedFiles.map((item) => ({
            url: item.secure_url,
            publicId: item.public_id,
            resourceType: item.resource_type,
        }));
        const report = this.reportRepository.create({
            ...createReportDto,
            evidences,
        });
        const savedReport = await this.reportRepository.save(report);
        await this.redisHelper.set(`report:${savedReport.id}`, JSON.stringify(savedReport));
        this.logger.debug(`[CREATE REPORT] - Report created successfully: ${JSON.stringify({
            id: savedReport.id,
        })}`);
        return {
            success: true,
            message: "Create report successfully",
            reportId: savedReport.id,
            evidences: savedReport.evidences,
        };
    }
    async getAllReports() {
        this.logger.debug("[GET ALL REPORTS] - Find all reports");
        return this.reportRepository.find({
            order: { createdAt: "DESC" },
            relations: ["user"],
        });
    }
    async findReportWithID(id) {
        if (!id) {
            throw new common_1.BadRequestException("Invalid ID");
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
            throw new common_1.NotFoundException(`Report not found for ID: ${id}`);
        }
        await this.redisHelper.set(`report:${id}`, JSON.stringify(report));
        return report;
    }
    async updateReport(id, updateReportDto, files) {
        if (!id) {
            throw new common_1.BadRequestException("Invalid ID");
        }
        this.logger.debug(`[UPDATE REPORT] - Updating report with ID: ${id}`);
        const existedReport = await this.reportRepository.findOne({
            where: { id },
        });
        if (!existedReport) {
            throw new common_1.NotFoundException(`Report not found for ID: ${id}`);
        }
        const uploadedFiles = files?.length
            ? await Promise.all(files.map((file) => this.cloudinaryService.uploadBuffer(file.buffer, {
                folder: "vietflood/reports",
                resource_type: "auto",
            })))
            : [];
        const newEvidences = uploadedFiles.map((item) => ({
            url: item.secure_url,
            publicId: item.public_id,
            resourceType: item.resource_type,
        }));
        const mergedReport = {
            ...existedReport,
            ...updateReportDto,
            evidences: newEvidences.length > 0
                ? [...(existedReport.evidences ?? []), ...newEvidences]
                : existedReport.evidences,
        };
        await this.reportRepository.update(id, mergedReport);
        const updatedReport = await this.reportRepository.findOne({
            where: { id },
            relations: ["user"],
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
    async deleteReport(id) {
        if (!id) {
            throw new common_1.BadRequestException("Invalid ID");
        }
        this.logger.debug(`[DELETE REPORT] - Deleting report with ID: ${id}`);
        const report = await this.reportRepository.findOne({
            where: { id },
        });
        if (!report) {
            throw new common_1.NotFoundException(`Report not found for ID: ${id}`);
        }
        const publicIds = report.evidences
            ?.map((item) => item.publicId)
            .filter((item) => !!item) ?? [];
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
};
exports.ReportsService = ReportsService;
exports.ReportsService = ReportsService = ReportsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(report_entity_1.ReportEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        vietflood_common_1.RedisService,
        vietflood_common_1.LoggerService,
        vietflood_common_1.CloudinaryService])
], ReportsService);
