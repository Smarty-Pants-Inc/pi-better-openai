import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Tells a helper on the machine with the microphone that browser live audio is up.
 * The helper reads it over its own SSH connection (scripts/live-mac-helper.sh), so the
 * page token never crosses HTTP and needs no cache on that machine.
 */
export interface LiveStateRecord {
  port: number;
  url: string;
  pid: number;
  startedAt: string;
}

/** A fixed per-user path, independent of PI_CODING_AGENT_DIR, so the helper can find it. */
export function liveStatePath(env = process.env, home = homedir()): string {
  const configured = env.XDG_STATE_HOME?.trim();
  const base = configured && isAbsolute(configured) ? configured : join(home, ".local", "state");
  return join(base, "pi-better-openai", "live.json");
}

export function writeLiveState(path: string, record: LiveStateRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Removes the file only while it still describes this run; a newer run keeps its own.
 * Never throws: it runs on the close path, which must still close the server.
 */
export function removeLiveState(path: string, record: LiveStateRecord): void {
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveStateRecord>;
    if (current.pid === record.pid && current.startedAt === record.startedAt) rmSync(path);
  } catch {
    // Missing, unreadable, or not removable: a helper ignores it once this pid is gone.
  }
}
