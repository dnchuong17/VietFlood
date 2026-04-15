# Architecture

**Analysis Date:** 2025-04-16

## Pattern Overview

**Overall:** Microservices with API Gateway Pattern (NestJS-based)

**Key Characteristics:**
- Three independent NestJS applications communicating via RabbitMQ message queues
- API Gateway serves as the HTTP entry point and message broker client
- Backend services operate as microservices with dedicated RabbitMQ consumers
- Each service maintains its own PostgreSQL database instance
- Shared infrastructure (Redis, RabbitMQ) for caching and async communication
- Role-based access control (RBAC) with JWT authentication

## Layers

**API Gateway Layer:**
- Purpose: HTTP request handler, request routing, token validation, file upload processing
- Location: `apps/api-gateway/src/`
- Contains: Controllers, Auth guards, JWT strategies, Service proxies (RabbitMQ clients)
- Depends on: RabbitMQ (message transport), Auth-Service (RMQ), Reports-Service (RMQ)
- Used by: Frontend applications (Express CORS origins defined in `main.ts`)

**Auth Service Layer:**
- Purpose: User authentication, registration, profile management, token generation/refresh
- Location: `apps/auth-service/src/`
- Contains: User entity, auth business logic, JWT generation, password hashing, session management
- Depends on: PostgreSQL (user data), Redis (caching), RabbitMQ (message consumer)
- Used by: API Gateway (via RabbitMQ auth_queue)

**Reports Service Layer:**
- Purpose: Report creation, storage, status management, image/evidence handling
- Location: `apps/reports-service/src/`
- Contains: Report entity, CRUD operations, status transitions, Cloudinary integration
- Depends on: PostgreSQL (report data), Redis (caching), RabbitMQ (message consumer), Cloudinary (file storage)
- Used by: API Gateway (via RabbitMQ reports_queue)

**Data Layer:**
- Purpose: Persistent storage and data access
- Location: Entity definitions in each service
- Contains: TypeORM entities, database configuration, migrations
- Uses: PostgreSQL with TypeORM ORM abstraction

**Infrastructure Layer:**
- Purpose: Message queueing, caching, file storage
- Contains: RabbitMQ (async messaging), Redis (session/cache), Cloudinary (image CDN)
- Configuration: `docker-compose.yml` and `.env` variables

## Data Flow

**User Registration/Login Flow:**

1. Frontend sends HTTP POST to `POST /auth/register` or `POST /auth/sign_in` on API Gateway
2. API Gateway receives request at `apps/api-gateway/src/auth/auth.controller.ts`
3. AuthController calls AuthService.sign_in() or register()
4. AuthService sends RabbitMQ message with pattern "register" or "sign_in" to auth_queue
5. Auth-Service microservice consumes message via MessagePattern decorator
6. AuthServiceController invokes AuthService.register() or signIn()
7. Auth logic executes against PostgreSQL (user lookup, password validation)
8. JWT tokens generated via JwtService and stored in Redis
9. Response returned via RabbitMQ back to API Gateway
10. API Gateway returns HTTP response with tokens to client

**Report Creation Flow:**

1. Frontend sends multipart/form-data POST to `POST /reports/create` with files
2. API Gateway receives at `apps/api-gateway/src/reports/reports.controller.ts`
3. FilesInterceptor (multer) processes file upload from request
4. ReportsController invokes ReportsService.createReport()
5. ReportsService uploads files to Cloudinary via CloudinaryService
6. ReportsService builds payload with file metadata
7. Sends RabbitMQ message to "create" pattern on reports_queue
8. Reports-Service consumes and invokes ReportsService.createReport()
9. Report entity created/inserted into PostgreSQL
10. Evidence metadata stored as JSONB in report record
11. Response returned via RabbitMQ to API Gateway
12. HTTP response with report data returned to frontend

**State Management:**

- **User sessions**: Redis cache stores token blacklist and refresh token state
- **Authentication tokens**: JWT tokens in memory on client side
- **Message state**: RabbitMQ queues are persistent (durable: true) with explicit ack handling
- **Entity state**: PostgreSQL is single source of truth for user and report data

## Key Abstractions

**Microservice Pattern:**
- Purpose: Decompose domain into independent, scalable services
- Examples: `apps/auth-service/src/auth-service.module.ts`, `apps/reports-service/src/reports-service.module.ts`
- Pattern: NestJS Module with dedicated RabbitMQ queue listener

**Service Proxy Pattern:**
- Purpose: Client-side abstraction for RabbitMQ communication
- Examples: `apps/api-gateway/src/auth/auth.service.ts`, `apps/api-gateway/src/reports/reports.service.ts`
- Pattern: Injectable services with @Inject("SERVICE_NAME") ClientProxy + RxJS observables (lastValueFrom, retry, timeout)

**Controller Patterns:**
- **Gateway Controllers** (HTTP entry points): `apps/api-gateway/src/auth/auth.controller.ts`, `apps/api-gateway/src/reports/reports.controller.ts`
  - Accept HTTP requests with decorators @Post, @Get, @Put, @Delete
  - Delegate to service layer via dependency injection
- **Microservice Controllers** (RabbitMQ message handlers): `apps/auth-service/src/auth-service.controller.ts`, `apps/reports-service/src/reports-service.controller.ts`
  - Handle RabbitMQ messages via @MessagePattern("pattern_name") decorator
  - Pattern names: "register", "sign_in", "profile", "create", "update", "delete"

**Guard and Strategy Pattern:**
- Purpose: Authentication and authorization at HTTP layer
- JWT Strategy: `apps/api-gateway/src/auth/strategy/jwt.strategy.ts` - validates JWT tokens
- Guards: `JwtAuthGuard`, `RolesGuard` - enforce authentication and role-based access
- Roles enforced via @Roles decorator on endpoints

**Entity-Based Data Modeling:**
- Purpose: Represent domain entities with TypeORM decorators
- Examples: `apps/auth-service/src/users/users.entity.ts` (User with roles), `apps/reports-service/src/entity/report.entity.ts` (Report with status and location)
- Pattern: @Entity class with @Column decorators, relationships, and timestamps

## Entry Points

**API Gateway HTTP Server:**
- Location: `apps/api-gateway/src/main.ts`
- Triggers: Application startup on port 8081 (configurable via API_GATEWAY_PORT env var)
- Responsibilities: Initialize NestFactory, configure CORS, enable HTTP listener
- Exports HTTP routes: `/auth/*`, `/reports/*`

**Auth Service RabbitMQ Consumer:**
- Location: `apps/auth-service/src/main.ts`
- Triggers: Application startup, listens to auth_queue on RabbitMQ
- Responsibilities: Create NestJS microservice with RMQ transport, connect to RabbitMQ broker
- Handles message patterns: "register", "sign_in", "profile", "all", "get_user", "update", "delete", "refresh", "logout"

**Reports Service RabbitMQ Consumer:**
- Location: `apps/reports-service/src/main.ts`
- Triggers: Application startup, listens to reports_queue on RabbitMQ
- Responsibilities: Create NestJS microservice with RMQ transport, connect to RabbitMQ broker
- Handles message patterns: "create", "" (getAll), "get_all_by_users", "update", "delete", "get_report_by_id"

## Error Handling

**Strategy:** Error propagation with logging and graceful degradation via RxJS operators

**Patterns:**

1. **RPC Exception Wrapping**: Microservice controllers throw RpcException for RabbitMQ responses
   - Example: `apps/auth-service/src/auth-service.controller.ts` - wraps try/catch in RpcException
   
2. **RxJS Error Handling**: Gateway services use RxJS catchError, retry, and timeout operators
   - Pattern: `.pipe(timeout(5000), retry(3), catchError(err => of({ error: "...", details })))`
   - Prevents cascading failures with configurable retry logic
   
3. **Validation Errors**: DTOs use class-validator decorators (@IsEmail, @IsNotEmpty, etc.)
   - BadRequestException thrown in auth-service for invalid data
   - Example: `apps/auth-service/src/auth-service.service.ts` checks for duplicate email/username
   
4. **Database Errors**: TypeORM errors propagate as RpcException or BadRequestException
   - Example: User not found throws UnauthorizedException
   
5. **Logging Integration**: LoggerService (from vietflood-common) logs errors and debug info
   - Set via logger.setServiceName() at service init
   - All controllers and services instantiate and use LoggerService

## Cross-Cutting Concerns

**Logging:** 
- Framework: Custom LoggerService (vietflood-common package)
- Implementation: Services call this.logger.debug(), this.logger.error() throughout
- Propagation: Service name set at initialization for context in logs

**Validation:** 
- Framework: class-validator with NestJS ValidationPipe (implicit)
- DTOs located in each service: `apps/*/src/DTO/` or `apps/*/src/*/dto/`
- Examples: RegisterDto, SigninDto, CreateReportDto validate required fields

**Authentication:** 
- Framework: Passport.js with JWT and Local strategies
- JWT tokens: Issued by auth-service, validated by api-gateway JwtAuthGuard
- Refresh tokens: Stored in RefreshTokenEntity, validated via RefreshJwtAuthGuard
- Token payload: Contains userId and role for authorization decisions

**Authorization:** 
- Mechanism: @Roles decorator + RolesGuard on protected endpoints
- Roles defined: UserRole.ADMIN, UserRole.RELIEF, UserRole.CITIZEN
- Examples: Only ADMIN can delete users, only ADMIN/RELIEF can view all reports

**File Upload:** 
- Framework: Multer with memory storage (files in buffer, not disk)
- Destination: Cloudinary CDN (configuration via CLOUDINARY_* env vars)
- Integration: CloudinaryService from vietflood-common handles uploadBuffer()
- Example: `apps/api-gateway/src/reports/reports.controller.ts` FilesInterceptor

**Caching:** 
- Framework: Redis (vietflood-common RedisModule)
- Usage: Token blacklist, user sessions, report caching (implicit in RedisModule)
- Configuration: REDIS_HOST, REDIS_PORT, REDIS_PASSWORD env vars

---

*Architecture analysis: 2025-04-16*
