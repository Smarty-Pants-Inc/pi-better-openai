import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClassifierApi,
  ClassifierModel,
  ClassifierResult,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  availableClassifiers,
  buildDecisionConfirmation,
  cachedAvailableClassifierModelKeys,
  findAvailableClassifier,
  DECISION_PREVIEW_MAX_BYTES,
  decisionModelPickerOverride,
  serializeDecisionPreview,
  evaluateDecision,
  registerOpenAIDecisions,
  validateDecisionAnswers,
  validateDecisionRequest,
  MAX_DECISION_BYTES,
} from "../src/decisions.ts";
import { configPaths, readRawConfig, resolveConfig, writeConfig } from "../src/config.ts";
import { makeResolvedConfig } from "./helpers.ts";

const model = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  api: "typesafe-system-one",
} as ClassifierModel<ClassifierApi>;
const rawOnly = {
  type: "classifier",
  provider: "openai",
  id: "gpt-6-luna",
  api: "openai-decisions",
  baseUrl: "https://api.openai.com/v1",
} as ClassifierModel<ClassifierApi>;
const input = {
  state: { failures: ["timeout connecting to test database"] },
  questions: {
    route: {
      type: "choice" as const,
      instructions: "Select a test-failure category.",
      criteria: { environment: "An environment problem", code: "A code defect" },
    },
    retry: {
      type: "bool" as const,
      instructions: "Would retrying help?",
      criteria: { true: "Transient problem", false: "Persistent problem" },
    },
    urgency: {
      type: "score" as const,
      instructions: "How urgently does this need review?",
      criteria: ["routine", "urgent"],
    },
  },
};
const usage: Usage = {
  input: 24,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 24,
  cost: { input: 0.000001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
};
const result: ClassifierResult = {
  api: "typesafe-system-one",
  provider: "typesafe",
  model: "jev-latest",
  stopReason: "stop",
  timestamp: 1,
  usage,
  answers: {
    route: {
      type: "choice",
      choice: "environment",
      probabilities: { environment: 0.9, code: 0.1 },
      confidence: 0.8,
    },
    retry: { type: "bool", probability: 0.7 },
    urgency: { type: "score", score: 0.3, confidence: 0.6 },
  },
};

function harness() {
  const cfg = makeResolvedConfig({
    decisions: {
      enabled: true,
      model: "typesafe/jev-latest",
      timeoutMs: 1000,
      allowWithoutConfirmation: false,
    },
  });
  const classify = vi.fn(async () => structuredClone(result));
  const ctx = {
    modelRegistry: {
      classify,
      // Raw catalog also contains a classifier the current credentials cannot use
      // (as Pi does for OpenAI Decisions under ChatGPT OAuth). It must never be used.
      getModelOfType: vi.fn((type: string, provider: string, id: string) =>
        type === "classifier"
          ? [model, rawOnly].find((m) => m.provider === provider && m.id === id)
          : undefined,
      ),
      getModelsOfType: vi.fn(() => [model, rawOnly]),
      getAvailableOfType: vi.fn(async (type: string) => (type === "classifier" ? [model] : [])),
    },
    hasUI: true,
    ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
    tools: [],
    executeTool: vi.fn(),
  } as unknown as ExtensionToolContext;
  return { ctx, cfg, classify, confirm: vi.mocked(ctx.ui.confirm) };
}

const scratch: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native typed decisions", () => {
  test("uses only the explicitly selected native classifier and preserves answers and usage", async () => {
    const { ctx, cfg, classify } = harness();
    const response = await evaluateDecision(ctx, cfg, input);
    expect(classify).toHaveBeenCalledExactlyOnceWith(model, input, {
      signal: expect.any(AbortSignal),
      maxRetries: 0,
    });
    expect(response.structuredContent).toEqual({
      status: "ok",
      provider: "typesafe",
      model: "jev-latest",
      answers: result.answers,
    });
    expect(response.usage).toEqual(usage);
    expect(response.isError).toBeUndefined();
    expect(response.content[0]!.text).not.toContain("timeout connecting");
  });

  test("lists, accepts, and uses only classifiers passing the shared availability predicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-decisions-"));
    scratch.push(dir);
    const path = configPaths(dir).project;
    const { ctx, cfg, classify, confirm } = harness();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    registerOpenAIDecisions(
      {
        registerTool: vi.fn(),
        registerCommand: (
          name: string,
          cmd: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
        ) => commands.set(name, cmd),
      } as unknown as ExtensionAPI,
      () => resolveConfig(dir),
      () => resolveConfig(dir),
    );
    const command = commands.get("openai-decisions")!;
    await command.handler("models", ctx);
    const listed = vi.mocked(ctx.ui.notify).mock.calls.at(-1)![0];
    expect(listed).toContain("typesafe/jev-latest");
    expect(listed).not.toContain("openai/gpt-6-luna");
    await command.handler("use openai/gpt-6-luna", ctx);
    expect(vi.mocked(ctx.ui.notify).mock.calls.at(-1)).toEqual([
      expect.stringContaining("unavailable"),
      "error",
    ]);
    expect(readRawConfig(path).decisions).toBeUndefined();
    // A hand-edited config cannot reach a raw-catalog-only classifier either.
    const rawOnlyCfg = { ...cfg, decisions: { ...cfg.decisions, model: "openai/gpt-6-luna" } };
    expect((await evaluateDecision(ctx, rawOnlyCfg, input)).structuredContent).toMatchObject({
      error: expect.stringContaining("unavailable"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.getModelOfType).not.toHaveBeenCalled();
    expect(cachedAvailableClassifierModelKeys()).toEqual(["typesafe/jev-latest"]);
  });

  test("fails closed on hosts without the classifier availability API or when it throws", async () => {
    const { ctx, cfg, classify } = harness();
    expect(await availableClassifiers({})).toEqual([]);
    expect(cachedAvailableClassifierModelKeys()).toEqual([]);
    const legacy = { ...ctx, modelRegistry: { classify } } as unknown as typeof ctx;
    expect((await evaluateDecision(legacy, cfg, input)).isError).toBe(true);
    vi.mocked(ctx.modelRegistry.getAvailableOfType).mockRejectedValue(new Error("auth broke"));
    expect((await evaluateDecision(ctx, cfg, input)).isError).toBe(true);
    expect(classify).not.toHaveBeenCalled();
  });

  test("real Pi registry: OpenAI Decisions under ChatGPT OAuth is in the raw catalog but not selectable", async () => {
    const credentials = new InMemoryCredentialStore();
    const registry = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    registry.setProvider(builtinProviders().find((p) => p.id === "openai")!);
    await credentials.modify("openai", async () => ({
      type: "oauth",
      access: "synthetic",
      refresh: "synthetic",
      expires: Date.now() + 3_600_000,
    }));
    expect(registry.getModelOfType("classifier", "openai", "gpt-6-luna")).toBeDefined();
    expect(await findAvailableClassifier(registry, "openai", "gpt-6-luna")).toBeUndefined();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic" }));
    expect(await findAvailableClassifier(registry, "openai", "gpt-6-luna")).toMatchObject({
      provider: "openai",
      id: "gpt-6-luna",
    });
  });

  test("declined confirmation sends nothing", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    confirm.mockResolvedValue(false);
    const response = await evaluateDecision(ctx, cfg, input);
    expect(confirm).toHaveBeenCalledOnce();
    expect(classify).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: "error",
      error: expect.stringContaining("declined by user"),
    });
  });

  test("accepted confirmation previews destination and exact state, then sends the same payload", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    const response = await evaluateDecision(ctx, cfg, input);
    expect(confirm).toHaveBeenCalledOnce();
    const [title, message] = confirm.mock.calls[0]!;
    expect(title).toBe("Send decision request?");
    expect(message).toContain("typesafe/jev-latest");
    expect(message).toContain(JSON.stringify(input, null, 2));
    expect(message).toContain(`${Buffer.byteLength(JSON.stringify(input))} bytes`);
    expect(classify).toHaveBeenCalledExactlyOnceWith(model, input, {
      signal: expect.any(AbortSignal),
      maxRetries: 0,
    });
    expect(response.isError).toBeUndefined();
  });

  test("confirmation shows the endpoint host and the complete request, including every question", () => {
    const tail = "TAIL-MARKER-after-the-old-2000-char-cut";
    const big = { ...input, state: { text: "y".repeat(10_000), tail } };
    const { message } = buildDecisionConfirmation(
      { provider: "openai", id: "gpt-6-luna", baseUrl: "https://api.openai.com/v1" },
      big,
    );
    expect(message).toContain("openai/gpt-6-luna (api.openai.com)");
    expect(message).toContain(`${Buffer.byteLength(JSON.stringify(big))} bytes`);
    expect(message).toContain(JSON.stringify(big, null, 2));
    expect(message).toContain(tail);
    expect(message).not.toContain("truncated");
    for (const q of Object.values(input.questions)) {
      expect(message).toContain(q.instructions);
      for (const criterion of Object.values(q.criteria)) expect(message).toContain(criterion);
    }
    for (const label of ["environment", "code", "true", "false"])
      expect(message).toContain(`"${label}"`);
    expect(buildDecisionConfirmation(model, input).message).toContain("provider-defined endpoint");
  });

  test("the preview is pure printable ASCII; every other code point is escaped and parses back", () => {
    const sneaky = {
      ...input,
      state: {
        cgj: "a\u034fb",
        vs16: "\u2764\ufe0f",
        zwsp: "ok\u200bhidden",
        rlo: "x\u202ey",
        emoji: "\u{1f600}",
        cafe: "café",
        namaste: "नमस्ते",
        controls: "\u0000\u001b\u007f\u0085\u2028\n\t",
        lone: "\ud800",
      },
    };
    const preview = serializeDecisionPreview(sneaky);
    for (const escaped of [
      '"a\\u034fb"',
      '"\\u2764\\ufe0f"',
      '"ok\\u200bhidden"',
      '"x\\u202ey"',
      '"\\ud83d\\ude00"',
      '"caf\\u00e9"',
      '"\\u0928\\u092e\\u0938\\u094d\\u0924\\u0947"',
      '"\\u0000\\u001b\\u007f\\u0085\\u2028\\n\\t"',
      '"\\ud800"',
    ])
      expect(preview).toContain(escaped);
    const unicodeModel = { provider: "prov\u202e", id: "m\u00e9" };
    const { message, request } = buildDecisionConfirmation(unicodeModel, sneaky);
    expect(message).toContain(preview);
    expect(message).toContain("Destination: prov\\u202e/m\\u00e9");
    expect(message).toMatch(/^[\x20-\x7E\n]*$/);
    expect(request).toEqual(sneaky);
    expect(JSON.parse(preview)).toEqual(sneaky);
  });

  test("destination metadata cannot inject confirmation lines", () => {
    const spoof = { provider: "safe\nFAKE: yes", id: "m\r\nDestination: evil" };
    const { message } = buildDecisionConfirmation(spoof, input);
    const lines = message.split("\n");
    expect(lines.filter((line) => line.startsWith("Destination: "))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("FAKE: "))).toBe(false);
    expect(message).toContain("Destination: safe\\u000aFAKE: yes/m\\u000d\\u000aDestination: evil");
    expect(message).toMatch(/^[\x20-\x7E\n]*$/);
  });

  test("the 16 KiB limit is measured on the escaped preview", () => {
    // Each "é" is 2 UTF-8 bytes raw but 6 bytes escaped, so this fits raw but not escaped.
    const accented = { ...input, state: { text: "é".repeat(4000) } };
    expect(Buffer.byteLength(JSON.stringify(accented, null, 2))).toBeLessThan(
      DECISION_PREVIEW_MAX_BYTES,
    );
    expect(() => buildDecisionConfirmation(model, accented)).toThrow(/too large to preview/);
  });

  test("the object previewed in the dialog is deep-equal to the object sent", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    const nested = {
      ...input,
      state: { list: [1, { a: "b\u200b" }], unicode: "éè😀", nil: null, flag: false },
    };
    await evaluateDecision(ctx, cfg, nested);
    const message = confirm.mock.calls[0]![1];
    const start = message.indexOf("\n{") + 1;
    const end = message.lastIndexOf("\n}") + 2;
    const previewed = JSON.parse(message.slice(start, end));
    expect(classify).toHaveBeenCalledOnce();
    const sent = (classify.mock.calls[0] as unknown as [unknown, unknown])[1];
    expect(sent).toEqual(previewed);
    expect(sent).toEqual(nested);
  });

  test("a request too large to preview completely is refused and nothing is sent", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    const big = { ...input, state: { text: "z".repeat(DECISION_PREVIEW_MAX_BYTES) } };
    expect(() => buildDecisionConfirmation(model, big)).toThrow(/too large to preview/);
    const response = await evaluateDecision(ctx, cfg, big);
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: "error",
      error: expect.stringMatching(/too large to preview.*reduce state/),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  test("settings picker offers only available classifiers", () => {
    const available = ["typesafe/jev-latest"];
    expect(decisionModelPickerOverride("typesafe/jev-latest", available)).toEqual({
      currentValue: "typesafe/jev-latest",
      values: ["", "typesafe/jev-latest"],
    });
    const stale = decisionModelPickerOverride("openai/gpt-6-luna", available);
    expect(stale.values).toEqual(["", "typesafe/jev-latest"]);
    expect(stale.values).not.toContain("openai/gpt-6-luna");
    expect(stale.currentValue).toBe("openai/gpt-6-luna (unavailable)");
    expect(decisionModelPickerOverride("", [])).toEqual({ currentValue: "", values: [""] });
  });

  test("without a UI, refuses by default and sends only with allowWithoutConfirmation", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    const headless = { ...ctx, hasUI: false } as typeof ctx;
    const refused = await evaluateDecision(headless, cfg, input);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: expect.stringContaining("decisions.allowWithoutConfirmation"),
    });
    expect(classify).not.toHaveBeenCalled();
    const allowed = await evaluateDecision(
      headless,
      { ...cfg, decisions: { ...cfg.decisions, allowWithoutConfirmation: true } },
      input,
    );
    expect(allowed.isError).toBeUndefined();
    expect(classify).toHaveBeenCalledExactlyOnceWith(model, input, {
      signal: expect.any(AbortSignal),
      maxRetries: 0,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("cancelling while the confirmation is open sends nothing", async () => {
    const { ctx, cfg, classify, confirm } = harness();
    const controller = new AbortController();
    confirm.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const response = await evaluateDecision(ctx, cfg, input, controller.signal);
    expect(response.structuredContent).toMatchObject({ error: "Decision request aborted." });
    expect(classify).not.toHaveBeenCalled();
  });

  test("is disabled by default and never auto-selects a provider or chat fallback", async () => {
    const { ctx, cfg, classify } = harness();
    for (const decisions of [
      makeResolvedConfig().decisions,
      { ...cfg.decisions, model: "" },
      { ...cfg.decisions, model: "openai/gpt-6-luna" },
      { ...cfg.decisions, model: "openai-codex/gpt-6.1-sol" },
    ]) {
      expect((await evaluateDecision(ctx, { ...cfg, decisions }, input)).isError).toBe(true);
    }
    expect(classify).not.toHaveBeenCalled();
  });

  test("rejects excessive, malformed, and non-JSON inputs before classification", async () => {
    const { ctx, cfg, classify } = harness();
    const bad = [
      { ...input, state: "not an object" },
      { ...input, state: { text: "x".repeat(MAX_DECISION_BYTES) } },
      { ...input, state: { bad: Infinity } },
      { ...input, state: { bad: undefined } },
      { ...input, extra: true },
      { ...input, questions: {} },
      {
        ...input,
        questions: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [String(i), input.questions.retry]),
        ),
      },
      { ...input, questions: { q: { ...input.questions.retry, type: "text" } } },
      { ...input, questions: { q: { ...input.questions.retry, instructions: " " } } },
      {
        ...input,
        questions: { q: { ...input.questions.retry, criteria: { yes: "yes", no: "no" } } },
      },
      { ...input, questions: { q: { ...input.questions.urgency, criteria: ["only one"] } } },
      {
        ...input,
        questions: JSON.parse(
          '{"__proto__":{"type":"bool","instructions":"test","criteria":{"true":"yes","false":"no"}}}',
        ),
      },
    ];
    for (const request of bad)
      expect((await evaluateDecision(ctx, cfg, request)).isError).toBe(true);
    expect(classify).not.toHaveBeenCalled();
  });

  test("rejects malformed answers without exposing returned state; retains billed usage", async () => {
    const { ctx, cfg, classify } = harness();
    classify.mockResolvedValue({
      ...result,
      answers: { ...result.answers, retry: { type: "bool", probability: 2 } },
      errorMessage: "secret provider echo",
    });
    const response = await evaluateDecision(ctx, cfg, input);
    expect(response.isError).toBe(true);
    expect(response.usage).toEqual(usage);
    expect(JSON.stringify(response)).not.toContain("secret provider echo");
  });

  test("validates answer types, labels, probabilities, and exact question coverage", () => {
    for (const answers of [
      {},
      { ...result.answers, other: result.answers.retry },
      { ...result.answers, retry: { type: "score", score: 0.5, confidence: 0.5 } },
      { ...result.answers, route: { ...result.answers.route, choice: "invented" } },
      {
        ...result.answers,
        route: { ...result.answers.route, probabilities: { environment: 0.9, code: 0.9 } },
      },
      { ...result.answers, urgency: { type: "score", score: NaN, confidence: 0.2 } },
    ])
      expect(() => validateDecisionAnswers(answers, input)).toThrow("invalid typed answers");
    const extra = {
      ...result.answers,
      retry: { ...result.answers.retry, secret: "must not escape" },
    };
    expect(validateDecisionAnswers(extra, input)).toEqual(result.answers);
    expect(
      validateDecisionAnswers(
        { ...result.answers, urgency: { type: "score", score: 4, confidence: 3 } },
        input,
      ).urgency,
    ).toMatchObject({ score: 4 });
    expect(validateDecisionRequest(input)).toEqual(input);
  });

  test("does not leak provider error text or silently change providers", async () => {
    const { ctx, cfg, classify } = harness();
    classify.mockResolvedValue({
      ...result,
      stopReason: "error",
      errorMessage: "Bearer sk-super-secret account private submitted state",
    });
    const failed = await evaluateDecision(ctx, cfg, input);
    expect(failed.isError).toBe(true);
    expect(failed.usage).toEqual(usage);
    expect(JSON.stringify(failed)).not.toContain("sk-super-secret");
    classify.mockRejectedValue(new Error("Bearer sk-super-secret"));
    expect(JSON.stringify(await evaluateDecision(ctx, cfg, input))).not.toContain(
      "sk-super-secret",
    );
    classify.mockResolvedValue({ ...result, provider: "unexpected" });
    expect((await evaluateDecision(ctx, cfg, input)).isError).toBe(true);
    expect(classify).toHaveBeenCalledTimes(3);
  });

  test("honors cancellation before and during a request", async () => {
    const { ctx, cfg, classify } = harness();
    const aborted = AbortSignal.abort();
    expect((await evaluateDecision(ctx, cfg, input, aborted)).structuredContent).toMatchObject({
      status: "error",
      error: "Decision request aborted.",
    });
    expect(classify).not.toHaveBeenCalled();
    classify.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = evaluateDecision(ctx, cfg, input, controller.signal);
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending).structuredContent).toMatchObject({ error: "Decision request aborted." });
    const options = vi.mocked(ctx.modelRegistry.classify).mock.calls[0]![2]!;
    expect(options.signal?.aborted).toBe(true);
  });

  test("enforces a deadline even if an adapter ignores cancellation, without retries", async () => {
    vi.useFakeTimers();
    const { ctx, cfg, classify } = harness();
    classify.mockImplementation(() => new Promise(() => {}));
    const pending = evaluateDecision(ctx, cfg, input);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).structuredContent).toMatchObject({
      status: "error",
      error: "Decision request timed out.",
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("registers a callable structured tool and explicit model-selection commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-decisions-"));
    scratch.push(dir);
    const path = configPaths(dir).project;
    writeConfig(path, { unknown: true, decisions: { enabled: false, unknown: "keep" } });
    const { ctx, classify } = harness();
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: (
        name: string,
        cmd: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, cmd),
    } as unknown as ExtensionAPI;
    registerOpenAIDecisions(
      pi,
      () => resolveConfig(dir),
      () => resolveConfig(dir),
    );
    const command = commands.get("openai-decisions")!;
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    await command.handler("models", ctx);
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("typesafe/jev-latest"),
      "info",
    );
    await command.handler("use openai/gpt-6-luna", ctx);
    expect(readRawConfig(path).decisions).toMatchObject({ enabled: false });
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    await command.handler("use typesafe/jev-latest", ctx);
    expect(readRawConfig(path)).toMatchObject({
      unknown: true,
      decisions: { enabled: true, model: "typesafe/jev-latest", unknown: "keep" },
    });
    const tool = tools.get("openai_decide")!;
    expect(tool.exposure).toBe("direct");
    expect(tool.outputSchema).toBeDefined();
    expect(
      (await tool.execute("decision", input, undefined, undefined, ctx)).structuredContent,
    ).toMatchObject({ status: "ok" });
    await command.handler("off", ctx);
    expect(tools.get("openai_decide")!.exposure).toBe("hidden");
    expect((await tool.execute("decision", input, undefined, undefined, ctx)).isError).toBe(true);
    expect(classify).toHaveBeenCalledOnce();
  });
});
