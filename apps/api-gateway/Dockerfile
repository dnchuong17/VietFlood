# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy only package files
COPY package*.json ./
COPY .npmrc ./

# Install all dependencies with cache optimization
RUN npm ci --prefer-offline --no-audit --loglevel=error && npm cache clean --force

# Copy source code
COPY . .

# Build the application
RUN npm run build api-gateway

# Prune dev dependencies
RUN npm prune --omit=dev

# Remove cache and unnecessary files
RUN rm -rf \
    .npmrc \
    .npm \
    node_modules/.cache \
    node_modules/.bin \
    node_modules/*/build \
    node_modules/*/doc \
    node_modules/*/*.md \
    node_modules/*/example \
    node_modules/*/examples \
    node_modules/*/test \
    node_modules/*/tests

# Production stage - Ultra-minimal
FROM node:20-alpine

# Set NODE_ENV
ENV NODE_ENV=production

WORKDIR /app

# Install only dumb-init
RUN apk add --no-cache dumb-init

# Copy only essential files from builder
COPY --from=builder /app/dist/apps/api-gateway ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Health check script (minimal)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8081', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Expose port
EXPOSE 8081

# User nobody for security
USER nobody

# Entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Run application
CMD ["node", "dist/main.js"]



