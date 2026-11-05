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
