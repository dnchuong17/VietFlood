import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReportsService } from "./reports-service.service.ts";

function createReportsServiceHarness() {
  const repository = {
    create: vi.fn((report) => report),
    save: vi.fn(async (report) => ({ id: 1, ...report })),
    find: vi.fn(),
    findOne: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    createQueryBuilder: vi.fn(),
  };
  const redis = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  };
  const logger = {
    setServiceName: vi.fn(),
    debug: vi.fn(),
  };
  const cloudinary = {
    deleteMany: vi.fn(),
  };

  const service = new ReportsService(
    repository as never,
    redis as never,
    logger as never,
    cloudinary as never,
  );

  return { cloudinary, logger, redis, repository, service };
}

describe("ReportsService payload normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only grouped areas from recent verified flood reports", async () => {
    const { repository, service } = createReportsServiceHarness();
    const query = {
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      addGroupBy: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getRawMany: vi.fn().mockResolvedValue([
        { province: "Đà Nẵng", ward: "Hải Châu", reportCount: "2", latestAt: new Date("2026-10-09T06:00:00.000Z") },
      ]),
    };
    repository.createQueryBuilder.mockReturnValue(query);

    const result = await service.getRecentVerifiedFloodAreas();

    expect(result).toEqual([
      { province: "Đà Nẵng", ward: "Hải Châu", reportCount: 2, latestAt: "2026-10-09T06:00:00.000Z" },
    ]);
    expect(query.select).toHaveBeenCalledWith("report.province", "province");
    expect(query.addSelect).toHaveBeenCalledWith("report.ward", "ward");
    expect(query.addSelect).not.toHaveBeenCalledWith("report.addressLine", expect.anything());
    expect(query.where).toHaveBeenCalledWith("report.status = :status", { status: "verified" });
    expect(query.andWhere).toHaveBeenCalledWith(":category = ANY(report.category)", { category: "flood" });
    expect(query.andWhere).toHaveBeenCalledWith("report.province IS NOT NULL AND BTRIM(report.province) <> ''");
    expect(query.andWhere).toHaveBeenCalledWith("report.ward IS NOT NULL AND BTRIM(report.ward) <> ''");
    expect(query.take).toHaveBeenCalledWith(5);
    const cutoff = query.andWhere.mock.calls.find(([sql]) => sql === "report.createdAt >= :since")?.[1].since;
    expect(cutoff.getTime()).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000 - 1000);
  });

  it("normalizes multipart coordinate strings and deduplicates create evidences by URL", async () => {
    const { repository, service } = createReportsServiceHarness();

    await service.createReport(
      {
        category: ["flood"],
        description: "Flooded street",
        province: "Da Nang",
        ward: "Hai Chau",
        addressLine: "12 Bach Dang",
        lat: "16.0544" as never,
        lng: "108.2022" as never,
        evidences: [
          { url: "https://cdn.test/a.jpg", publicId: "a" },
          { url: "https://cdn.test/a.jpg", publicId: "a-duplicate" },
          { url: "https://cdn.test/b.jpg", publicId: "b" },
        ],
      },
      7,
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 16.0544,
        lng: 108.2022,
        evidences: [
          { url: "https://cdn.test/a.jpg", publicId: "a", resourceType: undefined },
          { url: "https://cdn.test/b.jpg", publicId: "b", resourceType: undefined },
        ],
        images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
        userId: 7,
      }),
    );
  });

  it("omits invalid coordinates instead of saving NaN-like values", async () => {
    const { repository, service } = createReportsServiceHarness();

    await service.createReport(
      {
        category: ["flood"],
        description: "Flooded street",
        province: "Da Nang",
        ward: "Hai Chau",
        addressLine: "12 Bach Dang",
        lat: "not-a-number" as never,
        lng: "" as never,
      },
      7,
    );

    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("lat");
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("lng");
  });

  it("normalizes latitude and longitude aliases into canonical lat/lng", async () => {
    const { repository, service } = createReportsServiceHarness();

    await service.createReport(
      {
        category: ["flood"],
        description: "Flooded street",
        province: "Da Nang",
        ward: "Hai Chau",
        addressLine: "12 Bach Dang",
        latitude: "16.0544" as never,
        longitude: "108.2022" as never,
      },
      7,
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 16.0544,
        lng: 108.2022,
      }),
    );
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("latitude");
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("longitude");
  });

  it("drops incomplete or out-of-range coordinate pairs", async () => {
    const { repository, service } = createReportsServiceHarness();

    await service.createReport(
      {
        category: ["flood"],
        description: "Flooded street",
        province: "Da Nang",
        ward: "Hai Chau",
        addressLine: "12 Bach Dang",
        lat: "16.0544" as never,
        lng: "181" as never,
      },
      7,
    );

    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("lat");
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty("lng");
  });

  it("normalizes update coordinates and keeps one image URL per evidence", async () => {
    const { repository, service } = createReportsServiceHarness();
    repository.find.mockResolvedValue([
      {
        id: 3,
        userId: 7,
        category: ["flood"],
        description: "Old report",
        province: "Da Nang",
        ward: "Hai Chau",
        addressLine: "12 Bach Dang",
        evidences: [{ url: "https://cdn.test/a.jpg", publicId: "a" }],
      },
    ]);
    repository.findOne.mockResolvedValue({
      id: 3,
      userId: 7,
      lat: 16.055,
      lng: 108.203,
      evidences: [
        { url: "https://cdn.test/a.jpg", publicId: "a" },
        { url: "https://cdn.test/b.jpg", publicId: "b" },
      ],
      images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
    });

    await service.updateReport(3, 7, {
      lat: "16.055" as never,
      lng: "108.203" as never,
      evidences: [
        { url: "https://cdn.test/a.jpg", publicId: "a-again" },
        { url: "https://cdn.test/b.jpg", publicId: "b" },
      ],
    });

    expect(repository.update).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        lat: 16.055,
        lng: 108.203,
        evidences: [
          { url: "https://cdn.test/a.jpg", publicId: "a" },
          { url: "https://cdn.test/b.jpg", publicId: "b", resourceType: undefined },
        ],
        images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
      }),
    );
  });
});
