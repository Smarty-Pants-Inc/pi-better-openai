import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { liveStatePath, removeLiveState, writeLiveState } from "../src/live/state.ts";

describe("live state file", () => {
  test("uses an absolute XDG_STATE_HOME, else ~/.local/state", () => {
    expect(liveStatePath({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe(
      "/xdg/pi-better-openai/live.json",
    );
    expect(liveStatePath({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/state/pi-better-openai/live.json",
    );
    expect(liveStatePath({}, "/home/u")).toBe("/home/u/.local/state/pi-better-openai/live.json");
  });

  test("writes a private file and removes it only for the same run", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-state-"));
    try {
      const path = join(dir, "pi-better-openai", "live.json");
      const first = { port: 18_795, url: "http://localhost:18795/#a", pid: 11, startedAt: "t1" };
      writeLiveState(path, first);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "pi-better-openai")).mode & 0o777).toBe(0o700);

      const second = { ...first, url: "http://localhost:18795/#b", startedAt: "t2" };
      writeLiveState(path, second);
      removeLiveState(path, first);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(second);
      removeLiveState(path, second);
      expect(existsSync(path)).toBe(false);
      removeLiveState(path, second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
