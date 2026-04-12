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



