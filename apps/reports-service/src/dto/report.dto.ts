import { ReportCategory } from "../enums/report_type.enum";

class ReportEvidenceDto {
  url: string;
  publicId: string;
  resourceType?: string;
}

export class CreateReportDto {
  category: ReportCategory;
  waterLevel?: number;
  description: string;
  evidences?: ReportEvidenceDto[];
  province: string;
  ward: string;
  addressLine: string;
  lat?: number;
  lng?: number;
  userId?: number;
  createdBy?: string;
  isUrgent?: boolean;
  severity?: number;
}
