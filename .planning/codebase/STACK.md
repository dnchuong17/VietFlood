# Technology Stack

**Analysis Date:** 2026-04-15

## Languages

**Primary:**
- TypeScript 5.9.3 - All application services (API Gateway, Auth Service, Reports Service)

**Secondary:**
- JavaScript (Node.js) - Runtime

## Runtime

**Environment:**
- Node.js 20-alpine - Docker base image for all services
- npm (bundled with Node.js)

**Package Manager:**
- npm (via package.json)
- Lockfile: `package-lock.json` present
- Custom scope: `@dnchuong17` registry via GitHub Packages

## Frameworks

**Core:**
- NestJS 11.1.16 - Microservices framework used across all services
- Express 5.2.1 - Underlying HTTP framework (via NestJS platform-express)
- @nestjs/platform-express 11.1.14 - HTTP module for Express integration

**Microservices:**
- @nestjs/microservices 11.1.16 - RabbitMQ-based microservice communication
- amqplib 0.10.9 - AMQP protocol client
- amqp-connection-manager 5.0.0 - Connection pool management for RabbitMQ

**Authentication & Security:**
- Passport 0.7.0 - Authentication middleware
- @nestjs/passport 11.0.5 - Passport integration for NestJS
- @nestjs/jwt 11.0.2 - JWT handling
- passport-jwt 4.0.1 - JWT strategy
- passport-local 1.0.0 - Local username/password strategy
- bcrypt 6.0.0 - Password hashing

**Database:**
- TypeORM 0.3.28 - ORM for PostgreSQL
- @nestjs/typeorm 11.0.0 - NestJS TypeORM integration
- pg 8.19.0 - PostgreSQL client driver

**Configuration & Utilities:**
- @nestjs/config 4.0.3 - Configuration management with environment variables
- class-validator 0.14.4 - DTO validation
- class-transformer 0.5.1 - Request/response transformation
- multer 2.1.1 - File upload handling
- @types/multer 2.1.0 - Type definitions for multer

**File Management:**
- cloudinary 2.7.0 - Cloud storage and image management

**Shared Code:**
- vietflood-common 1.4.0 - Custom shared library from `@dnchuong17` GitHub Packages
  - Contains: LoggerService, RedisModule, RedisService, CloudinaryModule, CloudinaryService

**Testing & Development:**
- @nestjs/cli 10.4.8 - NestJS development CLI

## Key Dependencies

**Critical:**
- TypeORM 0.3.28 - Core data persistence across all services
- RabbitMQ/amqplib - Inter-service message communication
- NestJS microservices stack - Application framework foundation
- PostgreSQL (via pg driver) - Primary data store
- Redis - Caching layer (infrastructure dependency)

**Infrastructure:**
- multer 2.1.1 - File upload processing
- cloudinary 2.7.0 - Media storage and transformation
- bcrypt 6.0.0 - Authentication security

**Shared Logic:**
- vietflood-common 1.4.0 - Central location for cross-service functionality
  - Provides: Logger, Redis helper, Cloudinary wrapper

## Database Configuration

**Primary Database:**
- PostgreSQL (via TypeORM)
- Connection: `DATABASE_URL` environment variable
- Pool configuration: min=1, max=2 connections per service
- Synchronization: Enabled (`synchronize: true`)
- Logging: ["error", "schema"]
- Migrations: Located in `db/migrations/`
- Entities defined in: `**/*.entity.ts` files

**Shared Entities:**
- `UserEntity` (`apps/auth-service/src/users/users.entity.ts`)
  - Roles: CITIZEN, ADMIN, RELIEF
- `RefreshTokenEntity` (`apps/auth-service/src/refesh_token/refresh_token.entity.ts`)
- `ReportEntity` (`apps/reports-service/src/entity/report.entity.ts`)
  - Evidence type: `{url: string, publicId: string, resourceType?: string}`

## Configuration

**Environment:**
- NestJS ConfigModule configured globally in each service
- Configuration via `.env` file (not committed to git)
- Environment variables injected at service startup
- Service-specific ports:
  - API Gateway: `API_GATEWAY_PORT` (default: 8081)
  - Auth Service: Microservice (no exposed port)
  - Reports Service: Microservice (no exposed port)

**Build:**
- TypeScript compilation to CommonJS (`module: commonjs`)
- Compilation target: ES2021
- ts-loader 9.5.4 for webpack
- Output directory: `dist/`
- Monorepo structure with separate compilation per service

**Code Quality:**
- ESLint 10.0.3 - Code linting
- Prettier 3.8.1 - Code formatting
- eslint-config-prettier 10.1.8 - Prettier integration
- eslint-plugin-prettier 5.5.5 - Prettier plugin
- @typescript-eslint/parser 8.56.1 - TypeScript ESLint parser
- @typescript-eslint/eslint-plugin 8.56.1 - TypeScript ESLint rules
- ESLint configuration: `eslint.config.mjs`

## Platform Requirements

**Development:**
- Node.js 20.x (Alpine Linux image)
- npm with private GitHub Packages access (requires NPM_TOKEN)
- .npmrc configured for @dnchuong17 scope
- TypeScript compilation
- Docker (for containerization)

**Production:**
- Node.js 20-alpine Docker container
- dumb-init process manager (for proper signal handling)
- Docker Compose orchestration with:
  - PostgreSQL database
  - Redis 7-alpine caching layer
  - RabbitMQ 3-management-alpine message broker
  - Environment variable injection via .env file

**Deployment:**
- Docker images built for each service
- Multi-stage Docker build (builder + production stages)
- Docker Compose for local/staging orchestration
- docker-entrypoint.sh for service startup coordination
- Health checks enabled for API Gateway and dependency services

## Docker Configuration

**Base Image:** node:20-alpine (all services)

**Build Process:**
- Multi-stage build with builder and production stages
- Dependency installation via `npm ci --prefer-offline`
- Service-specific builds: `npm run build:api-gateway`, `npm run build:auth-service`, `npm run build:reports-service`
- Dev dependency pruning: `npm prune --omit=dev`

**Production Stage:**
- User: `nobody` (security hardening)
- Entrypoint: `dumb-init` (signal handling)
- Startup: `/docker-entrypoint.sh`
- Health check: HTTP GET on port 8081 (API Gateway)

**Published Images:**
- Docker Hub registry: `nguyenchuong1712/`
  - vietflood-api-gateway:latest
  - vietflood-auth-service:latest
  - vietflood-reports-service:latest

---

*Stack analysis: 2026-04-15*
