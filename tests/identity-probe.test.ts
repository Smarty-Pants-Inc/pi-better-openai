import { afterEach, expect, test, vi } from "vitest";
import { getCodexCredentials } from "../src/codex-auth.ts";
import { setActiveMultiproviderService } from "../src/multiprovider.ts";

const jwt = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;

afterEach(() => setActiveMultiproviderService(undefined));

test("identity-probe: pin A, resolve B with the same label must refuse", async () => {
  const fallback = vi.fn(async () =>
    JSON.stringify({ access: "default", accountId: "acct_default" }),
  );
  setActiveMultiproviderService({
    getActiveAccount: async (pool) =>
      pool === "openai-codex" ? { id: "slot_A", label: "Shared", authKind: "oauth" } : undefined,
    resolveActiveAccountAuth: async () => ({
      id: "slot_B",
      accessToken: jwt("acct_B"),
      label: "Shared",
    }),
    onActiveAccountChanged: () => () => {},
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: { getApiKeyForProvider: fallback },
    sessionManager: { getSessionId: () => "synthetic-probe" },
  } as unknown as NonNullable<Parameters<typeof getCodexCredentials>[0]>;
  expect(await getCodexCredentials(ctx)).toBeUndefined();
  expect(fallback).not.toHaveBeenCalled();
});
