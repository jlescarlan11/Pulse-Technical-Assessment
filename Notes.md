# Phase 1: Make It Run — Bug Discovery & Fixes

**Status:** In Progress  
**Date Started:** 2026-06-13  
**Current Focus:** Core presence and connection state bugs

---

## What Was Broken

### Bug #1: Heartbeat Updates All Presence Rows (SHOW-STOPPER)

**Symptom:** User dots stayed on the map indefinitely after closing the app. Stale presence cleanup never fired.

**Root Cause:**  
File: `/app/api/poll/route.ts` (line 25)

```typescript
// BROKEN CODE:
await prisma.presence.updateMany({
  where: {},  // ← EMPTY WHERE CLAUSE!
  data: { lastSeen: new Date(now) },
});
```

**Impact:**
- Every poll request updated **all presence rows in the database**, not just the caller's
- All stale presence rows were perpetually refreshed by any active user's poll
- Stale cleanup logic (checking for `lastSeen < staleCutoff`) never found anything to delete
- User dots never disappeared, even after 15+ seconds of inactivity
- Created phantom online status indefinitely

---

### Bug #2: Busy Flag Not Cleared on `end` Signal (SHOW-STOPPER)

**Symptom:** After a user ended a chat/video call, they couldn't initiate new connections. Second connection attempts would auto-decline with "user busy."

**Root Cause:**  
File: `/app/api/signal/route.ts` (lines 83-95)

```typescript
// BROKEN CODE:
if (signalType === "accept") {
  await prisma.presence.updateMany({
    where: { id: { in: [fromId, toId] } },
    data: { busy: true },
  });
} else if (signalType === "decline") {
  // ↑ Only handles "decline", NOT "end"!
  await prisma.presence.updateMany({
    where: { id: { in: [fromId, toId] } },
    data: { busy: false },
  });
}
```

**Impact:**
- When a user called `end`, the busy flag was never cleared
- Both peers remained locked in `busy: true` state indefinitely
- New connection requests were auto-declined because `/api/signal` checks `if (target.busy)` before accepting (line 57-59)
- Users could only ever have one connection, then were stuck offline forever
- Prevented all sequential connections on the same session

---

### Bug #3: Signal Orphan Cleanup (MINOR)

**Symptom:** Over long sessions, orphaned signals accumulated in the database.

**Root Cause:**  
When a busy user received a connection request, the server auto-declined (creating a new signal), but no logging tracked cleanup.

**Impact:**
- Database bloat over extended sessions
- Not a functional blocker, but poor hygiene
- Made debugging harder (couldn't see when cleanup actually fired)

---

## How We Found It

### Step 1: Context Scan (Architecture Review)
- Used `context-scanner` agent to map the full codebase
- Analyzed:
  - Database schema (`Presence` and `Signal` models)
  - API routes and their responsibilities
  - Polling interval (1500ms) vs stale timeout (15s)
  - Connection state machine in frontend
  
**Finding:** Identified that heartbeat logic should only update the current user, but the `where: {}` was updating everyone.

### Step 2: Plan Architecture
- Used `Plan` agent to design fixes
- Traced through the connection lifecycle:
  - User A: `join` → `poll` (heartbeat) → `signal` (request) → `signal` (accept) → chat
  - User B: responds, both marked `busy: true`
  - Either user: `signal` (end) → should clear `busy`, but didn't
  
**Finding:** Three interconnected issues blocking both core features.

### Step 3: Implementation & Verification
- `backend-engineer` agent applied surgical fixes
- Verified TypeScript compilation
- Added logging for observability

---

## How We Fixed It

### Fix #1: Heartbeat — Only Update Caller's Presence

**File:** `/app/api/poll/route.ts`

**Change (line 25):**
```typescript
// BEFORE:
await prisma.presence.updateMany({
  where: {},
  data: { lastSeen: new Date(now) },
});

// AFTER:
await prisma.presence.updateMany({
  where: { id },  // ← Use the caller's ID
  data: { lastSeen: new Date(now) },
});
```

**Why:** The `id` parameter (already validated at line 13) is the current user's presence record. Using it in the where clause ensures only their `lastSeen` is updated.

**Added Logging (line 29):**
```typescript
console.log(`[poll] heartbeat for ${id}, staleCutoff=${staleCutoff.toISOString()}`);
```

**Added Logging (lines 33-38):**
```typescript
const deletedPresenceResult = await prisma.presence.deleteMany({
  where: { lastSeen: { lt: staleCutoff } },
});
if (deletedPresenceResult.count > 0) {
  console.log(`[poll] reaped ${deletedPresenceResult.count} stale presence rows`);
}
```

**Expected Behavior:**
- Each poll only refreshes that user's timestamp
- After 15+ seconds without a poll (10 missed poll cycles at 1500ms), the presence row is deleted
- Dots disappear from the map within 20 seconds of app close

---

### Fix #2: Busy Flag — Clear on `end` Signal

**File:** `/app/api/signal/route.ts`

**Change (line 79):**
```typescript
// BEFORE:
} else if (signalType === "decline") {

// AFTER:
} else if (signalType === "decline" || signalType === "end") {
```

**Why:** Both `decline` and `end` signals terminate a connection. Both should clear the `busy` flag so users can initiate new connections.

**Added Logging (lines 85-92):**
```typescript
if (signalType === "accept" || signalType === "decline" || signalType === "end") {
  console.log(`[signal] busy transition: ${signalType} for ${fromId} and ${toId}`);
}
```

**Expected Behavior:**
- When either user sends `end`, both are marked `busy: false`
- Subsequent connection requests are accepted (no auto-decline)
- Users can have multiple sequential connections in one session

---

### Fix #3: Signal Orphan Cleanup — Added Logging

**File:** `/app/api/poll/route.ts`

**Change (lines post-signal deletion):**
```typescript
const deletedSignalsResult = await prisma.signal.deleteMany({
  where: { createdAt: { lt: signalCutoff } },
});
if (deletedSignalsResult.count > 0) {
  console.log(`[poll] cleaned ${deletedSignalsResult.count} orphaned signals`);
}
```

**Why:** The cleanup logic was already correct (60s TTL), but no visibility into whether it was firing.

**Expected Behavior:**
- Orphaned signals (older than 60s) are automatically deleted
- Log shows when cleanup happens (useful for debugging)

---

## Verification Strategy

### Test 1: Presence Cleanup (15-second disappearance)
1. Open app in Browser A
2. Open app in Browser B (should see each other)
3. Close Browser B tab
4. Monitor Browser A's map
5. **Expected:** Browser B's dot disappears within 15-20 seconds
6. **Verify:** Server logs show `[poll] reaped X stale presence rows`

### Test 2: Sequential Connections (busy flag)
1. Browser A initiates connection to Browser B
2. Browser B accepts
3. Both chat briefly
4. Browser A clicks "End"
5. Wait 1 second
6. Browser B initiates connection to Browser A
7. **Expected:** Connection succeeds (no auto-decline)
8. **Verify:** Server logs show `[signal] busy transition: end for ...` then new request accepted

### Test 3: P2P Chat (no signal leakage)
1. Establish connection
2. Send chat messages both directions
3. **Expected:** Messages arrive instantly over WebRTC data channel
4. **Verify:** Browser DevTools Network tab shows `/api/signal` only for control messages (request, accept, offer, answer, ice, end), NOT for chat text

### Test 4: Graceful App Close (sendBeacon)
1. Establish connection
2. Hard-close browser tab
3. Other browser monitors for dot disappearance
4. **Expected:** Dot gone within 15 seconds (sendBeacon triggers immediate `/api/leave`, or stale cleanup picks it up)

---

## Impact Summary

| Bug | Severity | Type | Fix | Lines Changed |
|-----|----------|------|-----|----------------|
| Heartbeat `where: {}` | CRITICAL | Logic | Change to `where: { id }` | `/app/api/poll/route.ts`: 1 line + logging |
| Busy flag on `end` | CRITICAL | Logic | Add `\|\| signalType === "end"` | `/app/api/signal/route.ts`: 1 line + logging |
| Signal cleanup logging | Minor | Observability | Add logs to cleanup | `/app/api/poll/route.ts`: +5 lines |

**Total:** 2 critical 1-line fixes + observability logging  
**Complexity:** Low (surgical changes, no refactoring)  
**Risk:** Very low (only fixes broken logic, no new features or API changes)

---

### Bug #4: WebRTC Connection Stuck in "Connecting" (CRITICAL)

**Symptom:** Two users could see each other on the map, exchange signals (request/accept/offer/answer/ice), but the data channel never opened. Connection state remained "Connecting..." indefinitely.

**Root Cause:**  
File: `/lib/webrtc.ts` (lines 109-111)

```typescript
// BROKEN CODE:
await this.flushPendingCandidates();          // ← Called BEFORE remote description
await this.pc.setRemoteDescription(desc);
```

**Impact:**
- ICE candidates arrived before the offer/answer, so they were queued
- After receiving answer, code tried to add queued candidates BEFORE setting remote description
- `addIceCandidate()` fails if there's no remote description (silently caught with `catch {}`)
- ICE connection never established, so data channel never opened
- Users could accept calls but couldn't chat, video, or do anything peer-to-peer

---

### Bug #5: Data Channel Open Event Race Condition (CRITICAL)

**Symptom:** Even with ICE connection established, `onChannelOpen` event sometimes never fired, leaving connection stuck.

**Root Cause:**  
File: `/lib/webrtc.ts` (lines 74-75)

```typescript
// BROKEN CODE:
dc.onopen = () => this.cb.onChannelOpen();
dc.onmessage = (e) => { ... };
```

**Issue:** RTCDataChannel can transition to "open" before the `onopen` handler is attached, causing the event to be missed entirely.

**Impact:**
- Data channel would open (readyState = "open") but the callback was never called
- Frontend remained in "connecting" state indefinitely
- No error message, connection appeared to hang

---

### Bug #6: Chat Message Type Mismatch (MINOR)

**Symptom:** Chat messages weren't being received even when connection established.

**Root Cause:**  
File: `/lib/webrtc.ts` (line 79 vs line 132)

```typescript
// SENDER (line 132):
this.safeSend({ t: "msg", text });

// RECEIVER (line 79):
if (msg.t === "chat" && typeof msg.text === "string") {
  // ↑ Checking for "chat", but sender uses "msg"!
```

**Impact:**
- Even when peers connected, chat messages were silently discarded
- Different message type meant the receiver's condition never matched

---

## How We Fixed It

### Fix #4: ICE Candidate Ordering — Set Remote Description First

**File:** `/lib/webrtc.ts`

**Change (lines 109-111):**
```typescript
// BEFORE:
await this.flushPendingCandidates();
await this.pc.setRemoteDescription(desc);

// AFTER:
await this.pc.setRemoteDescription(desc);
await this.flushPendingCandidates();
```

**Why:** ICE candidates can only be added after the remote description is set. The correct WebRTC flow is:
1. Set remote description (from offer/answer)
2. Then add any pending ICE candidates
3. New ICE candidates arrive and can be added immediately

**Expected Behavior:**
- Pending ICE candidates are queued when they arrive before remote description
- After remote description is set, all pending candidates are flushed (added)
- Connection state progresses to "connected"
- Data channel opens

---

### Fix #5: Data Channel Open Event — Check readyState

**File:** `/lib/webrtc.ts`

**Change (lines 74-81):**
```typescript
// BEFORE:
dc.onopen = () => this.cb.onChannelOpen();

// AFTER:
const handleOpen = () => {
  if (this.closed) return;
  this.cb.onChannelOpen();
};

if (dc.readyState === "open") {
  handleOpen();
} else {
  dc.onopen = handleOpen;
}
```

**Why:** Handles the race condition where the channel transitions to "open" before the handler is attached.

**Expected Behavior:**
- If channel is already open when handler is attached, we call the callback immediately
- If channel is still connecting, we wait for the `onopen` event
- Either way, `onChannelOpen` is guaranteed to be called

---

### Fix #6: Chat Message Type — Use "msg" Consistently

**File:** `/lib/webrtc.ts`

**Change (line 79):**
```typescript
// BEFORE:
if (msg.t === "chat" && typeof msg.text === "string") {

// AFTER:
if (msg.t === "msg" && typeof msg.text === "string") {
```

**Why:** Sender uses `t: "msg"`, so receiver must check for same value.

**Expected Behavior:**
- Chat messages are properly decoded and delivered to UI

---

## Impact Summary (All 6 Bugs)

| Bug | Severity | Type | Fix | Lines Changed |
|-----|----------|------|-----|----------------|
| Heartbeat `where: {}` | CRITICAL | Logic | Change to `where: { id }` | `/app/api/poll/route.ts`: 1 line |
| Busy flag on `end` | CRITICAL | Logic | Add `\|\| signalType === "end"` | `/app/api/signal/route.ts`: 1 line |
| ICE ordering | CRITICAL | Logic | Swap setRemoteDescription/flushPendingCandidates | `/lib/webrtc.ts`: 2 lines swapped |
| Data channel race | CRITICAL | Logic | Check readyState before attaching handler | `/lib/webrtc.ts`: 5 lines |
| Chat message type | MINOR | Type mismatch | Change "chat" to "msg" | `/lib/webrtc.ts`: 1 line |
| Signal cleanup logging | Minor | Observability | Add logs to cleanup | `/app/api/poll/route.ts`: +5 lines |

**Total:** 4 critical bugs, 2 minor bugs  
**Complexity:** Very low (all surgical, no refactoring)  
**Risk:** Very low (only fixes broken logic)

---

## Verification

All bugs fixed and tested:
- ✅ Two users can join and see each other
- ✅ Users can initiate and accept connections
- ✅ Connection transitions from "Connecting..." to "Connected"
- ✅ Chat messages send and receive correctly
- ✅ Sequential connections work after ending a call
- ✅ Presence dots disappear when users go offline

---

### Bug #7: Cross-Network Connectivity Fails (Symmetric NAT) (CRITICAL)

**Symptom:** Two users on different WiFi networks couldn't connect. Same WiFi worked fine. Users saw "network error" or "user decline" messages.

**Root Cause:**  
File: `/lib/webrtc.ts`

The ICE configuration only specified a STUN server — no TURN relay:

```typescript
// BROKEN CODE:
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],  // ← STUN only!
};
```

**Impact:**
- STUN servers help discover external IP but fail on symmetric NAT (common on different WiFi, enterprise networks, carrier-grade NAT)
- Devices on same WiFi: both behind same NAT gateway, hairpinning works, STUN sufficient
- Devices on different WiFi: behind different NAT contexts, STUN reflexive candidates blocked, all ICE candidates fail
- Connection state reaches "failed", triggering teardown with "network error"
- Cross-network P2P impossible; app only worked for same-WiFi use cases

---

## How We Fixed It

### Fix #7: Add a Cloudflare TURN Relay for NAT Traversal

**Files changed:**
1. `/app/api/turn-credentials/route.ts` (NEW) — server-side endpoint that mints short-lived TURN credentials
2. `/lib/webrtc.ts` — added `buildICEConfig()`; `PeerSession` accepts an `iceConfig` param
3. `/app/page.tsx` — `startPeer()` is now async and fetches the ICE config before creating the peer

**Client side** (`lib/webrtc.ts`) — fetch TURN credentials, fall back to STUN-only on any failure:

```typescript
export async function buildICEConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch("/api/turn-credentials", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return ICE_CONFIG;                       // STUN-only fallback
    const { urls, username, credential } = await res.json();
    if (!urls?.length || !username || !credential) return ICE_CONFIG;
    return {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls, username, credential },
      ],
    };
  } catch {
    return ICE_CONFIG;                                    // timeout / network / parse error
  }
}
```

**Server side** (`/api/turn-credentials`) — call Cloudflare's Realtime TURN API with credentials kept server-side, and return only `{ urls, username, credential }` to the client.

> **⚠️ Gotcha — the first attempt hit the wrong Cloudflare endpoint.** The initial implementation guessed the API shape and called a route that does not exist, so the endpoint returned **HTTP 500** in production and the client silently fell back to STUN-only — meaning cross-network *still* failed even after the TURN work shipped. Production logs revealed it:
>
> ```
> Cloudflare API error: {"success":false,"errors":[
>   {"code":7003,"message":"Could not route to /accounts/.../rtc/config, perhaps your object identifier is invalid?"},
>   {"code":7000,"message":"No route for that URI"}
> ]}
> ```
>
> The credentials were valid the whole time — only the URL/contract was wrong. Corrected against the [official docs](https://developers.cloudflare.com/realtime/turn/generate-credentials):
>
> | | First attempt (broken) | Correct |
> |---|---|---|
> | Host | `api.cloudflare.com/client/v4` | `rtc.live.cloudflare.com/v1` |
> | Path | `/accounts/{id}/rtc/config` | `/turn/keys/{KEY_ID}/credentials/generate-ice-servers` |
> | Body | _(none)_ | `{ "ttl": 86400 }` |
> | Response | expected `{ success, result }` wrapper | bare `{ iceServers: [...] }`, status 201 |
> | `CLOUDFLARE_TURN_TOKEN_ID` | used as a Cloudflare account ID | it's the TURN **key** ID (goes in the URL path) |

Final working call:

```typescript
const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`;
const response = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ ttl: 86400 }),
  signal: AbortSignal.timeout(5000),
});
// Response: { iceServers: [ {urls:[stun...]}, {urls:[turn...], username, credential} ] }
// Pick the entry that has username + credential.
```

**Environment variables** (server-side only, set in Vercel):
- `CLOUDFLARE_TURN_TOKEN_ID` — the Cloudflare TURN **key ID** (used in the request path)
- `CLOUDFLARE_TURN_API_TOKEN` — the TURN key API token (Bearer auth)

**Frontend integration** (`app/page.tsx`):
- `startPeer()` is async; calls `await buildICEConfig()` before creating the peer
- Wrapped in try-catch — if config building throws, calls `teardown("Connection failed (ICE config).")`

**Expected behavior:**
- Same-WiFi connections still work (STUN only)
- Cross-WiFi connections now work (STUN + TURN relay)
- If the TURN fetch fails for any reason, the client gracefully falls back to STUN-only

---

## How We Found It

- **Context scan** identified only a STUN server in the ICE config → symmetric NAT blocks reflexive candidates on cross-WiFi → a TURN relay is required.
- **Production Vercel logs** then exposed the wrong-endpoint bug (Cloudflare error 7003/7000), which we corrected against Cloudflare's official Realtime TURN docs.

---

## Impact Summary (Bug #7)

| Aspect | Details |
|--------|---------|
| **Severity** | CRITICAL (breaks cross-network use case) |
| **Type** | Missing capability (NAT traversal) + wrong external API contract |
| **Files** | 3 (1 new API route, 2 modified core files) |
| **Tests** | 20 automated tests (build clean, no `[DEBUG]` logging in source) |
| **Deployment** | Requires `CLOUDFLARE_TURN_TOKEN_ID` + `CLOUDFLARE_TURN_API_TOKEN` in Vercel env vars |

---

## Phase 1 Complete

**All 7 bugs fixed:**
- ✅ Bug #1: Heartbeat updates all presence (fixed — scope to caller)
- ✅ Bug #2: Busy flag not cleared on `end` (fixed — added end handler)
- ✅ Bug #3: Signal orphan cleanup logging (fixed — added observability)
- ✅ Bug #4: ICE candidate ordering (fixed — set remote description first)
- ✅ Bug #5: Data channel race condition (fixed — check readyState)
- ✅ Bug #6: Chat message type mismatch (fixed — use "msg" consistently)
- ✅ Bug #7: Cross-network connectivity (fixed — add Cloudflare TURN relay via the correct Realtime API)

**Phase 1 deliverable:** Fully functional P2P geolocation chat/video app with cross-network connectivity and comprehensive test coverage.

---
---

# Phase 2: Make It Good — "Signal in the Dark" UI/UX Redesign

**Status:** Complete
**Branch:** `feature/phase-2-ui-polish`
**Scope:** Presentation only — **no** WebRTC / signaling / state-machine logic was changed. Phase 1's behavior is preserved byte-for-byte; this is purely how it looks and feels.

---

## The Brief & The Thinking

Phase 1 made Pulse *work*. Phase 2 makes it something you'd be proud to show off. The starting point was competent but generic: flat `zinc` surfaces, a single `emerald-400` accent, `rounded-full` everything, essentially zero motion — and the body font was even silently falling back to Arial because a `globals.css` rule overrode Geist.

The concept the product was begging for: **"Signal in the Dark."** Pulse is literally *a living radar of human presence* — an app called Pulse, showing strangers broadcasting from the dark. So every visual decision leans into that: a deep, dimensional dark (not flat zinc), one luminous **signal-green** accent used sparingly so its glow actually means something, real glassmorphism, and motion that *breathes*. The guiding metaphors were **life/heartbeat**, **signal/radar/sonar**, and **calm confidence** (generous space, restrained accent).

**Deliberate constraint:** the entire motion system is hand-built **CSS** — no animation library was added. For a design-craft showcase this is both cleaner (no bundle/SSR concerns with the conditional-render-heavy `page.tsx`) and more impressive than reaching for Framer Motion.

---

## How We Worked (Pipeline)

Same agent pipeline as Phase 1, adapted for design work:

`context-scanner` → `project-manager` (8 sequenced stories) → `stakeholder` (scope/value gate) → implementation → `ui-ux-critic` (design audit) → `code-reviewer` → `qa-engineer`.

Key stakeholder decisions that shaped the work:
- **No new automated tests for the visual work** — there's no logic change and snapshot tests on Tailwind class soup are brittle. The bar is *existing tests green + clean build + manual visual/accessibility (WCAG 2.1 AA) verification*. The one carve-out: any **pure helper** added must be unit-tested (→ `lib/peerColor.ts`).
- **No formatter adoption** (would bury the design diff); **WCAG 2.1 AA** as the accessibility bar.

The creative brief lives at `.claude/knowledge/phase-2-design-brief.md`.

---

## What Changed

### Foundation: a real design system (`app/globals.css`, `app/layout.tsx`)

The spine everything hangs from. Replaced the `--background`/`--foreground`-only setup with a genuine token system in Tailwind v4's `@theme`:

- **Color scales** — `ink-*` (a cool, dimensional near-black, not flat zinc), `haze-*` (text tiers), `signal-*` (the luminous mint-cyan accent `#34f0bf`), `aurora-*` (atmospheric backdrop secondaries), and `danger-*`.
- **Radii, elevation/glow shadows, blur**, and a **motion vocabulary**: signature easings (`--ease-signal` / `--ease-spring` / `--ease-calm`) and `--animate-*` utilities (`fade-up`, `scale-in`, `slide-in`, `pill-in`, `msg-in`, …).
- **Reusable atmosphere helpers** — `.glass`, `.glass-faint`, `.aurora-field`, `.signal-grain`, `.vignette`.
- **Fixed the font** — removed the Arial override so Geist actually renders; committed to a dark `color-scheme`.
- **Accessibility baked in** — pill-shaped focus rings that follow each control's own radius; a `prefers-reduced-motion` block that stills ambient motion and, crucially, holds "live" status dots at a steady, visible glow (forcing `.animate-ping` ripples off and `.animate-pulse` dots to full opacity, so a status indicator never freezes mid-fade).
- Art-directed the **Mapbox controls** to match the dark glass.

### `lib/peerColor.ts` (new, unit-tested) — one identity color per peer

A peer's color must be **stable from their map dot → connection prompt → chat header**. Extracted the previously-triplicated hashing into one helper, with two deliberate rules:
- **Pinned saturation/lightness** (85% / 64%) so the map reads as one cohesive signal field, not confetti.
- **A hue wedge (130–189°) excluded** so a peer's color can *never* collide with the reserved signal-mint accent — protecting the "the green is *the* signal" idea the whole concept rests on. (The accent `#34f0bf` computes to hue ~164°, right in the excluded band.)

`lib/peerColor.test.ts` covers determinism, the wedge exclusion across 500 ids, valid range, and pinned S/L.

### Per-surface redesign

- **EntryGate** — atmospheric first impression: a living aurora backdrop, a radar/beacon field, the Geist wordmark with a signal glow, a glowing CTA with press + shimmer micro-interactions, and *designed* locating/error states (not a bare label swap).
- **WorldMap (the hero)** — luminous breathing peer dots with sonar rings (the dot reads a `--dot` CSS custom property; the `.pulse-dot`/`.pulse-me`/`.pulse-me-label` class-hook contract with the marker JS was preserved), a refined glowing "You" pin, and a glass brand + live-presence HUD. Busy peers are dimmed **and** made non-interactive (`pointer-events: none`) so the hover/cursor affordance matches what a tap will do.
- **ConnectionPrompt** — an "incoming signal" glass modal: spring entrance, an identity orb in the peer's own hue, plus real **focus management** (autofocus, Tab trap, Escape to decline).
- **ChatPanel** — a glass drawer that slides in, animated message entry, a warm empty state, a polished composer, and a `connecting`/`connected` affordance. Also fixed a latent robustness bug: auto-scroll switched from `scrollIntoView` (which could scroll the whole page) to scrolling the **list container** itself, and added a presentation-only "still connecting…" hint after 8s so the connecting state is never a silent dead end.
- **VideoPanel** — cinematic full-bleed remote, a settling floating PiP, **auto-calming controls** (they recede after idle and are made `pointer-events-none` while hidden so the invisible "End" button can't be tapped, while `focus-within` still reveals them for keyboard users), and a designed waiting state.
- **Toasts / notices / pills** (`app/page.tsx`) — refined glass with enter motion and `role="status"` for non-visual feedback; the WebRTC/state logic in `page.tsx` is untouched (only `activePeerId` derivation + prop pass-throughs were added).

---

## Design Iterations (the interesting part)

Good design is iteration. Three details got reworked based on direct visual review:

### 1. ConnectionPrompt orb halo — "too big and weird" → contained → balanced

The orb's pulse initially reused the map's `sonar` keyframe, which scales to **3×**. On the 80px orb box that expanded to ~240px — a giant ring that **burst out of the card and collided with the title**.

- **First fix (overcorrected):** a new contained `halo` keyframe (scale → 1.4×) and a smaller orb. Now it was *too small* to read as a halo.
- **Final:** the real insight was that the ring **faded out before it got wide**, so bumping the peak scale didn't make it *read* bigger. Retuned the opacity curve to **stay visible through the mid-expansion** (holds ~0.22 at 1.45× before fading at 1.8×), restored the orb to full size, and added title clearance. `sonar` was left untouched — it's still correct for the map dots / "You" pin, where a wide sweep reads as a signal radiating across geography. **Two named keyframes with distinct intent**, rather than overloading one.

### 2. EntryGate radar — bisecting the text → masked away → a living halo pulse

The landing's concentric rings + expanding green pings were centered on the viewport — *the same place the wordmark/tagline/CTA live* — so crisp 2px green rings sliced straight through the text.

- **First fix (overcorrected):** a radial mask dissolved the rings toward the center + softened the pings. Clean, but it masked the pulse into near-invisibility — losing the life.
- **Final:** brought back a clearly-felt pulse done *well*. Soft, **blurred** rings (waves of light, not crisp lines) swell and radiate outward on a steady ~1.5s rhythm, with a new `pulse-glow` keyframe driving a glow that **breathes behind the wordmark** as the pulse's "heart." A *light* mask keeps only the dense center clean. The lesson mirrors the orb: keep the motion visible and soft so it haloes the content instead of cutting through it.

### 3. Chat send icon — pointing the wrong way

The paper-plane glyph's tip pointed **back at the input**. First corrected to up-right, then — per the Messenger reference — rotated to point **horizontally right**, toward where the message goes.

---

## Verification

- **Build clean** (`npm run build`), **lint clean** (one pre-existing, unrelated `api/poll/route.ts` warning), **24/24 tests pass** (the 20 Phase-1 tests + 4 new `peerColor` tests).
- **Visual verification** via headless-Chrome screenshots of every iteration (EntryGate, ConnectionPrompt, ChatPanel, the live map HUD). Throwaway `app/preview` harnesses were used to render overlays/streams-dependent surfaces in isolation, then deleted. (Note: the map needs real GPU for WebGL — use `--use-angle=swiftshader` to render tiles headless.)
- **Review gates:** `ui-ux-critic` (0 critical, `aesthetic_match: yes`), `code-reviewer` (APPROVED — verified the WebRTC/state logic is unchanged), `qa-engineer` (manual walkthrough + edge-case catalog incl. reduced-motion, focus paths, peer-color consistency).
- Two reviewer/QA findings were addressed: the calmed VideoPanel control bar is `pointer-events-none` (was invisible-but-clickable), and the dead no-token map fallback was made reachable (dropped the placeholder token default so the graceful "set your token" card actually shows).

---

## Phase 2 Change Summary

| Area | Change | Thinking |
|------|--------|----------|
| `globals.css` / `layout.tsx` | Full design-token + CSS motion system; Geist font fix; reduced-motion + focus rings | One cohesive system so every surface is consistent; no animation library needed |
| `lib/peerColor.ts` (new) | Shared per-peer color; signal-mint hue wedge excluded; unit-tested | Stable identity across surfaces; peers never collide with the accent |
| `EntryGate.tsx` | Atmospheric landing, glowing CTA, **living halo pulse** | First impression sets the bar; the app named Pulse should *pulse* |
| `WorldMap.tsx` | Breathing luminous dots, glass HUD, busy dots non-interactive | The hero surface; affordance must match behavior |
| `ConnectionPrompt.tsx` | Glass modal, peer-hue identity orb (**retuned halo**), focus trap | "Incoming signal" moment; accessible |
| `ChatPanel.tsx` | Glass drawer, animated messages, container-scoped scroll, send-icon fix, slow-connect hint | Crafted conversation; no silent dead ends |
| `VideoPanel.tsx` | Cinematic full-bleed, floating PiP, auto-calming (pointer-safe) controls | Immersive call; controls get out of the way |
| `page.tsx` | Glass toast/pill restyling + `role="status"`; prop wiring | UI only — zero state-machine change |

**Total:** 1,093 insertions / 138 deletions across 8 app files + 2 new `lib` files.
**Risk:** Very low — presentation only, no behavioral change, all tests green.

**Phase 2 deliverable:** A genuinely beautiful, cohesive, motion-rich Pulse — a deep dimensional dark with one luminous signal accent, real glass, and breathing life across every surface — with no regression to Phase 1's functionality.

---
---

# Phase 3: Make It Secure — API Security Audit & Hardening

**Status:** Complete
**Branch:** `feature/phase-3-security` (branched from `main`, independent of the Phase 2 UI PR)
**Scope:** The HTTP coordination API and its deployment posture. No change to the WebRTC peer-to-peer path or the connection state machine — this phase locks down the *signaling server*, not the calls it brokers.

---

## The Brief & The Thinking

Phases 1 and 2 made Pulse work and made it beautiful. Phase 3 is the question you have to answer before you let strangers point a camera at each other: *can this be abused?* So the work was a security audit of the HTTP API first, then fixes.

The whole story turns on one realization about the trust model. Pulse is **intentionally anonymous** — there are no accounts. Every client mints a `crypto.randomUUID()` and calls itself that. The original design treated that id as if it were a secret: a client asserts "I am id X," and the server believes it.

But that id is not a secret — **it is public by design.** `/api/poll` returns every online peer's id, because peers have to address each other to place dots on the map and route signals. The map literally hands every client a directory of everyone else's id. So an attacker never has to *guess* anything: the identifier the server trusts as proof of identity is broadcast to all participants. Every critical finding below is a consequence of that single gap — **a client-asserted id with no proof of ownership.**

That reframing is what makes the fix obvious. The server has to be able to tell "the real owner of session X" apart from "anyone who read X off the map" — without introducing accounts and destroying the anonymity that is the product. The answer is a **capability token**: a secret the server issues and the client proves it holds, with no identity attached to it.

---

## How We Worked (Pipeline)

The audit-then-fix shape used a longer pipeline than the earlier phases:

`context-scanner` → `security-auditor` (audit) → `project-manager` (11 stories) → `stakeholder` (approve-with-conditions gate) → `database-architect` → `backend-engineer` + `devops-engineer` (CI, in parallel) → `frontend-engineer` → `test-engineer` → `code-reviewer` + `security-auditor` (re-audit).

The **stakeholder gate** is where this phase was really shaped. Approval came *with conditions* — five binding rulings that constrained the implementation rather than just blessing it:

1. **Token transport must survive `sendBeacon`.** `/api/leave` fires on tab-close via `navigator.sendBeacon`, which cannot set custom headers. So the token travels in the request **body or query param**, never an `Authorization`-style header — otherwise the most important "I'm leaving" call couldn't authenticate at all.
2. **The rate limiter must FAIL-OPEN.** A limiter that can lock real users out of an anonymous app on a DB hiccup is worse than the DoS it prevents. Any limiter error must return *allowed*.
3. **The rate limiter must be POOL-SAFE.** At a 1500ms poll cadence the limiter is on the hottest path; it must not exhaust the ~10-connection pool — single statement, no transactions.
4. **The CSP must not break the product.** A locked-down policy that blocks Mapbox tiles or relayed TURN calls is a regression, not a fix; the connect-src/worker-src/media-src allowances were a *verification condition*, not an afterthought.
5. **Ship CI as part of this phase.** The repo had no merge gate at all, which is itself a security gap.

---

## What We Found

The audit produced a ranked finding list. SQL injection, raw-coordinate leakage, and classic CSRF were **checked and dismissed** up front: Prisma is parameterized everywhere; the privacy offset is applied server-side *before* storage so raw coordinates never land in the DB; and there are no cookies or ambient credentials for a CSRF to ride. What remained clustered tightly around the no-ownership-proof trust model.

### CRITICAL — broken access control (all rooted in the unverified id)

**C1 — Mailbox drain via `GET /api/poll?id=<victim>`.** Poll *reads-and-deletes* the caller's signals. With no ownership check, an attacker polling a victim's id **steals the victim's WebRTC signaling** (offer/answer/ICE — and ICE candidates leak local/reflexive IPs, a real deanonymization vector) **and deletes them**, so the victim's calls silently fail. Run in a loop, it is a permanent denial of connection.

**C2 — Impersonation via spoofed `fromId` on `POST /api/signal`.** `fromId` was attacker-chosen and unverified. An attacker sends an offer *as victim A* to victim B; B connects to the attacker believing it is A. That is a full man-in-the-middle of a call, in an app whose entire trust model is "the dot you tapped is who you talk to."

**C3 — Forced-busy and eviction.** `signal` flips `busy` on both ids with no check — mark a victim busy and all their real connection requests auto-decline, so they appear permanently unavailable. And `POST /api/leave {id:<victim>}` evicts *anyone* from the map and wipes their mailbox.

These are four exploits, but **one missing control** behind all of them.

### HIGH

**H1 — `/api/turn-credentials` unauthenticated, 24h TTL.** Any HTTP client could mint *billed* Cloudflare TURN credentials, valid for 86400s. That is an uncapped bill and a stash of harvestable 24-hour relay credentials (free bandwidth theft).

**H2 — No rate limiting anywhere.** Join flooding, signal spam, and especially poll — the heaviest route at 4 DB operations — were all callable as fast as the attacker liked. A straightforward database and serverless-cost DoS.

**H3 — No security headers.** No CSP, HSTS, or X-Frame-Options on an app that requests **camera and microphone**. That invites clickjacking the "accept connection" / grant-camera flow, and means any future injection bug escalates straight to XSS — which on this app is surveillance.

### MEDIUM

| ID | Finding |
|----|---------|
| M1 | Hard-coded Mapbox token fallback (a placeholder `pk...ck00demo...`) baked into the client bundle — masks a missing-env misconfig and renders a silently broken map. |
| M2 | `CLOUDFLARE_TURN_*` secrets undocumented in `.env.example` — operators deploy without TURN and get silent STUN-only degradation (the exact Phase-1 Bug #7 failure, recurring). |
| M3 | Inconsistent input validation — `join`/`signal` validated ids well, but `poll`/`leave` only checked id *presence* (megabyte-id risk, and a smell that invites bypasses). |
| M4 | `payload` was only size-capped, never shape-checked. |
| M5 | Dependency CVEs (postcss via Next, Prisma dev chain) — low practical exploitability; tracked, not force-fixed. |

### Severity & Priority

Findings were ranked by exploitability × blast radius, then bucketed into fix tiers. The four CRITICALs collapse to a single fix (the capability token), which is why C1–C3 share one P0 line:

| ID | Finding | Severity | Priority | Exploit in one line |
|----|---------|----------|----------|---------------------|
| C1 | Mailbox drain via poll | CRITICAL | **P0** | Poll a victim's id → steal + delete their signaling → permanent DoS |
| C2 | Impersonation via spoofed `fromId` | CRITICAL | **P0** | Offer *as* victim A → MITM the call |
| C3 | Forced-busy + arbitrary eviction | CRITICAL | **P0** | Mark a victim busy / `leave` them off the map |
| H1 | Unauthenticated TURN creds, 24h TTL | HIGH | **P0** | Mint billed relay creds at will |
| H2 | No rate limiting | HIGH | P1 | Flood join/signal/poll → DB + cost DoS |
| H3 | No security headers | HIGH | P1 | Clickjack the camera-grant flow; XSS → surveillance |
| M3 | Inconsistent id validation | MEDIUM | P1 | Oversized/odd ids reach the DB |
| M1 | Hard-coded Mapbox token fallback | MEDIUM | P1 | Masks a misconfig; silently broken map |
| M2 | Undocumented TURN secrets | MEDIUM | P2 | Silent STUN-only deploys |
| M4 | Unshaped `payload` | MEDIUM | P2 | Malformed payloads pass the size cap |
| M5 | Dependency CVEs | MEDIUM | P2 | Low real-world reach; tracked |

Plus one cross-cutting deliverable the repo lacked entirely: **CI as a merge gate.**

---

## What We Fixed

### The key fix — a server-issued capability token

The whole CRITICAL cluster closes with one mechanism. Crucially, it is a **capability, not an account** — it carries no identity, so the app stays anonymous.

- **`/api/join` mints a fresh `crypto.randomUUID()` token on every join** (rotate-on-join), stores it in a new **`Presence.token`** column (`NOT NULL`), and returns it to the client **exactly once**.
- **`poll` / `leave` / `signal` / `turn-credentials` verify the token before *any* side effect.** The 401 fires *before* the heartbeat, the reap, the peer-list read, the mailbox drain, the delete, or the Cloudflare call — so an unauthenticated request changes nothing and learns nothing. In `/api/poll` the order is explicit:

```typescript
// Verify the capability token BEFORE any heartbeat / reap / read. A missing
// row or a token mismatch is unauthenticated: do nothing.
const owner = await prisma.presence.findUnique({
  where: { id },
  select: { token: true },        // ← token is the ONLY field selected here
});
if (!verifyToken(owner, token)) {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
```

- **Verification is constant-time** (`lib/auth.ts`, `verifyToken()`), using `crypto.timingSafeEqual` — but with a length guard *first*, because `timingSafeEqual` throws on unequal-length buffers:

```typescript
if (stored.length !== provided.length) {
  return false;                   // length-guard BEFORE timingSafeEqual (which throws)
}
return timingSafeEqual(stored, provided);
```

- **The token never leaks.** The peer list select stays `{ id, lat, lng, busy }` — the token is deliberately *not* selected, so poll can never return it to other peers. It is never logged and never placed in an error body.
- **Transport (stakeholder ruling):** the token rides in the **body or query param**, never a custom header — because `leave` uses `navigator.sendBeacon`, which can't set headers. So `poll` and `turn-credentials` take `?id=&token=`; `signal` and `leave` carry it in the JSON body.

### H1 — TURN credentials gated and short-lived

`/api/turn-credentials` is now **token-gated** (no Cloudflare call happens without a valid token — the 401 fires first), and the TTL is cut from **86400s to 600s**. The TTL was reconciled with the existing `Cache-Control: private, max-age=300`: 300 < 600, so a cached credential can never be handed out already expired.

```typescript
// 24h → 10min. Must stay safely GREATER than the Cache-Control max-age (300s)
// so a cached credential is never served already-expired.
const TURN_CRED_TTL_SECONDS = 600;
```

### H2 — Postgres-backed, fail-open, pool-safe rate limiter

A fixed-window limiter (`lib/ratelimit.ts`, new **`RateLimit`** table with composite PK `(key, route, window)`) on `join` / `signal` / `poll`. Two stakeholder-binding properties are designed in, not bolted on:

- **FAIL-OPEN** — any DB error returns `{ allowed: true }`. The limiter is abuse mitigation, not an authz control (the token is what gates access), so it must never be able to lock out a real user.
- **POOL-SAFE** — a single parameterized upsert, **no transactions**, so it can't exhaust the ~10-connection pool under the 1500ms poll cadence.

```typescript
} catch {
  // Fail open — never throw, never log the key.
  return { allowed: true };
}
```

- **The key is sha256-hashed** before it touches the table, so no raw id or token is ever persisted in `RateLimit`.
- **Thresholds** (10s window): poll **30**, signal **60**, join **10**. The poll cadence is 1.5s → ~6–7 polls per window, so a normal client sits at roughly **4x headroom** and is never throttled.
- **Counters are reaped lazily inside `/api/poll`** (no cron), consistent with Phase 1's presence/signal reaping.

### H3 — Security headers and CSP (`next.config.ts`)

A full header set applied to every route: **CSP**, **HSTS** (`max-age=63072000; includeSubDomains; preload`), **X-Frame-Options: DENY**, **X-Content-Type-Options: nosniff**, **Referrer-Policy: no-referrer**, and a **Permissions-Policy** scoping `camera`/`microphone`/`geolocation` to `self` (the app needs all three, so they're allowed same-origin rather than disabled).

The CSP was authored as explicit, auditable directives. The non-obvious part — and a stakeholder *verification condition* — is that `connect-src` deliberately allows Mapbox plus the Cloudflare TURN/STUN hosts, with `worker-src blob:` and `media-src blob:`, or the map and relayed calls would break:

```
connect-src 'self' https://*.mapbox.com ... stun: turn: turns: \
  stun:stun.cloudflare.com:3478 turn:turn.cloudflare.com:3478 turns:turn.cloudflare.com:443
worker-src 'self' blob:   # Mapbox GL runs its renderer in a blob:-backed worker
media-src 'self' blob:    # WebRTC media streams are exposed as blob: URLs
```

### M-tier hardening

- **M3** — a unified `lib/validate.ts` `isValidId` (string, 8–64 chars, conservative charset) is now applied to **every** id-bearing route: `poll`, `leave`, `signal` (both `fromId` and `toId`), and `join`.
- **M4** — a bounded `payload` check: string, 64KB cap, and a valid `type` enum.
- **M1** — removed the hard-coded Mapbox fallback so a missing token surfaces instead of rendering a broken map.
- **M2** — documented `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` as **server-side only** in `.env.example`.
- **M5** — dependency CVEs tracked (a non-blocking `npm audit` in CI) rather than force-fixed; none are practically exploitable here.

### Client (`app/page.tsx`, `lib/api.ts`, `lib/webrtc.ts`)

The client **captures the token from `join`**, holds it in a ref for the session, and threads it into every `poll` / `signal` / `leave` / `turn` call. The interesting part is the **401 recovery**: a 401 re-mints the token via re-join, but with **exponential backoff** and a **give-up ceiling** — after 5 consecutive failures the client shows a "Session expired, reload" notice rather than retrying. A persistent 401 therefore degrades to a single message instead of a request storm.

### CI (`.github/workflows/ci.yml`)

The merge gate the repo never had: on push and PR, **install → lint → typecheck → test → build**, plus a non-blocking `npm audit`. CD stays on Vercel (native). One deployment gotcha: the build needs a dummy `DATABASE_URL` because `lib/prisma.ts` throws at module load if it's absent.

---

## A Note on the Merge Conflict

Phase 2 merged to `main` while this branch was in flight, and it had also touched `WorldMap.tsx`. The conflict resolved cleanly: Phase 2 had already replaced the placeholder Mapbox token with `?? ""` (which satisfies **M1**) and kept its `peerColor` refactor, so `main`'s side was taken there. No security work was lost.

---

## Verification

- **Code review:** APPROVE WITH NITS — no blockers.
- **Security re-audit:** **SHIP.** Every CRITICAL (C1–C3), HIGH (H1–H3), and MEDIUM (M1–M4) verified **CLOSED against the actual code** — the 401 was confirmed to fire *before* every side effect on every gated route. Two residual **LOW** findings were knowingly accepted:
  - The CSP still uses `'unsafe-inline'`/`'unsafe-eval'` on `script-src` (no live XSS sink exists today; the nonce pipeline is Phase 4 work).
  - A 400-vs-401 id oracle (a missing row 401s, an invalid id 400s) — negligible over a 122-bit UUID space.
- **Tests:** the suite grew from **24 (Phase 2) to 77 passing** — covering token verification, input validation, fail-open rate limiting, per-route auth-gating, client token threading, and the new `join` route. `tsc` clean, lint clean, production build succeeds.
- **Schema:** `Presence.token` added + new `RateLimit` table, via migration `20260613121000_phase3_token_and_ratelimit`.

---

## Phase 3 Change Summary

| Area | Change | Thinking |
|------|--------|----------|
| `lib/auth.ts` (new) | `verifyToken()` — constant-time compare, length-guarded | One verification path; can't leak timing or throw on bad input |
| `app/api/join/route.ts` | Mint + return a `crypto.randomUUID()` token per join (rotate-on-join) | The capability that proves ownership without an account |
| `poll` / `leave` / `signal` / `turn-credentials` | 401 before any side effect; token never selected into peer list | Close C1–C3 + H1 with one control; the public id is no longer proof |
| `lib/ratelimit.ts` + `RateLimit` table (new) | Fixed-window, fail-open, pool-safe, sha256-keyed limiter on join/signal/poll | Mitigates DoS without ever locking out real users or draining the pool |
| `next.config.ts` | CSP + HSTS + X-Frame-Options/nosniff/Referrer/Permissions-Policy | Clickjacking + XSS hardening; CSP tuned so Mapbox/TURN still work |
| `lib/validate.ts` (new) | `isValidId` (8–64, charset) on every id-bearing route; bounded `payload` | Consistent boundary; no oversized/unshaped input reaches the DB |
| `app/api/turn-credentials/route.ts` | Token-gated; TTL 86400s → 600s; reconciled with 300s cache | No free billed creds; cached cred never served expired |
| `app/page.tsx` / `lib/api.ts` / `lib/webrtc.ts` | Capture + thread the token; 401 → backoff re-join with give-up ceiling | Auth on every call; a persistent 401 can't become a request storm |
| `.env.example` | Document `CLOUDFLARE_TURN_*` as server-side only | No more silent STUN-only deploys (M2) |
| `.github/workflows/ci.yml` (new) | install → lint → typecheck → test → build + non-blocking `npm audit` | The merge gate the repo lacked; CD stays on Vercel |

**Total:** 4 CRITICAL, 3 HIGH, and the M-tier findings closed; tests 24 → 77; one schema migration; CI added.
**Risk:** Low — the gating is additive and fail-open where it must be; all tests green, re-audit verdict SHIP.

**Deferred to Phase 4 (noted, not done):**
- Tighten the CSP to a **nonce/hash pipeline** and drop `'unsafe-eval'` once Mapbox GL's worker requirement is confirmed.
- **TURN credential re-fetch (ICE restart)** for calls that outlive the 600s TTL — there is already a `TODO` for this in `lib/webrtc.ts`.

**Phase 3 deliverable:** A coordination API that can be shown to strangers — every session-altering call proves it owns the session via an anonymous capability token, billed and abuse-prone routes are gated and rate-limited, the app ships clickjacking/XSS headers around its camera and mic, and a CI merge gate stands behind it all — with no regression to the Phase 1 functionality or Phase 2 polish.

---
---

# Phase 4: Make It Alive — "Reciprocal Video" (Mutual-Presence Privacy)

**Status:** Complete
**Scope:** A new, self-designed feature built on the Phase 1–3 base. Touches the video-call path and its UI only — the signaling API, the auth/token model, and the connection state machine are untouched. Presence rides the *existing* WebRTC data channel; **no new API route, no new DB column.**

---

## The Brief & The Thinking

The Phase 4 brief was open-ended: *build something new that makes Pulse feel more alive and/or safe — a unique feature of your own design.* The constraint we set ourselves was that whatever we shipped had to fit Pulse's three values — **anonymous** (no identity), **frictionless** (no new user action), **transient** (no new persistent state) — and, above all, be **honest**: it must not claim a protection it can't actually deliver.

### The pivot (this is the judgment call worth telling)

We first explored and partly built a different feature: a Signal-style **SAS "Safety Phrase"** — a short authentication string derived from the WebRTC fingerprints so two strangers could read it aloud and verify their encrypted channel wasn't being man-in-the-middled by the signaling relay. It's a real, respectable cryptographic primitive. **We rejected it on reflection**, for reasons that are themselves the point:

- It is only meaningfully verifiable **over live video** (you have to see/hear the other person say the phrase), which is a narrow window.
- It protects against **operator-MITM** — a sophisticated, *hard-to-feel* threat. For an anonymous stranger app, the actual person you're talking to has no identity to bind the phrase to, so "verified" doesn't mean much.
- The compare-the-phrase-in-chat framing risked **false confidence** — the worst outcome in a safety feature, because it makes a user feel safer without being safer.

We also considered and **rejected outright a "block screenshots" idea**: no web API can prevent screenshots, and shipping a button that claims to would be the same false-confidence trap in a louder costume.

So instead of chasing a threat strangers can't feel, we attacked the one they *can*: the **asymmetry**.

### What the real fear is

The genuine fear with stranger video isn't the operator quietly MITM-ing your call. It's **the person on the other end lurking on you, or recording you, while you believe they're engaged.** That asymmetry — you're present and exposed; they're absent and watching — is the trust failure that actually happens. So the feature removes it by construction: **you are only visible while they are too.**

---

## What It Is

**Reciprocal Video.** During a video call, clear video is transmitted **only while both peers' browser tabs are present.** The instant either side switches away (tab hidden, or the page is unloading), that side's **outgoing video track is disabled at the source** — real black frames from the media pipeline, *not* a cosmetic CSS blur — and each side sees an honest "stepped away" state. **Audio keeps flowing throughout.** On return, video resumes once both sides are present again.

The result: you literally cannot watch — or record a clear feed of — a stranger who isn't present with you. It kills one-sided lurking and recording, and as a bonus it makes the call feel *alive*: the video breathes with mutual presence.

### Why it fits Pulse

- **Anonymous** — it binds to nothing about who you are; it's purely about who's *present*.
- **Frictionless** — zero user action. There's no button, no setup; it's automatic the moment a video call is active.
- **Transient** — presence rides the existing data channel as control messages; there is no DB write and no new API call.

### The honesty line (a hard design constraint)

We **cannot** prevent screenshots or screen recording, and the UI **never claims to.** This is enforced in the copy: detection is **tab visibility/focus only — not gaze** — so every string says **"stepped away"** / **"tab inactive"**, and never "looked away." (`VideoPanel.tsx` copy: *"Stranger stepped away — their video pauses while their tab is inactive. Audio is still connected."*) The honest, exact claim the feature makes is: **"you're only visible while they are too"** — no more.

---

## How It Works (technical)

**Presence detection** (`app/page.tsx`, the mutual-presence engine effect):
- Driven by `document` `visibilitychange` plus `pagehide`/`beforeunload` — deliberately **not** `window` blur, which is too twitchy (alt-tab, clicking a dev console, a notification all fire it and would strobe the video).
- Going hidden is **debounced 500ms** (`AWAY_DEBOUNCE_MS`) so a momentary flick doesn't cut the feed; `pagehide`/`beforeunload` cut **instantly, no debounce** (unload is the most dangerous "absent" state).
- Resuming **settles 150ms** (`RESUME_DELAY_MS`) and re-checks mutual presence at fire time, so rapid flap-back doesn't strobe.

**Signaling** — peer-to-peer over the existing data channel. `PeerControl` (in `lib/webrtc.ts`) was extended with two messages, `presence-present` and `presence-away`, sent via the existing `sendControl()`. No new API route, no DB.

**Fail-closed heartbeat** — `presence-present` doubles as a periodic heartbeat: each present peer pings every **2s** (`HEARTBEAT_INTERVAL_MS`). If **no ping arrives within 4s** (`HEARTBEAT_TIMEOUT_MS`) — e.g. the data channel silently dropped — the peer is treated as **away** and the outgoing video is cut. A dropped channel can therefore never leak a clear feed. The peer state also **initializes to away** (fail-closed). To avoid a normal call starting with ~2s of black video, an immediate `presence-present` is sent the moment the engine activates, so the peer clears its fail-closed default within ~1 RTT.

**The protective core** — `PeerSession.setOutgoingVideoEnabled()` in `lib/webrtc.ts` toggles `track.enabled` (flipping both the local `MediaStreamTrack` and the matching `RTCRtpSender` track). Per the WebRTC spec this transmits **black frames with no renegotiation.** This is the reliable primitive *precisely because* the obvious alternative isn't: a canvas/CSS blur **cannot run while the tab is hidden** — `requestAnimationFrame` is throttled/paused in a background tab, which is exactly when protection is needed. A blur is also cosmetic and wouldn't stop a recorder. Disabling the source track is enforced by the media pipeline regardless of tab state.

**State hygiene** — all presence state is reset on teardown / `endVideo` (`resetPresence()` returns `peerAway` to its fail-closed `true`), so it never leaks across peers. **Audio is never cut.** A chat-only connection runs none of this — the engine is gated on `video === "active"`.

---

## Key Decisions & Honesty

- **Advisory to the connection, never punitive.** It never drops the call; it only pauses *video clarity*. Audio and chat continue.
- **Non-optional — no disable toggle.** A privacy feature you can quietly switch off invites coercion ("turn it off so I can see you"). Making it unconditional is the safer default.
- **Tab-hidden trigger, not window-blur, for v1** — to avoid false pauses; **fail-closed** on any unknown/stale presence.
- **Call-start flicker, handled honestly.** Because the peer initializes fail-closed (`peerAway = true`), a fresh call could otherwise flash a "Stranger stepped away" overlay before the first heartbeat. A `peerHasBeenPresent` latch gates the mid-call away overlay (and its screen-reader announcement) so a new call reads *waiting → live*, never *waiting → stepped-away → live*. Before the stranger has been seen present even once, the held state uses neutral tab/presence language, never "they're away."

**What it does NOT do (stated plainly, in the UI and here):**
- It does **not** prevent screenshots or screen recording of the clear feed during legitimate mutual presence.
- It does **not** protect against a compromised endpoint (malware on the peer's machine, a modified client).
- It relies on **tab presence, not gaze** — a present-but-not-looking peer is, correctly, treated as present.

---

## How We Worked & Verification

Built through the full subagent pipeline: `project-manager` → `stakeholder` (gate) → `backend-engineer` + `frontend-engineer` → `ui-ux-critic` + security/QA review → fixes → `code-reviewer` (**APPROVE**) → `qa-engineer` (**no blockers**).

- **Tests: 98 passing** (up from Phase 3's 77), including `setOutgoingVideoEnabled()` — the protective primitive — and the away-state UI matrix (only-peer-away / only-local-away / both-away, plus the call-start fail-closed case). `tsc` clean, lint clean, production build succeeds.
- Transparently: the `page.tsx` presence engine was **once lost to an editing mistake and reconstructed from the spec + review notes.** The recovery was clean — it was re-reviewed and the suite is green — but it's worth recording that it happened.

> The rest of Phase 4 was built on the same branch (`feature/phase-4-privacy-shield`), iterating on this base. The four follow-on pieces below each went through the same pipeline; the running numbers in the closing summary reflect the whole arc.

---

## Iteration: Live Self-View (clone-and-gate)

**The problem, found in real use.** The first Reciprocal Video version gated the **shared** camera track. That was correct for the *peer's* protection, but it had an unintended local cost: when the stranger stepped away and we cut our own outgoing video, our **own self-view went black too.** In testing this read as a bug — *"why did my camera turn off? I'm right here"* — and it quietly undermined the feature's honesty, because the present user looked punished for the absent peer's absence.

**The fix — split the track.** `startVideo()` now sends a `clone()` of the camera video track and gates **only the clone** (`sentVideoTrack`, born `enabled = false` — fail-closed). The **original** track stays in `localStream` and drives the local `<video>` self-view, which is **never** disabled. A clone shares the same camera source but carries its own independent `.enabled`, so the transmitted feed can go black without ever darkening the local preview. Net effect: **the present user always sees themselves**, while the absent peer still receives black frames — identical protection on the wire, none of the local confusion.

`VideoPanel` followed: instead of a black "Paused" box, the self-view now shows the **live** local preview with a compact **"Not shared"** badge, so the user can see both that they're on camera *and* that nothing clear is currently going out.

**Security re-audit.** Splitting the track touches the protective core, so this got a focused re-review. No clear-frame leak path: only the gated clone is ever attached to an `RTCRtpSender`; it is born disabled; `setOutgoingVideoEnabled()` still iterates the video senders for defense in depth; and `stopVideo()` stops **both** the original and the clone on teardown (the clone holds its own handle on the camera source). Verdict: **ship.** Files: `lib/webrtc.ts` (`sentVideoTrack` clone + gate), `app/components/VideoPanel.tsx`.

---

## Follow-on: UI/UX Pass

Driven by a full `ui-ux-critic` audit of every surface, not a cosmetic polish. Shipped in three batches.

**Batch 1 — Map accessibility (the most serious finding).** The core action of the whole app — tapping a stranger's dot to say hello — was a ~15px, pointer-only, **keyboard-unreachable** target. That's an action-blocking accessibility failure, not a nicety. Fixes:
- Each dot is now a **transparent 44px button** wrapped around the ~15px visible core (meets the touch-target minimum without changing the visual), fully **keyboard- and screen-reader-operable.**
- The **"N signals nearby"** chip became an accessible **disclosure list** of the nearby signals (Escape and outside-click close it; focus returns to the chip on close).
- Added a **"Tuning in…"** map loading state, a first-entry **"Tap a signal to say hello"** coach hint, and a **zero-peers reassurance card** so an empty map reads as *quiet*, not *broken*.

**Batch 2 — Seam / feedback states.** The gaps between states are where a stranger app feels unreliable:
- The **incoming connection prompt now auto-expires ~2s before** the requester's 30s timeout, so a late "Connect" can't accept into a peer the other side has already torn down.
- Transient notices were **raised above panels (`z-50`)** so they're never occluded by the video/chat surfaces.
- The **"Session expired"** message became a **persistent danger card with a real Reload button**, distinct from transient toasts — a terminal state should not look like a notification that fades.

**Batch 3 — Panel polish.**
- The **"Not shared"** PiP badge collapsed from a 4-line wrap to **one compact pill.**
- The pre-call video wait now **escalates after ~9s** ("Still waiting — they may be having camera trouble") so a stall is explained rather than silent.
- `ChatPanel`'s **"Say hello."** empty state only appears **once connected**; during the handshake it shows a quiet **"Connecting…"** body instead of inviting a message into a channel that isn't open yet.

---

## Follow-on: Identity — Call-Signs

**The problem.** Strangers were distinguishable only by their `peerColor`. Color is unspeakable ("the blue one" breaks down with two blues), unmemorable across a session, and **invisible to color-blind users** — so the only identity signal failed exactly the people who most need a non-color cue.

**What it is.** A new `lib/callsign.ts` derives a deterministic two-word **"Adjective Noun"** handle (e.g. *"Quiet Fox"*) from `peerId`. It hashes the id with **FNV-1a** (the same hashing voice as `peerColor`), then takes **two different 6-bit slices** — low bits → adjective, high bits → noun — into two curated **64-entry** atmospheric wordlists (`& 63`, so no modulo bias). It is pure and synchronous — no storage, no randomness, no `Date` — so the same id always yields the same handle.

**Deliberate constraints, all enforced in code:**
- The two wordlists are **disjoint**, so a same-word pairing like *"Dusk Dusk"* is impossible by construction — a handle never looks like a bug.
- **"Signal" / "Beacon" are excluded** from the words, so a handle can never collide with the app's own vocabulary or with the `"Quiet Signal"` fallback used for an empty/undefined id.
- It is **paired with, never replaces, `peerColor`.** Uniqueness is the color's job, so there is **intentionally no runtime collision handling** — call-signs are *allowed* to collide, and that's the design, not a gap.
- It is **ephemeral per session** and implies **no account** — consistent with Pulse's anonymity.

Shown consistently in the **map peer-list**, the **ConnectionPrompt**, and the **ChatPanel header**, so the same stranger reads as the same call-sign everywhere.

**Also in this batch (smaller `ui-ux-critic` items):** the EntryGate **reduced-motion beacon** now gives the rings a resting opacity so they don't vanish entirely under `prefers-reduced-motion` (matching what VideoPanel already did); **"End chat" vs "End video"** as a deliberate severity pair; and an **EntryGate CTA min-width** so the label swap doesn't reflow the button. The proposed **mono-tracking sweep was deliberately dropped** as imperceptible churn — not worth the diff. This batch also established the **first component tests** (RTL / jsdom), including **keyboard coverage of the map peer-list.**

---

## Follow-on: Live Typing Indicator

**What it is.** A `{ t: "typing", on }` message rides the **existing WebRTC data channel** — ephemeral, never stored, **no API, no DB** — consistent with the same privacy model as presence. `lib/webrtc.ts` gained `sendTyping()`, an `onTyping` callback, and a guarded inbound branch (`msg.t === "typing" && typeof msg.on === "boolean"`). `page.tsx` holds `peerTyping`, and **clears it on any incoming message and on teardown**, so a typing state can never leak across peers.

`ChatPanel` shows a **"{call-sign} is typing…"** bubble with breathing dots in the **peer's color** (reduced-motion → static dots; `aria-live="polite"` for screen readers). The composer announces typing **on input, throttled (~1.5s)** with a **~2.5s idle retract** — and it also retracts on **send / empty field / unmount**, and **never fires while disconnected** (`safeSend` no-ops on a closed channel, so it's lifecycle-safe regardless).

**One nice refinement:** on an empty thread, the **"Say hello."** empty state **yields to the typing indicator**, so the very first moment of a chat — the stranger starting to type — isn't cluttered by the prompt that's about to be answered.

---

## Phase 4 Change Summary

| Area | Change | Thinking |
|------|--------|----------|
| `lib/webrtc.ts` — `PeerControl` | Added `presence-present` / `presence-away` control messages | Presence rides the existing data channel; no new API or DB |
| `lib/webrtc.ts` — `setOutgoingVideoEnabled()` (new) | Toggle `track.enabled` (clone + sender), no renegotiation | The reliable protective primitive; a blur can't run in a hidden tab |
| `lib/webrtc.ts` — `sentVideoTrack` clone | Send a `clone()` of the camera track and gate only the clone; original stays live for the self-view | Protect the peer without blacking out the present user's own preview |
| `app/page.tsx` — mutual-presence engine | `visibilitychange`/`pagehide` detection, 500ms away-debounce, 150ms resume, 2s/4s fail-closed heartbeat, immediate-present on start, reset-on-teardown | Cut instantly, resume carefully; a dropped channel can never leak a feed |
| `app/components/VideoPanel.tsx` | Honest "stepped away / tab inactive" overlays + away-state matrix; `peerHasBeenPresent` latch; live self-view + compact "Not shared" pill; reduced-motion beacon | The claim is "visible only while they are too"; the present user always sees themselves |
| `lib/callsign.ts` (new) | Deterministic FNV-1a two-word "Adjective Noun" call-sign from `peerId`; disjoint 64-word lists; no collision handling | A speakable, color-blind-safe identity *paired with* peerColor; uniqueness stays the color's job |
| `WorldMap`/`ConnectionPrompt`/`ChatPanel` — accessibility & identity | 44px keyboard-operable dots, accessible nearby-signals disclosure, map loading/coach/zero states; call-sign shown everywhere; severity-paired End controls | The core action must be keyboard-reachable; the same stranger reads the same everywhere |
| `lib/webrtc.ts` + `ChatPanel` — typing indicator | `sendTyping()`/`onTyping` over the data channel; throttled announce + idle retract; "{call-sign} is typing…" bubble | A live sign of life with the same ephemeral, no-DB model as presence |

**Total:** Reciprocal Video (clone-and-gate self-view + the mutual-presence engine and its UI) + a full UI/UX accessibility pass + the call-sign identity layer + a live typing indicator — all over the existing data channel, with **no new API route and no schema change**. Tests grew across the arc from **77 (end of Phase 3) → 98 (Reciprocal Video) → 140 passing** (the follow-ons, including the first RTL/jsdom component tests). `tsc` clean, lint clean, production build clean.
**Risk:** Low — additive to the video/chat path, fail-closed by design, audio/chat untouched, chat-only calls unaffected; all tests green, code review APPROVE, QA no-blockers. Shipped on `feature/phase-4-privacy-shield` (PR #7).

**What I'd do next (with more time):**
- **Make the presence engine unit-testable.** Extract a *pure presence reducer* into `lib/` so the heartbeat / debounce / fail-closed gate logic can be tested without rendering the page. Today it's covered by the `setOutgoingVideoEnabled` primitive test plus manual QA; `lib/presence.ts` currently holds only the shared cadence constants, which is the natural home for the reducer.
- **An optional window-blur trigger as a stricter sensitivity tier** (off by default to avoid the false-pause problem), for users who want the tightest possible gate.
- **A brief first-run explainer** of *why* the video pauses, so the behavior never reads as a bug.
- **A richer return-from-away affordance** (a clearer "they're back" moment than the feed simply resuming).
- **Explore gaze / face-presence detection (ML)** as an honest *stronger* signal than tab focus — with the same hard honesty rule: only claim what it actually verifies.

**Phase 4 deliverable:** A self-designed "make it alive *and* safe" arc — Reciprocal Video (clear video flows only while both strangers are present, enforced at the media source on a gated clone so your own self-view never goes dark, fail-closed against dropped channels), a full UI/UX accessibility pass that makes the core action keyboard-reachable, speakable color-blind-safe **call-sign** identity, and a live **typing indicator** — every piece built on the existing data channel with copy that claims exactly what it delivers, no new API, no schema change, and no regression to Phases 1–3.

---
---

# Phase 4 (continued): Make It Safe — Spam Resistance & "Block & Next"

**Status:** Complete (built after the Reciprocal Video arc above, on the same `feature/phase-4-privacy-shield` branch)
**Scope:** Two abuse-resistance features for anonymous 1:1 chat — a P2P chat **rate-limit clamp** and **Block & Next**. Frontend-only: no new API route, no schema change, no persistence. The whole arc is a study in *honest scoping* — figuring out which "anti-abuse" features the architecture can actually deliver, and refusing the ones that would be theater.

---

## The Brief & The Thinking

The trigger was a product question: add a **screenshot/recording deterrent** ("peer may be recording"), **content moderation**, and a **spam blocker**? Two of the three hit architectural walls, and naming them is the point:

- **Recording detection is impossible.** No browser API tells you the peer screenshotted or screen-recorded. OS-level capture is invisible to the page. A "peer may be recording" notice would fire on *no real signal* — the same false-confidence trap we rejected with the SAS phrase and the "block screenshots" idea earlier in Phase 4. Declined.
- **Content moderation fights the architecture.** Chat travels **peer-to-peer**; the server never sees message content (that's the privacy model). Server-side moderation is impossible without routing content through the backend and breaking the no-persistence spine. Client-side moderation of 1:1 anonymous chat is low-value and trivially bypassed. The correct safety primitive for 1:1 isn't moderation — it's **block/disconnect**. Declined (redirected to Block & Next).
- **Spam blocking is partially tractable** — and became the first feature.

The honest through-line: in a P2P system you **cannot trust the remote client** (it's editable JS), and the server **cannot see P2P traffic**. So abuse defense has to be **receiver-side**, and it has to be honest about being a *mitigation*, not a *prevention*.

---

## Feature A: The P2P Chat Rate-Limit Clamp

**Why the Phase 3 limiter doesn't apply.** Phase 3 added a Postgres rate limiter on the HTTP API — but chat messages never touch the API. They ride the **WebRTC data channel**, peer-to-peer. The server is blind to them by design, so server-side rate limiting can't see a chat flood.

**Where enforcement must live.** A sender-side throttle is editable by a malicious peer, so it can only be a UX guardrail. The real defense is **receiver-side**: each client clamps the messages it *receives*. You only control your own client, so the side being protected does the enforcing.

**What shipped:**
- **Inbound clamp** (`lib/webrtc.ts`) — a token-bucket on inbound chat at the single `dc.onmessage` choke point. Excess chat is **dropped silently** before it renders, protecting the local render path from a flood.
- **Type-awareness (non-negotiable)** — *only* `t:"msg"` (chat) is clamped. `t:"ctrl"` (presence heartbeats + reciprocal-video signaling) and `t:"typing"` are **never** throttled. This is the one place the feature could have done harm: a blanket channel throttle would drop heartbeats → false "peer away" → cut video at the 4s timeout, **regressing the shipped Reciprocal Video shield.** Locked in with explicit invariant tests (a chat flood must never drop a `ctrl` frame).
- **Outbound cooldown** (`app/components/ChatPanel.tsx`) — because the peer drops your excess *silently*, an honest fast-typer's real messages would vanish on the other end with no feedback. So the composer shows a cooldown at the same limit. Crucially, **only sending is gated — the input stays enabled** (disabling a focused input drops focus to `<body>` and ejects an active typer; the ui-ux-critic caught this). The draft is never lost or queued.
- **One shared constant** (`lib/chatRate.ts`) — both sides import `CHAT_RATE`, so inbound and outbound limits can never drift.

**The clock-skew honesty fix (QA finding).** The honesty invariant is *"a compliant sender is never silently dropped by a compliant receiver."* Equal capacity holds only **numerically** — across two **independent wall clocks**, boundary jitter can let the sender's bucket grant a token while the receiver's is still empty, silently dropping a compliant message. The fix: the **inbound clamp runs strictly more permissive** than outbound (a small grace), so "outbound ≤ inbound" holds **temporally**, not just on paper. Proved with a two-bucket lagging-clock test.

**The honest framing (stakeholder ruling).** This was scoped *down* from "abuse protection / security core" to what it actually is: a **render-flood clamp**. Tab-close already neutralizes most of the threat; a determined spammer can fork the client. The naming had to stay honest — the same discipline as the rest of Phase 4. The stakeholder also **rejected** an inbound "peer is sending too fast" indicator (silent drop is more honest; you don't owe an attacker UX) and a `ctrl`-flood guard (pure-adversary, no honest-user story).

---

## The Realization: Rate-Limiting Can't *Prevent* Spam

In real use, the limit didn't appear to stop anything — a user sent a dozen messages and they all went through. That surfaced the honest truth, and it's worth recording because it drove the next feature: **client-side rate limiting cannot prevent a determined spammer.** The remote client is editable JS — delete the cooldown and blast away. The only thing your client controls is **its own render path** (which the inbound clamp protects). And your *own* sent messages always render locally — hiding them from yourself would be pointless. Rate-limiting clamps a *symptom*. The *cure* for an abusive peer in anonymous 1:1 is to **refuse them** — Block & Next.

---

## Feature B: Block & Next

**Architecture finding that reshaped it.** Discovery is **manual map selection** — there is no matchmaking. So **"Next" is not "auto-connect to a new stranger"** (that would be inventing matchmaking the app deliberately lacks). It means: tear down, return to the map, and the blocked peer is **gone from it.** The stakeholder explicitly rejected auto-advance.

**What shipped (three surfaces, one ephemeral blocklist):**
- **The blocklist** is an in-memory `useRef<Set<string>>` in `page.tsx` — no DB, no `localStorage`, no schema. It dies with the tab *on purpose* (see the honesty ceiling).
- **Block** (`blockPeer()`) — captures the peer id, adds it to the set, emits `end`, and tears down. It **records and tears down unconditionally**, never depending on the network emit succeeding.
- **Exclude from discovery** — the poll-tick filters blocked ids out at the single `setPeers` point, so they vanish from map dots, the accessible "Nearby signals" list, and the count. (`WorldMap` is unchanged — it renders what it's given.)
- **Auto-decline** — a blocked peer's inbound connection request is silently declined in `processSignal`, so the blocker is never re-prompted by someone they escaped — and it's **indistinguishable from a normal decline** (no "you're blocked" leak that would invite a refresh-for-new-identity or escalation).
- The two pure decisions were extracted to `lib/blocklist.ts` (`filterBlockedPeers`, `isBlockedRequest`) so they're unit-testable without rendering the heavy page.

**The honest ceiling (stated in the UI, enforced in a test).** Peer identity is a **per-page-load UUID**, so a block is *"refuse this identity for this session."* A reload or a forked client gets a new identity and **may reappear**. The copy says **"for this session"**, banned words (forever/permanently/always/for good) are forbidden, and a test asserts a fresh `Set` doesn't block — so no future contributor can quietly "improve" the blocklist into `localStorage` and turn a session refusal into a persistence violation.

**Accessibility — the safety net must work for the people who need it most.** Block is a single-tap destructive action (a confirm modal during active abuse is friction paid by the *victim*, not the attacker), so **Undo** is the safety net. The ui-ux-critic and a focused review found and fixed real gaps:
- The original **icon-only** button read as *less* deliberate than the labeled "End chat," inverting the intended severity → gave Block a **visible label** with a heavier danger fill.
- The Undo toast was a **conditionally-mounted** live region (may not announce) and after block, `ChatPanel` unmounts so focus fell to `<body>` → switched to **persistent dual live regions** (polite + assertive, always mounted) and **move focus to the Undo button** when the toast appears, returning it to `<main>` on dismiss.
- A **ghost-focus** bug (the whole toast was `aria-hidden` while focus moved *into* it — you can't un-hide a descendant of an `aria-hidden` subtree) → hide only the redundant text span, leaving the Undo button a real, focusable, announced control.
- A **latent** defect (QA): the focus effect was keyed on a derived `hasAction` boolean, so a *second* action toast within the window wouldn't re-focus its Undo → re-keyed on the notice **nonce**. Unreachable today, but a landmine the moment a second action toast is added.

**The deliberate decision NOT to build server-side block.** The residual gap is real: a blocked peer still *sees* the blocker on their own map and gets a polite "declined" if they click. Removing that requires server-side block state. We **chose not to**, and the reasoning is the feature's thesis:
1. The safety goal is **already met** — you're unreachable and they're gone from *your* world; server-side block only changes the *abuser's* view.
2. It hits the **same evasion ceiling** — a refresh yields a new UUID and they reappear regardless. Big change (DB + API + TTL + bidirectional filtering) for a *cosmetic* gain.
3. It would make the block **look stronger than it is** — the exact false-confidence trap we've rejected all through Phase 4.
4. It would force the server to hold **"A blocked B" relationship metadata** — which cuts against the privacy-first anonymity. Keeping the blocklist in the tab keeps that knowledge where it belongs.

So the "still sees you + declined" behavior isn't a bug — it's the **honest cost of anonymity**, and "declined" is exactly right because it leaks nothing.

---

## How We Worked & Verification

Both features ran the full subagent pipeline: `project-manager` → `stakeholder` (gate) → `frontend-engineer` → `ui-ux-critic` → engineer fixes → `test-engineer` → `code-reviewer` (**SHIP**) → `qa-engineer` (**QA-READY**).

- **Tests grew across the arc: 140 → 171 (rate-limit clamp) → 188 passing (Block & Next).** New coverage: the `TokenBucket` math + type-awareness invariants + the clock-skew two-bucket test; the cooldown UX (input stays enabled, draft preserved, auto-recovery, anti-flicker floor); the `lib/blocklist.ts` predicates incl. the no-persistence honesty invariant; and the Block control's accessible name + keyboard operability. `tsc` clean, lint clean.
- **Documented test gap:** no full-page integration test for the `blockPeer → teardown → toast → focus` wiring (it needs a brittle WebRTC/poll mock chain). The *decisions* are fully unit-tested; the React-lifecycle *wiring* is covered by manual QA instead — flagged honestly rather than shipped as a flaky test.

---

## Phase 4 (continued) Change Summary

| Area | Change | Thinking |
|------|--------|----------|
| `lib/chatRate.ts` (new) | `CHAT_RATE` single constant + `TokenBucket` (injectable clock) + outbound/`Inbound` factories (inbound = capacity + grace) | One source of truth; inbound strictly more permissive so clock skew never silently drops a compliant sender |
| `lib/webrtc.ts` — inbound clamp | Token-bucket on `t:"msg"` only; `ctrl`/`typing` never throttled | Receiver-side enforcement (the peer is untrusted); protects the render path without starving the video-presence shield |
| `app/components/ChatPanel.tsx` — cooldown | Outbound cooldown at the same limit; **input stays enabled**, only send gated; draft never lost | Honest feedback for fast typers; disabling a focused input ejects them |
| `lib/blocklist.ts` (new) | `filterBlockedPeers` / `isBlockedRequest` pure predicates | The block decisions, unit-testable without rendering the page |
| `app/page.tsx` — Block & Next | In-memory `blockedRef` Set; `blockPeer()` (record + teardown, unconditional); poll-tick discovery filter; auto-decline of blocked requests; persistent live-region Undo toast with focus management | Refuse a peer for the session; ephemeral by design; the Undo safety net works for AT users |
| `app/components/ChatPanel.tsx` — Block control | Labeled "Block" button beside "End chat" (heavier danger weight); honest `aria-label`/copy | Severity legible; never overpromises ("for this session", no banned words) |

**Total:** A P2P chat **render-flood clamp** (type-aware, receiver-side, clock-skew-honest) + **Block & Next** (session-scoped, in-memory, accessible) — both frontend-only, **no new API route, no schema change, no persistence**. Tests **140 → 188**. `tsc` clean, lint clean, build clean. Full pipeline per feature; code review **SHIP**, QA **QA-READY**.
**Risk:** Low — additive to the chat path; the clamp is fail-safe (drops only excess chat, never control/heartbeat traffic); the blocklist is ephemeral and reuses the existing `teardown`/signal paths.

**What I'd do next (with more time):**
- **One focused page-level integration test** for the `blockPeer → teardown → toast → focus-to-Undo → return-to-main` lifecycle (the one path without automated coverage), behind shared `lib/api` + `lib/webrtc` mocks driven by fake timers.
- Populate the near-empty `.claude/knowledge/conventions.md` / `stack.md` stubs so reviewers have a written convention source (flagged by code review).
- **Tunable rate params** are already a single constant; a future toggle could expose a stricter/looser tier.

**Phase 4 (continued) deliverable:** Two honest abuse-resistance features for anonymous 1:1 — a **receiver-side chat flood clamp** that protects the render path without ever starving the video-presence shield and is honest across two clocks, and **Block & Next**, which refuses a peer for the session, removes them from your map, and silently declines their return — paired with a clear-eyed decision *not* to build a server-side block that would look stronger than it is. The arc's real deliverable is the **judgment**: recognizing which "anti-abuse" features the P2P/no-persistence architecture can honestly deliver, and declining the theater.

---
---

# Phase 4 (continued): Make It Navigable — Map Controls

**Status:** Complete (built after the Block & Next arc above, on `feature/phase-4-map-controls`)
**Scope:** A top-right glass control cluster on the Mapbox map (`app/components/WorldMap.tsx`). Four native buttons — zoom in / out, recenter on me, frame all signals. Frontend-only: no API, no schema, no signaling change; it drives the *camera*, nothing else.

---

## The Brief & The Thinking

The map is the hero surface, but until now the only way to move it was a wheel/pinch/drag — a pure pointer gesture. That's an obvious gap for a HUD this central, but the *honest* framing matters and shaped the whole feature.

**The accessibility claim is deliberately narrow.** The zoom buttons help low-vision, motor, and no-scroll-wheel users *zoom the map*. They **do not** add a new path for the **core connect task** — that was already solved in the Phase 4 UI/UX pass, where the keyboard-navigable **"nearby signals"** disclosure list (the bottom-left count chip) became the non-spatial way to reach a stranger. So these controls make the map *navigable*; they don't make it *connectable* (it already was). We say that plainly rather than dressing a zoom button up as an accessibility win it isn't.

---

## What Shipped (four controls)

A vertical glass stack in the **top-right** — the only HUD corner left free, by elimination: the brand mark owns top-left, the coach hint sits top-center (`left-1/2`), the presence chip is bottom-left, and Mapbox attribution is bottom-right. It mounts only when `TOKEN && ready`, like the rest of the map-dependent UI.

- **Zoom in / Zoom out** — hand-rolled glass buttons that drive Mapbox's own `zoomIn()` / `zoomOut()`. Each goes **`aria-disabled` at its zoom bound** (zoom-in at max, zoom-out at min) and the handler no-ops there; the bound flags are synced off the map's live `"zoom"` event (compared against a small epsilon, because Mapbox lands fractionally short of the exact min/max after a wheel or pinch).
- **Recenter on me** — flies the camera back to the "You are here" pin at `ME_ZOOM` (4 — "your neighbourhood of the world", the same altitude the map opens at). **`aria-disabled`, not hidden,** until a location fix lands; the `me`-live closure enables it the instant a fix arrives, no remount. It **also dims while you're already home** — centred on the pin *and* at `ME_ZOOM`, where a tap would change nothing — measured in screen pixels off the live `"move"` event (zoom-robust) so it re-lights the moment you pan or zoom away. (Only that exact no-op state dims it: centred-but-zoomed-in stays lit, because Recenter would still pull you back to the home zoom.)
- **Frame all signals** — fit-bounds to show every peer dot at once. **`aria-disabled` when there are no peers.**

### Why hand-rolled, not Mapbox's `NavigationControl`

`NavigationControl` would have dragged in a compass and white control chrome that clashes head-on with the "Signal in the Dark" dark-glass HUD. Hand-rolling the buttons keeps them in the HUD's own vocabulary (glass, `:focus-visible` ring, spring press) and lets us own the disabled state and the reduced-motion behaviour — both of which the native control doesn't give us. We still delegate the *zoom math* to Mapbox (`zoomIn`/`zoomOut` respect min/max internally, so they never throw at a bound); only the chrome is ours.

### Frame peers-only (the own pin is excluded — on purpose)

`frameAllSignals` fits the bounds over **peers only**; the user's own `me` pin is deliberately left out, so the frame answers "where are the souls?", not "what's on my screen?". Recenter already serves "take me to *me*", so duplicating the user's own position into the frame would only loosen it. The single-peer / coincident-points case has no spatial spread, so a naive `fitBounds` would slam to max zoom and read as broken — it's **clamped to `FRAME_MAX_ZOOM`** (= `ME_ZOOM`) so it lands at the same comfortable altitude as Recenter (a stakeholder tripwire, locked with a test).

---

## The Two Non-Obvious Correctnesses (both surfaced by QA)

These are the parts worth recording, because both are invisible until the exact edge hits — and both were caught in QA and fixed before merge.

### Reduced motion is respected at the JS-camera level (not in CSS)

The `globals.css` `prefers-reduced-motion` block stills *CSS* motion — but it **does not govern Mapbox's camera**, which animates in **JS**, not via CSS transitions. So a reduced-motion user would still get a swooping `flyTo`. The fix lives in the control logic: a `prefersReducedMotion()` helper reads the live preference at the moment of each camera move, and we branch ourselves — **`flyTo` → `jumpTo`** for Recenter, and **`animate: false`** on the fit-bounds. The preference is read *per move* (not cached at mount) so toggling the OS setting mid-session is honoured.

### Antimeridian-aware framing (BUG-4)

A naive `LngLatBounds` over raw peer longitudes spanning the 180/−180 seam (say, +179 and −179) reads as a **358° span**, so `fitBounds` zooms out around the whole globe **the long way**. The fix: unwrap each longitude to the **shortest arc** relative to the first peer (Mapbox accepts longitudes outside `[-180, 180]` and renders the short way), so date-line-straddling peers frame *tightly* instead of showing the entire planet. Latitude is unaffected.

---

## Accessibility Details

- **Native `<button>`s** throughout — keyboard-operable (Enter/Space) and exposed in the controls `role="group"` ("Map controls") with accessible names ("Zoom in", "Zoom out", "Recenter on me", "Frame all signals").
- **44px hit areas** (`h-11 w-11`) with a small inner glyph, meeting the touch-target minimum.
- **`aria-disabled`, not the native `disabled` attribute (BUG-5).** The unavailable state still *reaches assistive tech* (AT announces the control as dimmed/unavailable) and the handler no-ops, so the map never jitters past a hard stop — **but the button stays focusable and in the tab order.** This is the deliberate fix for a real-browser focus bug: a control that takes the native `disabled` attribute **while it holds keyboard focus** makes the browser **synchronously** blur it to `<body>`, ejecting the keyboard user from the cluster. (We first tried a focus-*rescue* — capture intent, redirect to the sibling — but the browser's blur-on-disable fires React's `onBlur`, which cleared the captured intent *before* the rescue effect ran; it only "worked" under jsdom, which doesn't auto-blur on disable. `aria-disabled` sidesteps the whole race: the button never disables natively, so focus is never taken in the first place.)
- **The global `:focus-visible` ring** is inherited, so keyboard focus is always visible.

---

## How We Worked & Verification

Ran the full subagent pipeline: `project-manager` → `stakeholder` (gate) → `frontend-engineer` → `ui-ux-critic` → engineer fixes → `test-engineer` → `code-reviewer` → `qa-engineer`. **QA surfaced both edge bugs** — the antimeridian long-way zoom (BUG-4) and the focus ejection at a zoom bound (BUG-5) — which were fixed before merge. BUG-5 took two passes: a focus-rescue attempt that a test-engineer investigation proved only worked under jsdom (the real-browser blur-on-disable fires `onBlur` before the rescue effect), which is what drove the move to `aria-disabled` — the cure that removes the race entirely.

- **Tests: 188 → 211 (+23)**, the **first component-level coverage of `WorldMap`'s controls** (`app/components/WorldMap.test.tsx`, jsdom-scoped, mapbox-gl mocked). The mock stores the `"zoom"`/`"move"` handlers so a test can adjust the reported zoom/centre and emit, exposes the camera methods as spies, and tunes `getZoom/getMinZoom/getMaxZoom/getCenter/project`. Coverage includes the four buttons' camera calls, the `aria-disabled`-at-bound flags, the no-op-at-bound guard, the **focus-stays-put** proof (focus is *not* lost when a focused zoom button reaches its bound — the BUG-5 regression), the `flyTo`-vs-`jumpTo` reduced-motion branch, the peers-only frame, the antimeridian shortest-arc (BUG-4 regression), and the **Recenter dims-when-home** behaviour (centred + at `ME_ZOOM` dims; centred-but-zoomed-in stays lit; re-lights on pan; no-op guard on click). `tsc` clean, lint clean, build clean.

---

## Phase 4 (continued) Change Summary

| Area | Change | Thinking |
|------|--------|----------|
| `WorldMap.tsx` — controls cluster | Top-right glass stack of four native buttons (`role="group"`); mounts on `TOKEN && ready` | Top-right is the only HUD corner free of the brand mark, coach hint, presence chip, and attribution; HUD-native chrome, not Mapbox's white `NavigationControl` |
| `WorldMap.tsx` — zoom in / out | Drive Mapbox `zoomIn`/`zoomOut`; `aria-disabled` + handler no-op at the bound, synced off the live `"zoom"` event (epsilon-compared) | Helps low-vision / motor / no-wheel users zoom — it does **not** add a new *connect* path (the nearby-signals list already owns that) |
| `WorldMap.tsx` — Recenter on me | `flyTo` to the `me` pin at `ME_ZOOM`; `aria-disabled` until a fix lands **and while already home** (centred + at `ME_ZOOM`), synced in px off the `"move"` event | "Take me to me" — distinct from framing peers; `me`-live closure enables it without a remount; dim only when a tap is a true no-op |
| `WorldMap.tsx` — Frame all signals | `fitBounds` over **peers only** (own pin excluded); clamped to `FRAME_MAX_ZOOM` | "Where are the souls?" not "what's on my screen?"; the clamp keeps the single/coincident-peer case at a sane altitude |
| `WorldMap.tsx` — reduced motion | `flyTo → jumpTo` and `animate: false` under `prefers-reduced-motion`, read per move | The CSS reduced-motion block does **not** govern Mapbox's JS camera, so it's handled in control logic |
| `WorldMap.tsx` — antimeridian (BUG-4) | Unwrap longitudes to the shortest arc relative to the first peer | Date-line-straddling peers frame tightly instead of zooming out around the whole globe |
| `WorldMap.tsx` — `aria-disabled` (BUG-5) | At-bound controls go `aria-disabled` (not native `disabled`) and the handler no-ops | A natively-disabled focused element is synchronously blurred to `<body>`, ejecting the keyboard user; `aria-disabled` keeps it focusable so focus is never taken |

**Total:** A four-button map-controls cluster — zoom in/out, recenter, frame-all — hand-rolled in the dark-glass HUD vocabulary, reduced-motion-correct at the JS-camera level, antimeridian-aware, and fully keyboard/AT-operable (`aria-disabled`, not native `disabled`, so focus is never ejected). Frontend-only: **no API route, no schema change, no signaling change**. Tests **188 → 211 (+23)** (first `WorldMap` controls component coverage). `tsc` clean, lint clean, build clean. Full pipeline; QA caught BUG-4 + BUG-5, both fixed before merge.
**Risk:** Low — additive and read-only against state; it drives the map camera and nothing else, every control is guarded on `mapRef + ready` so a stray activation during teardown is a no-op, and disabled bounds keep it from ever fighting the map.

**What I'd do next (with more time):**
- **A "frame me + signals" mode** as an optional second framing that *does* include the own pin, for users who want themselves in the shot — kept distinct from the peers-only default so neither overloads one button.
- **Smooth the zoom-bound disable** with a brief debounce so a fast wheel-then-button sequence never flickers the disabled state.
- **Surface the controls' keyboard story** in a first-run hint, the way the map already coaches "tap a signal to say hello".

**Phase 4 (continued) deliverable:** A map-controls cluster that makes the hero surface *navigable* without a pointer — zoom, recenter, and frame-all in the HUD's own dark glass — with the honesty held throughout: the zoom buttons help people move the map, they don't pretend to be a new way to *connect* (the keyboard-reachable nearby-signals list already is that). The non-obvious correctnesses — reduced motion at the JS-camera level, the antimeridian shortest-arc, and choosing `aria-disabled` over the native attribute so a keyboard user is never ejected when a control reaches its bound — are the parts that make it actually work for the people the feature is for.

---

# Phase 4: Fade Trails — Ephemerality You Can See

**Status:** Shipped
**Date:** 2026-06-14
**Branch:** `feature/phase-4-felt-ephemerality`

**Brief & thinking:** The app *tells* you "nothing is kept" — messages are P2P, in-memory, and gone the moment a call tears down. But that promise was a footnote, not a feeling. Fade Trails makes it sensory: each chat message visibly dims as it ages, so you watch a thought dissolve. The same ephemerality the architecture already guarantees, now *felt* rather than claimed.

**What it is:** A chat message eases from full opacity toward a resting floor over its lifetime, then holds there. It is **purely visual** — opacity only. The text never leaves the DOM or the accessibility tree, the real (in-memory, teardown-cleared) message lifetime is unchanged, and nothing new crosses the wire. A client-only `createdAt` stamp is the only addition to the data.

**How it works:**
- **Decay model:** opacity is a pure function of `age = now − createdAt`, eased `1 − (1−t)²` over `DECAY_MS = 90s`, monotonic, then clamped at the floor. No clock baked into the value — it re-derives identically on every render.
- **Per-style floor (the AA fix):** mine bubbles are an opaque signal fill and dim safely to `0.35`. Incoming bubbles are translucent text over the live map, so a shared `0.35` floor composited to ~2.7:1 — below WCAG AA. Incoming therefore floors at `0.55` (measured ~4.8:1, passing). The floor is chosen per bubble by `m.mine`.
- **Newest pinned full:** the most recent message is held at full opacity regardless of age, so the active line of conversation is always the most legible; older lines trail off behind it.
- **One shared ticker:** a single `setInterval` bumps a render clock so every bubble recomputes opacity from its own age — never one timer per message. It's skipped when the list is empty and cleared on unmount (no setState-after-teardown).
- **Reduced motion:** under `prefers-reduced-motion`, a coarse ticker drives a single discrete full→floor *step* at the midpoint instead of a continuous fade — branched manually in JS, because the `globals.css` reduced-motion block can't govern a JS-driven opacity loop (the same reason the map controls handle it in camera logic).

**Key decisions & honesty:** The floor is never zero and the text always stays in the accessibility tree, so the fade can never *imply* a deletion that isn't happening — a dimmed line is still plainly, readably there, because it still is. Wall-clock age means a message keeps dissolving even while the tab is hidden (time really did pass); we deliberately don't pause it. The visual decay is decoration over a truth the system already keeps, never a substitute for it.

**Change summary:**

| Area | Change | Thinking |
|------|--------|----------|
| `ChatPanel.tsx` — decay core | `decayOpacity(age, floor)` eased full→floor over `DECAY_MS`; `staticDecayOpacity` for reduced motion | Pure, testable, identical every render; the floor is a parameter so each bubble style picks its own |
| `ChatPanel.tsx` — per-bubble opacity | Floor `0.35` (mine) / `0.55` (incoming); newest pinned full | Opaque fill can dim further than translucent-over-map text without failing AA; the active line stays brightest |
| `ChatPanel.tsx` — shared ticker | One interval re-renders the list; reduced-motion uses a coarse tick + single step; cleared on unmount | One timer, not N; reduced motion gets a step, not a loop; no teardown leak |
| `page.tsx` — `addMessage` | Stamp a client-only `createdAt: Date.now()` | The only data change; never sent, never stored, drives age alone |

**Total:** Messages that dim with age to make "nothing is kept" a felt experience — opacity only, text always in the a11y tree, per-style AA-safe floors, newest pinned legible, one shared ticker, reduced-motion-correct. Frontend-only: **no API route, no schema change, no signaling change.** Tests **211 → 220 (+9 Fade Trails + 2 reduced-motion)**. `tsc` clean, lint clean. Full pipeline; UI/UX review caught the incoming-bubble contrast risk (raised to `0.55`) and a reduced-motion correctness bug (a frozen clock under `prefers-reduced-motion` that stopped any decay), both fixed before merge.
**Risk:** Low — additive and visual; it changes how a message *looks* as it ages and nothing else. The text node, layout, auto-scroll, typing indicator, and real message lifetime are untouched.

**What I'd do next (with more time):**
- **Stop the idle ticker** once every visible non-newest message has reached the floor and no new message has arrived — nothing left to animate.
- **Smooth the newest→aged handoff:** when a new message arrives, the previously-newest jumps from full to its true aged opacity in one frame; a brief transition (without fighting the entrance animation) would soften it.
- **A whisper of decay on the composer** — a faint hint that an unsent draft is also impermanent — if it can be done without nagging.

**Phase 4 (continued) deliverable:** Fade Trails turns the app's central promise into something you can watch happen. The discipline is that it's honest twice over — the floor never reaches zero and the text never leaves the accessibility tree, so the fade dramatizes an ephemerality the system genuinely keeps without ever faking one it doesn't. The non-obvious parts — the per-style AA floor, the single shared ticker, and the reduced-motion *step* instead of a loop — are what keep a pretty effect from quietly becoming an accessibility regression.

---

# Phase 4: Proximity Pulse — Explored, Then Held (a decision)

**Status:** Built, reviewed, removed — held for a properly-scoped future pass
**Date:** 2026-06-14
**History:** added `1e65d4b`, removed `cf0926e` (branch `feature/phase-4-felt-ephemerality`)

**What it was:** An ambient orb that would intensify as the nearest anonymous peer trended *closer* over a session — "turn location into a feeling, not data; someone's signal is getting stronger." It was built in full: a pure trend reducer (EMA smoothing + a hysteresis dead-band + a nearest-peer-swap reset so two different peers' distances are never compared), an ambient HUD orb with a visible trend label and a debounced screen-reader live region, reduced-motion handling, and **41 passing tests**. Every quality gate was green.

**Why it was removed:** Code review and QA, independently, found the marquee behavior can *never fire in real use*. Two facts combine: `myLocation` is captured **once** at join (there's no `watchPosition`), and each peer's privacy offset is generated **once per session** (`lib/geo.ts`). So `distance(me, peer)` is **constant on every poll** — the smoothed trend is permanently "steady", and the only other transition (a nearest-peer swap) is deliberately forced to "neutral". The "growing stronger / fading" states existed *only* in synthetic tests that injected movement the app never produces. The 41 green tests were a signal in themselves: they passed without ever exercising a real approach.

**Why not just fix it:** The honest repairs each cost more than they return right now.
- *"Make it real"* (continuous geolocation so your own movement drives the signal) cuts against the app's privacy-minimal ethos — and the truest form, reacting to a *peer* moving, needs peers to periodically re-publish location, which is a presence/backend change deserving its own design cycle.
- *"Presence-only"* (a static glow whose brightness is just the nearest peer's closeness) largely **duplicates what the map already shows** and barely changes given static per-session data.

**The decision:** Hold Proximity Pulse rather than ship something inert or redundant. *Honest by design* has to apply to our own shipping bar — a feature whose headline behavior can't happen doesn't ship just because it compiles and tests green. The exploration stays in git history; when there's a location-republishing mechanism to build it on, it returns properly scoped. This mirrors the discipline behind the earlier rejected path: prefer one feature that genuinely works to two where one only looks like it does.
