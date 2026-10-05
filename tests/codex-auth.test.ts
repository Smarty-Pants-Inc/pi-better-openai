import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { setActiveMultiproviderService } from "../src/multiprovider.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-better-openai-auth-"));
vi.stubEnv("PI_CODING_AGENT_DIR", scratch);
const { getCodexCredentials, readCodexAuth, requireCodexCredentials } =
  await import("../src/codex-auth.ts");
vi.unstubAllEnvs();

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function writeAuth(openai: unknown, legacy: unknown = undefined): void {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "auth.json"), JSON.stringify({ openai, "openai-codex": legacy }));
}

const legacy = { type: "oauth", access: "legacy-token", accountId: "acct_legacy" };

afterEach(() => {
  setActiveMultiproviderService(undefined);
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

test("prefers openai ChatGPT OAuth over legacy auth-file credentials", () => {
  writeAuth({ type: "oauth", access: jwt("acct_new"), expires: Date.now() + 60_000 }, legacy);
  expect(readCodexAuth()).toEqual({ accessToken: jwt("acct_new"), accountId: "acct_new" });
});

test.each([
  undefined,
  { type: "api_key", key: "not-a-subscription" },
  { type: "oauth", access: "plain-api-key" },
  { type: "oauth", access: jwt("acct_expired"), expires: Date.now() - 1 },
  { type: "oauth", access: 42, accountId: "acct_bad" },
])("falls back to legacy OAuth when openai is unusable (%j)", (openai) => {
  writeAuth(openai, legacy);
  expect(readCodexAuth()).toEqual({ accessToken: "legacy-token", accountId: "acct_legacy" });
});

test("accepts an explicit account_id in an openai OAuth entry", () => {
  writeAuth({ type: "oauth", access: " new-token ", account_id: " acct_new " });
  expect(readCodexAuth()).toEqual({ accessToken: "new-token", accountId: "acct_new" });
});

test("rejects expired OAuth and API-key entries without a legacy fallback", () => {
  writeAuth({ type: "oauth", access: jwt("acct_new"), expires: Date.now() - 1 });
  expect(readCodexAuth()).toBeUndefined();
  writeAuth({ type: "api_key", access: jwt("acct_new"), accountId: "acct_new" });
  expect(readCodexAuth()).toBeUndefined();
});

test.each([undefined, "plain-api-key", "reject"])(
  "tries the legacy registry provider when openai cannot resolve (%s)",
  async (openai) => {
    writeAuth(undefined);
    const getApiKeyForProvider = vi.fn(async (provider: string) => {
      if (provider === "openai-codex") return jwt("acct_legacy");
      if (openai === "reject") throw new Error("refresh failed");
      return openai;
    });
    const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
    expect(await getCodexCredentials(ctx)).toEqual({
      accessToken: jwt("acct_legacy"),
      accountId: "acct_legacy",
      source: "modelRegistry",
    });
    expect(getApiKeyForProvider.mock.calls.map(([provider]) => provider)).toEqual([
      "openai",
      "openai-codex",
    ]);
  },
);

test("uses refreshed openai registry OAuth before legacy and auth-file credentials", async () => {
  writeAuth(undefined, legacy);
  const getApiKeyForProvider = vi.fn(async () => jwt("acct_new"));
  const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
  expect(await getCodexCredentials(ctx)).toEqual({
    accessToken: jwt("acct_new"),
    accountId: "acct_new",
    source: "modelRegistry",
  });
  expect(getApiKeyForProvider.mock.calls).toEqual([["openai"]]);
});

test.each(["openai", "openai-codex"])(
  "keeps the selected %s pool ahead of the other pool, registry, and auth file",
  async (providerId) => {
    writeAuth({ type: "oauth", access: jwt("acct_file") }, legacy);
    const getApiKeyForProvider = vi.fn(async () => jwt("acct_registry"));
    const resolveActiveAccountAuth = vi.fn(async (poolProviderId: string) => ({
      accessToken: jwt(poolProviderId === providerId ? "acct_pinned" : "acct_other_pool"),
      label: "Synthetic account",
    }));
    setActiveMultiproviderService({
      getActiveAccount: vi.fn(async () => undefined),
      resolveActiveAccountAuth,
      onActiveAccountChanged: vi.fn(() => () => {}),
    });
    const ctx = {
      model: { provider: providerId },
      modelRegistry: { getApiKeyForProvider },
    } as unknown as ExtensionContext;
    expect(await getCodexCredentials(ctx)).toEqual({
      accessToken: jwt("acct_pinned"),
      accountId: "acct_pinned",
      source: "multiprovider",
    });
    expect(resolveActiveAccountAuth.mock.calls).toEqual([[providerId, ctx, undefined]]);
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
  },
);

test("does not continue to legacy resolution after a cancelled openai lookup", async () => {
  writeAuth(undefined);
  const getApiKeyForProvider = vi.fn(() => new Promise<string>(() => {}));
  const controller = new AbortController();
  const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
  const request = getCodexCredentials(ctx, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(request).rejects.toThrow("cancelled");
  expect(getApiKeyForProvider.mock.calls).toEqual([["openai"]]);
});

test("auth-file fallback: Pi 1.0 ChatGPT login without an account id refuses clearly", async () => {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { per_user_salt: "salt" } }),
  ).toString("base64url");
  writeAuth({
    type: "oauth",
    access: `header.${payload}.signature`,
    refresh: "refresh",
    expires: Date.now() + 60_000,
    clientId: "client",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  });
  expect(readCodexAuth()).toBeUndefined();
  await expect(requireCodexCredentials(undefined, "/openai-usage", "missing")).rejects.toThrow(
    "/openai-usage needs a ChatGPT account id",
  );
});

test("an OpenAI API key is reported as missing ChatGPT credentials, not a missing account id", async () => {
  writeAuth(undefined);
  const getApiKeyForProvider = vi.fn(async (provider: string) =>
    provider === "openai" ? "sk-test-key" : undefined,
  );
  const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    /^missing$/,
  );
});

// Security S2 / Astra R3 (PR #27): Pi 1.0's direct ChatGPT token has no account-id claim.
const accountless = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { per_user_salt: "salt" } }),
).toString("base64url")}.signature`;

function pools(byProvider: Record<string, string | undefined | Error>) {
  const resolveActiveAccountAuth = vi.fn(async (providerId: string) => {
    const value = byProvider[providerId];
    if (value instanceof Error) throw value;
    return value ? { accessToken: value, label: `Synthetic ${providerId}` } : undefined;
  });
  setActiveMultiproviderService({
    getActiveAccount: vi.fn(async () => undefined),
    resolveActiveAccountAuth,
    onActiveAccountChanged: vi.fn(() => () => {}),
  });
  return resolveActiveAccountAuth;
}

test.each([
  ["an account-less token", accountless, "needs a ChatGPT account id; the selected openai account"],
  [
    "a failed resolution",
    new Error("store locked"),
    "could not resolve the selected openai account",
  ],
])(
  "a selected openai pool with %s never falls back to another account",
  async (_label, selected, refusal) => {
    writeAuth({ type: "oauth", access: accountless }, legacy);
    const getApiKeyForProvider = vi.fn(async (provider: string) =>
      provider === "openai-codex" ? jwt("acct_registry_codex") : accountless,
    );
    const resolve = pools({ openai: selected, "openai-codex": jwt("acct_pool_codex") });
    const ctx = {
      model: { provider: "openai" },
      modelRegistry: { getApiKeyForProvider },
    } as unknown as ExtensionContext;
    await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
      `/openai-usage ${refusal}`,
    );
    // The reset paths use getCodexCredentials: they must get nothing, not account B.
    expect(await getCodexCredentials(ctx)).toBeUndefined();
    expect(resolve.mock.calls.map(([provider]) => provider)).toEqual(["openai", "openai"]);
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
  },
);

test("a selected openai-codex pool account is used", async () => {
  pools({ openai: accountless, "openai-codex": jwt("acct_pool_codex") });
  const ctx = { model: { provider: "openai-codex" } } as unknown as ExtensionContext;
  expect(await requireCodexCredentials(ctx, "/openai-usage", "missing")).toEqual({
    accessToken: jwt("acct_pool_codex"),
    accountId: "acct_pool_codex",
    source: "multiprovider",
  });
});

test("an unselected account-less pool identity is not replaced by the other pool", async () => {
  pools({ openai: accountless, "openai-codex": jwt("acct_pool_codex") });
  const ctx = { model: undefined } as unknown as ExtensionContext;
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    "the selected openai account does not provide one",
  );
});

test("with nothing selected, only an openai-codex login works as before", async () => {
  writeAuth(undefined, legacy);
  pools({});
  const ctx = { model: undefined } as unknown as ExtensionContext;
  expect(await requireCodexCredentials(ctx, "/openai-usage", "missing")).toEqual({
    accessToken: "legacy-token",
    accountId: "acct_legacy",
    source: "authFile",
  });
  setActiveMultiproviderService(undefined);
  expect(await requireCodexCredentials(undefined, "/openai-usage", "missing")).toEqual({
    accessToken: "legacy-token",
    accountId: "acct_legacy",
    source: "authFile",
  });
});
