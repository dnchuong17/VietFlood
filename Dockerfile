# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY .npmrc ./

# Install all dependencies
RUN npm ci --prefer-offline --no-audit --loglevel=error

# Copy source code
COPY . .

# Build all services
RUN npm run build:api-gateway && \
    npm run build:auth-service && \
    npm run build:reports-service

# Prune dev dependencies
RUN npm prune --omit=dev

# Production stage
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files
COPY package*.json ./
COPY .npmrc ./

# Install production dependencies only
RUN npm ci --prefer-offline --no-audit --omit=dev

# Copy all built services from builder
COPY --from=builder /app/dist/apps/api-gateway ./dist/api-gateway
COPY --from=builder /app/dist/apps/auth-service ./dist/auth-service
COPY --from=builder /app/dist/apps/reports-service ./dist/reports-service

# Copy startup script
COPY ./docker-entrypoint.sh /

# Clean up
RUN rm -rf .npmrc && \
    chmod +x /docker-entrypoint.sh

# Health check for API Gateway (main entry point)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8081', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})" || exit 0

# Expose the public HTTP entry point
EXPOSE 8081

# User
USER nobody

# Entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Start all services
CMD ["/docker-entrypoint.sh"]
