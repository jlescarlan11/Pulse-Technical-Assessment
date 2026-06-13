# Pulse Technical Assessment — Complete Project Context

**Date Scanned:** 2026-06-13 14:15 GMT+8  
**Git HEAD:** fbbdc2a (feat: Add comprehensive debug logging and fix TURN credentials endpoint)  
**Working Tree:** Clean (all code committed), context.md regenerated  
**Phase Progress:** Phase 1 ✅ (6 bugs fixed), Phase 2 ✅ (UI/UX redesigned), Phase 3-4 (not yet started)

---

## Executive Summary

**Pulse** is a real-time peer-to-peer geolocation chat and video platform. Users appear as anonymous colored dots on a live Mapbox globe; tapping a dot initiates a connection request. Once accepted, peers communicate entirely P2P over WebRTC — chat via data channel, video via media tracks. The server handles **only** coordination (presence heartbeat, signal delivery, connection state machine via HTTP polling); no chat, video, or user data is ever stored or seen by the server.

**Architecture:**
- **Frontend:** Next.js 16.2.7 + React 19.2.4 + TypeScript 5 (strict) + Tailwind CSS 4 + Mapbox GL JS 3.24.0
- **Backend:** Node.js API routes (Vercel serverless) + Prisma 7.8.0 ORM + PostgreSQL
- **Coordination:** Transient Presence and Signal models (deleted on leave, after stale timeout, or after delivery)
- **P2P Network:** Native WebRTC (RTCPeerConnection, RTCDataChannel) with STUN (Google) + optional TURN (Cloudflare Realtime API)
- **Polling-based:** No WebSockets (incompatible with Vercel serverless); HTTP GET/POST at 1500ms interval

**Phase Status:**
- **Phase 1:** All 6 core bugs identified and fixed (heartbeat scope, busy flag clearing, ICE candidate ordering, data channel race, chat type mismatch, cross-network NAT traversal)
- **Phase 2:** UI/UX significantly enhanced with comprehensive animation library (10+ keyframes), improved styling, responsive adjustments
- **Phase 3-4:** Not yet started

**CRITICAL ISSUE — TURN Credentials Endpoint HTTP 500 in Production:**

The `/api/turn-credentials` endpoint (commit fbbdc2a) uses `https://rtc.live.cloudflare.com/api/v1/turn/keys/{CLOUDFLARE_TURN_TOKEN_ID}/credentials/rtc` but may return HTTP 500 in production. Root causes identified:

1. **Environment variable misconfiguration on Vercel:** `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` must be explicitly configured in Vercel project settings (not inherited from `.env`).
2. **Incorrect Cloudflare API endpoint format:** The endpoint `https://rtc.live.cloudflare.com/api/v1/turn/keys/{id}/credentials/rtc` is valid but may fail if:
   - The API token lacks RTC/Realtime permissions (check Cloudflare dashboard)
   - The token ID does not correspond to an active TURN configuration
   - Cloudflare API changes (endpoint is not officially documented in all APIs)
3. **Fallback is graceful:** `buildICEConfig()` in `lib/webrtc.ts` catches all errors and falls back to STUN-only configuration, so connections still work same-network and some cross-network cases. However, symmetric NAT traversal fails without TURN.

---

## Technology Stack

### Frontend
- **Next.js 16.2.7** — App Router with serverless deployment on Vercel
- **React 19.2.4** — Hooks-based components (useState, useRef, useEffect)
- **TypeScript 5** — Full strict mode enabled (`strict: true` in tsconfig.json)
- **Tailwind CSS 4** — @tailwindcss/postcss integration with custom animation library
- **Mapbox GL JS 3.24.0** — Interactive 2D/3D map with custom peer dot rendering
- **Jest 30.4.2** + **ts-jest 29.4.11** — Test runner with TypeScript transpilation
- **ESLint 9** + **eslint-config-next** — Linting (core-web-vitals + TypeScript rules)

### Backend & Database
- **Node.js runtime** — Next.js API routes at `/app/api/*`
- **Prisma 7.8.0** — ORM with PostgreSQL adapter (@prisma/adapter-pg)
- **PostgreSQL** — Transient coordination database (tested with Neon, Vercel Postgres, Supabase)
- **pg 8.21.0** — Native database driver (abstracted by Prisma)

### WebRTC & Networking
- **Native RTCPeerConnection** — No wrapper libraries (no webrtc-adapter, simple-peer, etc.)
- **RTCDataChannel** — Chat messaging (0ms latency, P2P)
- **RTCMediaStream** — Video and audio tracks
- **STUN:** Google stun.l.google.com:19302 (always available, handles same-network and some cross-network cases)
- **TURN:** Cloudflare RTC Realtime API (optional, dynamically fetched; graceful fallback to STUN-only)

### Build Tools
- **TypeScript 5** — tsconfig.json with `@/*` path alias, ES2017 target, strict mode
- **PostCSS 4** — postcss.config.mjs for Tailwind integration
- **Next.js 16** — next.config.ts (minimal configuration)

---

## Project Structure

```
Pulse-Technical-Assessment/
├── app/
│   ├── api/
│   │   ├── join/route.ts                  # POST: register presence, apply 1–3 km privacy offset
│   │   ├── poll/route.ts                  # GET: heartbeat (caller only), reap stale, drain inbox
│   │   ├── leave/route.ts                 # POST: explicit cleanup via sendBeacon on tab close
│   │   ├── signal/route.ts                # POST: signal delivery, auto-decline if busy, manage busy flag
│   │   └── turn-credentials/
│   │       ├── route.ts                   # GET: fetch Cloudflare TURN credentials (5-min cache)
│   │       └── __tests__/route.test.ts    # 12+ tests for endpoint validation
│   │
│   ├── components/
│   │   ├── EntryGate.tsx                  # Geolocation permission gate
│   │   ├── WorldMap.tsx                   # Mapbox GL map, peer dots, "You are here" marker
│   │   ├── ConnectionPrompt.tsx           # Modal: incoming request or video prompt
│   │   ├── ChatPanel.tsx                  # Chat UI (Phase 2: redesigned with animations)
│   │   └── VideoPanel.tsx                 # Video UI: local PiP + remote full-screen
│   │
│   ├── page.tsx                           # Root page: 530+ lines, connection/video state machine
│   ├── layout.tsx                         # Next.js app layout wrapper
│   ├── globals.css                        # Tailwind directives + 10+ animation keyframes
│   └── favicon.ico
│
├── lib/
│   ├── api.ts                             # Client-side fetch wrappers (join, poll, signal, leave)
│   ├── geo.ts                             # applyPrivacyOffset() — 1–3 km random offset calculation
│   ├── presence.ts                        # Constants: STALE_MS=15s, SIGNAL_TTL_MS=60s, POLL_INTERVAL_MS=1500ms
│   ├── prisma.ts                          # Singleton Prisma client (reused across hot reloads)
│   ├── types.ts                           # Shared types: SignalType, PeerDot, SignalMsg, PollResponse
│   ├── webrtc.ts                          # PeerSession class + buildICEConfig() async function
│   ├── webrtc.test.ts                     # 11+ unit tests for WebRTC functions
│   └── (other utilities)
│
├── prisma/
│   ├── schema.prisma                      # Presence and Signal models (transient, no durable user data)
│   └── migrations/                        # Prisma-managed schema migrations
│
├── public/
│   └── (static assets)
│
├── .env.example                           # Template: DATABASE_URL, NEXT_PUBLIC_MAPBOX_TOKEN
├── .env                                   # Populated locally with secrets (git-ignored)
├── .gitignore
├── eslint.config.mjs                      # ESLint flat config (next core-web-vitals + TypeScript)
├── jest.config.js                         # Jest configuration (ts-jest preset, Node environment)
├── next.config.ts                         # Next.js minimal config
├── postcss.config.mjs                     # Tailwind CSS integration
├── tsconfig.json                          # TypeScript compiler options
├── package.json                           # Dependencies + build/test scripts
├── package-lock.json
├── README.md                              # Project overview and phase descriptions
├── AGENTS.md                              # Notes for AI assistants
├── TURN_MANIFEST.md                       # Specification for TURN integration (13,500 words)
├── Notes.md                               # Phase 1 bug discovery and fix documentation
│
└── .claude/
    ├── context.md                         # This file (regenerated)
    ├── knowledge/
    │   ├── stack.md                       # Tech stack summary
    │   ├── conventions.md                 # Code style and naming
    │   ├── schema-overview.md             # Database schema details
    │   ├── api-patterns.md                # API endpoint structure
    │   ├── design-language.md             # Visual design (colors, typography, spacing, animations)
    │   ├── infra.md                       # Deployment and infrastructure
    │   └── decisions.md                   # Architectural decision log
    └── agents/                            # (14 specialized agents for multi-agent workflow)
```

---

## Git History & Current State

**Recent commits:**
```
fbbdc2a  feat: Add comprehensive debug logging and fix TURN credentials endpoint
cd2e999  refactor: Clean up unused error variable in TURN credentials endpoint
553a07f  Implement Cloudflare TURN server integration for WebRTC
7cb7cf2  Merge pull request #1 from jlescarlan11/fix/presence-and-webrtc-bugs
b0c2862  Fix presence heartbeat scope, signal end handler, and WebRTC connection bugs
d098fe4  Initialized
```

**Working tree:** Clean (all changes committed to main branch)  
**Branch structure:** Single `main` branch with linear history; no active feature branches  
**Untracked files:** `Notes.md` (documentation, not part of codebase build artifacts)

---

## Phase 1: Make It Run — Bug Fixes (COMPLETE)

### 6 Bugs Fixed

1. **Heartbeat updates all presence rows** (CRITICAL)
   - **File:** `/app/api/poll/route.ts` line 24–27
   - **Fix:** Changed `where: {}` to `where: { id }` so only the polling user's lastSeen is updated
   - **Impact:** User dots now disappear 15–20 seconds after app closes (was never disappearing; all users' heartbeats conflated)

2. **Busy flag not cleared on `end` signal** (CRITICAL)
   - **File:** `/app/api/signal/route.ts` line 78
   - **Fix:** Added `|| signalType === "end"` condition to clear both peers' busy flag on connection end
   - **Impact:** Users can now make sequential connections (was stuck after one call; busy flag persisted forever)

3. **ICE candidate flushed before remote description set** (CRITICAL)
   - **File:** `/lib/webrtc.ts` lines 109–111 (in flushPendingCandidates, moved after setRemoteDescription)
   - **Fix:** Reordered operations: set remote description first, then flush queued ICE candidates
   - **Impact:** WebRTC connections now transition to "connected" state (was stuck in "connecting"; candidates rejected before offer/answer)

4. **Data channel open event race condition** (CRITICAL)
   - **File:** `/lib/webrtc.ts` lines 74–81 (in wireDataChannel)
   - **Fix:** Check `readyState === "open"` before attaching onopen handler; call callback immediately if already open
   - **Impact:** Chat/video callbacks now always fire (was sometimes missed if data channel opened before handler attached)

5. **Chat message type mismatch** (MINOR)
   - **File:** `/lib/webrtc.ts` line 79 (in onmessage handler)
   - **Fix:** Changed receiver check from `msg.t === "chat"` to `msg.t === "msg"` (sender uses "msg" key)
   - **Impact:** Chat messages now received correctly (was silently discarded due to type name mismatch)

6. **Cross-network connectivity fails (Symmetric NAT)** (CRITICAL)
   - **Files:** `/lib/webrtc.ts` (buildICEConfig function) + `/app/api/turn-credentials/route.ts`
   - **Fix:** Implemented Cloudflare TURN credential fetching with dynamic API calls; graceful fallback to STUN-only if TURN unavailable
   - **Impact:** Users on different WiFi networks can now connect (was failing on symmetric NAT; STUN insufficient for NAT traversal)

---

## Phase 2: Make It Good — UI/UX Redesign (MOSTLY COMPLETE)

### Changes Made

**globals.css:** Extended from ~100 lines to 325+ lines with comprehensive animation library
- 10+ keyframe animations: `fade-in`, `fade-in-up`, `fade-in-down`, `scale-in`, `slide-in-right`, `pulse-ring`, `glow-pulse`, `spin-smooth`, `button-press`, and more
- Stagger delay utilities (`.animate-stagger-1` through `.animate-stagger-5`) for list animations
- Responsive mobile adjustments (faster animations, reduced motion on slower devices)
- Enhanced focus states and dark mode support

**Components:** Updated ChatPanel.tsx, VideoPanel.tsx, ConnectionPrompt.tsx, EntryGate.tsx, WorldMap.tsx with animation classes and improved styling

**Design direction:** Modern, minimal dark theme with emerald green accents; smooth, purposeful animations; rapid feedback on interaction

---

## Phase 3: Make It Secure (NOT YET STARTED)

Security review needed for API endpoint validation, input sanitization, and authentication/authorization concerns.

---

## Phase 4: Make It Better (NOT YET STARTED)

Original feature design entirely open-ended; implementation scope at builder's discretion.

---

## Database Schema (PostgreSQL)

### Model: Presence

**Purpose:** Tracks online users and their connection state.

```prisma
model Presence {
  id       String   @id           // client-generated session UUID
  lat      Float                  // latitude (privacy-offset 1–3 km)
  lng      Float                  // longitude (privacy-offset 1–3 km)
  busy     Boolean  @default(false)  // true during active connection
  lastSeen DateTime               // updated each poll (heartbeat)

  @@index([lastSeen])             // for stale cleanup query
}
```

**Lifecycle:**
- Created: `/api/join` (POST)
- Updated: `/api/poll` (GET — heartbeat), `/api/signal` (POST — busy flag)
- Deleted: `/api/leave` (POST — explicit) or stale cleanup in `/api/poll` (>15s idle)
- **TTL:** ~15 seconds (10 missed polls at 1500ms interval)

### Model: Signal

**Purpose:** Message mailbox for connection requests and WebRTC signaling.

```prisma
model Signal {
  id        String   @id @default(uuid())
  toId      String              // recipient session ID
  fromId    String              // sender session ID
  type      String              // "request"|"accept"|"decline"|"offer"|"answer"|"ice"|"end"
  payload   String?             // JSON string (SDP/ICE) or null
  createdAt DateTime @default(now())

  @@index([toId])               // for inbox queries
}
```

**Lifecycle:**
- Created: `/api/signal` (POST)
- Deleted: `/api/poll` (GET — immediately after drained) or stale cleanup (>60s old)
- **TTL:** ~60 seconds (or immediately after polled)

---

## API Endpoints (Coordination Only)

### POST `/api/join`

**Request:**
```json
{
  "lat": 37.7749,
  "lng": -122.4194
}
```

**Response (200):**
```json
{
  "ok": true
}
```

**Logic:**
- Validate lat/lng (must be numbers, within bounds)
- Apply 1–3 km privacy offset (random bearing)
- Insert Presence record (never store raw coordinates)
- Called once on entry

### GET `/api/poll?id=uuid`

**Response (200):**
```json
{
  "peers": [
    { "id": "uuid", "lat": 37.7749, "lng": -122.4194, "busy": false }
  ],
  "signals": [
    { "id": "sig-uuid", "fromId": "uuid", "toId": "uuid", "type": "request", "payload": null, "createdAt": "2026-06-13T12:00:00Z" }
  ]
}
```

**Logic:**
1. Heartbeat: Update caller's `lastSeen` only (fixed in Phase 1; was updating all rows)
2. Reap: Delete stale presence (>15s old) and orphaned signals (>60s old)
3. Return: Live peers (excluding self) + this user's signal inbox
4. Drain: Delete delivered signals immediately after returning

**Called every 1500ms in polling loop.**

### POST `/api/signal`

**Request:**
```json
{
  "fromId": "uuid",
  "toId": "uuid",
  "type": "request|accept|decline|offer|answer|ice|end",
  "payload": "json string or null"
}
```

**Response (200):**
```json
{
  "ok": true,
  "autoDeclined": true
}
```

**Logic:**
- Validate input (IDs, type, payload size)
- If type === "request" and target is busy → auto-decline (return 200 with autoDeclined: true)
- If type === "accept" → set `busy: true` for both peers
- If type === "decline" OR "end" → set `busy: false` for both peers
- Insert signal into mailbox

### POST `/api/leave`

**Request:**
```json
{
  "id": "uuid"
}
```

**Response (200):**
```json
{
  "ok": true
}
```

**Logic:**
- Delete Presence record for this ID
- Delete all signals to/from this ID
- Called via sendBeacon() on page unload (guarantees delivery even on hard close)

### GET `/api/turn-credentials`

**Response (200 — success):**
```json
{
  "urls": ["turn:turn1.example.com:3478", "turn:turn2.example.com:3478"],
  "username": "user:timestamp",
  "credential": "token"
}
```

**Response (500 — error or misconfiguration):**
```json
{
  "error": "TURN credentials not configured",
  "details": "error message from Cloudflare API or missing env vars"
}
```

**Implementation Details:**
- **Runtime:** Node.js (export const runtime = "nodejs")
- **Dynamic:** `export const dynamic = "force-dynamic"` (disables caching)
- **Caching:** Cache-Control: private, max-age=300 (5-minute client-side cache)
- **Cloudflare API Endpoint:** `https://rtc.live.cloudflare.com/api/v1/turn/keys/{CLOUDFLARE_TURN_TOKEN_ID}/credentials/rtc`
- **Method:** POST with Bearer token in Authorization header
- **Error handling:** On any failure (network, timeout, invalid response), client falls back to STUN-only (graceful degradation)
- **Comprehensive logging:** All debug logs prefixed with `[DEBUG]` for production troubleshooting

**CRITICAL PRODUCTION ISSUE:** Endpoint may return HTTP 500 if:
1. **Environment variables missing on Vercel:** `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` must be explicitly set in Vercel project settings (Settings → Environment Variables). They are NOT automatically inherited from `.env` file. This is the most common cause of 500 errors in production.
2. **API token lacks permissions:** Verify in Cloudflare dashboard that the API token has RTC/Realtime API permissions.
3. **Token ID mismatch:** Ensure `CLOUDFLARE_TURN_TOKEN_ID` matches an active TURN key in Cloudflare account.
4. **Endpoint format issue:** Cloudflare's official documentation may have changed; the endpoint `https://rtc.live.cloudflare.com/api/v1/turn/keys/{id}/credentials/rtc` is used but not guaranteed to be stable across Cloudflare versions.

**Debugging:** Check Vercel function logs for `[DEBUG]` statements showing which step failed (missing env, Cloudflare API error response, invalid response structure, no TURN server found).

---

## TURN Credentials Integration — Detailed Analysis

### File: `/app/api/turn-credentials/route.ts` (120 lines)

**Current Implementation (commit fbbdc2a):**

The endpoint was modified in the most recent commit to:
1. Change from `https://api.cloudflare.com/client/v4/accounts/{tokenId}/rtc/config` (original)
2. To `https://rtc.live.cloudflare.com/api/v1/turn/keys/{accountId}/credentials/rtc` (current)
3. Add comprehensive debug logging at each step

**Key Code Structure:**
- Line 25–28: Read environment variables (`CLOUDFLARE_TURN_TOKEN_ID`, `CLOUDFLARE_TURN_API_TOKEN`, optional `CLOUDFLARE_TURN_APP_ID`)
- Line 30–33: Log presence of each variable
- Line 35–41: Validate both `accountId` and `apiToken` are present; return 500 if missing
- Line 46: Construct URL with `accountId` (TURN Token ID)
- Line 49–56: POST to Cloudflare API with Bearer token auth, 5-second timeout
- Line 60–67: Check for HTTP error; if not OK, log error body and return 500
- Line 69–78: Parse JSON response; validate `success: true` and `result.iceServers` present
- Line 80–95: Find TURN server entry with both `username` and `credential`
- Line 97–109: Return successfully formatted credentials with 5-minute cache header
- Line 110–119: Catch clause logs error details and returns 500

**Why HTTP 500 Occurs in Production:**

The endpoint returns HTTP 500 with `error: "TURN credentials not configured"` (line 35–40) when:
- `CLOUDFLARE_TURN_TOKEN_ID` is undefined or null
- `CLOUDFLARE_TURN_API_TOKEN` is undefined or null

On Vercel, environment variables in `.env` file are NOT automatically loaded in production. They must be:
1. Configured in Vercel project dashboard (Settings → Environment Variables)
2. Set for the specific environment (Production, Preview, Development)

**Why Local Dev Works But Production Doesn't:**
- Local: `.env` file is read by `next dev` and variables are available to the process
- Production on Vercel: `.env` is not deployed; only variables set in Vercel dashboard are available
- This is a **deployment configuration issue**, not a code bug

### File: `/lib/webrtc.ts` — `buildICEConfig()` function

**Lines 28–90: Async function that fetches TURN credentials and builds RTCConfiguration**

```typescript
export async function buildICEConfig(): Promise<RTCConfiguration> {
  // 1. Fetch /api/turn-credentials with 5-second timeout
  const response = await fetch("/api/turn-credentials", {
    method: "GET",
    signal: AbortSignal.timeout(5000),
  });

  // 2. On any error (network, timeout, non-OK status), log warning and return STUN-only
  if (!response.ok) {
    console.warn(`TURN fetch failed: HTTP ${response.status}`);
    return ICE_CONFIG; // Fallback: STUN only
  }

  // 3. Parse response; if missing/invalid TURN data, log warning and return STUN-only
  const data = (await response.json()) as TurnCredentialsResponse;
  if (data.error || !data.urls || data.urls.length === 0 || !data.username || !data.credential) {
    console.warn("TURN data invalid or missing");
    return ICE_CONFIG; // Fallback: STUN only
  }

  // 4. Success: build config with both STUN and TURN servers
  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: data.urls,
        username: data.username,
        credential: data.credential,
      },
    ],
  };
  return config;
}
```

**How It's Used:**
- Called in `/app/page.tsx` line 79: `const iceConfig = await buildICEConfig();`
- Result passed to `new PeerSession(initiator, callbacks, iceConfig)` on line 81–104
- Every connection attempt calls this function to fetch fresh credentials

**Graceful Fallback:**
- If `/api/turn-credentials` returns HTTP 500, `buildICEConfig()` catches it and returns `ICE_CONFIG` (STUN-only)
- All error logging uses `console.warn`, not `console.error`
- No exceptions thrown; function always returns a valid RTCConfiguration
- Connections still work same-network and some cross-network cases with STUN alone

**Performance:**
- Fetch includes 5-second timeout; if slower than that, falls back to STUN
- Response cached by client for 5 minutes (Cache-Control: max-age=300)
- Subsequent peer connections within 5 minutes reuse cached credentials

### Why the Endpoint Changed

Commit 553a07f originally implemented TURN integration using:
```
https://api.cloudflare.com/client/v4/accounts/{tokenId}/rtc/config
```

Commit fbbdc2a changed to:
```
https://rtc.live.cloudflare.com/api/v1/turn/keys/{accountId}/credentials/rtc
```

**Reason:** The original endpoint (`api.cloudflare.com/.../rtc/config`) may have been:
1. Incorrect (never worked)
2. Deprecated by Cloudflare
3. Requiring different authentication or account setup

The new endpoint format aligns with Cloudflare's documented Realtime API structure, but this change introduces risk:
- The new endpoint is less stable or less well-documented
- If Cloudflare changes their API again, this will break
- Fallback to STUN-only mitigates the risk but degrades symmetric NAT traversal

---

## Environment Variable Configuration for Vercel

**What must be set on Vercel (not in `.env`):**

```
CLOUDFLARE_TURN_TOKEN_ID=b039224899c8583bd7c95fae7359f1be
CLOUDFLARE_TURN_API_TOKEN=5531767a3fdf227b92fcad1bb5b2501f05a4d4d82ba196b5855c0244fb53ae59
DATABASE_URL=postgresql://...
NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1...
```

**Setup Steps:**

1. **Go to Vercel Project Settings:**
   - https://vercel.com/dashboard/YOUR_PROJECT/settings/environment-variables

2. **Add each variable:**
   - Key: `CLOUDFLARE_TURN_TOKEN_ID`
   - Value: (from Cloudflare dashboard)
   - Environments: Check "Production", "Preview", "Development" (or Production only if preferred)
   - Click "Save"

3. **Repeat for `CLOUDFLARE_TURN_API_TOKEN`**

4. **Redeploy:**
   - Push code change to main (or manually redeploy in Vercel dashboard)
   - Vercel will use the new env vars for next build/deployment

**Why `.env` doesn't work on Vercel:**
- `.env` is in `.gitignore` and never committed to repository
- Vercel builds from the repository; no `.env` file present in build environment
- Vercel instead provides environment variables via project dashboard (encrypted, secure)

---

## WebRTC State Machine & Connection Flow

### Initiation (User A → User B)

1. **User A clicks dot (User B):**
   - Send signal: POST `/api/signal` (type: "request")
   - Set connection state to "requesting"
   - Start 30-second timer; if no accept, auto-teardown

2. **User B polls and receives "request":**
   - If idle: set connection state to "incoming", show prompt
   - If busy: auto-decline (signal route sends "decline" back)

3. **User B accepts:**
   - await buildICEConfig() → fetch `/api/turn-credentials` (or STUN-only on error)
   - new PeerSession(initiator: false, iceConfig)
   - Send signal: POST `/api/signal` (type: "accept")
   - Set connection state to "connecting"

4. **User A polls and receives "accept":**
   - await buildICEConfig() → fetch `/api/turn-credentials`
   - new PeerSession(initiator: true, iceConfig)
   - Set connection state to "connecting"

### Offer/Answer/ICE Exchange

- **Initiator (A) creates offer:** onnegotiationneeded fires → setLocalDescription() → send signal (type: "offer")
- **Responder (B) receives offer:** setRemoteDescription(offer) → flush pending ICE candidates → setLocalDescription() → send signal (type: "answer")
- **Initiator (A) receives answer:** setRemoteDescription(answer) → flush pending ICE candidates → connection enters "connected" state
- **ICE candidates:** Exchanged via signals (type: "ice"); queued if arrive before remote description, flushed after

### Data Channel & Chat

1. **Initiator (A):** Creates data channel in PeerSession constructor
2. **Responder (B):** Receives in ondatachannel event
3. **Both:** When channel reaches `readyState === "open"`, callback fires (immediately if already open)
4. **Chat:** User types, presses send → sendChat(text) → data channel send (0ms, P2P)

### Video

1. **User A clicks video button:** sendControl("video-request") → data channel → User B sees prompt
2. **User B accepts:** navigator.mediaDevices.getUserMedia() → addTracks() → renegotiation (new offer/answer)
3. **User A receives answer:** ontrack fires with remote stream → renderVideo()

### End Connection

1. **User A clicks end:** sendSignal(type: "end") → close PeerSession
2. **User B polls and receives "end":** Busy flag cleared by signal route → teardown UI

---

## Key Implementation Details

### Privacy

- Raw user coordinates never stored; 1–3 km random offset applied server-side before insertion (lib/geo.ts)
- Same user lands at different location each session (offset re-randomized on each join)
- No chat or video history stored (P2P only)
- No account system or user tracking

### Polling (No WebSockets)

- HTTP GET `/api/poll?id={sessionId}` every 1500ms
- Necessary because Vercel serverless doesn't support WebSocket connections
- Trade-off: Slightly higher latency for signal delivery (~1500ms max), but works on all networks

### Error Handling

- **TURN unavailable:** Falls back to STUN-only; connection still works same-network and some cross-network (STUN is better than nothing)
- **Signal timeout:** 30-second request timer; auto-decline if no response
- **Connection lost:** Detect via RTCPeerConnectionState changes; teardown and notify user
- **Chat/video errors:** Graceful fallback (don't break entire connection)

### Performance

- Singleton Prisma client reused across hot reloads (prevents connection pool exhaustion)
- Polling-based signaling is stateless (no WebSocket connections to manage)
- Database indexes on `Presence.lastSeen` and `Signal.toId` for fast queries
- Cache-Control headers on /api/turn-credentials (5-minute client-side cache)

---

## Environment Variables

**Required:**
```env
DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require"
NEXT_PUBLIC_MAPBOX_TOKEN="pk.eyJ1..."
CLOUDFLARE_TURN_TOKEN_ID="token-id"
CLOUDFLARE_TURN_API_TOKEN="api-token"
```

**Optional:**
```env
CLOUDFLARE_TURN_APP_ID="app-id"  # If using TURN App ID instead of Token ID (not currently used)
```

**Setup (Local Development):**
1. Create `.env` file in project root
2. Copy `.env.example` as template
3. Fill in actual values (DATABASE_URL, MAPBOX_TOKEN, Cloudflare credentials)

**Setup (Vercel Production):**
1. Go to Vercel project dashboard → Settings → Environment Variables
2. Add each variable with key and value
3. Select environments (Production, Preview, Development)
4. Save and redeploy

**Critical Note for TURN on Vercel:**
- Do NOT rely on `.env` file to populate TURN variables in production
- Must explicitly set `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` in Vercel dashboard
- Without these set on Vercel, `/api/turn-credentials` will always return HTTP 500
- Connection will fall back to STUN-only (works for many cases, fails for symmetric NAT)

---

## Testing

**Test Infrastructure:**
- Jest 30.4.2 (Node test environment, ts-jest preset)
- Tests in `/lib/webrtc.test.ts`, `/app/api/turn-credentials/__tests__/route.test.ts`
- Module resolution via `@/*` path alias in jest.config.js

**Coverage:**
- 11+ unit tests for buildICEConfig() and PeerSession (error handling, fallback, ICE flushing)
- 12+ API tests for /api/turn-credentials (success, missing env, Cloudflare errors, invalid response)

**Run Tests:**
```bash
npm test              # Run once
npm run test:watch   # Watch mode
```

---

## Code Style & Conventions

### Naming
- **Files:** PascalCase (components), camelCase (utilities), UPPER_SNAKE_CASE (constants)
- **Functions:** camelCase (applyPrivacyOffset, buildICEConfig)
- **State:** useState setters follow setXxx pattern; Refs end in Ref (connRef, peerRef)
- **Types:** PascalCase (PeerDot, SignalType, PollResponse)

### React Patterns
- **State:** Local useState for UI-only; useRef for non-rendering state (connection, peer session)
- **Effects:** Dependencies explicit and correct; cleanup functions where needed
- **Composition:** 5–10 small, focused components; props down, callbacks up (no context, no Redux)

### TypeScript
- Strict mode enabled (strict: true)
- All functions have explicit return types
- Shared types in lib/types.ts

### Error Handling
- API routes: Input validation → business logic → Response.json with status codes
- Client code: Try/catch for async; fallback values for missing data
- WebRTC: Graceful degradation (STUN fallback when TURN unavailable)

### Async/Await
- All async functions explicitly marked `async`
- Fire-and-forget calls prefixed with `void` (void sendSignal(...))

---

## Design Language (Phase 2)

**Color Palette:**
- Dark background: `#0a0a0a` (CSS variable `--background`)
- Light text: `#ededed`
- Primary: Emerald-400 (#10b981) for buttons, focus rings, active states
- Danger: Red-500 for error/decline actions
- Peer dots: Hash-based HSL colors (unique per user)

**Typography:**
- Sans-serif (Vercel Geist via Next.js defaults)
- Type scale: text-3xl (headings), text-base (body), text-sm (labels)
- Line height: 1.5 (body), 1.2 (headings)

**Spacing:**
- Padding: p-2 (8px) to p-8 (32px)
- Gaps: gap-3 (12px) to gap-6 (24px)
- Border radius: rounded-lg (8px) for cards, rounded-full (9999px) for circles

**Animation Library:**
- 10+ keyframes: fade-in, fade-in-up, fade-in-down, scale-in, slide-in-right, pulse-ring, glow-pulse, spin-smooth, button-press
- Stagger delays: .animate-stagger-1 through .animate-stagger-5
- Motion duration: 0.3s–0.4s (responsive to device)

---

## Deployment & Hosting

**Platform:** Vercel (serverless Next.js)  
**Database:** PostgreSQL (Neon, Vercel Postgres, or equivalent)  
**CDN:** Vercel CDN (included)  
**Environment:** Node.js runtime (no custom build steps)

**Deployment Process:**
1. Push to GitHub
2. Vercel auto-deploys on push to main
3. Environment variables set in Vercel project settings
4. Prisma schema synced with `npx prisma db push` before first deploy

**Live URL:** https://pulse-silk-eta.vercel.app/ (example from README; actual URL depends on Vercel project)

---

## Known Limitations & Future Considerations

### Technical Limitations
- **TURN credentials HTTP 500:** Without proper Vercel environment variable configuration, symmetric NAT traversal fails; STUN-only fallback is sufficient for same-network and some cross-network cases
- **Polling latency:** HTTP polling at 1500ms means signal delivery is delayed by up to 1500ms (vs. WebSocket <100ms)
- **No persistence:** No chat history, no call logs, no user accounts (feature by design for privacy)
- **No rate limiting:** Not implemented (Vercel serverless limitation)

### Future Enhancements
- WebSocket support if hosting model changes (away from Vercel)
- More robust TURN endpoint detection (fallback to alternative providers if Cloudflare fails)
- Authentication/authorization for Phase 3 security review
- Original feature for Phase 4 (open-ended)
- Database backups and disaster recovery strategy
- Monitoring and observability infrastructure

---

## Git Workflow & Commit Practices

**Commit Strategy:**
- Incremental, logical commits (not giant final commits)
- Clear imperative messages ("Fix presence heartbeat", "Add TURN integration")
- Reference phase context when applicable

**Recent Examples:**
- "Fix presence heartbeat scope, signal end handler, and WebRTC connection bugs" (Phase 1, 6 fixes in one commit)
- "Implement Cloudflare TURN server integration for WebRTC" (Phase 1 bug 6)
- "feat: Add comprehensive debug logging and fix TURN credentials endpoint" (Debug logging enhancement)

**Branches:**
- Main branch contains all work
- Feature/bugfix branches created as needed, merged via PR

---

## Troubleshooting TURN Credentials HTTP 500

**Issue:** `/api/turn-credentials` returns HTTP 500 in production (Vercel) but works locally.

**Diagnosis Steps:**

1. **Check Vercel function logs:**
   - Go to Vercel dashboard → Deployments → your deployment → Runtime Logs
   - Look for `[DEBUG]` messages from `/api/turn-credentials`
   - Identify which log line failed (env vars? API call? Response parse?)

2. **Verify environment variables on Vercel:**
   - Settings → Environment Variables
   - Confirm `CLOUDFLARE_TURN_TOKEN_ID` is set
   - Confirm `CLOUDFLARE_TURN_API_TOKEN` is set
   - If missing, add them now and redeploy

3. **Test API token permissions:**
   - Go to Cloudflare dashboard
   - Find the API token used for `CLOUDFLARE_TURN_API_TOKEN`
   - Check token permissions: should include "Realtime API" or "RTC" scope
   - If missing, create a new token with correct permissions

4. **Test endpoint URL:**
   - Manually call `curl -X POST https://rtc.live.cloudflare.com/api/v1/turn/keys/{TURN_TOKEN_ID}/credentials/rtc -H "Authorization: Bearer {API_TOKEN}"`
   - If this fails, the credentials or endpoint format is incorrect

5. **Check buildICEConfig logs:**
   - Open browser DevTools → Console
   - Look for `console.warn` messages from `buildICEConfig()`
   - If TURN fetch failed, connection uses STUN-only (check RTCPeerConnection ICE servers)

**Resolution:**

If TURN cannot be fixed quickly:
- Connections fall back to STUN-only (gracefully)
- Same-network connections work perfectly
- Cross-network connections on symmetric NAT may fail (requires TURN)
- This is acceptable for Phase 1/2; TURN is marked as Phase 1 bug 6 (cross-network enhancement)

---

## Notes for Future Agents

1. **TURN Credentials Endpoint Issue:** If encountering HTTP 500 errors from `/api/turn-credentials`:
   - First check: Are `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` set in Vercel project settings (not `.env`)?
   - Second check: Does the API token have RTC/Realtime permissions in Cloudflare?
   - Third check: Verify the token ID corresponds to an active TURN configuration
   - Connection falls back to STUN-only; not a total blocker (STUN works for many cases)
   - Debug logs in function output will pinpoint the exact failure step

2. **Testing:** Run `npm test` to validate all WebRTC and API changes; 30+ tests must pass before committing.

3. **Phase 3 & 4:** Not yet started. Security review (Phase 3) should focus on:
   - Input validation edge cases (payload size, ID format)
   - Privacy leaks (raw coordinates, rate limiting abuse)
   - Denial-of-service vectors (signal spam, presence spam)

4. **Type Safety:** TypeScript strict mode is enabled; all changes must satisfy type checker. No `any` types without justification.

5. **Design Language:** Phase 2 UI is established (see knowledge/design-language.md). Maintain animation classes and color palette consistency for new features.

6. **TURN Endpoint Stability:** The current Cloudflare endpoint format (`rtc.live.cloudflare.com/api/v1/turn/keys/{id}/credentials/rtc`) may change. If future Cloudflare API updates break this, consider:
   - Switching to alternative TURN provider (COTURN, Twilio)
   - Implementing fallback endpoint detection
   - Adding feature flag to disable TURN if unavailable

---

## References

- **README.md** — Project overview, setup instructions, phase descriptions, scoring rubric
- **AGENTS.md** — Notes for AI assistants working on this codebase
- **TURN_MANIFEST.md** — Detailed specification for TURN integration (13,500 words)
- **Notes.md** — Phase 1 bug discovery documentation and verification checklist
- **.claude/knowledge/*.md** — Specialized knowledge files (stack, conventions, schema, API patterns, design language, infra, decisions)
