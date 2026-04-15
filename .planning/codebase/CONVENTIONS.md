# Coding Conventions

**Analysis Date:** 2024-12-19

## Language & Environment

**Primary Language:** TypeScript 5.9.3
- Target: ES2021
- Module: commonjs
- Decorators and metadata emission enabled
- Strict null checking not enforced in all apps (auth-service has `strictPropertyInitialization: false`)

**Runtime:** Node.js
- Package manager: npm
- Project type: NestJS monorepo with 3 microservices

## Naming Patterns

### Files

- **Service files:** `[feature].service.ts`
  - Example: `auth.service.ts`, `reports.service.ts`
  
- **Controller files:** `[feature].controller.ts`
  - Example: `auth.controller.ts`, `reports.controller.ts`

- **Module files:** `[feature].module.ts`
  - Example: `auth.module.ts`, `api-gateway.module.ts`

- **DTO files:** Inconsistent casing across codebase
  - Recommended: `[resource].dto.ts` (lowercase)
  - Found: Both `Dto/` directories with mixed naming
  - Example: `register.dto.ts`, `signIn.dto.ts`, `update_user.dto.ts`

- **Entity files:** `[entity].entity.ts`
  - Example: `users.entity.ts`, `refresh_token.entity.ts`

- **Enum files:** `[name].enum.ts`
  - Example: `userRole.enum.ts`, `report_type.enum.ts`

- **Guard files:** `[name]-auth.guard.ts` or `[name].guard.ts`
  - Example: `jwt-auth.guard.ts`, `role.guard.ts`, `refresh-jwt-auth.guard.ts`

- **Strategy files:** `[name].strategy.ts`
  - Example: `jwt.strategy.ts`, `refreshToken.strategy.ts`

### Classes & Interfaces

- **Controllers:** PascalCase ending in `Controller`
  - Example: `AuthController`, `ReportsController`, `ApiGatewayController`

- **Services:** PascalCase ending in `Service`
  - Example: `AuthService`, `ReportsService`, `UsersService`

- **Modules:** PascalCase ending in `Module`
  - Example: `AuthModule`, `ReportsModule`, `ApiGatewayModule`

- **Guards:** PascalCase ending in `Guard`
  - Example: `JwtAuthGuard`, `RolesGuard`, `RefreshJwtAuthGuard`

- **Entities:** PascalCase ending in `Entity`
  - Example: `UserEntity`, `RefreshTokenEntity`

- **DTOs:** PascalCase ending in `Dto`
  - Example: `RegisterDto`, `SigninDto`, `UpdateUserDto`, `CreateReportDto`

- **Enums:** PascalCase, no suffix
  - Example: `UserRole`, `ReportStatus`, `FloodType`

### Methods & Functions

- **Service methods:** camelCase, descriptive verb-noun pattern
  - Example: `register()`, `signIn()`, `validateUser()`, `createReport()`, `getAllReports()`, `updateProfile()`

- **Controller route handlers:** camelCase
  - Example: `signIn()`, `register()`, `profile()`, `updateProfile()`, `updateUserById()`, `deleteUser()`

- **Property names:** camelCase with underscores for database columns
  - Example: `userId`, `firstName`, `refresh_token` (in DTO), `first_name` (in entity)
  - Note: Inconsistent - DTO uses snake_case in some cases (`sign_in`, `update_user`, `first_name`)

### Variables & Constants

- **Constructor injection:** camelCase, prefixed with underscores in some cases
  - Example: `authService`, `auth_service`, `reportsClient`
  - Pattern: `@Inject("SERVICE_NAME") private readonly serviceName`

- **Constants/Enum values:** lowercase with underscores or lowercase only
  - Example: `CITIZEN = "citizen"`, `ADMIN = "admin"`, `durable: true`

- **Request/Response objects:** Generic `any` type used frequently
  - Example: `profile(@Req() req: any)`, `async logout(body: any)`

## Code Style

### Formatting

**Tool:** Prettier 3.8.1
- Integrated with ESLint via `eslint-plugin-prettier` and `eslint-config-prettier`
- No explicit `.prettierrc` file - using defaults
- Default Prettier settings apply:
  - Double quotes for strings (seen in code)
  - Semicolons at end of statements
  - Print width: 80 (default)

### Linting

**Tool:** ESLint 10.0.3 with TypeScript support

**Configuration:** `eslint.config.mjs` (Flat Config format)

**Parser:** `@typescript-eslint/parser` with `typescript-eslint` 8.56.1

**Extends:**
- `@eslint/js` recommended
- `typescript-eslint` recommendedTypeChecked
- `eslint-plugin-prettier/recommended`

**Active Linting Rules:**
- `@typescript-eslint/no-explicit-any`: `off` - Allows `any` type (permissive)
- `@typescript-eslint/no-floating-promises`: `warn` - Warns on unhandled promises
- `@typescript-eslint/no-unsafe-argument`: `warn` - Warns on unsafe argument passing

**Ignored Paths:**
- `dist/**`
- `node_modules/**`
- `eslint.config.mjs`

**Global variables enabled:**
- Node.js globals
- Jest globals (even though Jest not currently configured)

## Import Organization

**Order (observed pattern):**

1. NestJS framework imports
   ```typescript
   import { Module, Injectable, Inject } from "@nestjs/common";
   import { ClientsModule, Transport } from "@nestjs/microservices";
   ```

2. Third-party library imports
   ```typescript
   import * as bcrypt from "bcrypt";
   import { lastValueFrom, of, retry, timeout } from "rxjs";
   ```

3. Local module imports (relative paths)
   ```typescript
   import { AuthService } from "./auth.service";
   import { RegisterDto } from "./Dto/register.dto";
   ```

4. Custom package imports (vietflood-common)
   ```typescript
   import { LoggerService, CloudinaryService } from "vietflood-common";
   ```

**Path Aliases:** Not configured in current tsconfig.json (baseUrl is set but paths object is empty)

## Class Structure & Access Modifiers

**Pattern:** Constructor dependency injection with `private readonly` modifier

```typescript
@Injectable()
export class AuthService {
  constructor(
    @Inject("AUTH_SERVICE") private readonly auth_service: ClientProxy,
  ) {}
}
```

**Access Modifiers Used:**
- `private readonly` - Standard for injected dependencies and service fields
- `public` - Not explicitly used (implicit for class methods and properties)
- `protected` - Not observed in codebase

**Decorator Usage:**
- `@Injectable()` - Services and strategy classes
- `@Module()` - Module classes with imports, controllers, providers, exports
- `@Controller()` - HTTP controller classes with route paths
- `@Get()`, `@Post()`, `@Put()`, `@Delete()` - HTTP method decorators
- `@UseGuards()` - Authentication/authorization guards at method level
- `@Roles()` - Custom metadata for role-based access control
- `@Body()`, `@Param()`, `@Req()`, `@UploadedFiles()` - Route handler parameters
- `@Inject()` - Dependency injection of named services
- `@InjectRepository()` - TypeORM repository injection
- `@Entity()`, `@Column()`, `@CreateDateColumn()`, `@UpdateDateColumn()` - Entity/column definitions
- `@Index()` - Database column indexing

## Error Handling

**Strategy:** Explicit error handling with NestJS built-in exceptions

**Patterns Observed:**

1. **Validation Exceptions:**
   ```typescript
   throw new BadRequestException("Email already in use");
   ```

2. **Authorization Exceptions:**
   ```typescript
   throw new ForbiddenException("User not found in request");
   throw new ForbiddenException(`Only users with roles: ${requiredRoles.join(", ")}`);
   throw new UnauthorizedException(error);
   ```

3. **Microservice Error Handling (RxJS pattern):**
   ```typescript
   this.auth_service.send("register", registerDto).pipe(
     timeout(5000),
     retry(3),
     catchError((error) => {
       return of({ error: "auth service error!", details: error });
     }),
   )
   ```

4. **Try-Catch Blocks:**
   ```typescript
   try {
     const hashPassword = await bcrypt.hash(registerDto.password, 10);
     const user = await this.userRepository.save(newUser);
     return "register successfully";
   } catch (error) {
     throw new BadRequestException(error);
   }
   ```

## Logging

**Framework:** Custom `LoggerService` from `vietflood-common` package

**Pattern:** Injected as dependency

```typescript
constructor(private readonly logger: LoggerService) {
  this.logger.setServiceName("Api-gateway");
}
```

**Usage:**
- `this.logger.debug()` - Debug level logs
- `this.logger.info()` - Info level logs
- `this.logger.setServiceName()` - Set service name context

**Location in codebase:** Gateway services (api-gateway, reports-service) use logging extensively

## Database

**ORM:** TypeORM 0.3.28

**Pattern:**
- `@Entity()` decorated classes with `@Column()` properties
- `@InjectRepository()` for injecting repositories into services
- Database column naming uses snake_case (e.g., `first_name`, `date_of_birth`, `address_line`)
- Automatic timestamps with `@CreateDateColumn()` and `@UpdateDateColumn()`

**Example:**
```typescript
@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("increment")
  id!: number;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 255 })
  email!: string;
}
```

## Async/Await Patterns

**Pattern:** RxJS with `lastValueFrom()` for Promise conversion

```typescript
const data = await lastValueFrom(
  this.auth_service.send("register", registerDto).pipe(
    timeout(5000),
    retry(3),
    catchError((error) => {
      return of({ error: "auth service error!", details: error });
    }),
  ),
);
```

**Alternative:** Direct Promise returns for database operations

```typescript
const user = await this.userRepository.save(newUser);
```

## Comments & Documentation

**JSDoc/TSDoc:** Not extensively used in codebase

**Inline Comments:** Rarely present

**Git Hooks:** `setup.sh` and `verify.sh` scripts check Docker configuration but don't enforce code quality

## Microservice Communication

**Transport:** RabbitMQ (AMQP)

**Pattern:**
- Services registered in `ClientsModule` with named connections
- Message-based communication with `send()` pattern
- Standard timeout: 5000ms for most calls, 10000ms for upload operations
- Automatic retry: 3 attempts on failure

```typescript
ClientsModule.register([
  {
    name: "AUTH_SERVICE",
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL || "amqp://admin:admin@rabbitmq:5672"],
      queue: "auth_queue",
      queueOptions: { durable: true },
      persistent: true,
    },
  },
])
```

## File Upload & Storage

**Multipart Upload:** `@nestjs/platform-express` with `multer`

**Storage:** In-memory storage for processing, then upload to Cloudinary

```typescript
@UseInterceptors(FilesInterceptor("files", 10, { storage: memoryStorage() }))
```

**Cloud Storage:** Cloudinary via `vietflood-common` package's `CloudinaryService`

## Type Safety

**Enforcement:**
- TypeScript strict mode not fully enabled
- Frequent use of `any` type in parameters (explicitly allowed by ESLint)
- No explicit type for request/response bodies in some cases

**DTO Validation:** Planned but not heavily enforced - DTOs use plain class definitions without validation decorators from `class-validator` visible in current code

## Module Organization

**Monorepo Structure:**
- `apps/api-gateway/` - Main API gateway (HTTP REST)
- `apps/auth-service/` - Microservice handling authentication
- `apps/reports-service/` - Microservice handling reports

**Module Dependencies:**
- Services import DTOs, entities, and other services
- Controllers import services
- Modules register controllers, services, and external client modules

---

*Convention analysis: 2024-12-19*
