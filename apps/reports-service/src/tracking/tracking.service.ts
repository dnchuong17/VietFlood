import { Injectable } from "@nestjs/common";
import { LoggerService } from "vietflood-common";

export interface SendLocationPayload {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
}

interface TrackedLocation extends SendLocationPayload {
  socketId: string;
  updatedAt: number;
}

@Injectable()
export class TrackingService {
  private readonly connectedClients = new Set<string>();
  private readonly locations = new Map<string, TrackedLocation>();

  constructor(private readonly logger: LoggerService) {
    this.logger.setServiceName(TrackingService.name);
  }

  handleConnection(socketId: string): void {
    this.connectedClients.add(socketId);
    this.logger.info(`Connected: ${socketId}`);
  }

  handleDisconnect(socketId: string): void {
    this.connectedClients.delete(socketId);
    this.locations.delete(socketId);
    this.logger.info(`Disconnected: ${socketId}`);
  }

  processLocationUpdate(socketId: string, payload: SendLocationPayload) {
    if (!this.isValidPayload(payload)) {
      return {
        valid: false as const,
        message: "Invalid location payload.",
      };
    }

    const timestamp = payload.timestamp ?? Date.now();
    const trackedLocation: TrackedLocation = {
      socketId,
      ...payload,
      timestamp,
      updatedAt: Date.now(),
    };

    this.locations.set(socketId, trackedLocation);

    return {
      valid: true as const,
      data: {
        id: socketId,
        ...payload,
        timestamp,
      },
    };
  }

  getConnectedClients() {
    return Array.from(this.connectedClients);
  }

  getTrackedLocations() {
    return Array.from(this.locations.values());
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
