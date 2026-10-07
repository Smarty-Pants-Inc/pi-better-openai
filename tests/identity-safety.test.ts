import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  CodexIdentityRefusedError,
  getCodexCredentials,
  requireCodexCredentials,
  resolveCodexIdentity,
} from "../src/codex-auth.ts";
import {
  setActiveMultiproviderService,
  type MultiproviderAccountAuth,
  type MultiproviderActiveAccount,
  type MultiproviderService,
} from "../src/multiprovider.ts";
import { ResetController } from "../src/reset-controller.ts";
import * as resetGuard from "../src/reset-guard.ts";
import { BANKED_RESET_AUTO_REDEEM_LEAD_MS } from "../src/resets.ts";
import { requestCodexUsage } from "../src/usage.ts";
import { CONSUME_RESET_URL, consumeBankedReset, requestBankedResetCredits } from "../src/resets.ts";
import { registerOpenAIImage } from "../src/image.ts";
import { registerOpenAIWebSearch } from "../src/websearch.ts";
import { makeResolvedConfig } from "./helpers.ts";

const jwt = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;
const pin = (id = "slot_A", label = "Shared"): MultiproviderActiveAccount => ({
  id,
  label,
  authKind: "oauth",
});
const bound = (id = "slot_A", label = "Shared"): MultiproviderAccountAuth => ({
  id,
  label,
  accessToken: jwt("acct_A"),
});
function harness(model = "openai-codex") {
  let pins: Record<string, MultiproviderActiveAccount> = { "openai-codex": pin() };
  const fallback = vi.fn(async () =>
    JSON.stringify({ access: "synthetic_default", accountId: "acct_default" }),
  );
  const ctx = {
    model: { provider: model },
    modelRegistry: { getApiKeyForProvider: fallback },
    sessionManager: { getSessionId: () => "synthetic" },
  } as unknown as ExtensionContext;
  const resolve = vi.fn<MultiproviderService["resolveActiveAccountAuth"]>(async () => bound());
  const service: MultiproviderService = {
    getActiveAccount: vi.fn(async (provider) => pins[provider]),
    resolveActiveAccountAuth: resolve,
    onActiveAccountChanged: () => () => {},
  };
  setActiveMultiproviderService(service);
  return {
    ctx,
    fallback,
    resolve,
    service,
    pins: (next: typeof pins) => {
      pins = next;
    },
  };
}
afterEach(() => {
  setActiveMultiproviderService(undefined);
  vi.unstubAllGlobals();
});

test.each(["undefined", "throw", "mismatch", "accountless"])(
  "a selected %s resolution refuses without fallback",
  async (mode) => {
    const h = harness();
    h.resolve.mockImplementation(async () => {
      if (mode === "throw") throw new Error("unresolved pool");
      if (mode === "undefined") return undefined;
      if (mode === "mismatch") return bound("slot_B");
      return { ...bound(), accessToken: "direct-or-api-key-without-account" };
    });
    expect(await getCodexCredentials(h.ctx)).toBeUndefined();
    await expect(requireCodexCredentials(h.ctx, "/probe")).rejects.toBeInstanceOf(
      CodexIdentityRefusedError,
    );
    expect(h.fallback).not.toHaveBeenCalled();
  },
);

test("a same-account label rename succeeds, bound to slot id rather than JWT account id", async () => {
  const h = harness();
  h.resolve.mockResolvedValue(bound("slot_A", "Renamed"));
  expect(await resolveCodexIdentity(h.ctx)).toMatchObject({
    kind: "selected",
    credentials: { accountId: "acct_A", selection: { id: "slot_A" } },
  });
  expect(h.resolve).toHaveBeenCalledWith("openai-codex", h.ctx, undefined);
  expect(h.fallback).not.toHaveBeenCalled();
});

test("switch/resume during resolution refuses even if the old token is returned", async () => {
  const h = harness();
  h.resolve.mockImplementation(async () => {
    h.pins({ "openai-codex": pin("slot_B") });
    return bound();
  });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
  expect(h.fallback).not.toHaveBeenCalled();
});

test("mutating the original selection object cannot rewrite the snapshot", async () => {
  const h = harness();
  const original = pin();
  h.pins({ "openai-codex": original });
  h.resolve.mockImplementation(async () => {
    original.id = "slot_B";
    return bound("slot_B");
  });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
});

test("a replaced bridge cannot return stale credentials", async () => {
  const h = harness();
  h.resolve.mockImplementation(async () => {
    setActiveMultiproviderService(undefined);
    return bound();
  });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
});

test.each(["openai", "openai-codex"])("failure reading the %s selection refuses", async (pool) => {
  const h = harness();
  h.service.getActiveAccount = vi.fn(async (provider) => {
    if (provider === pool) throw new Error("journal unavailable");
    return undefined;
  });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
  expect(h.fallback).not.toHaveBeenCalled();
});

test("malformed stable pin id fails closed", async () => {
  const h = harness();
  h.pins({ "openai-codex": pin("") });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
  expect(h.resolve).not.toHaveBeenCalled();
});

test("a bridge without session context cannot prove no selection", async () => {
  harness();
  expect(await getCodexCredentials()).toBeUndefined();
});

test.each(["openai", "other-provider"])(
  "a sole native openai pin with %s model never forwards its grant, even with a JWT account id",
  async (model) => {
    const h = harness(model);
    h.pins({ openai: pin() });
    await expect(requireCodexCredentials(h.ctx, "/probe")).rejects.toThrow(
      "separate api.openai.com grant",
    );
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  },
);

test("both pools pinned with an unrelated model refuse as ambiguous", async () => {
  const h = harness("other-provider");
  h.pins({ openai: pin("slot_O"), "openai-codex": pin() });
  expect(await resolveCodexIdentity(h.ctx)).toMatchObject({
    kind: "refuse",
    reason: "selected-ambiguous",
  });
  expect(h.fallback).not.toHaveBeenCalled();
});

test("both pools pinned use only the model's Codex pool", async () => {
  const h = harness();
  h.pins({ openai: pin("slot_O"), "openai-codex": pin() });
  expect(await resolveCodexIdentity(h.ctx)).toMatchObject({ kind: "selected" });
  expect(h.resolve.mock.calls.map(([pool]) => pool)).toEqual(["openai-codex"]);
});

test("no pin uses only default Codex credentials, not unselected pooled auth", async () => {
  const h = harness();
  h.pins({});
  expect(await getCodexCredentials(h.ctx)).toMatchObject({
    accountId: "acct_default",
    source: "modelRegistry",
  });
  expect(h.resolve).not.toHaveBeenCalled();
  expect(h.fallback).toHaveBeenCalledWith("openai-codex");
});

test("a pin restored while default auth is pending refuses that fallback", async () => {
  const h = harness();
  h.pins({});
  h.fallback.mockImplementation(async () => {
    h.pins({ "openai-codex": pin() });
    return JSON.stringify({ access: "default", accountId: "acct_default" });
  });
  expect(await getCodexCredentials(h.ctx)).toBeUndefined();
});

test("cancellation during unresolved pool auth never falls through", async () => {
  const h = harness();
  const controller = new AbortController();
  const reason = new Error("cancel-probe");
  h.resolve.mockImplementation(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(getCodexCredentials(h.ctx, controller.signal)).rejects.toBe(reason);
  expect(h.fallback).not.toHaveBeenCalled();
});

test("pre-aborted requests do not inspect the bridge", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new Error("already-cancelled"));
  await expect(getCodexCredentials(h.ctx, controller.signal)).rejects.toThrow("already-cancelled");
  expect(h.service.getActiveAccount).not.toHaveBeenCalled();
});

test("usage and both reset endpoints refuse unresolved selected auth before network", async () => {
  const h = harness();
  h.resolve.mockResolvedValue(undefined);
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  await expect(requestCodexUsage(h.ctx)).rejects.toBeInstanceOf(CodexIdentityRefusedError);
  await expect(requestBankedResetCredits(h.ctx)).rejects.toBeInstanceOf(CodexIdentityRefusedError);
  await expect(
    consumeBankedReset(h.ctx, "synthetic-credit", "synthetic-request"),
  ).rejects.toBeInstanceOf(CodexIdentityRefusedError);
  expect(network).not.toHaveBeenCalled();
  expect(h.fallback).not.toHaveBeenCalled();
});

test("pinned reset snapshots cannot bypass a switch, even to a slot with the same ChatGPT id", async () => {
  const h = harness();
  const credentials = await requireCodexCredentials(h.ctx, "/probe");
  h.pins({ "openai-codex": pin("slot_B") });
  h.resolve.mockResolvedValue(bound("slot_B"));
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  await expect(requestBankedResetCredits(h.ctx, undefined, credentials)).rejects.toThrow(
    "selected account changed",
  );
  await expect(
    consumeBankedReset(h.ctx, "synthetic-credit", "synthetic-request", undefined, credentials),
  ).rejects.toThrow("selected account changed");
  expect(network).not.toHaveBeenCalled();
});

test("pinned reset auth also refuses an unresolved pool, rather than falling back", async () => {
  const h = harness();
  const credentials = await requireCodexCredentials(h.ctx, "/probe");
  h.resolve.mockResolvedValue(undefined);
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  await expect(
    consumeBankedReset(h.ctx, "synthetic-credit", "synthetic-request", undefined, credentials),
  ).rejects.toBeInstanceOf(CodexIdentityRefusedError);
  expect(network).not.toHaveBeenCalled();
});

// Faithful announcement contract: resolution looks up the active slot internally,
// refresh failures become undefined, and successful auth has NO stable id.
function realBridgeHarness() {
  const h = harness();
  const listeners = new Map<
    string,
    Set<Parameters<MultiproviderService["onActiveAccountChanged"]>[1]>
  >();
  h.service.onActiveAccountChanged = (provider, callback) => {
    const callbacks = listeners.get(provider) ?? new Set();
    listeners.set(provider, callbacks);
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  };
  const change = (id: string) => {
    const account = pin(id);
    h.pins({ "openai-codex": account });
    for (const callback of listeners.get("openai-codex") ?? [])
      callback({ providerId: "openai-codex", account, ctx: h.ctx });
  };
  let refresh: () => Promise<string | undefined> = async () => jwt("acct_A");
  h.resolve.mockImplementation(async (provider, ctx) => {
    const active = await h.service.getActiveAccount(provider, ctx);
    if (!active) return undefined;
    try {
      const accessToken = await refresh();
      if (!accessToken?.trim()) return undefined;
      return { accessToken: accessToken.trim(), label: active.label, source: "oauth" };
    } catch {
      return undefined;
    }
  });
  return {
    ...h,
    change,
    refresh: (next: typeof refresh) => {
      refresh = next;
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0),
  };
}

test("real bridge auth without id accepts the unchanged selected A and unsubscribes", async () => {
  const h = realBridgeHarness();
  expect(await requireCodexCredentials(h.ctx, "/probe")).toMatchObject({
    accountId: "acct_A",
    selection: { providerId: "openai-codex", id: "slot_A" },
  });
  expect(h.fallback).not.toHaveBeenCalled();
  expect(h.listenerCount()).toBe(0);
});

test.each([false, true])(
  "real bridge switch during resolve refuses (switch back: %s)",
  async (back) => {
    const h = realBridgeHarness();
    h.refresh(async () => {
      h.change("slot_B");
      if (back) h.change("slot_A");
      return jwt("acct_A");
    });
    await expect(requireCodexCredentials(h.ctx, "/probe")).rejects.toBeInstanceOf(
      CodexIdentityRefusedError,
    );
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  },
);

test.each(["undefined", "refresh-error"])(
  "real bridge selected A %s blocks usage and reset with usable B registry",
  async (mode) => {
    const h = realBridgeHarness();
    h.refresh(async () => {
      if (mode === "refresh-error") throw new Error("refresh failed");
      return undefined;
    });
    h.fallback.mockResolvedValue(JSON.stringify({ access: jwt("acct_B"), accountId: "acct_B" }));
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(requestCodexUsage(h.ctx)).rejects.toBeInstanceOf(CodexIdentityRefusedError);
    await expect(requestBankedResetCredits(h.ctx)).rejects.toBeInstanceOf(
      CodexIdentityRefusedError,
    );
    await expect(consumeBankedReset(h.ctx, "credit_A", "request_A")).rejects.toBeInstanceOf(
      CodexIdentityRefusedError,
    );
    expect(network).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  },
);

test.each(["image", "reference", "websearch"])(
  "real bridge unresolved A refuses %s without any B requests",
  async (feature) => {
    const h = realBridgeHarness();
    h.refresh(async () => undefined);
    h.fallback.mockResolvedValue(JSON.stringify({ access: jwt("acct_B"), accountId: "acct_B" }));
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    let tool: Tool | undefined;
    const pi = {
      registerTool: (next: Tool) => {
        tool = next;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
    } as unknown as ExtensionAPI;
    const defaults = makeResolvedConfig();
    const config = makeResolvedConfig({
      image: { ...defaults.image, enabled: true },
      websearch: { ...defaults.websearch, enabled: true },
    });
    h.ctx.ui = { notify: vi.fn() } as unknown as ExtensionContext["ui"];
    h.ctx.cwd = "/synthetic-never-written";
    if (feature === "websearch") registerOpenAIWebSearch(pi, () => config);
    else registerOpenAIImage(pi, () => config);
    if (!tool) throw new Error("Expected registered tool");
    const params =
      feature === "websearch"
        ? { query: "synthetic" }
        : {
            prompt: "synthetic",
            ...(feature === "reference" ? { images: ["/synthetic-must-not-be-read.png"] } : {}),
          };
    await expect(
      tool.execute("synthetic", params, undefined, undefined, h.ctx),
    ).rejects.toBeInstanceOf(CodexIdentityRefusedError);
    expect(network).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  },
);
test.each(["preflight", "reserve"])(
  "real bridge reset switch at %s refuses before consumption",
  async (stage) => {
    const h = realBridgeHarness();
    const controller = new ResetController();
    let getCount = 0;
    const network = vi.fn<typeof fetch>(async () => {
      getCount++;
      if (stage === "preflight" && getCount === 2) h.change("slot_B");
      return new Response(
        JSON.stringify({ credits: [{ id: "credit_A", status: "available" }], available_count: 1 }),
      );
    });
    vi.stubGlobal("fetch", network);
    const reserve = vi.spyOn(resetGuard, "reserveBankedResetRedemption").mockImplementation(() => {
      if (stage === "reserve") h.change("slot_B");
      return true;
    });
    try {
      await controller.refresh(h.ctx);
      expect(controller.snapshot?.credentials.selection?.id).toBe("slot_A");
      await expect(controller.redeem(h.ctx, "credit_A")).rejects.toBeInstanceOf(
        CodexIdentityRefusedError,
      );
      expect(network).toHaveBeenCalledTimes(2); // only A's initial and exact-credit GETs
      for (const [, init] of network.mock.calls) {
        expect(init?.method).not.toBe("POST");
        expect(init?.headers).toMatchObject({ "chatgpt-account-id": "acct_A" });
      }
      if (stage === "preflight") expect(reserve).not.toHaveBeenCalled();
      else expect(reserve).toHaveBeenCalledExactlyOnceWith("acct_A", "credit_A");
      expect(h.fallback).not.toHaveBeenCalled();
    } finally {
      controller.stop();
      reserve.mockRestore();
    }
  },
);

test("real bridge manual reset revalidates the exact confirmed credit before reserve", async () => {
  const h = realBridgeHarness();
  const controller = new ResetController();
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ credits: [{ id: "credit_A", status: "available" }], available_count: 1 }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          credits: [{ id: "credit_other", status: "available" }],
          available_count: 1,
        }),
      ),
    );
  vi.stubGlobal("fetch", network);
  const reserve = vi.spyOn(resetGuard, "reserveBankedResetRedemption").mockReturnValue(true);
  try {
    await controller.refresh(h.ctx);
    await expect(controller.redeem(h.ctx, "credit_A")).rejects.toThrow("no longer available");
    expect(reserve).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    controller.stop();
    reserve.mockRestore();
  }
});

test("real bridge automatic reset retains scheduled A identity after a switch to B", async () => {
  vi.useFakeTimers();
  const h = realBridgeHarness();
  h.ctx.ui = { notify: vi.fn() } as unknown as ExtensionContext["ui"];
  const controller = new ResetController(() => true);
  const network = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          credits: [
            {
              id: "credit_A",
              status: "available",
              reset_type: "codex_rate_limits",
              expires_at: Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS + 1000,
            },
          ],
          available_count: 1,
        }),
      ),
  );
  vi.stubGlobal("fetch", network);
  const reserve = vi.spyOn(resetGuard, "reserveBankedResetRedemption").mockReturnValue(true);
  try {
    controller.start(h.ctx);
    await controller.refresh(h.ctx);
    expect(controller.snapshot?.credentials.selection?.id).toBe("slot_A");
    h.change("slot_B");
    await vi.advanceTimersByTimeAsync(1000);
    expect(network).toHaveBeenCalledTimes(1); // no B lookup or consume
    expect(reserve).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    reserve.mockRestore();
    vi.useRealTimers();
  }
});
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};
test.each(["image", "websearch"])(
  "%s tool refuses a same-label wrong-slot resolution before network",
  async (feature) => {
    const h = harness();
    h.resolve.mockResolvedValue(bound("slot_B"));
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    let tool: Tool | undefined;
    const pi = {
      registerTool: (next: Tool) => {
        tool = next;
      },
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
    } as unknown as ExtensionAPI;
    const defaults = makeResolvedConfig();
    const config = makeResolvedConfig({
      image: { ...defaults.image, enabled: true },
      websearch: { ...defaults.websearch, enabled: true },
    });
    h.ctx.ui = { notify: vi.fn() } as unknown as ExtensionContext["ui"];
    h.ctx.cwd = "/synthetic-never-written";
    if (feature === "image") registerOpenAIImage(pi, () => config);
    else registerOpenAIWebSearch(pi, () => config);
    if (!tool) throw new Error("Expected registered tool");
    await expect(
      tool.execute(
        "synthetic",
        feature === "image" ? { prompt: "synthetic" } : { query: "synthetic" },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toBeInstanceOf(CodexIdentityRefusedError);
    expect(network).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  },
);

// pi-multiprovider 7571b77 (src/announcement.ts:57-86): implicit affinity can move
// without an event, and resolveActiveAccountAuth returns no slot id. Both calls
// capture the pinned slot synchronously, then await the account list.
test("F3: unannounced implicit-affinity A->B->A around resolution never labels B's token as slot A", async () => {
  const h = harness();
  const tokens: Record<string, string> = { slot_A: jwt("acct_A"), slot_B: jwt("acct_B") };
  let affinity = "slot_A";
  let pinReads = 0;
  h.service.getActiveAccount = vi.fn(async (provider: string) => {
    if (provider !== "openai-codex") return undefined;
    const id = affinity;
    pinReads++;
    await Promise.resolve(); // integration.accounts()
    if (pinReads === 1) affinity = "slot_B"; // implicit move after A's pin read, no event
    return pin(id);
  });
  h.resolve.mockImplementation(async () => {
    const id = affinity; // the bridge's own slot capture
    await Promise.resolve();
    affinity = "slot_A"; // back to A before the final re-read, no event
    return { accessToken: tokens[id]!, label: "Shared", source: "oauth" };
  });
  expect(await resolveCodexIdentity(h.ctx)).toMatchObject({
    kind: "refuse",
    reason: "selected-unresolved",
  });
  expect(h.fallback).not.toHaveBeenCalled();
});

test("F3: an id-less auth labelled for another slot refuses, even when every pin read shows A", async () => {
  const h = realBridgeHarness();
  h.pins({ "openai-codex": pin("slot_A", "Alpha") });
  h.resolve.mockImplementation(async () => ({
    accessToken: jwt("acct_B"),
    label: "Beta",
    source: "oauth",
  }));
  await expect(requireCodexCredentials(h.ctx, "/probe")).rejects.toBeInstanceOf(
    CodexIdentityRefusedError,
  );
  expect(h.fallback).not.toHaveBeenCalled();
});

const jwtV = (id: string, version: number) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id }, version })).toString("base64url")}.sig`;

function autoRedeemNetwork(expiries: Record<string, number>) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const account = headers["chatgpt-account-id"]!;
    if (String(url) === CONSUME_RESET_URL) return new Response(JSON.stringify({ code: "reset" }));
    return new Response(
      JSON.stringify({
        credits: [
          {
            id: `credit_${account}`,
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: expiries[account],
          },
        ],
        available_count: 1,
      }),
    );
  });
}

test("auto-redeem re-arms for the newly selected account's sooner credit after a switch", async () => {
  vi.useFakeTimers();
  const h = realBridgeHarness();
  h.ctx.ui = { notify: vi.fn() } as unknown as ExtensionContext["ui"];
  let account = "acct_A";
  h.refresh(async () => jwt(account));
  const network = autoRedeemNetwork({
    acct_A: Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS + 10 * 60 * 60_000,
    acct_B: Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS + 60_000,
  });
  vi.stubGlobal("fetch", network);
  const reserve = vi.spyOn(resetGuard, "reserveBankedResetRedemption").mockReturnValue(true);
  const controller = new ResetController(() => true);
  try {
    controller.start(h.ctx);
    await controller.refresh(h.ctx);
    expect(controller.snapshot?.credentials.selection?.id).toBe("slot_A");
    account = "acct_B";
    h.change("slot_B");
    await controller.refresh(h.ctx, { force: true });
    expect(controller.snapshot?.credentials.selection?.id).toBe("slot_B");
    await vi.advanceTimersByTimeAsync(61_000);
    const posts = network.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]?.headers).toMatchObject({ "chatgpt-account-id": "acct_B" });
    expect(JSON.parse(String(posts[0]![1]?.body))).toMatchObject({ credit_id: "credit_acct_B" });
    expect(reserve).toHaveBeenCalledExactlyOnceWith("acct_B", "credit_acct_B", {
      expiresAtMs: expect.any(Number),
    });
  } finally {
    controller.stop();
    reserve.mockRestore();
    vi.useRealTimers();
  }
});

test("auto-redeem sends the current token for the same slot, not the one captured when armed", async () => {
  vi.useFakeTimers();
  const h = realBridgeHarness();
  h.ctx.ui = { notify: vi.fn() } as unknown as ExtensionContext["ui"];
  let version = 1;
  h.refresh(async () => jwtV("acct_A", version));
  const network = autoRedeemNetwork({
    acct_A: Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS + 1000,
  });
  vi.stubGlobal("fetch", network);
  const reserve = vi.spyOn(resetGuard, "reserveBankedResetRedemption").mockReturnValue(true);
  const controller = new ResetController(() => true);
  try {
    controller.start(h.ctx);
    await controller.refresh(h.ctx);
    const armedCalls = network.mock.calls.length;
    version = 2; // the bridge refreshed A's OAuth token after the timer was armed
    await vi.advanceTimersByTimeAsync(1000);
    const fired = network.mock.calls.slice(armedCalls);
    expect(fired.some(([, init]) => init?.method === "POST")).toBe(true);
    for (const [, init] of fired)
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${jwtV("acct_A", 2)}`,
        "chatgpt-account-id": "acct_A",
      });
  } finally {
    controller.stop();
    reserve.mockRestore();
    vi.useRealTimers();
  }
});
