# VietFlood RAG v2

The 34 supplied sources are accepted as APPROVED_FOR_RAG. This implementation checks only this flag; it does not add reviewer, medical or licensing workflows.

## Actual pipeline

Markdown → registry/version/content hash → sections → chunks counted with the E5 tokenizer → normalized E5 dense vectors (768/Cosine) + FastEmbed BM25 sparse vectors → candidate collection → exact ID/hash/vector/count validation → atomic `flood_kb_active` alias switch → release manifest and immutable source snapshots.

The current corpus has 34 documents / 212 section-aware chunks, compared with 76 larger chunks previously. Actual E5 inputs include `passage:`, titles, headings and special tokens and do not exceed 450 tokens (512 is a hard model ceiling). Lists and paragraphs remain intact when possible; long blocks split into sentences and then lossless word ranges if necessary. Adjacent chunks carry previous/next IDs within a parent section. A block that cannot fit safely is rejected; model truncation is never accepted. Smaller complete sections are retained, rather than padded to an arbitrary size.

The registry increments document versions on content/title/source URL changes. Synchronization constructs the complete desired corpus. Updated and deleted chunks are absent from the newly active release; unchanged vectors are reused only when content/model revision/pipeline fingerprints match. Previous releases are retained for rollback and are not queried by the active alias. To rollback, use Qdrant's atomic alias update to the previous collection named in the manifest.

## Services and configuration

Python source directory: `VietFlood_python/VietFlood`. Use a Python environment outside OneDrive to avoid file hydration timeouts. The local environment used for verification is `~/.cache/vietflood/rag-venv`.

```sh
python -m pip install -r requirements.txt
python sync_pipeline.py
python -m uvicorn retrieval_service:app --host 127.0.0.1 --port 8001
# Optional: automatically synchronize changes to source Markdown files.
python watch_corpus.py
```

Configure the same secret `RAG_SERVICE_TOKEN` in the gateway and Python environment, without committing it. Local gateway `.env` uses `RAG_SERVICE_URL=http://127.0.0.1:8001`. Python uses `QDRANT_URL`, optional `QDRANT_API_KEY`, and `QDRANT_CHAT_COLLECTION=flood_kb_active`. Model cache and source snapshot/release data must be persistent. Only the administration portal writes corpus data; the retrieval deployment mounts it read-only.

For Docker, build the Python image from its directory:

```sh
docker build -f Dockerfile.rag -t vietflood-retrieval:local .
```

The backend Compose files include `rag-retrieval` on the private service network. Set `RAG_SERVICE_IMAGE` to the image built/published for the server and `RAG_CORPUS_DIR` to that server's synchronized `data` directory, including releases and snapshots. `RAG_DOCKER_SERVICE_URL` defaults to `http://rag-retrieval:8001`. The Python standalone `docker-compose.rag.yml` is for local administration/testing. A remote deployment must receive the corpus artifacts before starting retrieval; a green Qdrant collection alone does not supply citation snapshots or model revision metadata.

Use `GOOGLE_API_KEY` and optional `GEMINI_CHAT_MODEL` for the model. The currently configured default is `gemini-3-flash-preview`; confirm availability in the provider project. Gemini uses JSON-schema structured output for routing, sufficiency, generation and grounding.

## Query and answer contract

Gateway → query planner (up to 3 queries / minimum conversation context) → dense + sparse Query API / RRF → multilingual BGE reranking → evidence sufficiency check → optional query expansion (at most 3 rounds) → structured factual claims → independent model evidence check plus exact supporting quote validation → citations.

There is no `/points/scroll`, `match.text`, or matching-term count retrieval. BM25 operates on indexed sparse vectors with stemming disabled and no stopword removal so negation is retained. Dense E5 documents use `passage:` and queries use `query:`. Reranking uses `BAAI/bge-reranker-v2-m3`; scores are rankings, not correctness probabilities. Models are loaded once. CPU/GPU latency must be measured on the deployment host: large multilingual rerankers can take tens of seconds on CPU or on the first accelerated request.

`POST /chat` keeps answer/sessionId/action and adds status/sources/sourceSupportPercent/generationMode/unansweredParts. It does not generate substantive advice when retrieval is empty or insufficient. Static first aid and app guidance now use the corpus. Introduction alone may be fixed. Missing-source/service/scope messages are operational notices. Explicit report/profile operations retain role checks and confirmation. Current alerts/weather/flood conditions are unsupported; static parts of mixed questions may be answered with citations.

Citation metadata is stored inside the existing encrypted assistant message, not in plaintext DB columns. Old plaintext-inside-encryption history remains readable. `GET /chat/sources/:documentId/versions/:version` requires the existing JWT and serves a versioned source snapshot. Web citation links open `/tro-ly/nguon/:documentId/:version`; external original URLs are additional links. Retrieved text is displayed as escaped text. Deleted or superseded sources remain archived for old citations and are excluded from the active index.

Source support percentage counts only claims that survived model grounding and exact quote validation. Accepted answers normally show 100%; this measures model-assessed claim support, not whether the underlying source is correct, current, or universally applicable. All substantive phrasing is generated by AI from retrieved evidence; unsupported claims and arbitrary model URLs are rejected.

## Diagnostics and evaluation

Startup checks alias/physical collection, dense dimensions/distance, sparse presence, model revision and exact count vs release manifest. Gateway requests have X-Request-Id; internal search and Gemini logs share it. Logs include stages/counts/status/type/timing/point IDs and omit keys, raw provider bodies, user messages, prompts and passage contents. The retrieval API uses `X-Rag-Token` and must stay private.

Local verification passes 58 chatbot unit/security tests after the JSON/timeout/citation fixes; 14 opt-in tests are skipped by default. Earlier checks passed 5 HTTP tests with real retrieval and a deterministic model stub and four tokenizer checks. The latest live Gemini attempt passed planning, retrieval and sufficiency assessment but failed generation with HTTP 429 RESOURCE_EXHAUSTED: the provider reports the free-tier request quota of 20 is exhausted. Full live generation and citation verification remain unvalidated after the final citation-label change. Gemini 3 Flash is configured as `gemini-3-flash-preview` because that is the available API identifier.

```sh
npm test -- --run apps/api-gateway/src/chat
# Opt-in live HTTP tests use local .env, real Qdrant/retrieval/Gemini,
# JWT/controller path and an isolated encrypted history store (no production writes).
RAG_LIVE_TESTS=1 npx vitest run apps/api-gateway/src/chat/rag.production.http.spec.ts
```

Python `test_pipeline.py` checks actual token limits, lossless splits, IDs and neighboring section metadata. `evaluate_production.py` and the compatibility entrypoint `verify_retrieval.py` evaluate the real authenticated gateway instead of a standalone vector search. Set `RAG_EVAL_API_URL` and `RAG_EVAL_BEARER_TOKEN` in the local environment, then run `python evaluate_production.py`; tokens are not command-line parameters. The report contains queries/statuses/document coverage/latency/citation endpoint reachability. Run it on the deployed host to include actual DB persistence and infrastructure. Do not call the deployment fully validated until that evaluation passes.

## JSON and timeout diagnostics

Each model stage (`plan`, `assess`, `generate`, `grounding`, `action`) has a service-enforced 25-second deadline, including parsing and one optional retry for malformed/truncated JSON. SDK automatic retries are disabled. The overall knowledge request still has a 90-second deadline. Gemini 3 uses low thinking; JSON stages start with 4096 output tokens (action 1024), with a ceiling of 8192 on the single output retry. Blocked output, authentication errors and timeout are not retried. Strict JSON parsing rejects truncated or empty output; partial JSON is never repaired into an accepted answer.

Logs include request ID, stage, elapsed time, finish reason, response length and output token count. They do not log raw questions, evidence, model response bodies or API keys. Citation generation and verification use short K1/K2 labels constrained by the current evidence schema; the gateway resolves labels to exact chunk UUIDs before publishing citations. Document IDs and unrelated payload metadata are excluded from the generation input to prevent ambiguous references.
