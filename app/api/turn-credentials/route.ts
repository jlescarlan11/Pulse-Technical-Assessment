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
  const accountId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  // TURN App ID is optional; if provided, it will be used instead of accountId
  const turnAppId = process.env.CLOUDFLARE_TURN_APP_ID;

  console.log("[DEBUG] TURN credentials endpoint called");
  console.log("[DEBUG] accountId/tokenId present:", !!accountId);
  console.log("[DEBUG] apiToken present:", !!apiToken);
  console.log("[DEBUG] turnAppId present:", !!turnAppId);

  if (!accountId || !apiToken) {
    console.error("[DEBUG] Missing environment variables - TURN not configured");
    return Response.json(
      { error: "TURN credentials not configured" },
      { status: 500 }
    );
  }

  try {
    // Cloudflare TURN credentials endpoint (accounts API)
    // Format: https://api.cloudflare.com/client/v4/accounts/{accountId}/rtc/config
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/rtc/config`;
    console.log("[DEBUG] Calling Cloudflare TURN API URL:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    console.log("[DEBUG] Cloudflare API response status:", response.status);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[DEBUG] Cloudflare API error response:", errorBody);
      return Response.json(
        { error: "Failed to fetch TURN credentials from Cloudflare", details: errorBody },
        { status: 500 }
      );
    }

    const data = (await response.json()) as CloudflareRTCResponse;
    console.log("[DEBUG] Cloudflare response data:", JSON.stringify(data));

    if (!data.success || !data.result?.iceServers) {
      console.error("[DEBUG] Invalid Cloudflare response structure");
      return Response.json(
        { error: "Invalid response from Cloudflare API", success: data.success, hasResult: !!data.result },
        { status: 500 }
      );
    }

    const turnServer = data.result.iceServers.find(
      (server) => server.username && server.credential
    );

    console.log("[DEBUG] Found TURN server:", !!turnServer);
    if (turnServer) {
      console.log("[DEBUG] TURN server URLs:", turnServer.urls);
    }

    if (!turnServer || !turnServer.urls || turnServer.urls.length === 0) {
      console.error("[DEBUG] No valid TURN server found");
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

    console.log("[DEBUG] Successfully returning TURN credentials");
    return Response.json(credentials, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[DEBUG] TURN credentials error:", error instanceof Error ? error.message : "unknown");
    if (error instanceof Error) {
      console.error("[DEBUG] Error stack:", error.stack);
    }
    return Response.json(
      { error: "Failed to fetch TURN credentials", details: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}
