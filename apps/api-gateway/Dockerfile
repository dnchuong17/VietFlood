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

# Preserve engine.io/build before cleanup (required by socket.io)
RUN mkdir -p /tmp/engine.io && cp -r node_modules/engine.io/build /tmp/engine.io/ 2>/dev/null || true

# Aggressive cleanup: remove all docs, tests, examples, and build dirs
RUN find node_modules -maxdepth 2 \( \
    -name '*.md' \
    -o -name 'doc' \
    -o -name 'docs' \
    -o -name 'example' \
    -o -name 'examples' \
    -o -name 'test' \
    -o -name 'tests' \
    -o -name 'build' \
    \) -type d -exec rm -rf {} + 2>/dev/null || true && \
  rm -rf .npmrc .npm node_modules/.cache node_modules/.bin

# Restore engine.io/build
RUN mkdir -p node_modules/engine.io && cp -r /tmp/engine.io/build node_modules/engine.io/ 2>/dev/null || true && rm -rf /tmp/engine.io

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



