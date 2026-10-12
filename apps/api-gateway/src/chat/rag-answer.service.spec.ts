import { describe, expect, it, vi } from "vitest";
import { RagAnswerService } from "./rag-answer.service";
const p = { id:"p1", documentId:"E01", version:1, title:"Nguồn", sectionPath:["Chuẩn bị"], text:"Chuẩn bị nước sạch và giấy tờ quan trọng.", sourceUrl:"https://example.com/source", chunkHash:"hash", score:1 };
const plan = { route:"static", queries:["chuẩn bị trước lũ"], dynamicParts:[] };
const sufficient = { sufficient:true, supportedIds:["p1"], missingParts:[], nextQueries:[] };
const claims = { claims:[{ text:"Chuẩn bị nước sạch và giấy tờ quan trọng.", sourceIds:["p1"] }] };
const grounded = { checks:[{ index:0, supported:true, evidence:[{ sourceId:"p1", quote:p.text }] }] };
function setup(outputs:unknown[], passages=[p]) {
  const model = { structured:vi.fn(), isConfigured: vi.fn(() => true) }; for (const output of outputs) model.structured.mockResolvedValueOnce(output);
  const knowledge={retrieve:vi.fn(async()=>passages)};
  const logger={info:vi.fn(),warn:vi.fn()};
  return { service:new RagAnswerService(knowledge as never,model as never,logger as never),knowledge,model,logger };
}
describe("RAG answer contract",()=> {
  it("returns exact citations only after sufficiency and claim grounding",async()=> {
    const {service}=setup([plan,sufficient,claims,grounded]);
    const result=await service.reply("Chuẩn bị gì?");
    expect(result).toMatchObject({ status:"answered", generationMode:"grounded_synthesis", sourceSupportPercent:100 });
    expect(result.answer).toContain("[1]"); expect(result.sources[0]).toMatchObject({ documentId:"E01", snapshotUrl:"/chat/sources/E01/versions/1" });
  });
  it("does not generate any answer when retrieval is empty",async()=> {
    const {service,model}=setup([plan],[]);
    expect((await service.reply("sơ cứu" )).status).toBe("no_knowledge");
    expect(model.structured).toHaveBeenCalledTimes(1);
  });
  it("blocks dynamic requests before knowledge retrieval",async()=> {
    const {service,knowledge}=setup([{route:"dynamic",queries:[],dynamicParts:["tình hình hôm nay"]}]);
    expect((await service.reply("Hôm nay ngập ở đâu?")).status).toBe("unsupported_dynamic"); expect(knowledge.retrieve).not.toHaveBeenCalled();
  });
  it("expands retrieval when the model identifies missing evidence",async()=> {
    const {service,knowledge}=setup([plan,{...sufficient,sufficient:false,missingParts:["nước"],nextQueries:["nước sạch"]},sufficient,claims,grounded]);
    expect((await service.reply("Chuẩn bị gì?")).status).toBe("answered"); expect(knowledge.retrieve).toHaveBeenCalledTimes(2);
    expect(knowledge.retrieve.mock.calls[1].slice(0,3)).toEqual([["nước sạch"],40,12]);
  });
  it("rejects fabricated supporting quotes even if the evaluator says supported",async()=> {
    const fake={checks:[{index:0,supported:true,evidence:[{sourceId:"p1",quote:"this text is not in any source"}]}]};
    const {service}=setup([plan,sufficient,claims,fake,claims,fake]);
    expect((await service.reply("Chuẩn bị gì?")).status).toBe("no_knowledge");
  });
  it("rejects citations to unknown passages",async()=> {
    const {service}=setup([plan,sufficient,{claims:[{text:"Do something",sourceIds:["unknown"]}]}]);
    expect((await service.reply("question")).sources).toEqual([]);
  });
  it("returns an unavailable notice for provider errors with no hardcoded advice",async()=> {
    const {service,model,logger}=setup([]);model.structured.mockRejectedValue(new Error("secret provider details"));
    const result=await service.reply("private question"); expect(result.status).toBe("unavailable");expect(result.sourceSupportPercent).toBeUndefined();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private question|secret provider details/);
  });
  it("answers only supported static parts of mixed questions",async()=> {
    const {service}=setup([{...plan,route:"mixed",dynamicParts:["Tình hình hôm nay"]},sufficient,claims,grounded]);
    const result=await service.reply("Chuẩn bị gì và hôm nay ngập đâu?");expect(result.status).toBe("partial");expect(result.unansweredParts).toContain("Tình hình hôm nay");
  });
  it("binds citation labels to exact chunk IDs and hides competing document IDs", async () => {
    const labeledClaims = { claims: [{ text: p.text, sourceIds: ["K1"] }] };
    const labeledChecks = { checks: [{ index: 0, supported: true, evidence: [{ sourceId: "K1", quote: p.text }] }] };
    const { service, model } = setup([plan, sufficient, labeledClaims, labeledChecks]);
    const reply = await service.reply("Chuẩn bị gì?");
    expect(reply.status).toBe("answered");
    expect(reply.sources[0].id).toBe("p1");
    const generation = model.structured.mock.calls[2];
    expect(generation[1].evidence[0]).toEqual({ id: "K1", title: p.title, sectionPath: p.sectionPath, text: p.text });
    expect(generation[2].properties.claims.items.properties.sourceIds.items.enum).toEqual(["K1"]);
    expect(model.structured.mock.calls[3][2].properties.checks.items.properties.evidence.items.properties.sourceId.enum).toEqual(["K1"]);
  });

});
