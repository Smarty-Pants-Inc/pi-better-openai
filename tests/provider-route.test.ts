import { expect, test, vi } from "vitest";
import { gatewayRoot, resolveProviderRoute } from "../src/provider-route.ts";

test("maps a provider base URL to the gateway root", () => {
  expect(gatewayRoot("https://gateway.example.ts.net/v1/")).toBe("https://gateway.example.ts.net");
  expect(gatewayRoot("https://gateway.example.ts.net/v1")).toBe("https://gateway.example.ts.net");
  expect(gatewayRoot("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317");
  expect(gatewayRoot("https://gateway.example/proxy/v1/?x=1#h")).toBe(
    "https://gateway.example/proxy",
  );
});

test("routes through the provider's base URL and API key without an account ID", async () => {
  const modelRegistry = {
    getAll: () => [{ provider: "cliproxyapi", baseUrl: "https://gateway.example/v1/" }],
    getApiKeyForProvider: vi.fn(async () => "gw-key"),
  };
  const route = resolveProviderRoute({ modelRegistry } as never, "cliproxyapi");
  expect(route.baseUrl).toBe("https://gateway.example");
  await expect(route.getCredentials()).resolves.toEqual({ accessToken: "gw-key", accountId: "" });
  expect(() => resolveProviderRoute({ modelRegistry } as never, "missing")).toThrow(
    'Provider "missing" has no model with a base URL in pi.',
  );
});
