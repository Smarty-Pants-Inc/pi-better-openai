import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getCodexCredentials } from "../src/codex-auth.ts";
import { ResetController } from "../src/reset-controller.ts";
import { CONSUME_RESET_URL, RESET_CREDITS_URL } from "../src/resets.ts";

// No auth files, reservation files, real transport, or filesystem fixtures.
vi.mock("../src/codex-auth.ts", () => ({
  CODEX_AUTH_REQUIRED: "Mock credentials required",
  getCodexCredentials: vi.fn(),
}));
vi.mock("../src/reset-guard.ts", () => ({ reserveBankedResetRedemption: vi.fn(() => true) }));

const NOW = Date.parse("2026-09-21T00:00:00Z");
const MINUTE = 60_000;
let target: ResetController;
let ctx: ExtensionContext;
let account: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let expiredElsewhere: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  account = "account-a";
  expiredElsewhere = false;
  ctx = { hasUI: true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  vi.mocked(getCodexCredentials).mockImplementation(async () => ({
    accessToken: "mock-token",
    accountId: account,
    source: "authFile",
  }));
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === RESET_CREDITS_URL) {
      const id = new Headers(init?.headers).get("chatgpt-account-id");
      return new Response(
        JSON.stringify({
          available_count: 1,
          applicable_available_count: 1,
          credits: [
            {
              id: id === "account-a" ? "credit-a" : "credit-b",
              status: expiredElsewhere ? "redeemed" : "available",
              reset_type: "codex_rate_limits",
              expires_at: NOW + (id === "account-a" ? 24 * 60 : 20) * MINUTE,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (String(url) === CONSUME_RESET_URL)
      return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
    throw new Error("Unexpected mocked request");
  });
  vi.stubGlobal("fetch", fetchMock);
  target = new ResetController(() => true);
});

afterEach(() => {
  target.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function posts() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === CONSUME_RESET_URL);
}

async function start() {
  target.start(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(0);
}

test("replaces A's distant timer with B's expiry-minus-ten-minute timer", async () => {
  await start();
  const pending = vi.getTimerCount();
  account = "account-b";
  await target.refresh(ctx, { force: true });
  expect(vi.getTimerCount()).toBe(pending);
  await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
  expect(posts()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("credit-b");
  expect(posts()[0]![1]!.headers).toMatchObject({ "chatgpt-account-id": "account-b" });
});

test("switching B back to A reschedules A without leaving a second timer", async () => {
  await start();
  const pending = vi.getTimerCount();
  account = "account-b";
  await target.refresh(ctx, { force: true });
  account = "account-a";
  await target.refresh(ctx, { force: true });
  expect(vi.getTimerCount()).toBe(pending);
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(posts()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync((24 * 60 - 20) * MINUTE - 1);
  expect(posts()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("credit-a");
  expect(posts()[0]![1]!.headers).toMatchObject({ "chatgpt-account-id": "account-a" });
});

test("a scheduled A credit is not consumed under B credentials without a refresh", async () => {
  await start();
  await vi.advanceTimersByTimeAsync((24 * 60 - 10) * MINUTE - 1);
  account = "account-b";
  // Even if the new account returns a matching credit ID, it must not inherit
  // the previous account's scheduled credit or deadline.
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) !== RESET_CREDITS_URL) return implementation(url, init);
    return new Response(
      JSON.stringify({
        available_count: 1,
        applicable_available_count: 1,
        credits: [
          {
            id: "credit-a",
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: NOW + 24 * 60 * MINUTE,
          },
        ],
      }),
      { status: 200 },
    );
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(posts()).toHaveLength(0);
});

test("account-change notification discards an old in-flight lookup and its timer", async () => {
  await start();
  const pending = vi.getTimerCount();
  let release!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const oldRefresh = target.refresh(ctx, { force: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toBeTypeOf("function");
  account = "account-b";
  // This is the account-change callback's cancellation path in index.ts.
  target.accountChanged(ctx);
  await target.refresh(ctx);
  release(
    new Response(
      JSON.stringify({
        available_count: 1,
        credits: [
          {
            id: "credit-a",
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: NOW + 24 * 60 * MINUTE,
          },
        ],
      }),
      { status: 200 },
    ),
  );
  await oldRefresh;
  expect(vi.getTimerCount()).toBe(pending);
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("credit-b");
});

test("same-account re-selection retains the exact credit, even if redeemed elsewhere", async () => {
  account = "account-b";
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await implementation(url, init);
    if (String(url) !== RESET_CREDITS_URL) return response;
    const payload = await response.json();
    payload.credits.push({
      id: "replacement",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: NOW + 21 * MINUTE,
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  await start();
  await vi.advanceTimersByTimeAsync(4 * MINUTE);
  expiredElsewhere = true;
  target.accountChanged(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(8 * MINUTE);
  expect(posts()).toHaveLength(0);
});

test("pending same-account identity resolution cannot replace the retained credit", async () => {
  account = "account-b";
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await implementation(url, init);
    if (String(url) !== RESET_CREDITS_URL) return response;
    const payload = await response.json();
    payload.credits.push({
      id: "replacement",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: NOW + 21 * MINUTE,
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  await start();
  await vi.advanceTimersByTimeAsync(4 * MINUTE);
  let resolve!: (value: Awaited<ReturnType<typeof getCodexCredentials>>) => void;
  vi.mocked(getCodexCredentials).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  target.accountChanged(ctx);
  const refresh = target.refresh(ctx);
  expiredElsewhere = true;
  await vi.advanceTimersByTimeAsync(7 * MINUTE);
  expect(posts()).toHaveLength(0);
  resolve({ accountId: account, accessToken: "mock-token", source: "authFile" });
  await refresh;
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(posts()).toHaveLength(0);
});

test("same-account re-selection preserves the cooldown after a no-op preflight", async () => {
  account = "account-b";
  await start();
  expiredElsewhere = true;
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(posts()).toHaveLength(0);
  expiredElsewhere = false;
  target.accountChanged(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(9 * MINUTE);
  expect(posts()).toHaveLength(0);
});

test("unresolved notification identity cancels the retained credit", async () => {
  account = "account-b";
  await start();
  await vi.advanceTimersByTimeAsync(4 * MINUTE);
  vi.mocked(getCodexCredentials).mockRejectedValue(new Error("Mock resolution failed"));
  target.accountChanged(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(16 * MINUTE);
  expect(posts()).toHaveLength(0);
  expect(target.snapshot).toBeUndefined();
});

test("A to B to A retains A's no-op cooldown rather than spending its replacement", async () => {
  let originalRedeemed = false;
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) !== RESET_CREDITS_URL) return implementation(url, init);
    const id = new Headers(init?.headers).get("chatgpt-account-id");
    return new Response(
      JSON.stringify({
        available_count: 1,
        applicable_available_count: 1,
        credits:
          id === "account-a"
            ? [
                {
                  id: "credit-a",
                  status: originalRedeemed ? "redeemed" : "available",
                  reset_type: "codex_rate_limits",
                  expires_at: NOW + 20 * MINUTE,
                },
                {
                  id: "replacement-a",
                  status: "available",
                  reset_type: "codex_rate_limits",
                  expires_at: NOW + 22 * MINUTE,
                },
              ]
            : [
                {
                  id: "credit-b",
                  status: "available",
                  reset_type: "codex_rate_limits",
                  expires_at: NOW + 100 * MINUTE,
                },
              ],
      }),
      { status: 200 },
    );
  });
  await start();
  originalRedeemed = true;
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(posts()).toHaveLength(0);
  account = "account-b";
  target.accountChanged(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(MINUTE);
  account = "account-a";
  target.accountChanged(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(8 * MINUTE);
  expect(posts()).toHaveLength(0);
  // Suppression belongs to A and lasts exactly ten minutes after its no-op.
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("replacement-a");
  expect(posts()[0]![1]!.headers).toMatchObject({ "chatgpt-account-id": "account-a" });
});

test("a fresh notification context supplies B credentials to polling and its due preflight", async () => {
  const oldContext = ctx;
  const newContext = { ...ctx, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  vi.mocked(getCodexCredentials).mockImplementation(async (lookupContext) => ({
    accessToken: lookupContext === oldContext ? "synthetic-a" : "synthetic-b",
    accountId: lookupContext === oldContext ? "account-a" : "account-b",
    source: "multiprovider",
  }));
  await start();
  await vi.advanceTimersByTimeAsync(3 * MINUTE);
  target.accountChanged(newContext);
  await target.refresh(newContext);
  await vi.advanceTimersByTimeAsync(7 * MINUTE - 1);
  expect(posts()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("credit-b");
  expect(posts()[0]![1]!.headers).toMatchObject({
    "chatgpt-account-id": "account-b",
    authorization: "Bearer synthetic-b",
  });
  expect(oldContext.ui.notify).not.toHaveBeenCalled();
  expect(newContext.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Auto-redeem:"),
    "info",
  );
});

test("fresh same-account context rebinds cancellation without replacing the exact credit", async () => {
  account = "account-b";
  const oldSession = new AbortController();
  const newSession = new AbortController();
  ctx = { ...ctx, signal: oldSession.signal };
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await implementation(url, init);
    if (String(url) !== RESET_CREDITS_URL) return response;
    const payload = await response.json();
    payload.credits.push({
      id: "replacement",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: NOW + 21 * MINUTE,
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  await start();
  await vi.advanceTimersByTimeAsync(3 * MINUTE);
  expiredElsewhere = true;
  const newContext = {
    ...ctx,
    signal: newSession.signal,
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  target.accountChanged(newContext);
  await target.refresh(newContext);
  oldSession.abort();
  await vi.advanceTimersByTimeAsync(9 * MINUTE);
  expect(posts()).toHaveLength(0);
  expect(target.snapshot).toBeDefined();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  newSession.abort();
  expect(vi.getTimerCount()).toBe(0);
});

test("the adopted notification context cancels its new account's due work", async () => {
  await start();
  await vi.advanceTimersByTimeAsync(3 * MINUTE);
  account = "account-b";
  const session = new AbortController();
  const newContext = { ...ctx, signal: session.signal };
  target.accountChanged(newContext);
  await target.refresh(newContext);
  session.abort();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(8 * MINUTE);
  expect(posts()).toHaveLength(0);
});

test.each(["stop", "abort"] as const)(
  "late live-context notifications after %s stay cancelled until explicit start",
  async (reason) => {
    const session = new AbortController();
    ctx = { ...ctx, signal: session.signal };
    const sessionManager = { getSessionId: () => "same-session" };
    ctx = { ...ctx, sessionManager } as unknown as ExtensionContext;
    await start();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    if (reason === "stop") target.stop();
    else session.abort();
    expect(vi.getTimerCount()).toBe(0);

    account = "account-b";
    const liveContext = {
      ...ctx,
      signal: new AbortController().signal,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    const lookups = vi.mocked(getCodexCredentials).mock.calls.length;
    target.accountChanged(liveContext);
    await target.refresh(liveContext, { force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCodexCredentials).toHaveBeenCalledTimes(lookups);
    await vi.advanceTimersByTimeAsync(8 * MINUTE);
    expect(posts()).toHaveLength(0);
    expect(liveContext.ui.notify).not.toHaveBeenCalled();

    // Only an explicit lifecycle start authorizes background work again.
    target.start(liveContext);
    await target.refresh(liveContext);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("credit-b");
  },
);

test("within one account a polling refresh retains the exact scheduled credit", async () => {
  account = "account-b";
  await start();
  expiredElsewhere = true;
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const response = await implementation(url, init);
    if (String(url) !== RESET_CREDITS_URL) return response;
    const payload = await response.json();
    payload.credits.push({
      id: "replacement",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: NOW + 20 * MINUTE,
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  await target.refresh(ctx, { force: true });
  await vi.advanceTimersByTimeAsync(10 * MINUTE);
  expect(posts()).toHaveLength(0);
});
