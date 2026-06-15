# Architectural Decisions — Pulse Technical Assessment

**Last Updated:** 2026-06-13

Append-only log of architectural decisions, technological choices, and design trade-offs that shaped Pulse. Decisions listed chronologically with rationale.

---

## Entries

### 1. Polling-Based Signaling (No WebSockets)

**Date:** 2026-06-08  
**Decision:** Use HTTP polling (1500ms interval) for WebRTC signaling instead of WebSocket or Server-Sent Events.

**Alternatives Considered:**
- WebSocket connections with persistent server state
- Server-Sent Events (SSE) with polling fallback
- Hybrid: WebSocket with graceful fallback to polling

**Why This Won:**
- **Vercel serverless constraint:** Vercel does not support WebSocket connections on free/pro tiers (requires dedicated server or third-party service)
- **Cost:** Polling is cheaper than maintaining persistent connections
- **Simplicity:** Stateless HTTP GET/POST; no connection state to manage per user
- **Latency trade-off:** 1500ms polling latency is acceptable for connection setup (peers exchange offer/answer within 1–2 polls)
- **Deployment:** Zero deployment complexity; works on any serverless platform

**Implication:** Maximum signal delivery latency is 1500ms. For future scaling beyond 10k users, WebSocket support would require architectural change (migrate away from Vercel or adopt third-party WebSocket provider like Firebase Realtime or Socket.io Cloud).

---

### 2. Transient Database (No Persistence)

**Date:** 2026-06-08  
**Decision:** Store only ephemeral coordination data (Presence, Signal) in PostgreSQL; never persist chat, video, or user metadata.

**Alternatives Considered:**
- Persistent chat history and call logs
- User profiles with saved preferences
- Session recovery (rejoin previous session)
- Encrypted message archive

**Why This Won:**
- **Privacy by design:** No trace of conversations survives session end; comply with privacy-first ethos
- **Simplicity:** No complex data retention policies, GDPR concerns, or deletion requests
- **Cost:** No need for backups, disaster recovery, or long-term storage capacity planning
- **Security:** Minimal attack surface (no sensitive data to steal)
- **Scalability:** Data cleanup automatic (TTL logic in API routes); no manual retention management

**Implication:** Users cannot recover chat history if they reconnect. Calls are ephemeral; no call logs exist. This is a feature, not a limitation.

---

### 3. Native WebRTC (No Libraries)

**Date:** 2026-06-08  
**Decision:** Use raw browser WebRTC APIs (RTCPeerConnection, RTCDataChannel) without wrapper libraries (no simple-peer, webrtc-adapter, etc.).

**Alternatives Considered:**
- simple-peer (high-level API, handles many edge cases)
- webrtc-adapter (standardizes API across browsers)
- PeerJS (full abstraction layer)
- Janus/Kurento (SFU/MCU server)

**Why This Won:**
- **Code clarity:** Raw APIs are well-documented; developers understand exactly what's happening (offer/answer/ICE)
- **Bundle size:** No external dependencies; code footprint minimal
- **Control:** Handle offer/answer negotiation, ICE candidate management, data channel lifecycle explicitly
- **Learning value:** Educational purpose of take-home assessment favors transparency
- **Minimal browser support:** Only modern browsers (Chrome, Safari, Edge, Firefox) needed; no legacy IE compatibility required

**Implication:** Must manually handle offer/answer collisions, ICE candidate queuing, data channel readiness checks. This is handled in `lib/webrtc.ts` with ~300 lines of clear, testable code.

---

### 4. Client-Side Location Privacy Offset

**Date:** 2026-06-08  
**Decision:** Apply 1–3 km random bearing offset to raw user coordinates **on the server** before insertion into database (never store raw coordinates).

**Alternatives Considered:**
- No offset (expose exact location)
- Offset on client, send offset coordinates to server
- Grid-based quantization (round to 1 km grid)
- Server-side offset per API key (same offset for repeated calls)

**Why This Won:**
- **Privacy guarantee:** Raw coordinates inaccessible even if database is breached
- **Server-side logic:** Offset cannot be reversed by client (client never knows offset amount)
- **Randomized:** Each session gets different offset; same user never lands at same location twice
- **User trust:** Transparent privacy model (documented in README)

**Implication:** Users cannot see exact location of peers; dots appear 1–3 km away from actual position. This is acceptable for privacy-first geolocation chat.

---

### 5. Cloudflare TURN for Cross-Network NAT Traversal

**Date:** 2026-06-13  
**Decision:** Integrate Cloudflare Realtime API for TURN server credentials; graceful fallback to STUN-only if unavailable.

**Alternatives Considered:**
- STUN-only (no TURN)
- Self-hosted COTURN server
- Twilio TURN credentials
- AWS Kinesis Video Streams

**Why This Won:**
- **Cost:** Cloudflare TURN included with account (no per-request charges)
- **Reliability:** Cloudflare global edge network; low latency from any location
- **Integration:** Simple HTTP API (single POST to get credentials)
- **Graceful degradation:** buildICEConfig() falls back to STUN-only on any error (no breaking failures)
- **Phase 1 bug:** Cross-network connectivity failure identified as critical bug; TURN resolves it

**Trade-offs:**
- Cloudflare endpoint format is not officially documented; may change without notice
- API token requires explicit Vercel configuration (not inherited from `.env`)
- Symmetric NAT traversal impossible without TURN (STUN insufficient)

**Implication:** Deployment must include Cloudflare credentials in Vercel environment variables. STUN-only fallback ensures connections work same-network and some cross-network cases. Full cross-network support requires TURN.

---

### 6. Vercel Serverless Deployment

**Date:** 2026-06-08  
**Decision:** Deploy on Vercel (serverless Next.js) instead of traditional VPS or container platforms.

**Alternatives Considered:**
- Self-hosted VPS (AWS EC2, DigitalOcean)
- Container platforms (Docker on AWS ECS, Google Cloud Run)
- Heroku (PaaS)
- Fly.io (edge compute)

**Why This Won:**
- **Zero DevOps:** Automatic scaling, SSL, CDN, environment management
- **Cost:** Free tier sufficient for prototype; pay-as-you-go for scale
- **Deployment:** Push to GitHub → auto-deploy (CI/CD included)
- **Speed:** Next.js-native optimization; no custom build config needed
- **Ecosystem:** TypeScript, Tailwind, Prisma all have first-class Vercel support

**Trade-offs:**
- No WebSocket support (polling required)
- Function timeout limits (30s on Pro)
- Vendor lock-in (Vercel-specific configuration)
- Limited to Node.js runtime (no custom runtimes)

**Implication:** Architecture constrained by serverless limitations (polling, stateless, 30s timeout). Suitable for MVP and take-home assessment; not ideal for high-throughput systems (>100k concurrent users).

---

### 7. TypeScript Strict Mode

**Date:** 2026-06-08  
**Decision:** Enable TypeScript strict mode (`"strict": true` in tsconfig.json); all code must satisfy type checker.

**Alternatives Considered:**
- TypeScript without strict mode (allow implicit any, etc.)
- JavaScript (no type checking)
- PropTypes (React-only, runtime checks)

**Why This Won:**
- **Code clarity:** Types serve as inline documentation
- **Refactoring safety:** Type checker catches breaking changes automatically
- **Testing:** Types reduce need for defensive runtime checks
- **Best practice:** Industry standard for production codebases

**Implication:** All new code must pass `tsc --noEmit` type check. Refactorings are safe; type checker ensures compatibility.

---

### 8. React Hooks Only (No Redux/Context)

**Date:** 2026-06-08  
**Decision:** Use React hooks (useState, useRef, useEffect) for state management; no Redux, Zustand, or Context API.

**Alternatives Considered:**
- Redux with reducers and thunks
- Zustand (lightweight alternative)
- React Context API + useReducer
- MobX (observable state)

**Why This Won:**
- **Simplicity:** Minimal dependencies; hooks built into React
- **Clarity:** State colocated with components; easier to trace data flow
- **Bundle size:** No external state library needed
- **Learning value:** Hooks teach React fundamentals; Redux adds abstraction layers

**Trade-offs:**
- Prop drilling (passing callbacks through multiple component levels)
- Ref-based state for connection state (non-rendering updates)
- No time-travel debugging (Redux offers this)

**Implication:** State management is simple but verbose. For components with complex state, useReducer hooks used (e.g., connection state machine in page.tsx).

---

### 9. Tailwind CSS Without Custom Component Library

**Date:** 2026-06-13  
**Decision:** Use Tailwind CSS utility classes directly in components; no custom component library (e.g., no shadcn/ui, Chakra, Material-UI).

**Alternatives Considered:**
- shadcn/ui (Tailwind-based component library)
- Chakra UI (CSS-in-JS components)
- Material Design
- Styled Components

**Why This Won:**
- **Minimal abstraction:** Tailwind is utility-based; components are straightforward React with inline classes
- **Fast development:** No component library learning curve
- **Customization:** Direct control over styling; no component API constraints
- **Bundle size:** No component library overhead

**Trade-offs:**
- More repetitive class names in JSX
- Custom animation utilities defined in globals.css
- No pre-built complex components (e.g., data tables, carousels)

**Implication:** Components are ~200–400 lines each; styling is visible and modifiable. Animation library defined in globals.css is easily extended.

---

### 10. Database Indexes on lastSeen and toId

**Date:** 2026-06-08  
**Decision:** Index Presence.lastSeen and Signal.toId for fast cleanup and inbox queries (not indexed on id, which is PK).

**Alternatives Considered:**
- No indexes (simple but slow with large tables)
- Compound indexes (e.g., (toId, createdAt))
- Full-text search indexes (not needed)

**Why This Won:**
- **Query performance:** `/api/poll` queries stale rows by lastSeen and inbox by toId; indexes critical for <50ms query time
- **Minimal overhead:** Two simple indexes (not composite or full-text)
- **Maintenance:** Prisma manages indexes; no manual schema tuning needed

**Implication:** Stale cleanup and inbox queries are O(log n) instead of O(n). Scaling to 100k users remains feasible.

---

### 11. Cache-Control: private, max-age=300 on TURN Credentials

**Date:** 2026-06-13  
**Decision:** Set 5-minute client-side cache on `/api/turn-credentials` response.

**Alternatives Considered:**
- No caching (fetch fresh credentials every connection)
- Longer cache (10–30 minutes)
- Server-side caching (Redis, in-process)
- No cache but longer TTL (Cloudflare caches credentials server-side)

**Why This Won:**
- **Cost reduction:** Each peer connection (both initiator and responder) would call TURN endpoint twice; caching reduces API calls by 50%
- **Latency:** Cached credentials available immediately; no fetch delay
- **Token freshness:** 5 minutes is short enough that credential rotation doesn't cause stale credentials (Cloudflare credentials typically valid for 12–24 hours)
- **Implementation:** Trivial with Cache-Control header; no server-side cache infrastructure needed

**Trade-offs:**
- Multiple connections from same client may reuse stale credentials (acceptable, credentials valid for hours)
- Cache not shared across clients (private cache); each client maintains own 5-minute cache

**Implication:** TURN API hit reduced by ~50%; cost savings and latency improvement for rapid successive connections.

---

### 12. 1500ms Polling Interval

**Date:** 2026-06-08  
**Decision:** Poll `/api/poll` every 1500ms (1.5 seconds).

**Alternatives Considered:**
- 1000ms (more responsive, higher API cost)
- 3000ms (less responsive, lower cost)
- Adaptive polling (varies based on network state)
- WebSocket (not feasible on Vercel)

**Why This Won:**
- **Latency vs. cost trade-off:** 1500ms gives ~1.5s max signal delivery latency; acceptable for connection setup
- **API cost:** At 1000ms, a user polls 86400 times/day; at 1500ms, 57600 times/day
- **Resource usage:** 1500ms is a comfortable interval; doesn't overload database or Vercel function quota
- **Responsiveness:** Peer dots update, incoming requests arrive within 1.5 seconds (feels responsive to user)

**Implication:** Signal delivery latency is 0–1500ms (random within polling interval). For initial offer/answer, this is acceptable. Real-time chat uses WebRTC data channel (0ms P2P latency).

---

### 13. No Authentication/Authorization

**Date:** 2026-06-08  
**Decision:** No login, signup, or access control; users are identified only by client-generated session UUID.

**Alternatives Considered:**
- OAuth (Google, GitHub sign-in)
- Email + password authentication
- Anonymous with rate limiting per IP
- JWT tokens with time-limited access

**Why This Won:**
- **Simplicity:** No user database, password reset flows, or session management
- **Privacy:** No user accounts to leak; minimal personal data collected
- **MVP speed:** Focus on core WebRTC and coordination logic
- **Attack risk:** Client-generated UUID is trivial to forge, but all users are ephemeral; no persistent identity to compromise

**Trade-offs:**
- No rate limiting (anyone can spam API endpoints)
- No bans (rude users cannot be blocked)
- No moderation (any content is allowed)

**Implication:** Phase 3 (security review) should address DoS vectors and consider lightweight rate limiting or firewall rules.

---

## Decision Impact Summary

| Decision | Impact | Reversibility |
|----------|--------|-----------------|
| Polling (no WebSocket) | Forces 1500ms latency; stateless signaling | High (switch provider, migrate to dedicated servers) |
| Transient data | No persistence, privacy advantage | Medium (add persistence layer, requires schema change) |
| Native WebRTC | Full control, no library overhead | High (can wrap with library later if needed) |
| Privacy offset | No exact location storage | High (easy to remove if privacy requirement relaxed) |
| Cloudflare TURN | Cost-effective NAT traversal | Medium (switch TURN provider, update endpoint) |
| Vercel serverless | Zero DevOps, but vendor lock-in | Medium (migrate to VPS, significant rewrite) |
| TypeScript strict | Type safety, longer initial dev time | Low (removing strict mode breaks existing code) |
| React hooks only | Simple but verbose for complex state | Medium (add state library, large refactor) |
| Tailwind (no components) | Fast development, but repetitive | Medium (add component library, migrate styles) |
| No authentication | Privacy advantage, but no moderation | Medium (add auth, affects API signatures) |

---

## page.tsx Decomposition Refactor (2026-06-15)

Behavior-preserving decomposition of the 1192-line `Home` god component into
custom hooks + pure reducers (branch `refactor/page-decomposition`, 8 commits).
Final: page.tsx 1192 → 841 lines; 8 new modules, each with co-located tests
(323 total, all green; CI lint/tsc/test/build green).

Decisions made and held:
- **R-0 characterization test required before R-4/R-5 merge.** page.tsx had ZERO
  tests, so "behavior-preserving" had no baseline. A focused integration net
  (`app/page.characterization.test.tsx`) pins the connection lifecycle + the
  privacy-critical reciprocal-video gate against the CURRENT behavior. It must
  keep passing through any future page.tsx change.
- **`startPeer` stays resident in page.tsx (R-6 rejected).** It's the seam where
  chat/connection/video converge and touches the privacy-critical track gating;
  relocating the `PeerSession` constructor was judged higher-risk than the
  marginal tidiness. Hooks supply handler bodies; the orchestrator holds the seam.
- **Single shared `peerRef` is a hard constraint.** Both reducers are state-only
  and pure; `peerRef` is one `useRef` in page.tsx passed by reference into the
  hooks. Do not move it into a hook or duplicate it.
- **No behavior changes in flight.** BUG-1 (manual mute/camera state is reset
  only on full teardown, NOT on `video-end`/`endVideo`, so it can carry into a
  second video call within the same chat) was found by QA and confirmed
  **pre-existing on `main`** — faithfully preserved, deliberately NOT fixed here.
  It is a separate story if we choose to address it.

## Out of Scope (separate efforts)

- **Per-poll global DB reaping** (`app/api/poll/route.ts`): every client runs
  three global `deleteMany` sweeps every poll tick — O(N) writes for O(1) useful
  work. Move to a scheduled job (Vercel Cron). Unrelated to the page decomposition.

## Future Decision Points

1. **Phase 3 (Security):** Rate limiting and input validation strategy
2. **Phase 4 (Feature):** Original feature design and scope
3. **Scale beyond 10k users:** Evaluate WebSocket or polling architecture change
4. **Persistent features:** If chat history required, decide on encryption, retention, and privacy implications
