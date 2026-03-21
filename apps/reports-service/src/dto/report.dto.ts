import { ReportCategory } from "../enums/report_type.enum";

export class CreateReportDto {
  category: ReportCategory;
  waterLevel?: number;
  description: string;
  evidences?: string[];
  province: string;
  ward: string;
  addressLine?: string;
}
