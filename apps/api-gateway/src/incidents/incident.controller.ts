import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guard/jwt-auth.guard";
import { RolesGuard } from "../auth/guard/role.guard";
import { Roles } from "../auth/Decorators/role.decorator";
import { UserRole } from "../auth/enum/userRole.enum";
import {
  IncidentExceptionFilter,
  IncidentGatewayService,
} from "./incident.http";
import {
  AssignmentChange,
  IncidentQuery,
  MergeChange,
  ProcessRequest,
  ResolveChange,
  SeverityChange,
  SplitChange,
  StatusChange,
  VerifyChange,
  VersionedChange,
} from "./incident.dto";

export function requireKey(value: string) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(value ?? ""))
    throw new BadRequestException(
      "Idempotency-Key is required (8–100 letters, digits, hyphens or underscores)",
    );
  return value;
}
@Controller("incidents")
@UseFilters(IncidentExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.RELIEF)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class IncidentsController {
  constructor(private readonly gateway: IncidentGatewayService) {}
  @Get() list(@Req() req: any, @Query() q: IncidentQuery) {
    return this.gateway.read(req, "list", "", q);
  }
  @Get("overview") overview(@Req() req: any, @Query() q: IncidentQuery) {
    return this.gateway.read(req, "overview", "", q);
  }
  @Get("emergencies") emergencies(@Req() req: any, @Query() q: IncidentQuery) {
    return this.gateway.read(req, "emergencies", "", q);
  }
  @Get("review") @Roles(UserRole.ADMIN) review(
    @Req() req: any,
    @Query() q: IncidentQuery,
  ) {
    return this.gateway.read(req, "review", "", q);
  }
  @Get("assignees") @Roles(UserRole.ADMIN) assignees(
    @Req() req: any,
    @Query() q: IncidentQuery,
  ) {
    return this.gateway.read(req, "assignees", "", q);
  }
  @Post("review/:reportId/resolve")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  resolve(
    @Req() req: any,
    @Param("reportId", ParseIntPipe) id: number,
    @Body() body: ResolveChange,
    @Headers("idempotency-key") key: string,
  ) {
    return this.gateway.mutate(
      req,
      "resolve",
      String(id),
      body,
      requireKey(key),
    );
  }
  @Post("merge")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  merge(
    @Req() req: any,
    @Body() body: MergeChange,
    @Headers("idempotency-key") key: string,
  ) {
    if (new Set(body.sources.map((s) => s.id)).size !== body.sources.length)
      throw new BadRequestException("Duplicate merge sources");
    return this.gateway.mutate(req, "merge", "", body, requireKey(key));
  }
  @Get(":id") detail(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.gateway.read(req, "detail", id);
  }
  @Get(":id/reports") reports(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() q: IncidentQuery,
  ) {
    return this.gateway.read(req, "reports", id, q);
  }
  @Get(":id/reports/:reportId") source(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("reportId", ParseIntPipe) reportId: number,
  ) {
    return this.gateway.read(req, "source", id, { reportId });
  }
  @Get(":id/reports/:reportId/revisions") revisions(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("reportId", ParseIntPipe) reportId: number,
    @Query() q: IncidentQuery,
  ) {
    return this.gateway.read(req, "revisions", id, { ...q, reportId });
  }
  @Get(":id/history") history(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() q: IncidentQuery,
  ) {
    return this.gateway.read(req, "history", id, q);
  }
  @Post(":id/verify")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  verify(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: VerifyChange,
    @Headers("idempotency-key") key: string,
  ) {
    return this.gateway.mutate(req, "verify", id, body, requireKey(key));
  }
  @Patch(":id/status") status(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: StatusChange,
  ) {
    return this.gateway.mutate(req, "status", id, body);
  }
  @Patch(":id/severity")
  @Roles(UserRole.ADMIN)
  severity(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SeverityChange,
  ) {
    return this.gateway.mutate(req, "severity", id, body);
  }
  @Patch(":id/assignment")
  @Roles(UserRole.ADMIN)
  assignment(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: AssignmentChange,
  ) {
    return this.gateway.mutate(req, "assignment", id, body);
  }
  @Post(":id/regenerate-summary")
  @HttpCode(202)
  @Roles(UserRole.ADMIN)
  regenerate(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: VersionedChange,
    @Headers("idempotency-key") key: string,
  ) {
    return this.gateway.mutate(req, "regenerate", id, body, requireKey(key));
  }
  @Post(":id/split")
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  split(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SplitChange,
    @Headers("idempotency-key") key: string,
  ) {
    return this.gateway.mutate(req, "split", id, body, requireKey(key));
  }
}
@Controller("ai/incidents")
@UseFilters(IncidentExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class IncidentProcessingController {
  constructor(private readonly gateway: IncidentGatewayService) {}
  @Post("process")
  @HttpCode(202)
  process(
    @Req() req: any,
    @Body() body: ProcessRequest,
    @Headers("idempotency-key") key: string,
  ) {
    if (
      body.reportIds
        ? body.from || body.to
        : !body.from ||
          !body.to ||
          Date.parse(body.from) > Date.parse(body.to) ||
          Date.parse(body.to) - Date.parse(body.from) > 31 * 86400000
    )
      throw new BadRequestException(
        "Choose reportIds or an ordered date range of at most 31 days",
      );
    return this.gateway.mutate(req, "process", "", body, requireKey(key));
  }
  @Get("jobs/:id") job(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.gateway.read(req, "job", id);
  }
}
