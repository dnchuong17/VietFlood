# Stage 1: install dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json .npmrc ./
RUN npm ci --no-audit --loglevel=error

# Stage 2: build all NestJS services
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build:api-gateway \
  && npm run build:auth-service \
  && npm run build:reports-service

# Stage 3: production runtime
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV API_GATEWAY_PORT=8081

RUN apk add --no-cache dumb-init

COPY package*.json .npmrc ./
RUN npm ci --omit=dev --no-audit --loglevel=error \
  && npm cache clean --force \
  && rm -f .npmrc

COPY --from=build /app/dist/apps/api-gateway ./dist/api-gateway
COPY --from=build /app/dist/apps/auth-service ./dist/auth-service
COPY --from=build /app/dist/apps/reports-service ./dist/reports-service
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.API_GATEWAY_PORT || 8081), res => process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

USER nobody

ENTRYPOINT ["dumb-init", "--"]
CMD ["/docker-entrypoint.sh"]
