import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { LoggerService } from "vietflood-common";
import { Server, Socket } from "socket.io";

interface SendLocationPayload {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
}

@WebSocketGateway({
  cors: {
    origin: "*",
  },
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName("TrackingGateway");
  }

  handleConnection(socket: Socket) {
    this.logger.info(`Connected: ${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    this.logger.info(`Disconnected: ${socket.id}`);
    this.server.emit("user-disconnected", socket.id);
  }

  @SubscribeMessage("send-location")
  handleSendLocation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SendLocationPayload,
  ) {
    if (!this.isValidPayload(payload)) {
      socket.emit("location-error", {
        message: "Invalid location payload.",
      });
      return;
    }

    this.server.emit("receive-location", {
      id: socket.id,
      ...payload,
      timestamp: payload.timestamp ?? Date.now(),
    });
  }

  private isValidPayload(payload: SendLocationPayload | undefined): boolean {
    if (!payload) {
      return false;
    }

    return (
      Number.isFinite(payload.latitude) &&
      Number.isFinite(payload.longitude) &&
      payload.latitude >= -90 &&
      payload.latitude <= 90 &&
      payload.longitude >= -180 &&
      payload.longitude <= 180
    );
  }
}
