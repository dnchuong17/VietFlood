import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocationsService } from "./locations.service";

const provinces = [
  { code: 48, name: "Thành phố Đà Nẵng" },
  { code: 79, name: "Thành phố Hồ Chí Minh" },
];

const wards = [
  { code: 20194, name: "Phường Hải Châu", province_code: 48 },
  { code: 26734, name: "Phường Bà Rịa", province_code: 79 },
];

function createHarness() {
  const redisValues = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => redisValues.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisValues.set(key, value);
      return "OK";
    }),
  };
  const logger = {
    setServiceName: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };

  const service = new LocationsService(redis as never, logger as never);
  return { logger, redis, redisValues, service };
}

describe("LocationsService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  });

  it("reverse geocodes coordinates and maps city/suburb to v2 province and ward", async () => {
    const { service } = createHarness();
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.includes("/api/v2/p/")) return provinces;
        if (url.includes("/api/v2/w/")) return wards;
        return {
          lat: "16.0544",
          lon: "108.2022",
          display_name: "12 Bạch Đằng, Hải Châu, Đà Nẵng",
          licence: "Data © OpenStreetMap contributors, ODbL 1.0",
          address: {
            city: "Đà Nẵng",
            suburb: "Hải Châu",
            road: "Bạch Đằng",
            house_number: "12",
          },
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.reverseGeocode(16.0544, 108.2022)).resolves.toEqual(
      expect.objectContaining({
        coordinates: { lat: 16.0544, lng: 108.2022 },
        province: { code: 48, name: "Thành phố Đà Nẵng" },
        ward: { code: 20194, name: "Phường Hải Châu", provinceCode: 48 },
        addressLine: "12 Bạch Đằng",
        matchLevel: "ward",
      }),
    );
  });

  it("does not choose the first ward when Nominatim has no matching ward candidate", async () => {
    const { service } = createHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url.includes("/api/v2/p/")) return provinces;
          if (url.includes("/api/v2/w/")) return wards;
          return {
            lat: "16.0544",
            lon: "108.2022",
            display_name: "Đà Nẵng",
            address: { city: "Đà Nẵng", suburb: "Không Khớp" },
          };
        },
      })),
    );

    const result = await service.reverseGeocode(16.0544, 108.2022);

    expect(result.province).toEqual({ code: 48, name: "Thành phố Đà Nẵng" });
    expect(result.ward).toBeNull();
    expect(result.matchLevel).toBe("province");
  });

  it("caches reverse lookups for 24 hours and forward lookups for 7 days", async () => {
    const { redis, service } = createHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url.includes("/api/v2/p/")) return provinces;
          if (url.includes("/api/v2/w/")) return wards;
          if (url.includes("/search")) {
            return [
              {
                lat: "16.0544",
                lon: "108.2022",
                display_name: "12 Bạch Đằng, Đà Nẵng",
                address: { city: "Đà Nẵng", suburb: "Hải Châu" },
              },
            ];
          }
          return {
            lat: "16.0544",
            lon: "108.2022",
            display_name: "12 Bạch Đằng, Đà Nẵng",
            address: { city: "Đà Nẵng", suburb: "Hải Châu" },
          };
        },
      })),
    );

    await service.reverseGeocode(16.0544, 108.2022);
    await service.forwardGeocode({
      province: "Thành phố Đà Nẵng",
      ward: "Phường Hải Châu",
      addressLine: "12 Bạch Đằng",
    });

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("locations:reverse"),
      expect.any(String),
      24 * 60 * 60,
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("locations:forward"),
      expect.any(String),
      7 * 24 * 60 * 60,
    );
  });
});
