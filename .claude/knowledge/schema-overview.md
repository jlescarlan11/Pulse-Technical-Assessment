# Schema Overview — Pulse Technical Assessment

**Last Updated:** 2026-06-13

## Database: PostgreSQL (Transient Coordination Store Only)

### Key Principle

**No durable user data is stored.** Presence and Signal records are transient—deleted on leave, after stale timeout, or immediately after delivery. Chat and video never touch the server (P2P over WebRTC).

---

## Tables

### Table: `Presence`

Tracks online users and their connection state.

```sql
CREATE TABLE "Presence" (
  id          TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  busy        BOOLEAN NOT NULL DEFAULT false,
  lastSeen    TIMESTAMP NOT NULL
);

CREATE INDEX "Presence_lastSeen_idx" ON "Presence"("lastSeen");
```

**Columns:**

| Column  | Type      | Nullable | Default      | Purpose |
|---------|-----------|----------|--------------|---------|
| id      | TEXT      | No       | N/A          | Client-generated session UUID (PK) |
| lat     | FLOAT     | No       | N/A          | User's latitude (privacy-offset 1–3 km) |
| lng     | FLOAT     | No       | N/A          | User's longitude (privacy-offset 1–3 km) |
| busy    | BOOLEAN   | No       | `false`      | Locked during active connection (prevent overlapping calls) |
| lastSeen| TIMESTAMP | No       | N/A          | Last poll heartbeat (for stale cleanup) |

**Indexes:**

- `(lastSeen)` — Used in `/api/poll` to find stale rows (`lastSeen < staleCutoff`)

**Lifecycle:**

- **Created:** `/api/join` (POST) — User registers presence with privacy-offset location
- **Updated:** 
  - `/api/poll` (GET) — `lastSeen` updated on each heartbeat (fixed in Phase 1 to update only caller's row)
  - `/api/signal` (POST) — `busy` flag toggled on "accept" (set true) or "decline"/"end" (set false)
- **Deleted:**
  - `/api/leave` (POST) — Explicit deletion when user closes app (via sendBeacon)
  - `/api/poll` (GET) — Stale cleanup: rows with `lastSeen < now - 15s` auto-deleted
- **TTL:** ~15 seconds (10 missed polls at 1500ms interval, or explicit `/api/leave`)

**Constraints:**

- `id` is TEXT (UUID as string), uniquely identified by session
- No foreign keys (Signal references Presence IDs, but no FK constraint—simpler for transient data)

**Notable Design Choices:**

- **Coordinates are pre-offset** — Raw user location never stored; offset applied by `/app/geo.ts` before insertion
- **No indexes on id** — id is PK (implicit index); lookups are O(1)
- **No soft deletes** — Rows are permanently deleted (not marked deleted)

---

### Table: `Signal`

Message mailbox for connection requests and WebRTC signaling (offer/answer/ICE/end).

```sql
CREATE TABLE "Signal" (
  id        TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  toId      TEXT NOT NULL,
  fromId    TEXT NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT,
  createdAt TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX "Signal_toId_idx" ON "Signal"("toId");
```

**Columns:**

| Column    | Type      | Nullable | Default           | Purpose |
|-----------|-----------|----------|-------------------|---------|
| id        | TEXT      | No       | `gen_random_uuid()`| Signal message ID (PK) |
| toId      | TEXT      | No       | N/A               | Recipient session ID |
| fromId    | TEXT      | No       | N/A               | Sender session ID |
| type      | TEXT      | No       | N/A               | Signal type: "request", "accept", "decline", "offer", "answer", "ice", "end" |
| payload   | TEXT      | Yes      | NULL              | JSON string (SDP offer/answer, ICE candidate), or null for control signals |
| createdAt | TIMESTAMP | No       | `now()`           | Record creation time (for stale cleanup) |

**Indexes:**

- `(toId)` — Used in `/api/poll` to query recipient's inbox (`WHERE toId = id`)

**Lifecycle:**

- **Created:** `/api/signal` (POST) — Signal is inserted into recipient's mailbox
  - Auto-decline generated if recipient is busy (inserted by `/api/signal` route, not client)
- **Deleted:**
  - `/api/poll` (GET) — Immediately after drained (read and returned to client)
  - `/api/poll` (GET) — Stale cleanup: rows with `createdAt < now - 60s` auto-deleted
- **TTL:** ~60 seconds (or immediately after polled)

**Constraints:**

- No FK constraint on toId/fromId (would slow inserts; Presence row may be deleted concurrently)
- `type` is TEXT (not ENUM, for flexibility)
- `payload` is nullable (control signals like "request", "decline", "end" have no payload)

**Notable Design Choices:**

- **No timestamps for delivery tracking** — Signal is not marked as "read"; it's either in mailbox or deleted
- **Immediate deletion after drain** — Client receives signal once, then it's gone (prevents re-processing)
- **60s TTL for orphaned signals** — If client crashes, signal is cleaned up after 60s (won't accumulate)

---

## Data Flow by API Endpoint

### `/api/join` → Presence.create()

```
POST /api/join { lat, lng }
  → Apply privacy offset via geo.ts
  → INSERT INTO Presence (id, lat, lng, busy, lastSeen)
  → RETURN { id, peers: [...] }
```

### `/api/poll` → Presence.update() + cleanup

```
GET /api/poll?id={sessionId}
  1. UPDATE Presence SET lastSeen = now() WHERE id = {sessionId}
  2. DELETE FROM Presence WHERE lastSeen < (now - 15s)
  3. DELETE FROM Signal WHERE createdAt < (now - 60s)
  4. SELECT ... FROM Presence WHERE id != {sessionId} AND lastSeen >= (now - 15s)
  5. SELECT ... FROM Signal WHERE toId = {sessionId}
  6. DELETE FROM Signal WHERE id IN (selected signals)  -- drain inbox
  → RETURN { peers: [...], signals: [...] }
```

### `/api/signal` → Signal.create() + Presence.update()

```
POST /api/signal { fromId, toId, type, payload }
  → Validate inputs
  → If type = "request":
      → SELECT busy FROM Presence WHERE id = {toId}
      → If busy or missing, auto-insert decline signal
  → If type = "accept":
      → UPDATE Presence SET busy = true WHERE id IN ({fromId}, {toId})
  → If type = "decline" OR "end":
      → UPDATE Presence SET busy = false WHERE id IN ({fromId}, {toId})
  → INSERT INTO Signal (toId, fromId, type, payload)
  → RETURN { ok: true }
```

### `/api/leave` → Presence.delete()

```
POST /api/leave { id }
  → DELETE FROM Presence WHERE id = {id}
  → RETURN { ok: true }
```

---

## Consistency & Constraints

### Transient Data Guarantee

- No `CHECK`, `UNIQUE`, or foreign key constraints (unnecessary for ephemeral data)
- No audit columns (created_at, updated_at, deleted_at) beyond what WebRTC signaling needs
- No soft deletes (rows are hard-deleted)

### Busy Flag Invariant

**Rule:** At most one active connection per session at a time.

- When "accept" signal sent: both peers marked `busy: true`
- When "decline" or "end" signal sent: both peers marked `busy: false`
- When "request" received and target is busy: auto-decline (prevents overlapping connections)

**Fix in Phase 1:** Bug was that "end" signal did not clear busy flag; fixed to include "end" in the condition.

### Stale Presence Cleanup

**Rule:** Delete presence if not heartbeated in 15 seconds (10 missed polls at 1500ms interval).

- Prevents phantom dots on map after user closes app
- Allows re-entry: can rejoin with a new session ID and appear as new dot

### Signal Inbox Atomicity

**Rule:** Signals are drained atomically to prevent loss.

- Read signals where toId = {sessionId}
- Return them to client
- Delete them only if read (same transaction or immediate deletion)
- If client crashes before next poll, signal is deleted after 60s by stale cleanup

---

## Performance Considerations

### Indexes

- `Presence(lastSeen)` — O(log n) scan for stale cleanup (common operation at 1.5s interval)
- `Signal(toId)` — O(log n) inbox query (polled at 1.5s interval)
- `Presence(id)` — Implicit (PK); O(1) lookups

### Query Patterns

| Query | Frequency | Index Used |
|-------|-----------|-----------|
| Poll heartbeat: `UPDATE Presence.lastSeen WHERE id = X` | 1500ms per user | PK (id) |
| Stale cleanup: `DELETE FROM Presence WHERE lastSeen < X` | 1500ms (shared) | `Presence(lastSeen)` |
| Inbox drain: `SELECT FROM Signal WHERE toId = X` | 1500ms per user | `Signal(toId)` |
| Signal cleanup: `DELETE FROM Signal WHERE createdAt < X` | 1500ms (shared) | `Signal(createdAt)` (MISSING?) |

**Note:** `Signal(createdAt)` index not explicitly defined in schema but used for stale cleanup. Consider adding for production.

### Denormalization

- **Presence:** Location is stored as raw lat/lng (no reverse geocoding, no city/country columns)
- **Signal:** Full sender/receiver IDs stored (no join to Presence; mailbox self-contained)

### Transaction Isolation

- Most operations are single-statement (no explicit transactions)
- Exception: `/api/poll` has multiple statements; PgBouncer (Vercel) doesn't support transactions over pooler, so treated as independent (eventual consistency is acceptable)

---

## Evolution & Migrations

### Current Schema Version

Prisma 7.8.0 with PostgreSQL adapter. Schema defined in `/prisma/schema.prisma`.

### Migration Strategy

- **Development:** `npx prisma db push` (schema → database, no migration files)
- **Production:** Should use `npx prisma migrate deploy` (repeatable, auditable)

### Historical Migrations

- **d098fe4 (initial):** Created Presence and Signal tables
- **No schema changes after initial commit** (current as of 2026-06-13)

### Planned Future Changes

- Consider `Signal(createdAt)` index for stale cleanup performance
- Consider `Presence(busy)` index if filtering by busy status becomes common
- Consider TTL column if database supports automatic row expiration (PostgreSQL 14+)

---

## Security Notes

### Data Privacy

- **Coordinates are pre-offset** before storage (never raw location)
- **No chat/video** stored (P2P only)
- **No user identifiers** (session UUIDs are opaque)
- **Transient** — all data deleted within 60–15 seconds

### SQL Injection Prevention

- All queries use Prisma (parameterized statements by default)
- No raw SQL in codebase except in notes/comments
- Input validation in API routes before database insertion

### Soft Delete Consideration

- **Not used** (deliberate choice for simplicity and privacy)
- Deleted rows are permanently gone (no recovery window)

---

## Monitoring & Debugging

### Useful Queries

```sql
-- Count online users
SELECT COUNT(*) FROM Presence WHERE lastSeen > now() - INTERVAL '15 seconds';

-- Find busy users
SELECT id, busy FROM Presence WHERE busy = true;

-- Inspect mailbox for a user
SELECT id, fromId, type, createdAt FROM Signal WHERE toId = 'user-id' ORDER BY createdAt DESC;

-- Stale presence that will be cleaned on next poll
SELECT id, lastSeen FROM Presence WHERE lastSeen < now() - INTERVAL '15 seconds';

-- Orphaned signals
SELECT id, fromId, toId, createdAt FROM Signal WHERE createdAt < now() - INTERVAL '60 seconds';
```

### Logging

- Server logs presence heartbeat count in `/api/poll`
- Server logs stale cleanup deletions in `/api/poll`
- Client logs connection state transitions via console.log (available in browser DevTools)

---

## Summary

| Aspect | Details |
|--------|---------|
| **Tables** | 2 (Presence, Signal) |
| **Total Columns** | 9 (5 in Presence, 5 in Signal, 1 shared) |
| **Primary Keys** | id (TEXT/UUID) |
| **Foreign Keys** | None (transient data doesn't need constraints) |
| **Indexes** | 2 (`Presence.lastSeen`, `Signal.toId`) |
| **Constraints** | None explicit (data is ephemeral) |
| **Data Retention** | 15s (Presence), 60s (Signal), or immediate (after delivery) |
| **Transactions** | None (eventual consistency acceptable) |
| **Total Schema Size** | ~2 KB (SQL definition) |
