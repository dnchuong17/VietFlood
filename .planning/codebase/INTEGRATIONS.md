# External Integrations

**Analysis Date:** 2026-04-15

## APIs & External Services

**Media Management:**
- Cloudinary - Image and document storage
  - SDK/Client: `cloudinary` v2.7.0
  - Auth: Environment variables
    - `CLOUDINARY_CLOUD_NAME`
    - `CLOUDINARY_API_KEY`
    - `CLOUDINARY_API_SECRET`
  - Service implementation: `CloudinaryService` from `vietflood-common`
  - Usage: `apps/api-gateway/src/reports/reports.service.ts`, `apps/reports-service/src/reports-service.module.ts`
  - Data format: Stores evidence with `{url, publicId, resourceType}`

## Data Storage

**Primary Database:**
- PostgreSQL (Production)
  - Connection: `DATABASE_URL` environment variable
  - Client: TypeORM 0.3.28
  - ORM Layer: @nestjs/typeorm 11.0.0
  - Pool size: 1-2 connections per service
  - Used by:
    - Auth Service: Users, Refresh Tokens
    - Reports Service: Report records
    - Synchronized schema: `synchronize: true`

**Caching Layer:**
- Redis 7-alpine (Docker)
  - Connection Details:
    - Host: `REDIS_HOST` (default: redis via Docker network)
    - Port: `REDIS_PORT` (default: 6379)
    - Password: `REDIS_PASSWORD`
    - Database: `REDIS_DB` (default: 0)
  - Client: RedisService from `vietflood-common`
  - Usage: User caching in Auth Service (`apps/auth-service/src/users/users.service.ts`)
  - Health check: redis-cli with password authentication

**File Storage:**
- Cloudinary cloud storage (primary)
- No local filesystem storage for user uploads
- Evidence files stored with: url, publicId, resourceType metadata

## Message Queue & Inter-Service Communication

**Message Broker:**
- RabbitMQ 3-management-alpine (Docker)
  - Connection: `RABBITMQ_URL` environment variable
  - Format: `amqp://[user]:[password]@[host]:[port]`
  - Default: `amqp://guest:guest@rabbitmq:5672`
  - Auth:
    - `RABBITMQ_DEFAULT_USER`
    - `RABBITMQ_DEFAULT_PASS`
  - Management UI: Port 15672
  - AMQP Port: 5672
  - Health check: rabbitmq-diagnostics check_running
  - Volumes: rabbitmq-data persistence

**Microservice Queues:**
- Auth Service Queue: `auth_queue`
  - Durable: true
  - Persistent: true
  - Transport: NestJS RabbitMQ
  - Message Patterns:
    - `register` - User registration
    - `sign_in` - Login
    - `profile` - Get user profile
    - `all` - Get all users
    - `get_user` - Get specific user
    - `update` - Update user
    - `update/user` - User-specific update
    - `delete` - Delete user
    - `refresh` - Token refresh
    - `refresh_token` - Refresh token operation
    - `logout` - User logout

- Reports Service Queue: `reports_queue`
  - Durable: true
  - Transport: NestJS RabbitMQ
  - Message Patterns:
    - `create` - Create report
    - (empty pattern) - Default handler
    - `get_all_by_users` - Fetch user reports
    - `update` - Update report

**API Gateway Communication:**
- AUTH_SERVICE Client:
  - Name: "AUTH_SERVICE"
  - Queue: auth_queue
  - Options: durable=true, persistent=true
  - Implementation: `apps/api-gateway/src/auth/auth.module.ts`

- REPORTS_SERVICE Client:
  - Name: "REPORTS_SERVICE"
  - Queue: reports_queue
  - Implementation: `apps/api-gateway/src/reports/reports.module.ts`

## Authentication & Identity

**Auth Provider:**
- Custom JWT-based authentication
  - Token types: Access Token, Refresh Token
  - Expiration: 800 seconds (access token)
  - Secrets:
    - `JWT_SECRET` - Access token signing key
    - `REFRESH_SECRET` - Refresh token signing key

**Strategies:**
- Passport.js with NestJS integration
- Local Strategy: Username/password (passport-local 1.0.0)
  - Implementation: `apps/auth-service/src/strategy/local.strategy.ts`
- JWT Strategy: Bearer token (passport-jwt 4.0.1)
  - Implementation: `apps/auth-service/src/strategy/jwt.strategy.ts`
- Refresh Token Strategy: Refresh token flow
  - Implementation: `apps/auth-service/src/strategy/refreshToken.strategy.ts`

**Password Management:**
- Hashing: bcrypt v6.0.0 with salt rounds = 10
- Verification: bcrypt.compare() for authentication
- Used in:
  - `apps/auth-service/src/auth-service.service.ts` - Login
  - `apps/auth-service/src/refesh_token/refresh_token.service.ts` - Token hashing
  - `apps/auth-service/src/admin/admin.seed.ts` - Admin setup

**Admin Account:**
- Seeded during Auth Service initialization
- Credentials from environment variables:
  - `ADMIN_EMAIL`
  - `ADMIN_PASSWORD`
- Seeding location: `apps/auth-service/src/admin/admin.seed.ts`

## HTTP & API Gateway

**API Gateway (HTTP Entry Point):**
- Service: `apps/api-gateway/src/main.ts`
- Port: 8081 (via API_GATEWAY_PORT)
- Base Image: node:20-alpine
- CORS Configuration:
  - Allowed Origins:
    - http://172.16.25.252:3000
    - http://172.16.25.252:3001
    - http://localhost:3000
    - http://localhost:3001
    - https://vietflood-fe.vercel.app
    - https://viet-flood-app.vercel.app
  - Methods: GET, HEAD, PUT, PATCH, POST, DELETE
  - Credentials: true

**HTTP Methods:**
- Defined in app-level CORS configuration
- All standard REST methods supported
- File upload support via multer 2.1.1

## Monitoring & Observability

**Error Tracking:**
- Built-in error handling via NestJS framework
- No external error tracking service detected
- Error logging: console/LoggerService

**Logs:**
- Approach: Custom LoggerService from vietflood-common
  - Implementation: Used across all services
  - Methods: logger.info(), logger.error(), etc.
- Database Logging (TypeORM):
  - Levels: ["error", "schema"]
  - Entity auto-discovery: `dist/**/*.entity{.ts,.js}`
- Service naming: logger.setServiceName() per service (api-gateway, auth-service, reports-service)

**Health Checks:**
- API Gateway HTTP Health Check:
  - Endpoint: http://localhost:8081
  - Interval: 30 seconds
  - Timeout: 3 seconds
  - Start period: 5 seconds
  - Retries: 3
  - Method: HTTP GET status check

- Redis Health Check:
  - Command: redis-cli with password
  - Interval: 10 seconds
  - Timeout: 5 seconds
  - Retries: 5

- RabbitMQ Health Check:
  - Command: rabbitmq-diagnostics check_running
  - Interval: 10 seconds
  - Timeout: 10 seconds
  - Retries: 5

## CI/CD & Deployment

**Hosting:**
- Docker-based containerized deployment
- Multi-service architecture with orchestration

**Container Registry:**
- Docker Hub: nguyenchuong1712/
  - vietflood-api-gateway:latest
  - vietflood-auth-service:latest
  - vietflood-reports-service:latest

**CI Pipeline:**
- Shell scripts for deployment:
  - `deploy.sh` - Deployment orchestration
  - `push-to-docker-hub.sh` - Image publishing
  - `docker-entrypoint.sh` - Service startup
  - `verify.sh` - Verification script

**Orchestration:**
- Docker Compose configurations:
  - `docker-compose.yml` - Development/local setup
  - `docker-compose.prod.yml` - Production setup
- Network: vietflood-network (bridge)
- Service dependencies:
  - api-gateway → auth-service, reports-service, redis, rabbitmq
  - auth-service → redis, rabbitmq
  - reports-service → redis, rabbitmq
- Restart policy: unless-stopped

## Environment Configuration

**Required env vars - Database:**
- `DATABASE_URL` - PostgreSQL connection string

**Required env vars - Message Queue:**
- `RABBITMQ_URL` - RabbitMQ connection string (format: amqp://user:pass@host:port)
- `RABBITMQ_DEFAULT_USER` - RabbitMQ username
- `RABBITMQ_DEFAULT_PASS` - RabbitMQ password

**Required env vars - Caching:**
- `REDIS_HOST` - Redis hostname/IP
- `REDIS_PORT` - Redis port
- `REDIS_PASSWORD` - Redis password
- `REDIS_DB` - Redis database number

**Required env vars - Authentication:**
- `JWT_SECRET` - JWT access token signing key
- `REFRESH_SECRET` - Refresh token signing key
- `ADMIN_EMAIL` - Initial admin email
- `ADMIN_PASSWORD` - Initial admin password

**Required env vars - File Storage:**
- `CLOUDINARY_CLOUD_NAME` - Cloudinary account name
- `CLOUDINARY_API_KEY` - Cloudinary API key
- `CLOUDINARY_API_SECRET` - Cloudinary API secret

**Required env vars - API Configuration:**
- `API_GATEWAY_PORT` - API Gateway port (default: 8081)
- `NODE_ENV` - Environment (development/production)
- `CORS_ORIGINS` - Comma-separated list of allowed origins

**Secrets location:**
- `.env` file at project root (NOT committed)
- Environment variables injected at runtime via Docker/docker-compose
- GitHub Packages authentication: `NPM_TOKEN` in CI/CD environment

## External Documentation & APIs

**Postman Collections:**
- Location: `docs/VietFlood.postman_collection.json`
- Environment: `docs/VietFlood.postman_environment.json`
- For API testing and development

**GitHub Repository:**
- URL: https://github.com/dnchuong17/VietFlood
- Private package registry: @dnchuong17 scope via GitHub Packages

## Webhooks & Callbacks

**Incoming:**
- None detected - microservices use request-response via RabbitMQ

**Outgoing:**
- None detected - no external service callbacks configured

---

*Integration audit: 2026-04-15*
