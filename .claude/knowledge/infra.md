# Infrastructure — Pulse Technical Assessment

**Last Updated:** 2026-06-13  
**Current Status:** Vercel serverless with PostgreSQL backend

---

## Hosting Platform

**Primary:** Vercel (serverless Next.js)
- **Runtime:** Node.js (runtime: "nodejs" in API routes)
- **Function Timeout:** 30 seconds (Vercel Pro plan)
- **Cold Start:** ~100–300ms (typical serverless cold start)
- **Auto-scaling:** Automatic; no capacity planning required
- **CDN:** Vercel global CDN included (caches static assets, API responses via Cache-Control headers)

**Why Vercel:**
- Native Next.js optimization (no build configuration)
- Automatic deployments from GitHub
- Environment variable management via dashboard
- Serverless limits impose polling-based (not WebSocket) architecture

---

## Database

**Primary:** PostgreSQL (transient coordination database)
- **Providers Tested:** Neon, Vercel Postgres, Supabase
- **Schema:** Two models only (Presence, Signal) — no durable user data
- **Connection Pool:** Managed by Prisma (@prisma/adapter-pg)
- **SSL Required:** sslmode=require in production (DATABASE_URL)

**Indexes:**
- `Presence(lastSeen)` — for stale cleanup in `/api/poll`
- `Signal(toId)` — for inbox queries in `/api/poll`

**No Backups:** Not applicable (transient data, no persistence)

**Data Retention:** Automatic via TTL logic in API routes (Presence: 15s idle, Signal: 60s old)

---

## Environment Variables & Secrets Management

**Vercel Project Settings:**
All secrets stored in Vercel dashboard (encrypted):
- `DATABASE_URL` — PostgreSQL connection string
- `NEXT_PUBLIC_MAPBOX_TOKEN` — Mapbox API token (public, safe to expose)
- `CLOUDFLARE_TURN_TOKEN_ID` — Cloudflare RTC account ID
- `CLOUDFLARE_TURN_API_TOKEN` — Cloudflare API token (sensitive)

**Local Development:**
- `.env` file (git-ignored) contains same variables
- Loaded by `next dev` automatically
- Never committed to repository

**Deployment Process:**
1. Set all variables in Vercel dashboard (Settings → Environment Variables)
2. Select deployment environments (Production, Preview, Development)
3. Push code to GitHub or manually redeploy
4. Vercel automatically passes env vars to build and runtime

**Critical Note for TURN:**
- Vercel does NOT automatically load `.env` file in production
- `CLOUDFLARE_TURN_TOKEN_ID` and `CLOUDFLARE_TURN_API_TOKEN` must be explicitly configured in Vercel dashboard
- Without these set, `/api/turn-credentials` returns HTTP 500
- Fallback to STUN-only is graceful but reduces cross-network connectivity

---

## Deployment Pipeline

**Git Workflow:**
1. Develop locally, commit to main branch
2. Push to GitHub
3. Vercel automatically detects push
4. Build: `npx prisma generate && next build`
5. Test suite runs (pre-deployment checks)
6. Deploy to production URL
7. Live immediately; no manual approval needed

**Build Steps:**
```bash
npm run build  # Includes: prisma generate + next build
```

**Pre-Deployment Checks:**
- TypeScript compilation (strict mode)
- ESLint linting
- Jest tests (if configured)

**Database Initialization:**
```bash
npx prisma db push  # First-time schema setup
```

**Rollback:**
- Vercel dashboard: Deployments → previous build → Promote
- No data rollback needed (transient data only)

---

## Monitoring & Logging

**Error Tracking:** Not implemented
- No Sentry, LogRocket, or similar
- Vercel provides basic runtime logs (visible in dashboard)

**Application Logging:**
- `console.log()` and `console.error()` for debugging
- All WebRTC and TURN logs prefixed with `[DEBUG]` for identification
- Logs visible in Vercel Runtime Logs (Deployments → specific build → Runtime Logs)

**Performance Monitoring:** Not implemented
- No APM (Application Performance Monitoring)
- No custom metrics or dashboards

**Database Monitoring:** Delegated to provider
- Neon: Built-in monitoring dashboard
- Vercel Postgres: Via provider dashboard
- Supabase: Via provider dashboard

---

## Rate Limiting & DDoS Protection

**Not Implemented**
- Vercel serverless cannot enforce per-client rate limiting in application code
- API endpoints (join, poll, signal, leave, turn-credentials) have no rate limit logic
- Each endpoint call creates a new function invocation

**Attack Vectors (Unmitigated):**
- Signal spam: Attacker sends 1000s of signals to a user (DoS)
- Presence spam: Attacker creates 1000s of presence records (database bloat)
- Polling spam: Attacker polls endpoint 1000s times/second (function invocation spam)

**Mitigation (Not Implemented):**
- Firewall rules (Cloudflare, Vercel Edge Middleware)
- Database connection limits (inherent in Prisma pooling)
- Rate limiting middleware (custom implementation needed)

---

## Service Dependencies

**External Services:**
1. **GitHub** — Code repository and CI/CD trigger
2. **Cloudflare** — TURN credentials API (optional, graceful fallback to STUN)
3. **Mapbox** — Map tiles and geocoding (non-critical, map renders empty if unavailable)
4. **PostgreSQL Provider** (Neon, Vercel Postgres, or Supabase) — Database host

**Service Outage Scenarios:**
- **Cloudflare TURN down:** Falls back to STUN-only; cross-network connections may fail
- **Mapbox down:** Map component empty; users can see dots but no basemap
- **PostgreSQL down:** All API endpoints return database errors; app unusable
- **GitHub down:** No impact on live deployments; only affects new deployments

---

## Cost Optimization

**Vercel Pricing (as of 2026):**
- Free tier: 100 GB bandwidth/month
- Pro: $20/month + overage charges
- Compute: Generally $0.50 per GB-hour for function execution

**Optimization Strategies:**
1. **Function Duration:** API endpoints are < 500ms average; minimal cost
2. **Database Queries:** Simple queries (Presence, Signal); no complex joins
3. **Polling Interval:** 1500ms is optimal (less frequent = fewer function invocations)
4. **Cache-Control Headers:** 5-minute cache on `/api/turn-credentials` reduces API hits
5. **No Media Upload:** Chat and video are P2P; server never stores or processes media

**Estimated Monthly Cost:**
- Database (Neon/Vercel Postgres): $5–20/month
- Vercel Functions: $0–10/month (depending on user count and polling frequency)
- Mapbox: $0–50/month (depending on tile requests; first 50k free)
- Cloudflare: $0/month (TURN API included with account)

---

## Disaster Recovery

**Data Recovery:** Not applicable (transient data, no persistence)

**Service Recovery:**
- **Vercel:** Automatic; no intervention needed
- **Database:** Switch provider (Neon → Supabase, etc.) by updating DATABASE_URL
- **Cloudflare:** Switch TURN provider (Cloudflare → COTURN, etc.) by updating endpoint and auth

**Backup Strategy:** None (not needed; no durable user data)

**Incident Response:**
1. Check Vercel dashboard for deployment status
2. Check database provider dashboard for connectivity
3. Review runtime logs for specific errors
4. Redeploy if necessary (git push or manual redeploy)

---

## Load Balancing & Caching

**Load Balancing:** Automatic (Vercel handles)
- Functions auto-scaled based on demand
- No manual load balancer configuration

**Caching Strategy:**
- **Static assets:** Vercel CDN (instant, cached forever)
- **API responses:** Cache-Control headers (TURN credentials: 5 minutes)
- **Browser caching:** Via Cache-Control headers set by API routes

**Cache Headers:**
- `/api/turn-credentials`: `private, max-age=300` (5-minute client cache)
- Other API routes: `no-cache, no-store` (no caching; always fresh)

---

## Scalability Considerations

**Current Limits:**
- **Concurrent Users:** Unlimited (serverless scales automatically)
- **Database Connections:** Limited by Prisma connection pool (default: 10 connections)
- **Request Rate:** Limited by Vercel (free tier: 5000 requests/month; Pro: unlimited with overage)
- **Message Size:** Limited by AWS Lambda (6MB payload limit via Vercel)

**Scaling at 1000 users:**
- Presence records: 1000 rows (negligible)
- Poll requests/second: ~667 (1000 users * 1 poll per 1.5 seconds)
- Vercel scales transparently

**Scaling at 10000 users:**
- Presence records: 10000 rows (still negligible)
- Poll requests/second: ~6667
- Database connection pool may saturate; upgrade Prisma pooling or database plan

**Architectural Limitation:**
- Polling-based signaling (1500ms interval) is inherently latent
- At 100k users, polling would exceed reasonable API rate limits
- WebSocket support required for true high-scale; incompatible with Vercel serverless

---

## References

- **Vercel Documentation:** https://vercel.com/docs
- **Prisma Documentation:** https://www.prisma.io/docs/
- **PostgreSQL:** https://www.postgresql.org/docs/
- **Cloudflare TURN API:** https://developers.cloudflare.com/calls/get-started/
