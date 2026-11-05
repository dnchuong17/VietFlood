import { describe, it, expect } from "vitest";
import { relationSignals } from "./incident-matching";
describe("tentative relation signals", () => {
 it("uses normalized matching text and preserves source ids and time", () => {
  const result = relationSignals({ matchingText:"ngập đường", createdAt:"2026-11-01T01:00:00Z" }, [{ report_id:8, snapshot:{description:"bản gốc",createdAt:"2026-11-01T00:30:00Z"},result:{matchingText:"ngap duong"}}]);
  expect(result).toEqual({relation:"possible_duplicate",timeDifferenceMinutes:30,matchingReportIds:[8]});
 });
 it("labels different content related rather than a duplicate or probability", () => {
  expect(relationSignals({description:"A",createdAt:"2026-11-01T01:00:00Z"},[{report_id:1,snapshot:{description:"B",createdAt:"2026-11-01T01:00:00Z"}}])).toEqual({relation:"related",timeDifferenceMinutes:0,matchingReportIds:[]});
 });
});
