import {
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  IsNumber,
  IsBoolean,
  MaxLength,
  MinLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";

export class ChatRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @IsOptional()
  @IsUUID()
  actionId?: string;

  @IsOptional()
  @IsIn(["confirm", "cancel"])
  actionDecision?: "confirm" | "cancel";

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  longitude?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  clearLocation?: boolean;
}
