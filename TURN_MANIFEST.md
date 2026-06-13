# TURN Integration Implementation Manifest

## Overview
Cloudflare TURN server integration enables WebRTC connections across different networks (symmetric NAT traversal). The implementation consists of:
1. Backend API endpoint to fetch short-lived TURN credentials from Cloudflare
2. ICE configuration builder with graceful fallback to STUN-only
3. Async peer initialization to allow credential fetching
4. Comprehensive test suite
5. Jest infrastructure setup

This manifest covers ONLY the TURN integration changes. EXCLUDE all Phase 2 UI animations and styling changes.

---

## Files to Create

### 1. `/app/api/turn-credentials/route.ts` (NEW FILE)
**Purpose:** Fetch short-lived Cloudflare TURN credentials from the Cloudflare Realtime API

**Key Requirements:**
- Runtime: `export const runtime = "nodejs"`
- Exports: `GET()` async function
- Behavior:
  - Read `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` from environment
  - POST to `https://api.cloudflare.com/client/v4/accounts/{tokenId}/rtc/config`
  - Extract TURN server entry (has both `username` and `credential`) from response
  - Return `{ urls: [...], username: "...", credential: "..." }`
  - Set Cache-Control header to `private, max-age=300` (5-minute cache)
  - On error: return `{ error: "message" }` with appropriate HTTP status
  - Log errors to console (no user exposure)

**Response Format (Success):**
```json
{
  "urls": ["turn:turn.example.com:3478"],
  "username": "cloudflare-user-1234",
  "credential": "cloudflare-pass-5678"
}
```

**Response Format (Error):**
```json
{ "error": "message" }
```

---

### 2. `/lib/webrtc.ts` (MODIFY EXISTING FILE)
**Purpose:** Add TURN credential fetching and ICE configuration builder

**Changes:**
- Add import statement: `import { TurnCredentialsResponse }` type
- Define `TurnCredentialsResponse` interface with optional `username`, `credential`, `urls: string[]`
- Define base `ICE_CONFIG` constant (STUN-only fallback):
  ```typescript
  const ICE_CONFIG: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };
  ```
- Add **new async function** `buildICEConfig(): Promise<RTCConfiguration>`:
  - Call `fetch("/api/turn-credentials", { method: "GET", signal: AbortSignal.timeout(5000) })`
  - On fetch failure (network, timeout, non-OK response): log warning and return `ICE_CONFIG`
  - On response parse failure (invalid JSON): log warning and return `ICE_CONFIG`
  - On missing/invalid TURN data (no urls, missing username/credential): log warning and return `ICE_CONFIG`
  - On success: build config with both STUN and TURN servers, return it
- **Modify `PeerSession` constructor**:
  - Add third parameter: `iceConfig: RTCConfiguration = ICE_CONFIG`
  - Pass `iceConfig` to `new RTCPeerConnection(iceConfig)`

**Key Points:**
- All errors are graceful (fallback to STUN-only, don't throw)
- 5-second timeout on fetch via AbortSignal
- STUN server always included even when TURN is available
- No UI-level error messages in this file (handled in page.tsx)

---

### 3. `/lib/webrtc.test.ts` (NEW FILE — UNIT TESTS)
**Purpose:** Comprehensive test coverage for `buildICEConfig()` and `PeerSession` changes

**Test Suites:**
- `buildICEConfig()` — 8 test cases:
  - Success: returns RTCConfiguration with both STUN and TURN servers
  - Fetch non-OK (500): falls back to STUN-only
  - Fetch timeout (AbortError): falls back to STUN-only
  - Fetch throws (network error): falls back to STUN-only
  - Response invalid JSON: falls back to STUN-only
  - Response missing `urls` field: falls back to STUN-only
  - Response has empty `urls` array: falls back to STUN-only
  - Response missing `username` or `credential`: falls back to STUN-only

- Mock global fetch for all tests
- Verify console.warn is called on errors
- Verify console.warn is NOT called on success

---

### 4. `/app/api/turn-credentials/__tests__/route.test.ts` (NEW FILE — API TESTS)
**Purpose:** Test the `/api/turn-credentials` endpoint

**Test Suites:**
- Success: returns 200 with TURN credentials from Cloudflare response
- Error: missing `CLOUDFLARE_TURN_TOKEN_ID` — returns 500
- Error: missing `CLOUDFLARE_TURN_API_TOKEN` — returns 500
- Error: Cloudflare returns non-OK status (e.g., 401) — returns 500
- Error: Cloudflare returns `success: false` — returns 500
- Error: Cloudflare response missing `result.iceServers` — returns 500
- Error: Cloudflare response has no TURN server entry (missing username/credential) — returns 500
- Error: Network fetch throws — returns 500

**Key Points:**
- Mock global fetch to simulate Cloudflare API responses
- Verify Bearer token in Authorization header
- Verify POST method to correct Cloudflare endpoint
- Verify TURN server extraction logic (finds entry with username AND credential)
- Verify Cache-Control header is set

---

## Files to Modify

### 5. `/app/page.tsx` (MODIFY EXISTING FILE)
**Purpose:** Make `startPeer()` async and integrate TURN credential fetching

**Changes:**
- Import `buildICEConfig` from `@/lib/webrtc`
- **Change `startPeer()` signature from synchronous to async:**
  ```typescript
  async function startPeer(peerId: string, initiator: boolean) {
    try {
      const iceConfig = await buildICEConfig();
      // ... existing PeerSession constructor call
      const ps = new PeerSession(initiator, { ... }, iceConfig);
      peerRef.current = ps;
    } catch (error) {
      console.error("Failed to start peer:", error);
      teardown("Connection failed (ICE config).");
    }
  }
  ```
- All existing calls to `startPeer()` must be prefixed with `void` or `await`:
  - `void startPeer(peerId, false)` (acceptIncoming)
  - `void startPeer(peerId, true)` (requestConnection after peer selection)
- No UI changes to `startPeer()` calls (keep existing error boundaries)
- No animation or styling changes to components

**Key Points:**
- The try-catch wraps the entire `startPeer()` to catch `buildICEConfig()` errors
- Failing to fetch TURN credentials results in `teardown("Connection failed (ICE config).")`
- Same-network connections still work via STUN-only fallback in `buildICEConfig()`
- No need to change component rendering or event handlers

---

### 6. `package.json` (MODIFY EXISTING FILE)
**Purpose:** Add Jest test infrastructure

**Changes:**
- Add scripts:
  ```json
  "test": "jest",
  "test:watch": "jest --watch"
  ```
- Add devDependencies:
  ```json
  "@types/jest": "^30.0.0",
  "jest": "^30.4.2",
  "ts-jest": "^29.4.11"
  ```

**Key Points:**
- This enables `npm test` and `npm run test:watch` commands
- ts-jest transforms TypeScript test files for Jest

---

### 7. `jest.config.js` (NEW FILE)
**Purpose:** Configure Jest test runner

**Content:**
- Preset: `ts-jest`
- Test environment: `node`
- Test match patterns: `**/__tests__/**/*.test.ts` and `**/*.test.ts`
- Module name mapper: `@/(.*)` → `<rootDir>/$1` (support import aliases)
- Extensions: `.ts` files
- Coverage: lib and app/api files only (exclude node_modules and .d.ts)

---

### 8. `/app/globals.css` (MODIFY EXISTING FILE — CAREFULLY)
**Purpose:** Add only spinner animation for loading states

**IMPORTANT: EXCLUDE all Phase 2 animations**
- DO NOT add: `fade-in`, `fade-in-up`, `fade-in-down`, `scale-in`, `slide-in-right`, `slide-out-right`, `glow-pulse`, `spin-smooth`, `button-press` keyframes
- DO NOT add: `.animate-*` utility classes
- DO NOT add: `.animate-stagger-*` delay utilities
- DO NOT modify: button styles, component hover effects, box shadows, or transitions

**ONLY ADD (if needed for spinner):**
- Spinner styles needed by TURN components (ConnectionPrompt, ChatPanel, etc.) if not already present
- Keep it minimal — DO NOT expand to full animation library

**Key Points:**
- The spinner animation is for the "Connecting..." loading state
- This is PRESENT in Phase 1, so may already be in globals.css
- Do NOT add the extensive animation library that Phase 2 includes
- Compare against ONLY the Phase 1 baseline

---

## Environment Variables Required

**Production/Deployment:**
```env
CLOUDFLARE_TURN_TOKEN_ID=<your-account-id>
CLOUDFLARE_TURN_API_TOKEN=<your-api-token>
```

**Development (local .env file):**
- Create `.env.local` with above variables
- .env files are already in `.gitignore`

**Setup Instructions:**
1. Sign in to Cloudflare Dashboard
2. Go to Account Home → Calls (or Realtime)
3. Generate API token with RTC permissions
4. Copy account ID and token to environment

---

## Testing Checklist

**Unit Tests:**
- [ ] Run `npm run test` — all 30+ tests pass
- [ ] Coverage: lib/webrtc.ts and app/api/turn-credentials/route.ts

**Integration Testing (Manual):**
- [ ] Same-network connection: works with STUN-only (no TURN needed)
- [ ] Cross-network connection: works with TURN enabled
- [ ] TURN credentials timeout: falls back gracefully, connection still works via STUN
- [ ] TURN API error: falls back gracefully, connection still works via STUN
- [ ] Multiple peers: each uses fresh credentials (no cache collision)

**Browser Console:**
- [ ] No errors on page load
- [ ] No errors on peer connection
- [ ] Warnings logged (not errors) when TURN fetch fails
- [ ] No sensitive data (credentials) exposed in logs

---

## Git Integration

**Branch to cherry-pick from:** `feat/cloudflare-turn` (commit 3fa87cb)

**Files to cherry-pick (ONLY these):**
1. `/app/api/turn-credentials/route.ts` — NEW
2. `/app/api/turn-credentials/__tests__/route.test.ts` — NEW
3. `/lib/webrtc.ts` — MODIFIED (add `buildICEConfig()` and `iceConfig` param)
4. `/lib/webrtc.test.ts` — NEW
5. `/jest.config.js` — NEW
6. `/package.json` — MODIFIED (add jest scripts and devDependencies)
7. `/app/page.tsx` — MODIFIED (async `startPeer()`, import `buildICEConfig`)
8. `/app/globals.css` — MODIFIED (spinner only, NO phase 2 animations)

**Files to SKIP/IGNORE from Phase 2 UI commit:**
- `app/components/ChatPanel.tsx` — extensive styling changes (SKIP)
- `app/components/VideoPanel.tsx` — layout restructure (SKIP)
- `app/components/ConnectionPrompt.tsx` — styling changes (SKIP)
- `app/components/EntryGate.tsx` — styling changes (SKIP)
- `app/components/WorldMap.tsx` — styling changes (SKIP)
- `app/globals.css` — animation library + button/component styling (ONLY apply spinner if missing)
- Any other Phase 2 UI/UX changes

---

## Cloudflare TURN Configuration

**What buildICEConfig() does:**
1. Fetches TURN credentials from `/api/turn-credentials` endpoint
2. Endpoint calls Cloudflare Realtime API with Bearer token
3. Cloudflare returns short-lived TURN server URLs and credentials
4. Credentials are cached client-side for 5 minutes (Cache-Control header)
5. TURN servers added to RTCConfiguration alongside STUN server
6. If TURN fetch fails, falls back to STUN-only (no error thrown)

**Why this matters:**
- STUN alone cannot traverse symmetric NAT (NAT that blocks unsolicited inbound)
- TURN relays media through Cloudflare's infrastructure (guarantees connectivity)
- Credentials are short-lived (security) and cached (performance)
- Fallback ensures even TURN failures don't break same-network connections

---

## Implementation Order

1. **Create test infrastructure:**
   - Add jest.config.js
   - Update package.json (scripts + devDependencies)

2. **Create TURN API endpoint:**
   - Add /app/api/turn-credentials/route.ts
   - Add /app/api/turn-credentials/__tests__/route.test.ts

3. **Update WebRTC library:**
   - Modify lib/webrtc.ts (add buildICEConfig, update PeerSession)
   - Add lib/webrtc.test.ts

4. **Update page component:**
   - Modify app/page.tsx (async startPeer, import buildICEConfig)

5. **Update globals.css:**
   - Add spinner if missing
   - VERIFY no Phase 2 animations added

6. **Run tests:**
   - `npm run test` — all pass
   - `npm run build` — no errors
   - `npm run dev` — manual verification

---

## Key Differences from Phase 2

**Phase 2 includes (DO NOT implement):**
- Component hover effects with shadows and color transitions
- Staggered message animations (`animate-fade-in-up`)
- Spinner and loading animations throughout
- Button press animations (`active:scale-95`)
- Responsive layout changes (flex-col → flex-row on medium screens)
- Button state styling (disabled opacity, focus outlines)
- Message bubble shadows
- Chat panel slide-in animation
- Video panel fade-in and layout changes

**TURN integration includes (DO implement):**
- `buildICEConfig()` async function with fallback logic
- PeerSession `iceConfig` parameter
- Async `startPeer()` with try-catch error boundary
- /api/turn-credentials endpoint with Cloudflare API integration
- Comprehensive test suite
- Jest infrastructure
- Environment variable setup

---

## Quick Reference: File Checklist

| File | Type | Status | Notes |
|------|------|--------|-------|
| `/app/api/turn-credentials/route.ts` | NEW | Create | Cloudflare API endpoint |
| `/app/api/turn-credentials/__tests__/route.test.ts` | NEW | Create | API unit tests (8+ cases) |
| `/lib/webrtc.ts` | MODIFY | Add buildICEConfig() | Add async ICE config builder |
| `/lib/webrtc.test.ts` | NEW | Create | WebRTC unit tests (8+ cases) |
| `/app/page.tsx` | MODIFY | Make startPeer() async | Integrate credential fetching |
| `package.json` | MODIFY | Add jest + scripts | Test infrastructure |
| `jest.config.js` | NEW | Create | Jest configuration |
| `/app/globals.css` | MODIFY | Verify spinner only | NO Phase 2 animations |
| `app/components/*.tsx` | SKIP | Do not modify | All component changes are Phase 2 |
