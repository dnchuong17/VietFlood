# =========================
# 1. Build stage
# =========================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

# Install all deps for build
RUN npm ci --no-audit --loglevel=error

COPY . .

# Build reports-service
RUN npm run build reports-service


# =========================
# 2. Production dependencies stage
# =========================
FROM node:20-alpine AS prod-deps

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

# Install production deps only
RUN npm ci --omit=dev --no-audit --loglevel=error \
    && npm cache clean --force

# Safe cleanup only
RUN rm -rf \
    .npmrc \
    /root/.npm \
    node_modules/.cache \
    node_modules/.bin

# Verify important runtime deps
RUN node -e "require.resolve('@nestjs/core'); require.resolve('@nestjs/microservices'); console.log('Nest deps OK')"


# =========================
# 3. Runtime stage
# =========================
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=builder /app/dist/apps/reports-service ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./

EXPOSE 3002

USER nobody

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/main.js"]