import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHATGPT_PROVIDER_IDS,
  CODEX_PROVIDER_ID,
  getActiveMultiproviderService,
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

export function accountIdRequiredMessage(command: string, alternative?: string): string {
  return (
    `${command} needs a ChatGPT account id; Pi 1.0's ChatGPT login (/login openai) does not provide one. ` +
    `Run /login openai-codex (OpenAI Codex, legacy)${alternative ? `, ${alternative}` : ""} to use it (see ${ACCOUNT_ID_ISSUE}).`
  );
}

export class AccountIdRequiredError extends Error {
  constructor(command: string, alternative?: string) {
    super(accountIdRequiredMessage(command, alternative));
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

export async function getCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexCredentialsWithSource | undefined> {
  return (await resolveCodexCredentials(ctx, signal)).credentials;
}

/**
 * Credentials for a chatgpt.com backend endpoint. Throws AccountIdRequiredError when the
 * only ChatGPT login is Pi 1.0's direct token, and `missingMessage` when there is none.
 */
export async function requireCodexCredentials(
  ctx: CodexCredentialsContext | undefined,
  command: string,
  missingMessage: string,
  signal?: AbortSignal,
  alternative?: string,
): Promise<CodexCredentialsWithSource> {
  const resolved = await resolveCodexCredentials(ctx, signal);
  if (resolved.credentials) return resolved.credentials;
  if (resolved.directTokenOnly) throw new AccountIdRequiredError(command, alternative);
  throw new Error(missingMessage);
}

async function resolveCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<{ credentials?: CodexCredentialsWithSource; directTokenOnly: boolean }> {
  let directTokenOnly = false;
  if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");
  // A pooled account pinned for this session (pi-multiprovider /switch-account)
  // wins over pi's own credential: subscription usage is per-account.
  const multiprovider = getActiveMultiproviderService();
  if (multiprovider && ctx) {
    // Resolve the selected provider's session pin before the other pool's default.
    const poolProviderIds =
      ctx.model?.provider === CODEX_PROVIDER_ID
        ? [CODEX_PROVIDER_ID, CHATGPT_PROVIDER_IDS[0]]
        : CHATGPT_PROVIDER_IDS;
    for (const providerId of poolProviderIds) {
      try {
        const resolved = await waitForSignal(
          multiprovider.resolveActiveAccountAuth(providerId, ctx, signal),
          signal,
        );
        const accountId = resolved ? extractAccountIdFromJwt(resolved.accessToken) : undefined;
        if (resolved && accountId) {
          return {
            credentials: { accessToken: resolved.accessToken, accountId, source: "multiprovider" },
            directTokenOnly: false,
          };
        }
      } catch {
        if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");
        // Try the other pool, then pi-owned credential resolution.
      }
    }
  }
  for (const providerId of CHATGPT_PROVIDER_IDS) {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");
    const registryRequest = ctx?.modelRegistry?.getApiKeyForProvider(providerId);
    const registryToken = registryRequest
      ? await waitForSignal(
          registryRequest.catch(() => undefined),
          signal,
        )
      : undefined;
    const registryCredentials = parseCodexRegistryCredentials(registryToken);
    if (registryCredentials)
      return {
        credentials: { ...registryCredentials, source: "modelRegistry" },
        directTokenOnly: false,
      };
    if (providerId === CHATGPT_PROVIDER_IDS[0] && isDirectChatGptToken(registryToken))
      directTokenOnly = true;
  }
  const auth = resolveAuthFile();
  return auth.credentials
    ? { credentials: { ...auth.credentials, source: "authFile" }, directTokenOnly: false }
    : { directTokenOnly: directTokenOnly || auth.directTokenOnly };
}
