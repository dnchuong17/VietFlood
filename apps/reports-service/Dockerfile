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
RUN npm run build reports-service

# Prune dev dependencies
RUN npm prune --omit=dev

# Minimal cleanup: remove only cache, docs, examples, and tests (keep all build dirs)
RUN rm -rf \
    .npmrc \
    .npm \
    node_modules/.cache \
    node_modules/.bin && \
  find node_modules -maxdepth 2 \( \
    -name '*.md' \
    -o -name 'doc' \
    -o -name 'docs' \
    -o -name 'example' \
    -o -name 'examples' \
    -o -name 'test' \
    -o -name 'tests' \
    \) -type d -exec rm -rf {} + 2>/dev/null || true

# Production stage - Ultra-minimal
FROM node:20-alpine

# Set NODE_ENV
ENV NODE_ENV=production

WORKDIR /app

# Install only dumb-init
RUN apk add --no-cache dumb-init

# Copy only essential files from builder
COPY --from=builder /app/dist/apps/reports-service ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Expose port (internal)
EXPOSE 3002

# User nobody for security
USER nobody

# Entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Run application
CMD ["node", "dist/main.js"]



