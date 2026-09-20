import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexCredentials } from "./codex-auth.ts";
import { sanitizeDiagnosticError } from "./format.ts";
import { reserveBankedResetRedemption } from "./reset-guard.ts";
import {
  BANKED_RESET_AUTO_REDEEM_LEAD_MS,
  type BankedResetCredit,
  type BankedResetCredits,
  type ConsumeBankedResetResult,
  consumeBankedReset,
  formatConsumeOutcome,
  newRedeemRequestId,
  requestBankedResetCredits,
  selectAutoRedeemCredit,
} from "./resets.ts";

export const BANKED_RESET_CACHE_TTL_MS = 5 * 60_000;
const BANKED_RESET_REQUEST_TIMEOUT_MS = 10_000;

export type BankedResetCache = {
  credits: BankedResetCredits;
  updatedAt: number;
};

// Keep the picker warm, but never redeem from the cache alone. Automatic
// redemption revalidates one exact credit and pins its account for the POST.
export class ResetController {
  private cache: BankedResetCache | undefined;
  private error: string | undefined;
  private lastFetchAt: number | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionSignal: AbortSignal | undefined;
  private sessionAbortHandler: (() => void) | undefined;
  private lifetime = new AbortController();
  private generation = 0;
  private activeCtx: ExtensionContext | undefined;
  private redeeming = false;
  private manualPickers = 0;
  private blockedUntilMs = 0;

  private readonly autoRedeemEnabled: (ctx: ExtensionContext) => boolean;
  private readonly onAutoRedeemed: (ctx: ExtensionContext) => void;

  constructor(
    autoRedeemEnabled: (ctx: ExtensionContext) => boolean = () => false,
    onAutoRedeemed: (ctx: ExtensionContext) => void = () => {},
  ) {
    this.autoRedeemEnabled = autoRedeemEnabled;
    this.onAutoRedeemed = onAutoRedeemed;
  }

  get snapshot(): BankedResetCache | undefined {
    return this.cache;
  }

  get lastError(): string | undefined {
    return this.error;
  }

  isFresh(now = Date.now()): boolean {
    return this.cache !== undefined && now - this.cache.updatedAt < BANKED_RESET_CACHE_TTL_MS;
  }

  private requestSignal(ctx: ExtensionContext): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(BANKED_RESET_REQUEST_TIMEOUT_MS),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
  }

  refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (
      !options?.force &&
      this.lastFetchAt !== undefined &&
      Date.now() - this.lastFetchAt < BANKED_RESET_CACHE_TTL_MS
    )
      return Promise.resolve();
    this.lastFetchAt = Date.now();
    const generation = this.generation;
    const signal = this.requestSignal(ctx);
    const task = (async () => {
      try {
        const credits = await requestBankedResetCredits(ctx, signal);
        if (signal.aborted || generation !== this.generation) return;
        if (credits) {
          this.cache = { credits, updatedAt: Date.now() };
          this.error = undefined;
        } else {
          this.error = "OpenAI Codex credentials unavailable.";
        }
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return;
        this.error = sanitizeDiagnosticError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (generation === this.generation) {
          this.inFlight = undefined;
          this.scheduleAutoRedeem();
        }
      }
    })();
    this.inFlight = task;
    return task;
  }

  // While a person is choosing/confirming, the timer must not spend a different
  // credit behind their dialog. An already-running redemption remains locked.
  pauseAutoRedeem(): () => void {
    this.manualPickers++;
    this.clearAutoTimer();
    return () => {
      this.manualPickers--;
      this.scheduleAutoRedeem();
    };
  }

  async redeem(ctx: ExtensionContext, creditId: string): Promise<ConsumeBankedResetResult> {
    if (!creditId) throw new Error("An explicit banked reset credit is required.");
    if (this.redeeming) throw new Error("A banked reset redemption is already in progress.");
    this.redeeming = true;
    const generation = this.generation;
    this.blockedUntilMs = Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS;
    try {
      const signal = this.requestSignal(ctx);
      const credentials = await getCodexCredentials(ctx, signal);
      signal.throwIfAborted();
      if (!credentials) throw new Error("OpenAI Codex credentials unavailable.");
      if (!reserveBankedResetRedemption(credentials.accountId, creditId))
        throw new Error(
          "A banked reset was already attempted recently; no additional credit was spent.",
        );
      return await consumeBankedReset(ctx, creditId, newRedeemRequestId(), signal, credentials);
    } finally {
      if (generation === this.generation) {
        this.redeeming = false;
        this.scheduleAutoRedeem();
      }
    }
  }

  private clearAutoTimer(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
  }

  private canAutoRedeem(ctx: ExtensionContext): boolean {
    return (
      this.activeCtx === ctx &&
      !this.lifetime.signal.aborted &&
      !ctx.signal?.aborted &&
      this.manualPickers === 0 &&
      this.autoRedeemEnabled(ctx)
    );
  }

  private scheduleAutoRedeem(): void {
    const ctx = this.activeCtx;
    if (!ctx || this.redeeming) return;
    try {
      if (!this.canAutoRedeem(ctx)) {
        this.clearAutoTimer();
        return;
      }
      // A cache refresh must not replace a due timer with the next credit,
      // particularly when the scheduled one was redeemed in another client.
      if (this.autoTimer) return;
      const credit = selectAutoRedeemCredit(this.cache?.credits.credits ?? []);
      if (!credit || credit.expiresAtMs === null) return;
      const dueAt = Math.max(
        credit.expiresAtMs - BANKED_RESET_AUTO_REDEEM_LEAD_MS,
        this.blockedUntilMs,
      );
      this.autoTimer = setTimeout(
        () => {
          this.autoTimer = undefined;
          if (Date.now() < dueAt) this.scheduleAutoRedeem();
          else void this.autoRedeem(ctx, credit);
        },
        Math.max(0, Math.min(dueAt - Date.now(), BANKED_RESET_CACHE_TTL_MS)),
      );
      this.autoTimer.unref?.();
    } catch {
      // Stale extension contexts must not leave a background timer running.
      this.stop();
    }
  }

  private async autoRedeem(ctx: ExtensionContext, scheduled: BankedResetCredit): Promise<void> {
    const generation = this.generation;
    let ownsRedemption = false;
    try {
      if (this.redeeming || !this.canAutoRedeem(ctx) || Date.now() < this.blockedUntilMs) return;
      this.redeeming = true;
      ownsRedemption = true;
      // Even a no-op or ambiguous failure ends this window: never try the next
      // credit. The persistent reservation below enforces this across processes.
      this.blockedUntilMs = Date.now() + BANKED_RESET_AUTO_REDEEM_LEAD_MS;
      const signal = this.requestSignal(ctx);
      const credentials = await getCodexCredentials(ctx, signal);
      if (!credentials) return;
      const fresh = await requestBankedResetCredits(ctx, signal, credentials);
      if (signal.aborted || generation !== this.generation || !this.canAutoRedeem(ctx)) return;
      if (!fresh) return;
      this.cache = { credits: fresh, updatedAt: Date.now() };
      this.error = undefined;
      const credit = selectAutoRedeemCredit(fresh.credits.filter((row) => row.id === scheduled.id));
      if (
        !credit ||
        credit.expiresAtMs === null ||
        fresh.availableCount <= 0 ||
        fresh.applicableCount === 0 ||
        credit.expiresAtMs - Date.now() > BANKED_RESET_AUTO_REDEEM_LEAD_MS
      )
        return;
      if (
        !reserveBankedResetRedemption(credentials.accountId, credit.id, {
          expiresAtMs: credit.expiresAtMs,
        })
      )
        return;
      // Filesystem contention or a clock adjustment must not turn a valid
      // reservation into a POST for an expired or not-yet-due credit.
      const remainingMs = credit.expiresAtMs - Date.now();
      if (remainingMs <= 0 || remainingMs > BANKED_RESET_AUTO_REDEEM_LEAD_MS) return;
      const result = await consumeBankedReset(
        ctx,
        credit.id,
        newRedeemRequestId(),
        signal,
        credentials,
      );
      if (signal.aborted || generation !== this.generation) return;
      const outcome = formatConsumeOutcome(result);
      ctx.ui.notify(`Auto-redeem: ${outcome.message}`, outcome.level);
      if (result.code === "reset") this.onAutoRedeemed(ctx);
      void this.refresh(ctx, { force: true });
    } catch (error) {
      if (generation !== this.generation || this.lifetime.signal.aborted) return;
      this.error = sanitizeDiagnosticError(error instanceof Error ? error.message : String(error));
      try {
        ctx.ui.notify(
          `Banked reset auto-redemption failed; no automatic retry: ${this.error}`,
          "warning",
        );
      } catch {
        /* The context may have become stale. */
      }
    } finally {
      if (ownsRedemption && generation === this.generation) {
        this.redeeming = false;
        this.scheduleAutoRedeem();
      }
    }
  }

  start(ctx: ExtensionContext): void {
    this.stop();
    this.lifetime = new AbortController();
    this.cache = undefined;
    this.lastFetchAt = undefined;
    if (ctx.signal?.aborted) return;
    this.activeCtx = ctx;
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
    this.generation++;
    this.lifetime.abort();
    this.activeCtx = undefined;
    this.inFlight = undefined;
    this.redeeming = false;
    this.clearAutoTimer();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.sessionSignal && this.sessionAbortHandler) {
      this.sessionSignal.removeEventListener("abort", this.sessionAbortHandler);
    }
    this.sessionSignal = undefined;
    this.sessionAbortHandler = undefined;
  }
}
