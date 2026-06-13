import { join, poll, sendSignal, leave, UnauthorizedError } from "./api";

// Client token-threading: join issues the token; poll carries it as a query
// param; signal/leave carry it in the JSON body; a 401 surfaces as
// UnauthorizedError so page.tsx can re-mint by re-joining.

const ID = "session-abcdef12";
const TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

describe("lib/api client token threading", () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // Invariant: join returns the server-issued capability token verbatim so the
  // caller can keep it for the session.
  it("join returns the token from the response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, token: TOKEN }),
    });

    const result = await join(ID, 1, 2);

    expect(result).toEqual({ ok: true, token: TOKEN });
  });

  // Invariant: join sends id/lat/lng in the body (raw coords, server offsets).
  it("join posts id, lat, lng in the body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, token: TOKEN }),
    });

    await join(ID, 37.7749, -122.4194);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/join");
    expect(JSON.parse(opts.body)).toEqual({
      id: ID,
      lat: 37.7749,
      lng: -122.4194,
    });
  });

  // Invariant: poll appends BOTH id and token as URL-encoded query params — this
  // is how the GET endpoint receives the capability proof.
  it("poll appends id and token as query params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ peers: [], signals: [] }),
    });

    await poll(ID, TOKEN);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const parsed = new URL(calledUrl, "https://test.local");
    expect(parsed.searchParams.get("id")).toBe(ID);
    expect(parsed.searchParams.get("token")).toBe(TOKEN);
  });

  // Invariant: a 401 from poll surfaces as UnauthorizedError (not a generic
  // Error) so the caller can distinguish "re-mint token" from other failures.
  it("poll throws UnauthorizedError on a 401 response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });

    await expect(poll(ID, TOKEN)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // Invariant: a non-401 failure surfaces as a generic Error (NOT
  // UnauthorizedError) so it isn't mistaken for a token problem.
  it("poll throws a generic Error on a non-401 failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(poll(ID, TOKEN)).rejects.toThrow("poll failed: 500");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(poll(ID, TOKEN)).rejects.not.toBeInstanceOf(UnauthorizedError);
  });

  // Invariant: sendSignal carries the token in the JSON body alongside the
  // signal fields.
  it("sendSignal includes the token in the request body", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await sendSignal(ID, "to-abcdef12", "offer", TOKEN, "sdp");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/signal");
    expect(JSON.parse(opts.body)).toEqual({
      fromId: ID,
      toId: "to-abcdef12",
      type: "offer",
      payload: "sdp",
      token: TOKEN,
    });
  });

  // Invariant: a 401 from signal surfaces as UnauthorizedError.
  it("sendSignal throws UnauthorizedError on a 401 response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(
      sendSignal(ID, "to-abcdef12", "offer", TOKEN),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // Invariant: leave carries id + token in the body so it stays sendBeacon-
  // compatible (no headers / query params). When sendBeacon is unavailable it
  // falls back to fetch with the same body.
  it("leave sends id and token in the body via fetch fallback", () => {
    // No navigator.sendBeacon in the node test env → fetch fallback path.
    const navAny = globalThis as unknown as { navigator?: { sendBeacon?: unknown } };
    const hadSendBeacon =
      navAny.navigator && "sendBeacon" in (navAny.navigator as object);
    expect(hadSendBeacon).toBeFalsy();

    leave(ID, TOKEN);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/leave");
    expect(JSON.parse(opts.body)).toEqual({ id: ID, token: TOKEN });
    expect(opts.keepalive).toBe(true);
  });

  // Invariant: when navigator.sendBeacon exists it is preferred (survives tab
  // close) and receives the same id+token body.
  it("leave prefers navigator.sendBeacon when available", () => {
    const sendBeacon = jest.fn().mockReturnValue(true);
    const navAny = globalThis as unknown as { navigator: { sendBeacon: unknown } };
    const original = navAny.navigator;
    navAny.navigator = { sendBeacon } as unknown as typeof original;

    try {
      leave(ID, TOKEN);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, body] = sendBeacon.mock.calls[0];
      expect(url).toBe("/api/leave");
      expect(JSON.parse(body)).toEqual({ id: ID, token: TOKEN });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      navAny.navigator = original;
    }
  });
});
