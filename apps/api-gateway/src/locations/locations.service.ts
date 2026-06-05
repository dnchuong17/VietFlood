import { BadRequestException, Injectable } from "@nestjs/common";
import { LoggerService, RedisService } from "vietflood-common";

import { GeocodeDto } from "./dto/geocode.dto";

const NOMINATIM_BASE_URL =
  process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  "VietFlood/1.0 (https://github.com/dnchuong17/VietFlood)";
const VIETNAM_DIVISIONS_API_URL =
  process.env.VIETNAM_DIVISIONS_API_URL ??
  "https://provinces.open-api.vn/api/v2";

const REVERSE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const FORWARD_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DIVISIONS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const NOMINATIM_MIN_INTERVAL_MS = 1000;
const DIVISIONS_CACHE_KEY = "locations:divisions:v2";

type ProvinceDivision = {
  code: number;
  name: string;
};

type WardDivision = {
  code: number;
  name: string;
  province_code: number;
};

type Divisions = {
  provinces: ProvinceDivision[];
  wards: WardDivision[];
};

type Coordinates = {
  lat: number;
  lng: number;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  licence?: string;
  address?: Record<string, string | undefined>;
};

type MatchLevel = "ward" | "province" | "coordinates" | "unmatched";

export type LocationGeocodeResult = {
  coordinates: Coordinates | null;
  province: ProvinceDivision | null;
  ward: { code: number; name: string; provinceCode: number } | null;
  addressLine: string | null;
  displayName: string | null;
  matchLevel: MatchLevel;
  attribution: {
    provider: "OpenStreetMap Nominatim";
    license: string;
    url: "https://www.openstreetmap.org/copyright";
  };
};

@Injectable()
export class LocationsService {
  private divisionsPromise: Promise<Divisions> | null = null;
  private lastNominatimCall = 0;
  private nominatimQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly redis: RedisService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(LocationsService.name);
  }

  async reverseGeocode(
    latInput: unknown,
    lngInput: unknown,
  ): Promise<LocationGeocodeResult> {
    const coordinates = this.parseCoordinatePair(latInput, lngInput);
    if (!coordinates) {
      throw new BadRequestException("Valid lat/lng are required");
    }

    const cacheKey = `locations:reverse:${coordinates.lat.toFixed(6)},${coordinates.lng.toFixed(6)}`;
    const cached = await this.getCachedLocation(cacheKey);
    if (cached) {
      return cached;
    }

    const searchParams = new URLSearchParams({
      format: "jsonv2",
      lat: String(coordinates.lat),
      lon: String(coordinates.lng),
      addressdetails: "1",
      "accept-language": "vi",
      layer: "address",
    });

    const raw = await this.fetchNominatim<NominatimResult>(
      `/reverse?${searchParams.toString()}`,
    );
    const result = await this.normalizeNominatimResult(raw, {
      coordinates,
    });

    await this.setCachedLocation(
      cacheKey,
      result,
      REVERSE_CACHE_TTL_SECONDS,
    );

    return result;
  }

  async forwardGeocode(input: GeocodeDto): Promise<LocationGeocodeResult> {
    const query = this.buildForwardQuery(input);
    if (!query) {
      throw new BadRequestException("Location text is required");
    }

    const cacheKey = `locations:forward:${this.normalizeCacheKey(query)}`;
    const cached = await this.getCachedLocation(cacheKey);
    if (cached) {
      return cached;
    }

    const searchParams = new URLSearchParams({
      format: "jsonv2",
      q: query,
      addressdetails: "1",
      limit: "1",
      countrycodes: "vn",
      "accept-language": "vi",
    });

    const rawResults = await this.fetchNominatim<NominatimResult[]>(
      `/search?${searchParams.toString()}`,
    );
    const raw = rawResults[0];
    const result = raw
      ? await this.normalizeNominatimResult(raw, {
          coordinates: this.parseCoordinatePair(raw.lat, raw.lon),
          input,
        })
      : this.emptyResult(input);

    await this.setCachedLocation(
      cacheKey,
      result,
      FORWARD_CACHE_TTL_SECONDS,
    );

    return result;
  }

  private async normalizeNominatimResult(
    raw: NominatimResult,
    options: { coordinates?: Coordinates | null; input?: GeocodeDto },
  ): Promise<LocationGeocodeResult> {
    const divisions = await this.getDivisions();
    const address = raw.address ?? {};
    const province = this.findProvince(divisions.provinces, [
      options.input?.province,
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.county,
      address.state,
    ]);
    const ward = province
      ? this.findWard(
          divisions.wards.filter((item) => item.province_code === province.code),
          [
            options.input?.ward,
            address.ward,
            address.suburb,
            address.city_district,
            address.neighbourhood,
            address.quarter,
            address.village,
            address.town,
          ],
        )
      : null;
    const addressLine = this.buildAddressLine(
      address,
      options.input?.addressLine,
    );
    const coordinates =
      options.coordinates ?? this.parseCoordinatePair(raw.lat, raw.lon);
    const matchLevel = this.getMatchLevel(Boolean(ward), Boolean(province), coordinates);

    return {
      coordinates,
      province,
      ward: ward
        ? {
            code: ward.code,
            name: ward.name,
            provinceCode: ward.province_code,
          }
        : null,
      addressLine,
      displayName: raw.display_name ?? addressLine,
      matchLevel,
      attribution: this.buildAttribution(raw.licence),
    };
  }

  private emptyResult(input: GeocodeDto): LocationGeocodeResult {
    return {
      coordinates: null,
      province: input.province
        ? {
            code: 0,
            name: input.province,
          }
        : null,
      ward: null,
      addressLine: this.cleanText(input.addressLine) ?? null,
      displayName: this.cleanText(
        [input.addressLine, input.ward, input.province]
          .map((item) => this.cleanText(item))
          .filter(Boolean)
          .join(", "),
      ),
      matchLevel: "unmatched",
      attribution: this.buildAttribution(),
    };
  }

  private getMatchLevel(
    hasWard: boolean,
    hasProvince: boolean,
    coordinates: Coordinates | null,
  ): MatchLevel {
    if (hasWard) return "ward";
    if (hasProvince) return "province";
    if (coordinates) return "coordinates";
    return "unmatched";
  }

  private buildAttribution(license?: string) {
    return {
      provider: "OpenStreetMap Nominatim" as const,
      license: license ?? "OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright" as const,
    };
  }

  private buildForwardQuery(input: GeocodeDto): string {
    return [
      input.addressLine,
      input.ward,
      input.province,
      "Vietnam",
    ]
      .map((item) => this.cleanText(item))
      .filter(Boolean)
      .join(", ");
  }

  private buildAddressLine(
    address: Record<string, string | undefined>,
    fallback?: string,
  ): string | null {
    const line = [address.house_number, address.road]
      .map((item) => this.cleanText(item))
      .filter(Boolean)
      .join(" ");

    return line || this.cleanText(fallback) || null;
  }

  private findProvince(
    provinces: ProvinceDivision[],
    candidates: Array<string | undefined>,
  ): ProvinceDivision | null {
    return this.findByCandidates(provinces, candidates);
  }

  private findWard(
    wards: WardDivision[],
    candidates: Array<string | undefined>,
  ): WardDivision | null {
    return this.findByCandidates(wards, candidates);
  }

  private findByCandidates<T extends { name: string }>(
    items: T[],
    candidates: Array<string | undefined>,
  ): T | null {
    const normalizedCandidates = candidates
      .map((item) => this.normalizeName(item))
      .filter(Boolean);

    if (normalizedCandidates.length === 0) {
      return null;
    }

    return (
      items.find((item) => {
        const itemName = this.normalizeName(item.name);
        return normalizedCandidates.some(
          (candidate) =>
            itemName === candidate ||
            itemName.includes(candidate) ||
            candidate.includes(itemName),
        );
      }) ?? null
    );
  }

  private normalizeName(value: unknown): string {
    if (typeof value !== "string") return "";

    return value
      .replace(/[đĐ]/g, (item) => (item === "Đ" ? "D" : "d"))
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(
        /\b(thanh pho|tp\.?|tinh|quan|huyen|thi xa|thi tran|phuong|xa)\b/g,
        "",
      )
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private normalizeCacheKey(value: string): string {
    return this.normalizeName(value).replace(/\s+/g, "-") || "empty";
  }

  private cleanText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private parseCoordinatePair(
    latInput: unknown,
    lngInput: unknown,
  ): Coordinates | null {
    const lat = this.toFiniteNumber(latInput);
    const lng = this.toFiniteNumber(lngInput);

    if (lat === undefined || lng === undefined) {
      return null;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }

    return { lat, lng };
  }

  private toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private async getDivisions(): Promise<Divisions> {
    const cached = await this.getCachedDivisions();
    if (cached) {
      return cached;
    }

    if (!this.divisionsPromise) {
      this.divisionsPromise = Promise.all([
        this.fetchJson<ProvinceDivision[]>(`${VIETNAM_DIVISIONS_API_URL}/p/`),
        this.fetchJson<WardDivision[]>(`${VIETNAM_DIVISIONS_API_URL}/w/`),
      ])
        .then(async ([provinces, wards]) => {
          const divisions = { provinces, wards };
          await this.setCache(
            DIVISIONS_CACHE_KEY,
            JSON.stringify(divisions),
            DIVISIONS_CACHE_TTL_SECONDS,
          );
          return divisions;
        })
        .finally(() => {
          this.divisionsPromise = null;
        });
    }

    return this.divisionsPromise;
  }

  private async getCachedDivisions(): Promise<Divisions | null> {
    const raw = await this.getCache(DIVISIONS_CACHE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed?.provinces) &&
        Array.isArray(parsed?.wards)
      ) {
        return parsed as Divisions;
      }
    } catch {
      this.logger.warn("Ignoring invalid divisions cache");
    }

    return null;
  }

  private async getCachedLocation(
    key: string,
  ): Promise<LocationGeocodeResult | null> {
    const raw = await this.getCache(key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      return this.isLocationGeocodeResult(parsed) ? parsed : null;
    } catch {
      this.logger.warn(`Ignoring invalid location cache: ${key}`);
      return null;
    }
  }

  private isLocationGeocodeResult(value: unknown): value is LocationGeocodeResult {
    if (!this.isRecord(value)) return false;
    if (value.coordinates !== null) {
      if (!this.isRecord(value.coordinates)) return false;
      if (
        typeof value.coordinates.lat !== "number" ||
        typeof value.coordinates.lng !== "number"
      ) {
        return false;
      }
    }

    return typeof value.matchLevel === "string" && this.isRecord(value.attribution);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private async setCachedLocation(
    key: string,
    value: LocationGeocodeResult,
    ttlSeconds: number,
  ) {
    await this.setCache(key, JSON.stringify(value), ttlSeconds);
  }

  private async getCache(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logger.warn(`Failed to read cache ${key}: ${String(error)}`);
      return null;
    }
  }

  private async setCache(key: string, value: string, ttlSeconds: number) {
    try {
      await this.redis.set(key, value, ttlSeconds);
    } catch (error) {
      this.logger.warn(`Failed to write cache ${key}: ${String(error)}`);
    }
  }

  private async fetchNominatim<T>(path: string): Promise<T> {
    return this.enqueueNominatimFetch(() =>
      this.fetchJson<T>(`${NOMINATIM_BASE_URL}${path}`),
    );
  }

  private enqueueNominatimFetch<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.nominatimQueue.then(async () => {
      if (process.env.NODE_ENV !== "test") {
        const elapsed = Date.now() - this.lastNominatimCall;
        if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
          await new Promise((resolve) =>
            setTimeout(resolve, NOMINATIM_MIN_INTERVAL_MS - elapsed),
          );
        }
      }

      this.lastNominatimCall = Date.now();
      return operation();
    });

    this.nominatimQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": NOMINATIM_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new BadRequestException(`Location provider failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
