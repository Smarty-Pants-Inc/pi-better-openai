import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piAgentDir } from "./paths.ts";
import { BANKED_RESET_AUTO_REDEEM_LEAD_MS } from "./resets.ts";

type RedemptionReservation = {
  blockedUntilMs: number;
  creditHash: string;
  attemptedCreditHashes?: string[];
};

// Reserve before sending a POST, not after receiving its outcome. A timeout may
// already have spent the credit. Shared by manual/automatic redemption and all
// pi processes using this agent directory. Corrupt state or an orphaned lock
// fails closed rather than risking another redemption.
export function reserveBankedResetRedemption(
  accountId: string,
  creditId: string,
  options: { expiresAtMs?: number } = {},
): boolean {
  if (!accountId.trim() || !creditId.trim()) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const dir = join(piAgentDir(), "pi-better-openai", "reset-redemptions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${digest(accountId)}.json`);
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error("Banked reset safety reservation unavailable.");
  }
  try {
    let previous: RedemptionReservation | undefined;
    try {
      previous = JSON.parse(readFileSync(path, "utf8"));
      if (
        !previous ||
        typeof previous.blockedUntilMs !== "number" ||
        !Number.isFinite(previous.blockedUntilMs) ||
        typeof previous.creditHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(previous.creditHash) ||
        (previous.attemptedCreditHashes !== undefined &&
          (!Array.isArray(previous.attemptedCreditHashes) ||
            !previous.attemptedCreditHashes.every(
              (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
            ) ||
            !previous.attemptedCreditHashes.includes(previous.creditHash)))
      )
        throw new Error("Invalid reservation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Banked reset safety reservation unavailable.");
    }
    // Check the actual clock under the account lock, not a cached timer's time.
    // Manual, explicitly confirmed redemptions do not supply an expiry limit.
    const now = Date.now();
    if (
      options.expiresAtMs !== undefined &&
      (!Number.isFinite(options.expiresAtMs) ||
        options.expiresAtMs <= now ||
        options.expiresAtMs - now > BANKED_RESET_AUTO_REDEEM_LEAD_MS)
    )
      return false;
    const creditHash = digest(creditId);
    // Migrate old single-credit state. Never forget an uncertain attempt just
    // because another credit was subsequently redeemed.
    const attemptedCreditHashes =
      previous?.attemptedCreditHashes ?? (previous ? [previous.creditHash] : []);
    if ((previous && previous.blockedUntilMs > now) || attemptedCreditHashes.includes(creditHash))
      return false;
    writeFileSync(
      path,
      JSON.stringify({
        blockedUntilMs: now + BANKED_RESET_AUTO_REDEEM_LEAD_MS,
        creditHash,
        attemptedCreditHashes: [...attemptedCreditHashes, creditHash],
      }),
      { mode: 0o600, flush: true },
    );
    return true;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
