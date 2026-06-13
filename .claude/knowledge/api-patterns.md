# API Patterns — Pulse Technical Assessment

**Last Updated:** 2026-06-13

## Overview

Pulse coordination API is **polling-based (HTTP only)**, not WebSocket. Five core endpoints handle presence registration, heartbeat, signaling, and TURN credential provisioning. No authentication or authorization (anonymous, ephemeral connections).

---

## Endpoint Structure

All endpoints follow Next.js App Router conventions: `/app/api/{endpoint}/route.ts`

**Naming Convention:**
- Single-word resource names (lowercase): `join`, `poll`, `signal`, `leave`, `turn-credentials`
- HTTP methods: GET for queries, POST for mutations
- No versioning (v1, v2, etc.)

**Runtime Configuration (all routes):**
```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

- `nodejs` runtime required for database access
- `force-dynamic` disables caching (prevent stale responses)

---

## Response Format

### Success Responses

```json
{
  "ok": true,
  "data": { /* optional */ },
  ...additional fields
}
```

**Pattern:**
- `ok: true` indicates success
- HTTP status 200 (or 201 for creation)
- Response body is always JSON

**Example: `/api/join`**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "peers": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "lat": 37.7749,
      "lng": -122.4194,
      "busy": false
    }
  ]
}
```

### Error Responses

```json
{
  "error": "Human-readable error message"
}
```

**Pattern:**
- `error` field with description
- HTTP status 400 (bad input), 500 (server error), etc.
- No exception stack traces sent to client

**Example: Invalid ID**
```json
{
  "error": "invalid ids"
}
```

---

## Authentication & Authorization

**None.** The app is **anonymous and ephemeral.**

- No login / signup
- No session tokens
- No role-based access control
- Client-generated session ID (UUID) is the only "identity"

**Security model:**
- Anyone can call any endpoint with any session ID
- Rate limiting: Not implemented (Vercel serverless limitation)
- Input validation: Yes (size limits, type checks, format validation)

---

## Endpoints

### 1. POST `/api/join`

**Purpose:** Register a new presence record when user enters the app.

**Request:**
```json
{
  "lat": 37.7749,
  "lng": -122.4194
}
```

**Request Body:**
- `lat` (number): User's latitude (raw, will be privacy-offset server-side)
- `lng` (number): User's longitude (raw, will be privacy-offset server-side)

**Response (200 OK):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "peers": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "lat": 37.7749,
      "lng": -122.4194,
      "busy": false
    }
  ]
}
```

**Response Fields:**
- `id` (string): Client's generated session ID (should match header or body if provided, but not used in current implementation; generated client-side)
- `peers` (array): List of other online users

**Error Responses:**
- 400: Invalid lat/lng (not numbers, out of bounds)
- 500: Database error

**Side Effects:**
- Creates Presence record with `lastSeen = now()`
- Privacy offset applied to coordinates (1–3 km random)
- Coordinates stored, not raw location

**Called By:** Client on app entry (page mount)

---

### 2. GET `/api/poll?id={sessionId}`

**Purpose:** Heartbeat + mailbox drain + peer list + stale cleanup.

This is the **core polling loop** endpoint. Called every 1500ms by client.

**Request:**
- Query param: `id` (string, required) — Session ID from Presence table

**Response (200 OK):**
```json
{
  "peers": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "lat": 37.7749,
      "lng": -122.4194,
      "busy": false
    }
  ],
  "signals": [
    {
      "id": "sig-uuid",
      "fromId": "550e8400-e29b-41d4-a716-446655440001",
      "toId": "550e8400-e29b-41d4-a716-446655440000",
      "type": "request",
      "payload": null,
      "createdAt": "2026-06-13T12:00:00.000Z"
    }
  ]
}
```

**Response Fields:**
- `peers` (array): Online users excluding self
  - `id`, `lat`, `lng`, `busy` (see schema)
- `signals` (array): Signals in recipient's mailbox
  - `id`, `fromId`, `toId`, `type`, `payload`, `createdAt`

**Error Responses:**
- 400: Missing or invalid id
- 500: Database error

**Side Effects:**
1. **Heartbeat:** `UPDATE Presence SET lastSeen = now() WHERE id = {id}` (fixed in Phase 1 to update only caller)
2. **Cleanup (stale presence):** `DELETE FROM Presence WHERE lastSeen < (now - 15s)` 
3. **Cleanup (stale signals):** `DELETE FROM Signal WHERE createdAt < (now - 60s)`
4. **Drain inbox:** `DELETE FROM Signal WHERE id IN (fetched signals)`

**Called By:** Client in polling loop (every 1500ms)

**Polling Interval:** `POLL_INTERVAL_MS = 1500` (defined in `/lib/presence.ts`)

**Stale Timeout:** `STALE_MS = 15000` (15 seconds without heartbeat = offline)

---

### 3. POST `/api/signal`

**Purpose:** Send a signal (connection request, accept, decline, offer, answer, ICE candidate, or end).

**Request:**
```json
{
  "fromId": "550e8400-e29b-41d4-a716-446655440000",
  "toId": "550e8400-e29b-41d4-a716-446655440001",
  "type": "request",
  "payload": null
}
```

**Request Fields:**
- `fromId` (string): Sender's session ID
- `toId` (string): Recipient's session ID
- `type` (string): Signal type — one of:
  - `"request"` — Connection request
  - `"accept"` — Accept request
  - `"decline"` — Reject request (or auto-decline if busy)
  - `"offer"` — WebRTC SDP offer
  - `"answer"` — WebRTC SDP answer
  - `"ice"` — WebRTC ICE candidate
  - `"end"` — End connection / hang up
- `payload` (string, nullable): JSON string for SDP/ICE, or null for control signals

**Payload Examples:**

Control signal (no payload):
```json
{ "fromId": "...", "toId": "...", "type": "request", "payload": null }
```

SDP offer:
```json
{
  "fromId": "...",
  "toId": "...",
  "type": "offer",
  "payload": "{\"type\":\"offer\",\"sdp\":\"v=0\\r\\n...\"}"
}
```

ICE candidate:
```json
{
  "fromId": "...",
  "toId": "...",
  "type": "ice",
  "payload": "{\"candidate\":\"candidate:...\",\"sdpMLineIndex\":0,...}"
}
```

**Response (200 OK):**
```json
{
  "ok": true,
  "autoDeclined": false
}
```

**Response Fields:**
- `ok` (boolean): Always true if request validated
- `autoDeclined` (boolean): True if target was busy and request auto-declined

**Error Responses:**
- 400: Invalid IDs, invalid type, payload too large (> 64 KB)
- 500: Database error

**Side Effects:**
1. **Validation:** Check if target exists and is not busy (for "request" only)
2. **Auto-decline:** If target busy, create decline signal from target → sender
3. **Busy flag updates:**
   - `"accept"` → `UPDATE Presence SET busy = true WHERE id IN (fromId, toId)`
   - `"decline"` OR `"end"` → `UPDATE Presence SET busy = false WHERE id IN (fromId, toId)` (fixed in Phase 1)
4. **Mailbox insertion:** `INSERT INTO Signal (toId, fromId, type, payload)`

**Called By:** Client for all signaling (request, accept, decline, offer, answer, ice, end)

**Rate Limiting:** None (should add for production)

---

### 4. POST `/api/leave`

**Purpose:** Explicit cleanup when user closes tab or app.

**Request:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Request Fields:**
- `id` (string): Session ID to delete

**Response (200 OK):**
```json
{
  "ok": true
}
```

**Error Responses:**
- 400: Missing or invalid id
- 500: Database error

**Side Effects:**
- `DELETE FROM Presence WHERE id = {id}` (immediate removal from online list)

**Called By:** Client via `navigator.sendBeacon()` on page unload (guaranteed delivery even on hard close)

**Note:** Fallback to stale cleanup if sendBeacon fails (15-second timeout for dot to disappear).

---

### 5. GET `/api/turn-credentials`

**Purpose:** Fetch short-lived TURN credentials from Cloudflare for cross-network connectivity.

**Request:**
- No query params or body

**Response (200 OK):**
```json
{
  "urls": ["turn:turn1.cloudflare.example.com:3478", "turn:turn2.cloudflare.example.com:3478"],
  "username": "user:timestamp",
  "credential": "token-xxx"
}
```

**Response Fields:**
- `urls` (array): TURN server URLs (can have multiple for load balancing)
- `username` (string): Credentials username (time-limited by Cloudflare)
- `credential` (string): Credentials token (time-limited by Cloudflare)

**Error Responses:**
- 500: Missing env vars (`CLOUDFLARE_TURN_TOKEN_ID` or `CLOUDFLARE_TURN_API_TOKEN`)
- 500: Cloudflare API error (500, timeout, invalid response)

**Side Effects:**
- HTTP request to Cloudflare API: `POST https://api.cloudflare.com/client/v4/accounts/{TOKEN_ID}/rtc/config`
- Authorization header: `Bearer {API_TOKEN}`

**Caching:**
- Response header: `Cache-Control: private, max-age=300` (5-minute client-side cache)
- Client-side: Fetched once per connection start, cached locally

**Graceful Degradation:**
- If endpoint unreachable or returns error, client falls back to STUN-only (no exception thrown)
- Same-network connections work fine with STUN alone
- Cross-network connections with TURN configured have better success rates

**Called By:** Client via `buildICEConfig()` function (async, fetches before PeerSession creation)

**Environment Variables (Vercel):**
```
CLOUDFLARE_TURN_TOKEN_ID=your_account_id
CLOUDFLARE_TURN_API_TOKEN=your_api_token
```

---

## Common Query Parameters & Filters

| Endpoint | Param | Purpose | Type | Example |
|----------|-------|---------|------|---------|
| `/api/poll` | `id` | Session ID | string | `?id=550e8400-e29b-41d4-a716-446655440000` |

**No other query params used.** (No pagination, filtering, sorting.)

---

## Common Request/Response Headers

### Request Headers (Client → Server)

```
GET /api/poll?id=... HTTP/1.1
Content-Type: application/json
```

### Response Headers (Server → Client)

```
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store    (or for TURN: private, max-age=300)
```

**Note:** All responses are JSON, never HTML or other formats.

---

## Error Handling & Status Codes

| Status | Meaning | Example |
|--------|---------|---------|
| 200 | Success | All successful responses |
| 201 | Created | (Not used; join returns 200) |
| 400 | Bad Request | Invalid IDs, missing params, payload too large |
| 500 | Server Error | Database error, env vars missing, API error |

**No 404s** (all endpoints exist; errors are 400 or 500).

**No 401/403** (no authentication/authorization).

**Error Response Format:**
```json
{
  "error": "Human-readable description"
}
```

---

## Rate Limiting

**Current:** Not implemented.

**Needed for production:** Yes, especially on:
- `/api/signal` (spammable signaling)
- `/api/poll` (DoS vector with many concurrent users)

**Suggested:**
- Per-IP rate limit: 100 requests/minute
- Per-session rate limit: 500 requests/minute
- Cloudflare Workers or similar for edge-level rate limiting

---

## Pagination

**Not used.** Peer list and signal inbox are unbounded (assumed small in take-home context).

**Future consideration:** If user count grows, implement:
- Peer list: Paginate by nearest-neighbors or spatial tiles
- Signal inbox: Limit to last 100 signals, paginate if needed

---

## API Versioning

**Not versioned.** Single API surface, no v1/v2 endpoints.

**If versioning needed:** Consider path-based (`/api/v1/poll`) or header-based (`Accept: application/vnd.pulse.v1+json`).

---

## Webhook & Async Patterns

**None used.** All operations are synchronous request/response.

---

## Request Validation

**Input validation performed in all routes:**

```typescript
// Example: /api/signal
if (typeof fromId !== "string" || typeof toId !== "string") {
  return Response.json({ error: "invalid ids" }, { status: 400 });
}
if (payload && (typeof payload !== "string" || payload.length > MAX_PAYLOAD)) {
  return Response.json({ error: "invalid payload" }, { status: 400 });
}
```

**Payload Size Limit:** 64 KB (SDP/ICE candidates are small; cap prevents abuse)

---

## Client-Side Fetch Wrappers

All client-side API calls wrapped in `/lib/api.ts` for consistency:

```typescript
export async function join(lat: number, lng: number): Promise<JoinResponse> { ... }
export async function poll(id: string): Promise<PollResponse> { ... }
export async function sendSignal(fromId, toId, type, payload?): Promise<void> { ... }
export async function leave(id: string): Promise<void> { ... }
```

**Benefits:**
- Centralized error handling
- Consistent timeout/retry logic
- Type safety (TypeScript)
- Easy to add logging/metrics

---

## Performance & Latency

### Polling Interval
- **Client request frequency:** 1500 ms (every 1.5 seconds)
- **Round-trip latency:** ~100–500 ms (depends on geography, network)
- **Perceived staleness:** Up to 2 seconds (1.5s poll interval + network latency)

### Database Query Performance
- **Heartbeat update:** O(1) indexed lookup
- **Stale cleanup:** O(n log n) due to `lastSeen` index scan
- **Inbox query:** O(log n) indexed lookup on `toId`
- **All queries complete <100ms on Vercel (typical)**

### Typical Cycle
```
[Client] → (50ms) → [Vercel] (heartbeat + 3 queries: 50ms) → (50ms) → [Client]
Total: ~150ms per poll cycle, very fast.
```

---

## Summary

| Aspect | Details |
|--------|---------|
| **Endpoints** | 5 (join, poll, signal, leave, turn-credentials) |
| **HTTP Methods** | GET (poll, turn-credentials), POST (join, signal, leave) |
| **Authentication** | None (anonymous) |
| **Rate Limiting** | None (should add for production) |
| **Pagination** | None (unbounded lists) |
| **Versioning** | None |
| **Response Format** | JSON always |
| **Error Status Codes** | 400, 500 only |
| **Webhooks** | None |
| **Polling Interval** | 1500 ms |
| **Async Patterns** | None (all sync request/response) |
