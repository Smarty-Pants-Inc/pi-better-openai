import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getActiveMultiproviderService,
  setActiveMultiproviderService,
} from "../src/multiprovider.ts";

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
  "with no selection, reads only the default openai-codex registry credential (openai: %s)",
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
    expect(getApiKeyForProvider.mock.calls).toEqual([["openai-codex"]]);
  },
);

test("never uses an openai registry token that has an account id, nor the auth file", async () => {
  writeAuth({ type: "oauth", access: jwt("acct_file") }, legacy);
  const getApiKeyForProvider = vi.fn(async (provider: string) =>
    provider === "openai" ? jwt("acct_new") : undefined,
  );
  const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
  expect(await getCodexCredentials(ctx)).toBeUndefined();
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    /^missing$/,
  );
});

test("does not continue after a cancelled default lookup", async () => {
  writeAuth(undefined);
  const getApiKeyForProvider = vi.fn(() => new Promise<string>(() => {}));
  const controller = new AbortController();
  const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
  const request = getCodexCredentials(ctx, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(request).rejects.toThrow("cancelled");
  expect(getApiKeyForProvider.mock.calls).toEqual([["openai-codex"]]);
});

test("without a registry, Pi 1.0's direct ChatGPT login refuses clearly", async () => {
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

/**
 * Faithful to pi-multiprovider 0.10.2's announcement: `getActiveAccount()` reports a selection
 * separately from `resolveActiveAccountAuth()`, which can return `undefined` for a selected
 * account (a pinned Pi-default slot, or a swallowed refresh failure). A key present in
 * `pinned` is selected; its value is the resolution (token, undefined, or a thrown Error).
 */
function pools(pinned: Record<string, string | undefined | Error>) {
  const label = (providerId: string) => `Synthetic ${providerId}`;
  const getActiveAccount = vi.fn(async (providerId: string) =>
    providerId in pinned
      ? { id: `acct_${providerId}`, label: label(providerId), authKind: "oauth" }
      : undefined,
  );
  const resolveActiveAccountAuth = vi.fn(async (providerId: string) => {
    const value = pinned[providerId];
    if (value instanceof Error) throw value;
    return value ? { accessToken: value, label: label(providerId) } : undefined;
  });
  setActiveMultiproviderService({
    getActiveAccount,
    resolveActiveAccountAuth,
    onActiveAccountChanged: vi.fn(() => () => {}),
  });
  return resolveActiveAccountAuth;
}

function registryWithB() {
  // Account B: a distinct, usable openai-codex login in Pi's registry and auth file.
  writeAuth({ type: "oauth", access: jwt("acct_file_b") }, legacy);
  return vi.fn(async (provider: string) =>
    provider === "openai-codex" ? jwt("acct_registry_b") : accountless,
  );
}

// pbo27b (a/b/c), kept with a faithful selection fixture.
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
    const getApiKeyForProvider = registryWithB();
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

// pbo27c (round 5): one identity, no fallback chain.
describe.each(["openai", "openai-codex"])("a pin in the %s pool", (pool) => {
  test.each([
    ["(a) resolves undefined", undefined],
    ["(b) throws", new Error("refresh failed")],
  ])("%s: refuses and never reads another identity", async (_label, resolution) => {
    const getApiKeyForProvider = registryWithB();
    const other = pool === "openai" ? "openai-codex" : "openai";
    const resolve = pools({ [pool]: resolution });
    for (const model of [pool, other, "anthropic", undefined]) {
      const ctx = {
        model: model ? { provider: model } : undefined,
        modelRegistry: { getApiKeyForProvider },
      } as unknown as ExtensionContext;
      await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
        `/openai-usage could not resolve the selected ${pool} account`,
      );
      expect(await getCodexCredentials(ctx)).toBeUndefined();
    }
    expect(new Set(resolve.mock.calls.map(([provider]) => provider))).toEqual(new Set([pool]));
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
  });

  test("(c) a valid pin is the only identity used", async () => {
    const getApiKeyForProvider = registryWithB();
    const resolve = pools({ [pool]: jwt("acct_pinned") });
    const ctx = {
      model: { provider: pool },
      modelRegistry: { getApiKeyForProvider },
    } as unknown as ExtensionContext;
    expect(await getCodexCredentials(ctx)).toEqual({
      accessToken: jwt("acct_pinned"),
      accountId: "acct_pinned",
      source: "multiprovider",
    });
    expect(resolve.mock.calls.map(([provider]) => provider)).toEqual([pool]);
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
  });
});

test("a pin that changes between selection and resolution (switch/resume) refuses", async () => {
  const getApiKeyForProvider = registryWithB();
  pools({ openai: jwt("acct_pinned") });
  const service = getActiveMultiproviderService()!;
  vi.mocked(service.resolveActiveAccountAuth).mockResolvedValueOnce({
    accessToken: jwt("acct_switched"),
    label: "Switched",
  });
  const ctx = {
    model: { provider: "openai" },
    modelRegistry: { getApiKeyForProvider },
  } as unknown as ExtensionContext;
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    "could not resolve the selected openai account",
  );
  expect(getApiKeyForProvider).not.toHaveBeenCalled();
});

test("pins in both pools with a non-ChatGPT model refuse as ambiguous", async () => {
  const getApiKeyForProvider = registryWithB();
  pools({ openai: jwt("acct_a"), "openai-codex": jwt("acct_b") });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: { getApiKeyForProvider },
  } as unknown as ExtensionContext;
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    "found selected accounts in more than one ChatGPT pool",
  );
  expect(getApiKeyForProvider).not.toHaveBeenCalled();
});

test.each([
  ["pi-multiprovider absent", false],
  ["pi-multiprovider active, nothing selected", true],
])("(d) no pin (%s): only the default openai-codex credential", async (_label, service) => {
  const getApiKeyForProvider = registryWithB();
  const resolve = service ? pools({}) : undefined;
  const ctx = {
    model: { provider: "openai" },
    modelRegistry: { getApiKeyForProvider },
  } as unknown as ExtensionContext;
  expect(await requireCodexCredentials(ctx, "/openai-usage", "missing")).toEqual({
    accessToken: jwt("acct_registry_b"),
    accountId: "acct_registry_b",
    source: "modelRegistry",
  });
  expect(getApiKeyForProvider.mock.calls).toEqual([["openai-codex"]]);
  expect(resolve ?? vi.fn()).not.toHaveBeenCalled();
});

test("(e) no pin and no default openai-codex credential refuses", async () => {
  writeAuth({ type: "oauth", access: jwt("acct_file") }, legacy);
  pools({});
  const getApiKeyForProvider = vi.fn(async (provider: string) =>
    provider === "openai" ? accountless : undefined,
  );
  const ctx = {
    model: { provider: "openai" },
    modelRegistry: { getApiKeyForProvider },
  } as unknown as ExtensionContext;
  await expect(requireCodexCredentials(ctx, "/openai-usage", "missing")).rejects.toThrow(
    "/openai-usage needs a ChatGPT account id; Pi 1.0's ChatGPT login",
  );
  expect(await getCodexCredentials(ctx)).toBeUndefined();
});

test("with pi-multiprovider active and no context, nothing selected is unproven: refuse", async () => {
  writeAuth(undefined, legacy);
  pools({});
  await expect(requireCodexCredentials(undefined, "/openai-usage", "missing")).rejects.toThrow(
    "could not resolve the selected ChatGPT account",
  );
  setActiveMultiproviderService(undefined);
  // Without a registry (no context), Pi's stored openai-codex login is the default identity.
  expect(await requireCodexCredentials(undefined, "/openai-usage", "missing")).toEqual({
    accessToken: "legacy-token",
    accountId: "acct_legacy",
    source: "authFile",
  });
});
