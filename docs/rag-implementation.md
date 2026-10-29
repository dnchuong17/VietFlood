# VietFlood RAG v3

The 34 supplied sources are accepted as APPROVED_FOR_RAG. This implementation checks only this flag; it does not add reviewer, medical or licensing workflows.

## Actual pipeline

Markdown → registry/version/content hash → sections → chunks counted with cl100k_base → API text-embedding-3-small dense vectors (1536/Cosine) + FastEmbed BM25 sparse vectors → candidate collection → exact ID/hash/vector/count validation → atomic `flood_kb_active` alias switch → release manifest and immutable source snapshots.

The corpus contains 34 approved documents. Chunk counts are recorded per release. Embedding inputs include titles and headings, without E5 prefixes; chunks stay within 450 cl100k_base tokens with 50-token overlap. The API hard input ceiling is 8191 tokens. Lists and paragraphs remain intact when possible; long blocks split into sentences and then lossless word ranges if necessary. Adjacent chunks carry previous/next IDs within a parent section. A block that cannot fit safely is rejected; model truncation is never accepted. Smaller complete sections are retained, rather than padded to an arbitrary size.

The registry increments document versions on content/title/source URL changes. Synchronization constructs the complete desired corpus. Updated and deleted chunks are absent from the newly active release; unchanged vectors are reused only when content/endpoint/model/dimensions/tokenizer/pipeline fingerprints match. Previous releases are retained for rollback and are not queried by the active alias. To rollback, use Qdrant's atomic alias update to the previous collection named in the manifest.

## Services and configuration

Python source directory: `VietFlood_RAG`. Use a Python environment outside OneDrive to avoid file hydration timeouts. The local environment used for verification is `~/.cache/vietflood/rag-venv`.

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
docker build -f Dockerfile -t vietflood-retrieval:local .
```

The backend Compose files include `rag-retrieval` on the private service network. Set `RAG_SERVICE_IMAGE` to the image built/published for the server and `RAG_CORPUS_DIR` to that server's synchronized `data` directory, including releases and snapshots. `RAG_DOCKER_SERVICE_URL` defaults to `http://rag-retrieval:8001`. The Python standalone `docker-compose.rag.yml` is for local administration/testing. A remote deployment must receive the corpus artifacts before starting retrieval; a green Qdrant collection alone does not supply citation snapshots or embedding identity metadata.

Generation uses the OpenAI-compatible cheapkeyai.shop chat completions API. Configure `OPENAI_API_KEY`, `OPENAI_BASE_URL=https://cheapkeyai.shop/v1`, `OPENAI_CHAT_MODEL=gpt-4.1-nano-2025-04-14`, `OPENAI_REQUEST_TIMEOUT_MS=120000`, `RAG_REQUEST_TIMEOUT_MS=300000`, and `RAG_RETRIEVAL_TIMEOUT_MS=90000`. See [OpenAI deployment](openai-deployment.md).

## Query and answer contract

Gateway → query planner (up to 3 queries / minimum conversation context) → dense + sparse Query API / RRF → multilingual BGE reranking → evidence sufficiency check → optional query expansion (at most 3 rounds) → structured factual claims → independent model evidence check plus exact supporting quote validation → citations.

There is no `/points/scroll`, `match.text`, or matching-term count retrieval. BM25 operates on indexed sparse vectors with stemming disabled and no stopword removal so negation is retained. Document and query vectors both use the same text-embedding-3-small API configuration without E5 prefixes. Embedding requests have a 30-second timeout and at most one transient-error retry. Reranking uses `BAAI/bge-reranker-v2-m3`; scores are rankings, not correctness probabilities. Models are loaded once. CPU/GPU latency must be measured on the deployment host: large multilingual rerankers can take tens of seconds on CPU or on the first accelerated request.

`POST /chat` keeps answer/sessionId/action and adds status/sources/sourceSupportPercent/generationMode/unansweredParts. It does not generate substantive advice when retrieval is empty or insufficient. Static first aid and app guidance now use the corpus. Introduction alone may be fixed. Missing-source/service/scope messages are operational notices. Explicit report/profile operations retain role checks and confirmation. Current alerts/weather/flood conditions are unsupported; static parts of mixed questions may be answered with citations.

Citation metadata is stored inside the existing encrypted assistant message, not in plaintext DB columns. Old plaintext-inside-encryption history remains readable. `GET /chat/sources/:documentId/versions/:version` requires the existing JWT and serves a versioned source snapshot. Web citation links open `/tro-ly/nguon/:documentId/:version`; external original URLs are additional links. Retrieved text is displayed as escaped text. Deleted or superseded sources remain archived for old citations and are excluded from the active index.

Source support percentage counts only claims that survived model grounding and exact quote validation. Accepted answers normally show 100%; this measures model-assessed claim support, not whether the underlying source is correct, current, or universally applicable. All substantive phrasing is generated by AI from retrieved evidence; unsupported claims and arbitrary model URLs are rejected.

## Diagnostics and evaluation

Startup checks alias/physical collection, dense dimensions/distance, sparse presence, embedding identity/fingerprint and exact count vs release manifest. Gateway requests have X-Request-Id; internal search and OpenAI logs share it. Logs include stages/counts/status/type/timing/point IDs and omit keys, raw provider bodies, user messages, prompts and passage contents. The retrieval API uses `X-Rag-Token` and must stay private.

The unit suite tests JSON schema validation, provider timeouts, source grounding and security. The opt-in live suite evaluates the configured model and retrieval service. Production requires a separate run after deployment: unit success does not establish model quality or server latency.

```sh
npm test -- --run apps/api-gateway/src/chat
# Opt-in live HTTP tests use local .env, real Qdrant/retrieval/OpenAI,
# JWT/controller path and an isolated encrypted history store (no production writes).
RAG_LIVE_TESTS=1 npx vitest run apps/api-gateway/src/chat/rag.production.http.spec.ts
```

Python `test_pipeline.py` checks actual token limits, lossless splits, IDs and neighboring section metadata. `evaluate_production.py` and the compatibility entrypoint `verify_retrieval.py` evaluate the real authenticated gateway instead of a standalone vector search. Set `RAG_EVAL_API_URL` and `RAG_EVAL_BEARER_TOKEN` in the local environment, then run `python evaluate_production.py`; tokens are not command-line parameters. The report contains queries/statuses/document coverage/latency/citation endpoint reachability. Run it on the deployed host to include actual DB persistence and infrastructure. Do not call the deployment fully validated until that evaluation passes.

## JSON and timeout diagnostics

Each model stage (`plan`, `assess`, `generate`, `grounding`, `action`) has a shared deadline of `OPENAI_REQUEST_TIMEOUT_MS` (default 120 seconds), including response parsing and at most one retry. The entire knowledge request is limited by `RAG_REQUEST_TIMEOUT_MS` (default 300 seconds). Requests use JSON object mode; JSON.parse plus AJV validate the output locally against the stage schema. Empty, truncated, malformed or schema-invalid output is retried once; truncated output is never accepted. Other HTTP errors and request timeouts are not retried.

Requests omit temperature and use minimal reasoning effort. Completion budgets start at 2048 tokens for planning/sufficiency/action and 4096 for generation/grounding; the single output retry doubles the budget up to 8192. These budgets include reasoning tokens.

Logs include request ID, provider, stage, model, elapsed time, finish reason and token/character counts. They omit user text, evidence and model bodies. Citation generation/checking use K1/K2 labels constrained to current evidence, mapped back to chunk UUIDs by the gateway. Deployment checks Redis/retrieval readiness and a small static OpenAI completion without logging credentials. Operational failures return notices, not canned knowledge answers.

Retrieval uses a shared `RAG_RETRIEVAL_TIMEOUT_MS` deadline (default 90 seconds) covering network and JSON parsing, enforced by a service timer. Readiness uses 10 seconds. Invalid base URLs are rejected explicitly; DNS, refused connections, TLS, timeout and malformed response errors have distinct safe reason codes. Only the service origin is logged, excluding URL credentials and query strings.

Candidate limits (20/40/60) are total budgets across unique subqueries. The gateway calls single-query search with each query's share and merges passage lists round-robin, deduplicating chunk IDs. This avoids Python's full queries × pooled-candidates reranking matrix. The smaller initial per-query pool requires a recall check on the golden question set after deployment. No knowledge answer is accepted without the existing sufficiency and claim grounding checks.
