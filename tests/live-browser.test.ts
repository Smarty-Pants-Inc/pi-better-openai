import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  CLOSE_REJECTED,
  CLOSE_STOPPED,
  isAllowedLoopbackRequest,
  readOrCreateBrowserToken,
  startBrowserLiveAudio,
} from "../src/live/browser.ts";
import { BROWSER_PAGE_HTML } from "../src/live/browser-page.ts";

const TOKEN = "t".repeat(32);

function openPage(
  port: number,
  token: string,
  origin = `http://localhost:${port}`,
  hello: Record<string, unknown> = {},
) {
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
      socket.send(JSON.stringify({ type: "hello", token, ...hello }));
      resolve();
    }),
  );
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
  return { socket, opened, closed, next, send };
}

type FakeDevice = { kind: "audioinput" | "audiooutput"; deviceId: string; label: string };
type FakeTrack = {
  kind: string;
  enabled: boolean;
  readyState: string;
  deviceId: string;
  stop(): void;
};

// Runs the page script with the smallest fakes of the browser APIs it uses.
function runPageScript(options: { devices?: FakeDevice[]; saved?: Record<string, string> } = {}) {
  const elements = new Map<string, Record<string, unknown>>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const created: Record<string, unknown> = {
        textContent: "",
        hidden: true,
        value: 0,
        dataset: {},
        attributes: {},
      };
      created.setAttribute = (name: string, value: string) => {
        (created.attributes as Record<string, string>)[name] = value;
      };
      created.replaceChildren = (...children: Array<{ value: string; textContent: string }>) => {
        created.options = children;
      };
      elements.set(id, created);
    }
    return elements.get(id)!;
  };
  const sent: Array<Record<string, unknown>> = [];
  let socket: Record<string, (event?: unknown) => void> | undefined;
  let channel: Record<string, () => void> | undefined;
  const connections: FakePeerConnection[] = [];
  // Browsers hide device labels until microphone permission is granted.
  let permitted = false;
  const devices = options.devices ?? [];
  const saved = new Map(Object.entries(options.saved ?? {}));
  const openedMics: string[] = [];
  const tracks: FakeTrack[] = [];
  const replaced: string[] = [];
  const sinks: Array<[string, string]> = [];
  let devicechange: (() => void) | undefined;
  const openTrack = (deviceId: string): FakeTrack => {
    const track = { kind: "audio", enabled: true, readyState: "live", deviceId, stop() {} };
    track.stop = () => {
      track.readyState = "ended";
    };
    tracks.push(track);
    return track;
  };
  let socketsOpened = 0;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this as unknown as typeof socket;
      socketsOpened += 1;
    }
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    }
  }
  class FakePeerConnection {
    iceGatheringState = "complete";
    localDescription = { sdp: "v=0 offer" };
    ontrack: ((event: unknown) => void) | undefined;
    senders: Array<{ track: FakeTrack | null; replaceTrack(track: FakeTrack): Promise<void> }> = [];
    addTrack(track: FakeTrack) {
      const sender = {
        track: track as FakeTrack | null,
        replaceTrack: async (next: FakeTrack) => {
          sender.track = next;
          replaced.push(next.deviceId);
        },
      };
      this.senders.push(sender);
    }
    getSenders() {
      return this.senders;
    }
    createDataChannel() {
      channel = {};
      return channel;
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription() {}
    closed = false;
    close() {
      this.closed = true;
    }
  }
  const sinkTarget = (name: string) => ({
    async setSinkId(id: string) {
      if (id && !devices.some((device) => device.deviceId === id)) throw new Error("NotFoundError");
      sinks.push([name, id]);
    },
  });
  const PeerConnection = class extends FakePeerConnection {
    constructor() {
      super();
      connections.push(this);
    }
  };
  const script = /<script>([\s\S]*)<\/script>/.exec(BROWSER_PAGE_HTML)?.[1] ?? "";
  runInNewContext(script, {
    location: { hash: `#${TOKEN}`, protocol: "http:", host: "localhost:1" },
    window: {
      isSecureContext: true,
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
      },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints: { audio: { deviceId?: { exact: string } } | true }) => {
          permitted = true;
          const exact = constraints.audio === true ? undefined : constraints.audio.deviceId?.exact;
          if (exact && !devices.some((device) => device.deviceId === exact)) {
            throw new Error("OverconstrainedError");
          }
          openedMics.push(exact ?? "default");
          const track = openTrack(exact ?? "default");
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
        enumerateDevices: async () =>
          devices.map((device) => ({ ...device, label: permitted ? device.label : "" })),
        addEventListener: (type: string, listener: () => void) => {
          if (type === "devicechange") devicechange = listener;
        },
      },
    },
    document: {
      getElementById: element,
      createElement: () => ({ value: "", textContent: "" }),
    },
    Audio: class {
      setSinkId = sinkTarget("audio").setSinkId;
      play = async () => undefined;
    },
    AudioContext: class {
      setSinkId = sinkTarget("context").setSinkId;
      async resume() {}
      createAnalyser() {
        return { getFloatTimeDomainData() {} };
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
    },
    WebSocket: FakeWebSocket,
    RTCPeerConnection: PeerConnection,
    setTimeout,
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  return {
    status: () => element("status").textContent,
    warning: () => String(element("device-warning").textContent),
    select: (kind: "input" | "output") => element(`${kind}-device`),
    choose: (kind: "input" | "output", value: string) => {
      element(`${kind}-device`).value = value;
      (element(`${kind}-device`).onchange as () => void)();
    },
    enable: () => (element("voice").onclick as () => Promise<void>)(),
    voice: () => element("voice"),
    mute: () => element("mute"),
    detail: () => element("detail").textContent,
    error: () => element("error").textContent,
    openSocket: () => socket?.onopen?.(),
    socketsOpened: () => socketsOpened,
    dropSocket: (code: number) => socket?.onclose?.({ code }),
    connections,
    receive: (message: Record<string, unknown>) =>
      socket?.onmessage?.({ data: JSON.stringify(message) }),
    openChannel: () => channel?.onopen?.(),
    remoteTrack: () => connections.at(-1)?.ontrack?.({ streams: [{}] }),
    deviceChange: () => devicechange?.(),
    devices,
    saved,
    openedMics,
    replaced,
    sinks,
    sent,
  };
}

/** Starts a page call up to the sent offer. */
async function startPageCall(page: ReturnType<typeof runPageScript>) {
  page.receive({ type: "offer.request" });
  await vi.waitFor(() => expect(page.sent.some((message) => message.type === "offer")).toBe(true));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const YEALINK_MIC: FakeDevice = {
  kind: "audioinput",
  deviceId: "mic-y",
  label: "Yealink BT51 Microphone",
};
const YEALINK_SPEAKER: FakeDevice = {
  kind: "audiooutput",
  deviceId: "spk-y",
  label: "Yealink BT51",
};
const BUILT_IN: FakeDevice[] = [
  { kind: "audioinput", deviceId: "default", label: "Default - Yealink BT51 Microphone" },
  { kind: "audioinput", deviceId: "mic-mac", label: "MacBook Pro Microphone" },
  { kind: "audiooutput", deviceId: "default", label: "Default - MacBook Pro Speakers" },
  { kind: "audiooutput", deviceId: "spk-mac", label: "MacBook Pro Speakers" },
];

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
    const bound = await startBrowserLiveAudio({
      port: 0,
      token: TOKEN,
      inputDevice: "Yealink BT51",
      outputDevice: "Yealink",
    });
    const port = Number(new URL(bound.url).port);
    try {
      expect(bound.url).toBe(`http://localhost:${port}/#${TOKEN}`);
      const rejected = openPage(port, "wrong-token");
      expect(await rejected.closed).toBe(CLOSE_REJECTED);

      const page = openPage(port, TOKEN);
      await page.opened;
      // The config device defaults reach the page after its authenticated hello.
      expect(await page.next("audio.defaults")).toEqual({
        type: "audio.defaults",
        inputDevice: "Yealink BT51",
        outputDevice: "Yealink",
      });
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

  test("keeps an open call when the page socket drops, and rebinds it on reconnect", async () => {
    const bound = await startBrowserLiveAudio({ port: 0, token: TOKEN });
    const port = Number(new URL(bound.url).port);
    try {
      const page = openPage(port, TOKEN);
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
      page.send({ type: "open" });
      await peer.waitForOpen(2_000);

      // A Herdr or SSH client restart drops the tunnel: the socket closes, the call stays.
      page.socket.terminate();
      await page.closed;
      peer.setMuted(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(failures).toEqual([]);

      const back = openPage(port, TOKEN, undefined, { live: true });
      await back.opened;
      expect((await back.next("mute")).muted).toBe(true);
      back.send({ type: "event", payload: "{}" });
      peer.setMuted(false);
      expect((await back.next("mute")).muted).toBe(false);

      // A page that comes back without the call cannot resume it.
      back.socket.terminate();
      await back.closed;
      const fresh = openPage(port, TOKEN);
      await fresh.opened;
      await vi.waitFor(() => expect(failures).toEqual(["The browser audio page lost the call."]));
    } finally {
      await bound.close();
    }
  });

  test("the page keeps its call through a dropped socket and reports it on reconnect", async () => {
    const page = runPageScript();
    page.openSocket();
    await page.enable();
    await startPageCall(page);
    page.openChannel();
    expect(page.status()).toBe("Live. Speak to pi.");

    page.dropSocket(1006);
    expect(page.connections.at(-1)?.closed).toBe(false);
    expect(page.status()).toBe("Call still live. Reconnecting to pi…");
    await vi.waitFor(
      () => {
        page.openSocket();
        expect(page.sent.filter((message) => message.type === "hello").at(-1)).toMatchObject({
          live: true,
        });
      },
      { timeout: 3_000 },
    );
    expect(page.status()).toBe("Live. Speak to pi.");

    // pi stopping the call still hangs up.
    page.dropSocket(CLOSE_STOPPED);
    expect(page.connections.at(-1)?.closed).toBe(true);
  });

  test("matches devices by label and applies them to the microphone and every playback target", async () => {
    const page = runPageScript({ devices: [...BUILT_IN, YEALINK_MIC, YEALINK_SPEAKER] });
    page.openSocket();
    page.receive({ type: "audio.defaults", inputDevice: "yealink", outputDevice: "Yealink BT51" });
    await page.enable();
    await startPageCall(page);
    page.remoteTrack();
    await flush();

    // Substring match for the mic, exact match for the speaker; the "default" alias is skipped.
    expect(page.openedMics.at(-1)).toBe("mic-y");
    expect(page.sinks).toContainEqual(["audio", "spk-y"]);
    expect(page.sinks).toContainEqual(["context", "spk-y"]);
    expect(page.warning()).toBe("");
    expect(page.select("input").value).toBe("yealink");
  });

  test("matches Chrome's suffixed Yealink labels on Paul's Mac and never a built-in device", async () => {
    // Paul's Chrome device list; the system default is the built-in speakers.
    const devices: FakeDevice[] = [
      {
        kind: "audioinput",
        deviceId: "default",
        label: "Default - MacBook Pro Microphone (Built-in)",
      },
      { kind: "audioinput", deviceId: "communications", label: "Communications - Yealink BT51" },
      { kind: "audioinput", deviceId: "mic-mac", label: "MacBook Pro Microphone (Built-in)" },
      { kind: "audioinput", deviceId: "mic-camo", label: "Camo Microphone (Virtual)" },
      { kind: "audioinput", deviceId: "mic-phone", label: "Paul's iPhone Microphone" },
      { kind: "audioinput", deviceId: "mic-y", label: "YEALINK BT51 (Bluetooth)" },
      {
        kind: "audiooutput",
        deviceId: "default",
        label: "Default - MacBook Pro Speakers (Built-in)",
      },
      { kind: "audiooutput", deviceId: "spk-mac", label: "MacBook Pro Speakers (Built-in)" },
      { kind: "audiooutput", deviceId: "spk-y", label: "Yealink BT51 (6993:b0b1)" },
    ];
    const page = runPageScript({ devices });
    page.openSocket();
    page.receive({
      type: "audio.defaults",
      inputDevice: "Yealink BT51",
      outputDevice: "Yealink BT51",
    });
    await page.enable();
    await startPageCall(page);
    page.remoteTrack();
    await flush();

    expect(page.openedMics.at(-1)).toBe("mic-y");
    expect(page.sinks).toContainEqual(["audio", "spk-y"]);
    expect(page.sinks).toContainEqual(["context", "spk-y"]);
    expect(page.warning()).toBe("");
  });

  test("never picks another device when the Yealink is absent", async () => {
    const page = runPageScript({
      devices: [
        { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { kind: "audioinput", deviceId: "mic-mac", label: "MacBook Pro Microphone" },
        { kind: "audioinput", deviceId: "mic-camo", label: "Camo Microphone" },
        { kind: "audiooutput", deviceId: "spk-mac", label: "MacBook Pro Speakers" },
      ],
    });
    page.openSocket();
    page.receive({
      type: "audio.defaults",
      inputDevice: "Yealink BT51",
      outputDevice: "Yealink BT51",
    });
    await page.enable();
    await startPageCall(page);
    await flush();

    // The system default, never an exact pick of "MacBook Pro Microphone".
    expect(page.openedMics).not.toContain("mic-mac");
    expect(page.openedMics.at(-1)).toBe("default");
    expect(page.sinks.every(([, id]) => id === "")).toBe(true);
    expect(page.warning()).toContain('"Yealink BT51" is not available');
  });

  test("warns and falls back to the system default only once labels are known", async () => {
    const page = runPageScript({ devices: BUILT_IN });
    page.openSocket();
    page.receive({ type: "audio.defaults", inputDevice: "Yealink BT51", outputDevice: "Yealink" });
    await flush();
    // Before permission the labels are hidden, so the device cannot be judged missing.
    expect(page.warning()).toBe("");

    await page.enable();
    expect(page.warning()).toContain('Microphone "Yealink BT51" is not available');
    expect(page.warning()).toContain('Speaker "Yealink" is not available');
    await startPageCall(page);
    expect(page.openedMics.at(-1)).toBe("default");
    expect(page.sinks.at(-1)).toEqual(["context", ""]);
  });

  test("a page choice is remembered and beats the config default", async () => {
    const page = runPageScript({
      devices: [...BUILT_IN, YEALINK_MIC, YEALINK_SPEAKER],
      saved: { "pi-live-audio-input": "MacBook Pro Microphone" },
    });
    page.openSocket();
    page.receive({ type: "audio.defaults", inputDevice: "Yealink", outputDevice: "Yealink" });
    await page.enable();
    page.choose("output", "MacBook Pro Speakers");
    await startPageCall(page);
    await flush();

    expect(page.openedMics.at(-1)).toBe("mic-mac");
    expect(page.sinks.at(-1)).toEqual(["context", "spk-mac"]);
    expect(page.saved.get("pi-live-audio-output")).toBe("MacBook Pro Speakers");
  });

  test("switches to the chosen devices when they appear mid-call", async () => {
    const page = runPageScript({ devices: [...BUILT_IN] });
    page.openSocket();
    page.receive({ type: "audio.defaults", inputDevice: "Yealink", outputDevice: "Yealink" });
    await page.enable();
    await startPageCall(page);
    expect(page.openedMics).toEqual(["default", "default"]);
    expect(page.warning()).toContain("is not available");

    page.devices.push(YEALINK_MIC, YEALINK_SPEAKER);
    page.deviceChange();
    await vi.waitFor(() => expect(page.replaced).toEqual(["mic-y"]));
    await flush();
    expect(page.sinks).toContainEqual(["audio", "spk-y"]);
    expect(page.warning()).toBe("");
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

  test("after pi ends the call the page waits and reconnects, so calls reuse one tab", async () => {
    vi.useFakeTimers();
    try {
      const page = runPageScript();
      page.openSocket();
      const opened = page.socketsOpened();
      page.dropSocket(4002); // pi ended the call (/live stopped)
      expect(page.status()).toBe("Call ended; waiting for pi");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(page.socketsOpened()).toBe(opened + 1);
      // Nothing is listening yet: it keeps waiting instead of giving up.
      for (let attempt = 0; attempt < 8; attempt++) {
        page.dropSocket(1006);
        expect(page.status()).toBe("Call ended; waiting for pi");
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(page.socketsOpened()).toBe(opened + 9);
      page.openSocket(); // the next /live
      expect(page.status()).not.toContain("waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the server reports whether a page is connected", async () => {
    const bound = await startBrowserLiveAudio({ port: 0, token: TOKEN });
    try {
      expect(await bound.waitForPage(50)).toBe(false);
      const waiting = bound.waitForPage(5_000);
      const page = openPage(Number(new URL(bound.url).port), TOKEN);
      await page.opened;
      expect(await waiting).toBe(true);
      expect(await bound.waitForPage(0)).toBe(true);
    } finally {
      await bound.close();
    }
  });

  test("the voice and mute buttons control the call like GipPity's page", async () => {
    const page = runPageScript();
    page.openSocket();
    expect(page.voice().textContent).toBe("Tap to enable voice");
    await page.enable();
    page.receive({ type: "offer.request" });
    await vi.waitFor(() =>
      expect(page.sent.some((message) => message.type === "offer")).toBe(true),
    );
    expect(page.voice().dataset).toEqual({ state: "connecting" });
    page.openChannel();
    expect(page.voice().textContent).toBe("Tap to stop");
    expect(page.mute().hidden).toBe(false);
    expect(page.detail()).toBe("Listening");

    (page.mute().onclick as () => void)();
    expect(page.sent.at(-1)).toEqual({ type: "control", action: "mute" });
    page.receive({ type: "mute", muted: true });
    expect(page.mute().textContent).toBe("Unmute mic");
    expect(page.detail()).toBe("Microphone muted");

    await (page.voice().onclick as () => Promise<void>)();
    expect(page.sent.at(-1)).toEqual({ type: "control", action: "stop" });
  });
});
