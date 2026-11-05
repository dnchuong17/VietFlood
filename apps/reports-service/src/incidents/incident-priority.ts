import { fold, PIPELINE, urgent } from "./incident-domain";

export type PriorityAssessment = {
  value: "UNKNOWN" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  provenance: "estimate";
  requiresHumanDecision: true;
  reasonCodes: string[];
  factIds: string[];
  sourceReportIds: number[];
  evidenceVersion: number;
};
// A positive life-threat claim is required; depth alone never establishes it.
export function lifeThreat(text: string): boolean {
  return fold(text).split(/[.!?;\n]/).some(sentence =>
    [...sentence.matchAll(/\b(duoi nuoc|nguy kich|de doa tinh mang|sap chet|ngung tho|bat tinh|nuoc dang cuon|bi cuon troi)\b/g)].some(match => {
      const clause = sentence.slice(0, match.index).split(/,|\b(?:nhung|tuy nhien|va)\b/).slice(-1)[0] ?? "";
      return !/\b(?:khong|chua|ko|khong co|chua co)\b/.test(clause);
    }));
}
export function assessPriority(rows: any[], evidenceVersion: number): PriorityAssessment {
  const result: PriorityAssessment = { value: "UNKNOWN", provenance: "estimate", requiresHumanDecision: true, reasonCodes: [], factIds: [], sourceReportIds: [], evidenceVersion };
  const levels = ["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
  for (const row of rows) {
    const source = row.snapshot ?? {};
    const facts = row.result?.facts ?? [];
    const critical = lifeThreat(String(source.description ?? ""));
    const emergency = row.emergency === true || urgent(source);
    const flood = row.result?.hasFloodEvidence === true;
    const blocked = row.result?.blockedRoad === true;
    const value = critical ? "CRITICAL" : emergency ? "HIGH" : blocked ? "MODERATE" : flood ? "LOW" : "UNKNOWN";
    if (levels.indexOf(value) > levels.indexOf(result.value)) {
      result.value = value; result.reasonCodes = []; result.factIds = []; result.sourceReportIds = [];
    }
    if (value !== result.value || value === "UNKNOWN") continue;
    result.reasonCodes.push(critical ? "EXPLICIT_LIFE_THREAT" : emergency ? "RESCUE_OR_EMERGENCY_REPORT" : blocked ? "BLOCKED_ACCESS" : "FLOOD_EVIDENCE");
    if (Number.isSafeInteger(row.report_id)) result.sourceReportIds.push(row.report_id);
    facts.forEach((fact: any, index: number) => {
      if (critical ? lifeThreat(String(fact.text ?? "")) : emergency ? fact.kind === "emergency" : blocked ? fact.kind === "blocked_road" : fact.kind === "condition")
        result.factIds.push(`${row.report_id}:${row.revision}:${PIPELINE}:${index}`);
    });
  }
  result.reasonCodes = [...new Set(result.reasonCodes)];
  result.sourceReportIds = [...new Set(result.sourceReportIds)];
  return result;
}
