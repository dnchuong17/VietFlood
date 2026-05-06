import { Controller } from "@nestjs/common";
import { MessagePattern } from "@nestjs/microservices";
import { TrackingService } from "./tracking.service";

@Controller()
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @MessagePattern("tracking_clients")
  getConnectedClients() {
    const clients = this.trackingService.getConnectedClients();

    return {
      count: clients.length,
      clients,
    };
  }

  @MessagePattern("tracking_locations")
  getTrackedLocations() {
    const locations = this.trackingService.getTrackedLocations();

    return {
      count: locations.length,
      locations,
    };
  }
}
