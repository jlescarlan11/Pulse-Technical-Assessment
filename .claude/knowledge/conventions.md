# Conventions — Pulse Technical Assessment

## Naming

### Files & Directories
- **API routes:** `/app/api/{endpoint}/route.ts` (Next.js convention)
- **Components:** PascalCase (EntryGate.tsx, ChatPanel.tsx, WorldMap.tsx)
- **Utilities:** camelCase (api.ts, geo.ts, presence.ts, webrtc.ts)
- **Tests:** `*.test.ts` or `__tests__/*.test.ts` (Jest convention)

### Variables & Functions
- **Constants:** UPPER_SNAKE_CASE (POLL_INTERVAL_MS, STALE_MS, REQUEST_TIMEOUT_MS)
- **Functions:** camelCase (applyPrivacyOffset, buildICEConfig, startPeer)
- **State setters:** setXxx pattern (setPhase, setConn, setVideo, setMessages)
- **Refs:** xxxRef (connRef, videoRef, peerRef, mapRef, markersRef)

### Database & Types
- **Models:** PascalCase (Presence, Signal)
- **Types:** PascalCase with leading capital (PeerDot, SignalMsg, PollResponse, SignalType)
- **Enums/Unions:** lowercase literals ("request", "accept", "decline", "offer", "answer", "ice", "end")

## Code Organization

### Component Structure
```typescript
"use client";  // Required for client components in Next.js 16 App Router

import { ... } from "react";

export interface ComponentProps {
  prop1: Type;
  prop2: Type;
}

export default function ComponentName({ prop1, prop2 }: ComponentProps) {
  // State
  const [state, setState] = useState(initialValue);
  const ref = useRef(initialValue);

  // Effects
  useEffect(() => { ... }, [dependencies]);

  // Handlers
  function handleEvent() { ... }

  // Render
  return <div>...</div>;
}
```

### API Route Structure
```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RequestBody {
  field: Type;
}

interface ResponseData {
  field: Type;
}

export async function POST(request: NextRequest) {
  // Parse + validate input
  // Execute business logic
  // Return Response.json({ ... }, { status: 200 })
}
```

### Library Utilities
```typescript
// Export type definitions first
export type SignalType = "request" | "accept" | ...;

// Export interfaces
export interface PeerDot {
  id: string;
  lat: number;
  lng: number;
  busy: boolean;
}

// Export functions
export function applyPrivacyOffset(lat: number, lng: number): { lat: number; lng: number } {
  // ...
}

// Export classes
export class PeerSession {
  // ...
}
```

## TypeScript Practices

### Strict Mode
- tsconfig.json enables `strict: true`
- All functions have explicit return types
- No `any` types without explicit justification

### Type Safety
- Shared types in `lib/types.ts` (SignalType, PeerDot, SignalMsg, PollResponse)
- API request/response types defined in route.ts files
- Component props as exported interfaces

### Async/Await
- All async functions explicitly marked `async`
- Promises handled with `.then()` / `.catch()` or `try`/`catch`
- Fire-and-forget calls prefixed with `void` (void sendSignal(...))

## React Patterns

### State Management
- **Local state** for UI-only concerns (draft text, error messages, loading flags)
- **Ref state** for values that don't trigger re-renders (connection state, peer session)
- **Dual state + ref** for state that both renders and is accessed in callbacks (connRef + _setConn)

### Hooks
- `useEffect` dependencies explicit and correct
- Cleanup functions returned from useEffect where needed (listeners, timers)
- `useRef` for DOM access, callbacks, and non-rendering state

### Component Composition
- Small, focused components (5–10 components per app)
- Props passed down, callbacks passed up (no context, no state library)
- Conditional rendering with ternary operators or short-circuit `&&`

## Styling

### Tailwind CSS
- Utility-first approach (no custom CSS for component styling)
- Responsive modifiers (md:, lg:, sm:) used sparingly
- Arbitrary values for one-offs (width-40, height-28)

### Animation Classes
- Animation library in globals.css (animate-fade-in, animate-scale-in, etc.)
- Animation delays for stagger effects (.animate-stagger-1 through .animate-stagger-5)
- Transitions applied to interactive elements (buttons, inputs)

### Color Palette (Phase 2)
- **Neutral:** zinc-* (900, 800, 700, 600, 500, 400, 300, 200, 100, 50)
- **Primary:** emerald-* (400 main, 300 hover)
- **Danger:** red-* (500 main, 400 hover)
- **Dark background:** zinc-950, black
- **Text:** zinc-100 (light), zinc-600 (muted)

## Testing Conventions

### Jest
- Test files colocate with source or in `__tests__/` directory
- Describe blocks group related tests
- Clear test names (verbs: "returns", "throws", "calls", "updates")
- Mock setup in beforeEach, cleanup in afterEach

### Mocking
- Global fetch mocked with jest.fn()
- RTCPeerConnection mocked as Jest mock object
- Console methods spied on to verify warnings/errors

### Assertions
- expect(...).toEqual(...) for value equality
- expect(...).toHaveBeenCalled() for spy verification
- expect(...).toHaveLength(...) for array/string length
- expect(...).toBeDefined() for existence checks

## Error Handling

### API Routes
- Input validation before business logic
- Descriptive error messages in responses
- HTTP status codes (400 for bad input, 500 for server error)
- console.error for server-side logging

### Client Code
- Try/catch for async operations
- Fallback values when data is missing (graceful degradation)
- User-friendly error messages via showNotice()
- console.warn for non-critical issues

### WebRTC
- Graceful fallback to STUN-only if TURN fails
- Timeout handling with AbortSignal
- Optional chaining (?.) for nullable operations

## Git Practices

### Commits
- Incremental, logical commits (not one giant final commit)
- Clear, imperative messages ("Fix presence heartbeat", "Add TURN integration")
- Reference issue/feature when applicable ("feat: Add TURN...")
- Include phase context in message if applicable

### Branches
- Feature branches (feat/cloudflare-turn)
- Bugfix branches (fix/presence-and-webrtc-bugs)
- Pull request format for code review

## Environment & Secrets

### .env Management
- .env.example provided for reference
- Real .env never committed
- Secrets prefixed with CLOUDFLARE_, DATABASE_, etc. for clarity
- NEXT_PUBLIC_* prefix for client-side variables only

### Runtime Detection
- `process.env.NODE_ENV` for dev/prod checks
- `typeof navigator` / `typeof window` for SSR-safe client code
- Feature detection (e.g., "geolocation" in navigator)

## Documentation

### Code Comments
- Complex algorithms documented with intent, not code duplication
- Why, not what (comments explain business logic, not syntax)
- JSDoc comments for exported functions/classes (optional, but encouraged)

### README & Specs
- README.md: Project overview, setup, phases, deliverables
- AGENTS.md: Notes for AI assistants
- In-code comments: Where intent is non-obvious
- Type annotations: Self-documenting via TypeScript

## No Strong Conventions (Flexible)
- Formatter: No Prettier configured; ESLint runs but no auto-fix in npm scripts
- CSS naming: No BEM, OOCSS, or other naming methodology; purely Tailwind
- Component organization: Flat structure (app/components/) rather than feature-based
- Database migrations: Prisma migrations managed but not explicitly documented in repo
