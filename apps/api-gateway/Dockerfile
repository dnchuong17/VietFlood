# =========================
# 1. Build stage
# =========================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

RUN npm ci --no-audit --loglevel=error

COPY . .

RUN npm run build api-gateway


# =========================
# 2. Production dependencies stage
# =========================
FROM node:20-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

RUN npm ci --omit=dev --no-audit --loglevel=error \
    && npm cache clean --force

# Chỉ xóa cache / binary không cần thiết, không xóa sâu trong package runtime
RUN rm -rf \
    .npmrc \
    /root/.npm \
    node_modules/.cache \
    node_modules/.bin

# Check bắt buộc để tránh lỗi thiếu engine.io khi deploy
RUN node -e "require.resolve('socket.io'); require.resolve('engine.io'); console.log('Socket.IO deps OK')"


# =========================
# 3. Runtime stage
# =========================
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=builder /app/dist/apps/api-gateway ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./

EXPOSE 8081

USER nobody

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/main.js"]