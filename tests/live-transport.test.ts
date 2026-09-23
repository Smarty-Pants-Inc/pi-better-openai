import { describe, expect, test } from "vitest";
import {
  buildLiveHeaders,
  buildLiveSidebandUrl,
  buildLiveSignalingUrl,
  liveGatewayRoot,
  parseLiveCallId,
} from "../src/live/transport.ts";

describe("live transport helpers", () => {
  test("extracts only rtc call IDs and builds an encoded sideband URL", () => {
    expect(parseLiveCallId("https://api.openai.com/v1/live/rtc_call-7?foo=bar")).toBe("rtc_call-7");
    expect(parseLiveCallId("https://example.com/live/not-a-call")).toBeUndefined();
    expect(buildLiveSidebandUrl("rtc_call-7")).toBe("wss://api.openai.com/v1/live/rtc_call-7");
  });

  test("builds the Codex Desktop headers required by signaling and sideband", () => {
    const headers = buildLiveHeaders(
      { accessToken: "secret-token", accountId: "acct_test" },
      "pi-session",
      "realtime-session",
      "attestation",
    );
    expect(headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "OpenAI-Alpha": "quicksilver=v2",
      "x-session-id": "realtime-session",
      "session-id": "pi-session",
      "thread-id": "pi-session",
      "chatgpt-account-id": "acct_test",
      "x-oai-attestation": "attestation",
      originator: "Codex Desktop",
    });
  });

  test("routes both live legs through a gateway provider base URL", () => {
    const root = liveGatewayRoot("https://gateway.example.ts.net/v1/");
    expect(root).toBe("https://gateway.example.ts.net");
    expect(liveGatewayRoot("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317");
    expect(buildLiveSignalingUrl(root)).toBe("https://gateway.example.ts.net/v1/live");
    expect(buildLiveSignalingUrl()).toContain("chatgpt.com/backend-api/codex/realtime/calls");
    expect(buildLiveSidebandUrl("rtc_1", root)).toBe("wss://gateway.example.ts.net/v1/live/rtc_1");
    expect(buildLiveSidebandUrl("rtc_1", "http://127.0.0.1:8317")).toBe(
      "ws://127.0.0.1:8317/v1/live/rtc_1",
    );
  });

  test("omits the account header when the gateway selects the account", () => {
    const headers = buildLiveHeaders(
      { accessToken: "gateway-key", accountId: "" },
      "pi-session",
      "realtime-session",
      undefined,
    );
    expect(headers.Authorization).toBe("Bearer gateway-key");
    expect(headers).not.toHaveProperty("chatgpt-account-id");
  });
});
