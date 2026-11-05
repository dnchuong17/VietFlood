import { describe, expect, it } from "vitest";
import { assessPriority, lifeThreat } from "./incident-priority";
import { PIPELINE } from "./incident-domain";
describe("evidence priority assistance", () => {
 it("requires positive life threat and never infers Critical from depth or emergency flags", () => {
  expect(lifeThreat("Không có người đuối nước")).toBe(false);
  expect(lifeThreat("Chưa có ai nguy kịch")).toBe(false);
  expect(assessPriority([{ report_id: 1, snapshot: { description: "Ngập 3 m" }, emergency: true }], 2)).toMatchObject({value:"HIGH", factIds:[], sourceReportIds:[1], evidenceVersion:2});
  expect(assessPriority([{ report_id: 2, revision: 1, snapshot:{description:"Có người đuối nước"}, result:{facts:[{kind:"emergency",text:"Có người đuối nước"}]}}], 3)).toMatchObject({value:"CRITICAL",factIds:[`2:1:${PIPELINE}:0`],requiresHumanDecision:true});
 });
 it.each([
  "Có người đuối nước?",
  "Có người nguy kịch không",
  "Liệu có người bất tỉnh",
  "Có phải có người ngừng thở",
  "Nếu có người đuối nước thì gọi cứu hộ",
  "Giả sử có người nguy kịch",
  "Có thể có người bất tỉnh",
  "Nguy cơ đuối nước",
  "Cảnh báo đuối nước",
  "Đề phòng đuối nước",
  "Nghe nói có người đuối nước",
  "Có người đuối nước, chưa xác minh",
  "Có người nguy kịch chưa được xác nhận",
  "Có người bất tỉnh, chỉ là tin đồn",
  "Có người ngừng thở, không có thật",
  "Có người đuối nước là sai",
  "Không có người mắc kẹt và đuối nước",
  "Không có người mắc kẹt, có người đuối nước",
  "Không có những người đuối nước",
  "Chẳng có người nguy kịch",
  "Ko có người đuối nước",
  "k co nguoi duoi nuoc",
 ])("does not escalate non-asserted life threats: %s", description => {
  expect(lifeThreat(description)).toBe(false);
  const rows = [{ report_id: 3, revision: 1, snapshot: { description, severity: "LOW" }, result: { hasFloodEvidence: true, facts: [{ kind: "life_threat", text: description }] } }];
  const before = JSON.stringify(rows);
  const priority = assessPriority(rows, 4);
  expect(priority.value).not.toBe("CRITICAL");
  expect(priority.reasonCodes).not.toContain("EXPLICIT_LIFE_THREAT");
  expect(priority.factIds).toEqual([]);
  expect(JSON.stringify(rows)).toBe(before);
 });
 it.each([
  "Có người đuối nước",
  "Tôi thấy có người bất tỉnh!",
  "Có người nguy kịch, cần cấp cứu",
  "Có người ngừng thở",
  "Có người đuối nước? Tôi thấy có người bất tỉnh.",
  "Nghe nói có người đuối nước; tôi thấy có người nguy kịch",
  "Có người đuối nước, chưa xác minh. Có người ngừng thở!",
  "Không có người đuối nước nhưng có người nguy kịch",
  "Không có người đuối nước, nhung có người bất tỉnh",
  "Không có người đuối nước; có người nguy kịch",
  "Những người đuối nước cần cấp cứu",
 ])("retains genuine observations and independent positive scopes: %s", description => {
  expect(lifeThreat(description)).toBe(true);
  const rows = [{ report_id: 4, revision: 2, snapshot: { description, severity: "LOW" }, result: { facts: [
   { kind: "life_threat", text: "Có người đuối nước, chưa xác minh" },
   { kind: "life_threat", text: "Có người bất tỉnh?" },
   { kind: "life_threat", text: "Tôi thấy có người nguy kịch" },
  ] } }];
  const before = JSON.stringify(rows);
  expect(assessPriority(rows, 5)).toMatchObject({ value: "CRITICAL", factIds: [`4:2:${PIPELINE}:2`], sourceReportIds: [4], reasonCodes: ["EXPLICIT_LIFE_THREAT"] });
  expect(JSON.stringify(rows)).toBe(before);
 });
 it("keeps emergency reports High when a life-threat claim is unconfirmed", () => {
  expect(assessPriority([{ report_id: 5, emergency: true, snapshot: { description: "Có người đuối nước, chưa xác minh" } }], 1).value).toBe("HIGH");
 });
 it("uses originals during model outage, downgrades with new evidence, and leaves sources unchanged", () => {
  const rows = [{report_id:1,snapshot:{description:"Cứu với, có người mắc kẹt"}}];
  const copy = JSON.stringify(rows);
  expect(assessPriority(rows, 1).value).toBe("HIGH");
  expect(JSON.stringify(rows)).toBe(copy);
  expect(assessPriority([{report_id:1,snapshot:{description:"Không còn người mắc kẹt"}}],2).value).toBe("UNKNOWN");
  expect(assessPriority([{report_id:1,result:{hasFloodEvidence:true}}],2).value).toBe("LOW");
  expect(assessPriority([{report_id:1,result:{blockedRoad:true}}],2).value).toBe("MODERATE");
 });
});
