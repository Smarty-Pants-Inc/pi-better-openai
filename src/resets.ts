import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexCredentials } from "./codex-auth.ts";
import { formatPercent, type UsageSnapshot } from "./usage.ts";

export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CONSUME_RESET_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

export type BankedResetStatus = "available" | "redeeming" | "redeemed" | "unknown";

export type BankedResetCredit = {
  id: string;
  resetType: string | null;
  status: BankedResetStatus;
  grantedAtMs: number | null;
  expiresAtMs: number | null;
  title: string | null;
  description: string | null;
};

export type BankedResetCredits = {
  availableCount: number;
  applicableCount: number | null;
  credits: BankedResetCredit[];
};

export type ConsumeBankedResetCode =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export type ConsumeBankedResetResult = {
  code: ConsumeBankedResetCode;
  windowsReset: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function asOptionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 100_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseCreditRow(row: unknown): BankedResetCredit | undefined {
  if (!isRecord(row)) return undefined;
  const id = typeof row.id === "string" && row.id ? row.id : undefined;
  if (!id) return undefined;
  const statusValue = row.status;
  const status: BankedResetStatus =
    statusValue === "available" || statusValue === "redeeming" || statusValue === "redeemed"
      ? statusValue
      : "unknown";
  return {
    id,
    resetType: readText(row.reset_type),
    status,
    grantedAtMs: parseTimestampMs(row.granted_at),
    expiresAtMs: parseTimestampMs(row.expires_at),
    title: readText(row.title),
    description: readText(row.description),
  };
}

export function parseBankedResetCredits(payload: unknown): BankedResetCredits {
  if (!isRecord(payload)) return { availableCount: 0, applicableCount: null, credits: [] };
  const rows = Array.isArray(payload.credits) ? payload.credits : [];
  const credits = rows
    .map(parseCreditRow)
    .filter((credit): credit is BankedResetCredit => credit !== undefined);
  const applicableRaw = payload.applicable_available_count;
  return {
    availableCount: asOptionalInt(payload.available_count) ?? 0,
    applicableCount: applicableRaw === undefined ? null : asOptionalInt(applicableRaw),
    credits,
  };
}

export function parseConsumeBankedResetResult(payload: unknown): ConsumeBankedResetResult {
  if (!isRecord(payload)) throw new Error("Codex reset response was malformed.");
  const code = payload.code;
  if (
    code !== "reset" &&
    code !== "nothing_to_reset" &&
    code !== "no_credit" &&
    code !== "already_redeemed"
  )
    throw new Error("Unexpected Codex reset response code.");
  return { code, windowsReset: asOptionalInt(payload.windows_reset) };
}

export function availableBankedResetCredits(
  credits: readonly BankedResetCredit[],
): BankedResetCredit[] {
  return credits.filter((credit) => credit.status === "available");
}

// Soonest-expiring available credit first: banked resets expire, so spend the
// one closest to expiry. Credits without an expiry sort last.
export function selectBankedResetCredit(
  credits: readonly BankedResetCredit[],
): BankedResetCredit | undefined {
  return [...availableBankedResetCredits(credits)].sort((a, b) => {
    const aExpiry = a.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const bExpiry = b.expiresAtMs ?? Number.POSITIVE_INFINITY;
    if (aExpiry !== bExpiry) return aExpiry - bExpiry;
    return (a.grantedAtMs ?? 0) - (b.grantedAtMs ?? 0);
  })[0];
}

function formatResetTimestamp(ms: number | null): string {
  if (ms === null) return "unknown";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBankedResetChoice(credit: BankedResetCredit, index: number): string {
  const title = credit.title ?? "Codex banked reset";
  const expires =
    credit.expiresAtMs === null
      ? "no expiry"
      : `expires ${formatResetTimestamp(credit.expiresAtMs)}`;
  return `${index + 1}. ${title} · ${expires}`;
}

export function formatConsumeOutcome(result: ConsumeBankedResetResult): {
  message: string;
  level: "info" | "warning";
} {
  switch (result.code) {
    case "reset":
      return {
        message: `Banked reset redeemed${result.windowsReset === null ? "" : ` — ${result.windowsReset} usage window${result.windowsReset === 1 ? "" : "s"} refreshed`}.`,
        level: "info",
      };
    case "nothing_to_reset":
      return {
        message: "Nothing to reset — Codex reported no eligible usage window.",
        level: "warning",
      };
    case "no_credit":
      return { message: "No banked Codex resets remain available.", level: "warning" };
    case "already_redeemed":
      return { message: "That banked reset was already redeemed.", level: "warning" };
  }
}

export function buildBankedResetConfirmation(options: {
  credit?: BankedResetCredit;
  availableCount: number;
  snapshot?: Pick<UsageSnapshot, "fiveHourLeftPercent" | "sevenDayLeftPercent">;
}): { title: string; message: string } {
  const credit = options.credit;
  const lines: string[] = [credit?.title ?? "Codex banked rate-limit reset"];
  if (credit?.description) lines.push(credit.description);
  lines.push("");
  if (credit?.grantedAtMs != null)
    lines.push(`Granted: ${formatResetTimestamp(credit.grantedAtMs)}`);
  lines.push(`Expires: ${formatResetTimestamp(credit?.expiresAtMs ?? null)}`);
  lines.push(`Available: ${options.availableCount}`);
  const windows: string[] = [];
  if (options.snapshot?.fiveHourLeftPercent != null)
    windows.push(`5h ${formatPercent(options.snapshot.fiveHourLeftPercent)} left`);
  if (options.snapshot?.sevenDayLeftPercent != null)
    windows.push(`7d ${formatPercent(options.snapshot.sevenDayLeftPercent)} left`);
  if (windows.length > 0) lines.push(`Current usage: ${windows.join(" · ")}`);
  lines.push("");
  lines.push(
    "This resets your 5-hour and weekly Codex usage windows immediately and cannot be undone.",
  );
  return { title: "Redeem banked Codex reset?", message: lines.join("\n") };
}

export async function requestBankedResetCredits(
  ctxOrSignal?: ExtensionContext | AbortSignal,
  signal?: AbortSignal,
): Promise<BankedResetCredits | undefined> {
  const ctx = isAbortSignal(ctxOrSignal) ? undefined : ctxOrSignal;
  const requestSignal = isAbortSignal(ctxOrSignal) ? ctxOrSignal : signal;
  const credentials = await getCodexCredentials(ctx, requestSignal);
  if (!credentials) return undefined;
  const response = await fetch(RESET_CREDITS_URL, {
    headers: {
      accept: "*/*",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
    },
    signal: requestSignal,
  });
  if (!response.ok) throw new Error(`Codex reset credit request failed (${response.status})`);
  return parseBankedResetCredits(await response.json());
}

export async function consumeBankedReset(
  ctx: ExtensionContext | undefined,
  creditId: string | undefined,
  redeemRequestId: string,
  signal?: AbortSignal,
): Promise<ConsumeBankedResetResult> {
  const credentials = await getCodexCredentials(ctx, signal);
  if (!credentials)
    throw new Error("OpenAI Codex authentication is unavailable. Run /login first.");
  const response = await fetch(CONSUME_RESET_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      creditId
        ? { credit_id: creditId, redeem_request_id: redeemRequestId }
        : { redeem_request_id: redeemRequestId },
    ),
    signal,
  });
  if (!response.ok) throw new Error(`Codex reset consume request failed (${response.status})`);
  return parseConsumeBankedResetResult(await response.json());
}

export function newRedeemRequestId(): string {
  return randomUUID();
}
