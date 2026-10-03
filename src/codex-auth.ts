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

export function readCodexAuth(): CodexCredentials | undefined {
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
      if (credentials) return credentials;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function getCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexCredentialsWithSource | undefined> {
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
          return { accessToken: resolved.accessToken, accountId, source: "multiprovider" };
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
    if (registryCredentials) return { ...registryCredentials, source: "modelRegistry" };
  }
  const auth = readCodexAuth();
  return auth ? { ...auth, source: "authFile" } : undefined;
}
