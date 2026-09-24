import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, type Mock } from "vitest";
import {
  LIVE_COMMAND,
  LIVE_FOCUS_SETTLE_MS,
  LIVE_DELEGATION_MESSAGE_TYPE,
  LIVE_TURN_ENTRY_TYPE,
  registerOpenAILive,
  renderLiveTurn,
} from "../src/live/index.ts";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import {
  LiveFloorArbiter,
  type LiveFloorArbiterCallbacks,
  type LiveFloorArbiterLike,
  type LiveFloorArbiterOptions,
} from "../src/live/queue.ts";
import { DEFAULT_LIVE_CONFIG } from "../src/config.ts";
import type { BrowserLiveAudio } from "../src/live/browser.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import { LIVE_VISUALIZER_TOGGLE_KEY } from "../src/live/visualizer.ts";
import { makeResolvedConfig } from "./helpers.ts";

type CommandOptions = {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type ShortcutOptions = {
  description?: string;
  handler(ctx: ExtensionContext): Promise<void> | void;
};

function createRegistrationHarness() {
  const commands = new Map<string, CommandOptions>();
  const shortcuts = new Map<string, ShortcutOptions>();
  const events: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const renderers: string[] = [];
  const pi = {
    registerCommand: vi.fn((name: string, options: CommandOptions) => commands.set(name, options)),
    registerShortcut: vi.fn((key: string, options: ShortcutOptions) => shortcuts.set(key, options)),
    registerMessageRenderer: vi.fn((type: string) => renderers.push(type)),
    registerEntryRenderer: vi.fn((type: string) => renderers.push(type)),
    appendEntry: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      events.push(event);
      handlers.set(event, handler);
    }),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, commands, shortcuts, events, handlers, renderers };
}

function commandFrom(harness: ReturnType<typeof createRegistrationHarness>): CommandOptions {
  const command = harness.commands.get(LIVE_COMMAND);
  if (!command) throw new Error("live command was not registered");
  return command;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type FakeTui = {
  requestRender: ReturnType<typeof vi.fn>;
  terminal: { write: ReturnType<typeof vi.fn>; rows: number };
  addInputListener: ReturnType<typeof vi.fn>;
  children: Component[];
};

function makeFakeTui(): FakeTui {
  return {
    requestRender: vi.fn(),
    terminal: { write: vi.fn(), rows: 24 },
    addInputListener: vi.fn(() => vi.fn()),
    children: [],
  };
}

type FakeEditor = Component & {
  history: string[];
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  addToHistory(text: string): void;
};

/** Pi's editor shape: top border, text, bottom border. */
function makeFakeEditor(): FakeEditor {
  const history: string[] = [];
  return {
    history,
    render: (width: number) => ["─".repeat(width), "draft", "─".repeat(width)],
    invalidate: () => undefined,
    getText: () => "",
    setText: () => undefined,
    handleInput: () => undefined,
    addToHistory: (text: string) => void history.unshift(text),
  };
}

const editorTheme = { borderColor: (text: string) => text, selectList: {} };

type FakeEditorFactory = (tui: FakeTui, theme: unknown, keybindings: unknown) => FakeEditor;

type FakeArbiter = {
  id: string;
  label: string;
  policy: LiveFloorArbiterLike["policy"];
  hasFloor: boolean;
  join: Mock<() => void>;
  leave: Mock<() => void>;
  tick: Mock<() => void>;
  setFocused: Mock<(focused: boolean) => void>;
};

type FakeArbiterControl = {
  options?: LiveFloorArbiterOptions;
  callbacks?: LiveFloorArbiterCallbacks;
  arbiter: FakeArbiter;
  createArbiter: (
    options: LiveFloorArbiterOptions,
    callbacks: LiveFloorArbiterCallbacks,
  ) => LiveFloorArbiterLike;
};

function requireCallbacks(control: FakeArbiterControl): LiveFloorArbiterCallbacks {
  if (!control.callbacks) throw new Error("arbiter not enrolled yet");
  return control.callbacks;
}

function makeFakeArbiter(): FakeArbiterControl {
  const control: FakeArbiterControl = {
    arbiter: undefined as unknown as FakeArbiterControl["arbiter"],
    createArbiter: (options, callbacks) => {
      control.options = options;
      control.callbacks = callbacks;
      control.arbiter = {
        id: "fake-arbiter",
        label: "project · session-7",
        policy: options.policy,
        hasFloor: false,
        join: vi.fn<() => void>(),
        leave: vi.fn<() => void>(),
        tick: vi.fn<() => void>(),
        setFocused: vi.fn<(focused: boolean) => void>(),
      };
      return control.arbiter;
    },
  };
  return control;
}

/** Pi's editor slot: an undefined factory mounts the default editor instance again. */
function makeFakeUi(notify = vi.fn()) {
  const defaultEditor = makeFakeEditor();
  const state = {
    tui: makeFakeTui(),
    defaultEditor,
    editor: defaultEditor as FakeEditor,
    editorFactory: undefined as FakeEditorFactory | undefined,
    editorText: "",
    keyHandler: undefined as ((data: string) => { consume?: boolean } | undefined) | undefined,
    removeKeys: vi.fn(() => {
      state.keyHandler = undefined;
    }),
  };
  const ui = {
    notify,
    custom: vi.fn(),
    getEditorText: () => state.editorText,
    onTerminalInput: vi.fn((handler: (data: string) => { consume?: boolean } | undefined) => {
      state.keyHandler = handler;
      return state.removeKeys;
    }),
    theme,
    getEditorComponent: () => state.editorFactory,
    setEditorComponent: vi.fn((factory: FakeEditorFactory | undefined) => {
      state.editorFactory = factory;
      state.editor = factory ? factory(state.tui, editorTheme, {}) : state.defaultEditor;
      state.tui.children = [state.editor];
    }),
  };
  state.tui.children = [state.editor];
  return { state, ui };
}

function makeContext(ui: object) {
  return {
    mode: "tui",
    cwd: "/project",
    ui,
    sessionManager: { getSessionId: () => "session-7" },
    modelRegistry: {},
  } as unknown as ExtensionCommandContext;
}

function makeSessionStub(options: LiveSessionControllerOptions, endsOnStart = true) {
  return {
    options,
    start: vi.fn(async () => {
      if (endsOnStart) options.callbacks.onTerminal();
    }),
    stop: vi.fn(async () => undefined),
    toggleMute: vi.fn(),
    sendUserText: vi.fn(),
    handleAgentMessage: vi.fn(),
    handleAgentSettled: vi.fn(),
  };
}

describe("registerOpenAILive", () => {
  test("registers the public command, non-conflicting toggle, renderer, and agent hooks", () => {
    const harness = createRegistrationHarness();
    registerOpenAILive(harness.pi, () => makeResolvedConfig());

    expect(harness.commands.has("live")).toBe(true);
    expect(harness.shortcuts.has(LIVE_VISUALIZER_TOGGLE_KEY)).toBe(true);
    expect(LIVE_VISUALIZER_TOGGLE_KEY).toBe("ctrl+shift+l");
    expect(harness.renderers).toContain(LIVE_DELEGATION_MESSAGE_TYPE);
    expect(harness.events).toEqual(["input", "message_end", "agent_settled", "session_shutdown"]);
  });

  test("rejects non-TUI and disabled invocations before opening custom UI", async () => {
    const harness = createRegistrationHarness();
    registerOpenAILive(harness.pi, () =>
      makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: false, voice: "sol" } }),
    );
    const notify = vi.fn();
    const { ui } = makeFakeUi(notify);
    const ctx = { mode: "rpc", ui } as unknown as ExtensionCommandContext;

    await commandFrom(harness).handler("", ctx);
    expect(notify).toHaveBeenCalledWith("Live voice requires interactive TUI mode.", "warning");
    expect(ui.setEditorComponent).not.toHaveBeenCalled();

    const tuiCtx = { mode: "tui", ui } as unknown as ExtensionCommandContext;
    await commandFrom(harness).handler("", tuiCtx);
    expect(notify).toHaveBeenLastCalledWith(
      "Live voice is disabled. Enable it in /openai-settings.",
      "warning",
    );
    expect(ui.setEditorComponent).not.toHaveBeenCalled();
  });

  test("activates on the floor grant and cleans up session and queue on close", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const disposeFocus = vi.fn();
    const notifyUnfocused = vi.fn();
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true, voice: "vale" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => disposeFocus),
        notifyActivatedUnfocused: notifyUnfocused,
        tickMs: 60_000,
      },
    );

    const { state, ui } = makeFakeUi();
    const ctx = makeContext(ui);

    await commandFrom(harness).handler("", ctx);
    // The status is drawn on the bottom border of Pi's editor, not a custom UI or widget that adds rows.
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
    expect(state.editor.render(60)).toHaveLength(3);
    expect(state.editor.render(60).at(-1)).toContain("standby");
    expect(live.isActive()).toBe(true);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    expect(arbiter.options?.policy).toBe("focus");
    requireCallbacks(arbiter).onActivated("focus");
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    expect(state.editor).toBe(state.defaultEditor);
    expect(state.editor.render(60).at(-1)).toBe("─".repeat(60));
    expect(state.removeKeys).toHaveBeenCalledOnce();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.options.voice).toBe("vale");
    expect(sessions[0]!.options.sessionId).toBe("session-7");
    expect(sessions[0]!.start).toHaveBeenCalledOnce();
    expect(sessions[0]!.stop).toHaveBeenCalledOnce();
    expect(arbiter.arbiter.leave).toHaveBeenCalledOnce();
    expect(disposeFocus).toHaveBeenCalledOnce();
    expect(notifyUnfocused).not.toHaveBeenCalled();
  });

  test("parks the session back to standby on floor loss without closing the enrollment", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true, voice: "sol" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options, false);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => false),
        attachFocusReporting: vi.fn(() => vi.fn()),
        tickMs: 60_000,
      },
    );

    const { state, ui } = makeFakeUi();
    const ctx = makeContext(ui);

    await commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    expect(arbiter.options?.policy).toBe("fifo");
    const rendered = state.editor.render(60).at(-1);
    expect(rendered).toContain("standby");

    requireCallbacks(arbiter).onActivated("fifo");
    await vi.waitFor(() => {
      if (sessions.length !== 1) throw new Error("session not activated yet");
    });
    requireCallbacks(arbiter).onDeactivated();
    await vi.waitFor(() => {
      if (sessions[0]!.stop.mock.calls.length !== 1) throw new Error("session not parked yet");
    });
    expect(state.editor.render(60).at(-1)).toContain("standby");
    expect(live.isActive()).toBe(true);

    // A second /live ends the call.
    await commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(sessions).toHaveLength(1);
    expect(arbiter.arbiter.leave).toHaveBeenCalledOnce();
  });

  test("logs each final voice turn once as a display-only entry", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options, false);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => false),
        tickMs: 60_000,
      },
    );
    const { ui } = makeFakeUi();
    await commandFrom(harness).handler("", makeContext(ui));
    await vi.waitFor(() => requireCallbacks(arbiter));
    requireCallbacks(arbiter).onActivated("fifo");
    await vi.waitFor(() => expect(sessions[0]?.start).toHaveBeenCalledOnce());
    const { onTranscript } = sessions[0]!.options.callbacks;
    onTranscript({ role: "user", text: "check the", turn: 1, final: false });
    onTranscript({ role: "user", text: "check the build", turn: 1, final: true });
    onTranscript({ role: "user", text: "check the build", turn: 1, final: true });
    onTranscript({ role: "assistant", text: "It is green.", turn: 1, final: true });
    onTranscript(undefined);
    expect(harness.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(1, LIVE_TURN_ENTRY_TYPE, {
      role: "user",
      text: "check the build",
    });
    expect(harness.pi.appendEntry).toHaveBeenNthCalledWith(2, LIVE_TURN_ENTRY_TYPE, {
      role: "assistant",
      text: "It is green.",
    });
    // Display-only: nothing is sent to the model.
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.renderers).toContain(LIVE_TURN_ENTRY_TYPE);
    await live.stop();
  });

  test("renders a logged turn as GipPity did", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const you = renderLiveTurn({ role: "user", text: "check the build" }, theme as never);
    const youText = you.render(60).join("\n");
    expect(youText).toContain("<customMessageLabel>You said");
    expect(youText).toContain("<customMessageText>check the build");
    const agent = renderLiveTurn({ role: "assistant", text: "It is green." }, theme as never);
    expect(agent.render(60).join("\n")).toContain("<customMessageLabel>Realtime Voice");
  });

  test("wraps another extension's editor and restores its factory and history on stop", async () => {
    const harness = createRegistrationHarness();
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true } }),
      {
        createSession: (options) => makeSessionStub(options, false),
        createArbiter: makeFakeArbiter().createArbiter,
        probeFocusReporting: vi.fn(async () => false),
        tickMs: 60_000,
      },
    );
    const { state, ui } = makeFakeUi();
    const otherFactory = vi.fn(() => makeFakeEditor());
    ui.setEditorComponent(otherFactory);
    const ctx = {
      ...makeContext(ui),
      sessionManager: {
        getSessionId: () => "session-7",
        getBranch: () => [
          { type: "message", message: { role: "user", content: "earlier prompt" } },
          { type: "message", message: { role: "assistant", content: "reply" } },
        ],
      },
    } as unknown as ExtensionCommandContext;

    await commandFrom(harness).handler("", ctx);
    const liveEditor = state.editor;
    expect(otherFactory).toHaveBeenCalledTimes(2);
    expect(liveEditor.history).toEqual(["earlier prompt"]);
    expect(liveEditor.render(80)[1]).toBe("draft");
    liveEditor.addToHistory("typed during the call");

    await live.stop();
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(ui.getEditorComponent()).toBe(otherFactory);
    expect(state.editor).not.toBe(liveEditor);
    expect(state.editor.render(80).at(-1)).toBe("─".repeat(80));
    expect(state.editor.history).toEqual(["typed during the call"]);
  });

  test("returns in-call prompts to Pi's default editor history", async () => {
    const { live, state } = await startTypingCall();
    expect(state.editor).not.toBe(state.defaultEditor);
    state.editor.addToHistory("first");
    state.editor.addToHistory("second");
    await live.stop();
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(state.editor).toBe(state.defaultEditor);
    expect(state.defaultEditor.history).toEqual(["second", "first"]);
  });

  test("a focus-out, terminal detach, and reattach keep the live call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-live-focus-"));
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    let onFocus: ((focused: boolean) => void) | undefined;
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options, false);
          sessions.push(stub);
          return stub;
        },
        // The real file-backed arbiter, so its focus rules are what is tested.
        createArbiter: (options, callbacks) =>
          new LiveFloorArbiter({ ...options, directory }, callbacks),
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn((_handle, listener: (focused: boolean) => void) => {
          onFocus = listener;
          return vi.fn();
        }),
        tickMs: 10,
      },
    );
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const { ui } = makeFakeUi();
    try {
      await commandFrom(harness).handler("", makeContext(ui));
      await vi.waitFor(() => expect(sessions[0]?.start).toHaveBeenCalledOnce());
      onFocus!(true);
      await sleep(LIVE_FOCUS_SETTLE_MS + 50);

      // The Herdr client exits: the terminal reports focus-out, then stays silent while detached.
      onFocus!(false);
      await sleep(200);
      // The client reattaches and the terminal reports focus again.
      onFocus!(true);
      await sleep(LIVE_FOCUS_SETTLE_MS + 100);

      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.stop).not.toHaveBeenCalled();
      expect(live.isActive()).toBe(true);
      expect(ui.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
    } finally {
      await live.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("notifies through the terminal when the floor is granted unfocused", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const notifyUnfocused = vi.fn();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true, voice: "sol" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => vi.fn()),
        notifyActivatedUnfocused: notifyUnfocused,
        tickMs: 60_000,
      },
    );

    const { ui } = makeFakeUi();
    const ctx = makeContext(ui);

    await commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    requireCallbacks(arbiter).onActivated("background");
    await vi.waitFor(() => {
      if (sessions.length !== 1) throw new Error("session not activated yet");
    });
    expect(notifyUnfocused).toHaveBeenCalledOnce();
    expect(notifyUnfocused.mock.calls[0]?.[1]).toBe("project · session-7");
  });

  async function startTypingCall() {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const live = registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { ...DEFAULT_LIVE_CONFIG, enabled: true } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options, false);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => false),
        tickMs: 60_000,
      },
    );
    const fake = makeFakeUi();
    await commandFrom(harness).handler("", makeContext(fake.ui));
    await vi.waitFor(() => requireCallbacks(arbiter));
    requireCallbacks(arbiter).onActivated("fifo");
    await vi.waitFor(() => expect(sessions[0]?.start).toHaveBeenCalledOnce());
    const session = sessions[0]!;
    const key = (data: string) => fake.state.keyHandler?.(data);
    return { harness, live, session, key, ...fake };
  }

  test("Space mutes and Esc ends the call only while the editor is empty", async () => {
    const { live, session, key, state } = await startTypingCall();

    state.editorText = "draft";
    expect(key(" ")).toBeUndefined();
    expect(key("\u001b")).toBeUndefined();
    expect(session.toggleMute).not.toHaveBeenCalled();
    expect(live.isActive()).toBe(true);

    state.editorText = "";
    expect(key(" ")).toEqual({ consume: true });
    expect(session.toggleMute).toHaveBeenCalledOnce();
    expect(key("x")).toBeUndefined();
    expect(key("\u001b")).toEqual({ consume: true });
    // The first Esc ends the call and releases the keys, so a second Esc reaches Pi's own
    // app.interrupt and aborts a streaming turn.
    await vi.waitFor(() => expect(state.keyHandler).toBeUndefined());
    expect(key("\u001b")).toBeUndefined();
    await vi.waitFor(() => expect(live.isActive()).toBe(false));
    expect(session.stop).toHaveBeenCalledOnce();
    expect(state.removeKeys).toHaveBeenCalledOnce();
  });

  test("typed input goes to Pi unchanged and into the live call once", async () => {
    const { harness, live, session } = await startTypingCall();
    const input = harness.handlers.get("input")!;

    // "continue" lets Pi send the text as a normal user message.
    expect(input({ type: "input", text: "What changed?", source: "interactive" }, {})).toEqual({
      action: "continue",
    });
    expect(session.sendUserText).toHaveBeenCalledExactlyOnceWith("What changed?");
    // Pi gets the typed text once, through its own submit; nothing is delegated on top of it.
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    input({ type: "input", text: "From another extension", source: "extension" }, {});
    input({ type: "input", text: "From RPC", source: "rpc" }, {});
    expect(session.sendUserText).toHaveBeenCalledOnce();

    await live.stop();
    input({ type: "input", text: "After the call", source: "interactive" }, {});
    expect(session.sendUserText).toHaveBeenCalledOnce();
  });

  describe("browser audio start cleanup", () => {
    function registerBrowserLive(startBrowserAudio: () => Promise<BrowserLiveAudio>) {
      const harness = createRegistrationHarness();
      registerOpenAILive(
        harness.pi,
        () =>
          makeResolvedConfig({
            live: { ...DEFAULT_LIVE_CONFIG, enabled: true, audio: "browser", browserPort: 18_795 },
          }),
        { startBrowserAudio, createArbiter: makeFakeArbiter().createArbiter },
      );
      return harness;
    }
    function fakeAudio(): BrowserLiveAudio & { close: Mock<() => Promise<void>> } {
      return {
        url: "http://localhost:18795/#token",
        native: {} as LiveNativeBindings,
        close: vi.fn(async () => undefined),
      };
    }

    test("closes the server when the session shuts down during the start", async () => {
      const audio = fakeAudio();
      let bind: (() => void) | undefined;
      const harness = registerBrowserLive(
        () => new Promise((resolve) => (bind = () => resolve(audio))),
      );
      const { ui } = makeFakeUi();
      const ctx = makeContext(ui);

      const run = commandFrom(harness).handler("", ctx);
      await vi.waitFor(() => expect(bind).toBeDefined());
      await harness.handlers.get("session_shutdown")?.({}, ctx);
      bind?.();
      await run;

      expect(audio.close).toHaveBeenCalledOnce();
      expect(ui.setEditorComponent).not.toHaveBeenCalled();
    });

    test("closes the server when the live UI cannot open", async () => {
      const audio = fakeAudio();
      const harness = registerBrowserLive(async () => audio);
      const { ui } = makeFakeUi();
      ui.setEditorComponent.mockImplementation(() => {
        throw new Error("UI unavailable");
      });
      const ctx = makeContext(ui);

      await expect(commandFrom(harness).handler("", ctx)).rejects.toThrow("UI unavailable");
      expect(audio.close).toHaveBeenCalledOnce();
    });
  });
});
