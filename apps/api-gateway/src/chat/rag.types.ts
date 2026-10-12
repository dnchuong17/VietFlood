export type Passage = {
  id: string; documentId: string; version: number; title: string; sectionPath: string[];
  text: string; sourceUrl: string; chunkHash: string; score: number; metadata?: Record<string, unknown>;
};
export type ChatSource = Omit<Passage, "text" | "score"> & { citation: number; snapshotUrl: string };
export type RagDetails = {
  status: "answered" | "partial" | "no_knowledge" | "unsupported_dynamic" | "needs_clarification" | "unavailable";
  sources: ChatSource[];
  sourceSupportPercent?: number;
  generationMode: "grounded_synthesis" | "system_notice" | "introduction";
  unansweredParts: string[];
};
export type RagReply = RagDetails & { answer: string };
