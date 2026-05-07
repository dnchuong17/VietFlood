FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./

RUN npm ci --no-audit --loglevel=error

COPY . .

RUN npm run build reports-service


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

RUN node -e "require('@nestjs/core'); require('@nestjs/microservices'); require('socket.io'); require('engine.io'); require('engine.io-parser'); console.log('Runtime deps OK')"


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