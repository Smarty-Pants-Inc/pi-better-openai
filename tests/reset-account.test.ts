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

test("account-change restart discards an old in-flight lookup and its timer", async () => {
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
  target.start(ctx);
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
