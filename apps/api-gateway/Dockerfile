FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

RUN npm ci --no-audit --loglevel=error

COPY . .

RUN npm run build api-gateway


FROM node:20-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

RUN npm ci --omit=dev --no-audit --loglevel=error \
    && npm cache clean --force

RUN rm -rf \
    .npmrc \
    /root/.npm \
    node_modules/.cache \
    node_modules/.bin

RUN node -e "require('socket.io'); require('engine.io'); require('engine.io-parser'); console.log('Socket deps OK')"


FROM node:20-alpine

ENV NODE_ENV=production
ENV OLLAMA_BASE_URL=http://ollama:11434
ENV OLLAMA_CHAT_MODEL=qwen3:1.7b-q4_K_M
ENV OLLAMA_REQUEST_TIMEOUT_MS=120000
ENV OLLAMA_NUM_CTX=16384
ENV RAG_REQUEST_TIMEOUT_MS=300000
ENV RAG_RETRIEVAL_TIMEOUT_MS=90000

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=builder /app/dist/apps/api-gateway ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./
COPY db/migrations/20261009_chat_history.sql ./db/migrations/20261009_chat_history.sql
COPY scripts/migrate-chat-history.js scripts/rotate-chat-history-key.js scripts/check-chat-runtime.js ./scripts/

EXPOSE 8081

USER nobody

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/main.js"]
