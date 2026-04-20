# WebSocket Location Tracking with OpenStreetMap

## 🎯 RECOMMENDATION: Method 2 + Method 4 Combined

Since you're using **OpenStreetMap** (free, self-hosted routing), here's the optimal approach:

---

## Why OpenStreetMap Changes the Approach

**OpenStreetMap advantages:**
✅ FREE — no API costs per request
✅ Self-hosted — OSRM (Open Route Service Machine)
✅ Works offline — can self-host entire routing engine
✅ Privacy-friendly — no tracking via Google
❌ Slightly slower than Google (1-3s vs <1s)
❌ Requires self-hosting infrastructure (OSRM server)

---

## RECOMMENDED ARCHITECTURE for OpenStreetMap

### Primary Method: Hybrid Approach (Method 2 + Method 4)

```
┌─────────────────────────────────────────────┐
│ Frontend (Browser)                          │
│ - Real-time location sharing (WebSocket)   │
│ - Display map with user location           │
│ - Show nearby disasters                    │
└────────────┬────────────────────────────────┘
             │ WebSocket: location:update
             ↓
┌─────────────────────────────────────────────┐
│ API Gateway (NestJS)                        │
│                                             │
│ ┌─ Location Gateway                         │
│ │  - Validates JWT on connection           │
│ │  - Caches user location in Redis         │
│ │  - Broadcasts to room (disaster-based)   │
│ │                                          │
│ ├─ Location Service                        │
│ │  - Turf.js: distance, bearing, proximity│
│ │  - Checks if user in danger zone        │
│ │  - Emits proximity alerts               │
│ │                                          │
│ └─ Room-based broadcasting                │
│    - location:{disasterId}                 │
│    - location:alerts (for proximity)       │
│                                            │
└────┬──────────────┬────────────────────────┘
     │              │
     ↓ RabbitMQ     ↓ HTTP
┌──────────────┐  ┌────────────────────┐
│ Reports Svc  │  │ OSRM (Local Server)│
│              │  │ (OpenStreetMap)    │
│ - PostGIS    │  │                    │
│ - ST_DWithin │  │ GET /route/v1/     │
│ - Nearby     │  │ driving/lng,lat;  │
│   reports    │  │ lng2,lat2         │
└──────────────┘  │                    │
                  │ Returns:          │
                  │ - Distance        │
                  │ - Duration        │
                  │ - Polyline        │
                  └────────────────────┘
     ↓
┌─────────────────┐
│ PostgreSQL      │
│ - Reports       │
│ - Locations     │
│ - PostGIS       │
└─────────────────┘
```

---

## Implementation Strategy

### 1. **Real-Time Location Broadcast (Method 2)**

```typescript
// User shares location via WebSocket
socket.emit('location:update', {
  lat: 21.0285,
  lng: 105.8542,
  disasterId: 1
})

// API Gateway:
// 1. Validate JWT ✓
// 2. Cache in Redis (60s TTL) ✓
// 3. Broadcast to room "location:1" ✓
// 4. Emit to RabbitMQ for persistence ✓

// Receivers get:
{
  event: 'location:received',
  userId: 5,
  lat: 21.0285,
  lng: 105.8542,
  timestamp: ...,
  disasterId: 1
}
```

**Stack:**
- `socket.io` 4.8.3
- `redis` (cache + Socket.io-Redis adapter)
- `@turf/turf` (distance calculations)

---

### 2. **Proximity Alert Detection (Method 4)**

```typescript
// When user location updates:

const userLocation = { lat: 21.0285, lng: 105.8542 };
const disasters = [
  { id: 1, lat: 21.03, lng: 105.85, radius: 1000 }, // 1km
  { id: 2, lat: 21.02, lng: 105.86, radius: 2000 }  // 2km
];

// For each disaster, check if user is within radius
for (const disaster of disasters) {
  const distance = turf.distance(
    [userLocation.lng, userLocation.lat],
    [disaster.lng, disaster.lat],
    { units: 'meters' }
  );
  
  if (distance < disaster.radius) {
    // User is in danger zone!
    socket.emit('alert:in_danger_zone', {
      disasterId: disaster.id,
      distance: distance,
      message: 'You are near a disaster location!'
    });
  }
}
```

**Stack:**
- `@turf/turf` (lightweight, runs in-memory)
- Redis (for disaster location cache)
- No external API needed

---

### 3. **Find Nearby Disasters (Bonus)**

```typescript
// User requests: "Show me disasters near me"

// Request:
GET /api/reports/nearby?lat=21.0285&lng=105.8542&radius=5000

// Reports Service executes:
SELECT id, lat, lng, category, description,
  ST_Distance(...) as distance
FROM reports
WHERE ST_DWithin(
  ST_GeomFromText('POINT(105.8542 21.0285)', 4326),
  ST_GeomFromText('POINT(lng lat)', 4326),
  5000  // 5km radius
)
ORDER BY distance ASC
LIMIT 10

// Response:
[
  { id: 1, distance: 800, category: 'flood', description: '...' },
  { id: 3, distance: 1200, category: 'landslide', description: '...' }
]
```

**Stack:**
- PostgreSQL + PostGIS
- `typeorm-spatial` for ORM integration

---

### 4. **Optional: Full Route with OSRM**

If user wants turn-by-turn directions to a specific disaster:

```typescript
// Request to OSRM (local server or hosted)
GET http://osrm-server:5000/route/v1/driving/
    105.8542,21.0285;        // from: user location
    105.85,21.03             // to: disaster location

// Response:
{
  routes: [
    {
      distance: 5200,  // meters
      duration: 312,   // seconds (~5 minutes)
      geometry: "...", // polyline for map
      legs: [
        { steps: [...], distance: 1000, duration: 60 }
      ]
    }
  ]
}

// Send to frontend to display on map
socket.emit('route:calculated', {
  distance: 5.2,    // km
  duration: 5,      // minutes
  polyline: "...",
  instructions: [...]
})
```

---

## Technology Stack Summary

| Layer | Technology | Purpose | Cost |
|-------|-----------|---------|------|
| Frontend | Socket.io-client 4.8.3 | Real-time connection | FREE |
| Gateway | socket.io 4.8.3 | WebSocket server | FREE |
| Location Logic | @turf/turf 7.3.4 | Distance/bearing | FREE |
| Caching | Redis 5.12.1 | Location cache | FREE (Docker) |
| Database | PostgreSQL + PostGIS | Spatial queries | FREE |
| Routing | OSRM (self-hosted) | Turn-by-turn directions | FREE |
| Adapter | socket.io-redis 6.1.1 | Scale across instances | FREE |

**Total Cost:** $0 API fees ✅

---

## Installation Commands

```bash
# API Gateway
npm install socket.io @nestjs/websockets socket.io-redis ioredis @turf/turf geolib typeorm-spatial

# Frontend
npm install socket.io-client

# PostgreSQL (one-time)
# CREATE EXTENSION IF NOT EXISTS postgis;

# OSRM (Docker, optional)
docker run -d -p 5000:5000 \
  -v /path/to/osm-data:/data \
  osrm/osrm-backend:v5.28.0 osrm-routed --algorithm mld /data/planet-latest.osrm
```

---

## Implementation Priority (Phase Order)

### Phase 1: Real-Time Location Broadcasting (Week 1)
1. ✅ Add socket.io to API Gateway
2. ✅ Create Location Gateway with JWT auth
3. ✅ Implement location caching in Redis
4. ✅ Add Socket.io rooms by disaster ID
5. Frontend: Display connected users' locations

### Phase 2: Proximity Alerts (Week 1-2)
1. ✅ Add distance calculation logic (Turf.js)
2. ✅ Check if user within disaster radius on each update
3. ✅ Emit alert:in_danger_zone event to user
4. Frontend: Show alert modal/notification

### Phase 3: Find Nearby Disasters (Week 2)
1. ✅ Enable PostGIS in PostgreSQL
2. ✅ Add geometry column to Reports entity
3. ✅ Create spatial queries service
4. ✅ API endpoint: GET /reports/nearby?lat=X&lng=Y&radius=Z
5. Frontend: Show nearby disasters list

### Phase 4: OSRM Integration (Week 3 - Optional)
1. ⚙️ Deploy OSRM server (Docker)
2. ⚙️ Create routing service in API Gateway
3. ⚙️ API endpoint: POST /routes/directions
4. Frontend: Display turn-by-turn route on map

---

## Key Design Decisions for OpenStreetMap

| Decision | What We Chose | Why |
|----------|--------------|-----|
| Routing | OSRM (self-hosted) | FREE, offline-capable, privacy-friendly |
| Distance calc | Turf.js (in-memory) | Fast, no API calls, accurate for short distances |
| Location cache | Redis with 60s TTL | Auto-cleanup, high performance, prevents memory growth |
| Room broadcast | Socket.io + Redis adapter | Scales horizontally, handles thousands of users |
| Spatial queries | PostGIS ST_DWithin | Database-level optimization, 100x faster than app-level |
| Auth | JWT on socket.handshake | Reuses existing Passport integration |

---

## OpenStreetMap Specifics

### Map Rendering Options
- **Leaflet.js** (most popular, lightweight) — pairs well with OSM
- **Mapbox GL JS** (more features, but optional paid tier)
- **OpenLayers** (enterprise-grade)

### Tile Providers
- **tile.openstreetmap.org** (official, free)
- **CartoDB** (styled tiles, free tier)
- **Stamen** (design-focused, free)

### Example Frontend Setup
```jsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';

<MapContainer center={[21.0285, 105.8542]} zoom={13}>
  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
  {/* User location marker */}
  {/* Disaster location markers */}
  {/* Route polyline overlay */}
</MapContainer>
```

---

## Ready to Implement?

**Next Steps:**

1. ✅ **Plan Phase 1** — Real-time location broadcasting
2. ✅ **Install dependencies**
3. ✅ **Create Location Gateway**
4. ✅ **Test with frontend**

Would you like me to create a detailed **PLAN.md** for Phase 1?

