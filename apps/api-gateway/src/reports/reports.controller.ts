import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";

import { ReportsService } from "./reports.service";
import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";
import { JwtAuthGuard } from "../auth/guard/jwt-auth.guard";
import { Roles } from "../auth/Decorators/role.decorator";
import { memoryStorage } from "multer";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @UseGuards(JwtAuthGuard)
  @Post("create")
  @UseInterceptors(FilesInterceptor("files", 10, { storage: memoryStorage() }))
  async createReport(
    @Body() createReportDto: CreateReportDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.reportsService.createReport(createReportDto, files);
  }

  @UseGuards(JwtAuthGuard)
  @Get("")
  async getAllReports() {
    return this.reportsService.getAllReports();
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id/admin/:userId")
  @UseInterceptors(FilesInterceptor("files", 5))
  @Roles("admin")
  async updateReport(
    @Param("id", ParseIntPipe) id: number,
    @Param("userId", ParseIntPipe) userId: number,
    @Body() updateReportDto: UpdateReportDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.reportsService.updateReport(id, userId, updateReportDto, files);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  @UseInterceptors(FilesInterceptor("files", 5))
  async updateReportByUser(
    @Param("id", ParseIntPipe) id: number,
    @Req() req,
    @Body() updateReportDto: UpdateReportDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.reportsService.updateReport(
      id,
      req.user.id,
      updateReportDto,
      files,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(":id/admin/:userId")
  @Roles("admin")
  async deleteReport(
    @Param("id", ParseIntPipe) id: number,
    @Param("userId", ParseIntPipe) userId: number,
  ) {
    return this.reportsService.deleteReport(id, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  async deleteReportByUser(@Param("id", ParseIntPipe) id: number, @Req() req) {
    return this.reportsService.deleteReport(id, req.user.id);
  }
}
