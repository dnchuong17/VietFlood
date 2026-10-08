import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";

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
    @Req() request: { user: { userId: number } },
  ) {
    return this.chatService.listMessages(request.user.userId, sessionId, query.limit, query.cursor);
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

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async chat(
    @Body() body: ChatRequestDto,
    @Req() request: { user: { userId: number } },
  ) {
    return this.chatService.reply(request.user.userId, body);
  }
}
