import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { SendLocationPayload, TrackingService } from "./tracking.service";

@WebSocketGateway({
  cors: {
    origin: "*",
  },
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly trackingService: TrackingService) {}

  handleConnection(socket: Socket) {
    this.trackingService.handleConnection(socket.id);
  }

  handleDisconnect(socket: Socket) {
    this.trackingService.handleDisconnect(socket.id);
    this.server.emit("user-disconnected", socket.id);
  }

  @SubscribeMessage("send-location")
  handleSendLocation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: SendLocationPayload,
  ) {
    const result = this.trackingService.processLocationUpdate(socket.id, payload);

    if (!result.valid) {
      socket.emit("location-error", {
        message: result.message,
      });
      return;
    }

    this.server.emit("receive-location", result.data);
  }
}
