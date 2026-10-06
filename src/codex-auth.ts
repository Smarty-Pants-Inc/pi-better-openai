import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHATGPT_PROVIDER_IDS,
  CODEX_PROVIDER_ID,
  getActiveMultiproviderService,
  type MultiproviderActiveAccount,
  type MultiproviderService,
} from "./multiprovider.ts";
import { piAgentDir } from "./paths.ts";

export const AUTH_FILE = join(piAgentDir(), "auth.json");

export const CODEX_AUTH_REQUIRED =
  "Missing openai-codex OAuth credentials. Run /login openai-codex for this Codex backend feature. /login openai uses separate ChatGPT subscription credentials for api.openai.com.";

export type CodexCredentials = {
  accessToken: string;
  accountId: string;
  /** Pool slot id, supplied by the trusted bridge; never a label or JWT account id. */
  selection?: { providerId: string; id: string };
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
  if (signal.aborted) {
    // The caller may have started the async bridge operation just before it aborted.
    void operation.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("Operation was aborted."));
  }

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

export class CodexIdentityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexIdentityRefusedError";
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
        | "selected-provider-incompatible"
        | "default-missing";
      selectedPool?: string;
    };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");
}

async function readSelections(
  service: MultiproviderService,
  ctx: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<Map<string, MultiproviderActiveAccount>> {
  const pins = new Map<string, MultiproviderActiveAccount>();
  for (const provider of CHATGPT_PROVIDER_IDS) {
    const account = await waitForSignal(service.getActiveAccount(provider, ctx), signal);
    throwIfAborted(signal);
    // Copy the stable id: a bridge may mutate its active-account object on switches.
    if (account) {
      if (!account.id?.trim()) throw new Error("Selected account has no stable pool id.");
      pins.set(provider, { ...account });
    }
  }
  return pins;
}

/** One selected identity, no fallback on unresolved, unbound, or switched pool auth. */
export async function resolveCodexIdentity(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexIdentity> {
  throwIfAborted(signal);
  const service = getActiveMultiproviderService();
  if (service) {
    if (!ctx) return { kind: "refuse", reason: "selected-unresolved" };
    const modelProvider = ctx.model?.provider;
    let changed = false;
    const unsubscribe: (() => void)[] = [];
    try {
      // Subscribe before reading pins, through the final re-read. This also
      // detects A -> B -> A while a real bridge refresh is pending.
      for (const provider of CHATGPT_PROVIDER_IDS)
        unsubscribe.push(
          service.onActiveAccountChanged(provider, () => {
            changed = true;
          }),
        );
      let pins: Map<string, MultiproviderActiveAccount>;
      try {
        pins = await readSelections(service, ctx, signal);
        if (changed) return { kind: "refuse", reason: "selected-unresolved" };
      } catch {
        throwIfAborted(signal);
        return { kind: "refuse", reason: "selected-unresolved" };
      }
      const pool =
        modelProvider && pins.has(modelProvider)
          ? modelProvider
          : pins.size === 1
            ? [...pins.keys()][0]
            : undefined;
      if (pins.size && !pool) return { kind: "refuse", reason: "selected-ambiguous" };
      if (pool) {
        // Native openai OAuth belongs to api.openai.com, even if it contains an account-id claim.
        if (pool !== CODEX_PROVIDER_ID)
          return { kind: "refuse", reason: "selected-provider-incompatible", selectedPool: pool };
        const expectedId = pins.get(pool)!.id;
        try {
          const resolved = await waitForSignal(
            service.resolveActiveAccountAuth(pool, ctx, signal),
            signal,
          );
          throwIfAborted(signal);
          if (!resolved || (resolved.id !== undefined && resolved.id !== expectedId))
            return { kind: "refuse", reason: "selected-unresolved", selectedPool: pool };
          const current = await readSelections(service, ctx, signal);
          if (
            changed ||
            getActiveMultiproviderService() !== service ||
            ctx.model?.provider !== modelProvider ||
            current.size !== pins.size ||
            [...pins].some(([provider, account]) => current.get(provider)?.id !== account.id)
          )
            return { kind: "refuse", reason: "selected-unresolved", selectedPool: pool };
          const accountId = extractAccountIdFromJwt(resolved.accessToken);
          if (!accountId)
            return { kind: "refuse", reason: "selected-no-account-id", selectedPool: pool };
          return {
            kind: "selected",
            credentials: {
              accessToken: resolved.accessToken,
              accountId,
              source: "multiprovider",
              selection: { providerId: pool, id: expectedId },
            },
          };
        } catch {
          throwIfAborted(signal);
          return { kind: "refuse", reason: "selected-unresolved", selectedPool: pool };
        }
      }
      // No pin was observed. Recheck after default resolution so a concurrent switch cannot fall through.
      const result = await resolveDefaultCodexCredentials(ctx, signal);
      try {
        const current = await readSelections(service, ctx, signal);
        if (
          changed ||
          current.size ||
          getActiveMultiproviderService() !== service ||
          ctx.model?.provider !== modelProvider
        )
          return { kind: "refuse", reason: "selected-unresolved" };
      } catch {
        throwIfAborted(signal);
        return { kind: "refuse", reason: "selected-unresolved" };
      }
      return result;
    } catch {
      throwIfAborted(signal);
      return { kind: "refuse", reason: "selected-unresolved" };
    } finally {
      for (const off of unsubscribe) {
        try {
          off();
        } catch {
          /* A broken bridge cleanup must not enable fallback. */
        }
      }
    }
  }
  const result = await resolveDefaultCodexCredentials(ctx, signal);
  if (getActiveMultiproviderService()) return { kind: "refuse", reason: "selected-unresolved" };
  return result;
}

async function resolveDefaultCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexIdentity> {
  // Never substitute native openai credentials for the legacy Codex endpoint grant.
  const request = ctx?.modelRegistry?.getApiKeyForProvider(CODEX_PROVIDER_ID);
  const token = request
    ? await waitForSignal(
        request.catch(() => undefined),
        signal,
      )
    : undefined;
  throwIfAborted(signal);
  const credentials = parseCodexRegistryCredentials(token);
  if (credentials)
    return { kind: "default", credentials: { ...credentials, source: "modelRegistry" } };
  const auth = readCodexAuth();
  return auth
    ? { kind: "default", credentials: { ...auth, source: "authFile" } }
    : { kind: "refuse", reason: "default-missing" };
}

export async function getCodexCredentials(
  ctx?: CodexCredentialsContext,
  signal?: AbortSignal,
): Promise<CodexCredentialsWithSource | undefined> {
  const result = await resolveCodexIdentity(ctx, signal);
  return result.kind === "refuse" ? undefined : result.credentials;
}

export async function requireCodexCredentials(
  ctx: CodexCredentialsContext | undefined,
  command: string,
  missingMessage = CODEX_AUTH_REQUIRED,
  signal?: AbortSignal,
): Promise<CodexCredentialsWithSource> {
  const result = await resolveCodexIdentity(ctx, signal);
  if (result.kind !== "refuse") return result.credentials;
  if (result.reason === "default-missing") throw new Error(missingMessage);
  const detail =
    result.reason === "selected-provider-incompatible"
      ? "The selected openai account uses a separate api.openai.com grant, not this Codex backend."
      : result.reason === "selected-no-account-id"
        ? "The selected Codex account provides no ChatGPT account id."
        : result.reason === "selected-ambiguous"
          ? "Selected accounts in both ChatGPT pools are ambiguous for this model."
          : "The selected account could not be bound to its stable pool id, or changed during resolution.";
  throw new CodexIdentityRefusedError(
    `${command}: ${detail} Another account is never used in its place. ${CODEX_AUTH_REQUIRED}`,
  );
}

/** Revalidate operation-level reset credentials; a stale snapshot must never bypass a pin. */
export async function verifyPinnedCodexCredentials(
  ctx: CodexCredentialsContext | undefined,
  credentials: CodexCredentials,
  signal?: AbortSignal,
): Promise<CodexCredentials> {
  throwIfAborted(signal);
  if (credentials.selection || getActiveMultiproviderService()) {
    const current = await requireCodexCredentials(
      ctx,
      "/openai-resets",
      CODEX_AUTH_REQUIRED,
      signal,
    );
    if (
      current.accountId !== credentials.accountId ||
      current.selection?.providerId !== credentials.selection?.providerId ||
      current.selection?.id !== credentials.selection?.id
    )
      throw new CodexIdentityRefusedError(
        "/openai-resets: selected account changed; no reset was spent.",
      );
  }
  throwIfAborted(signal);
  return credentials;
}
