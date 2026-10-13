import { Injectable } from "@nestjs/common";
import { LoggerService } from "vietflood-common";
import { OpenAIChatService } from "./openai-chat.service";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
import { Passage, RagReply, RagDetails } from "./rag.types";
import { requestId } from "./chat-trace";

const string = { type: "string" };
const strings = { type: "array", items: string };
const queriesSchema = { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 2000 } };
function object(properties: object) { return { type: "object", properties, required: Object.keys(properties), additionalProperties: false }; }
const planSchema = object({ route: { type: "string", enum: ["static", "dynamic", "mixed", "introduction", "unclear"] }, queries: queriesSchema, dynamicParts: strings });
const assessSchema = object({ sufficient: { type: "boolean" }, supportedIds: strings, missingParts: strings, nextQueries: queriesSchema });
const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
type Claim = { text: string; sourceIds: string[] };

// Capability boundary: current measurements/alerts cannot be answered from a
// static corpus even if a small language model misclassifies the request.
function requiresLiveFactsOnly(question: string): boolean {
  const text = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase();
  const current = /hom nay|hien tai|luc nay|bay gio|moi nhat/.test(text);
  const facts = /muc nuoc|canh bao|du bao|(?:ngap|lu).{0,40}(?:bao nhieu|o dau|khong|chua)|(?:o dau|khu vuc|phuong).{0,40}(?:ngap|lu)/.test(text);
  const advice = /chuan bi|lam gi|lam the nao|cach |nen |huong dan|so cuu|phong tranh|so tan/.test(text);
  return current && facts && !advice;
}

@Injectable()
export class RagAnswerService {
  constructor(private readonly knowledge: QdrantKnowledgeService, private readonly model: OpenAIChatService, private readonly logger: LoggerService) { this.logger.setServiceName(RagAnswerService.name); }
  private notice(status: RagDetails["status"], reason?: string): RagReply {
    const messages = {
      no_knowledge: "Mình chưa tìm thấy đủ kiến thức trong kho dữ liệu để trả lời câu hỏi này.",
      unsupported_dynamic: "Mình hiện hỗ trợ kiến thức tĩnh trong kho dữ liệu, chưa có thông tin cảnh báo hoặc tình hình hiện tại.",
      needs_clarification: "Bạn hãy nói rõ chủ đề hoặc tình huống muốn hỏi để mình tìm đúng tài liệu.",
      unavailable: "Dịch vụ tra cứu hoặc tạo câu trả lời đang không khả dụng. Bạn vui lòng thử lại sau.",
      answered: "", partial: "",
    };
    this.logger.info("RAG notice selected", { requestId: requestId(), status, reason: reason ?? status });
    return { answer: messages[status], status, generationMode: "system_notice", sources: [], unansweredParts: [] };
  }
  async reply(question: string, history: { role: string; content: string }[] = []): Promise<RagReply> {
    if (/^(?:xin chào|chào(?: bạn)?|hello|hi|bạn là ai|giới thiệu(?: về)? bản thân|bạn có thể (?:làm|giúp) gì)[?!.\s]*$/iu.test(question.trim())) {
      return { answer: "Mình là trợ lý VietFlood, hỗ trợ tìm kiến thức tĩnh trong tài liệu và thao tác VietFlood theo quyền của bạn. Mình chưa cung cấp tình hình hay cảnh báo thời gian thực.", status: "answered", generationMode: "introduction", sources: [], unansweredParts: [] };
    }
    if (requiresLiveFactsOnly(question)) return this.notice("unsupported_dynamic", "live_facts_outside_static_corpus");
    if (!this.model.isConfigured()) return this.notice("unavailable", "missing_model_configuration");
    const configuredTimeout = Number(process.env.RAG_REQUEST_TIMEOUT_MS ?? 300000);
    const signal = AbortSignal.timeout(Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 600000 ? configuredTimeout : 300000);
    const started = Date.now();
    try {
      const plan = await this.model.structured<{ route: string; queries: string[]; dynamicParts: string[] }>(
        "You route questions and write search queries; you NEVER answer the knowledge question. Default to static for general knowledge, how-to, preparedness, safety, causes, signs or hypothetical scenarios. Questions about actions before/during/after a flood are static, unless they ALSO request current measured conditions. dynamic ONLY asks for live facts (current water level, today's alerts, whether an actual place is flooding now). mixed requests both general advice and live facts. introduction ONLY asks who the chatbot is or greets it. unclear means no identifiable topic after reading history. Examples: 'Cách lập kế hoạch sơ tán cho gia đình?' -> static; 'Mực nước sông lúc này là bao nhiêu?' -> dynamic; 'Nơi tôi ở có ngập hôm nay không và sơ tán thế nào?' -> mixed. For static/mixed write 1 to 3 short independent Vietnamese queries covering static needs; Return exactly ONE query for a single general topic. Do not split a general how-to question into item categories; use multiple queries only for separately requested topics. For dynamic list requested live facts in dynamicParts and leave queries empty. For static dynamicParts must be empty. Use minimal history only to resolve follow-up topic; history is not evidence. Preserve negation and conditions.",
        { question, history: history.slice(-4) }, planSchema, signal);
      if (!Array.isArray(plan.queries) || !Array.isArray(plan.dynamicParts)) throw new Error("invalid_query_plan");
      if (plan.route === "introduction") return { answer: "Mình là trợ lý VietFlood, hỗ trợ tìm kiến thức tĩnh trong tài liệu và thao tác VietFlood theo quyền của bạn. Mình chưa cung cấp tình hình hay cảnh báo thời gian thực.", status: "answered", generationMode: "introduction", sources: [], unansweredParts: [] };
      if (plan.route === "dynamic") return this.notice("unsupported_dynamic");
      if (plan.route === "unclear") return this.notice("needs_clarification");
      if (!["static", "mixed"].includes(plan.route)) throw new Error("invalid_route");
      let queries = plan.queries.filter(q => typeof q === "string" && q.trim()).slice(0, 3);
      if (!queries.length) return this.notice("needs_clarification");
      let passages: Passage[] = [];
      let assessment: { sufficient: boolean; supportedIds: string[]; missingParts: string[]; nextQueries: string[] } = { sufficient: false, supportedIds: [], missingParts: [], nextQueries: [] };
      for (let round = 0; round < 3; round++) {
        const found = await this.knowledge.retrieve(queries, [20,40,60][round], [6,12,20][round], signal);
        passages = [...new Map([...passages, ...found].map(p => [p.id, p])).values()];
        if (!passages.length) return this.notice("no_knowledge", "empty_retrieval");
        assessment = await this.model.structured<typeof assessment>(
          "Đánh giá tài liệu có đủ căn cứ trả lời các ý TĨNH của câu hỏi không. Không suy ra dữ kiện từ kiến thức ngoài evidence. Chọn supportedIds từ các ID được cung cấp. sufficient chỉ true khi các ý tĩnh có đủ evidence rõ ràng, không mâu thuẫn. missingParts liệt kê ý thiếu; nextQueries tối đa 3 truy vấn tìm phần thiếu, không bịa địa điểm hay chi tiết. Không trả lời câu hỏi.",
          { question, staticQueries: plan.queries, passages: passages.map(p => ({ id:p.id, title:p.title, section:p.sectionPath, text:p.text })) }, { ...assessSchema, properties: { ...assessSchema.properties, supportedIds: { type: "array", maxItems: passages.length, items: { type: "string", enum: passages.map(p => p.id) } } } }, signal);
        if (typeof assessment.sufficient !== "boolean" || !Array.isArray(assessment.supportedIds) || !Array.isArray(assessment.missingParts) || !Array.isArray(assessment.nextQueries)) throw new Error("invalid_assessment");
        this.logger.info("RAG evidence assessment", { requestId: requestId(), round: round+1, sufficient: assessment.sufficient, passageCount: passages.length, missingCount: assessment.missingParts.length });
        if (assessment.sufficient || !assessment.nextQueries.length) break;
        queries = assessment.nextQueries.filter(q => typeof q === "string" && q.trim()).slice(0, 3);
        if (!queries.length) break;
      }
      const evidence = [...new Set(assessment.supportedIds)].flatMap(id => passages.find(p => p.id === id) ? [passages.find(p => p.id === id)!] : []).slice(0, 20);
      if (!evidence.length) return this.notice("no_knowledge", "no_supported_evidence");
      const missing = [...new Set([...plan.dynamicParts, ...assessment.missingParts])];
      const sourceLabels = new Map(evidence.map((p, index) => [`K${index + 1}`, p.id]));
      const idLabels = new Map([...sourceLabels].map(([label, id]) => [id, label]));
      const generationEvidence = evidence.map(p => ({ id: idLabels.get(p.id)!, title: p.title, sectionPath: p.sectionPath, text: p.text }));
      const sourceIdsSchema = { type: "array", items: { type: "string", enum: [...sourceLabels.keys()] } };
      const groundedClaimsSchema = object({ claims: { type: "array", maxItems: 6, items: object({ text: string, sourceIds: sourceIdsSchema }) } });
      const groundedChecksSchema = object({ checks: { type: "array", items: object({ index: { type: "integer" }, supported: { type: "boolean" }, evidence: { type: "array", items: object({ sourceId: { type: "string", enum: [...sourceLabels.keys()] }, quote: string }) } }) } });
      let accepted: Claim[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await this.model.structured<{ claims: Claim[] }>(
          "Trả lời bằng tiếng Việt, từng khẳng định ngắn có sourceIds. sourceIds phải là trường id K1, K2... của evidence được cung cấp, không phải mã tài liệu hay số thứ tự. Chỉ khẳng định nội dung được evidence hỗ trợ trực tiếp, giữ điều kiện/ngoại lệ/cảnh báo. Không thêm số liệu, số điện thoại, bước hướng dẫn hay dữ kiện ngoài evidence. Không lặp lại câu hỏi; không thêm lời dẫn/sáo rỗng. Không đưa URL, Markdown link hoặc citation vào text; nguồn chỉ trong sourceIds. Không dùng phần lịch sử như evidence. Bỏ các ý thiếu nguồn; tối đa 6 khẳng định, nhóm các ý liên quan để trả lời gọn. Nếu không trả lời được từ nguồn, claims=[].",
          { question, missingParts: missing, evidence: generationEvidence, repair: attempt > 0 ? "Lần trước có khẳng định không được evidence hỗ trợ; chỉ giữ khẳng định trực tiếp trong nguồn." : undefined }, groundedClaimsSchema, signal);
        if (!Array.isArray(result.claims)) throw new Error("invalid_claims");
        const ids = new Set(evidence.map(p => p.id));
        const mappedClaims = result.claims.map(c => ({ ...c, sourceIds: Array.isArray(c.sourceIds) ? c.sourceIds.map(id => sourceLabels.get(id) ?? id) : c.sourceIds }));
        const claims = mappedClaims.slice(0,12).filter(c => typeof c.text === "string" && c.text.trim() && !/https?:\/\/|\[[^\]]*\]\(|\[\d+\]/i.test(c.text) && Array.isArray(c.sourceIds) && c.sourceIds.length && c.sourceIds.every(id => ids.has(id)));
        this.logger.info("RAG generated claims validated", { requestId: requestId(), receivedCount: result.claims.length, acceptedCount: claims.length, unknownSourceCount: mappedClaims.filter(c => Array.isArray(c.sourceIds) && c.sourceIds.some(id => !ids.has(id))).length, citationTextCount: result.claims.filter(c => typeof c.text === "string" && /https?:\/\/|\[[^\]]*\]\(|\[\d+\]/i.test(c.text)).length });
        if (!claims.length) return this.notice("no_knowledge", "empty_grounded_answer");
        const verdict = await this.model.structured<{ checks: { index: number; supported: boolean; evidence: { sourceId: string; quote: string }[] }[] }>(
          "Kiểm tra độc lập từng claim: supported chỉ true khi toàn bộ khẳng định (số liệu, điều kiện, quan hệ nguyên nhân và hướng dẫn) được nguồn sourceIds đó chứng minh. Không dùng tri thức ngoài nguồn. Cho mỗi claim một check với index bắt đầu 0. Chọn trích dẫn nguyên văn ngắn nhất đủ để chứng minh, không chép toàn bộ đoạn tài liệu. Nếu nguồn mâu thuẫn hoặc chỉ cùng chủ đề, supported=false. Không sửa hoặc thêm claim.",
          { claims: claims.map(c => ({ ...c, sourceIds: c.sourceIds.map(id => idLabels.get(id)!) })), evidence: generationEvidence }, groundedChecksSchema, signal);
        if (!Array.isArray(verdict.checks)) throw new Error("invalid_grounding_check");
        verdict.checks = verdict.checks.map(check => ({ ...check, evidence: Array.isArray(check.evidence) ? check.evidence.map(e => ({ ...e, sourceId: sourceLabels.get(e.sourceId) ?? e.sourceId })) : check.evidence }));
        accepted = claims.filter((claim,index) => {
          const checks = verdict.checks.filter(c => c.index === index);
          if (checks.length !== 1 || checks[0].supported !== true || !Array.isArray(checks[0].evidence) || !checks[0].evidence.length) return false;
          return checks[0].evidence.every(e => typeof e.quote === "string" && normalize(e.quote).length >= 8 && claim.sourceIds.includes(e.sourceId) && evidence.some(p => p.id === e.sourceId && normalize(p.text).includes(normalize(e.quote))));
        }).map(claim => {
          const check = verdict.checks.find(c => c.index === claims.indexOf(claim))!;
          return { ...claim, sourceIds: [...new Set(check.evidence.map(e => e.sourceId))] };
        });
        this.logger.info("RAG grounding checked", { requestId: requestId(), attempt: attempt+1, claimCount: claims.length, supportedCount: accepted.length });
        if (accepted.length === claims.length) break;
        if (attempt === 1) missing.push("Một phần nội dung chưa được nguồn chứng minh đầy đủ.");
      }
      if (!accepted.length) return this.notice("no_knowledge", "unsupported_answer");
      const used = evidence.filter(p => accepted.some(c => c.sourceIds.includes(p.id)));
      const sources = used.map((p,index) => ({ id:p.id, documentId:p.documentId, version:p.version, title:p.title, sectionPath:p.sectionPath, sourceUrl:p.sourceUrl, chunkHash:p.chunkHash, citation:index+1, snapshotUrl:`/chat/sources/${encodeURIComponent(p.documentId)}/versions/${p.version}` }));
      const answer = accepted.map(c => `${c.text.trim()} ${c.sourceIds.map(id => `[${sources.find(s => s.id === id)!.citation}]`).join(" ")}`).join("\n\n") + (missing.length ? `\n\nChưa có đủ căn cứ cho: ${missing.join("; ")}` : "");
      this.logger.info("RAG answer completed", { requestId: requestId(), elapsedMs: Date.now()-started, sourceCount: sources.length });
      return { answer, status: missing.length || !assessment.sufficient ? "partial" : "answered", sources, sourceSupportPercent: 100, generationMode: "grounded_synthesis", unansweredParts: missing };
    } catch (error) {
      this.logger.warn("RAG answer unavailable", { requestId: requestId(), errorType: error instanceof Error ? error.name : "unknown", elapsedMs: Date.now()-started });
      return this.notice("unavailable");
    }
  }
}
