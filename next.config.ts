import type { NextConfig } from "next";

// Content-Security-Policy is assembled from explicit directives so each one is
// auditable. The two non-obvious consumers are Mapbox GL JS and WebRTC:
//   - Mapbox GL loads tiles/sprites/glyphs over https from *.mapbox.com,
//     injects styles inline, and runs its renderer in a web worker created from
//     a blob: URL (hence worker-src blob:).
//   - WebRTC negotiates over STUN/TURN; browsers match ICE server URLs against
//     connect-src, so the stun:/turn:/turns: endpoints MUST be listed there or
//     relayed calls are blocked. We connect to Google STUN plus the Cloudflare
//     Realtime TURN/STUN endpoints (turn.cloudflare.com / stun.cloudflare.com).
const cspDirectives = [
  "default-src 'self'",
  // Next.js inlines a small bootstrap script; Mapbox GL may evaluate code at
  // runtime. 'unsafe-inline'/'unsafe-eval' accepted for this phase (no nonce
  // pipeline yet) per the stakeholder ruling.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Mapbox and Tailwind both inject styles at runtime.
  "style-src 'self' 'unsafe-inline'",
  // Mapbox tiles/sprites (https), plus data:/blob: for generated images.
  "img-src 'self' data: blob: https://*.mapbox.com",
  // Coordination API (self) + Mapbox endpoints + WebRTC STUN/TURN. The scheme
  // entries (stun:/turn:/turns:) cover ICE candidate gathering.
  "connect-src 'self' https://*.mapbox.com https://api.mapbox.com https://events.mapbox.com stun: turn: turns: stun:stun.l.google.com:19302 stun:stun.cloudflare.com:3478 stun:stun.cloudflare.com:53 turn:turn.cloudflare.com:3478 turns:turn.cloudflare.com:5349 turns:turn.cloudflare.com:443",
  // Mapbox GL renderer runs in a blob:-backed worker.
  "worker-src 'self' blob:",
  // WebRTC media streams are exposed as blob: object URLs.
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    // The app uses camera/mic (video calls) and the Geolocation API (map), so
    // these are allowed for same-origin rather than disabled.
    value: "camera=(self), microphone=(self), geolocation=(self)",
  },
];

const nextConfig: NextConfig = {
  // Allow the ngrok tunnel host to access dev resources (HMR, etc.).
  allowedDevOrigins: ["kind-intensely-herring.ngrok-free.app"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
