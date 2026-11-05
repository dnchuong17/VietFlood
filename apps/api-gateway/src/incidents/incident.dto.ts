import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBooleanString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from "class-validator";

export class IncidentQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @IsOptional() @IsString() @MaxLength(200) province?: string;
  @IsOptional() @IsString() @MaxLength(200) ward?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional()
  @IsIn(["DETECTED", "UNDER_REVIEW", "VERIFIED", "RESCUE_DEPLOYED", "RESOLVED"])
  status?: string;
  @IsOptional()
  @IsIn(["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"])
  severity?: string;
  @IsOptional() @IsBooleanString() assignedToMe?: string;
}
export class VersionedChange {
  @IsInt() @Min(1) expectedVersion: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class StatusChange extends VersionedChange {
  @IsIn(["DETECTED", "UNDER_REVIEW", "RESCUE_DEPLOYED", "RESOLVED"])
  status: string;
}
export class SeverityChange extends VersionedChange {
  @IsIn(["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"]) severity: string;
}
export class AssignmentChange extends VersionedChange {
  @ValidateIf((_, value) => value !== null) @IsInt() @Min(1) assigneeId:
    | number
    | null;
}
export class VerifyChange extends VersionedChange {
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  factIds: string[];
}
export class SplitChange extends VersionedChange {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  reportIds: number[];
}
export class MergeSource {
  @IsUUID() id: string;
  @IsInt() @Min(1) expectedVersion: number;
}
export class MergeChange extends VersionedChange {
  @IsUUID() targetId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MergeSource)
  sources: MergeSource[];
}
export class ResolveChange {
  @IsInt() @Min(1) expectedRevision: number;
  @IsIn(["attach", "create", "exclude"]) action: string;
  @ValidateIf((o: ResolveChange) => o.action === "attach")
  @IsUUID()
  incidentId?: string;
  @ValidateIf((o: ResolveChange) => o.action === "attach")
  @IsInt()
  @Min(1)
  expectedVersion?: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class ProcessRequest {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  reportIds?: number[];
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class IncidentIntelligenceQuery extends IncidentQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) mapLimit?: number;
}

export class SummaryEditChange extends VersionedChange {
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsString() @MinLength(3) @MaxLength(12000) body: string;
}
