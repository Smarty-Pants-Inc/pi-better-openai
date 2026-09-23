import type { Server } from "node:http";
import { expect, test, vi } from "vitest";
import { startBrowserLiveAudio } from "../src/live/browser.ts";

const servers = vi.hoisted(() => [] as Server[]);
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const createServer = ((...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    servers.push(server);
    return server;
  }) as typeof actual.createServer;
  return { ...actual, createServer };
});

test("fails the live peer instead of crashing pi on a server error after bind", async () => {
  const bound = await startBrowserLiveAudio({ port: 0, token: "t".repeat(32) });
  try {
    const failures: string[] = [];
    new bound.native.LiveWebRtcPeer(
      () => undefined,
      () => undefined,
      (_error, message) => failures.push(message),
    );
    const server = servers.at(-1);
    expect(server).toBeDefined();
    expect(() => server?.emit("error", new Error("accept EMFILE"))).not.toThrow();
    expect(failures).toEqual(["Browser audio server error: accept EMFILE"]);
  } finally {
    await bound.close();
  }
});
