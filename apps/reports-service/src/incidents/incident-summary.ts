import { PIPELINE, redact } from "./incident-domain";

import { assessPriority } from "./incident-priority";

export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "titleKind",
    "conditionFactIds",
    "updateFactIds",
    "suggestedSeverity",
    "recommendedActions",
  ],
  properties: {
    titleKind: {
      type: "string",
      enum: ["FLOOD", "ACCESS_BLOCKED", "RESCUE_REQUEST"],
    },
    conditionFactIds: {
      type: "array",
      maxItems: 12,
      uniqueItems: true,
      items: { type: "string" },
    },
    updateFactIds: {
      type: "array",
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string" },
    },
    suggestedSeverity: {
      type: "string",
      enum: ["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"],
    },
    recommendedActions: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: {
        type: "string",
        enum: ["VERIFY_ON_SITE", "CHECK_ACCESS", "CONTACT_RESCUE", "MONITOR"],
      },
    },
  },
};
export const SUMMARY_INSTRUCTION =
  "Bạn tổng hợp các ghi nhận ngập lụt bằng cách chọn mã bằng chứng hiện có. Không tạo sự kiện, con số hay mã mới. Chọn các điều kiện tiêu biểu và thay đổi theo thời gian; giữ các mô tả mâu thuẫn. Chỉ đề xuất HIGH khi có bằng chứng khẩn cấp. Chỉ dùng RESCUE_REQUEST/CONTACT_RESCUE khi bằng chứng đề cập cần cứu trợ; ACCESS_BLOCKED/CHECK_ACCESS khi có đường bị chặn. Đây là khuyến nghị cần con người xác nhận, không phải lệnh triển khai. Mức độ do AI đề xuất là ước tính.";
const actions: Record<string, string> = {
  VERIFY_ON_SITE: "Xác minh thông tin tại hiện trường khi điều kiện an toàn.",
  CHECK_ACCESS: "Kiểm tra khả năng tiếp cận và tuyến đường thay thế.",
  CONTACT_RESCUE: "Liên hệ đơn vị cứu trợ để đánh giá nhu cầu hỗ trợ.",
  MONITOR: "Tiếp tục theo dõi các báo cáo và thay đổi tại khu vực.",
};
export type SummarySelection = {
  titleKind: string;
  conditionFactIds: string[];
  updateFactIds: string[];
  suggestedSeverity: string;
  recommendedActions: string[];
};
export type SummaryFact = {
  id: string;
  kind: string;
  text: string;
  reportedAt: string;
  [key: string]: unknown;
};
export type SummaryIncident = {
  ward?: string;
  province?: string;
  address: string;
  first_reported_at: string | Date;
  latest_reported_at: string | Date;
  evidence_version: number;
};
export type SummarySource = {
  emergency?: boolean;
  result?: {
    blockedRoad?: boolean;
    strandedPeople?: boolean;
    strandedVehicles?: boolean;
  };
};
export function renderSummary(
  selection: SummarySelection,
  incident: SummaryIncident,
  rows: SummarySource[],
  facts: SummaryFact[],
) {
  const map = new Map(facts.map((f) => [f.id, f]));
  const selected = [
    ...(selection.conditionFactIds ?? []),
    ...(selection.updateFactIds ?? []),
  ];
  if (selected.some((id) => !map.has(id)))
    throw new Error("unsupported_summary_reference");
  if (selection.suggestedSeverity === "CRITICAL" && assessPriority(rows, incident.evidence_version).value !== "CRITICAL")
    throw new Error("unsupported_summary_assessment");
  const emergency = rows.some((r) => r.emergency),
    blocked = rows.some((r) => r.result?.blockedRoad === true);
  if (
    (selection.titleKind === "RESCUE_REQUEST" ||
      selection.recommendedActions.includes("CONTACT_RESCUE") ||
      selection.suggestedSeverity === "HIGH") &&
    !emergency
  )
    throw new Error("unsupported_emergency_assessment");
  if (
    (selection.titleKind === "ACCESS_BLOCKED" ||
      selection.recommendedActions.includes("CHECK_ACCESS")) &&
    !blocked
  )
    throw new Error("unsupported_access_assessment");
  const titles: Record<string, string> = {
    FLOOD: "Ngập lụt",
    ACCESS_BLOCKED: "Đường bị gián đoạn",
    RESCUE_REQUEST: "Yêu cầu hỗ trợ khẩn cấp",
  };
  const title = titles[selection.titleKind];
  if (
    selection.recommendedActions.some(
      (code) => !Object.prototype.hasOwnProperty.call(actions, code),
    )
  )
    throw new Error("unsupported_summary_action");
  if (
    !title ||
    !["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"].includes(
      selection.suggestedSeverity,
    )
  )
    throw new Error("unsupported_summary_assessment");
  const conditions = selection.conditionFactIds.map((id) => map.get(id));
  const updates = selection.updateFactIds
    .map((id) => map.get(id))
    .sort((a, b) => Date.parse(a.reportedAt) - Date.parse(b.reportedAt));
  return {
    title: `${title} tại ${redact(incident.ward || incident.province || "vị trí chưa xác định")}`,
    location: redact(incident.address),
    totalReports: rows.length,
    firstReportedAt: incident.first_reported_at,
    latestReportedAt: incident.latest_reported_at,
    conditions,
    updates,
    depths: facts.filter((f) => f.kind === "depth"),
    blockedRoadReports: rows.filter((r) => r.result?.blockedRoad === true)
      .length,
    strandedPeopleReports: rows.filter((r) => r.result?.strandedPeople === true)
      .length,
    strandedVehicleReports: rows.filter(
      (r) => r.result?.strandedVehicles === true,
    ).length,
    suggestedSeverity: {
      value: selection.suggestedSeverity,
      provenance: "estimate",
    },
    recommendations: selection.recommendedActions.map((code) => ({
      code,
      text: actions[code],
      provenance: "recommendation",
      requiresHumanDecision: true,
    })),
    pipeline: PIPELINE,
    priority: assessPriority(rows, incident.evidence_version),
    generatedAt: new Date().toISOString(),
    evidenceVersion: incident.evidence_version,
  };
}
