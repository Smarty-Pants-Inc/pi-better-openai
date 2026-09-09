import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER_ID, getActiveMultiproviderService } from "./multiprovider.ts";
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
      if (accessToken?.trim() && accountId?.trim())
        return { accessToken: accessToken.trim(), accountId: accountId.trim() };
    }
  } catch {
    // Plain bearer token is expected for openai-codex in pi.
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
    const entry = auth["openai-codex"];
    if (entry?.type !== "oauth") return undefined;
    if (typeof entry.expires === "number" && Date.now() >= entry.expires) return undefined;
    const accessToken = entry.access?.trim();
    const accountId = (entry.accountId ?? entry.account_id)?.trim();
    return accessToken && accountId ? { accessToken, accountId } : undefined;
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
    try {
      const resolved = await waitForSignal(
        multiprovider.resolveActiveAccountAuth(CODEX_PROVIDER_ID, ctx, signal),
        signal,
      );
      const accountId = resolved ? extractAccountIdFromJwt(resolved.accessToken) : undefined;
      if (resolved && accountId) {
        return { accessToken: resolved.accessToken, accountId, source: "multiprovider" };
      }
    } catch {
      // Fall back to pi-owned credential resolution.
    }
  }
  const registryRequest = ctx?.modelRegistry?.getApiKeyForProvider(CODEX_PROVIDER_ID);
  const registryToken = registryRequest
    ? await waitForSignal(
        registryRequest.catch(() => undefined),
        signal,
      )
    : undefined;
  const registryCredentials = parseCodexRegistryCredentials(registryToken);
  if (registryCredentials) return { ...registryCredentials, source: "modelRegistry" };
  const auth = readCodexAuth();
  return auth ? { ...auth, source: "authFile" } : undefined;
}
