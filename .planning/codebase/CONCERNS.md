# Codebase Concerns

**Analysis Date:** 2024-04-15

## Critical Security Issues

### Hardcoded Fallback Secrets in JWT Strategy

**Severity:** CRITICAL

**Issue:** JWT strategies contain hardcoded fallback secrets instead of failing safely when environment variables are missing.

**Files:**
- `apps/api-gateway/src/auth/strategy/jwt.strategy.ts:11` - uses `'fallback-secret-key'` fallback
- `apps/api-gateway/src/auth/strategy/refreshToken.strategy.ts:10` - uses `'fallback-refresh-secret-key'` fallback

**Impact:** 
- Anyone with knowledge of fallback secrets can forge valid JWT tokens
- Tokens generated in development/testing may work in production if env vars are unset
- Breaks authentication security entirely if fallback is used

**Fix Approach:**
- Remove all hardcoded fallback strings
- Match pattern in `apps/auth-service/src/strategy/jwt.strategy.ts:8-12` which validates and throws error if missing
- Ensure all JWT-related env vars are required: `JWT_SECRET`, `REFRESH_SECRET`, `API_GATEWAY_JWT_SECRET`

---

### Missing Environment Variable Validation on Startup

**Severity:** HIGH

**Issue:** Several critical environment variables are accessed without validation. If undefined, they will cause runtime errors instead of failing fast at startup.

**Files:**
- `apps/api-gateway/src/main.ts:7` - `process.env.API_GATEWAY_PORT` (accessed without validation)
- `apps/auth-service/src/config/data-source-options.ts` - `process.env.DATABASE_URL`
- `apps/auth-service/src/admin/admin.seed.ts:55-56` - `process.env.ADMIN_EMAIL` and `process.env.ADMIN_PASSWORD`
- `apps/reports-service/src/config/data-source-options.ts` - `process.env.DATABASE_URL`

**Impact:**
- Services may start but fail later during requests
- Difficult to debug startup issues in production
- No clear signal to operators that configuration is missing

**Fix Approach:**
- Create a `validateEnv()` function called in main.ts before service initialization
- Validate all required vars: `JWT_SECRET`, `REFRESH_SECRET`, `DATABASE_URL`, `RABBITMQ_URL`, `API_GATEWAY_PORT`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- Throw descriptive error with missing var names if any are undefined

---

### Loose Equality in Report Authorization Check

**Severity:** HIGH

**Issue:** User ID comparison uses loose equality (`!=`) instead of strict equality (`!==`).

**Files:**
- `apps/reports-service/src/reports-service.service.ts:213`

**Code:**
```typescript
if (report.userId != userId) {  // Should be !==
  throw new NotFoundException(`Report not found for user: ${userId}`);
}
```

**Impact:**
- Type coercion vulnerability: string "123" would equal number 123
- Authorization bypass: attacker could delete/modify reports of other users by using different type for ID

**Fix Approach:**
- Change to strict equality: `if (report.userId !== userId)`
- Add TypeScript rule to enforce strict equality throughout codebase

---

## High Priority Issues

### Zero Test Coverage

**Severity:** HIGH

**Issue:** Codebase has 2,524 lines of TypeScript across 3 microservices with **zero test files** (0 .spec.ts/.test.ts files found).

**Files Affected:**
- All services in `apps/api-gateway/src`
- All services in `apps/auth-service/src`
- All services in `apps/reports-service/src`

**Impact:**
- No verification that critical paths work (auth, reports, user management)
- Regression bugs undetected
- Refactoring creates risk of breaking changes
- Cannot safely verify security fixes
- Deployment risk extremely high

**Test Coverage Gaps:**
- `apps/auth-service/src/auth-service.service.ts:32-67` - Register flow (validation, duplication checks, password hashing) - **CRITICAL**
- `apps/auth-service/src/auth-service.service.ts:69-80` - Password validation logic - **CRITICAL**
- `apps/auth-service/src/refesh_token/refresh_token.service.ts:22-63` - Token creation and hashing - **CRITICAL**
- `apps/api-gateway/src/auth/auth.service.ts` - RPC error handling patterns - **HIGH**
- `apps/api-gateway/src/reports/reports.service.ts:22-72` - File upload and Cloudinary integration - **HIGH**
- `apps/reports-service/src/reports-service.service.ts:116-196` - Report update logic with evidence merging - **HIGH**
- `apps/api-gateway/src/auth/guard/role.guard.ts` - Authorization guard logic - **HIGH**

**Fix Approach:**
1. Set up Jest (already in devDeps) with `jest.config.js`
2. Create test suite for critical paths first:
   - Auth service: register, sign-in, token refresh, password validation
   - Report service: CRUD operations, authorization checks
   - Guards: role-based access control
3. Target 70%+ coverage for critical paths
4. Add pre-commit hook to prevent zero-test code merges

---

### Untyped RPC Message Payloads

**Severity:** HIGH

**Issue:** RPC messages receive untyped `any` payloads without validation or type checking.

**Files:**
- `apps/auth-service/src/auth-service.controller.ts:19,28,38,58,68,84,103,118` - All handlers use `@Payload() data` or `@Payload() data: any`
- `apps/api-gateway/src/auth/auth.controller.ts:93,96` - `@Body() body: any` in refresh endpoints

**Code Example:**
```typescript
@MessagePattern("register")
async register(@Payload() data) {  // No type, anything accepted
  return await this.authService.register(data);
}
```

**Impact:**
- Invalid data passes silently through API
- Type errors only caught at runtime
- Hard to debug which field was malformed
- Potential for security issues (injection, unexpected fields)

**Fix Approach:**
- Create typed DTOs for each RPC message pattern
- Apply validation decorators from `class-validator`
- Use `ValidationPipe` in `apps/api-gateway/src/main.ts`

---

### Missing Input Validation in DTOs

**Severity:** HIGH

**Issue:** DTOs have no validation decorators despite using `class-validator` and `class-transformer` in dependencies.

**Files:**
- `apps/auth-service/src/DTO/register.dto.ts` - No `@IsEmail()`, `@IsString()`, `@MinLength()` etc.
- `apps/auth-service/src/DTO/signIn.dto.ts` - No validation
- `apps/reports-service/src/dto/report.dto.ts` - No validation
- `apps/api-gateway/src/auth/Dto/register.dto.ts` - No validation

**Example:**
```typescript
export class RegisterDto {
  email!: string;        // Should have @IsEmail(), @IsNotEmpty()
  username!: string;     // Should have @IsString(), @MinLength(3)
  password!: string;     // Should have @MinLength(8), strength requirements
  phone!: string;        // Should have @IsPhoneNumber()
  // ... more fields with no validation
}
```

**Impact:**
- Invalid data (empty strings, wrong formats) reaches database
- Phone numbers and emails not validated
- Passwords without length/complexity requirements
- No protection against malformed requests

**Fix Approach:**
1. Add validation decorators to all DTOs
2. Add `ValidationPipe` to `main.ts` in both API gateway and service:
   ```typescript
   app.useGlobalPipes(new ValidationPipe({
     whitelist: true,
     forbidNonWhitelisted: true,
   }));
   ```
3. Specific validators needed:
   - `@IsEmail()` for emails
   - `@IsPhoneNumber('VN')` for phone numbers
   - `@MinLength(8)` and regex for passwords
   - `@IsNotEmpty()` for required fields

---

## Medium Priority Issues

### Type Safety Issues with `any` Type Usage

**Severity:** MEDIUM

**Issue:** 26 instances of `any` type in the codebase. While this codebase has some good typing practices, loose typing creates maintenance problems and hides bugs.

**Files:**
- `apps/auth-service/src/strategy/jwt.strategy.ts:21` - `payload: any`
- `apps/api-gateway/src/auth/strategy/jwt.strategy.ts:21` - `payload: any`
- `apps/api-gateway/src/auth/auth.controller.ts:35,43,46,91,93,96` - `@Req() req: any`, `@Body() body: any`
- `apps/api-gateway/src/auth/auth.service.ts:11,18,35,39` - `user: any`, `@Inject() ... ClientProxy`
- `apps/api-gateway/src/reports/reports.service.ts:105` - `report: any`

**Impact:**
- IDE cannot provide accurate autocomplete
- Refactoring breaks undetected
- Logic errors in object property access
- Makes code harder to onboard new developers

**Fix Approach:**
- Create typed interfaces for all `any` instances:
  ```typescript
  // In auth/types/jwt-payload.ts
  export interface JwtPayload {
    sub: number;
    username: string;
    role: UserRole;
    first_name?: string;
    last_name?: string;
  }
  
  // Replace: async validate(payload: any)
  // With:    async validate(payload: JwtPayload)
  ```
- Create request type extending Express Request with user property
- Use `noImplicitAny: true` in tsconfig.json

---

### Inefficient Database Queries

**Severity:** MEDIUM

**Issue:** Missing eager loading and N+1 query patterns in key services.

**Files:**
- `apps/api-gateway/src/reports/reports.service.ts:74-119` - Loads all reports, then fetches all users in separate query, then maps. Could cause N+1 if users fetched per report.
  ```typescript
  const reports = await lastValueFrom(...);  // Fetch all reports
  const users = await lastValueFrom(...);     // Separate query for all users
  return reports.map((report) => ({
    user: userMap.get(report.userId)
  }));
  ```
- `apps/reports-service/src/reports-service.service.ts:78-87` - `getAllReportsByUserId()` repeatedly called, could fetch same user multiple times

**Impact:**
- Performance degrades with data volume
- Redis caching helps but doesn't solve root cause
- Database connections wasted on multiple queries

**Fix Approach:**
- Use TypeORM relations to eager load users with reports
- Add `relations: ["user"]` to query builder
- Cache results at service layer for expensive queries

---

### Hardcoded CORS Origins and IP Addresses

**Severity:** MEDIUM

**Issue:** CORS configuration hardcodes multiple local IP addresses and frontend URLs directly in code.

**Files:**
- `apps/api-gateway/src/main.ts:11-17`

**Code:**
```typescript
app.enableCors({
  origin: [
    "http://172.16.25.252:3000",   // Hardcoded internal IP
    "http://172.16.25.252:3001",   // Hardcoded internal IP
    "http://localhost:3000",
    "http://localhost:3001",
    "https://vietflood-fe.vercel.app",
    "https://viet-flood-app.vercel.app",
  ],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
});
```

**Impact:**
- Internal network topology exposed in code
- Difficult to change CORS settings without redeployment
- No environment-specific configuration (dev/staging/prod)
- Credentials=true with specific origins creates CORS vulnerability if origin validation fails

**Fix Approach:**
- Move CORS origins to `apps/api-gateway/src/config/cors.config.ts`
- Load from environment variables: `CORS_ORIGINS` (comma-separated)
- Implement dynamic CORS validation function
- Different configs for each environment

---

### Password Returned in User Registration Response

**Severity:** MEDIUM  

**Issue:** While the auth service doesn't explicitly return password, there's inconsistent handling. The registration endpoint should return success message only, not user data.

**Files:**
- `apps/auth-service/src/auth-service.service.ts:32-67` - Returns string "register successfully" (good), but pattern not consistent across all endpoints
- `apps/auth-service/src/users/users.service.ts:83` - Only deletes password in `findUserWithID()`, not all queries

**Impact:**
- Password could leak in error responses if exception handling exposes full user object
- Inconsistent: some endpoints sanitize, others might not
- Future developers might copy pattern and accidentally expose passwords

**Fix Approach:**
- Create typed response DTOs that never include password field
- Use NestJS `@Exclude()` decorator on UserEntity password field
- Add response interceptor that sanitizes all user objects before sending
- Test that no response ever contains `password` field

---

### Unencrypted Refresh Token Comparison

**Severity:** MEDIUM

**Issue:** Refresh token validation compares hash directly with plaintext input without verification function.

**Files:**
- `apps/auth-service/src/refesh_token/refresh_token.service.ts:102-107`

**Code:**
```typescript
async validateRefreshToken(token: string) {
  const existing = await this.refreshTokenRepository.findOne({
    where: {
      hash_token: token,  // Searching for token as-is, but it's stored hashed
    },
  });
  // ...
}
```

**Analysis:** The token is stored hashed (line 34: `await bcrypt.hash(refreshToken, 10)`) but searched unhashed. This will never match - potential bug.

**Fix Approach:**
- Store plain tokens (if short-lived) OR
- Use bcrypt.compare() to validate: `const isValid = await bcrypt.compare(token, existing.hash_token)`
- Add unit test to verify token validation works end-to-end

---

### Missing Error Details in RPC Catch Handlers

**Severity:** MEDIUM

**Issue:** Error messages in RPC catches are generic, making debugging difficult.

**Files:**
- `apps/api-gateway/src/auth/auth.service.ts:20-25` - Returns generic `"auth service error!"` without context
- `apps/api-gateway/src/reports/reports.service.ts:75-85` - Same pattern
- All RPC services use `catchError((error) => of({ error: "service error!", details: error }))`

**Code:**
```typescript
catchError((error) => {
  return of({ error: "reports service error!", details: error });
})
```

**Impact:**
- Client receives vague error messages
- Difficult to diagnose what went wrong (validation? database? service down?)
- No structured error responses

**Fix Approach:**
- Create custom error response DTOs:
  ```typescript
  interface ErrorResponse {
    error: string;
    code: string;      // e.g., "VALIDATION_ERROR", "NOT_FOUND", "SERVICE_UNAVAILABLE"
    details?: any;
    timestamp: Date;
  }
  ```
- Log full error with context on server side
- Return safe, structured error to client

---

## Low Priority Issues

### Typo in Directory Name "refesh_token"

**Severity:** LOW

**Issue:** Directory and file are named `refesh_token` instead of `refresh_token`.

**Files:**
- `apps/auth-service/src/refesh_token/` - Should be `refresh_token`
- Multiple imports like `from "./refesh_token/..."` should be `from "./refresh_token/..."`

**Impact:**
- Inconsistency in codebase readability
- Easy to mistype in future imports
- Typo in service name would be embarassing in code reviews

**Fix Approach:**
- Rename directory and all imports: `refesh_token` → `refresh_token`

---

### Cache Key Pattern Fragility

**Severity:** LOW

**Issue:** Cache keys use simple string patterns that could collide.

**Files:**
- `apps/reports-service/src/reports-service.service.ts:49-51` - Uses `report:${id}` pattern
- `apps/auth-service/src/users/users.service.ts:31,41` - Uses plain `email` as cache key

**Impact:**
- No namespace isolation between services
- If different types use same ID, collision possible (e.g., `user:123` and `report:123`)
- Email as key works but lacks versioning if schema changes

**Fix Approach:**
- Use hierarchical cache keys: `report:v1:${id}` to allow versioning
- Use consistent pattern across all caching

---

### Incomplete Route Implementations

**Severity:** LOW

**Issue:** Some controller endpoints appear incomplete or have mismatched route designs.

**Files:**
- `apps/api-gateway/src/reports/reports.controller.ts:42` - Route `/relief/:id/user/:userId` is relief-scoped but PUT expects different URL pattern than admin update
- Different parameter ordering than user endpoint could cause confusion

**Impact:**
- Inconsistent API contract
- Users need different URL formats for admin vs relief operations
- Could cause routing confusion

**Fix Approach:**
- Standardize route patterns: all updates should follow same structure
- Consider: `/reports/:id?userId=X` or `/reports/:id/user/:userId` consistently

---

## Performance Concerns

### Large Service Files

**Severity:** MEDIUM

**Issue:** Several service files exceed reasonable size for single responsibility.

**Files:**
- `apps/reports-service/src/reports-service.service.ts` - 235 lines (createReport, getAllReports, getAllReportsByUserId, findReportWithID, updateReport, deleteReport)
- `apps/api-gateway/src/reports/reports.service.ts` - 212 lines (mixing file uploads, RPC calls, user mapping)
- `apps/auth-service/src/users/users.service.ts` - 189 lines (multiple find methods, update methods)

**Impact:**
- Difficult to test individual functions
- Easy to introduce bugs when modifying one method
- Cognitive load for understanding service

**Fix Approach:**
- Split reports service into:
  - `ReportCrudService` - database operations
  - `ReportUploadService` - Cloudinary uploads
  - `ReportCacheService` - Redis caching logic
- Similar split for user service

---

### Synchronous File Upload to Multiple Services

**Severity:** LOW

**Issue:** When uploading report with multiple evidences, files are uploaded to Cloudinary sequentially with `Promise.all()`.

**Files:**
- `apps/api-gateway/src/reports/reports.service.ts:30-47`

**Impact:**
- Upload time = sum of all file uploads
- No parallel execution benefit from Promise.all

**Note:** This is actually correct usage of Promise.all() for parallelization. No issue here on closer inspection.

---

## Dependency & Configuration Issues

### Unused/Untested Dependencies

**Severity:** LOW

**Issue:** Some dependencies in package.json may not be used or tested.

**Current Usage Found:**
- ✓ `@nestjs/microservices` - RabbitMQ usage confirmed
- ✓ `cloudinary` - Used in reports service
- ✓ `bcrypt` - Used in auth
- ✓ `passport-*` - Used in auth guards
- ✓ `typeorm`, `pg` - Database confirmed
- ? `multer` - Included but files uploaded are piped to Cloudinary, not stored locally

**Fix Approach:**
- Audit dependencies to remove unused ones
- Add npm audit regular checks

---

### Missing .npmrc in Production Image

**Severity:** LOW

**Issue:** Dockerfile copies `.npmrc` to production image (line ~30 in Dockerfile) but should not.

**Files:**
- `Dockerfile` - Line 30-31 copies .npmrc, but later (line 48) says "Clean up: rm -rf .npmrc"

**Impact:**
- If .npmrc contains authentication tokens, they briefly exist in production container
- Should be removed before npm install, not after

**Fix Approach:**
- Remove .npmrc from production stage entirely
- Use `npm ci --no-save` without .npmrc in production

---

## Documentation Gaps

### Minimal Project Documentation

**Severity:** LOW

**Issue:** README.md contains only title "# VietFlood" with no setup instructions.

**Files:**
- `README.md` - 1 line only

**Impact:**
- New developers cannot understand project structure
- No setup instructions for local development
- No API documentation
- No architecture overview

**Fix Approach:**
- Add to README.md:
  1. Project overview
  2. Local setup instructions
  3. How to run each microservice
  4. Environment variables needed
  5. Database schema overview
  6. API endpoint documentation (or link to postman collection)
  7. Architecture diagram

---

## Security - Defense in Depth

### Insufficient Error Handling in Token Refresh

**Severity:** MEDIUM

**Issue:** Refresh token endpoint doesn't verify token with bcrypt comparison (see earlier).

**Files:**
- `apps/auth-service/src/refesh_token/refresh_token.service.ts:102-122`

**Current Flow:**
1. Token stored as bcrypt hash
2. Validation queries for token as plain string → will never match
3. Potential security issue if this is exploited for token bypass

**Fix Approach:**
- Implement proper bcrypt comparison
- Add rate limiting on refresh attempts
- Log suspicious refresh attempts

---

### No Rate Limiting

**Severity:** MEDIUM

**Issue:** No rate limiting on authentication endpoints (login, register, password reset when implemented).

**Files:**
- `apps/api-gateway/src/auth/auth.controller.ts:16-19` - Sign in endpoint unprotected
- `apps/api-gateway/src/auth/auth.controller.ts:22-24` - Register endpoint unprotected

**Impact:**
- Brute force attacks on authentication possible
- Botnet could hammer registration endpoint to spam database
- Refresh token endpoint vulnerable to replay attacks

**Fix Approach:**
- Add `@nestjs/throttler` package
- Apply `@Throttle(5, 60)` to login/register endpoints (5 requests per 60 seconds)
- Add CAPTCHA for registration if not present

---

## Summary Statistics

| Category | Count | Priority |
|----------|-------|----------|
| Critical Security Issues | 3 | CRITICAL |
| High Priority Issues | 3 | HIGH |
| Medium Priority Issues | 6 | MEDIUM |
| Low Priority Issues | 5 | LOW |
| **Total Concerns** | **17** | - |

### Critical Path Items (Fix First)
1. Remove hardcoded JWT fallback secrets - Security breach vector
2. Add environment variable validation on startup - Prevents silent failures
3. Fix loose equality in user authorization - Authorization bypass risk
4. Add comprehensive test coverage - No coverage means no safety net
5. Add DTO validation - Invalid data protection

---

*Concerns audit completed 2024-04-15*
