# Realtime Location Tracking Backend (NestJS)

## Overview

Tracking is implemented in **`reports-service`** and exposed to clients through **`api-gateway`** for HTTP APIs.

- Realtime transport: Socket.io gateway in `reports-service`
- Tracking logic/state: `TrackingService` in `reports-service`
- Cross-service query bridge: RMQ `@MessagePattern` handlers in `reports-service`
- Client-facing HTTP APIs: `api-gateway` `ReportsController`

---

## Why `TrackingGateway` is required

`TrackingGateway` is needed for realtime push behavior:

- handle socket connect/disconnect lifecycle
- receive `send-location` events continuously
- broadcast `receive-location` and `user-disconnected` instantly

HTTP controllers alone cannot provide persistent bidirectional realtime streams.

---

## File map

### reports-service

- `apps/reports-service/src/tracking/tracking.module.ts`
- `apps/reports-service/src/tracking/tracking.gateway.ts`
- `apps/reports-service/src/tracking/tracking.service.ts`
- `apps/reports-service/src/tracking/tracking.controller.ts` (RMQ handlers)
- `apps/reports-service/src/reports-service.module.ts` (imports `TrackingModule`)
- `apps/reports-service/src/main.ts` (hybrid bootstrap: HTTP + RMQ)

### api-gateway

- `apps/api-gateway/src/reports/reports.controller.ts` (HTTP endpoints)
- `apps/api-gateway/src/reports/reports.service.ts` (RMQ proxy calls)

---

## Request flow

### Realtime location stream (WebSocket)
1. Device connects to reports-service Socket.io gateway.
2. Device emits `send-location`.
3. Gateway validates through `TrackingService`.
4. Gateway broadcasts `receive-location` to connected clients.
5. On disconnect, gateway broadcasts `user-disconnected`.

### Tracking status APIs (HTTP via gateway)
1. Client calls API Gateway endpoint.
2. API Gateway sends RMQ message to `reports_queue`.
3. reports-service `TrackingController` handles message pattern.
4. Response returns to API Gateway and back to client.

---

## Contracts

## WebSocket events

### Incoming
- `send-location`

Payload:
```json
{
  "latitude": 21.0285,
  "longitude": 105.8542,
  "accuracy": 8.3,
  "heading": 120,
  "speed": 3.5,
  "timestamp": 1746547265000
}
```

Validation:
- latitude/longitude must be finite numbers
- latitude: `-90..90`
- longitude: `-180..180`

### Outgoing
- `receive-location`
- `user-disconnected`
- `location-error`

`receive-location` payload:
```json
{
  "id": "socket-id",
  "latitude": 21.0285,
  "longitude": 105.8542,
  "accuracy": 8.3,
  "heading": 120,
  "speed": 3.5,
  "timestamp": 1746547265000
}
```

## RMQ patterns (reports-service)

- `tracking_clients`
- `tracking_locations`

## HTTP endpoints (api-gateway)

- `GET /reports/tracking/clients` (Admin, Relief)
- `GET /reports/tracking/locations` (Admin, Relief)

Both are protected with `JwtAuthGuard` + `RolesGuard`.

---

## In-memory state model

`TrackingService` stores:
- `connectedClients: Set<string>`
- `locations: Map<string, TrackedLocation>`

`TrackedLocation` fields:
- `socketId`
- `latitude`, `longitude`
- `accuracy`, `heading`, `speed`, `timestamp` (optional)
- `updatedAt`

This state is process-local and resets on restart.

---

## Startup behavior

`apps/reports-service/src/main.ts`:
1. `NestFactory.create(ReportsServiceModule)` for HTTP/WebSocket runtime
2. `app.connectMicroservice(...)` for RabbitMQ transport
3. `app.startAllMicroservices()`
4. `app.listen(REPORTS_SERVICE_PORT || 3002)`

This hybrid bootstrap is required so reports-service can serve both WebSocket and RMQ.

---

## Dependencies added

- `@nestjs/websockets`
- `@nestjs/platform-socket.io`
- `socket.io`

---

## Current limitations

1. In-memory tracking state (no persistence)
2. Gateway CORS currently permissive (`origin: "*"`)
3. No socket authentication yet

---

## Recommended next steps

1. Add JWT auth for socket handshake
2. Move location state to Redis with TTL
3. Add room-based broadcasts (region/disaster scoped)
4. Add event rate-limiting for `send-location`
5. Add Redis adapter for horizontal Socket.io scaling
