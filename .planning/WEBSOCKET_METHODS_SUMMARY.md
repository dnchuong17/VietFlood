# WebSocket Location Tracking - Implementation Methods

## Complete Research Summary

Based on comprehensive research of your NestJS microservices architecture, here are the **recommended methods** for implementing WebSocket-based real-time location tracking.

---

## 1. RECOMMENDED TECH STACK

### Core Libraries (Verified & Production-Ready)
```
✅ socket.io 4.8.3           — Real-time bidirectional communication
✅ @nestjs/websockets 11.1   — NestJS WebSocket gateway adapter
✅ socket.io-redis 6.1.1     — Enable horizontal scaling via Redis
✅ @turf/turf 7.3.4          — Distance & bearing calculations
✅ geolib 3.3.14             — Lightweight distance math (fallback)
✅ typeorm-spatial 0.2.8     — PostGIS integration with TypeORM
✅ PostGIS (PostgreSQL)      — Spatial database queries
```

### Why Socket.io over WebSocket?
- ✅ Automatic fallback to HTTP long-polling if WebSocket unavailable
- ✅ Built-in room/namespace management (no custom broadcast logic)
- ✅ Automatic client reconnection with exponential backoff
- ✅ Redis adapter for horizontal scaling (Socket.io-Redis)
- ✅ Tight NestJS integration via @nestjs/websockets

---

## 2. FOUR IMPLEMENTATION METHODS

### METHOD 1: Event-Driven Location Broadcasting (RECOMMENDED)
**Best for:** Real-time location updates with broadcasting to subscribed users

```
Flow:
1. User sends location via Socket.io → API Gateway
2. API Gateway validates JWT, caches in Redis (60s TTL)
3. Location Service calculates distance to disaster
4. Broadcasts to Socket.io room (e.g., "location:disasterId_1")
5. All subscribed users receive update in real-time
6. Async: RabbitMQ message → Reports Service for persistence
```

**Advantages:**
- Real-time updates to all interested users
- Scales with Redis adapter (no O(n²) broadcast problem)
- Integrates seamlessly with existing RabbitMQ for persistence

**Complexity:** Medium | **Latency:** <100ms

---

### METHOD 2: Spatial Query Method (For Finding Nearby Reports)
**Best for:** Finding reports within distance threshold of user location

```
Flow:
1. User sends location to API Gateway
2. API Gateway queries Reports Service: "Find reports within 5km"
3. Reports Service uses PostGIS query: ST_DWithin(user_point, report_location, 5000)
4. Database returns sorted results (closest first)
5. Return list to user
```

**Advantages:**
- Leverages existing PostgreSQL database
- PostGIS indexes make queries fast (<100ms even with 100k reports)
- No need for external APIs
- Sorted by distance automatically

**Complexity:** Low | **Latency:** <100ms

---

### METHOD 3: Route/Navigation Method (With External APIs)
**Best for:** Turn-by-turn directions from current location to disaster

```
Flow:
1. User sends location + target disaster ID
2. API Gateway calls Google Directions API or OSRM
3. Get full route (polyline, distance, duration)
4. Send route to frontend for display on map
```

**Advantages:**
- Real-world routing (honors roads, traffic, restrictions)
- Turn-by-turn directions
- Multiple route options possible
- Traffic-aware (with Google Maps)

**Complexity:** Medium | **Latency:** 1-3s (depends on API)

**Recommended Services:**
- Google Directions API ($$$ per request, highly accurate)
- OSRM (Open Route Service Manager) - FREE, self-hosted or SaaS

---

### METHOD 4: Proximity Alert Method (Geofencing)
**Best for:** Notifying users when they're near a disaster location

```
Flow:
1. User sends location via WebSocket
2. API Gateway checks: Is user within 1km of any active disaster?
3. If YES: Send "alert:entered_zone" event to user socket
4. If NO: Clear alert
```

**Advantages:**
- Low latency, runs in-memory
- Uses Turf.js (no external APIs)
- Can trigger notifications/UI changes
- Lightweight

**Complexity:** Low | **Latency:** <10ms

---

## 3. ARCHITECTURE PATTERN

```
┌──────────────────────────────────┐
│ React Client (Browser)           │
│ - Geolocation API                │
│ - Socket.io-client               │
└────────┬─────────────────────────┘
         │ WebSocket (ws://)
         ↓
┌──────────────────────────────────┐
│ API Gateway (NestJS)             │
│                                  │
│ ┌─ Location Gateway              │
│ │  - Validate JWT                │
│ │  - @SubscribeMessage handlers  │
│ │                                │
│ ├─ Location Service              │
│ │  - Turf.js calculations        │
│ │  - Redis caching               │
│ │  - RabbitMQ publishing         │
│ │                                │
│ └─ Socket.io Rooms               │
│    - Namespaced by disaster ID  │
│    - Redis adapter for scaling   │
└────┬────────────────┬────────────┘
     │                │
     ↓ RabbitMQ       ↓ HTTP/gRPC
┌──────────────┐  ┌─────────────────┐
│ Reports Svc  │  │ Routing API      │
│              │  │ (Google/OSRM)    │
│ - PostGIS    │  │                  │
│ - Spatial Q  │  │ Returns route    │
│ - Persist    │  │ + distance       │
└──────────────┘  └─────────────────┘
     ↓
┌──────────────┐
│ PostgreSQL   │
│ - Reports    │
│ - Locations  │
│ - PostGIS    │
└──────────────┘
```

---

## 4. DATA FLOW EXAMPLES

### Real-Time Location Broadcast
```
Browser sends:
{
  event: "location:update",
  data: { lat: 21.0285, lng: 105.8542, disasterId: 1 }
}

API Gateway:
1. Validates JWT
2. Caches in Redis: location:{userId} → {lat, lng, ...} [TTL: 60s]
3. Publishes to room: "location:1"

Subscribers in room receive:
{
  event: "location:received",
  data: { userId: 5, lat: 21.0285, lng: 105.8542, timestamp: ... }
}
```

### Find Nearby Reports
```
Browser requests:
GET /api/reports/nearby?lat=21.0285&lng=105.8542&radius=5000

API Gateway calls Reports Service RabbitMQ:
send("find_nearby", { lat: 21.0285, lng: 105.8542, radiusMeters: 5000 })

Reports Service executes PostGIS query:
SELECT id, lat, lng, description, category,
  ST_Distance(...) as distance
FROM reports
WHERE ST_DWithin(ST_GeomFromText('POINT(...)'), report.geom, 5000)
ORDER BY distance ASC
LIMIT 10

Returns:
[
  { id: 1, lat: 21.03, lng: 105.85, distance: 800, category: "flood" },
  { id: 3, lat: 21.02, lng: 105.86, distance: 1200, category: "landslide" }
]
```

### Get Directions to Disaster
```
Browser requests:
POST /api/routes/directions
{ from: { lat: 21.0285, lng: 105.8542 }, to_disasterId: 1 }

API Gateway:
1. Get disaster location from cache/DB
2. Call Google Directions API
3. Return polyline + distance + duration

Response:
{
  distance: 5.2,        // km
  duration: 12,         // minutes
  polyline: "...",      // encoded polyline for map
  steps: [
    { instruction: "Head north", distance: 0.5 },
    { instruction: "Turn right", distance: 1.2 }
  ]
}
```

---

## 5. CRITICAL IMPLEMENTATION PATTERNS

### Pattern 1: WebSocket Gateway with JWT Auth
```typescript
@WebSocketGateway({ namespace: 'location' })
export class LocationGateway {
  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth.token;
    const decoded = await this.jwtService.verifyAsync(token);
    socket.data.userId = decoded.sub;
  }
  
  @SubscribeMessage('location:update')
  handleLocationUpdate(@ConnectedSocket() socket: Socket, @MessageBody() data) {
    // Validate, cache, broadcast
  }
}
```

### Pattern 2: Socket.io Redis Adapter (for scaling)
```typescript
async afterInit(server: Server) {
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  server.adapter(createAdapter(pubClient, subClient));
}
```

### Pattern 3: PostGIS Spatial Queries
```typescript
async findReportsWithin(userLat, userLng, radiusMeters) {
  return this.reportsRepository
    .createQueryBuilder('report')
    .where(`ST_DWithin(
      ST_GeomFromText('POINT(:lng :lat)', 4326),
      ST_GeomFromText('POINT(' || report.lng || ' ' || report.lat || ')', 4326),
      :radius
    )`)
    .orderBy('ST_Distance(...)', 'ASC')
    .getMany();
}
```

---

## 6. SECURITY CONSIDERATIONS

✅ JWT validation on socket.handshake
✅ Rate limiting: 1 location update per 5 seconds
✅ Input validation: Coordinate bounds checking
✅ Room subscriptions: Scoped by disaster ID
✅ TLS/SSL: wss:// protocol in production
✅ No trusted client coordinates: Validate server-side

---

## 7. PRODUCTION PITFALLS TO AVOID

❌ Don't hand-roll custom WebSocket (use socket.io)
❌ Don't calculate distances in app (use Turf.js)
❌ Don't skip PostGIS indexes (ST_DWithin needs geometry index)
❌ Don't trust client location without validation
❌ Don't forget Redis TTL on location cache (causes unbounded growth)
❌ Don't broadcast to all users (use rooms by disaster ID)
❌ Don't handle reconnection without room re-subscribe

---

## 8. NEXT STEPS

1. **Install dependencies** in API Gateway and Reports Service
2. **Enable PostGIS** in PostgreSQL
3. **Create Location Gateway** in API Gateway
4. **Add spatial columns** to Report entity
5. **Create spatial queries** service in Reports Service
6. **Implement frontend** socket.io-client

**Full implementation code**: See `.planning/WEBSOCKET_LOCATION_TRACKING_RESEARCH.md`

