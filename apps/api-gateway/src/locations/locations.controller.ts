import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";

import { JwtAuthGuard } from "../auth/guard/jwt-auth.guard";
import { GeocodeDto } from "./dto/geocode.dto";
import { LocationsService } from "./locations.service";

@Controller("locations")
@UseGuards(JwtAuthGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get("reverse")
  reverseGeocode(@Query("lat") lat: string, @Query("lng") lng: string) {
    return this.locationsService.reverseGeocode(lat, lng);
  }

  @Post("geocode")
  forwardGeocode(@Body() body: GeocodeDto) {
    return this.locationsService.forwardGeocode(body);
  }
}
