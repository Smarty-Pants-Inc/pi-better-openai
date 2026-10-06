// Regression for PR #27 live acceptance (2026-10-05): Pi 1.0's "Sign in with ChatGPT"
// stores an `openai` OAuth credential with no accountId and a JWT without the
// chatgpt_account_id claim. The commands must refuse clearly instead of reporting
// "Missing ChatGPT OAuth credentials", and must never send that token to chatgpt.com.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

/** A locally built JWT with a fake signature; `claims` go in the OpenAI auth namespace. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({
    aud: ["https://api.openai.com/v1"],
    "https://api.openai.com/auth": claims,
  })}.fake-signature`;
}

// Exactly the shape Pi 1.0 writes (pi-ai auth/oauth/openai-chatgpt.js:147-154).
const PI1_ACCESS = fakeJwt({ per_user_salt: "salt", encrypted_auth_metadata: "meta" });
const PI1_AUTH = {
  openai: {
    type: "oauth",
    access: PI1_ACCESS,
    refresh: "fake-refresh",
    expires: Date.now() + 3_600_000,
    clientId: "client_issued_fake",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
  },
};
const CODEX_ACCESS = fakeJwt({ chatgpt_account_id: "acct_codex_fixture" });
const CODEX_AUTH = {
  "openai-codex": {
    type: "oauth",
    access: CODEX_ACCESS,
    refresh: "fake-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "acct_codex_fixture",
  },
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * pi-multiprovider pins per pool, faithful to its 0.10.2 announcement: a key present here is a
 * selected account (`getActiveAccount()` reports it); its value is what
 * `resolveActiveAccountAuth()` yields: a token, `undefined` (a pinned Pi-default slot or a
 * swallowed refresh failure), or an Error (thrown). Absent keys are unselected pools.
 */
type Pools = Record<string, string | undefined | Error>;

async function createHarness(auth: Record<string, unknown>, pools?: Pools, provider = "openai") {
  const cwd = tempDir("pbo-pi1-project-");
  const agentDir = tempDir("pbo-pi1-agent-");
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    JSON.stringify({
      persistState: false,
      usage: { enabled: true, refreshIntervalMs: 60_000, showOnlyOnSubscriptionModels: false },
      footer: { mode: "status" },
      image: { enabled: true, defaultSave: "none" },
      websearch: { enabled: true },
      pets: { enabled: false },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.stubEnv("PI_OFFLINE", "1");

  // Pi's own credential path: the real ModelRegistry over Pi's auth storage.
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const registry = new ModelRegistry(services.modelRuntime);

  vi.resetModules();
  const { default: betterOpenAI } = await import("../index.ts");
  const commands = new Map<string, { handler: CommandHandler }>();
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on: (event: string, handler: EventHandler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: (name: string, command: { handler: CommandHandler }) =>
      commands.set(name, command),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
    events: { on: vi.fn() },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider, id: "gpt-5.5" },
    ui: { notify: vi.fn(), setFooter: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      getApiKeyForProvider: (provider: string) => registry.getApiKeyForProvider(provider),
      isUsingOAuth: () => true,
      getAll: () => registry.getAll(),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;
  betterOpenAI(pi);
  if (pools) {
    // pi-multiprovider's session-pinned account per pool (same module instance as index.ts).
    const { setActiveMultiproviderService } = await import("../src/multiprovider.ts");
    const label = (pool: string) => `Synthetic ${pool}`;
    setActiveMultiproviderService({
      getActiveAccount: vi.fn(async (pool: string) =>
        pool in pools ? { id: `acct_${pool}`, label: label(pool), authKind: "oauth" } : undefined,
      ),
      resolveActiveAccountAuth: vi.fn(async (pool: string) => {
        const value = pools[pool];
        if (value instanceof Error) throw value;
        return value ? { accessToken: value, label: label(pool) } : undefined;
      }),
      onActiveAccountChanged: vi.fn(() => () => {}),
    });
  }
  const run = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
  return { ctx, pi, run };
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const chatgptCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://chatgpt.com/"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("/openai-usage refuses clearly with Pi 1.0's ChatGPT login", async () => {
  const fetchMock = stubFetch({});
  const { ctx, run } = await createHarness(PI1_AUTH);
  await run("openai-usage");
  const messages = vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => String(message));
  expect(messages.join("\n")).toContain(
    "/openai-usage needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one.",
  );
  expect(messages.join("\n")).not.toContain("Missing ChatGPT OAuth credentials");
  expect(chatgptCalls(fetchMock)).toEqual([]);
}, 30_000);

test("/openai-image refuses clearly with Pi 1.0's ChatGPT login", async () => {
  const fetchMock = stubFetch({});
  const { run } = await createHarness(PI1_AUTH);
  const error = await Promise.resolve(run("openai-image", "a small red apple")).catch((e) => e);
  expect(String(error)).toContain(
    "/openai-image needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one. Run /login openai-codex",
  );
  expect(chatgptCalls(fetchMock)).toEqual([]);
}, 30_000);

test("/openai-websearch refuses clearly with Pi 1.0's ChatGPT login", async () => {
  const fetchMock = stubFetch({});
  const { run } = await createHarness(PI1_AUTH);
  const error = await Promise.resolve(run("openai-websearch", "current UTC date")).catch((e) => e);
  expect(String(error)).toContain(
    "/openai-websearch needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one.",
  );
  expect(String(error)).toContain("or set websearch.provider");
  expect(chatgptCalls(fetchMock)).toEqual([]);
}, 30_000);

test("a Codex-style login with an account id still reaches all three endpoints", async () => {
  const fetchMock = stubFetch({
    rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_after_seconds: 60 } },
  });
  const { run } = await createHarness({ ...PI1_AUTH, ...CODEX_AUTH });
  await run("openai-usage");
  await Promise.resolve(run("openai-image", "a small red apple")).catch(() => undefined);
  await Promise.resolve(run("openai-websearch", "current UTC date")).catch(() => undefined);
  const urls = chatgptCalls(fetchMock).map(([url]) => String(url));
  expect(urls).toEqual(
    expect.arrayContaining([
      "https://chatgpt.com/backend-api/wham/usage",
      expect.stringContaining("https://chatgpt.com/backend-api/codex/images"),
      "https://chatgpt.com/backend-api/codex/alpha/search",
    ]),
  );
  for (const [, init] of chatgptCalls(fetchMock)) {
    const headers = new Headers(init?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("acct_codex_fixture");
    expect(headers.get("authorization")).toBe(`Bearer ${CODEX_ACCESS}`);
  }
}, 30_000);

// Security S2 / Astra R3 (PR #27): an explicitly selected account-less `openai` pool account
// must never be replaced by another account's `openai-codex` credential.
const POOL_B_ACCESS = fakeJwt({ chatgpt_account_id: "acct_pool_b" });

test("a selected account-less openai pool refuses and never uses the openai-codex account", async () => {
  const fetchMock = stubFetch({
    rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_after_seconds: 60 } },
  });
  const { ctx, run } = await createHarness(
    { ...PI1_AUTH, ...CODEX_AUTH },
    { openai: PI1_ACCESS, "openai-codex": POOL_B_ACCESS },
  );
  await run("openai-usage");
  const image = await Promise.resolve(run("openai-image", "a small red apple")).catch((e) => e);
  const search = await Promise.resolve(run("openai-websearch", "current UTC date")).catch((e) => e);
  const usage = vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => String(message));
  const refusal = "needs a ChatGPT account id; the selected openai account does not provide one";
  expect(usage.join("\n")).toContain(`/openai-usage ${refusal}`);
  expect(String(image)).toContain(`/openai-image ${refusal}`);
  expect(String(search)).toContain(`/openai-websearch ${refusal}`);
  const bearers = fetchMock.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("authorization"),
  );
  expect(bearers).not.toContain(`Bearer ${POOL_B_ACCESS}`);
  expect(bearers).not.toContain(`Bearer ${CODEX_ACCESS}`);
  expect(chatgptCalls(fetchMock)).toEqual([]);
}, 30_000);

test("a selected openai-codex pool account reaches all three endpoints", async () => {
  const fetchMock = stubFetch({
    rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_after_seconds: 60 } },
  });
  const { run } = await createHarness(
    { ...PI1_AUTH, ...CODEX_AUTH },
    { openai: PI1_ACCESS, "openai-codex": POOL_B_ACCESS },
    "openai-codex",
  );
  await run("openai-usage");
  await Promise.resolve(run("openai-image", "a small red apple")).catch(() => undefined);
  await Promise.resolve(run("openai-websearch", "current UTC date")).catch(() => undefined);
  const calls = chatgptCalls(fetchMock);
  expect(calls.map(([url]) => String(url))).toEqual(
    expect.arrayContaining([
      "https://chatgpt.com/backend-api/wham/usage",
      expect.stringContaining("https://chatgpt.com/backend-api/codex/images"),
      "https://chatgpt.com/backend-api/codex/alpha/search",
    ]),
  );
  for (const [, init] of calls) {
    const headers = new Headers(init?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("acct_pool_b");
    expect(headers.get("authorization")).toBe(`Bearer ${POOL_B_ACCESS}`);
  }
}, 30_000);

// Round 5 (S2/R3 scope cut): one identity. A pin resolves only that account or refuses; no pin
// uses only Pi's default openai-codex credential or refuses. Every endpoint, resets included.
async function runAll(run: (name: string, args?: string) => unknown) {
  const results: unknown[] = [];
  for (const [name, args] of [
    ["openai-usage", ""],
    ["openai-image", "a small red apple"],
    ["openai-websearch", "current UTC date"],
    ["openai-resets", ""],
  ] as const)
    results.push(await Promise.resolve(run(name, args)).catch((error: unknown) => error));
  return results.map(String).join("\n");
}

const bearers = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls
    .map(([, init]) => new Headers(init?.headers).get("authorization"))
    .filter(Boolean);

test.each([
  ["(a) resolves undefined (pinned Pi-default slot / swallowed refresh)", undefined],
  ["(b) resolver throws", new Error("refresh failed")],
])(
  "a pinned account that %s refuses, with zero bearer requests",
  async (_label, pinned) => {
    for (const provider of ["openai", "openai-codex"]) {
      const fetchMock = stubFetch({});
      // Distinct usable identities exist everywhere else: Pi's openai-codex login and the
      // other pool. None may be used in place of the pinned account.
      const { ctx, run } = await createHarness(
        { ...PI1_AUTH, ...CODEX_AUTH },
        { [provider]: pinned },
        provider,
      );
      const out = await runAll(run);
      const notes = vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => String(message));
      const all = `${out}\n${notes.join("\n")}`;
      expect(all).toContain(`/openai-usage could not resolve the selected ${provider} account`);
      expect(all).toContain(`/openai-image could not resolve the selected ${provider} account`);
      expect(all).toContain(`/openai-websearch could not resolve the selected ${provider} account`);
      expect(bearers(fetchMock)).toEqual([]);
    }
  },
  60_000,
);

test("(a) a pin in one pool is not replaced by an unpinned pool or Pi's default login", async () => {
  const fetchMock = stubFetch({});
  const { run } = await createHarness({ ...PI1_AUTH, ...CODEX_AUTH }, { openai: undefined }, "x");
  await runAll(run);
  expect(bearers(fetchMock)).toEqual([]);
}, 30_000);

test("(c) a valid pin works and only its bearer is used", async () => {
  const fetchMock = stubFetch({
    rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_after_seconds: 60 } },
  });
  const { run } = await createHarness({ ...PI1_AUTH, ...CODEX_AUTH }, { openai: POOL_B_ACCESS });
  await runAll(run);
  expect(chatgptCalls(fetchMock).map(([url]) => String(url))).toEqual(
    expect.arrayContaining([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/codex/alpha/search",
    ]),
  );
  expect(new Set(bearers(fetchMock))).toEqual(new Set([`Bearer ${POOL_B_ACCESS}`]));
}, 30_000);

test("(d) no pin: only Pi's default openai-codex credential is used", async () => {
  const fetchMock = stubFetch({
    rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_after_seconds: 60 } },
  });
  // pi-multiprovider is active but nothing is selected.
  const { run } = await createHarness({ ...PI1_AUTH, ...CODEX_AUTH }, {});
  await runAll(run);
  expect(chatgptCalls(fetchMock).map(([url]) => String(url))).toEqual(
    expect.arrayContaining(["https://chatgpt.com/backend-api/wham/usage"]),
  );
  expect(new Set(bearers(fetchMock))).toEqual(new Set([`Bearer ${CODEX_ACCESS}`]));
}, 30_000);

test("(e) no pin and no default openai-codex credential: refuse", async () => {
  const fetchMock = stubFetch({});
  const { ctx, run } = await createHarness(PI1_AUTH, {});
  const out = await runAll(run);
  const notes = vi.mocked(ctx.ui.notify).mock.calls.map(([message]) => String(message));
  expect(`${out}\n${notes.join("\n")}`).toContain(
    "/openai-image needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one.",
  );
  expect(bearers(fetchMock)).toEqual([]);
}, 30_000);
