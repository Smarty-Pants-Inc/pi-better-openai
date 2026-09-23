import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LiveVisualizer, liveKeyAction } from "../src/live/visualizer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveVisualizer", () => {
  test("renders a fixed five-row panel at every supplied width", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      for (const width of [0, 1, 2, 40, 80, 140, 200]) {
        const lines = visualizer.render(width);
        expect(lines).toHaveLength(5);
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
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
      const rendered = visualizer.render(50).join("\n");
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

  test("animates through requestRender and stops its timer on dispose", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const visualizer = new LiveVisualizer({ theme, requestRender });
    const initialConnectingFrame = visualizer.render(80);
    requestRender.mockClear();
    vi.advanceTimersByTime(80);
    expect(visualizer.render(80)).not.toEqual(initialConnectingFrame);
    visualizer.setInputLevel(0.5);
    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(4);
    visualizer.dispose();
    vi.advanceTimersByTime(240);
    expect(requestRender).toHaveBeenCalledTimes(4);
  });
});
