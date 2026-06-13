export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CloudflareRTCResponse {
  success: boolean;
  result?: {
    iceServers: Array<{
      urls: string[];
      username?: string;
      credential?: string;
    }>;
  };
  errors?: Array<{ message: string }>;
}

// GET /api/turn-credentials — Fetches short-lived Cloudflare TURN credentials.
// Returns { urls: [...], username, credential } or { error: "message" }
export async function GET() {
  const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!tokenId || !apiToken) {
    console.error("Missing CLOUDFLARE_TURN_TOKEN_ID or CLOUDFLARE_TURN_API_TOKEN");
    return Response.json(
      { error: "TURN credentials not configured" },
      { status: 500 }
    );
  }

  try {
    // Cloudflare Realtime API endpoint for generating TURN credentials
    // POST /accounts/{account_id}/rtc/config
    // where account_id is the CLOUDFLARE_TURN_TOKEN_ID

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${tokenId}/rtc/config`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(
        `Cloudflare API error: ${response.status}`,
        errorData
      );
      return Response.json(
        { error: "Failed to fetch TURN credentials" },
        { status: 500 }
      );
    }

    const data: CloudflareRTCResponse = await response.json();

    if (!data.success || !data.result?.iceServers) {
      console.error("Invalid Cloudflare response:", data);
      return Response.json(
        { error: "Invalid TURN credentials response" },
        { status: 500 }
      );
    }

    const iceServers = data.result.iceServers;

    // Find the TURN server entry (has both username and credential)
    const turnServer = iceServers.find((s) => s.username && s.credential);

    if (!turnServer || !turnServer.urls || turnServer.urls.length === 0) {
      console.error("No TURN server found in Cloudflare response");
      return Response.json(
        { error: "No TURN server in response" },
        { status: 500 }
      );
    }

    // Return in the format expected by WebRTC config
    return Response.json(
      {
        urls: turnServer.urls,
        username: turnServer.username,
        credential: turnServer.credential,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=300", // 5-minute client-side cache
        },
      }
    );
  } catch (error) {
    console.error("Error fetching TURN credentials:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
