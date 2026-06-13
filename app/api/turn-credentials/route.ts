import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";
import { isValidId } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CloudflareIceServer {
  username?: string;
  credential?: string;
  urls: string[];
}

interface CloudflareRTCResponse {
  iceServers: CloudflareIceServer[];
}

interface TurnCredentialsResponse {
  urls: string[];
  username: string;
  credential: string;
}

// Short-lived TURN credential TTL (10 min). Must stay safely GREATER than the
// response Cache-Control max-age (300s) below so a cached credential is never
// served already-expired.
//
// NOTE FOR FRONTEND: these credentials expire after TURN_CRED_TTL_SECONDS. Any
// active WebRTC connection that outlives this window must re-fetch this endpoint
// (and ICE-restart with the fresh credentials) before the TTL elapses.
const TURN_CRED_TTL_SECONDS = 600;

// GET /api/turn-credentials?id=&token= — mints short-lived Cloudflare TURN
// credentials, gated by a valid session capability token (same transport as
// poll: query params). On a missing/invalid token we 401 WITHOUT calling
// Cloudflare. Fail-closed on env misconfig is preserved; client falls back to
// STUN-only on any non-200.
export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const id = params.get("id");
  const token = params.get("token");

  if (!isValidId(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const owner = await prisma.presence.findUnique({
    where: { id },
    select: { token: true },
  });
  if (!verifyToken(owner, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const turnKeyId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!turnKeyId || !apiToken) {
    return Response.json(
      { error: "TURN credentials not configured" },
      { status: 500 }
    );
  }

  try {
    // Cloudflare Realtime TURN: generate short-lived ICE server credentials.
    // https://developers.cloudflare.com/realtime/turn/generate-credentials
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_CRED_TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("TURN credentials: Cloudflare API error", response.status, errorBody);
      return Response.json(
        { error: "Failed to fetch TURN credentials from Cloudflare" },
        { status: 500 }
      );
    }

    const data = (await response.json()) as CloudflareRTCResponse;

    if (!data.iceServers || !Array.isArray(data.iceServers)) {
      console.error("TURN credentials: invalid Cloudflare response structure");
      return Response.json(
        { error: "Invalid response from Cloudflare API" },
        { status: 500 }
      );
    }

    const turnServer = data.iceServers.find(
      (server) => server.username && server.credential
    );

    if (!turnServer || !turnServer.urls || turnServer.urls.length === 0) {
      console.error("TURN credentials: no usable TURN server in response");
      return Response.json(
        { error: "No TURN servers available" },
        { status: 500 }
      );
    }

    const credentials: TurnCredentialsResponse = {
      urls: turnServer.urls,
      username: turnServer.username!,
      credential: turnServer.credential!,
    };

    // Cache max-age (300s) is kept safely below the credential TTL (600s) so a
    // cached credential is never handed out already expired.
    return Response.json(credentials, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error(
      "TURN credentials error:",
      error instanceof Error ? error.message : "unknown"
    );
    return Response.json(
      { error: "Failed to fetch TURN credentials" },
      { status: 500 }
    );
  }
}
