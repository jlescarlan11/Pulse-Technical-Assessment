export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(): Promise<Response> {
  const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!tokenId || !apiToken) {
    return Response.json(
      { error: "TURN credentials not configured" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${tokenId}/rtc/config`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return Response.json(
        { error: "Failed to fetch TURN credentials from Cloudflare" },
        { status: 500 }
      );
    }

    const data = (await response.json()) as CloudflareRTCResponse;

    if (!data.success || !data.result?.iceServers) {
      return Response.json(
        { error: "Invalid response from Cloudflare API" },
        { status: 500 }
      );
    }

    const turnServer = data.result.iceServers.find(
      (server) => server.username && server.credential
    );

    if (!turnServer || !turnServer.urls || turnServer.urls.length === 0) {
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { error: "Failed to fetch TURN credentials" },
      { status: 500 }
    );
  }
}
