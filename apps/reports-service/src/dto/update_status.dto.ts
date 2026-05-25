import { IsEnum, IsNotEmpty } from "class-validator";
import { ReportStatus } from "../enums/status.enum";

export class UpdateStatusDto {
  @IsNotEmpty()
  @IsEnum(ReportStatus)
  status: ReportStatus;
}
