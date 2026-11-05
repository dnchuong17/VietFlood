import { describe, it, expect, vi, afterEach } from "vitest";
import PDFDocument from "pdfkit";
import { renderIncidentReportPdf, redactReportText } from "./incident-report";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function fixture(size = 1) {
  return {
    generatedAt: "2026-11-05T10:00:00Z",
    filters: { from: "2026-11-04T17:00:00Z", to: "2026-11-05T16:59:59.999Z", province: "Thành phố Hồ Chí Minh", ward: "Tăng Nhơn Phú" },
    analytics: { totalReports: size * 2, totalIncidents: size, linkedReports: size * 2, ungroupedReports: 0, missingGpsReports: 0,
      bySeverity: [{ key: "HIGH", count: size }], byStatus: [{ key: "VERIFIED", count: size }],
      dailyReports: [{ date: "2026-11-05", count: size * 2 }], topAreas: [{ province: "Thành phố Hồ Chí Minh", ward: "Tăng Nhơn Phú", reportCount: size * 2, incidentCount: size }] },
    coverage: { complete: true, incidentCount: size, maximumIncidents: 1000 },
    incidents: Array.from({ length: size }, (_, index) => ({
      id: `fixture-${index + 1}`, title: "Ngập lụt tại Tăng Nhơn Phú", address: "Đường thử nghiệm — dữ liệu QA",
      reportCount: 2, severity: "HIGH", status: "VERIFIED", needsVerification: false,
      first_reported_at: "2026-11-05T01:00:00Z", latest_reported_at: "2026-11-05T03:00:00Z",
      priority: { value: "CRITICAL" }, sourceReportIds: [1, 2],
      editorialSummary: { title: "Ghi chú đã biên tập", body: "Admin ghi nhận cần kiểm tra khả năng tiếp cận.", actorId: 1, createdAt: "2026-11-05T04:00:00Z", stale: true },
      summaryStale: true,
      summary: { title: "Ngập lụt", conditions: [{ id: "1:1:incidents-v2:0", reportId: 1, text: "Ngập cao cản trở giao thông, cần cứu hộ." }], depths: [], updates: [], recommendations: [{ text: "Xác minh thông tin khi điều kiện an toàn." }] },
    })),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("real Vietnamese incident PDF", () => {
  it("renders a real embedded-font PDF and preserves separate source/AI/Admin provenance", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    const pdf = await renderIncidentReportPdf(fixture());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10000);
    expect(pdf.toString("latin1")).toContain("/FontFile2");
    const text = spy.mock.calls.map(([value]) => String(value)).join("\n");
    expect(text).toContain("Tăng Nhơn Phú");
    expect(text).toContain("Mức độ chính thức: Cao");
    expect(text).toContain("Gợi ý ưu tiên: Nghiêm trọng");
    expect(text).toContain("Admin biên tập — dựa trên bằng chứng/phiên bản cũ");
    expect(text).toContain("Tóm tắt AI — chưa phản ánh");
    expect(text).toContain("1:1:incidents-v2:0");
    if (process.env.QA_INTELLIGENCE_PDF_OUTPUT) {
      mkdirSync(dirname(process.env.QA_INTELLIGENCE_PDF_OUTPUT), { recursive: true });
      writeFileSync(process.env.QA_INTELLIGENCE_PDF_OUTPUT, pdf);
    }
  });
  it("paginates long reports and emits page numbers without an extra footer page", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    const pdf = await renderIncidentReportPdf(fixture(30));
    expect(pdf.length).toBeGreaterThan(20000);
    const footers = spy.mock.calls.map(([value]) => String(value)).filter(x => x.startsWith("VietFlood · Trang"));
    expect(footers.length).toBeGreaterThan(1);
    expect(footers.at(-1)).toBe(`VietFlood · Trang ${footers.length} / ${footers.length}`);
  });
  it("redacts contacts from manual text and never fetches external evidence media", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    const report = fixture();
    report.incidents[0].editorialSummary.body = "Gọi 0912345678 hoặc private@example.test; tôi tên Nguyễn Văn A. Cần kiểm tra.";
    await renderIncidentReportPdf(report);
    const text = spy.mock.calls.map(([value]) => String(value)).join("\n");
    expect(text).not.toContain("0912345678"); expect(text).not.toContain("private@example.test");
    expect(text).not.toContain("Nguyễn Văn A"); expect(text).toContain("[điện thoại]");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects incomplete, oversized or undecodable producer snapshots rather than returning a partial success", async () => {
    await expect(renderIncidentReportPdf({})).rejects.toMatchObject({ status: 502 });
    const partial = fixture(); partial.coverage.complete = false;
    await expect(renderIncidentReportPdf(partial)).rejects.toMatchObject({ status: 502 });
    const large = fixture(); large.incidents[0].editorialSummary.body = "x".repeat(2_000_001);
    await expect(renderIncidentReportPdf(large)).rejects.toMatchObject({ status: 413 });
    large.incidents[0].editorialSummary.body = "ậ".repeat(700000);
    await expect(renderIncidentReportPdf(large)).rejects.toMatchObject({ status: 413 });
    await expect(renderIncidentReportPdf(fixture(), { fontPath: "/does-not-exist/noto.ttf" })).rejects.toThrow("incident_pdf_font_unavailable");
  });
  it("has an explicit truthful empty state and robust contact redaction", async () => {
    const spy = vi.spyOn(PDFDocument.prototype, "text");
    await renderIncidentReportPdf(fixture(0));
    expect(spy.mock.calls.some(([value]) => String(value).includes("không khẳng định khu vực không có ngập"))).toBe(true);
    expect(redactReportText("+84 912 345 678; a@b.test\u0000")).toBe("[điện thoại]; [email]");
  });
});