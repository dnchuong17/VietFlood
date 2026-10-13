import { describe, expect, it } from "vitest";
import { validateRetrieval } from "./check-chat-runtime.js";

const health = {
  status: "ready", alias: "flood_kb_active",
  collection: "flood_kb_active_20261012170418_13a14650", pointCount: 212,
};
describe("Retrieval deployment readiness", () => {
  it("accepts the active alias even though it resolves to a versioned collection", () => {
    expect(validateRetrieval(health, "flood_kb_active")).toEqual({ alias: "flood_kb_active", pointCount: 212 });
  });
  it("identifies the physical collection configured instead of the alias", () => {
    expect(() => validateRetrieval(health, health.collection)).toThrow("retrieval_alias_mismatch");
    try { validateRetrieval(health, health.collection); }
    catch (error) {
      expect(error.details).toEqual({ expectedAlias: health.collection, reportedAlias: "flood_kb_active", reportedStatus: "ready", pointCount: 212 });
    }
  });
  it("fails when the retrieval service reports it is not ready", () => {
    expect(() => validateRetrieval({ ...health, status: "unavailable" }, health.alias)).toThrow("retrieval_not_ready");
  });
  it.each([0, -1, "212", 0.5, undefined])("rejects an empty or invalid point count: %s", (pointCount) => {
    expect(() => validateRetrieval({ ...health, pointCount }, health.alias)).toThrow("retrieval_empty_or_invalid_point_count");
  });
  it.each([null, undefined, [], "ready"])("rejects invalid health objects", (value) => {
    expect(() => validateRetrieval(value, health.alias)).toThrow("retrieval_invalid_health_response");
  });
  it("limits failure metadata to expected identifiers and counts", () => {
    try { validateRetrieval({ ...health, alias: "secret\nprovider text", token: "private-token" }, health.alias); }
    catch (error) {
      expect(error.details.reportedAlias).toBe("[invalid]");
      expect(JSON.stringify(error.details)).not.toMatch(/private-token|provider text/);
    }
  });
});
