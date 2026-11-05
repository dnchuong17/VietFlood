import { fold } from "./incident-domain";

/** Tentative relation only, never a probability or an automatic evidence gate. */
export function relationSignals(report: any, rows: any[]) {
  const text = fold(String(report.matchingText ?? report.description ?? "")).trim().replace(/\s+/g, " ");
  const at = Date.parse(String(report.createdAt));
  const comparable = rows.map(row => {
    const source = row.snapshot ?? {};
    const other = fold(String(row.result?.matchingText ?? source.description ?? "")).trim().replace(/\s+/g, " ");
    return { id: row.report_id, duplicate: text.length > 0 && text === other, minutes: Math.abs(at - Date.parse(String(source.createdAt))) / 60000 };
  }).filter(row => Number.isFinite(row.minutes));
  return {
    relation: comparable.some(row => row.duplicate) ? "possible_duplicate" as const : "related" as const,
    timeDifferenceMinutes: comparable.length ? Math.min(...comparable.map(row => row.minutes)) : 0,
    matchingReportIds: comparable.filter(row => row.duplicate).map(row => row.id),
  };
}
