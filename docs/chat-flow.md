# Chatbot RAG v2 flow

Authenticated POST /chat → validate/rate limit/session ownership → handle explicit report/profile operations → static query planner → dense E5 + BM25 sparse Query API → RRF and BGE reranker → evidence sufficiency assessment → bounded expansion → grounded factual claims → independent model check and exact supporting quotations → citations and encrypted history.

Only chatbot introduction and operational notices are fixed. First aid/app guidance use APPROVED_FOR_RAG corpus. Dynamic alerts/current conditions are unsupported; mixed requests may receive a cited static partial answer. No retrieved evidence means no generation call. Model/retrieval failure means unavailable, without excerpt/advice fallback.

Detailed data generation, synchronization, API contract, deployment and evaluation: [rag-implementation.md](rag-implementation.md).
