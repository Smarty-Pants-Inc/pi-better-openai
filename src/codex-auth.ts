import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_IDS,
  CODEX_PROVIDER_ID,
  getActiveMultiproviderService,
  type MultiproviderActiveAccount,
} from "./multiprovider.ts";
import { piAgentDir } from "./paths.ts";

export const AUTH_FILE = join(piAgentDir(), "auth.json");

export type CodexCredentials = {
  accessToken: string;
  accountId: string;
};

export type CodexCredentialsContext = Pick<
  ExtensionContext,
  "modelRegistry" | "model" | "sessionManager"
>;

export type CodexCredentialsWithSource = CodexCredentials & {
  source: "multiprovider" | "modelRegistry" | "authFile";
};

function waitForSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was aborted."));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Operation was aborted."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractAccountIdFromJwt(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const parsed = JSON.parse(decodeBase64Url(payload)) as unknown;
    if (!isRecord(parsed)) return undefined;
    const auth = parsed["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexRegistryCredentials(
  raw: string | undefined,
): CodexCredentials | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      const accessToken =
        typeof parsed.access === "string"
          ? parsed.access
          : typeof parsed.token === "string"
            ? parsed.token
            : undefined;
      const accountId =
        typeof parsed.accountId === "string"
          ? parsed.accountId
          : typeof parsed.account_id === "string"
            ? parsed.account_id
            : undefined;
      const resolvedAccountId =
        accountId?.trim() || (accessToken && extractAccountIdFromJwt(accessToken));
      if (accessToken?.trim() && resolvedAccountId)
        return { accessToken: accessToken.trim(), accountId: resolvedAccountId };
    }
  } catch {
    // Pi returns the plain bearer token for ChatGPT OAuth.
  }
  const accountId = extractAccountIdFromJwt(value);
  return accountId ? { accessToken: value, accountId } : undefined;
}

/**
 * Pi 1.0's "Sign in with ChatGPT" (`openai`, client `dynamic_agent_client`) stores
 * `{type, access, refresh, expires, clientId, scopes}`: no account id, and the access token
 * has no `chatgpt_account_id` claim. Pi sends it only to `https://api.openai.com/v1`
 * (pi-ai `providers/openai.js:10`, `auth/oauth/openai-chatgpt.js:18,262-264`). Pi's own
 * chatgpt.com backend path refuses a token without an account id
 * (pi-ai `api/openai-codex-responses.js:1266-1279`), so this extension does too.
 */
export const ACCOUNT_ID_ISSUE = "Smarty-Pants-Inc/pi-better-openai#27";

export function accountIdRequiredMessage(
  command: string,
  alternative?: string,
  selectedPool?: string,
): string {
  if (selectedPool)
    return (
      `${command} needs a ChatGPT account id; the selected ${selectedPool} account does not provide one, ` +
      `and another account is never used in its place. Select an openai-codex account, or run /login openai-codex ` +
      `(OpenAI Codex, legacy)${alternative ? `, ${alternative}` : ""} to use it (see ${ACCOUNT_ID_ISSUE}).`
    );
  return (
    `${command} needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one. ` +
    `Run /login openai-codex (OpenAI Codex, legacy)${alternative ? `, ${alternative}` : ""} to use it (see ${ACCOUNT_ID_ISSUE}).`
  );
}

/** A clear refusal: the one permitted identity cannot serve this endpoint. */
export class CodexIdentityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexIdentityRefusedError";
  }
}

export class AccountIdRequiredError extends CodexIdentityRefusedError {
  constructor(command: string, alternative?: string, selectedPool?: string) {
    super(accountIdRequiredMessage(command, alternative, selectedPool));
    this.name = "AccountIdRequiredError";
  }
}

/** A ChatGPT OAuth JWT (not an `sk-` API key) that carries no account id. */
function isDirectChatGptToken(token: string | undefined): boolean {
  const value = token?.trim();
  return (
    !!value &&
    !value.startsWith("sk-") &&
    value.split(".").length === 3 &&
    !extractAccountIdFromJwt(value)
  );
}

type AuthFileResolution = { credentials?: CodexCredentials; directTokenOnly: boolean };

function resolveAuthFile(): AuthFileResolution {
  let directTokenOnly = false;
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<
      string,
      | {
          type?: string;
          access?: string | null;
          accountId?: string | null;
          account_id?: string | null;
          expires?: number | null;
        }
      | undefined
    >;
    for (const providerId of CHATGPT_PROVIDER_IDS) {
      const entry = auth[providerId];
      if (entry?.type !== "oauth") continue;
      if (typeof entry.expires === "number" && Date.now() >= entry.expires) continue;
      const credentials = parseCodexRegistryCredentials(JSON.stringify(entry));
      if (credentials) return { credentials, directTokenOnly: false };
      if (typeof entry.access === "string" && isDirectChatGptToken(entry.access))
        directTokenOnly = true;
    }
    return { directTokenOnly };
  } catch {
    return { directTokenOnly };
  }
}

export function readCodexAuth(): CodexCredentials | undefined {
  return resolveAuthFile().credentials;
}

/** Pi's own stored `openai-codex` login: the default identity when no model registry is available. */
function readDefaultCodexAuthFile(): { token?: string; directToken: boolean } {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<
      string,
      { type?: string; access?: unknown; expires?: unknown } | undefined
    >;
    const usable = (entry: (typeof auth)[string]) =>
      entry?.type === "oauth" &&
      typeof entry.access === "string" &&
      !(typeof entry.expires === "number" && Date.now() >= entry.expires);
    const codex = auth[CODEX_PROVIDER_ID];
    const openai = auth[CHATGPT_PROVIDER_ID];
    return {
      token: usable(codex) ? JSON.stringify(codex) : undefined,
      directToken: usable(openai) && isDirectChatGptToken(openai?.access as string),
    };
  } catch {
    return { directToken: false };
  }
}

export async function getCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexCredentialsWithSource | undefined> {
  const resolved = await resolveCodexIdentity(ctx, signal);
  return resolved.kind === "refuse" ? undefined : resolved.credentials;
}

/**
 * Credentials for a chatgpt.com backend endpoint. Throws a clear refusal when the selected
 * account cannot serve it, or when there is no selection and no default openai-codex login.
 */
export async function requireCodexCredentials(
  ctx: CodexCredentialsContext | undefined,
  command: string,
  missingMessage: string,
  signal?: AbortSignal,
  alternative?: string,
): Promise<CodexCredentialsWithSource> {
  const resolved = await resolveCodexIdentity(ctx, signal);
  if (resolved.kind !== "refuse") return resolved.credentials;
  switch (resolved.reason) {
    case "selected-unresolved":
      throw new CodexIdentityRefusedError(
        `${command} could not resolve the selected ${resolved.selectedPool} account, and another account is never used in its place. ` +
          `Select or log in to an openai-codex account (/login openai-codex).`,
      );
    case "selected-ambiguous":
      throw new CodexIdentityRefusedError(
        `${command} found selected accounts in more than one ChatGPT pool and cannot tell which one this session uses; ` +
          `another account is never used in its place. Switch to a model from the pool you want.`,
      );
    case "selected-no-account-id":
      throw new AccountIdRequiredError(command, alternative, resolved.selectedPool);
    case "default-direct-only":
      throw new AccountIdRequiredError(command, alternative);
    default:
      throw new Error(missingMessage);
  }
}

export type CodexIdentity =
  | { kind: "selected" | "default"; credentials: CodexCredentialsWithSource }
  | {
      kind: "refuse";
      reason:
        | "selected-unresolved"
        | "selected-ambiguous"
        | "selected-no-account-id"
        | "default-direct-only"
        | "default-missing";
      selectedPool?: string;
    };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");
}

/**
 * Security S2 / Astra R3 (PR #27). ponytail: one identity source, no fallback chain.
 * - Any pi-multiprovider selection (`getActiveAccount()` returns an account in a ChatGPT pool)
 *   resolves ONLY that account; `undefined`, a throw, or no account id refuses.
 * - With no selection at all, ONLY Pi's default `openai-codex` credential is used; else refuse.
 */
export async function resolveCodexIdentity(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexIdentity> {
  throwIfAborted(signal);
  const multiprovider = getActiveMultiproviderService();
  if (multiprovider) {
    // Without a context the selection cannot be read, so "nothing selected" is unproven.
    if (!ctx) return { kind: "refuse", reason: "selected-unresolved", selectedPool: "ChatGPT" };
    const modelPool = (CHATGPT_PROVIDER_IDS as readonly string[]).includes(
      ctx.model?.provider ?? "",
    )
      ? ctx.model?.provider
      : undefined;
    const pinned = new Map<string, MultiproviderActiveAccount>();
    for (const providerId of CHATGPT_PROVIDER_IDS) {
      try {
        const active = await waitForSignal(multiprovider.getActiveAccount(providerId, ctx), signal);
        if (active) pinned.set(providerId, active);
      } catch {
        throwIfAborted(signal);
        return { kind: "refuse", reason: "selected-unresolved", selectedPool: providerId };
      }
    }
    const selectedPool =
      modelPool && pinned.has(modelPool)
        ? modelPool
        : pinned.size === 1
          ? [...pinned.keys()][0]
          : undefined;
    if (pinned.size > 0 && !selectedPool) return { kind: "refuse", reason: "selected-ambiguous" };
    if (selectedPool) {
      let resolved;
      try {
        resolved = await waitForSignal(
          multiprovider.resolveActiveAccountAuth(selectedPool, ctx, signal),
          signal,
        );
      } catch {
        throwIfAborted(signal);
        resolved = undefined;
      }
      // A pin that changed between the two calls (switch/resume) is not the selected account.
      if (!resolved || resolved.label !== pinned.get(selectedPool)?.label)
        return { kind: "refuse", reason: "selected-unresolved", selectedPool };
      const accountId = extractAccountIdFromJwt(resolved.accessToken);
      if (!accountId) return { kind: "refuse", reason: "selected-no-account-id", selectedPool };
      return {
        kind: "selected",
        credentials: { accessToken: resolved.accessToken, accountId, source: "multiprovider" },
      };
    }
  }

  // No selection: Pi's single default openai-codex credential.
  const registry = ctx?.modelRegistry;
  let token: string | undefined;
  let directToken = false;
  if (registry) {
    token = await waitForSignal(
      Promise.resolve(registry.getApiKeyForProvider(CODEX_PROVIDER_ID)).catch(() => undefined),
      signal,
    );
  } else {
    ({ token, directToken } = readDefaultCodexAuthFile());
  }
  throwIfAborted(signal);
  const credentials = parseCodexRegistryCredentials(token);
  if (credentials)
    return {
      kind: "default",
      credentials: { ...credentials, source: registry ? "modelRegistry" : "authFile" },
    };
  if (registry && !token) {
    // Message only: say why /login openai is not enough. This token is never sent anywhere.
    const openai = await waitForSignal(
      Promise.resolve(registry.getApiKeyForProvider(CHATGPT_PROVIDER_ID)).catch(() => undefined),
      signal,
    );
    directToken = isDirectChatGptToken(openai);
  }
  return {
    kind: "refuse",
    reason: directToken || isDirectChatGptToken(token) ? "default-direct-only" : "default-missing",
  };
}
