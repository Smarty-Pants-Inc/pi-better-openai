import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticError } from "./format.ts";
import { type BankedResetCredits, requestBankedResetCredits } from "./resets.ts";

export const BANKED_RESET_CACHE_TTL_MS = 5 * 60_000;
const BANKED_RESET_REQUEST_TIMEOUT_MS = 10_000;

export type BankedResetCache = {
  credits: BankedResetCredits;
  updatedAt: number;
};

// Keeps the banked-reset credit list warm so /openai-resets opens without
// paying the credential-resolution + wham round trip. The cache is prefetched
// at session start, refreshed on a TTL, and served even when stale (a stale
// open still kicks off a background refresh; the backend re-validates every
// redemption server-side, so a stale offer can never be consumed twice).
export class ResetController {
  private cache: BankedResetCache | undefined;
  private error: string | undefined;
  private lastFetchAt: number | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessionSignal: AbortSignal | undefined;
  private sessionAbortHandler: (() => void) | undefined;

  get snapshot(): BankedResetCache | undefined {
    return this.cache;
  }

  get lastError(): string | undefined {
    return this.error;
  }

  isFresh(now = Date.now()): boolean {
    return this.cache !== undefined && now - this.cache.updatedAt < BANKED_RESET_CACHE_TTL_MS;
  }

  refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (
      !options?.force &&
      this.lastFetchAt !== undefined &&
      Date.now() - this.lastFetchAt < BANKED_RESET_CACHE_TTL_MS
    )
      return Promise.resolve();
    this.lastFetchAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(BANKED_RESET_REQUEST_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    const task = (async () => {
      try {
        const credits = await requestBankedResetCredits(ctx, signal);
        if (credits) {
          this.cache = { credits, updatedAt: Date.now() };
          this.error = undefined;
        } else {
          this.error = "OpenAI Codex credentials unavailable.";
        }
      } catch (error) {
        this.error = sanitizeDiagnosticError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.inFlight = undefined;
      }
    })();
    this.inFlight = task;
    return task;
  }

  start(ctx: ExtensionContext): void {
    this.stop();
    if (ctx.signal?.aborted) return;
    this.sessionSignal = ctx.signal;
    this.sessionAbortHandler = () => this.stop();
    ctx.signal?.addEventListener("abort", this.sessionAbortHandler, { once: true });
    void this.refresh(ctx).catch(() => {});
    this.timer = setInterval(() => {
      if (ctx.signal?.aborted) {
        this.stop();
        return;
      }
      void this.refresh(ctx).catch(() => {});
    }, BANKED_RESET_CACHE_TTL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.sessionSignal && this.sessionAbortHandler) {
      this.sessionSignal.removeEventListener("abort", this.sessionAbortHandler);
    }
    this.sessionSignal = undefined;
    this.sessionAbortHandler = undefined;
  }
}
