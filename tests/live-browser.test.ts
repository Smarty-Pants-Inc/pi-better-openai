import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  CLOSE_REJECTED,
  CLOSE_STOPPED,
  isAllowedLoopbackRequest,
  createBrowserToken,
  startBrowserLiveAudio,
} from "../src/live/browser.ts";
import { BROWSER_PAGE_HTML } from "../src/live/browser-page.ts";

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

// Runs the page script with the smallest fakes of the browser APIs it uses.
function runPageScript() {
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: true, value: 0 });
    return elements.get(id)!;
  };
  const sent: Array<Record<string, unknown>> = [];
  let socket: Record<string, (event?: unknown) => void> | undefined;
  let channel: Record<string, () => void> | undefined;
  const track = { enabled: true, stop() {} };
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this as unknown as typeof socket;
    }
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    }
  }
  class FakePeerConnection {
    iceGatheringState = "complete";
    localDescription = { sdp: "v=0 offer" };
    addTrack() {}
    createDataChannel() {
      channel = {};
      return channel;
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription() {}
    close() {}
  }
  const script = /<script>([\s\S]*)<\/script>/.exec(BROWSER_PAGE_HTML)?.[1] ?? "";
  runInNewContext(script, {
    location: { hash: `#${TOKEN}`, protocol: "http:", host: "localhost:1" },
    window: { isSecureContext: true },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
      },
    },
    document: { getElementById: element },
    Audio: class {},
    AudioContext: class {
      async resume() {}
    },
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakePeerConnection,
    setTimeout,
  });
  return {
    status: () => element("status").textContent,
    enable: () => (element("enable").onclick as () => Promise<void>)(),
    openSocket: () => socket?.onopen?.(),
    receive: (message: Record<string, unknown>) =>
      socket?.onmessage?.({ data: JSON.stringify(message) }),
    openChannel: () => channel?.onopen?.(),
    sent,
  };
}

describe("browser live audio", () => {
  test("accepts only same-origin loopback hosts", () => {
    expect(isAllowedLoopbackRequest("localhost:8795")).toBe(true);
    expect(isAllowedLoopbackRequest("127.0.0.1:9000", "http://127.0.0.1:9000")).toBe(true);
    expect(isAllowedLoopbackRequest("evil.example:8795")).toBe(false);
    expect(isAllowedLoopbackRequest("localhost:8795", "http://evil.example")).toBe(false);
    expect(isAllowedLoopbackRequest(undefined)).toBe(false);
  });

  test("makes a new private page token for each run", () => {
    const token = createBrowserToken();
    expect(token).toMatch(/^[\w-]{32,}$/);
    expect(createBrowserToken()).not.toBe(token);
  });

  test("publishes the live state while serving and removes it on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-state-"));
    try {
      const statePath = join(dir, "state", "live.json");
      const bound = await startBrowserLiveAudio({ port: 0, token: TOKEN, statePath });
      const record = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      expect(record).toMatchObject({ url: bound.url, pid: process.pid });
      expect(record.port).toBe(Number(new URL(bound.url).port));
      expect(Number.isNaN(Date.parse(String(record.startedAt)))).toBe(false);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      expect(bound.stateError).toBeUndefined();
      await bound.close();
      expect(existsSync(statePath)).toBe(false);

      const blocked = join(dir, "file");
      writeFileSync(blocked, "");
      const unwritable = await startBrowserLiveAudio({
        port: 0,
        token: TOKEN,
        statePath: join(blocked, "live.json"),
      });
      expect(unwritable.stateError).toBeInstanceOf(Error);
      await unwritable.close();
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

  test("page status follows mute and the call state", async () => {
    const page = runPageScript();
    page.openSocket();
    await page.enable();
    page.receive({ type: "offer.request" });
    await vi.waitFor(() =>
      expect(page.sent.some((message) => message.type === "offer")).toBe(true),
    );
    expect(page.status()).toBe("Connecting voice…");

    page.receive({ type: "mute", muted: true });
    expect(page.status()).toBe("Muted in pi.");
    page.receive({ type: "mute", muted: false });
    expect(page.status()).toBe("Connecting voice…");

    page.receive({ type: "mute", muted: true });
    page.openChannel();
    expect(page.status()).toBe("Muted in pi.");
    page.receive({ type: "mute", muted: false });
    expect(page.status()).toBe("Live. Speak to pi.");
  });
});
