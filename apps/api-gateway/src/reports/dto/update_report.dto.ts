import { CreateReportDto } from "./report.dto";
import { PartialType } from "@nestjs/mapped-types";

export class UpdateReportDto extends PartialType(CreateReportDto) {}
