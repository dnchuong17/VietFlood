import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSource } from "typeorm";
import { IncidentRepository } from "./incident.repository";

const relief = { userId: 2, role: "relief" };
const admin = { userId: 1, role: "admin" };
const unavailable = {
  statusCode: 503,
  code: "incidents_unavailable",
  message: "Incident storage is not configured",
};
function fixture() {
  const query = vi.fn().mockResolvedValue([{ ready: false, postgis: false }]);
  const transaction = vi.fn(async (run) => run({ query }));
  const repo = new IncidentRepository({
    query,
    transaction,
  } as unknown as DataSource);
  vi.stubEnv("INCIDENTS_ENABLED", "false");
  return { repo, query, transaction };
}
afterEach(() => vi.unstubAllEnvs());

describe("incident readiness recovery", () => {
  it("keeps enabled startup fail-fast when the schema is absent", async () => {
    const { repo, query } = fixture();
    vi.stubEnv("INCIDENTS_ENABLED", "true");
    await expect(repo.onModuleInit()).rejects.toThrow(
      "Run the incident migration before enabling incidents",
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(repo.ready).toBe(false);
  });
  it("returns sanitized unavailability while absent, then recovers reads without enabling processing", async () => {
    const { repo, query } = fixture();
    await repo.onModuleInit();
    await expect(repo.read(relief, "emergencies", "")).rejects.toMatchObject(
      unavailable,
    );
    expect(query).toHaveBeenCalledTimes(2);
    query
      .mockResolvedValueOnce([{ ready: true, postgis: false }])
      .mockResolvedValueOnce([]);
    await expect(repo.read(relief, "emergencies", "")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(repo.ready).toBe(true);
    expect(repo.enabled).toBe(false);
  });
  it("recovers mutations before opening their transaction when processing is disabled", async () => {
    const { repo, query, transaction } = fixture();
    await repo.onModuleInit();
    query.mockResolvedValueOnce([{ ready: true, postgis: false }]);
    const resolve = vi.spyOn(repo, "resolve").mockImplementation(async () => {
      expect(repo.ready).toBe(true);
      return { reportId: 7, excluded: true };
    });
    await expect(
      repo.mutate(admin, "resolve", "7", { action: "exclude" }),
    ).resolves.toEqual({ reportId: 7, excluded: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(repo.enabled).toBe(false);
  });
  it("shares one in-flight refresh across reads and mutations", async () => {
    const { repo, query } = fixture();
    await repo.onModuleInit();
    let release!: (rows: unknown[]) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.spyOn(repo, "resolve").mockResolvedValue({
      reportId: 7,
      excluded: true,
    });
    const requests = [
      repo.read(relief, "emergencies", ""),
      repo.read(relief, "emergencies", ""),
      repo.mutate(admin, "resolve", "7", {}),
    ];
    expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValue([]);
    release([{ ready: true, postgis: false }]);
    await Promise.all(requests);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("to_regclass")),
    ).toHaveLength(2);
  });
  it("clears failed shared refreshes, sanitizes errors, and permits a later retry", async () => {
    const { repo, query, transaction } = fixture();
    await repo.onModuleInit();
    query.mockRejectedValueOnce(
      new Error("postgresql://secret@private-host/catalog SQL failure"),
    );
    const results = await Promise.allSettled([
      repo.read(relief, "emergencies", ""),
      repo.mutate(admin, "resolve", "7", {}),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ status: "rejected", reason: unavailable });
      if (result.status === "rejected")
        expect(String(result.reason)).not.toContain("secret");
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(repo.ready).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    query
      .mockResolvedValueOnce([{ ready: true, postgis: false }])
      .mockResolvedValueOnce([]);
    await expect(repo.read(relief, "emergencies", "")).resolves.toMatchObject({
      items: [],
    });
  });
  it("never probes readiness on healthy read or mutate paths", async () => {
    const { repo, query } = fixture();
    query.mockResolvedValueOnce([{ ready: true, postgis: false }]);
    await repo.onModuleInit();
    query.mockClear().mockResolvedValue([]);
    vi.spyOn(repo, "resolve").mockResolvedValue({
      reportId: 7,
      excluded: true,
    });
    await repo.read(relief, "emergencies", "");
    await repo.mutate(admin, "resolve", "7", {});
    expect(query).toHaveBeenCalledTimes(2); // feed query and transaction lock only
    expect(query.mock.calls.some(([sql]) => sql.includes("to_regclass"))).toBe(
      false,
    );
  });
  it("refreshes PostGIS metadata atomically and retries a failed metadata lookup", async () => {
    const { repo, query } = fixture();
    await repo.onModuleInit();
    query
      .mockResolvedValueOnce([{ ready: true, postgis: true }])
      .mockRejectedValueOnce(new Error("private catalog details"));
    await expect(repo.requireReady()).rejects.toMatchObject(unavailable);
    expect(repo.ready).toBe(false);
    query
      .mockResolvedValueOnce([{ ready: true, postgis: true }])
      .mockResolvedValueOnce([{ name: '"spatial"' }]);
    await repo.requireReady();
    expect(repo.ready).toBe(true);
    expect(repo.postgis).toBe(true);
    expect(repo.postgisNamespace).toBe('"spatial"');
  });
  it("authorizes before probing or opening transactions", async () => {
    const { repo, query, transaction } = fixture();
    await expect(
      repo.read({ userId: 3, role: "citizen" }, "emergencies", ""),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(repo.mutate(relief, "resolve", "7", {})).rejects.toMatchObject(
      { statusCode: 403 },
    );
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
