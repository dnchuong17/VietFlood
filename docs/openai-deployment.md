# OpenAI deployment

VietFlood uses OpenAI for intent planning, grounded answer synthesis, source checks, and report-action extraction. The existing Python retrieval service and approved Qdrant collection remain the only source of flood knowledge; the model does not replace retrieval or role checks.

## Local setup

Keep the API key in the ignored root `.env` file or another local secret manager. Never commit it or put it in frontend configuration.

```dotenv
OPENAI_API_KEY=<OpenAI API key>
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_REQUEST_TIMEOUT_MS=120000
RAG_REQUEST_TIMEOUT_MS=300000
RAG_RETRIEVAL_TIMEOUT_MS=90000
```

Run the Nest API gateway as usual. It loads `.env` through `ConfigModule`; a successful build does not make a live model request. Chat requests send the user message and selected retrieved passages to the configured OpenAI endpoint.

## Compose

Set the same variables in the Compose environment file, then run:

```sh
docker compose up -d --build
# Published images:
docker compose -f docker-compose.prod.yml up -d
```

Both Compose files pass the key only to the API gateway. Ollama containers and model downloads are not needed. The gateway still depends on the retrieval, auth, and report services.

## Jenkins deployment

Add `OPENAI_API_KEY` to the protected `/opt/env/vietflood.env` on the Jenkins agent. Set `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL`, and timeout values there as needed. The pipeline checks that the key and retrieval configuration are present before replacing the running backend. The preflight does not print credentials or call the model API.

For production, rotate any key that has been pasted into chat, committed, or otherwise exposed. Restrict the key to the required project and monitor usage limits in the OpenAI platform.
