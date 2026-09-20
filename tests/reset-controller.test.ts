import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getCodexCredentials } from "../src/codex-auth.ts";
import { ResetController } from "../src/reset-controller.ts";
import { reserveBankedResetRedemption } from "../src/reset-guard.ts";
import {
  BANKED_RESET_AUTO_REDEEM_LEAD_MS,
  CONSUME_RESET_URL,
  RESET_CREDITS_URL,
  buildBankedResetConfirmation,
  formatBankedResetChoice,
  parseBankedResetCredits,
  selectAutoRedeemCredit,
} from "../src/resets.ts";

// Never consult real credentials or send a real request in these tests.
vi.mock("../src/codex-auth.ts", () => ({ getCodexCredentials: vi.fn() }));

const NOW = Date.parse("2026-09-21T00:00:00Z");
const FIVE_MINUTES = BANKED_RESET_AUTO_REDEEM_LEAD_MS;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
let controllers: ResetController[];
let ctx: ExtensionContext;
let rows: Record<string, unknown>[];
let outcome: string;
let availableCount: number;
let applicableCount: number | undefined;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function row(id = "first", expires = NOW + 10 * 60_000): Record<string, unknown> {
  return { id, status: "available", reset_type: "codex_rate_limits", expires_at: expires };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function posts() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === CONSUME_RESET_URL);
}

function controller(enabled = () => true, onRedeemed = vi.fn()): ResetController {
  const result = new ResetController(enabled, onRedeemed);
  controllers.push(result);
  return result;
}

async function start(target = controller()): Promise<ResetController> {
  target.start(ctx);
  await target.refresh(ctx);
  await vi.advanceTimersByTimeAsync(0);
  return target;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  agentDir = mkdtempSync(join(tmpdir(), "pi-reset-safety-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  controllers = [];
  ctx = { hasUI: true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  rows = [row(), row("second")];
  outcome = "reset";
  availableCount = 2;
  applicableCount = undefined;
  vi.mocked(getCodexCredentials).mockReset().mockResolvedValue({
    accessToken: "fake-token",
    accountId: "fake-account",
    source: "authFile",
  });
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === RESET_CREDITS_URL && !init?.method)
      return json({
        credits: rows,
        available_count: availableCount,
        applicable_available_count: applicableCount,
      });
    if (String(url) === CONSUME_RESET_URL && init?.method === "POST") {
      if (outcome === "network-error") throw new Error("Simulated ambiguous timeout");
      if (outcome === "http-error") return new Response("mock error", { status: 500 });
      return json({ code: outcome, windows_reset: 2 });
    }
    throw new Error(`Unexpected mocked request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const target of controllers) target.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("automatic banked reset redemption (mocked transport only)", () => {
  test("waits until exactly five minutes before expiry and spends only one explicit credit", async () => {
    const onRedeemed = vi.fn();
    const target = await start(controller(() => true, onRedeemed));
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1);
    expect(posts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0]![1]!.body as string);
    expect(body.credit_id).toBe("first");
    expect(body.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(onRedeemed).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Auto-redeem:"), "info");
    await target.refresh(ctx, { force: true });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(posts()).toHaveLength(1);
  });

  test.each([
    "reset",
    "nothing_to_reset",
    "no_credit",
    "already_redeemed",
    "network-error",
    "http-error",
    "malformed",
  ])("never retries or falls back after %s, including a new controller/reload", async (code) => {
    rows = [row("first", NOW + FOUR_MINUTES), row("second", NOW + FOUR_MINUTES)];
    outcome = code;
    await start();
    expect(posts()).toHaveLength(1);
    // Simulate the first credit disappearing after an ambiguous result. A
    // second process must not burn the next one from its fresh snapshot.
    rows = [row("second", NOW + FOUR_MINUTES)];
    await start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts()).toHaveLength(1);
  });

  test("does not fall back when the scheduled credit was redeemed elsewhere", async () => {
    await start();
    rows[0]!.status = "redeemed";
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts()).toHaveLength(0);
  });

  test("handles multiple concurrent controllers with a shared account guard", async () => {
    await Promise.all([start(), start()]);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(posts()).toHaveLength(1);
  });

  test.each(["disabled", "missing-auth", "unavailable", "inapplicable"])(
    "skips %s",
    async (reason) => {
      rows = [row("first", NOW + FOUR_MINUTES)];
      if (reason === "missing-auth") vi.mocked(getCodexCredentials).mockResolvedValue(undefined);
      if (reason === "unavailable") availableCount = 0;
      if (reason === "inapplicable") applicableCount = 0;
      await start(controller(() => reason !== "disabled"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(posts()).toHaveLength(0);
    },
  );

  test("ignores expired, unknown-expiry, non-Codex, and non-available credits", async () => {
    rows = [
      row("expired", NOW),
      { ...row("unknown-expiry"), expires_at: null },
      { ...row("invalid-expiry"), expires_at: "bad date" },
      { ...row("redeeming"), status: "redeeming" },
      { ...row("redeemed"), status: "redeemed" },
      { ...row("unknown"), status: "something-new" },
      { ...row("other-type"), reset_type: "other" },
    ];
    expect(
      selectAutoRedeemCredit(parseBankedResetCredits({ credits: rows }).credits),
    ).toBeUndefined();
    await start();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(posts()).toHaveLength(0);
  });

  test("never spends a not-yet-due credit after another instance spends the expiring one", async () => {
    rows = [row(), row("later", NOW + 60 * 60_000)];
    await Promise.all([start(), start(), start()]);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(posts()).toHaveLength(1);
    rows[0]!.status = "redeemed";
    await Promise.all([start(), start()]);
    await vi.advanceTimersByTimeAsync(50 * 60_000 - 1);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1]![1]!.body as string).credit_id).toBe("later");
  });

  test("skips a cached due credit whose fresh expiry moved into the future", async () => {
    await start();
    rows[0]!.expires_at = NOW + 60 * 60_000;
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(posts()).toHaveLength(0);
  });

  test("can redeem a later independent expiry without draining the current batch", async () => {
    rows = [row(), row("later", NOW + 60 * 60_000)];
    await start();
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1]![1]!.body as string).credit_id).toBe("later");
  });

  test("a manual picker pauses automatic spending and manual redemption uses the same guard", async () => {
    const target = await start();
    const resume = target.pauseAutoRedeem();
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(posts()).toHaveLength(0);
    await target.redeem(ctx, "second");
    resume();
    await start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]![1]!.body as string).credit_id).toBe("second");
  });

  test("never sends a generic/manual fallback without a credit ID", async () => {
    await expect(controller().redeem(ctx, "")).rejects.toThrow("explicit");
    expect(posts()).toHaveLength(0);
  });

  test.each(["stop", "abort", "disable"])("cancels scheduling on %s", async (action) => {
    const abort = new AbortController();
    ctx = { ...ctx, signal: abort.signal };
    let enabled = true;
    const target = await start(controller(() => enabled));
    if (action === "stop") target.stop();
    if (action === "abort") abort.abort();
    if (action === "disable") enabled = false;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(posts()).toHaveLength(0);
  });

  test.each(["stop", "disable"])("rechecks %s after an in-flight fresh lookup", async (action) => {
    let enabled = true;
    const target = await start(controller(() => enabled));
    let release!: (response: Response) => void;
    // Avoid the TTL poll so this delayed GET is the redemption preflight.
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1000);
    await target.refresh(ctx, { force: true });
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toBeTypeOf("function");
    if (action === "stop") target.stop();
    else enabled = false;
    release(json({ credits: rows, available_count: 2 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(posts()).toHaveLength(0);
  });

  test("pins credentials between preflight and consume even if the active account changes", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1000);
    const target = controllers[0]!;
    await target.refresh(ctx, { force: true });
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === RESET_CREDITS_URL)
        vi.mocked(getCodexCredentials).mockResolvedValue({
          accessToken: "other-token",
          accountId: "other-account",
          source: "authFile",
        });
      return implementation(url, init);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![1]!.headers).toMatchObject({
      "chatgpt-account-id": "fake-account",
      authorization: "Bearer fake-token",
    });
  });
});

const FOUR_MINUTES = 4 * 60_000;

describe("persistent single-credit reservation", () => {
  test("reserves before outcomes, scopes by account and stores no auth or raw identifiers", () => {
    expect(reserveBankedResetRedemption("account-a", "credit-a")).toBe(true);
    expect(reserveBankedResetRedemption("account-a", "credit-b")).toBe(false);
    expect(reserveBankedResetRedemption("account-b", "credit-b")).toBe(true);
    const dir = join(agentDir, "pi-better-openai", "reset-redemptions");
    for (const file of readdirSync(dir)) {
      const text = file + readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain("account-a");
      expect(text).not.toContain("credit-a");
      expect(text).not.toContain("fake-token");
    }
    vi.advanceTimersByTime(FIVE_MINUTES);
    expect(reserveBankedResetRedemption("account-a", "credit-a")).toBe(false);
    expect(reserveBankedResetRedemption("account-a", "credit-b")).toBe(true);
    vi.advanceTimersByTime(FIVE_MINUTES);
    // An intervening credit must not erase the first uncertain attempt.
    expect(reserveBankedResetRedemption("account-a", "credit-a")).toBe(false);
  });

  test.each(["corrupt", "lock"])("fails closed for %s safety state", (kind) => {
    expect(reserveBankedResetRedemption("account", "first")).toBe(true);
    const dir = join(agentDir, "pi-better-openai", "reset-redemptions");
    const path = join(dir, readdirSync(dir)[0]!);
    vi.advanceTimersByTime(FIVE_MINUTES);
    if (kind === "corrupt") {
      writeFileSync(path, "{broken");
      expect(() => reserveBankedResetRedemption("account", "second")).toThrow("safety reservation");
    } else {
      writeFileSync(`${path}.lock`, "");
      expect(reserveBankedResetRedemption("account", "second")).toBe(false);
    }
    expect(posts()).toHaveLength(0);
  });
});

describe("expiry notes", () => {
  test("shows each credit's exact auto-redemption time, including date rollover", () => {
    const afterMidnight = new Date(NOW);
    afterMidnight.setDate(afterMidnight.getDate() + 1);
    afterMidnight.setHours(0, 2, 0, 0);
    const credits = parseBankedResetCredits({
      credits: [
        row("first", afterMidnight.getTime()),
        row("later", afterMidnight.getTime() + 60 * 60_000),
      ],
    }).credits;
    const labels = credits.map((credit, index) => {
      const expected = new Date(credit.expiresAtMs! - FIVE_MINUTES).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const note = ` · auto-redeems ${expected}`;
      const label = formatBankedResetChoice(credit, index, true);
      expect(label.endsWith(note)).toBe(true);
      expect(
        buildBankedResetConfirmation({ credit, availableCount: 2, autoRedeem: true }).message,
      ).toContain(note);
      return label.split("auto-redeems ")[1];
    });
    expect(labels[0]).not.toBe(labels[1]);
    const credit = credits[0]!;
    expect(formatBankedResetChoice(credit, 0, false)).not.toContain("auto-redeems");
    expect(formatBankedResetChoice({ ...credit, expiresAtMs: null }, 0, true)).not.toContain(
      "auto-redeems",
    );
    expect(formatBankedResetChoice({ ...credit, expiresAtMs: NOW }, 0, true)).not.toContain(
      "auto-redeems",
    );
  });
});
