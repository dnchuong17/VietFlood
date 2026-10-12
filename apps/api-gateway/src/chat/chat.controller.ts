import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";

import { JwtAuthGuard } from "../auth/guard/jwt-auth.guard";
import { ChatService } from "./chat.service";
import { ChatAuditInterceptor } from "./chat-audit.interceptor";
import { ChatRequestDto } from "./dto/chat.dto";
import { ChatHistoryQueryDto } from "./dto/chat-history.dto";

@Controller("chat")
@UseGuards(JwtAuthGuard)
@UseInterceptors(ChatAuditInterceptor)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get("sessions")
  @Header("Cache-Control", "private, no-store")
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  listSessions(
    @Query() query: ChatHistoryQueryDto,
    @Req() request: { user: { userId: number } },
  ) {
    return this.chatService.listSessions(request.user.userId, query.limit, query.cursor);
  }

  @Get("sessions/:sessionId/messages")
  @Header("Cache-Control", "private, no-store")
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  listMessages(
    @Param("sessionId", new ParseUUIDPipe({ version: "4" })) sessionId: string,
    @Query() query: ChatHistoryQueryDto,
    @Req() request: { user: { userId: number; role: string; username: string } },
  ) {
    return this.chatService.listMessages(request.user, sessionId, query.limit, query.cursor);
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @Header("Cache-Control", "private, no-store")
  deleteSession(
    @Param("sessionId", new ParseUUIDPipe({ version: "4" })) sessionId: string,
    @Req() request: { user: { userId: number } },
  ) {
    return this.chatService.deleteSession(request.user.userId, sessionId);
  }

  @Get("sources/:documentId/versions/:version")
  @Header("Cache-Control", "private, no-store")
  source(@Param("documentId") documentId: string, @Param("version", ParseIntPipe) version: number) {
    return this.chatService.source(documentId, version);
  }

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @UseInterceptors(FilesInterceptor("files", 5, {
    storage: memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },
    fileFilter: (_request, file, callback) => {
      if (!file.mimetype.startsWith("image/")) {
        callback(new BadRequestException("Chat report evidence must be an image"), false);
        return;
      }
      callback(null, true);
    },
  }))
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async chat(
    @Body() body: ChatRequestDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() request: { user: { userId: number; role: string; username: string } },
  ) {
    if (files?.length && (body.actionDecision !== "confirm" || !body.actionId)) {
      throw new BadRequestException("Evidence can only be uploaded when confirming a report");
    }
    return this.chatService.reply(request.user, body, files ?? []);
  }
}
