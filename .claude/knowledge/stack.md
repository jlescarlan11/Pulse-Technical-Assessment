# Stack — Pulse Technical Assessment

## Frontend
- **Next.js 16.2.7** with App Router (Vercel serverless)
- **React 19.2.4** with TypeScript 5 (strict mode)
- **Tailwind CSS 4** (@tailwindcss/postcss)
- **Mapbox GL JS 3.24.0** for interactive map rendering

## Backend & Data
- **Node.js runtime** (Next.js API routes)
- **Prisma 7.8.0** ORM with PostgreSQL adapter
- **PostgreSQL** — transient coordination store (Presence, Signal models)
- **pg 8.21.0** — native driver (abstracted by Prisma)

## WebRTC & Networking
- **Native RTCPeerConnection** + **RTCDataChannel** (no external library)
- **STUN:** Google stun.l.google.com:19302 (fallback)
- **TURN:** Cloudflare RTC credentials API (optional, graceful degradation)

## Testing & Linting
- **Jest 30.4.2** with ts-jest (Node test environment)
- **ESLint 9** + eslint-config-next (linting, no formatter in package.json)
- **@types/jest 30.0.0** + TypeScript for test type safety

## Build & Tooling
- **TypeScript 5** (tsconfig.json with path aliases `@/*` → `./*`)
- **Tailwind CSS 4** with PostCSS (@tailwindcss/postcss)
- **Jest configuration** (jest.config.js) for `@/*` module resolution

## Environment
- **.env** variables: NEXT_PUBLIC_MAPBOX_TOKEN, DATABASE_URL, CLOUDFLARE_TURN_TOKEN_ID, CLOUDFLARE_TURN_API_TOKEN
- **Vercel deployment** (serverless Node runtime)
- **PostgreSQL database** (Neon, Vercel Postgres, or equivalent)

## Key Dependencies by Purpose

| Purpose | Package | Version |
|---------|---------|---------|
| Frontend framework | next | 16.2.7 |
| UI library | react, react-dom | 19.2.4 |
| Type system | typescript | ^5 |
| Styling | tailwindcss, @tailwindcss/postcss | ^4 |
| Mapping | mapbox-gl | ^3.24.0 |
| ORM | @prisma/client, @prisma/adapter-pg, prisma | ^7.8.0 |
| Database | pg | ^8.21.0 |
| Testing | jest, ts-jest, @types/jest | 30.x, 29.x, 30.x |
| Linting | eslint, eslint-config-next | ^9, 16.2.7 |

## Testing Commands
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode
```

## Build & Run Commands
```bash
npm run dev          # Next.js dev server (localhost:3000)
npm run build        # Build for production (includes `prisma generate`)
npm run start        # Production server
npm run lint         # Run ESLint
```

## No External WebRTC Libraries
- WebRTC implementation is native browser APIs
- No webrtc-adapter, simple-peer, or similar
- Manages offer/answer/ICE negotiation manually in lib/webrtc.ts (PeerSession class)
- Polling-based signaling over HTTP (no WebSocket, no Socket.IO)

## No State Management Library
- React hooks only (useState, useRef, useEffect)
- Ref-based state for connection/video machine (reduces re-renders)
- No Redux, Zustand, or other external state libraries
