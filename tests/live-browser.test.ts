import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import {
  CLOSE_REJECTED,
  CLOSE_STOPPED,
  isAllowedLoopbackRequest,
  readOrCreateBrowserToken,
  startBrowserLiveAudio,
} from "../src/live/browser.ts";

const TOKEN = "t".repeat(32);

function openPage(port: number, token: string, origin = `http://localhost:${port}`) {
  const socket = new WebSocket(`ws://localhost:${port}/ws`, { origin });
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    waiters.splice(0).forEach((wake) => wake());
  });
  const next = async (type: string) => {
    for (;;) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const opened = new Promise<void>((resolve) =>
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", token }));
      resolve();
    }),
  );
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
  return { socket, opened, closed, next, send };
}

describe("browser live audio", () => {
  test("accepts only same-origin loopback hosts", () => {
    expect(isAllowedLoopbackRequest("localhost:8795")).toBe(true);
    expect(isAllowedLoopbackRequest("127.0.0.1:9000", "http://127.0.0.1:9000")).toBe(true);
    expect(isAllowedLoopbackRequest("evil.example:8795")).toBe(false);
    expect(isAllowedLoopbackRequest("localhost:8795", "http://evil.example")).toBe(false);
    expect(isAllowedLoopbackRequest(undefined)).toBe(false);
  });

  test("keeps a private reusable page token", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-token-"));
    try {
      const path = join(dir, "nested", "token");
      const token = readOrCreateBrowserToken(path);
      expect(token).toMatch(/^[\w-]{32,}$/);
      expect(readOrCreateBrowserToken(path)).toBe(token);
      expect(readFileSync(path, "utf8").trim()).toBe(token);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("relays signaling, events, and levels between the page and the live transport", async () => {
    const bound = await startBrowserLiveAudio({ port: 0, token: TOKEN });
    const port = Number(new URL(bound.url).port);
    try {
      expect(bound.url).toBe(`http://localhost:${port}/#${TOKEN}`);
      const rejected = openPage(port, "wrong-token");
      expect(await rejected.closed).toBe(CLOSE_REJECTED);

      const page = openPage(port, TOKEN);
      await page.opened;
      const events: string[] = [];
      const levels: number[] = [];
      const inputLevels: number[] = [];
      const peer = new bound.native.LiveWebRtcPeer(
        (_error, payload) => events.push(payload),
        (_error, level) => levels.push(level),
        () => {},
      );
      const capture = new bound.native.AudioCapture(16_000, (_error, samples) =>
        inputLevels.push(samples[0]!),
      );

      const offer = peer.createOffer();
      await page.next("offer.request");
      page.send({ type: "offer", sdp: "v=0 offer" });
      expect(await offer).toBe("v=0 offer");

      await peer.acceptAnswer("v=0 answer");
      expect((await page.next("answer")).sdp).toBe("v=0 answer");
      page.send({ type: "open" });
      await peer.waitForOpen(2_000);

      page.send({ type: "event", payload: '{"type":"session.started"}' });
      page.send({ type: "levels", input: 0.2, output: 0.4 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['{"type":"session.started"}']);
      expect(levels).toEqual([0.4]);
      expect(inputLevels).toEqual([Math.fround(0.2)]);

      peer.setMuted(true);
      expect((await page.next("mute")).muted).toBe(true);
      capture.stop();
      await peer.close();
      await page.next("hangup");

      const stopped = page.closed;
      await bound.close();
      expect(await stopped).toBe(CLOSE_STOPPED);
    } finally {
      await bound.close().catch(() => undefined);
    }
  });

  test("fails the live peer when the page disconnects mid-call", async () => {
    const bound = await startBrowserLiveAudio({ port: 0, token: TOKEN });
    try {
      const page = openPage(Number(new URL(bound.url).port), TOKEN);
      await page.opened;
      const failures: string[] = [];
      const peer = new bound.native.LiveWebRtcPeer(
        () => {},
        () => {},
        (_error, message) => failures.push(message),
      );
      const offer = peer.createOffer();
      await page.next("offer.request");
      page.send({ type: "offer", sdp: "v=0" });
      await offer;
      page.socket.close();
      await page.closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(failures).toEqual(["The browser audio page disconnected."]);
    } finally {
      await bound.close();
    }
  });
});
