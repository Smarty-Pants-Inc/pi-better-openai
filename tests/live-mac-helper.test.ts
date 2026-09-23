import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const HELPER = resolve(import.meta.dirname, "../scripts/live-mac-helper.sh");
const PORT = 18_795;

// Stub ssh: the master (-M) makes its control "socket" and waits. A poll runs the
// helper's remote command locally with sh, after it applies the next scripted state.
const SSH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB/ssh.log"
last=; ctl=; prev=
for a; do
  if [ "$prev" = "-S" ]; then ctl=$a; fi
  prev=$a; last=$a
done
case " $* " in *" -M "*) : > "$ctl"; exec sleep 30 ;; esac
n=$(cat "$STUB/polls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB/polls"
f=$XDG_STATE_HOME/pi-better-openai/live.json
if [ -f "$STUB/state.$n" ]; then cp "$STUB/state.$n" "$f"; else rm -f "$f"; fi
exec sh -c "$last"
`;
const OPEN_STUB = `#!/bin/sh
printf '%s\\n' "$1" >> "$STUB/open.log"
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function deadPid(): number {
  const exited = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(exited.stdout.trim());
}

function runHelper(states: Array<Record<string, unknown> | undefined>) {
  dir = mkdtempSync(join(tmpdir(), "live-helper-"));
  const stub = join(dir, "stub");
  const bin = join(dir, "bin");
  const stateHome = join(dir, "state");
  mkdirSync(stub);
  mkdirSync(bin);
  mkdirSync(join(stateHome, "pi-better-openai"), { recursive: true });
  writeFileSync(join(bin, "ssh"), SSH_STUB);
  writeFileSync(join(bin, "open"), OPEN_STUB);
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "open"), 0o755);
  states.forEach((state, index) => {
    if (state) writeFileSync(join(stub, `state.${index + 1}`), `${JSON.stringify(state)}\n`);
  });
  const result = spawnSync("sh", [HELPER, "pi-host"], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      TMPDIR: dir,
      STUB: stub,
      XDG_STATE_HOME: stateHome,
      PBO_LIVE_PORT: String(PORT),
      PBO_LIVE_INTERVAL: "0",
      PBO_LIVE_POLLS: String(states.length + 3),
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(stub, name), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { result, opened: read("open.log"), ssh: read("ssh.log") };
}

const run = (token: string, startedAt: string, pid = process.pid) => ({
  port: PORT,
  url: `http://localhost:${PORT}/#${token}`,
  pid,
  startedAt,
});

describe("live Mac helper", () => {
  test("opens the page once per /live run over one SSH master", () => {
    const first = run("A".repeat(32), "2026-09-23T19:00:00.000Z");
    const second = run("B".repeat(32), "2026-09-23T19:05:00.000Z");
    const stale = run("C".repeat(32), "2026-09-23T19:09:00.000Z", deadPid());
    const { result, opened, ssh } = runHelper([first, first, undefined, second, second, stale]);

    expect(result.status).toBe(0);
    expect(opened).toEqual([first.url, second.url]);
    const output = `${result.stdout}${result.stderr}`;
    for (const token of ["A", "B", "C"]) expect(output).not.toContain(token.repeat(32));

    const [master, ...pollCalls] = ssh;
    expect(master).toContain("-N -M -S");
    expect(master).toContain("ExitOnForwardFailure=yes");
    expect(master).toContain(`-L ${PORT}:127.0.0.1:${PORT} pi-host`);
    expect(pollCalls.length).toBeGreaterThanOrEqual(6);
    for (const call of pollCalls) {
      expect(call).toContain("-S ");
      expect(call).toContain("ControlMaster=no");
      expect(call).not.toContain("-M ");
    }
  });

  test("never opens a URL that is not the localhost page of its port", () => {
    const { result, opened } = runHelper([
      { ...run("A".repeat(32), "t1"), url: "file:///etc/passwd" },
      { ...run("B".repeat(32), "t2"), url: `http://localhost:${PORT + 1}/#${"B".repeat(32)}` },
      { ...run("C".repeat(32), "t3"), url: `http://localhost:${PORT}/#bad;token` },
    ]);
    expect(result.status).toBe(0);
    expect(opened).toEqual([]);
    expect(result.stderr.match(/Ignored a live state/g)).toHaveLength(3);
  });
});
