import { describe, expect, test, vi } from "vitest";
import { LiveSessionController } from "../src/live/controller.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import type { LiveClientMessage } from "../src/live/protocol.ts";
import type { LiveTransportOptions } from "../src/live/transport.ts";

function fakeNative(): LiveNativeBindings {
  return {
    AudioCapture: class {
      stop(): void {}
    },
    LiveWebRtcPeer: class {
      async createOffer(): Promise<string> {
        return "offer";
      }
      async acceptAnswer(): Promise<void> {}
      async waitForOpen(): Promise<void> {}
      pushAudio(): void {}
      setMuted(): void {}
      async close(): Promise<void> {}
    },
    async deviceCheckGenerateToken() {
      return { supported: false, latencyMs: 0 };
    },
    __ompInstallTokioRuntime() {},
  };
}

async function flushSends(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function startFakeSession() {
  let transportOptions: LiveTransportOptions | undefined;
  const send = vi.fn(async (_message: LiveClientMessage) => undefined);
  const delegate = vi.fn((_request: string) => undefined);
  const controller = new LiveSessionController({
    sessionId: "session-fifo",
    native: fakeNative(),
    getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
    delegate,
    createTransport: (options) => {
      transportOptions = options;
      return {
        connect: vi.fn(async () => undefined),
        send,
        pushAudio: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      };
    },
    createAudioCapture: () => ({ stop: vi.fn() }),
    callbacks: { onPhase: vi.fn(), onLevels: vi.fn(), onTranscript: vi.fn(), onTerminal: vi.fn() },
  });
  await controller.start();
  const emit = (event: Parameters<LiveTransportOptions["callbacks"]["onEvent"]>[0]) =>
    transportOptions?.callbacks.onEvent(event);
  const delegation = (id: string, text: string) =>
    emit({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
    });
  /** Pi's message_end for the steered delegation message. */
  const consume = (call: number) =>
    controller.handleAgentMessage({ role: "custom", content: delegate.mock.calls[call]?.[0] });
  const reply = (text: string, stopReason = "stop") =>
    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    });
  const finals = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "delegation.context.append" && !("channel" in message))
      .map((message) =>
        message.type === "delegation.context.append"
          ? [message.delegation_item_id, message.content[0]?.text]
          : [],
      );
  };
  /** Standalone context appends that are not tied to a delegation. */
  const standalone = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "session.context.append");
  };
  return {
    controller,
    emit,
    delegation,
    delegate,
    consume,
    reply,
    finals,
    standalone,
    send,
    transportOptions: () => transportOptions,
  };
}

const speakable = (text: string) => ({
  type: "session.context.append",
  channel: "speakable",
  content: [{ type: "input_text", text }],
});

describe("LiveSessionController", () => {
  test("delegates coding work and returns commentary plus the final agent result", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    const callOrder: string[] = [];
    const send = vi.fn(async (message: LiveClientMessage) => {
      callOrder.push(`send:${message.type}`);
    });
    const delegate = vi.fn();
    const phases: string[] = [];
    const transcripts: unknown[] = [];
    const terminal = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-1",
      voice: "vale",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate,
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send,
          pushAudio: vi.fn(),
          setMuted: vi.fn(),
          close: vi.fn(async () => {
            callOrder.push("close");
          }),
        };
      },
      createAudioCapture: () => ({ stop: vi.fn() }),
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels: vi.fn(),
        onTranscript: (transcript) => transcripts.push(transcript),
        onTerminal: terminal,
      },
    });

    await controller.start();
    expect(transportOptions?.voice).toBe("vale");
    transportOptions?.callbacks.onEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "Fix the failing test." }],
      },
    });
    const request =
      "<realtime_delegation>\n  <input>Fix the failing test.</input>\n</realtime_delegation>";
    expect(delegate).toHaveBeenCalledWith(request);
    expect(phases).toContain("working");

    controller.handleAgentMessage({ role: "custom", content: request });
    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "I found the failing assertion." }],
      stopReason: "toolUse",
    });
    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fixed the assertion and all tests pass." }],
      stopReason: "stop",
    });
    controller.handleAgentSettled();
    await flushSends();

    const messages = send.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "commentary",
      content: [{ type: "input_text", text: "I found the failing assertion." }],
    });
    expect(messages).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      content: [
        {
          type: "input_text",
          text: '"Agent Final Message":\n\nFixed the assertion and all tests pass.',
        },
      ],
    });
    expect(controller.activeDelegationId).toBeUndefined();

    transportOptions?.callbacks.onEvent({
      type: "input_transcript.added",
      item: { text: "Run" },
    });
    transportOptions?.callbacks.onEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "Run the tests." },
    });
    expect(transcripts.at(-1)).toEqual({
      role: "user",
      text: "Run the tests.",
      turn: 1,
      final: true,
    });

    await controller.stop();
    expect(send).toHaveBeenLastCalledWith({ type: "session.close" });
    expect(callOrder.slice(-2)).toEqual(["send:session.close", "close"]);
    expect(terminal).toHaveBeenCalledOnce();
  });

  test("carries undelegated transcripts from before a pause and the previous turn", async () => {
    const { controller, emit, delegation, delegate } = await startFakeSession();
    emit({ type: "input_transcript.added", item: { text: "Make sure the whole fleet" } });
    emit({
      type: "turn.done",
      turn: { role: "user", transcript: "Make sure the whole fleet uses the new workflows." },
    });
    emit({ type: "turn.done", turn: { role: "assistant", transcript: "Which workflows?" } });
    emit({ type: "input_transcript.added", item: { text: "The GitHub & Fabric ones" } });
    delegation("d-1", "Check the fleet uses the GitHub and Fabric workflows.");

    expect(delegate).toHaveBeenLastCalledWith(
      [
        "<realtime_delegation>",
        "  <input>Check the fleet uses the GitHub and Fabric workflows.</input>",
        "  <transcript_delta>user: Make sure the whole fleet uses the new workflows.",
        "assistant: Which workflows?",
        "user: The GitHub &amp; Fabric ones</transcript_delta>",
        "</realtime_delegation>",
      ].join("\n"),
    );

    // The rest of the partly delegated turn goes with the next delegation, without repeats.
    emit({
      type: "turn.done",
      turn: { role: "user", transcript: "The GitHub & Fabric ones, on every host." },
    });
    delegation("d-2", "Include every host.");
    expect(delegate).toHaveBeenLastCalledWith(
      [
        "<realtime_delegation>",
        "  <input>Include every host.</input>",
        "  <transcript_delta>user: , on every host.</transcript_delta>",
        "</realtime_delegation>",
      ].join("\n"),
    );
    await controller.stop();
  });

  test("drops a final user turn that only repeats the delegation input", async () => {
    const { controller, emit, delegation, delegate } = await startFakeSession();
    emit({ type: "turn.done", turn: { role: "user", transcript: "Hi." } });
    emit({ type: "turn.done", turn: { role: "assistant", transcript: "Hello." } });
    emit({ type: "turn.done", turn: { role: "user", transcript: "  Run the\n tests  on dev2. " } });
    delegation("d-1", "Run the tests on dev2.");
    expect(delegate).toHaveBeenLastCalledWith(
      [
        "<realtime_delegation>",
        "  <input>Run the tests on dev2.</input>",
        "  <transcript_delta>user: Hi.",
        "assistant: Hello.</transcript_delta>",
        "</realtime_delegation>",
      ].join("\n"),
    );

    // A partial transcript that the input already holds is dropped as well; no empty delta is sent.
    emit({ type: "input_transcript.added", item: { text: "Then deploy" } });
    delegation("d-2", "Then deploy it.");
    expect(delegate).toHaveBeenLastCalledWith(
      ["<realtime_delegation>", "  <input>Then deploy it.</input>", "</realtime_delegation>"].join(
        "\n",
      ),
    );
    await controller.stop();
  });

  test("keeps a final user turn that adds to the delegation input", async () => {
    const { controller, emit, delegation, delegate } = await startFakeSession();
    emit({
      type: "turn.done",
      turn: { role: "user", transcript: "Run the tests, but only on dev2." },
    });
    delegation("d-1", "Run the tests.");
    expect(delegate).toHaveBeenLastCalledWith(
      [
        "<realtime_delegation>",
        "  <input>Run the tests.</input>",
        "  <transcript_delta>user: Run the tests, but only on dev2.</transcript_delta>",
        "</realtime_delegation>",
      ].join("\n"),
    );
    await controller.stop();
  });

  test("answers every delegation made while Pi is busy, in order", async () => {
    const { controller, delegation, consume, reply, finals, standalone } = await startFakeSession();
    delegation("d-1", "First question?");
    delegation("d-2", "Second question?");
    delegation("d-3", "Third question?");
    expect(controller.activeDelegationId).toBe("d-1");

    // Pi first finishes unrelated work from another steer; it must not answer a delegation.
    reply("Answer to a Fabric steer.");
    consume(0);
    reply("Answer one.");
    consume(1);
    reply("Answer two.");
    consume(2);
    reply("Answer three.");
    controller.handleAgentSettled();

    expect(await finals()).toEqual([
      ["d-1", '"Agent Final Message":\n\nAnswer one.'],
      ["d-2", '"Agent Final Message":\n\nAnswer two.'],
      ["d-3", '"Agent Final Message":\n\nAnswer three.'],
    ]);
    expect(await standalone()).toEqual([speakable("Answer to a Fabric steer.")]);
    expect(controller.activeDelegationId).toBeUndefined();
    await controller.stop();
  });

  test("sends the final on message_end without waiting for agent_settled", async () => {
    const { controller, delegation, consume, reply, finals, standalone } = await startFakeSession();
    delegation("d-1", "What changed?");
    consume(0);
    reply("Looking.", "toolUse");
    reply("Two files changed.");

    // Other steers keep the run going; the answer is already out.
    expect(await finals()).toEqual([["d-1", '"Agent Final Message":\n\nTwo files changed.']]);
    expect(controller.phase).not.toBe("working");
    reply("Answer to a later Fabric steer.");
    controller.handleAgentSettled();
    expect(await finals()).toHaveLength(1);
    expect(await standalone()).toEqual([speakable("Answer to a later Fabric steer.")]);
    await controller.stop();
  });

  test("sends a non-delegated final to voice once as standalone speakable context", async () => {
    const { controller, reply, standalone, send } = await startFakeSession();
    // An idle call: Pi answers a Fabric steer or typed input that no delegation started.
    reply("The org lead approved the fleet rollout.");
    controller.handleAgentSettled();

    expect(await standalone()).toEqual([speakable("The org lead approved the fleet rollout.")]);
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(["session.context.append"]);
    expect(controller.phase).toBe("listening");
    await controller.stop();
  });

  test("speaks a delegated final only through its delegation", async () => {
    const { controller, delegation, consume, reply, finals, standalone } = await startFakeSession();
    delegation("d-1", "Run the tests.");
    consume(0);
    reply("All tests pass.");
    controller.handleAgentSettled();

    expect(await finals()).toEqual([["d-1", '"Agent Final Message":\n\nAll tests pass.']]);
    expect(await standalone()).toEqual([]);
    await controller.stop();
  });

  test("injects typed user text into the live context once, as silent [USER] context", async () => {
    const { controller, send, delegate, transportOptions } = await startFakeSession();
    // Voice is told that Pi already handles typed text, so it must not delegate it again.
    expect(transportOptions()?.instructions).toContain(
      'Context beginning with "[USER] " is text the user typed to your execution surface, which is already handling it; use it as context and do not delegate it again.',
    );
    controller.sendUserText("  What changed in the fleet?\n");
    controller.sendUserText("   ");
    await new Promise((resolve) => setImmediate(resolve));

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "session.context.append",
        content: [{ type: "input_text", text: "[USER] What changed in the fleet?" }],
      },
    ]);
    expect(delegate).not.toHaveBeenCalled();
    await controller.stop();
    controller.sendUserText("Too late.");
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      send.mock.calls.filter(([message]) => message.type === "session.context.append"),
    ).toHaveLength(1);
  });

  test("keeps non-delegated tool-use and aborted replies silent", async () => {
    const { controller, reply, send } = await startFakeSession();
    reply("Checking the fleet.", "toolUse");
    reply("", "toolUse");
    reply("Partial answ", "aborted");
    reply("");
    controller.handleAgentSettled();
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).not.toHaveBeenCalled();
    await controller.stop();
  });

  test("starts microphone capture before transport negotiation completes", async () => {
    let finishConnect: (() => void) | undefined;
    const connect = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const createAudioCapture = vi.fn(() => ({ stop: vi.fn() }));
    const controller = new LiveSessionController({
      sessionId: "session-connecting",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: () => ({
        connect: () => connect,
        send: vi.fn(async () => undefined),
        pushAudio: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      createAudioCapture,
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    const start = controller.start();
    expect(createAudioCapture).toHaveBeenCalledOnce();
    finishConnect?.();
    await start;
    await controller.stop();
  });

  test("reports privacy-filtered zero-only microphone input", async () => {
    let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
    const terminal = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-silent",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: () => ({
        connect: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        pushAudio: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      createAudioCapture: (_native, callback) => {
        onAudio = callback;
        return { stop: vi.fn() };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: terminal,
      },
    });

    await controller.start();
    onAudio?.(null, new Float32Array(32_000));

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(terminal.mock.calls[0]?.[0]?.message).toContain("only digital silence");
    await controller.stop();
  });

  test("suppresses likely speaker echo, permits barge-in, and honors mute", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
    const pushAudio = vi.fn();
    const setMuted = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-2",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
          pushAudio,
          setMuted,
          close: vi.fn(async () => undefined),
        };
      },
      createAudioCapture: (_native, callback) => {
        onAudio = callback;
        return { stop: vi.fn() };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    await controller.start();
    transportOptions?.callbacks.onOutputLevel(0.5);
    onAudio?.(null, new Float32Array([0.1, -0.1, 0.1, -0.1]));
    expect(pushAudio).not.toHaveBeenCalled();
    const loud = new Float32Array([0.8, -0.8, 0.8, -0.8]);
    onAudio?.(null, loud);
    expect(pushAudio).toHaveBeenCalledWith(loud);

    controller.toggleMute();
    expect(controller.muted).toBe(true);
    expect(setMuted).toHaveBeenLastCalledWith(true);
    onAudio?.(null, loud);
    expect(pushAudio).toHaveBeenCalledOnce();

    await controller.stop();
  });

  test("restores the real phase after mute then unmute", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    let connected: (() => void) | undefined;
    const phases: string[] = [];
    const controller = new LiveSessionController({
      sessionId: "session-3",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: () => new Promise<void>((resolve) => (connected = resolve)),
          send: vi.fn(async () => undefined),
          pushAudio: vi.fn(),
          setMuted: vi.fn(),
          close: vi.fn(async () => undefined),
        };
      },
      createAudioCapture: () => ({ stop: vi.fn() }),
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });
    const muteThenUnmute = () => {
      controller.toggleMute();
      expect(controller.phase).toBe("muted");
      controller.toggleMute();
    };

    const started = controller.start();
    await flushSends();
    expect(controller.phase).toBe("connecting");
    muteThenUnmute();
    expect(controller.phase).toBe("connecting");
    transportOptions?.callbacks.onOutputLevel(0);
    expect(controller.phase).toBe("connecting");

    connected?.();
    await started;
    expect(controller.phase).toBe("listening");

    transportOptions?.callbacks.onOutputLevel(0.5);
    expect(controller.phase).toBe("speaking");
    muteThenUnmute();
    expect(controller.phase).toBe("speaking");
    transportOptions?.callbacks.onOutputLevel(0);

    transportOptions?.callbacks.onEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-3",
        content: [{ type: "input_text", text: "Run the tests." }],
      },
    });
    expect(controller.phase).toBe("working");
    muteThenUnmute();
    expect(controller.phase).toBe("working");

    expect(phases).not.toContain("error");
    await controller.stop();
  });
});
