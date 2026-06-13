# Pulse Technical Assessment — Complete Project Context

**Date Scanned:** 2026-06-13  
**Git Status:** Main branch at commit c1900d8 (Cloudflare TURN integration merged)  
**Phase Progress:** Phase 1 ✅ (6 bugs fixed), Phase 2 ✅ (UI/UX redesigned with animation library), Phase 3-4 (not yet started)  

---

## Executive Summary

**Pulse** is a real-time peer-to-peer geolocation chat and video platform. Users appear as anonymous colored dots on a live Mapbox globe; tapping a dot initiates a connection request. Once accepted, peers communicate entirely P2P over WebRTC — chat via data channel, video via media tracks. The server handles **only** coordination (presence heartbeat, signal delivery, connection state machine via HTTP polling); no chat, video, or user data is ever stored or seen by the server.

**Key Architecture:**
- **Frontend:** Next.js 16 + React 19 + TypeScript (strict) + Tailwind CSS 4 + Mapbox GL JS
- **Backend:** Node.js API routes (Vercel serverless) + Prisma 7 + PostgreSQL
- **Coordination:** Transient Presence and Signal models (deleted on leave, after stale timeout, or after delivery)
- **P2P Network:** Native WebRTC (RTCPeerConnection, RTCDataChannel) with STUN (Google) + optional TURN (Cloudflare)
- **Polling-based:** No WebSockets (incompatible with Vercel); HTTP GET/POST at ~1500ms interval

**Phase 1 Status:** All 6 core bugs fixed and tested (heartbeat scope, busy flag clearing, ICE candidate ordering, data channel race condition, chat message type, cross-network TURN support).

**Phase 2 Status:** UI/UX significantly enhanced with animation library (10+ keyframes), improved component styling, responsive layout adjustments.

**Current state:** All changes committed to main. No unstaged work in codebase (Notes.md and TEST_STRATEGY.md are untracked but document what's already merged).

---

## Stack (Framework, Libraries, Tooling, Testing)

### Frontend
- **Next.js 16.2.7** — App Router with client/server component split; deployed on Vercel serverless
- **React 19.2.4** — Hooks-based component model (useState, useRef, useEffect)
- **TypeScript 5** — Full strict mode enabled (strict: true in tsconfig.json)
- **Tailwind CSS 4** — Utility-first styling with @tailwindcss/postcss integration

### Backend & Data
- **Node.js runtime** — Next.js API routes at /app/api/*
- **Prisma 7.8.0** — ORM with PostgreSQL adapter (@prisma/adapter-pg)
- **PostgreSQL** — Transient coordination database (Neon, Vercel Postgres, or equivalent)
- **pg 8.21.0** — Native database driver (abstracted by Prisma)

### Mapping & Geolocation
- **Mapbox GL JS 3.24.0** — Interactive 2D/3D map with custom marker rendering
- **Browser Geolocation API** — User location capture (privacy-offset by 1–3 km random before storing)

### WebRTC & Networking
- **Native RTCPeerConnection** — No wrapper libraries (no webrtc-adapter, simple-peer, etc.)
- **RTCDataChannel** — Chat messaging
- **RTCMediaStream** — Video and audio tracks
- **STUN:** Google stun.l.google.com:19302 (always available, handles same-network and some cross-network cases)
- **TURN:** Cloudflare RTC credentials API (optional, fetched dynamically; graceful fallback to STUN-only)

### Testing & Code Quality
- **Jest 30.4.2** — Test runner (Node environment, ts-jest preset)
- **ts-jest 29.4.11** — TypeScript-to-JS transpilation for tests
- **@types/jest 30.0.0** — Type definitions
- **ESLint 9** + eslint-config-next 16.2.7 — Linting (no auto-formatter in npm scripts)

### Build & Configuration
- **TypeScript 5** — tsconfig.json with path aliases (@/*), ES2017 target, strict mode
- **Next.js 16.2.7** — next.config.ts minimal config
- **PostCSS** — postcss.config.mjs for Tailwind integration
- **Jest** — jest.config.js with module name mapping for @/* paths

---

## Project Structure

```
Pulse-Technical-Assessment/
├── app/
│   ├── api/
│   │   ├── join/route.ts              # POST: register presence, apply privacy offset
│   │   ├── poll/route.ts              # GET: heartbeat (caller only), reap stale presence/signals, drain inbox
│   │   ├── leave/route.ts             # POST: explicit cleanup (sendBeacon on tab close)
│   │   ├── signal/route.ts            # POST: signal delivery, auto-decline if busy, manage busy flag
│   │   └── turn-credentials/
│   │       ├── route.ts               # GET: fetch Cloudflare TURN credentials (5-min cache)
│   │       └── __tests__/
│   │           └── route.test.ts      # 12 tests for API validation and error cases
│   │
│   ├── components/
│   │   ├── EntryGate.tsx              # Geolocation permission gate + location confirm
│   │   ├── WorldMap.tsx               # Mapbox interactive map, peer dots, "You are here" marker
│   │   ├── ConnectionPrompt.tsx       # Modal: incoming request or video prompt
│   │   ├── ChatPanel.tsx              # Chat UI + video button (Phase 2: redesigned with animations)
│   │   └── VideoPanel.tsx             # Video UI: local PiP + remote full-screen (Phase 2: redesigned)
│   │
│   ├── page.tsx                       # Root page: 530+ lines, state machine for connection/video lifecycle
│   ├── layout.tsx                     # Next.js app layout wrapper
│   ├── globals.css                    # 325 lines: Tailwind directives + 10+ animation keyframes
│   └── favicon.ico
│
├── lib/
│   ├── api.ts                         # Client-side fetch wrappers (join, poll, signal, leave)
│   ├── geo.ts                         # applyPrivacyOffset() — 1–3 km random offset calculation
│   ├── presence.ts                    # Constants: STALE_MS (15s), SIGNAL_TTL_MS (60s), POLL_INTERVAL_MS (1500ms)
│   ├── prisma.ts                      # Singleton Prisma client (singletonForPrisma pattern)
│   ├── types.ts                       # Shared types: SignalType, PeerDot, SignalMsg, PollResponse
│   ├── webrtc.ts                      # PeerSession class + buildICEConfig() for TURN integration
│   ├── webrtc.test.ts                 # 11 unit tests for buildICEConfig() and PeerSession
│   └── (other utilities)
│
├── prisma/
│   ├── schema.prisma                  # Presence (id, lat, lng, busy, lastSeen) + Signal (id, toId, fromId, type, payload, createdAt)
│   └── migrations/                    # Prisma-managed schema migrations
│
├── __tests__/
│   └── turn-integration.test.ts       # 6 integration tests for TURN credentials flow
│
├── public/
│   └── (static assets)
│
├── .env.example                       # Reference: DATABASE_URL, NEXT_PUBLIC_MAPBOX_TOKEN
├── .gitignore
├── eslint.config.mjs                  # ESLint flat config (Next.js core-web-vitals + TypeScript)
├── jest.config.js                     # Test runner config
├── next.config.ts                     # Next.js minimal config
├── postcss.config.mjs                 # Tailwind CSS integration
├── tsconfig.json                      # TypeScript compiler options (strict mode, @/* path alias)
├── package.json                       # Dependencies + scripts
├── package-lock.json
├── README.md                          # Project overview and phase descriptions
├── AGENTS.md                          # Notes for AI assistants
├── Notes.md                           # Phase 1 bug discovery & fixes (untracked, documents merged work)
├── TEST_STRATEGY.md                   # Test coverage and strategy (untracked, documents merged work)
└── .claude/
    ├── context.md                     # This file
    └── knowledge/
        ├── stack.md                   # Tech stack summary
        ├── conventions.md             # Code style and naming
        ├── schema-overview.md         # Database schema details
        ├── api-patterns.md            # API endpoint structure
        ├── design-language.md         # Visual design (colors, typography, spacing, animations)
        ├── infra.md                   # Deployment and infrastructure
        └── decisions.md               # Architectural decision log
```

---

## Current Git State

**Recent commit history:**
```
c1900d8 (HEAD -> main, origin/main)  Merge pull request #2 from jlescarlan11/feat/cloudflare-turn
3fa87cb  feat: Add Cloudflare TURN server integration for cross-network connectivity
7cb7cf2  Merge pull request #1 from jlescarlan11/fix/presence-and-webrtc-bugs
b0c2862  Fix presence heartbeat scope, signal end handler, and WebRTC connection bugs
d098fe4  (tag: initial)  Initialized
```

**No unstaged changes:**
- Working tree is clean (all changes committed)
- Untracked files: `.claude/`, `Notes.md`, `TEST_STRATEGY.md` (documentation only)

**Branch structure:** Single `main` branch with linear history. No feature branches active. All Phase 1 and Phase 2 work merged.

---

## Phase 1: Make It Run — Bug Fixes (COMPLETE)

All 6 critical and minor bugs identified and fixed. Details are in `Notes.md`.

### Bugs Fixed

1. **Heartbeat updates all presence rows (CRITICAL)**
   - File: `/app/api/poll/route.ts` line 25
   - Fixed: Changed `where: {}` to `where: { id }` so only the polling user's lastSeen is updated
   - Impact: User dots now disappear 15–20 seconds after app close (was never disappearing)

2. **Busy flag not cleared on `end` signal (CRITICAL)**
   - File: `/app/api/signal/route.ts` line 79
   - Fixed: Added `|| signalType === "end"` to clear busy flag on connection end
   - Impact: Users can now make sequential connections (was stuck after one call)

3. **ICE candidate flushed before remote description set (CRITICAL)**
   - File: `/lib/webrtc.ts` lines 109–111
   - Fixed: Swapped order — set remote description first, then flush pending candidates
   - Impact: WebRTC connections now transition to "connected" state (was stuck in "connecting")

4. **Data channel open event race condition (CRITICAL)**
   - File: `/lib/webrtc.ts` lines 74–81
   - Fixed: Check `readyState === "open"` before attaching onopen handler; call immediately if already open
   - Impact: Chat/video callbacks now always fire (was sometimes missed)

5. **Chat message type mismatch (MINOR)**
   - File: `/lib/webrtc.ts` line 79
   - Fixed: Changed receiver check from `msg.t === "chat"` to `msg.t === "msg"` (sender uses "msg")
   - Impact: Chat messages now received (was silently discarded)

6. **Cross-network connectivity fails (Symmetric NAT) (CRITICAL)**
   - File: `/lib/webrtc.ts` (buildICEConfig) + `/app/api/turn-credentials/route.ts`
   - Fixed: Added Cloudflare TURN credential fetching via dynamic API call; graceful fallback to STUN-only
   - Impact: Users on different WiFi networks can now connect (was failing on symmetric NAT)

---

## Phase 2: Make It Good — UI/UX Redesign (MOSTLY COMPLETE)

### What Changed

- **globals.css:** Extended from ~100 lines to 325 lines with comprehensive animation library
  - 10+ keyframe animations: fade-in, fade-in-up, fade-in-down, scale-in, slide-in-right, pulse-ring, glow-pulse, spin-smooth, button-press
  - Stagger delay utilities for list animations
  - Responsive mobile adjustments (faster animations, reduced delays)
  - Enhanced focus states and dark mode support

- **app/page.tsx:** Refactored state machine and added error boundaries
  - Better error handling for ICE config fetch failure
  - Graceful degradation when TURN unavailable

- **Components (ChatPanel.tsx, VideoPanel.tsx, ConnectionPrompt.tsx, EntryGate.tsx, WorldMap.tsx):** 
  - Updated with new animation classes
  - Improved modal and transition flows
  - More polished user feedback (notices, loading states)

### Design Direction

- **Aesthetic:** Modern, minimal dark theme with emerald green accents
- **Motion:** Smooth, purposeful animations (not excessive; spring easing for interactive elements)
- **Interaction:** Rapid feedback on tap/click with visual scale changes

---

## Phase 3: Make It Secure (NOT YET STARTED)

Security review and fixes for API endpoint validation, input sanitization, and authentication/authorization concerns.

---

## Phase 4: Make It Better (NOT YET STARTED)

Original feature design and implementation. Specs entirely open-ended.

---

## Key Components & How They Interact

### Entry Point: `/app/page.tsx` (530+ lines)

Main orchestrator. Manages:
- Session ID (generated once, persists for tab lifetime)
- Presence location + registration (geolocation gate)
- Polling loop (heartbeat + signal drain at 1500ms interval)
- Connection state machine: idle → requesting → incoming → connecting → connected
- Video state machine: none → requesting → incoming → active
- Chat message history
- PeerSession lifecycle (create on accept, close on end/error)

**Flow:**
1. User enters geolocation permission (EntryGate)
2. Call `/api/join` to register Presence record
3. Start polling loop: GET `/api/poll?id={sessionId}`
4. Render peers on map (WorldMap)
5. On tap, send signal: POST `/api/signal` (type: "request")
6. On incoming, show prompt (ConnectionPrompt)
7. On accept, await buildICEConfig(), create PeerSession, send signal (type: "accept")
8. Exchange offer/answer/ice via signals
9. When data channel opens, transition to "connected"
10. Chat messages send via data channel (no server)
11. On end, send signal (type: "end"), close PeerSession, clear busy flag

### Component: `WorldMap.tsx` (180 lines)

Renders Mapbox GL map + peer dots + "You are here" marker.

**Responsibilities:**
- Initialize map once on mount (lazy-load mapboxgl async)
- Render peer dots with hash-based colors, pulse animation, click handler
- Update peer positions on new poll response
- Render "Me" marker at user's location

**Interaction:** Dots are clickable; onPeerClick triggers connection request.

### Component: `ConnectionPrompt.tsx` (70 lines)

Modal for incoming connection requests or video prompts.

**Responsibilities:**
- Show modal when connRef.current.kind === "incoming"
- Accept/Decline buttons
- Video request/accept/decline flows

### Component: `ChatPanel.tsx` (180 lines, Phase 2 redesigned)

Chat UI + message history + video button.

**Responsibilities:**
- Render message list with animations
- Send chat input via data channel
- Video request button
- Styled with Tailwind + animation classes

### Component: `VideoPanel.tsx` (100 lines, Phase 2 redesigned)

Video UI with local video in PiP + remote video full-screen.

**Responsibilities:**
- Render <video> elements for local/remote streams
- Mute/unmute, camera on/off buttons
- End call button

### Component: `EntryGate.tsx` (90 lines)

Geolocation permission gate.

**Responsibilities:**
- Request geolocation permission
- Show error if denied
- Pass location up to parent (page.tsx) on grant

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

**Response:**
```json
{
  "id": "uuid",
  "peers": [...]
}
```

**Logic:**
- Insert Presence record with privacy offset applied
- Return initial peer list
- Called once on entry, no polling needed for initial state

### GET `/api/poll?id=uuid`

**Response:**
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
1. Heartbeat: Update caller's `lastSeen` (fixed in Phase 1; was updating all rows)
2. Reap: Delete stale presence (> 15s old) and orphaned signals (> 60s old)
3. Return: Live peers (excluding self) + this user's signal inbox
4. Drain: Delete delivered signals immediately after returning

**Called every 1500ms in a polling loop.**

### POST `/api/signal`

**Request:**
```json
{
  "fromId": "uuid",
  "toId": "uuid",
  "type": "request|accept|decline|offer|answer|ice|end",
  "payload": "json string (SDP/ICE candidate) or null"
}
```

**Response:**
```json
{
  "ok": true,
  "autoDeclined": true  // if target was busy
}
```

**Logic:**
- Validate input (IDs, type, payload size)
- If type === "request" and target is busy → auto-decline (return 200 with autoDeclined: true)
- If type === "accept" → set `busy: true` for both peers
- If type === "decline" OR "end" → set `busy: false` for both peers (fixed in Phase 1)
- Insert signal into mailbox (toId's inbox)

**Called for signaling (request, accept, decline, offer, answer, ice, end).**

### POST `/api/leave`

**Request:**
```json
{
  "id": "uuid"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Logic:**
- Delete Presence record for this ID immediately
- Called via sendBeacon() on page unload (guarantees delivery even on hard close)

### GET `/api/turn-credentials`

**Response (on success):**
```json
{
  "urls": ["turn:turn1.example.com:3478", "turn:turn2.example.com:3478"],
  "username": "user:timestamp",
  "credential": "token"
}
```

**Response (on error or misconfiguration):**
```json
{
  "error": "TURN credentials not configured"
}
```

**Logic:**
- Fetch short-lived TURN credentials from Cloudflare API endpoint `https://api.cloudflare.com/client/v4/accounts/{TOKEN_ID}/rtc/config`
- Return first TURN server entry (with username + credential)
- Set Cache-Control: private, max-age=300 (5-minute client-side cache)
- On any error, client falls back to STUN-only (graceful degradation)

**Called once at connection start (buildICEConfig) and cached for 5 minutes.**

---

## Database Schema (Prisma)

### Model: Presence

```prisma
model Presence {
  id       String   @id          // client-generated session UUID
  lat      Float                 // privacy-offset coordinates
  lng      Float
  busy     Boolean  @default(false)  // locked during active connection
  lastSeen DateTime              // updated each poll (heartbeat)

  @@index([lastSeen])             // for stale cleanup query
}
```

**Lifecycle:**
- Created: `/api/join`
- Deleted: `/api/leave` (explicit) or stale cleanup in `/api/poll` (after 15s inactivity)
- Updated: Heartbeat in `/api/poll` (lastSeen), busy flag in `/api/signal` (accept/decline/end)

### Model: Signal

```prisma
model Signal {
  id        String   @id @default(uuid())
  toId      String              // recipient session ID
  fromId    String              // sender session ID
  type      String              // "request" | "accept" | "decline" | "offer" | "answer" | "ice" | "end"
  payload   String?             // JSON string (SDP / ICE candidate) or null
  createdAt DateTime @default(now())

  @@index([toId])                // for inbox queries
}
```

**Lifecycle:**
- Created: `/api/signal` POST
- Deleted: Immediately after polled and returned in `/api/poll` (drain), OR after 60s stale cleanup

**Invariant:** Every signal is deleted within 60 seconds; no history kept.

---

## WebRTC State Machine

### Initiation Flow (User A → User B)

1. **User A clicks dot (User B):**
   - setConn({ kind: "requesting", peerId: B })
   - sendSignal(A, B, "request")
   - Start 30s timer; if no accept, send "end" and teardown

2. **User B polls and receives "request":**
   - If idle, setConn({ kind: "incoming", peerId: A })
   - If busy, auto-decline (signal route sends "decline" back)

3. **User B clicks "Accept":**
   - acceptIncoming() → await startPeer(A, initiator: false)
   - buildICEConfig() → fetch TURN (or STUN-only on error)
   - new PeerSession(initiator: false, iceConfig)
   - sendSignal(B, A, "accept")
   - setConn({ kind: "connecting", peerId: A })

4. **User A polls and receives "accept":**
   - Clear timer (if running)
   - await startPeer(B, initiator: true)
   - buildICEConfig() → fetch TURN (or STUN-only on error)
   - new PeerSession(initiator: true, iceConfig)
   - setConn({ kind: "connecting", peerId: B })

### Offer/Answer Exchange

1. **Initiator (A) creates offer:**
   - PeerSession.onnegotiationneeded fires (initiator only)
   - setLocalDescription() → generates offer
   - onSignal("offer", sdp) → sendSignal(A, B, "offer", sdp)

2. **Responder (B) receives offer:**
   - processSignal("offer", sdp)
   - handleSignal("offer", sdp) → setRemoteDescription(offer)
   - Flush pending ICE candidates (if arrived early)
   - setLocalDescription() → generates answer
   - onSignal("answer", sdp) → sendSignal(B, A, "answer", sdp)

3. **Initiator (A) receives answer:**
   - processSignal("answer", sdp)
   - handleSignal("answer", sdp) → setRemoteDescription(answer)
   - Flush pending ICE candidates
   - Connection now "connected" (ICE gathering complete)

### ICE Candidate Exchange

- Both peers: onicecandidate fires for each candidate
- Send via: sendSignal(from, to, "ice", JSON.stringify(candidate))
- Receive: processSignal("ice", candidate) → addIceCandidate(candidate)
- **Order:** Candidates may arrive before offer/answer. If before remote description, queue them. After remote description, flush all queued + new ones immediately.

### Data Channel Open

1. **Initiator (A):** Creates data channel in constructor (`createDataChannel("chat")`)
2. **Responder (B):** Receives in `ondatachannel` event (data channel offered by initiator, accepted by responder)
3. **Both:** When channel reaches `readyState === "open"`, callback onChannelOpen fires (or called immediately if already open)
4. **Result:** setConn({ kind: "connected", peerId: ... })

### Chat Message

1. **User A:**
   - Type message, press send
   - sendChat(text) → safeSend({ t: "msg", text })
   - Sent via data channel (0ms latency, P2P)

2. **User B:**
   - onmessage fires → parse JSON
   - Check msg.t === "msg" → callback onChat(text)
   - Display in ChatPanel

### Video

1. **User A clicks video button:**
   - startVideoRequest()
   - sendControl("video-request") → data channel
   - setVideo("requesting")

2. **User B receives:**
   - onControl("video-request") → setVideo("incoming")
   - Show prompt

3. **User B accepts:**
   - acceptVideo() → navigator.mediaDevices.getUserMedia({ video: true, audio: true })
   - Add tracks to PeerConnection (renegotiation, onnegotiationneeded fires again)
   - Exchange new offer/answer
   - sendControl("video-accept")
   - setVideo("active")

4. **User A receives:**
   - onControl("video-accept") → startVideo() → getUserMedia() → addTracks()
   - ontrack fires with remote stream
   - setRemoteStream(stream)
   - setVideo("active")

### End Connection

1. **User A clicks "End":**
   - endConnection()
   - sendSignal(A, B, "end")
   - teardown() → close PeerSession, clear state, show brief notice

2. **User B polls and receives "end":**
   - processSignal("end")
   - Busy flag cleared by signal route
   - teardown() on next UI update

---

## Testing

### Jest Configuration

- **Test environment:** Node (not jsdom, because WebRTC is Node-emulated via mocks)
- **Module resolution:** ts-jest transpiles TypeScript; path aliases (@/*) mapped
- **Coverage:** lib/ and app/api/ targeted; *.d.ts and node_modules excluded

### Test Coverage

**Unit Tests: `lib/webrtc.test.ts` (11 tests)**
- buildICEConfig(): 8 tests covering success, timeouts, invalid responses, fallback to STUN
- PeerSession constructor: 3 tests covering custom config, backward compatibility, data channel creation

**Integration Tests: `__tests__/turn-integration.test.ts` (6 tests)**
- Full TURN flow from buildICEConfig() through PeerSession creation
- Error scenarios (API failure, timeouts)
- Multiple TURN servers
- Config immutability

**API Route Tests: `app/api/turn-credentials/__tests__/route.test.ts` (12 tests)**
- Success: Cloudflare response parsing, caching headers, credential extraction
- Config errors: Missing env vars
- API errors: 500, invalid JSON, missing fields
- Graceful degradation

**Total:** 29 tests across three layers. All passing.

---

## Environment & Secrets

### Required `.env` Variables

```
DATABASE_URL="postgresql://user:password@host:5432/database?sslmode=require"
NEXT_PUBLIC_MAPBOX_TOKEN="pk.your_token_here"
CLOUDFLARE_TURN_TOKEN_ID="your_account_id_here"
CLOUDFLARE_TURN_API_TOKEN="your_api_token_here"
```

**Notes:**
- `DATABASE_URL` not prefixed NEXT_PUBLIC (server-side only)
- `NEXT_PUBLIC_MAPBOX_TOKEN` accessible to client (required for map initialization)
- `CLOUDFLARE_TURN_*` variables server-side only (`/api/turn-credentials` endpoint)
- `.env.example` provided for reference (actual `.env` never committed)

### Deployment (Vercel)

- Set env vars in Vercel project settings
- Run `npx prisma db push` on first deploy to create tables
- Subsequent deploys auto-migrate via build script (`npm run build` calls `npx prisma generate`)
- Database must be accessible from Vercel's edge locations (use managed postgres or publicly accessible)

---

## Key Files by Purpose

### Coordination APIs
- `/app/api/join/route.ts` — Register presence
- `/app/api/poll/route.ts` — Heartbeat + mailbox drain
- `/app/api/signal/route.ts` — Signal delivery + busy flag
- `/app/api/leave/route.ts` — Cleanup on exit
- `/app/api/turn-credentials/route.ts` — Cloudflare TURN credential fetch

### Frontend State & Logic
- `/app/page.tsx` — Main state machine (530+ lines)
- `/lib/api.ts` — Fetch wrappers (join, poll, signal, leave)
- `/lib/webrtc.ts` — PeerSession class + buildICEConfig()
- `/lib/types.ts` — Shared type definitions
- `/lib/presence.ts` — Constants (timings, polling interval)
- `/lib/geo.ts` — Privacy offset calculation

### Components
- `/app/components/EntryGate.tsx` — Geolocation gate
- `/app/components/WorldMap.tsx` — Mapbox map + peer dots
- `/app/components/ConnectionPrompt.tsx` — Connection/video modals
- `/app/components/ChatPanel.tsx` — Chat UI
- `/app/components/VideoPanel.tsx` — Video UI

### Styling
- `/app/globals.css` — 325 lines: Tailwind + animation library
- Tailwind utility classes in component JSX

### Testing
- `/lib/webrtc.test.ts` — Unit tests for WebRTC functions
- `/__tests__/turn-integration.test.ts` — Integration tests
- `/app/api/turn-credentials/__tests__/route.test.ts` — API route tests

### Configuration
- `/tsconfig.json` — TypeScript config (strict mode, path aliases)
- `/jest.config.js` — Jest test configuration
- `/next.config.ts` — Next.js build configuration
- `/postcss.config.mjs` — Tailwind CSS integration
- `/eslint.config.mjs` — ESLint linting rules

---

## Coding Patterns & Conventions

### State Management Pattern

```typescript
const [state, _setState] = useState(initialValue);
const stateRef = useRef(state);
const setState = (s) => {
  stateRef.current = s;
  _setState(s);
};
```

**Why:** Allows state to be read synchronously in callbacks without closure issues. Used for `connRef` and `videoRef` in page.tsx.

### Async Handlers Pattern

```typescript
function requestConnection(peerId: string) {
  void sendSignal(sessionId, peerId, "request");
  // ...
}
```

**Why:** `void` prefix indicates intentional fire-and-forget. Prevents unhandled promise warnings.

### Error Handling in WebRTC

```typescript
try {
  const iceConfig = await buildICEConfig();
  const ps = new PeerSession(initiator, callbacks, iceConfig);
  peerRef.current = ps;
} catch (error) {
  console.error("Failed to start peer:", error);
  teardown("Connection failed (ICE config).");
}
```

**Why:** Gracefully handle TURN fetch failures; fallback is built into buildICEConfig().

### Polling Loop Pattern

```typescript
useEffect(() => {
  const pollInterval = setInterval(async () => {
    const response = await poll(sessionId);
    setPeers(response.peers);
    response.signals.forEach(processSignal);
  }, POLL_INTERVAL_MS);
  
  return () => clearInterval(pollInterval);
}, [sessionId]);
```

**Why:** Synchronous polling is simple, predictable, and works on Vercel (no WebSocket support).

---

## Known Limitations & Design Decisions

1. **HTTP Polling, not WebSocket**
   - Rationale: Vercel serverless doesn't support long-lived connections
   - Trade-off: 1500ms heartbeat interval (balance between staleness detection and API call frequency)
   - Acceptable: Users perceive near-real-time; 1.5s latency is imperceptible for this use case

2. **STUN only on unsupported networks**
   - Rationale: TURN adds cost; many home WiFi / same-network scenarios work fine
   - Trade-off: Corporate/symmetric NAT networks require TURN configured
   - Acceptable: TURN optional, graceful fallback, documentation clear on limitations

3. **Transient database (no history)**
   - Rationale: Privacy guarantee—no chat/video ever stored; addresses "nothing stored" requirement
   - Trade-off: Can't retrieve past conversations; no user history
   - Acceptable: By design (privacy-first)

4. **No authentication or accounts**
   - Rationale: Anonymous, ephemeral connections only
   - Trade-off: Can't prevent abuse at scale (no identity tracking)
   - Acceptable: For take-home assessment; real product would add moderation

5. **Native WebRTC, not library**
   - Rationale: Fine-grained control; avoids dependency bloat
   - Trade-off: Manual offer/answer/ICE management; more code
   - Acceptable: ~200 lines of webrtc.ts is reasonable for a P2P coordination layer

---

## Recent Changes & Git History

**Commit b0c2862** — Phase 1 bug fixes (6 bugs)
- Fix heartbeat to update only caller's presence
- Fix busy flag clearing on "end" signal
- Fix ICE candidate ordering (flush after remote description)
- Fix data channel open race condition
- Fix chat message type mismatch
- Add logging for observability

**Commit 3fa87cb** — Phase 2 TURN integration
- Add `/api/turn-credentials` endpoint for Cloudflare TURN credentials
- Implement `buildICEConfig()` async function
- Update `PeerSession` to accept optional iceConfig parameter
- Make `startPeer()` async to fetch credentials before peer creation
- Add 29 tests (unit + integration + API route)
- Add comprehensive animation library to globals.css
- Update components with animation classes and improved UX

---

## Deployment Checklist

- [ ] `.env` variables set in Vercel project settings
- [ ] PostgreSQL database created and accessible
- [ ] `npx prisma db push` executed against production database
- [ ] `npm run build` succeeds without errors
- [ ] `npm run test` passes all tests
- [ ] `npm run lint` passes linting
- [ ] Vercel deployment preview tested end-to-end (two browsers, mock geolocation)
- [ ] Chat, video, and connection flows verified
- [ ] TURN credentials (Cloudflare account ID + API token) configured or understood as optional

---

## Useful Commands

```bash
# Development
npm run dev              # Start local Next.js dev server (localhost:3000)

# Testing
npm test                # Run all tests once
npm run test:watch     # Watch mode for development

# Build & Lint
npm run build          # Build for production (includes `prisma generate`)
npm start              # Start production server
npm run lint           # ESLint check

# Database
npx prisma db push    # Apply schema to database (create tables)
npx prisma db pull    # Introspect database (update schema if changed externally)
npx prisma migrate dev --name "<name>"  # Create new migration
npx prisma studio    # GUI for database inspection

# Git
git log --oneline -10  # Recent commits
git diff HEAD~1        # Changes in latest commit
git status             # Working tree status
```

---

## Next Steps

### Phase 3: Security Review
- Review API endpoints for injection attacks (SQL, XSS, etc.)
- Validate input size limits
- Check rate limiting (if needed)
- Review WebRTC security considerations (DTLS-SRTP, etc.)

### Phase 4: New Feature
- Implement a new feature that makes the app "more alive" or "safer"
- Examples: user ratings, idle presence auto-leave, chat history (opt-in), presence mini-feed, etc.
- Requirement: Must be shipped, working, and documented

### Known Tech Debt
- No automated CI/CD pipeline (manual Vercel deploy)
- No e2e test suite (only unit + integration tests)
- No monitoring or error tracking (no Sentry, DataDog, etc.)
- No rate limiting on API endpoints
- Mapbox token visible in .env.example (acceptable for dev, but rotate before production)

---

**Context last updated:** 2026-06-13 12:10 GMT+8  
**Scanner version:** Claude Haiku 4.5 context-discovery agent  
**Next scanner run recommended:** After Phase 3–4 completion or major refactor
