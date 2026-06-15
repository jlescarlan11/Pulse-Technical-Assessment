# Conventions — Pulse Technical Assessment

**Last Updated:** 2026-06-13

Code style, naming patterns, and organizational conventions used throughout the project.

---

## File Naming

### Components (PascalCase)
```
app/components/EntryGate.tsx
app/components/WorldMap.tsx
app/components/ConnectionPrompt.tsx
app/components/ChatPanel.tsx
app/components/VideoPanel.tsx
```
- React components: `PascalCase` with `.tsx` extension
- One component per file
- File name matches export name (e.g., `export default function EntryGate`)

### Utilities & Libraries (camelCase)
```
lib/api.ts         # Client-side fetch wrappers
lib/geo.ts         # Privacy offset calculation
lib/presence.ts    # Constants (STALE_MS, POLL_INTERVAL_MS, etc.)
lib/prisma.ts      # Singleton Prisma client
lib/types.ts       # Shared TypeScript types
lib/webrtc.ts      # PeerSession class, buildICEConfig function
```
- Utilities and modules: `camelCase` with `.ts` extension
- Type-only files can use `.ts` (not `.d.ts` unless declaring ambient types)

### API Routes (kebab-case in URL, route.ts as filename)
```
app/api/join/route.ts
app/api/poll/route.ts
app/api/leave/route.ts
app/api/signal/route.ts
app/api/turn-credentials/route.ts
```
- All API routes export `route.ts` (Next.js convention)
- URL path: `kebab-case` (e.g., `/api/turn-credentials`)
- No versioning (no `/api/v1/`, `/api/v2/`)

### Test Files (component.test.ts)
```
lib/webrtc.test.ts
app/api/turn-credentials/__tests__/route.test.ts
```
- Test files: `[original-name].test.ts` or in `__tests__/` directory
- Jest auto-discovers `.test.ts` files

### Styles & Configuration (camelCase)
```
tailwind.config.ts
next.config.ts
jest.config.js
postcss.config.mjs
tsconfig.json
eslint.config.mjs
```
- Config files: standard naming (not customized)

---

## Variable & Function Naming

### Constants (UPPER_SNAKE_CASE)
```typescript
const STALE_MS = 15000;          // Presence TTL in milliseconds
const POLL_INTERVAL_MS = 1500;   // Polling heartbeat interval
const SIGNAL_TTL_MS = 60000;     // Signal message TTL
const REQUEST_TIMEOUT_MS = 30_000; // Connection request timeout
```
- Module-level constants: `UPPER_SNAKE_CASE`
- Numeric constants use underscores for readability (e.g., `30_000` not `30000`)

### Functions (camelCase)
```typescript
export async function buildICEConfig(): Promise<RTCConfiguration> { }
export function applyPrivacyOffset(lat: number, lng: number): { lat: number; lng: number } { }
export async function join(lat: number, lng: number): Promise<void> { }
export async function poll(id: string): Promise<PollResponse> { }
export async function sendSignal(fromId: string, toId: string, type: SignalType, payload: string | null): Promise<void> { }
```
- Exported functions: `camelCase`
- Async functions explicitly marked `async`
- Return type always specified (no implicit `any`)

### Variables & State (camelCase)
```typescript
const [sessionId] = useState(() => crypto.randomUUID());
const [peers, setPeers] = useState<PeerDot[]>([]);
const [phase, setPhase] = useState<"gate" | "live">("gate");
const [conn, _setConn] = useState<Conn>({ kind: "idle" });
const connRef = useRef<Conn>(conn);
```
- useState setters: `set{VariableName}` pattern (e.g., `setPeers`, `setPhase`)
- useRef variables: end in `Ref` suffix (e.g., `connRef`, `peerRef`, `requestTimer`)
- Private state (internal to component): `_setConn` prefix (underscore indicates "private")

### Event Handlers (on{Event})
```typescript
const handleControl = (ctrl: PeerControl) => { }
const handleOpen = () => { }
const handleSignal = (type: DescType, payload: string) => { }
```
- Event handlers: `on{Event}` or `handle{Event}` pattern
- Used in callbacks: `onOpen`, `onmessage`, `ontrack`, `onconnectionstatechange`
- Custom handlers: `handle{Action}` (e.g., `handleControl`, `handleSignal`)

---

## Type Naming (PascalCase)

### Shared Types (in lib/types.ts)
```typescript
export type SignalType = "request" | "accept" | "decline" | "offer" | "answer" | "ice" | "end";
export type DescType = "offer" | "answer" | "ice";
export type PeerControl = "video-request" | "video-accept" | "video-decline" | "video-end";

export interface PeerDot {
  id: string;
  lat: number;
  lng: number;
  busy: boolean;
}

export interface SignalMsg {
  id: string;
  fromId: string;
  toId: string;
  type: SignalType;
  payload: string | null;
  createdAt: string;
}

export interface PollResponse {
  peers: PeerDot[];
  signals: SignalMsg[];
}
```
- Type aliases: PascalCase (e.g., `SignalType`, `DescType`, `PeerControl`)
- Interfaces: PascalCase (e.g., `PeerDot`, `SignalMsg`, `PollResponse`)
- Union types: literal values in quotes (e.g., `"request" | "accept" | ...`)

### API Response Types (at top of route.ts)
```typescript
// In app/api/turn-credentials/route.ts
interface CloudflareIceServer {
  username?: string;
  credential?: string;
  urls: string[];
}

interface CloudflareRTCResponse {
  success: boolean;
  result?: {
    iceServers: CloudflareIceServer[];
  };
  errors?: Array<{ message: string }>;
}

interface TurnCredentialsResponse {
  urls: string[];
  username: string;
  credential: string;
}
```
- API-specific types: defined at top of route file
- External API response types prefixed with provider name (e.g., `CloudflareIceServer`)

---

## React Patterns

### Component Structure
```typescript
// 1. Imports
import { useState, useRef, useEffect } from "react";
import { fetchSomething } from "@/lib/api";

// 2. Type definitions (if any)
interface MyComponentProps {
  onUpdate: (value: string) => void;
}

// 3. Component
export default function MyComponent({ onUpdate }: MyComponentProps) {
  // State (all together at top)
  const [phase, setPhase] = useState<"idle" | "loading">("idle");
  const [data, setData] = useState<Data | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Effects (grouped logically)
  useEffect(() => {
    // Setup
    return () => {
      // Cleanup
    };
  }, []);

  // Event handlers
  const handleClick = () => { };

  // Render
  return (
    <div>
      {/* JSX */}
    </div>
  );
}
```

### State Management
- **Rendering state:** `useState` (affects UI)
- **Non-rendering state:** `useRef` (connection, peer session, internal counters)
- **Immutable updates:** Never mutate state; use spread operator or new references
- **State reduction:** For complex state, consider `useReducer` (e.g., page.tsx connection state machine)

### Props Down, Callbacks Up
```typescript
<ConnectionPrompt
  visible={connRef.current.kind === "incoming"}
  peerId={connRef.current.kind === "incoming" ? connRef.current.peerId : ""}
  onAccept={acceptIncoming}
  onDecline={declineIncoming}
/>
```
- Components accept data via props
- Child → parent updates via callback props
- No context, no Redux (keep data flow explicit)

### Cleanup Functions
```typescript
useEffect(() => {
  const interval = setInterval(poll, POLL_INTERVAL_MS);
  return () => clearInterval(interval);  // Cleanup on unmount
}, []);
```
- Always return cleanup function from useEffect
- Cancel timers, abort fetches, remove event listeners

---

## TypeScript Patterns

### Function Signatures
```typescript
// Always specify return type
export async function buildICEConfig(): Promise<RTCConfiguration> { }
export function applyPrivacyOffset(lat: number, lng: number): { lat: number; lng: number } { }
export function addMessage(mine: boolean, text: string): void { }

// Callback types
type OnSignal = (type: DescType, payload: string) => void;
type OnChat = (text: string) => void;
```
- Explicit return types (no implicit `any`)
- Callback types defined as `type` aliases
- Arrow functions preferred for callbacks

### Strict Mode
```typescript
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true
  }
}
```
- Strict mode enabled; all code must satisfy type checker
- No `any` without justification
- No nullable values without explicit `null` or `undefined`

### Nullable Types
```typescript
interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
}

// If a callback might not be called, use optional:
interface OptionalCallbacks {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
}

// If a value might be null, use union:
const currentPeer: PeerSession | null = peerRef.current;
const optional: string | undefined = something;
```
- Optional properties: `prop?: Type`
- Nullable types: `Type | null` or `Type | undefined`

### Type Guards
```typescript
// Narrowing types
if (error instanceof Error) {
  console.error(error.message);
}

// Array/object checks
if (Array.isArray(data.urls) && data.urls.length > 0) {
  // data.urls is definitely an array
}

// Truthiness checks
if (data && data.success) {
  // data is not null and success is true
}
```
- Always check types before using properties
- `instanceof` for class instances, `typeof` for primitives

---

## API Endpoint Patterns

### POST Endpoints (Mutations)
```typescript
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();

    // Validate input
    if (!body.fromId || typeof body.fromId !== "string") {
      return Response.json({ error: "invalid fromId" }, { status: 400 });
    }

    // Business logic
    const result = await prisma.signal.create({ data: body });

    // Return success
    return Response.json({ ok: true, id: result.id }, { status: 200 });
  } catch (error) {
    console.error("POST /api/signal error:", error);
    return Response.json({ error: "server error" }, { status: 500 });
  }
}
```

### GET Endpoints (Queries)
```typescript
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  // Validate input
  if (!id) {
    return Response.json({ error: "missing id" }, { status: 400 });
  }

  try {
    // Business logic
    const data = await prisma.signal.findMany({ where: { toId: id } });

    // Return success
    return Response.json({ signals: data }, { status: 200 });
  } catch (error) {
    console.error("GET /api/poll error:", error);
    return Response.json({ error: "server error" }, { status: 500 });
  }
}
```

### Error Responses
```typescript
// Bad input
return Response.json({ error: "invalid ids" }, { status: 400 });

// Server error
return Response.json({ error: "server error" }, { status: 500 });

// Not found (if applicable)
return Response.json({ error: "not found" }, { status: 404 });
```
- Always include human-readable error message
- No stack traces in client response
- Standard HTTP status codes (400, 404, 500, etc.)

---

## Async/Await Patterns

### Fire-and-Forget Calls
```typescript
// Explicitly mark as void to indicate intentional lack of await
void sendSignal(sessionId, peerId, "request");
void poll(sessionId);
```
- Prefix fire-and-forget calls with `void`
- Prevents accidental missing `await` warnings

### Error Handling
```typescript
try {
  const response = await fetch("/api/something");
  if (!response.ok) {
    console.warn(`fetch failed: HTTP ${response.status}`);
    return fallbackValue;
  }
  const data = await response.json();
  return data;
} catch (error) {
  console.error("Error:", error instanceof Error ? error.message : "unknown");
  return fallbackValue;
}
```
- Always catch errors from `await` expressions
- Provide fallback value on error
- Log meaningful error context

### Timeout Handling
```typescript
const response = await fetch(url, {
  method: "POST",
  signal: AbortSignal.timeout(5000),  // 5-second timeout
});
```
- Use `AbortSignal.timeout()` for network requests
- Gracefully handle AbortError (timeout)

---

## Import Patterns

### Path Aliases
```typescript
// Use @/* alias (defined in tsconfig.json)
import { buildICEConfig } from "@/lib/webrtc";
import type { PeerDot } from "@/lib/types";
import { applyPrivacyOffset } from "@/lib/geo";

// NOT: import from relative paths (except rare cases)
// import { buildICEConfig } from "../../../../lib/webrtc";
```
- Always use `@/*` path alias (not relative `../../..` paths)
- Defined in tsconfig.json and jest.config.js

### Type Imports
```typescript
import type { PeerDot, SignalMsg, PollResponse } from "@/lib/types";

// Re-exports are fine for values:
export { default as EntryGate } from "./components/EntryGate";
```
- Use `import type` for type-only imports (helps with tree-shaking)
- Regular imports for values and functions

---

## Logging Patterns

### Debug Logging
```typescript
console.log("[DEBUG] buildICEConfig: starting TURN credentials fetch");
console.log("[DEBUG] TURN fetch response status: " + response.status);
console.log("[DEBUG] Cloudflare response data:", JSON.stringify(data));
```
- Prefix with `[DEBUG]` for development/debugging logs
- Include context: function name, variable values
- Use template strings or concatenation for readability

### Error Logging
```typescript
console.error("[DEBUG] TURN credentials error:", error instanceof Error ? error.message : "unknown");
if (error instanceof Error) {
  console.error("[DEBUG] Error stack:", error.stack);
}
```
- Prefix error logs with `[DEBUG]` (to distinguish from warnings)
- Include error message and stack trace
- Handle both Error instances and generic error types

### Warning Logging
```typescript
console.warn(`TURN fetch failed: HTTP ${response.status}`);
console.warn("TURN: missing or empty urls");
```
- Use `console.warn` for graceful degradation (fallback taken, but operation continued)
- Include specific issue (e.g., "missing urls")

---

## Testing Conventions

### Jest Test Structure
```typescript
describe("buildICEConfig()", () => {
  it("returns RTCConfiguration with STUN + TURN on success", async () => {
    // Arrange
    const mockResponse = { urls: [...], username: "...", credential: "..." };
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    // Act
    const config = await buildICEConfig();

    // Assert
    expect(config.iceServers).toHaveLength(2);
    expect(config.iceServers[0].urls).toEqual(["stun:stun.l.google.com:19302"]);
    expect(config.iceServers[1].username).toBe(mockResponse.username);
  });
});
```
- Test structure: Arrange → Act → Assert
- Descriptive test names (what is being tested, expected outcome)
- Mock external dependencies (fetch, database)

### Test Naming
```typescript
it("returns 200 with TURN credentials on success")
it("returns 500 when CLOUDFLARE_TURN_TOKEN_ID is missing")
it("falls back to STUN-only when Cloudflare returns non-OK status")
```
- Clear, descriptive names
- State what is being tested and expected outcome

---

## Comments & Documentation

### Inline Comments (Sparse)
```typescript
// Only comment complex logic or non-obvious decisions
const offset = (Math.random() * 6 - 3) * 1000; // 1–3 km offset in meters

// This line was added to fix Issue #123 (connection stuck in connecting state)
await flushPendingCandidates();
```
- Minimal comments; code should be self-documenting
- Comment non-obvious logic or workarounds only

### Function Documentation (JSDoc)
```typescript
/**
 * Applies a random 1–3 km privacy offset to raw coordinates.
 * @param lat - Raw latitude
 * @param lng - Raw longitude
 * @returns Object with offset lat and lng
 */
export function applyPrivacyOffset(lat: number, lng: number): { lat: number; lng: number } {
  // ...
}
```
- JSDoc for public functions (optional; type signatures are often enough)
- Include parameter descriptions and return type

---

## Misc Conventions

### String Literals
```typescript
// Discriminated unions for types
type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

// String literals for signal types
type SignalType = "request" | "accept" | "decline" | "offer" | "answer" | "ice" | "end";
```
- Use string literal unions for semantic types
- More type-safe than raw strings

### Date/Time Handling
```typescript
// Use ISO 8601 strings for JSON
const now = new Date().toISOString(); // "2026-06-13T14:15:30.123Z"

// Use milliseconds for durations
const STALE_MS = 15000; // 15 seconds
const POLL_INTERVAL_MS = 1500; // 1.5 seconds
```
- ISO 8601 for timestamps in APIs and logs
- Milliseconds for durations (not seconds)

### Null Coalescing & Optional Chaining
```typescript
// Optional chaining
const iceServers = data?.result?.iceServers;

// Null coalescing
const count = data?.errors?.length ?? 0;

// Non-null assertion (use sparingly)
const credential = turnServer.credential!; // We know it's not null (checked earlier)
```
- Use `?.` for optional chaining
- Use `??` for null coalescing
- Use `!` sparingly, only when you're certain value is not null

---

## Client State: Custom Hooks + Pure Reducers (added 2026-06-15)

`app/page.tsx` was decomposed from a 1192-line god component into focused units.
Two patterns are now the sanctioned house style for client state:

### Custom hooks (`app/hooks/`, camelCase `useX.ts`)
Extract a cohesive slice of `Home`'s state + behavior into a `useX` hook with a
typed return interface. Existing hooks:
- `useRefState<T>(initial)` → `[value, ref, setValue]` — state mirrored into a
  ref updated **synchronously** in the setter. Use whenever a value is read
  inside a long-lived closure (poll interval, presence heartbeat, data-channel
  handler) that must not re-subscribe. The synchronous ref write is load-bearing.
- `useNotice`, `useChat`, `useBlocklist`, `useReciprocalVideo` — feature slices.
  The render keeps the JSX; the hook owns the state/handlers.

### Pure reducers (`app/state/`, camelCase `xReducer.ts`)
Formalize an informal state machine (a tagged-union `useState`) as a pure
`xReducer(state, action)` with an explicit action union. The reducer is the
state authority and enforces all guards; **side effects stay at the call sites**
in page.tsx, gated on the same guards. Because the poll tick / signal handlers
need synchronous reads, transitions route through a `dispatchX` that reads the
synchronous `useRefState` ref and applies the reducer — NOT React's `useReducer`
(which has no synchronous read). Existing: `connReducer`, `videoReducer`.

### Effect dependency arrays
When an effect references a hook return (a `useRefState` ref/setter, a
`useCallback`, a destructured stable method), list it in the deps. These are
referentially stable, so listing them satisfies `react-hooks/exhaustive-deps`
without changing the effect's re-run trigger — add a comment saying so. Note:
the linter only special-cases **direct** `useRef`/`useState` calls, so
tuple-returned refs/setters from custom hooks DO get flagged; list them.

### Lint note
`eslint-plugin-react-hooks` v6 (React Compiler) includes `react-hooks/purity`.
Passing a component function that calls `Date.now()` into a custom hook can trip
it (it loses the render-vs-event-handler classification) — a `useLatestRef`
helper was explored for the 3 "latest-callback" mirrors and dropped for this
reason; those stay as inline `useRef` + `useEffect`.

---

## References

- **TypeScript Handbook:** https://www.typescriptlang.org/docs/
- **React Docs:** https://react.dev/
- **Next.js Docs:** https://nextjs.org/docs
- **Jest Docs:** https://jestjs.io/docs/getting-started
