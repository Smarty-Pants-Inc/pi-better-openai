import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { BROWSER_PAGE_HTML } from "./browser-page.ts";
import type { LiveAudioCapture, LiveNativeBindings, LiveWebRtcPeerInstance } from "./native.ts";
import { type LiveStateRecord, removeLiveState, writeLiveState } from "./state.ts";

// Browser audio: a loopback page is the WebRTC media peer, so pi can run on a
// host without audio devices (for example over SSH with `ssh -L PORT:127.0.0.1:PORT`).
// It implements the native bindings seam; the transport and controller are unchanged.

const HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
// ponytail: the controller only needs microphone RMS (visualizer, silence check),
// so each 100 ms page level report becomes 100 ms of constant 16 kHz samples instead
// of streaming PCM. Revisit if the controller starts consuming real samples.
const LEVEL_FRAME_SAMPLES = 1_600;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const CLOSE_REPLACED = 4000;
export const CLOSE_REJECTED = 4001;
export const CLOSE_STOPPED = 4002;

type PageMessage =
  | { type: "offer"; sdp: string }
  | { type: "open" }
  | { type: "event"; payload: string }
  | { type: "levels"; input: number; output: number }
  | { type: "failure"; message: string };

export interface BrowserLiveAudio {
  readonly url: string;
  readonly native: LiveNativeBindings;
  /** Set when options.statePath was given but the state file could not be written. */
  readonly stateError?: Error;
  close(): Promise<void>;
}

export interface BrowserLiveAudioOptions {
  port: number;
  token: string;
  host?: string;
  /** Where to publish the live state for a helper; omitted means no state file. */
  statePath?: string;
}

/** A new token for each /live run, so old URLs in scrollback or history stop working. */
export function createBrowserToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Accepts only loopback Host values, and same-origin loopback Origin values when present. */
export function isAllowedLoopbackRequest(host: string | undefined, origin?: string): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return origin === undefined || origin === `http://${host}`;
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parsePageMessage(data: RawData): PageMessage | undefined {
  try {
    const value = JSON.parse(data.toString()) as Record<string, unknown>;
    switch (value.type) {
      case "offer":
        return typeof value.sdp === "string" ? { type: "offer", sdp: value.sdp } : undefined;
      case "open":
        return { type: "open" };
      case "event":
        return typeof value.payload === "string"
          ? { type: "event", payload: value.payload }
          : undefined;
      case "levels":
        return typeof value.input === "number" && typeof value.output === "number"
          ? { type: "levels", input: value.input, output: value.output }
          : undefined;
      case "failure":
        return typeof value.message === "string"
          ? { type: "failure", message: value.message.slice(0, 500) }
          : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export async function startBrowserLiveAudio(
  options: BrowserLiveAudioOptions,
): Promise<BrowserLiveAudio> {
  const host = options.host ?? "127.0.0.1";
  let client: WebSocket | undefined;
  // At most one peer: the floor arbiter runs one live session per process.
  // ponytail: one fixed port means one serving pi process per host; a second /live
  // fails with EADDRINUSE. Revisit with a shared listener if people run parallel voice.
  const peers = new Set<BrowserPeer>();
  const captures = new Set<(samples: Float32Array) => void>();

  const send = (socket: WebSocket | undefined, message: Record<string, unknown>): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  class BrowserPeer implements LiveWebRtcPeerInstance {
    readonly #onEvent: (error: Error | null, payload: string) => void;
    readonly #onLevel: (error: Error | null, level: number) => void;
    readonly #onFailure: (error: Error | null, message: string) => void;
    #socket: WebSocket | undefined;
    #closed = false;
    #opened = false;
    #waiter:
      | { type: "client" | "offer" | "open"; resolve(value?: string): void; reject(e: Error): void }
      | undefined;

    constructor(
      onEvent: (error: Error | null, payload: string) => void,
      onLevel: (error: Error | null, level: number) => void,
      onFailure: (error: Error | null, message: string) => void,
    ) {
      this.#onEvent = onEvent;
      this.#onLevel = onLevel;
      this.#onFailure = onFailure;
      for (const previous of peers) previous.fail("Replaced by a newer live session.");
      peers.clear();
      peers.add(this);
    }

    #wait(type: "client" | "offer" | "open", timeoutMs?: number): Promise<string | undefined> {
      if (this.#closed) return Promise.reject(new Error("Browser live audio closed."));
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                this.#waiter = undefined;
                reject(new Error("The browser audio page did not connect the call in time."));
              }, timeoutMs);
        this.#waiter = {
          type,
          resolve: (value) => {
            if (timer) clearTimeout(timer);
            this.#waiter = undefined;
            resolve(value);
          },
          reject: (error) => {
            if (timer) clearTimeout(timer);
            this.#waiter = undefined;
            reject(error);
          },
        };
      });
    }

    clientConnected(): void {
      if (this.#waiter?.type === "client") this.#waiter.resolve();
    }

    socketClosed(socket: WebSocket): void {
      if (socket === this.#socket) this.fail("The browser audio page disconnected.");
    }

    handle(socket: WebSocket, message: PageMessage): void {
      if (this.#closed || socket !== this.#socket) return;
      switch (message.type) {
        case "offer":
          if (this.#waiter?.type === "offer") this.#waiter.resolve(message.sdp);
          break;
        case "open":
          this.#opened = true;
          if (this.#waiter?.type === "open") this.#waiter.resolve();
          break;
        case "event":
          this.#onEvent(null, message.payload);
          break;
        case "levels": {
          this.#onLevel(null, message.output);
          const samples = new Float32Array(LEVEL_FRAME_SAMPLES).fill(
            Number.isFinite(message.input) ? Math.min(1, Math.max(0, message.input)) : 0,
          );
          for (const capture of captures) capture(samples);
          break;
        }
        case "failure":
          this.fail(message.message);
          break;
      }
    }

    fail(message: string): void {
      if (this.#closed) return;
      this.#waiter?.reject(new Error(message));
      this.#onFailure(null, message);
    }

    async createOffer(): Promise<string> {
      // Waits without a deadline for the page; closing the transport aborts it.
      while (!client) await this.#wait("client");
      this.#socket = client;
      const offer = this.#wait("offer");
      send(this.#socket, { type: "offer.request" });
      return (await offer) ?? "";
    }

    async acceptAnswer(sdp: string): Promise<void> {
      if (!send(this.#socket, { type: "answer", sdp })) {
        throw new Error("The browser audio page disconnected.");
      }
    }

    async waitForOpen(timeoutMs = DEFAULT_OPEN_TIMEOUT_MS): Promise<void> {
      if (!this.#opened) await this.#wait("open", timeoutMs);
    }

    pushAudio(): void {
      // The browser sends microphone audio directly over WebRTC.
    }

    setMuted(muted: boolean): void {
      send(this.#socket, { type: "mute", muted });
    }

    async close(): Promise<void> {
      if (this.#closed) return;
      this.#closed = true;
      this.#waiter?.reject(new Error("Browser live audio closed."));
      send(this.#socket, { type: "hangup" });
      peers.delete(this);
    }
  }

  class BrowserAudioCapture implements LiveAudioCapture {
    readonly #listener: (samples: Float32Array) => void;

    constructor(
      _sampleRate: number,
      onAudio: (error: Error | null, samples: Float32Array) => void,
    ) {
      this.#listener = (samples) => onAudio(null, samples);
      captures.add(this.#listener);
    }

    stop(): void {
      captures.delete(this.#listener);
    }
  }

  const server = createServer((request, response) => {
    if (!isAllowedLoopbackRequest(request.headers.host) || request.method !== "GET") {
      response.writeHead(403).end();
      return;
    }
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(BROWSER_PAGE_HTML);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const origin = request.headers.origin;
    if (path !== "/ws" || !origin || !isAllowedLoopbackRequest(request.headers.host, origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;
      const helloTimer = setTimeout(
        () => ws.close(CLOSE_REJECTED, "hello timeout"),
        HELLO_TIMEOUT_MS,
      );
      ws.on("message", (data) => {
        if (!authenticated) {
          let token: unknown;
          try {
            token = (JSON.parse(data.toString()) as { type?: unknown; token?: unknown }).token;
          } catch {
            token = undefined;
          }
          clearTimeout(helloTimer);
          if (!tokenMatches(options.token, token)) {
            ws.close(CLOSE_REJECTED, "invalid token");
            return;
          }
          authenticated = true;
          const previous = client;
          client = ws;
          if (previous && previous !== ws) previous.close(CLOSE_REPLACED, "replaced");
          for (const peer of peers) peer.clientConnected();
          return;
        }
        const message = parsePageMessage(data);
        if (message) for (const peer of peers) peer.handle(ws, message);
      });
      ws.on("close", () => {
        clearTimeout(helloTimer);
        if (client === ws) client = undefined;
        for (const peer of peers) peer.socketClosed(ws);
      });
      ws.on("error", () => ws.terminate());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // An unhandled server error would crash pi; end the current call with the reason instead.
  server.on("error", (error) => {
    for (const peer of peers) peer.fail(`Browser audio server error: ${error.message}`);
  });

  const native: LiveNativeBindings = {
    AudioCapture: BrowserAudioCapture,
    LiveWebRtcPeer: BrowserPeer,
    deviceCheckGenerateToken: async () => ({ supported: false, latencyMs: 0 }),
    __ompInstallTokioRuntime: () => {},
  };

  const port = (server.address() as { port: number }).port;
  const url = `http://localhost:${port}/#${options.token}`;
  const state: LiveStateRecord = {
    port,
    url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  let stateError: Error | undefined;
  if (options.statePath) {
    try {
      writeLiveState(options.statePath, state);
    } catch (cause) {
      stateError = cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  return {
    url,
    native,
    ...(stateError ? { stateError } : {}),
    close: async () => {
      if (options.statePath) removeLiveState(options.statePath, state);
      await Promise.all([...peers].map((peer) => peer.close()));
      client = undefined;
      // Let pages receive the stop code so they do not retry, then force the rest.
      const open = [...sockets.clients];
      await Promise.all(
        open.map(
          (socket) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                socket.terminate();
                resolve();
              }, 500);
              socket.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
              socket.close(CLOSE_STOPPED, "live stopped");
            }),
        ),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
