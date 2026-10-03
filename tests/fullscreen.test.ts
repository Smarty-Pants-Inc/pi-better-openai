import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Image,
  TuiAltScreen,
  setCapabilities,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { combineInlinePetFooter } from "../src/footer-layout.ts";
import { registerOpenAIImage } from "../src/image.ts";
import { CodexPetKittyManager } from "../src/pets.ts";
import { makeResolvedConfig } from "./helpers.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const renderers: TuiAltScreen[] = [];

function fullscreen(component: Component) {
  const writes: string[] = [];
  const terminal = {
    columns: 80,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    drainInput: async () => {},
    write: (text: string) => writes.push(text),
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  renderers.push(tui);
  tui.setLayoutRoot(component);
  tui.start();
  tui.renderNow();
  return { tui, terminal, writes };
}

afterEach(() => {
  for (const tui of renderers.splice(0)) tui.stop();
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

test("fullscreen redraws and resizes Kitty images without losing placement", () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const image = new Image(
    "AAAA",
    "image/png",
    { fallbackColor: (text) => text },
    { maxWidthCells: 20, maxHeightCells: 4 },
    { widthPx: 40, heightPx: 40 },
  );
  const { tui, terminal, writes } = fullscreen(image);
  expect(writes.join("")).toContain("\x1b_G");
  expect(writes.join("")).toContain("a=T");
  writes.length = 0;
  tui.renderNow(true);
  expect(writes.join("")).toContain("a=p");
  writes.length = 0;
  terminal.columns = 40;
  image.invalidate();
  tui.renderNow();
  expect(writes.join("")).toContain("\x1b_G");
  expect(tui.getScreenLines()).toHaveLength(30);
});

test.each(["inline-left", "inline-right"] as const)(
  "fullscreen preserves %s raw pet uploads and balanced cursor movement",
  (placement) => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const manager = new CodexPetKittyManager(700001);
    const petLines = manager.renderFrame(
      {
        kittyImageId: 700002,
        rawRgbaData: "AAAA/w==",
        mimeType: "image/png",
        widthPx: 1,
        heightPx: 1,
        durationMs: 100,
      },
      80,
      { sizeCells: 4 },
    );
    const lines = combineInlinePetFooter(petLines, ["path", "stats"], 80, placement, 4);
    const { tui, writes } = fullscreen({ render: () => lines, invalidate() {} });
    expect(writes.join("")).toContain("a=t");
    expect(writes.join("")).toContain("i=700002");
    expect(writes.join("")).toContain("C=1");
    writes.length = 0;
    tui.renderNow(true);
    expect(writes.join("")).toContain("a=t");
    expect(lines.join("")).toContain("\x1b[1A");
    expect(lines.join("")).toContain("\x1b[1B");
  },
);

test.each([null, "iterm2"] as const)(
  "openai-image message renderer keeps its fullscreen text fallback (%s)",
  (images) => {
    setCapabilities({ images, trueColor: true, hyperlinks: false });
    type Renderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
    let renderer: Renderer | undefined;
    const pi = {
      registerMessageRenderer: (_name: string, callback: Renderer) => {
        renderer = callback;
      },
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    registerOpenAIImage(pi, () => makeResolvedConfig());
    if (!renderer) throw new Error("Missing openai-image renderer");
    const component = renderer(
      {
        role: "custom",
        customType: "openai-image",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        display: true,
        timestamp: 0,
      },
      { expanded: false, outputPad: 0 },
      theme as Parameters<Renderer>[2],
    );
    if (!component) throw new Error("Missing image component");
    const { tui } = fullscreen(component);
    expect(tui.getScreenLines().join("\n")).toContain("[openai-image]");
    expect(tui.getScreenLines().join("\n")).toContain("[Image");
  },
);
