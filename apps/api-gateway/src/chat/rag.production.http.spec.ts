import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { NestFactory } from "@nestjs/core";
import { PassportModule } from "@nestjs/passport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtStrategy } from "../auth/strategy/jwt.strategy";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { ChatAuditInterceptor } from "./chat-audit.interceptor";
import { ChatCryptoService } from "./chat-crypto.service";
import { GeminiChatService } from "./gemini-chat.service";
import { QdrantKnowledgeService } from "./qdrant-knowledge.service";
import { RagAnswerService } from "./rag-answer.service";

const live = process.env.RAG_LIVE_TESTS === "1";
const retrievalOnly = process.env.RAG_RETRIEVAL_TESTS === "1";
describe.skipIf(!live && !retrievalOnly)("Live production HTTP path with isolated encrypted history", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string; let token: string;
  const turns = new Map<string, { role: string; content: string; kind: string }[]>();
  beforeAll(async () => {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const index = line.indexOf("="); if (index > 0) { const key = line.slice(0,index).trim(); if (["GOOGLE_API_KEY","GEMINI_CHAT_MODEL","RAG_SERVICE_URL","RAG_SERVICE_TOKEN"].includes(key)) process.env[key] = line.slice(index+1).trim().replace(/^["']|["']$/g,""); }
    }
    if (live && !process.env.GOOGLE_API_KEY) throw new Error("Local Gemini key missing");
    process.env.JWT_SECRET = "isolated-live-evaluation-jwt";
    process.env.CHAT_KEY_CURRENT = "test";
    process.env.CHAT_KEYRING_B64 = Buffer.from(JSON.stringify({ test:randomBytes(32).toString("base64") })).toString("base64");
    const crypto = new ChatCryptoService();
    const logger = { setServiceName:()=>{}, info:(message:string,metadata?:object)=>console.log(message,metadata ?? {}), warn:(message:string,metadata?:object)=>console.log(message,metadata ?? {}) };
    const knowledge = new QdrantKnowledgeService(logger as never);
    const gemini = retrievalOnly ? {
      isConfigured: () => true,
      structured: async (_instruction: string, data: any) => {
        if (data.claims) return { checks: data.claims.map((c: any,index: number) => ({ index, supported: true, evidence: [{ sourceId:c.sourceIds[0], quote:c.text }] })) };
        if (data.evidence) return { claims: [{ text:data.evidence[0].text.split("\n").filter((t: string) => t.trim()).join(" "), sourceIds:[data.evidence[0].id] }] };
        if (data.passages) return { sufficient: !data.question.includes("tên lửa"), supportedIds: data.question.includes("tên lửa") ? [] : [data.passages[0].id], missingParts: [], nextQueries: [] };
        return { route:data.question.includes("Hôm nay") ? "dynamic" : "static", queries:[data.question], dynamicParts:[] };
      },
    } as unknown as GeminiChatService : new GeminiChatService(logger as never);
    const rag = new RagAnswerService(knowledge,gemini,logger as never);
    const save = async (_user:number,id:string,message:string,answer:string,kind:string) => {
      const encrypted=crypto.encrypt(answer,7,id,"assistant-id","assistant");
      const decoded=JSON.parse(crypto.decrypt(encrypted,7,id,"assistant-id","assistant"));
      turns.set(id,[...(turns.get(id) ?? []),{role:"user",content:message,kind},{role:"assistant",content:decoded.answer,kind}]);
      return true;
    };
    const history={create:save,append:save,access:async (_u:number,id:string)=>turns.has(id)?"owned":"missing",recent:async (_u:number,id:string)=>turns.get(id)??[],recentKnowledgeQuestions:async (_u:number,id:string)=>(turns.get(id)??[]).filter(t=>t.role==="user"&&t.kind==="knowledge").slice(-2),recentKnowledgeAnswers:async (_u:number,id:string)=>(turns.get(id)??[]).filter(t=>t.role==="assistant"&&t.kind==="knowledge").slice(-2)};
    const redis={getClient:()=>({multi:()=>({incr:()=>({expire:()=>({exec:async()=>[[null,1],[null,1]]})})})})};
    const actions={handle:async()=>({handled:false})};
    const service=new ChatService(redis as never,{} as never,knowledge,history as never,logger as never,gemini,actions as never,rag);
    class EvaluationModule {}
    Module({imports:[PassportModule],controllers:[ChatController],providers:[JwtStrategy,ChatAuditInterceptor,{provide:Reflect.getMetadata("design:paramtypes",ChatAuditInterceptor)[0],useValue:logger},{provide:ChatService,useValue:service},{provide:Reflect.getMetadata("design:paramtypes",ChatController)[0],useValue:service}]})(EvaluationModule);
    app=await NestFactory.create(EvaluationModule,{logger:false,abortOnError:false});await app.listen(0,"127.0.0.1");
    base=`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    token=new JwtService({secret:process.env.JWT_SECRET}).sign({sub:7,username:"evaluation",role:"citizen"});
  },30000);
  afterAll(async()=>{ if(app) await app.close(); });
  it.each([
    ["Tôi cần chuẩn bị gì trước lũ?", "knowledge"],
    ["nuoc co mui xang dun soi uong duoc khong", "knowledge"],
    ["Làm gì khi người bị nạn chảy máu nhiều?", "knowledge"],
    ["Hôm nay phường tôi ngập bao nhiêu?", "unsupported_dynamic"],
    ["Công thức chế tạo động cơ tên lửa là gì?", "no_knowledge"],
  ])("evaluates %s through JWT/controller/retrieval/Gemini", async (message,expected) => {
    const response=await fetch(base+"/chat",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({message})});
    expect(response.status).toBe(200); const reply=await response.json();
    console.log(JSON.stringify({message,status:reply.status,sources:reply.sources?.map((s:{documentId:string})=>s.documentId)}));
    if(expected==="knowledge") {
      expect(["answered","partial"]).toContain(reply.status);expect(reply.sources.length).toBeGreaterThan(0);expect(reply.sourceSupportPercent).toBe(100);
      const snapshot=await fetch(base+reply.sources[0].snapshotUrl,{headers:{Authorization:`Bearer ${token}`}});expect(snapshot.status).toBe(200);expect((await snapshot.json()).text).toBeTruthy();
    } else { expect(reply.status).toBe(expected);expect(reply.sources).toEqual([]); }
  },100000);
});
