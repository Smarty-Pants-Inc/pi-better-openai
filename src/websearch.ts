import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import {
  isRecord,
  WEBSEARCH_RESPONSE_LENGTHS,
  type ResolvedConfig,
  type WebsearchResponseLength,
} from "./config.ts";
import {
  type CodexCredentials,
  getCodexCredentials,
  type CodexCredentialsWithSource,
} from "./codex-auth.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { resolveProviderRoute } from "./provider-route.ts";

export const OPENAI_WEBSEARCH_TOOL = "openai_websearch";
export const OPENAI_WEBSEARCH_COMMAND = "openai-websearch";
export const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
export const SEARCH_ORIGINATOR = "codex_cli_rs";
export const MAX_QUERY_BYTES = 8 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_TEXT_SOURCES = 10;

export type WebSearchErrorCode =
  | "authentication_required"
  | "authentication_failed"
  | "invalid_query"
  | "request_failed"
  | "request_timeout"
  | "request_aborted"
  | "response_too_large"
  | "invalid_response";

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;

  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
  }
}

export type WebSearchResult = {
  url: string;
  title?: string;
  content?: string;
};

export type WebSearchAnswer = {
  answer: string;
  results: WebSearchResult[];
};

type ToolParams = {
  query: string;
  responseLength?: WebsearchResponseLength;
};

const TOOL_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The web search query. Pass the user's information need verbatim.",
    },
    responseLength: {
      type: "string",
      enum: WEBSEARCH_RESPONSE_LENGTHS,
      description:
        "Answer length produced by the search backend. Defaults to the configured value.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export type WebSearchDebug = {
  authFound: boolean;
  authSource?: string;
  accountId?: string;
  endpoint: string;
  model: string;
  reasoningEffort: string;
  enabled: boolean;
  lastStatus?: string;
  lastError?: string;
};

type SearchRoute = {
  url: string;
  credentials: CodexCredentials & { source: CodexCredentialsWithSource["source"] | "provider" };
  provider?: string;
};

/**
 * With websearch.provider set, search goes through that pi provider (for example a
 * CLIProxyAPI gateway) with its base URL and API key, resolved by resolveProviderRoute.
 * The gateway owns ChatGPT OAuth and account selection. Unset keeps openai-codex OAuth.
 */
async function resolveSearchRoute(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  signal?: AbortSignal,
): Promise<SearchRoute> {
  const provider = cfg.websearch.provider;
  if (!provider) {
    const credentials = await getCodexCredentials(ctx, signal);
    if (credentials) return { url: CODEX_SEARCH_URL, credentials };
    throw new WebSearchError(
      "authentication_required",
      "Missing openai-codex OAuth credentials. Run /login openai-codex, or set websearch.provider.",
    );
  }
  let route: ReturnType<typeof resolveProviderRoute>;
  try {
    route = resolveProviderRoute(ctx, provider);
  } catch {
    throw new WebSearchError(
      "authentication_required",
      `Web search provider "${provider}" has no model with a base URL in pi.`,
    );
  }
  const credentials = await route.getCredentials();
  if (!credentials) {
    throw new WebSearchError(
      "authentication_required",
      `Web search provider "${provider}" has no API key in pi.`,
    );
  }
  return {
    url: `${route.baseUrl}/v1/alpha/search`,
    credentials: { ...credentials, source: "provider" },
    provider,
  };
}

export function validateSearchQuery(query: string): string {
  const value = query.trim();
  if (!value) throw new WebSearchError("invalid_query", "Web search requires a non-empty query.");
  if (new TextEncoder().encode(value).byteLength > MAX_QUERY_BYTES) {
    throw new WebSearchError(
      "invalid_query",
      `Web search query exceeded ${MAX_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

export function buildSearchRequestBody(
  query: string,
  cfg: ResolvedConfig["websearch"],
  responseLength: WebsearchResponseLength,
  id: string,
): Record<string, unknown> {
  return {
    id,
    model: cfg.model,
    reasoning: { effort: cfg.reasoningEffort },
    input: query,
    commands: {
      search_query: [{ q: query }],
      response_length: responseLength,
    },
    settings: {
      allowed_callers: ["direct"],
      external_web_access: true,
    },
    max_output_tokens: cfg.maxOutputTokens,
  };
}

export function buildSearchHeaders(credentials: CodexCredentials): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    // A gateway route has no account ID; the gateway selects the account.
    ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
    accept: "application/json",
    "content-type": "application/json",
    originator: SEARCH_ORIGINATOR,
    "User-Agent": "codex_cli_rs/0.0.0 (pi-better-openai)",
  };
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSafeUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function parseSearchResponse(body: string): WebSearchAnswer {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new WebSearchError("invalid_response", "ChatGPT web search returned invalid JSON.");
  }
  if (!isRecord(value) || typeof value.output !== "string") {
    throw new WebSearchError(
      "invalid_response",
      "ChatGPT web search returned an invalid response.",
    );
  }
  if (value.results === undefined || value.results === null) {
    throw new WebSearchError(
      "invalid_response",
      "ChatGPT web search did not return structured citations; the alpha protocol may have changed.",
    );
  }
  if (!Array.isArray(value.results)) {
    throw new WebSearchError("invalid_response", "ChatGPT web search returned invalid results.");
  }
  const results = value.results.flatMap((result): WebSearchResult[] => {
    if (!isRecord(result) || result.type !== "text_result" || typeof result.url !== "string")
      return [];
    if (!isSafeUrl(result.url)) return [];
    const title = trimmedText(result.title);
    const content = trimmedText(result.snippet);
    return [{ url: result.url, ...(title ? { title } : {}), ...(content ? { content } : {}) }];
  });
  return { answer: value.output.trim(), results };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchError(
      "response_too_large",
      `ChatGPT web search response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebSearchError(
          "response_too_large",
          `ChatGPT web search response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function formatSearchText(query: string, answer: WebSearchAnswer): string {
  const lines: string[] = [];
  if (answer.answer) lines.push(answer.answer, "");
  const sources = answer.results.slice(0, MAX_TEXT_SOURCES);
  if (sources.length > 0) {
    lines.push("Sources:");
    sources.forEach((result, index) => {
      lines.push(`${index + 1}. [${result.title ?? result.url}](${result.url})`);
      if (result.content) lines.push(`   ${result.content}`);
    });
  }
  if (lines.length === 0) return `No web results found for "${query}".`;
  return lines.join("\n").trim();
}

async function requestWebSearch(
  params: ToolParams,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  requestSignal?: AbortSignal,
): Promise<{ query: string; answer: WebSearchAnswer; model: string }> {
  if (!cfg.websearch.enabled) throw new Error("OpenAI web search is disabled in config.");
  const query = validateSearchQuery(String(params.query ?? ""));
  const responseLength = params.responseLength ?? cfg.websearch.responseLength;
  const timeoutSignal = AbortSignal.timeout(cfg.websearch.timeoutMs);
  const baseSignal = requestSignal ?? ctx.signal;
  const signal = baseSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : timeoutSignal;
  const route = await resolveSearchRoute(ctx, cfg, signal);

  let response: Response;
  try {
    response = await fetch(route.url, {
      method: "POST",
      headers: buildSearchHeaders(route.credentials),
      body: JSON.stringify(
        buildSearchRequestBody(query, cfg.websearch, responseLength, crypto.randomUUID()),
      ),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (baseSignal?.aborted)
      throw new WebSearchError("request_aborted", "ChatGPT web search was aborted.");
    if (timeoutSignal.aborted)
      throw new WebSearchError(
        "request_timeout",
        `ChatGPT web search timed out after ${cfg.websearch.timeoutMs}ms.`,
      );
    throw new WebSearchError(
      "request_failed",
      `ChatGPT web search request failed: ${sanitizeDiagnosticError(error instanceof Error ? error.message : String(error))}`,
    );
  }

  if (response.url && new URL(response.url).origin !== new URL(route.url).origin) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchError(
      "request_failed",
      "ChatGPT web search returned from an unexpected origin.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new WebSearchError(
        "authentication_failed",
        route.provider
          ? `Web search authentication failed at provider "${route.provider}" (HTTP ${response.status}). Check its API key in pi.`
          : `ChatGPT web search authentication failed (HTTP ${response.status}). Reconnect with /login openai-codex.`,
      );
    }
    throw new WebSearchError(
      "request_failed",
      `ChatGPT web search failed (HTTP ${response.status}).`,
    );
  }

  const parsed = parseSearchResponse(await readBoundedResponse(response));
  return { query, answer: parsed, model: cfg.websearch.model };
}

export function registerOpenAIWebSearch(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
): { getDebug: (ctx: ExtensionContext) => Promise<WebSearchDebug> } {
  let lastStatus: string | undefined;
  let lastError: string | undefined;

  async function search(
    params: ToolParams,
    ctx: ExtensionContext,
    requestSignal?: AbortSignal,
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    try {
      lastStatus = "requesting";
      lastError = undefined;
      const result = await requestWebSearch(params, ctx, getConfig(ctx), requestSignal);
      lastStatus = `completed (${result.answer.results.length} sources)`;
      return {
        text: formatSearchText(result.query, result.answer),
        details: {
          query: result.query,
          answer: result.answer.answer,
          results: result.answer.results,
          model: result.model,
        },
      };
    } catch (error) {
      lastStatus = "error";
      lastError = sanitizeDiagnosticError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function getDebug(ctx: ExtensionContext): Promise<WebSearchDebug> {
    const cfg = getConfig(ctx);
    let route: SearchRoute | undefined;
    try {
      route = await resolveSearchRoute(ctx, cfg);
    } catch {
      route = undefined;
    }
    return {
      authFound: route !== undefined,
      authSource: route?.provider ? `provider:${route.provider}` : route?.credentials.source,
      accountId: maskIdentifier(route?.credentials.accountId),
      endpoint:
        route?.url ??
        (cfg.websearch.provider ? `provider "${cfg.websearch.provider}"` : CODEX_SEARCH_URL),
      model: cfg.websearch.model,
      reasoningEffort: cfg.websearch.reasoningEffort,
      enabled: cfg.websearch.enabled,
      lastStatus,
      lastError,
    };
  }

  pi.registerMessageRenderer("openai-websearch", (message, _options, theme) => {
    const text = Array.isArray(message.content)
      ? message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : String(message.content ?? "");
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(
      new Text(`${theme.fg("accent", theme.bold("[openai-websearch]"))}\n\n${text}`, 0, 0),
    );
    container.addChild(box);
    return container;
  });

  pi.registerCommand(OPENAI_WEBSEARCH_COMMAND, {
    description: "Search the web with the ChatGPT Codex search backend",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /openai-websearch <query>", "error");
        return;
      }
      ctx.ui.notify("Searching the web via ChatGPT...", "info");
      const result = await search({ query }, ctx);
      pi.sendMessage({
        customType: "openai-websearch",
        content: [{ type: "text", text: result.text }],
        display: true,
        details: result.details,
      });
    },
  });

  pi.registerTool({
    name: OPENAI_WEBSEARCH_TOOL,
    label: "OpenAI web search",
    description:
      "Search the live web through the ChatGPT Codex search backend using OpenAI subscription auth. Returns an answer with cited sources.",
    promptSnippet: "Search the live web via the ChatGPT Codex search backend.",
    promptGuidelines: [
      "Use openai_websearch when the user asks about current events, recent releases, prices, or anything requiring live web data.",
      "Prefer openai_websearch over recalling facts that may have changed recently; cite the returned source URLs in your answer.",
    ],
    parameters: TOOL_PARAMS,
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Searching the web via ChatGPT for "${params.query}"...` }],
        details: undefined,
      });
      const result = await search(params, ctx, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  return { getDebug };
}

export const _websearchTest = {
  CODEX_SEARCH_URL,
  MAX_QUERY_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TEXT_SOURCES,
  OPENAI_WEBSEARCH_COMMAND,
  OPENAI_WEBSEARCH_TOOL,
  SEARCH_ORIGINATOR,
  buildSearchHeaders,
  buildSearchRequestBody,
  formatSearchText,
  parseSearchResponse,
  readBoundedResponse,
  validateSearchQuery,
};
