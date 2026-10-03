import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { setActiveMultiproviderService } from "../src/multiprovider.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-better-openai-auth-"));
vi.stubEnv("PI_CODING_AGENT_DIR", scratch);
const { getCodexCredentials, readCodexAuth } = await import("../src/codex-auth.ts");
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
