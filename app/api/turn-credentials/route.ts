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

export async function GET(): Promise<Response> {
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
      body: JSON.stringify({ ttl: 86400 }),
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
