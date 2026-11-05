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
// Keep polarity aligned with RAG incident_processing.py: questions are not
// observations, and only an explicit contrast resets shared negation/uncertainty.
export function lifeThreat(text: string): boolean {
  const negation = /\b(?:khong|chua|chang|cha|dau co|ko|khg|khongg|khum|hok|hk|k0)\b/;
  const uncertain = /\b(?:neu|gia su|nguy co|co the|canh bao|de phong|nghe noi|lieu|co phai|chua (?:duoc )?xac (?:minh|nhan))\b/;
  for (const sentence of text.normalize("NFC").matchAll(/([^.!?;\n]+)([.!?;\n]|$)/g)) {
    if (sentence[2] === "?") continue;
    // Split before folding: 'những' must not become the contrast 'nhưng'.
    for (const original of sentence[1].split(/\b(?:nhưng|tuy nhiên|tuy nhien)\b|,\s*nhung\b/i)) {
      const scope = fold(original).replace(/\bk\s+(?=(?:di|qua|co|con|ai|the|duoc|ngap|bi|can|mac|duoi|nguy)\b)/g, "khong ");
      for (const match of scope.matchAll(/\b(duoi nuoc|nguy kich|de doa tinh mang|sap chet|ngung tho|bat tinh|nuoc dang cuon|bi cuon troi)\b/g)) {
        const prefix = scope.slice(0, match.index);
        const suffix = scope.slice(match.index! + match[0].length);
        if (negation.test(prefix) || uncertain.test(prefix + match[0])) continue;
        if (/^\s*(?:khong|chua|la sai|khong dung|khong co that)\b/.test(suffix)) continue;
        if (/^\s*,?\s*(?:la sai|khong dung|khong co that|chua (?:duoc )?xac (?:minh|nhan)|(?:chi la )?tin don)\b/.test(suffix)) continue;
        return true;
      }
    }
  }
  return false;
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
