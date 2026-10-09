import {
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  MaxLength,
  MinLength,
} from "class-validator";

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
}
