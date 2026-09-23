import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LivePhase } from "../src/live/controller.ts";
import {
  decorateEditorWithLive,
  embedInBorder,
  LiveVisualizer,
  liveKeyAction,
} from "../src/live/visualizer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const plainBorder = (text: string) => text;

afterEach(() => {
  vi.useRealTimers();
});

function makeEditor(text = "hello"): Editor {
  const tui = { terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI;
  const editor = new Editor(tui, { borderColor: plainBorder, selectList: {} as never });
  editor.setText(text);
  return editor;
}

function makeCall(phase: LivePhase = "listening"): LiveVisualizer {
  const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
  visualizer.setPhase(phase);
  visualizer.setTranscript({
    role: "user",
    text: "can you check the build on dev two",
    turn: 1,
    final: true,
  });
  visualizer.setTranscript({
    role: "assistant",
    text: "sure, the build finished green a minute ago",
    turn: 1,
    final: false,
  });
  return visualizer;
}

describe("live status on the editor border", () => {
  test.each([80, 120, 200])("keeps the editor's rows and width at %i columns", (width) => {
    const editor = makeEditor();
    const base = editor.render(width);
    const visualizer = makeCall();
    try {
      decorateEditorWithLive(editor, (maxWidth) => visualizer.renderSegment(maxWidth));
      const lines = editor.render(width);
      expect(lines).toHaveLength(base.length);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(visibleWidth(lines[0]!)).toBe(width);
      // Only the top border changes; text, cursor, paste markers, and autocomplete rows do not.
      expect(lines.slice(1)).toEqual(base.slice(1));
      expect(lines[0]).toMatch(/^──/);
      expect(lines[0]).toMatch(/─$/);
      expect(lines[0]).toContain("listening");
      expect(lines[0]).toContain("you › ");
      expect(lines[0]).toContain("live › ");
      // The newest speaker renders last and keeps its latest words.
      expect(lines[0]!.indexOf("live › ")).toBeGreaterThan(lines[0]!.indexOf("you › "));
      expect(lines[0]).toContain("minute ago");
    } finally {
      visualizer.dispose();
    }
  });

  test("drops the transcript, then the phase label, and never overflows", () => {
    const visualizer = makeCall("speaking");
    try {
      for (let width = 0; width <= 200; width += 1) {
        const line = embedInBorder(
          "─".repeat(width),
          width,
          (max) => visualizer.renderSegment(max),
          plainBorder,
        );
        expect(visibleWidth(line)).toBe(width);
      }
      const at = (width: number) =>
        embedInBorder(
          "─".repeat(width),
          width,
          (max) => visualizer.renderSegment(max),
          plainBorder,
        );
      expect(at(40)).toContain("live › ");
      expect(at(40)).not.toContain("you › ");
      expect(at(24)).toContain("speaking");
      expect(at(24)).not.toContain("›");
      expect(at(14)).toContain("»");
      expect(at(14)).not.toContain("speaking");
    } finally {
      visualizer.dispose();
    }
  });

  test("shows key hints until someone speaks, and the mute state", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setPhase("muted");
      const segment = visualizer.renderSegment(78);
      expect(segment).toContain("× muted · space mute · esc end");
      visualizer.setTranscript({ role: "user", text: "hi", turn: 1, final: true });
      expect(visualizer.renderSegment(78)).toContain("muted · you › hi");
      visualizer.setTranscript(undefined);
      expect(visualizer.renderSegment(78)).toContain("space mute");
    } finally {
      visualizer.dispose();
    }
  });

  test("keeps Pi's working indicator and scroll label on the border", () => {
    const visualizer = makeCall();
    try {
      const busy = `── ⠋ Working... ${"─".repeat(64)}`;
      const line = embedInBorder(busy, 80, (max) => visualizer.renderSegment(max), plainBorder);
      expect(line.startsWith("── ⠋ Working... ─")).toBe(true);
      expect(visibleWidth(line)).toBe(80);
      expect(line).toContain("listening");
      // Too little room leaves the editor's border untouched.
      const crowded = `── ${"x".repeat(74)} ──`;
      expect(embedInBorder(crowded, 80, (max) => visualizer.renderSegment(max), plainBorder)).toBe(
        crowded,
      );
    } finally {
      visualizer.dispose();
    }
  });

  test("removing the decoration restores the exact editor render", () => {
    const editor = makeEditor();
    const base = editor.render(80);
    const visualizer = makeCall();
    try {
      const remove = decorateEditorWithLive(editor, (max) => visualizer.renderSegment(max));
      expect(editor.render(80)).not.toEqual(base);
      remove();
      expect(editor.render(80)).toEqual(base);
      expect(Object.prototype.hasOwnProperty.call(editor, "render")).toBe(false);
    } finally {
      visualizer.dispose();
    }
  });

  test("sanitizes transcript control sequences", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setTranscript({
        role: "assistant",
        text: "\u001b[31mhello\u001b[0m\tthere",
        turn: 1,
        final: false,
      });
      const rendered = visualizer.renderSegment(80);
      expect(rendered).toContain("live › hello there");
      expect(rendered).not.toContain("\u001b[31m");
    } finally {
      visualizer.dispose();
    }
  });

  test("Space mutes and Esc ends the call only while the editor is empty", () => {
    expect(liveKeyAction(" ", true)).toBe("mute");
    expect(liveKeyAction("\u001b", true)).toBe("stop");
    expect(liveKeyAction(" ", false)).toBeUndefined();
    expect(liveKeyAction("\u001b", false)).toBeUndefined();
    expect(liveKeyAction("a", true)).toBeUndefined();
    expect(liveKeyAction("\r", true)).toBeUndefined();
    // Ctrl+C and Ctrl+Shift+L stay with Pi; the registered shortcut toggles the call.
    expect(liveKeyAction("\u0003", true)).toBeUndefined();
    expect(liveKeyAction("\u001b[108;6u", true)).toBeUndefined();
  });

  test("renders about 10 times a second, only on visible change, and stops on dispose", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const visualizer = new LiveVisualizer({ theme, requestRender });
    visualizer.setPhase("muted");
    vi.advanceTimersByTime(100);
    requestRender.mockClear();
    // Muted and silent: the waveform is flat, so ticks request nothing.
    vi.advanceTimersByTime(1_000);
    expect(requestRender).not.toHaveBeenCalled();

    visualizer.setPhase("listening");
    visualizer.setInputLevel(0.5);
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender.mock.calls.length).toBeGreaterThan(0);
    expect(requestRender.mock.calls.length).toBeLessThanOrEqual(10);
    visualizer.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
