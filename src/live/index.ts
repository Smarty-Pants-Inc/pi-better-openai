import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { type CodexCredentials, getCodexCredentials } from "../codex-auth.ts";
import type { ResolvedConfig } from "../config.ts";
import { sanitizeDiagnosticError } from "../format.ts";
import {
  LiveSessionController,
  type LiveSessionControllerOptions,
  type LiveTranscript,
} from "./controller.ts";
import { attachFocusReporting, probeFocusReporting, type FocusTerminalHandle } from "./focus.ts";
import {
  LIVE_QUEUE_TICK_MS,
  LiveFloorArbiter,
  type LiveActivationCause,
  type LiveFloorArbiterCallbacks,
  type LiveFloorArbiterLike,
  type LiveFloorArbiterOptions,
} from "./queue.ts";
import {
  type BrowserLiveAudio,
  readOrCreateBrowserToken,
  startBrowserLiveAudio,
} from "./browser.ts";
import { liveGatewayRoot } from "./transport.ts";
import {
  decorateEditorWithLive,
  LiveVisualizer,
  LIVE_VISUALIZER_TOGGLE_KEY,
  liveKeyAction,
} from "./visualizer.ts";

export const LIVE_COMMAND = "live";
export const LIVE_DELEGATION_MESSAGE_TYPE = "better-openai-live-delegation";
export const LIVE_FOCUS_SETTLE_MS = 400;

interface LiveSessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): void;
  sendUserText(text: string): void;
  handleAgentMessage(message: unknown): void;
  handleAgentSettled(): void;
}

// An enrollment outlives any single realtime session: `/live` opens the
// visualizer and joins the cross-process queue, then the arbiter activates
// (creates the actual mic + WebRTC session) and parks (stops it) as the floor
// comes and goes. Only the floor holder runs a realtime session at all, so a
// dozen enrolled windows cost zero open connections while standby.
interface ActiveLiveRun {
  getSession(): LiveSessionRuntime | undefined;
  finishUi(result: LiveUiResult): void;
  dispose(): Promise<void>;
}

type LiveUiResult = { error?: Error };

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionRuntime;

type LiveArbiterFactory = (
  options: LiveFloorArbiterOptions,
  callbacks: LiveFloorArbiterCallbacks,
) => LiveFloorArbiterLike;

export interface LiveRegistrationDependencies {
  createSession?: LiveSessionFactory;
  createArbiter?: LiveArbiterFactory;
  probeFocusReporting?: typeof probeFocusReporting;
  attachFocusReporting?: typeof attachFocusReporting;
  notifyActivatedUnfocused?: (handle: FocusTerminalHandle, label: string) => void;
  startBrowserAudio?: (
    port: number,
    devices: { inputDevice: string; outputDevice: string },
  ) => Promise<BrowserLiveAudio>;
  tickMs?: number;
}

// eslint-disable-next-line no-control-regex -- OSC payloads must not carry raw control characters; matching them is the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

export function notifyActivatedUnfocused(handle: FocusTerminalHandle, label: string): void {
  // OSC 9 desktop toast. Reaching this branch means the mic went hot in a
  // window the user is not typing into (FIFO promotion or a vacant-floor
  // background claim), so the toast is the only signal that it happened.
  const safeLabel = label.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  try {
    handle.write(`\x1b]9;Live voice is now active in ${safeLabel}\x07`);
  } catch {
    // Notification support is optional and terminal-dependent.
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type HistoryEditor = { addToHistory?(text: string): void };

/** Pi fills a new editor's history from the session's user messages; do the same for ours. */
function sessionPrompts(ctx: ExtensionContext): string[] {
  const entries = ctx.sessionManager.getBranch?.() ?? [];
  return entries.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "user"
      ? [messageText(entry.message.content)]
      : [],
  );
}

/**
 * Finds the mounted editor so prompts typed during the call stay in its up-arrow history.
 * ponytail: Pi has no API for the restored editor instance; this walks the public
 * Container.children tree and adds only through the public addToHistory. If it finds no
 * editor, only those in-call history entries are missing.
 */
function findMountedEditor(root: Component, skip: object): HistoryEditor | undefined {
  const stack: unknown[] = [root];
  for (let visited = 0; stack.length > 0 && visited < 500; visited += 1) {
    const node = stack.pop() as (HistoryEditor & { children?: unknown }) | undefined;
    if (!node || typeof node !== "object") continue;
    if (node !== skip && typeof node.addToHistory === "function") return node;
    if (Array.isArray(node.children)) stack.push(...(node.children as unknown[]));
  }
  return undefined;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export type LiveProviderRoute = {
  baseUrl: string;
  getCredentials(): Promise<CodexCredentials | undefined>;
};

/**
 * Routes live traffic through a configured pi provider (for example CLIProxyAPI)
 * using that provider's base URL and API key. The gateway owns ChatGPT OAuth and
 * account selection, so the account ID stays empty.
 */
export function resolveLiveProviderRoute(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  provider: string,
): LiveProviderRoute {
  const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
  if (!model?.baseUrl) {
    throw new Error(`Live provider "${provider}" has no model with a base URL in pi.`);
  }
  return {
    baseUrl: liveGatewayRoot(model.baseUrl),
    getCredentials: async () => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
      return apiKey ? { accessToken: apiKey, accountId: "" } : undefined;
    },
  };
}

export function registerOpenAILive(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
  dependencies: LiveRegistrationDependencies = {},
): { isActive(): boolean; stop(): Promise<void> } {
  const createSession =
    dependencies.createSession ?? ((options) => new LiveSessionController(options));
  const createArbiter: LiveArbiterFactory =
    dependencies.createArbiter ??
    ((options, callbacks) => new LiveFloorArbiter(options, callbacks));
  const probeFocus = dependencies.probeFocusReporting ?? probeFocusReporting;
  const attachFocus = dependencies.attachFocusReporting ?? attachFocusReporting;
  const notifyUnfocused = dependencies.notifyActivatedUnfocused ?? notifyActivatedUnfocused;
  const startBrowserAudio =
    dependencies.startBrowserAudio ??
    ((port, devices) =>
      startBrowserLiveAudio({ port, token: readOrCreateBrowserToken(), ...devices }));
  const tickMs = dependencies.tickMs ?? LIVE_QUEUE_TICK_MS;
  let activeRun: ActiveLiveRun | undefined;
  let settling: Promise<void> | undefined;
  let shutdowns = 0;

  async function stopActive(): Promise<void> {
    const run = activeRun;
    if (!run) {
      if (settling) await settling;
      return;
    }
    run.finishUi({});
    await run.dispose();
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Live voice requires interactive TUI mode.", "warning");
      return;
    }
    const cfg = getConfig(ctx);
    if (!cfg.live.enabled) {
      ctx.ui.notify("Live voice is disabled. Enable it in /openai-settings.", "warning");
      return;
    }
    if (settling) await settling;

    const shutdownsAtStart = shutdowns;
    let route: LiveProviderRoute | undefined;
    let browserAudio: BrowserLiveAudio | undefined;
    try {
      if (cfg.live.provider) route = resolveLiveProviderRoute(ctx, cfg.live.provider);
      if (cfg.live.audio === "browser") {
        browserAudio = await startBrowserAudio(cfg.live.browserPort, {
          inputDevice: cfg.live.inputDevice,
          outputDevice: cfg.live.outputDevice,
        });
      }
    } catch (cause) {
      const message = errorFrom(cause).message;
      ctx.ui.notify(sanitizeDiagnosticError(`Live voice could not start: ${message}`), "error");
      return;
    }
    // The server binds before any run exists, so session_shutdown cannot reach it yet.
    if (shutdowns !== shutdownsAtStart) {
      await browserAudio?.close().catch(() => undefined);
      return;
    }
    if (browserAudio) {
      ctx.ui.notify(
        `Live audio page: ${browserAudio.url} (remote pi: ssh -L ${cfg.live.browserPort}:127.0.0.1:${cfg.live.browserPort})`,
        "info",
      );
    }

    let ownRun = undefined as ActiveLiveRun | undefined;
    let done: (result: LiveUiResult) => void = () => undefined;
    const ui = new Promise<LiveUiResult>((resolve) => (done = resolve));
    let removeKeys: (() => void) | undefined;
    // The status sits on the editor's bottom border: the call adds no rows and Pi's editor keeps
    // the keyboard. startRun runs once, from the first editor the factory builds.
    const startRun = (tui: TUI): LiveVisualizer => {
      let completed = false;
      let disposed = false;
      let session: LiveSessionRuntime | undefined;
      let sessionParked = false;
      let arbiter: LiveFloorArbiterLike | undefined;
      let tickInterval: NodeJS.Timeout | undefined;
      let focusDebounce: NodeJS.Timeout | undefined;
      let disposeFocus: (() => void) | undefined;

      const finishUi = (value: LiveUiResult) => {
        if (completed) return;
        completed = true;
        done(value);
      };

      const visualizer = new LiveVisualizer({
        theme: ctx.ui.theme,
        requestRender: () => tui.requestRender(),
      });
      visualizer.setPhase("standby");
      removeKeys = ctx.ui.onTerminalInput((data) => {
        const action = liveKeyAction(data, ctx.ui.getEditorText() === "");
        if (action === "mute") session?.toggleMute();
        else if (action === "stop") finishUi({});
        return action ? { consume: true } : undefined;
      });

      const terminalHandle: FocusTerminalHandle = {
        write: (data) => tui.terminal.write(data),
        addInputListener: (listener) => tui.addInputListener(listener),
      };

      const parkSession = () => {
        const current = session;
        session = undefined;
        sessionParked = true;
        visualizer.setPhase("standby");
        visualizer.setTranscript(undefined);
        if (current) void current.stop().catch(() => undefined);
      };

      const activateSession = () => {
        if (completed || session) return;
        sessionParked = false;
        const created = createSession({
          sessionId: ctx.sessionManager.getSessionId(),
          voice: cfg.live.voice,
          getCredentials: route?.getCredentials ?? ((signal) => getCodexCredentials(ctx, signal)),
          ...(route ? { baseUrl: route.baseUrl } : {}),
          ...(browserAudio ? { native: browserAudio.native } : {}),
          delegate: (request) => {
            pi.sendMessage(
              {
                customType: LIVE_DELEGATION_MESSAGE_TYPE,
                content: request,
                display: true,
                details: { source: "live" },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          },
          callbacks: {
            onPhase: (phase) => visualizer.setPhase(phase),
            onLevels: (input) => visualizer.setInputLevel(input),
            onTranscript: (transcript: LiveTranscript | undefined) =>
              visualizer.setTranscript(transcript),
            onTerminal: (error) => {
              if (sessionParked) return;
              finishUi(error ? { error } : {});
            },
          },
        });
        session = created;
        setImmediate(() => {
          if (session !== created) return;
          void created.start().catch((cause) => {
            finishUi({ error: errorFrom(cause) });
          });
        });
      };

      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        if (focusDebounce) clearTimeout(focusDebounce);
        if (tickInterval) clearInterval(tickInterval);
        disposeFocus?.();
        arbiter?.leave();
        const current = session;
        session = undefined;
        if (current) await current.stop().catch(() => undefined);
        await browserAudio?.close().catch(() => undefined);
      };

      const run: ActiveLiveRun = {
        getSession: () => session,
        finishUi,
        dispose,
      };
      activeRun = run;
      ownRun = run;

      setImmediate(() => {
        void (async () => {
          try {
            const focusSupported = await probeFocus(terminalHandle);
            if (completed) return;
            const enrolled = createArbiter(
              {
                pid: process.pid,
                sessionId: ctx.sessionManager.getSessionId(),
                cwd: ctx.cwd,
                policy: focusSupported ? "focus" : "fifo",
              },
              {
                onActivated: (cause: LiveActivationCause) => {
                  if (cause !== "focus") notifyUnfocused(terminalHandle, enrolled.label);
                  activateSession();
                },
                onDeactivated: parkSession,
              },
            );
            arbiter = enrolled;
            enrolled.join();
            tickInterval = setInterval(() => {
              try {
                enrolled.tick();
              } catch {
                // A failing tick must not tear down the enrollment.
              }
            }, tickMs);
            tickInterval.unref?.();
            if (!focusSupported) return;
            disposeFocus = attachFocus(terminalHandle, (focused) => {
              if (focusDebounce) clearTimeout(focusDebounce);
              if (!focused) {
                enrolled.setFocused(false);
                return;
              }
              // Debounce focus-in so window-manager focus flicker does not flap
              // floor ownership between two live windows.
              focusDebounce = setTimeout(() => {
                focusDebounce = undefined;
                try {
                  enrolled.setFocused(true);
                } catch {
                  // Focus edges are advisory; a lost race settles next tick.
                }
              }, LIVE_FOCUS_SETTLE_MS);
              focusDebounce.unref?.();
            });
          } catch (cause) {
            finishUi({ error: errorFrom(cause) });
          }
        })();
      });
      return visualizer;
    };

    let visualizer: LiveVisualizer | undefined;
    let liveTui: TUI | undefined;
    let liveEditor: object | undefined;
    let undecorate: (() => void) | undefined;
    const inCallPrompts: string[] = [];
    const previousEditor = ctx.ui.getEditorComponent();
    // Wrap whatever editor is installed (Pi's default or another extension's) and restore it on stop.
    const liveEditorFactory: EditorFactory = (tui, editorTheme, keybindings) => {
      const editor =
        previousEditor?.(tui, editorTheme, keybindings) ??
        new CustomEditor(tui, editorTheme, keybindings, { embedWorkingStatus: true });
      for (const prompt of sessionPrompts(ctx)) editor.addToHistory?.(prompt);
      const addToHistory = editor.addToHistory?.bind(editor);
      if (addToHistory) {
        editor.addToHistory = (text) => {
          inCallPrompts.push(text);
          addToHistory(text);
        };
      }
      visualizer ??= startRun(tui);
      liveTui = tui;
      liveEditor = editor;
      undecorate?.();
      undecorate = decorateEditorWithLive(
        editor,
        (width) => visualizer?.renderSegment(width) ?? "",
      );
      return editor;
    };
    const restoreEditor = () => {
      undecorate?.();
      undecorate = undefined;
      if (ctx.ui.getEditorComponent() !== liveEditorFactory) return;
      ctx.ui.setEditorComponent(previousEditor);
      const restored = liveTui && liveEditor ? findMountedEditor(liveTui, liveEditor) : undefined;
      for (const prompt of inCallPrompts) restored?.addToHistory?.(prompt);
    };
    try {
      ctx.ui.setEditorComponent(liveEditorFactory);
    } catch (cause) {
      removeKeys?.();
      visualizer?.dispose();
      await (ownRun?.dispose() ?? browserAudio?.close())?.catch(() => undefined);
      if (activeRun === ownRun) activeRun = undefined;
      throw cause;
    }

    // The call runs in the background; the command returns so Pi keeps taking input.
    // dispose() is idempotent and closes the browser server.
    void ui.then(async (result) => {
      visualizer?.dispose();
      try {
        removeKeys?.();
        restoreEditor();
      } catch {
        // Pi may already have torn down this context's UI on shutdown.
      }
      const run = ownRun;
      if (!run) {
        await browserAudio?.close().catch(() => undefined);
        return;
      }
      const cleanup = run.dispose().catch(() => undefined);
      settling = cleanup;
      await cleanup;
      if (activeRun === run) activeRun = undefined;
      if (settling === cleanup) settling = undefined;
      if (result.error) {
        const message = `${result.error.message} Run /live or press Ctrl+Shift+L to start a new call.`;
        ctx.ui.notify(sanitizeDiagnosticError(message), "error");
      }
    });
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (activeRun) {
      activeRun.finishUi({});
      return;
    }
    await start(ctx);
  }

  pi.registerMessageRenderer(LIVE_DELEGATION_MESSAGE_TYPE, (message, _options, theme) => {
    const text = messageText(message.content).trim();
    const label = theme.fg("accent", theme.bold("Live request"));
    return new Text(`${label}\n${theme.fg("customMessageText", text)}`, 1, 0);
  });

  pi.registerCommand(LIVE_COMMAND, {
    description: "Start or stop Codex-backed realtime voice mode",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "error");
        return;
      }
      await toggle(ctx);
    },
  });

  pi.registerShortcut(LIVE_VISUALIZER_TOGGLE_KEY, {
    description: "Start or stop Better OpenAI live voice mode",
    handler: toggle,
  });

  // Typed text goes to Pi as a normal user message and, during a call, into the voice context.
  pi.on("input", (event) => {
    if (event.source === "interactive") activeRun?.getSession()?.sendUserText(event.text);
    return { action: "continue" };
  });

  pi.on("message_end", (event) => {
    activeRun?.getSession()?.handleAgentMessage(event.message);
  });

  pi.on("agent_settled", () => {
    activeRun?.getSession()?.handleAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    shutdowns += 1;
    await stopActive();
    activeRun = undefined;
  });

  return {
    isActive: () => activeRun !== undefined || settling !== undefined,
    stop: stopActive,
  };
}
