import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piAgentDir } from "./paths.ts";
import { BANKED_RESET_AUTO_REDEEM_LEAD_MS } from "./resets.ts";

// Reserve before sending a POST, not after receiving its outcome. A timeout may
// already have spent the credit. Shared by manual/automatic redemption and all
// pi processes using this agent directory. Corrupt state or an orphaned lock
// fails closed rather than risking another redemption.
export function reserveBankedResetRedemption(
  accountId: string,
  creditId: string,
  now = Date.now(),
): boolean {
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
    let previous: { blockedUntilMs?: unknown; creditHash?: unknown } | undefined;
    try {
      previous = JSON.parse(readFileSync(path, "utf8"));
      if (
        !previous ||
        typeof previous.blockedUntilMs !== "number" ||
        !Number.isFinite(previous.blockedUntilMs) ||
        typeof previous.creditHash !== "string"
      )
        throw new Error("Invalid reservation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Banked reset safety reservation unavailable.");
    }
    const creditHash = digest(creditId);
    if (
      previous &&
      ((previous.blockedUntilMs as number) > now || previous.creditHash === creditHash)
    )
      return false;
    writeFileSync(
      path,
      JSON.stringify({
        blockedUntilMs: now + BANKED_RESET_AUTO_REDEEM_LEAD_MS,
        creditHash,
      }),
      { mode: 0o600 },
    );
    return true;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
