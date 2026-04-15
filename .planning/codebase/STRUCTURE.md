# Codebase Structure

**Analysis Date:** 2025-04-16

## Directory Layout

```
VietFlood/ (project root)
├── apps/                           # Monorepo applications
│   ├── api-gateway/                # HTTP API Gateway (REST server)
│   │   ├── src/
│   │   │   ├── main.ts             # Entry point, CORS config
│   │   │   ├── api-gateway.module.ts
│   │   │   ├── api-gateway.controller.ts
│   │   │   ├── api-gateway.service.ts
│   │   │   ├── auth/               # Auth module (RabbitMQ client)
│   │   │   ├── reports/            # Reports module (RabbitMQ client)
│   │   │   └── config/             # Configuration files
│   │   ├── Dockerfile
│   │   └── tsconfig.app.json
│   │
│   ├── auth-service/               # Authentication Microservice (RabbitMQ server)
│   │   ├── src/
│   │   │   ├── main.ts             # Entry point, RabbitMQ listener setup
│   │   │   ├── auth-service.module.ts
│   │   │   ├── auth-service.controller.ts
│   │   │   ├── auth-service.service.ts
│   │   │   ├── users/              # User management
│   │   │   │   ├── users.entity.ts
│   │   │   │   ├── users.service.ts
│   │   │   │   ├── users.controller.ts
│   │   │   │   └── users.module.ts
│   │   │   ├── refesh_token/       # Refresh token management
│   │   │   │   ├── refresh_token.entity.ts
│   │   │   │   ├── refresh_token.service.ts
│   │   │   │   ├── refresh_token.controller.ts
│   │   │   │   └── refresh_token.module.ts
│   │   │   ├── admin/              # Admin initialization
│   │   │   │   └── admin.seed.ts
│   │   │   ├── guard/              # Authentication guards
│   │   │   ├── strategy/           # Passport strategies
│   │   │   ├── DTO/                # Data Transfer Objects
│   │   │   └── config/             # Database configuration
│   │   ├── Dockerfile
│   │   └── tsconfig.app.json
│   │
│   └── reports-service/            # Reports Microservice (RabbitMQ server)
│       ├── src/
│       │   ├── main.ts             # Entry point, RabbitMQ listener setup
│       │   ├── reports-service.module.ts
│       │   ├── reports-service.controller.ts
│       │   ├── reports-service.service.ts
│       │   ├── entity/
│       │   │   └── report.entity.ts
│       │   ├── dto/                # Data Transfer Objects
│       │   ├── enums/              # Report-related enums
│       │   └── config/             # Database configuration
│       ├── Dockerfile
│       └── tsconfig.app.json
│
├── dist/                           # Compiled output (generated)
├── docs/                           # Documentation
├── .planning/
│   └── codebase/                   # Architecture analysis documents
│
├── docker-compose.yml              # Local development setup
├── docker-compose.prod.yml         # Production setup
├── Dockerfile                      # Multi-stage build (all services)
├── docker-entrypoint.sh
├── nest-cli.json                   # NestJS monorepo config
├── package.json                    # Root dependencies
├── tsconfig.json                   # Base TypeScript config
├── tsconfig.base.json              # Extended base config
├── eslint.config.mjs               # ESLint configuration
├── setup.sh                        # Project setup script
├── deploy.sh                       # Deployment script
└── verify.sh                       # Verification script
```

## Directory Purposes

**apps/**
- Purpose: Contains all NestJS applications in a monorepo structure
- Contains: Three independent services (api-gateway, auth-service, reports-service)
- Key files: Each app has its own src/, Dockerfile, tsconfig.app.json

**apps/api-gateway/**
- Purpose: HTTP REST API entry point, request router, microservice client
- Contains: Controllers handling HTTP endpoints, services proxying to RabbitMQ queues
- Architecture: Gateway pattern - receives HTTP, sends RabbitMQ messages
- Key directories:
  - `src/auth/` - Auth-related HTTP endpoints and RabbitMQ client
  - `src/reports/` - Reports-related HTTP endpoints and RabbitMQ client
  - `src/config/` - CORS and other HTTP-level configuration

**apps/auth-service/**
- Purpose: User authentication, registration, profile management
- Contains: User entity, authentication business logic, token generation
- Architecture: Microservice pattern - listens on RabbitMQ auth_queue
- Key directories:
  - `src/users/` - User CRUD, lookup, validation
  - `src/refesh_token/` - Refresh token lifecycle management (note: typo in folder name "refesh_token")
  - `src/DTO/` - Data transfer objects for auth operations
  - `src/guard/` - JWT and Local authentication guards
  - `src/strategy/` - Passport strategies (JWT, Local, RefreshToken)
  - `src/config/` - TypeORM database configuration
  - `src/admin/` - Admin user seeding

**apps/reports-service/**
- Purpose: Report management, CRUD, image handling, status tracking
- Contains: Report entity, report business logic, Cloudinary integration
- Architecture: Microservice pattern - listens on RabbitMQ reports_queue
- Key directories:
  - `src/entity/` - Report entity and related types
  - `src/dto/` - Report creation and update DTOs
  - `src/enums/` - Report status, type, category enums
  - `src/config/` - TypeORM database configuration

**dist/**
- Purpose: Compiled JavaScript output (development and production builds)
- Generated: Yes, via `npm run build`
- Committed: No (in .gitignore)

**docs/**
- Purpose: Project documentation and design documents
- Contains: Architecture diagrams, API specifications, setup guides
- Key files: READMEs, design documents

**Configuration Files (Root)**
- `nest-cli.json`: Defines monorepo structure with three application projects
- `package.json`: Root-level dependencies shared by all services
- `tsconfig.json`: Base TypeScript configuration
- `tsconfig.base.json`: Extended base configuration (experimental decorators, metadata emission)
- `docker-compose.yml`: Local development with Redis, RabbitMQ, all services
- `docker-compose.prod.yml`: Production setup with pre-built images from Docker Hub
- `Dockerfile`: Multi-stage build that compiles all three services

## Key File Locations

**Entry Points:**
- `apps/api-gateway/src/main.ts`: HTTP server bootstrap on port 8081
- `apps/auth-service/src/main.ts`: RabbitMQ microservice listener (auth_queue)
- `apps/reports-service/src/main.ts`: RabbitMQ microservice listener (reports_queue)

**Configuration:**
- `apps/api-gateway/src/config/`: CORS configuration
- `apps/auth-service/src/config/`: TypeORM database config (data-source-options.ts)
- `apps/reports-service/src/config/`: TypeORM database config (data-source-options.ts)
- `nest-cli.json`: Monorepo project definitions

**Core Logic:**
- **Authentication**: `apps/auth-service/src/auth-service.service.ts` (register, login, password hashing, JWT signing)
- **Users**: `apps/auth-service/src/users/users.service.ts` (user lookup, CRUD)
- **Reports**: `apps/reports-service/src/reports-service.service.ts` (report CRUD, status changes, evidence management)
- **Auth Gateway**: `apps/api-gateway/src/auth/auth.service.ts` (RabbitMQ proxy for auth calls)
- **Reports Gateway**: `apps/api-gateway/src/reports/reports.service.ts` (RabbitMQ proxy for reports, Cloudinary upload)

**Data Models:**
- `apps/auth-service/src/users/users.entity.ts`: User entity (id, email, username, phone, role, profile info)
- `apps/auth-service/src/refesh_token/refresh_token.entity.ts`: Refresh token storage
- `apps/reports-service/src/entity/report.entity.ts`: Report entity (id, description, location, status, evidence, metadata)

**Testing:** Not detected (no .test.ts or .spec.ts files found)

**API Endpoints (HTTP):**
- `apps/api-gateway/src/auth/auth.controller.ts`: POST /auth/register, /auth/sign_in, GET /auth/profile, PUT /auth/update, DELETE /auth/delete/:id, etc.
- `apps/api-gateway/src/reports/reports.controller.ts`: POST /reports/create, GET /reports, /reports/:id, PUT /reports/update/:id, DELETE /reports/delete/:id

**Message Patterns (RabbitMQ):**
- `apps/auth-service/src/auth-service.controller.ts`: @MessagePattern("register"), ("sign_in"), ("profile"), ("all"), ("get_user"), ("update"), ("delete"), ("refresh"), ("logout")
- `apps/reports-service/src/reports-service.controller.ts`: @MessagePattern("create"), (""), ("get_all_by_users"), ("update"), ("delete"), ("get_report_by_id")

## Naming Conventions

**Files:**
- Controllers: `{feature}.controller.ts` (e.g., `auth.controller.ts`, `users.controller.ts`)
- Services: `{feature}.service.ts` (e.g., `auth-service.service.ts`, `users.service.ts`)
- Entities: `{feature}.entity.ts` (e.g., `users.entity.ts`, `report.entity.ts`)
- DTOs: `{action}.dto.ts` or in DTO folder (e.g., `register.dto.ts`, `signIn.dto.ts`)
- Modules: `{feature}.module.ts` (e.g., `auth.module.ts`, `users.module.ts`)
- Enums: Files in `enums/` folder (e.g., `status.enum.ts`, `flood_type.enum.ts`)
- Guards: `{check}-auth.guard.ts` (e.g., `jwt-auth.guard.ts`, `refresh-jwt-auth.guard.ts`)
- Strategies: `{type}.strategy.ts` (e.g., `jwt.strategy.ts`, `local.strategy.ts`)

**Directories:**
- Feature modules: lowercase with hyphen (e.g., `auth`, `reports`, `refresh_token`)
- Supporting folders: lowercase (e.g., `guard`, `strategy`, `dto`, `entity`, `enums`, `config`)
- Capital case for DTO folders in some services: `DTO/` (inconsistent - see Note below)

**Note on Naming Inconsistency:**
- `apps/api-gateway/src/auth/Dto/` uses capital D
- `apps/auth-service/src/DTO/` uses all caps
- `apps/reports-service/src/dto/` uses lowercase
- Recommend standardizing to lowercase `dto/`

## Where to Add New Code

**New Feature Endpoint:**

1. **HTTP REST endpoint** (if exposed in API Gateway):
   - Create controller method in `apps/api-gateway/src/{feature}/{feature}.controller.ts`
   - Add service method in `apps/api-gateway/src/{feature}/{feature}.service.ts`
   - Create DTO in `apps/api-gateway/src/{feature}/dto/{action}.dto.ts`
   - Decorate method with @Post, @Get, @Put, @Delete and @UseGuards as needed

2. **RabbitMQ message handler** (in backend service):
   - Add @MessagePattern("action") method in `apps/{service}/src/{service}.controller.ts`
   - Implement handler in `apps/{service}/src/{service}.service.ts`
   - Test via API Gateway proxy service

**New Module in Existing Service:**
- Create folder: `apps/{service}/src/{module}/`
- Add files:
  - `{module}.module.ts` - NestJS module definition
  - `{module}.controller.ts` - Message handlers (if microservice) or HTTP handlers (if gateway)
  - `{module}.service.ts` - Business logic
  - `{module}.entity.ts` - If data model needed
  - DTOs in subdirectory: `{module}/{action}.dto.ts`
- Import module in parent service's main module file (e.g., `apps/auth-service/src/auth-service.module.ts`)

**New Microservice:**
- Create `apps/{new-service}/` directory
- Structure:
  - `src/main.ts` - RabbitMQ bootstrap (copy from auth-service/src/main.ts)
  - `src/{service}.module.ts` - Root module with RabbitMQ ClientsModule config
  - `src/{service}.controller.ts` - @MessagePattern handlers
  - `src/{service}.service.ts` - Business logic
  - `Dockerfile` - Service-specific Docker build
  - `tsconfig.app.json`
- Register in `nest-cli.json` projects section
- Add docker service in `docker-compose.yml`

**Utilities/Shared:**
- No shared libs folder currently (using vietflood-common npm package)
- To add shared code: Create `libs/{feature}/` in monorepo if wanted
- Or add methods to vietflood-common package and version bump

**Enums/Constants:**
- Located in `enums/` subdirectories of relevant services
- Examples: `apps/reports-service/src/enums/status.enum.ts`, `flood_type.enum.ts`
- Duplicated across API Gateway and services if both need access
- Consider centralizing in vietflood-common to avoid duplication

**Database Migrations:**
- Location: Would be in `db/migrations/` (not yet created)
- Configure in `apps/{service}/src/config/data-source-options.ts` migrations path
- Currently using `synchronize: true` - enables auto-schema updates

## Special Directories

**node_modules/**
- Purpose: NPM dependencies (shared root-level installation)
- Generated: Yes, via `npm install`
- Committed: No (in .gitignore)

**dist/**
- Purpose: Compiled output from TypeScript
- Generated: Yes, via `npm run build`
- Committed: No (in .gitignore)
- Structure: Mirrors src/ structure with .js files

**.planning/codebase/**
- Purpose: Architecture and structure documentation
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md
- Committed: Yes (versioned documentation)

**.github/workflows/**
- Purpose: CI/CD pipeline definitions
- Contains: GitHub Actions workflow YAML files
- Committed: Yes

**.env and .env.* files**
- Purpose: Environment variables (database, Redis, RabbitMQ, JWT secrets, API keys)
- Pattern: Not committed (.gitignore), loaded via dotenv
- Example: DATABASE_URL, RABBITMQ_URL, REDIS_PASSWORD, JWT_SECRET, CLOUDINARY_* vars
- Must be set before running services

**.vscode/**
- Purpose: VS Code project settings and debugging configuration
- Committed: Yes (shared dev setup)

## Build and Deployment Structure

**Development Build:**
- Command: `npm run build` (NestJS CLI builds all projects defined in nest-cli.json)
- Output: `dist/` folder with three subdirectories (api-gateway, auth-service, reports-service)
- Entry files: `dist/apps/{service}/main.js`

**Docker Build (Local Development):**
- File: `docker-compose.yml`
- Services:
  - api-gateway (port 80 -> 8081)
  - auth-service (internal only)
  - reports-service (internal only)
  - redis (port 6379)
  - rabbitmq (port 5672, management 15672)
- Network: `vietflood-network` bridge
- Health checks: Enabled for api-gateway, redis, rabbitmq

**Docker Build (Production):**
- File: `docker-compose.prod.yml`
- Pulls pre-built images from Docker Hub (nguyenchuong1712/vietflood-*)
- Services: api-gateway (port 80), auth-service, reports-service, redis, rabbitmq
- Same network and health check setup

**Multi-stage Dockerfile (Root):**
- Build stage: Node 20 Alpine, npm ci, npm run build (all services), npm prune
- Runtime stage: Node 20 Alpine, copies compiled dist, sets NODE_ENV=production
- Final output: Single Docker image containing all three services (for single-image deployment)

---

*Structure analysis: 2025-04-16*
