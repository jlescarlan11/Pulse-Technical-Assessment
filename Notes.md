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
