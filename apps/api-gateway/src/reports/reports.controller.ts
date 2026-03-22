import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";

import { ReportsService } from "./reports.service";
import { CreateReportDto } from "./dto/report.dto";
import { UpdateReportDto } from "./dto/update_report.dto";
import { JwtAuthGuard } from "../auth/guard/jwt-auth.guard";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FilesInterceptor("files", 5))
  async createReport(
    @Body() createReportDto: CreateReportDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.reportsService.createReport(createReportDto, files);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async getAllReports() {
    return this.reportsService.getAllReports();
  }

  @UseGuards(JwtAuthGuard)
  @Patch(":id")
  @UseInterceptors(FilesInterceptor("files", 5))
  async updateReport(
    @Param("id", ParseIntPipe) id: number,
    @Body() updateReportDto: UpdateReportDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.reportsService.updateReport(id, updateReportDto, files);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(":id")
  async deleteReport(@Param("id", ParseIntPipe) id: number) {
    return this.reportsService.deleteReport(id);
  }
}
