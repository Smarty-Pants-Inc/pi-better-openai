import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LivePhase } from "../src/live/controller.ts";
import {
  decorateEditorWithLive,
  embedInBorder,
  LiveVisualizer,
  liveKeyAction,
  liveSegmentWidth,
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
  test.each([60, 80, 120, 200])("changes only the bottom border at %i columns", (width) => {
    const editor = makeEditor();
    const base = editor.render(width);
    const visualizer = makeCall();
    try {
      decorateEditorWithLive(editor, (maxWidth) => visualizer.renderSegment(maxWidth));
      const lines = editor.render(width);
      expect(lines).toHaveLength(base.length);
      // Only the last line changes; the top border (Pi's working indicator), text, and cursor do not.
      expect(lines.slice(0, -1)).toEqual(base.slice(0, -1));
      const bottom = lines.at(-1)!;
      expect(visibleWidth(bottom)).toBe(width);
      const segmentWidth = liveSegmentWidth(width);
      expect(bottom.slice(0, width - segmentWidth - 1)).toBe("─".repeat(width - segmentWidth - 1));
      expect(bottom).toMatch(/ ─$/);
      // One speaker at a time: the newest speaker only.
      expect(bottom).toContain("agent: ");
      expect(bottom).not.toContain("you: ");
    } finally {
      visualizer.dispose();
    }
  });

  test.each([60, 80, 120, 200])(
    "keeps a fixed width as speech streams in at %i columns",
    (width) => {
      const editor = makeEditor();
      const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
      try {
        visualizer.setPhase("speaking");
        decorateEditorWithLive(editor, (maxWidth) => visualizer.renderSegment(maxWidth));
        const words = "sure the build on dev two finished green about a minute ago".split(" ");
        const starts = new Set<number>();
        for (let count = 1; count <= words.length; count += 1) {
          const text = words.slice(0, count).join(" ");
          visualizer.setTranscript({ role: "assistant", text, turn: 1, final: false });
          const bottom = editor.render(width).at(-1)!;
          expect(visibleWidth(bottom)).toBe(width);
          starts.add(bottom.search(/[^─]/));
          expect(bottom).toContain(words[count - 1]);
        }
        expect([...starts]).toEqual([width - liveSegmentWidth(width) - 1]);
      } finally {
        visualizer.dispose();
      }
    },
  );

  test("the segment is about 40 columns, at most 45% of the terminal", () => {
    expect(liveSegmentWidth(60)).toBe(27);
    expect(liveSegmentWidth(80)).toBe(36);
    expect(liveSegmentWidth(120)).toBe(40);
    expect(liveSegmentWidth(200)).toBe(40);
  });

  test("truncates long speech on the left and shows its newest words", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setPhase("speaking");
      visualizer.setTranscript({
        role: "assistant",
        text: "the first words scroll away while the newest words stay visible",
        turn: 1,
        final: false,
      });
      const segment = visualizer.renderSegment(40);
      expect(visibleWidth(segment)).toBe(40);
      expect(segment.endsWith("agent: …st words stay visible ")).toBe(true);
      expect(segment).not.toContain("first words");
    } finally {
      visualizer.dispose();
    }
  });

  test("shows only the current speaker", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setPhase("listening");
      visualizer.setTranscript({ role: "user", text: "check the build", turn: 1, final: false });
      let segment = visualizer.renderSegment(40);
      expect(segment).toContain("you: check the build");
      expect(segment).not.toContain("agent:");

      visualizer.setPhase("speaking");
      visualizer.setTranscript({ role: "assistant", text: "it is green", turn: 1, final: false });
      segment = visualizer.renderSegment(40);
      expect(segment).toContain("agent: it is green");
      expect(segment).not.toContain("you:");

      // A late final user transcript does not replace the voice's words while it speaks.
      visualizer.setTranscript({ role: "user", text: "check the build?", turn: 1, final: true });
      expect(visualizer.renderSegment(40)).toContain("agent: it is green");

      visualizer.setPhase("listening");
      visualizer.setTranscript({ role: "user", text: "thanks", turn: 2, final: false });
      segment = visualizer.renderSegment(40);
      expect(segment).toContain("you: thanks");
      expect(segment).not.toContain("agent:");
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
      for (let width = 3; width <= 60; width += 1) {
        expect(visibleWidth(visualizer.renderSegment(width))).toBe(width);
      }
      expect(visualizer.renderSegment(24)).toContain("agent: ");
      expect(visualizer.renderSegment(20)).toContain("speaking");
      expect(visualizer.renderSegment(20)).not.toContain("›");
      expect(visualizer.renderSegment(12)).toContain("»");
      expect(visualizer.renderSegment(12)).not.toContain("speaking");
    } finally {
      visualizer.dispose();
    }
  });

  test("shows key hints until someone speaks, and the mute state", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setPhase("muted");
      expect(visualizer.renderSegment(40)).toContain("× muted · space mute · esc end");
      visualizer.setTranscript({ role: "user", text: "hi", turn: 1, final: true });
      expect(visualizer.renderSegment(40)).toContain("× you: hi");
      visualizer.setTranscript(undefined);
      expect(visualizer.renderSegment(40)).toContain("space mute");
    } finally {
      visualizer.dispose();
    }
  });

  test("keeps the scroll label, and leaves a line of unexpected shape unchanged", () => {
    const visualizer = makeCall();
    try {
      const scrolled = `${"─".repeat(10)} ↓ 3 more ${"─".repeat(60)}`;
      const line = embedInBorder(scrolled, 80, (max) => visualizer.renderSegment(max), plainBorder);
      expect(line.startsWith(`${"─".repeat(10)} ↓ 3 more ─`)).toBe(true);
      expect(visibleWidth(line)).toBe(80);
      expect(line).toContain("agent: ");
      const crowded = `── ${"x".repeat(74)} ──`;
      expect(embedInBorder(crowded, 80, (max) => visualizer.renderSegment(max), plainBorder)).toBe(
        crowded,
      );
      const row = `  /model ${" ".repeat(71)}`;
      expect(embedInBorder(row, 80, (max) => visualizer.renderSegment(max), plainBorder)).toBe(row);
    } finally {
      visualizer.dispose();
    }
  });

  test("finds the bottom border above autocomplete rows", () => {
    const rows = ["─".repeat(80), "hello", "─".repeat(80), "  /model", "  /live"];
    const editor = {
      renderedAutocompleteHeight: 2,
      render: (_width: number) => rows,
      invalidate() {},
    };
    const visualizer = makeCall();
    try {
      decorateEditorWithLive(editor, (max) => visualizer.renderSegment(max));
      const lines = editor.render(80);
      expect(lines).toHaveLength(rows.length);
      expect(lines[2]).not.toBe(rows[2]);
      expect(lines[2]).toContain("agent: ");
      expect([lines[0], lines[1], lines[3], lines[4]]).toEqual([
        rows[0],
        rows[1],
        rows[3],
        rows[4],
      ]);
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
      expect(rendered).toContain("agent: hello there");
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

describe("live status: speaker switch and levels", () => {
  test("switches to 'you: …' as soon as the user is audibly speaking", () => {
    const visualizer = new LiveVisualizer({ theme, requestRender: vi.fn() });
    try {
      visualizer.setPhase("listening");
      visualizer.setTranscript({ role: "assistant", text: "what's next?", turn: 1, final: true });
      expect(visualizer.renderSegment(40)).toContain("agent: what's next?");
      visualizer.setLevels(0.2, 0); // one sample is not enough (no flicker)
      expect(visualizer.renderSegment(40)).toContain("agent: ");
      visualizer.setLevels(0.2, 0);
      expect(visualizer.renderSegment(40)).toContain("you: …");
      visualizer.setTranscript({ role: "user", text: "run the tests", turn: 2, final: false });
      expect(visualizer.renderSegment(40)).toContain("you: run the tests");
      // Room noise does not switch it.
      visualizer.setLevels(0.01, 0);
      visualizer.setLevels(0.01, 0);
      expect(visualizer.renderSegment(40)).toContain("you: run the tests");
    } finally {
      visualizer.dispose();
    }
  });
});
