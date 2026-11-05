import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cosine,
  distance,
  geoTemporalMatch,
  urgent,
  redact,
  checkStatus,
  matchingConfig,
  hash,
  PIPELINE,
} from "./incident-domain";
import { renderSummary } from "./incident-summary";
import { automaticAllowed } from "./incident.worker";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllEnvs());
const report = { lat: 16.047, lng: 108.206, createdAt: "2026-11-01T10:00:00Z" };
const incident = {
  ...report,
  status: "DETECTED",
  first_reported_at: "2026-11-01T09:00:00Z",
  latest_reported_at: "2026-11-01T09:30:00Z",
  address: "Đường A",
  ward: "Hải Châu",
  evidence_version: 2,
};
describe("incident matching and grounding invariants", () => {
  it("gates by GPS, event age, resolved status and a fixed geographic anchor", () => {
    expect(geoTemporalMatch(report, incident)).toBe(true);
    expect(geoTemporalMatch({ ...report, lat: 17 }, incident)).toBe(false);
    expect(geoTemporalMatch({ ...report, lat: null }, incident)).toBe(false);
    expect(
      geoTemporalMatch(
        { ...report, createdAt: "2026-11-02T10:00:00Z" },
        incident,
      ),
    ).toBe(false);
    expect(geoTemporalMatch(report, { ...incident, status: "RESOLVED" })).toBe(
      false,
    );
    expect(distance(report, report)).toBe(0);
  });
  it("does not interpret similarity as a probability or accept invalid vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
    expect(cosine([0, 0], [1, 0])).toBe(-1);
    expect(cosine([NaN], [1])).toBe(-1);
    expect(cosine([1], [1, 0])).toBe(-1);
  });
  it("detects emergencies before AI but preserves negation", () => {
    expect(urgent({ description: "Người mắc kẹt, cứu với" })).toBe(true);
    expect(urgent({ description: "Không có người mắc kẹt" })).toBe(false);
    expect(urgent({ description: "ngap", isUrgent: "false" })).toBe(false);
    expect(urgent({ description: "ngap", isUrgent: "true" })).toBe(true);
    expect(urgent({ category: ["rescue"] })).toBe(true);
  });
  it("redacts direct contact details without damaging depth measurements", () => {
    expect(redact("Ngập 50 cm; gọi 0901234567; email abc@example.com")).toBe(
      "Ngập 50 cm; gọi [điện thoại]; email [email]",
    );
  });
  it("never deploys via assignment or accepts unassigned relief progress", () => {
    expect(() =>
      checkStatus(
        { userId: 2, role: "relief" },
        { status: "VERIFIED", assignee_id: 3 },
        "RESCUE_DEPLOYED",
      ),
    ).toThrow();
    expect(() =>
      checkStatus(
        { userId: 1, role: "admin" },
        { status: "VERIFIED", assignee_id: null },
        "RESCUE_DEPLOYED",
      ),
    ).toThrow();
    expect(() =>
      checkStatus(
        { userId: 2, role: "relief" },
        { status: "RESOLVED", assignee_id: 2 },
        "RESCUE_DEPLOYED",
      ),
    ).toThrow();
  });
  it("renders quantities from evidence and rejects unsupported claims and critical AI output", () => {
    const facts = [
      {
        id: "1:1:0",
        kind: "condition",
        text: "Ngập 50 cm",
        reportId: 1,
        revision: 1,
        reportedAt: report.createdAt,
      },
    ];
    const rows = [{ result: { blockedRoad: true }, emergency: false }];
    const selection = {
      titleKind: "ACCESS_BLOCKED",
      conditionFactIds: ["1:1:0"],
      updateFactIds: [],
      suggestedSeverity: "MODERATE",
      recommendedActions: ["CHECK_ACCESS"],
    };
    const result = renderSummary(selection, incident, rows, facts);
    expect(result.totalReports).toBe(1);
    expect(result.blockedRoadReports).toBe(1);
    expect(result.conditions).toEqual(facts);
    expect(() =>
      renderSummary(
        { ...selection, conditionFactIds: ["invented"] },
        incident,
        rows,
        facts,
      ),
    ).toThrow("unsupported_summary_reference");
    expect(() =>
      renderSummary(
        { ...selection, suggestedSeverity: "CRITICAL" },
        incident,
        rows,
        facts,
      ),
    ).toThrow("unsupported_summary_assessment");
    expect(() =>
      renderSummary(
        { ...selection, recommendedActions: ["CONTACT_RESCUE"] },
        incident,
        rows,
        facts,
      ),
    ).toThrow("unsupported_emergency_assessment");
  });
  it("keeps automatic mode disabled without a matching held-out evaluation", () => {
    const dir = mkdtempSync(join(tmpdir(), "incident-gate-")),
      path = join(dir, "evaluation.json");
    try {
      vi.stubEnv("INCIDENT_MATCH_MODE", "automatic");
      vi.stubEnv("INCIDENT_EVALUATION_PATH", path);
      expect(automaticAllowed("model")).toBe(false);
      const result = {
        pipeline: PIPELINE,
        fingerprint: "model",
        configHash: hash(matchingConfig()),
        precision: 0.99,
        recall: 0.9,
        gateViolations: 0,
        positiveCases: 30,
        negativeCases: 30,
      };
      writeFileSync(path, JSON.stringify(result));
      expect(automaticAllowed("model")).toBe(true);
      expect(automaticAllowed("other-model")).toBe(false);
      writeFileSync(path, JSON.stringify({ ...result, precision: 0.97 }));
      expect(automaticAllowed("model")).toBe(false);
      vi.stubEnv("INCIDENT_MATCH_MODE", "review");
      expect(automaticAllowed("model")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
