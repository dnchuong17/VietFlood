import PDFDocument from "pdfkit";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { BadGatewayException, PayloadTooLargeException, ServiceUnavailableException } from "@nestjs/common";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const severity: Record<string, string> = {
  UNKNOWN: "Chưa đánh giá", LOW: "Thấp", MODERATE: "Trung bình",
  HIGH: "Cao", CRITICAL: "Nghiêm trọng",
};
const statuses: Record<string, string> = {
  DETECTED: "Mới phát hiện", UNDER_REVIEW: "Đang xem xét", VERIFIED: "Đã xác minh",
  RESCUE_DEPLOYED: "Đã triển khai cứu trợ", RESOLVED: "Đã giải quyết",
};

// Defense in depth: report snapshots must not disclose contact details even if a
// producer accidentally returns an unredacted manual edit or location label.
export function redactReportText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/(?:tôi tên|toi ten|họ tên|ho ten|tên tôi|ten toi)\s*[:：]?\s*[^,;.\n]{1,60}/gi, "[tên đã ẩn]")
    .replace(/(?:\+?84|0)[\s.-]?(?:\d[\s.-]?){8,10}\b/g, "[điện thoại]")
    .replace(/\b\d{9,12}\b/g, "[thông tin cá nhân]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function localDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(date)
    : "Chưa ghi nhận";
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function tooLarge(): never {
  throw new PayloadTooLargeException({
    code: "incident_report_too_large",
    message: "Báo cáo quá lớn. Hãy thu hẹp thời gian hoặc khu vực.",
  });
}

export async function renderIncidentReportPdf(
  input: unknown,
  options: { fontPath?: string } = {},
): Promise<Buffer> {
  const report = record(input), coverage = record(report.coverage), analytics = record(report.analytics);
  if (!Array.isArray(report.incidents) || coverage.complete !== true ||
      coverage.incidentCount !== report.incidents.length ||
      typeof analytics.totalReports !== "number" || typeof analytics.totalIncidents !== "number" ||
      !Number.isFinite(Date.parse(String(report.generatedAt)))) {
    throw new BadGatewayException({ code: "invalid_incident_report", message: "Không nhận được bản chụp báo cáo đầy đủ." });
  }
  if (report.incidents.length > 1000 || Buffer.byteLength(JSON.stringify(report), "utf8") > 2_000_000) tooLarge();
  // Service runners may start from dist/ rather than the Docker WORKDIR.
  // Resolve only the packaged font, never a network font or Latin-only fallback.
  const candidates = options.fontPath ? [options.fontPath] : [join(process.cwd(), "assets/fonts/NotoSans-Regular.ttf")];
  if (!options.fontPath) {
    let directory = __dirname;
    for (let level = 0; level < 6; level++) {
      candidates.push(join(directory, "assets/fonts/NotoSans-Regular.ttf"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const fontPath = candidates.find(candidate => {
    try { accessSync(candidate, constants.R_OK); return true; } catch { return false; }
  });
  if (!fontPath) throw new ServiceUnavailableException({ code: "incident_pdf_font_unavailable", message: "incident_pdf_font_unavailable" });
  const doc = new PDFDocument({
    size: "A4", margins: { top: 46, bottom: 48, left: 46, right: 46 },
    font: fontPath, bufferPages: true, compress: true,
    info: { Title: "Báo cáo tổng hợp ngập lụt — VietFlood", Author: "VietFlood", Subject: "AI Flood Intelligence; thông tin cần xác minh" },
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 20 * 1024 * 1024) doc.destroy(new Error("incident_pdf_size_limit"));
      else chunks.push(chunk);
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  // Attach a rejection handler before synchronous layout can throw.
  void complete.catch(() => undefined);
  const space = (height = 60) => {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
    if (doc.bufferedPageRange().count > 300) tooLarge();
  };
  const text = (value: unknown, size = 10, color = "#253a4a") => {
    doc.fontSize(size).fillColor(color).text(redactReportText(value), { paragraphGap: 5 });
  };
  const heading = (value: string) => { space(65); doc.moveDown(0.6); text(value, 14, "#07536b"); };
  const facts = (label: string, value: unknown) => {
    const list = rows(value);
    if (!list.length) return;
    text(label, 10, "#07536b");
    for (const fact of list) text(`• ${fact.text ?? ""} [Báo cáo #${fact.reportId ?? "?"}; ${fact.id ?? "chưa có mã bằng chứng"}]`);
  };
  try {
    text("VIETFLOOD · AI FLOOD INTELLIGENCE", 10, "#07536b");
    text("Báo cáo tổng hợp ngập lụt", 23, "#123247");
    text(`Chốt dữ liệu: ${localDate(report.generatedAt)} · Múi giờ Việt Nam`, 9);
    const filters = record(report.filters);
    text(`Khu vực: ${[filters.province, filters.ward].filter(Boolean).join(", ") || "Tất cả khu vực trong phạm vi quyền truy cập"}`, 9);
    text(`Khoảng thời gian: ${localDate(filters.from)} → ${localDate(filters.to)}`, 9);
    if (filters.status) text(`Lọc trạng thái: ${statuses[String(filters.status)] ?? filters.status}`, 9);
    if (filters.severity) text(`Lọc mức độ chính thức: ${severity[String(filters.severity)] ?? filters.severity}`, 9);
    if (filters.assignedToMe === true || filters.assignedToMe === "true") text("Phạm vi: chỉ các sự cố được phân công cho tài khoản yêu cầu.", 9);
    text("Thông tin người dân phản ánh, gợi ý AI và quyết định của Admin được phân biệt. Báo cáo này không phải lệnh triển khai cứu hộ.", 9);
    heading("1. Tổng quan và phạm vi dữ liệu");
    text(`${count(analytics.totalIncidents)} sự cố · ${count(analytics.totalReports)} báo cáo trong phạm vi lọc.`);
    text(`${count(analytics.linkedReports)} báo cáo đã liên kết · ${count(analytics.ungroupedReports)} báo cáo chưa gom nhóm · ${count(analytics.missingGpsReports)} báo cáo thiếu GPS.`);
    text("Báo cáo gốc được thống kê theo thời điểm gửi; sự cố được chọn theo khoảng diễn biến giao với thời gian lọc. Mật độ ghi nhận không phải ranh giới ngập đã xác minh.", 9);
    text(`Bản chụp đầy đủ: ${coverage.incidentCount} sự cố; không cắt theo trang đang mở.`, 9);
    heading("2. Mức độ chính thức và tiến độ xử lý");
    for (const row of rows(analytics.bySeverity)) text(`${severity[String(row.key)] ?? row.key}: ${count(row.count)} sự cố`);
    for (const row of rows(analytics.byStatus)) text(`${statuses[String(row.key)] ?? row.key}: ${count(row.count)} sự cố`);
    heading("3. Ghi nhận theo ngày và khu vực");
    for (const row of rows(analytics.dailyReports)) text(`${row.date}: ${count(row.count)} báo cáo`);
    for (const row of rows(analytics.topAreas)) text(`${[row.province, row.ward].filter(Boolean).join(", ") || "Chưa xác định khu vực"}: ${count(row.reportCount)} báo cáo · ${count(row.incidentCount)} sự cố`);
    heading("4. Các sự cố và bằng chứng tổng hợp");
    if (!report.incidents.length) text("Không có sự cố phù hợp với bộ lọc. Điều này không khẳng định khu vực không có ngập hoặc không có báo cáo chưa được xử lý.");
    for (const [index, value] of report.incidents.entries()) {
      space(125);
      const incident = record(value), priority = record(incident.priority);
      text(`${index + 1}. ${incident.title ?? "Sự cố"}`, 12, "#123247");
      text(`Mã sự cố: ${incident.id ?? ""} · ${count(incident.reportCount)} báo cáo`, 9);
      text(incident.address ?? "Chưa xác định vị trí", 9);
      text(`Mức độ chính thức: ${severity[String(incident.severity)] ?? "Chưa đánh giá"} · ${statuses[String(incident.status)] ?? "Chưa ghi nhận"}`);
      text(`Xác minh: ${incident.needsVerification ? "Cần xác minh/cập nhật bằng chứng" : "Đã có xác minh của Admin; không đồng nghĩa mọi ghi nhận đều đúng"}`, 9);
      text(`Diễn biến: ${localDate(incident.first_reported_at)} → ${localDate(incident.latest_reported_at)}`, 9);
      text(`Gợi ý ưu tiên: ${severity[String(priority.value)] ?? "Chưa đánh giá"} — ước tính, cần Admin xác nhận; không tự thay đổi mức độ chính thức.`, 9);
      const sourceIds = Array.isArray(incident.sourceReportIds) ? incident.sourceReportIds : [];
      text(`Nguồn báo cáo: ${sourceIds.length ? sourceIds.map(id => `#${id}`).join(", ") : "Chưa có mã nguồn trong bản chụp"}`, 9);
      const editorial = record(incident.editorialSummary);
      if (typeof editorial.body === "string") {
        text(`Admin biên tập${editorial.stale ? " — dựa trên bằng chứng/phiên bản cũ, cần rà soát" : ""}`, 10, "#07536b");
        text(editorial.title, 11);
        text(editorial.body);
        text(`Người biên tập #${editorial.actorId ?? "chưa ghi nhận"} · ${localDate(editorial.createdAt)}`, 9);
      }
      const summary = record(incident.summary);
      if (typeof summary.title === "string") {
        text(`Tóm tắt AI${incident.summaryStale ? " — chưa phản ánh đầy đủ bằng chứng hiện tại" : ""}`, 10, "#07536b");
        facts("Tình hình được phản ánh", summary.conditions);
        facts("Mực nước được người dân đề cập", summary.depths);
        facts("Diễn biến theo ghi nhận", summary.updates);
        for (const action of rows(summary.recommendations)) text(`Khuyến nghị cần con người quyết định: ${action.text ?? ""}`, 9);
      } else text("Chưa có tóm tắt AI. Không suy diễn nội dung thay cho phần phân tích đang thiếu.", 9);
      doc.moveDown(0.6);
      space(1);
    }
    const range = doc.bufferedPageRange();
    if (range.count > 300) tooLarge();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor("#526775").text(`VietFlood · Trang ${i + 1} / ${range.count}`, 46, doc.page.height - 29, { lineBreak: false, align: "right", width: doc.page.width - 92 });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error("incident_pdf_layout_failed"));
    throw error;
  }
  return complete;
}