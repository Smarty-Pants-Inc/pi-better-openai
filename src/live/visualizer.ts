import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { LivePhase, LiveTranscript } from "./controller.ts";

// About 10 Hz; a tick requests a render only when the waveform or spinner visibly changes.
const ANIMATION_INTERVAL_MS = 100;
const LIVE_TOGGLE_KEY = Key.ctrlShift("l");
// SGR plus OSC/APC strings (Pi's cursor marker is an APC); none of them take columns.
const ANSI_ESCAPE_REGEXP = new RegExp(
  String.raw`\u001B\[[0-?]*[ -/]*[@-~]|\u001B[\]_][^\u0007\u001B]*(?:\u0007|\u001B\\)`,
  "g",
);
const WAVE_WIDTH = 6;
const SEPARATOR = " · ";
const HINTS = "space mute · esc end";
/** The transcript is shown only with at least this many text columns. */
const MIN_TRANSCRIPT_COLUMNS = 6;
/** The segment has a fixed width, so it does not jitter while words stream in. */
const SEGMENT_COLUMNS = 40;
const SEGMENT_MAX_SHARE = 0.45;

/** The fixed segment width for a border `width` columns wide. */
export function liveSegmentWidth(width: number): number {
  return Math.max(0, Math.min(SEGMENT_COLUMNS, Math.floor(width * SEGMENT_MAX_SHARE)));
}

export interface LiveVisualizerOptions {
  theme: Theme;
  requestRender(): void;
}

/**
 * The live status is drawn on the editor border, so Pi's editor keeps the keyboard. Space and Esc
 * control the call only while the editor is empty; otherwise they reach the editor as usual.
 */
export function liveKeyAction(data: string, editorEmpty: boolean): "mute" | "stop" | undefined {
  if (!editorEmpty) return undefined;
  if (matchesKey(data, Key.space)) return "mute";
  if (matchesKey(data, Key.escape)) return "stop";
  return undefined;
}

function sanitizeTranscript(text: string): string {
  const withoutAnsi = text.replace(ANSI_ESCAPE_REGEXP, "");
  let safe = "";
  for (const character of withoutAnsi) {
    const code = character.charCodeAt(0);
    safe += code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }
  return safe.replace(/\s+/g, " ").trim();
}

function truncateFromStart(text: string, width: number): string {
  if (width <= 0) return "";
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text;
  if (width === 1) return "…";
  return `…${sliceByColumn(text, textWidth - width + 1, width - 1, true)}`;
}

type TranscriptSide = { role: LiveTranscript["role"]; text: string; final?: boolean };

const TRANSCRIPT_LABELS: Record<LiveTranscript["role"], string> = {
  user: "you: ",
  assistant: "agent: ",
};

/** Each side's color (theme tokens, so it follows /theme): label, meter, and text. */
export const SIDE_COLORS: Record<LiveTranscript["role"], ThemeColor> = {
  user: "accent",
  assistant: "borderAccent",
};

/** Microphone RMS that counts as the user speaking (the barge-in level). */
const USER_SPEECH_LEVEL = 0.04;

const STATIC_ICONS: Record<LivePhase, string> = {
  standby: "◌",
  connecting: "○",
  listening: "●",
  working: "○",
  speaking: "»",
  muted: "×",
  error: "!",
};

const PHASE_COLORS: Record<LivePhase, ThemeColor> = {
  standby: "dim",
  connecting: "dim",
  listening: "success",
  working: "warning",
  speaking: "accent",
  muted: "dim",
  error: "error",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WAVE_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Live call state (phase, microphone level, the current speaker's latest words) rendered as one
 * fixed-width, right-aligned segment for the editor's bottom border. It adds no rows to Pi's layout.
 */
export class LiveVisualizer {
  readonly #options: LiveVisualizerOptions;
  #phase: LivePhase = "connecting";
  #inputLevel = 0;
  #displayLevel = 0;
  #loudSamples = 0;
  #frame = 0;
  /** Latest text per side, oldest first; the last entry is the most recent speaker. */
  #transcripts: TranscriptSide[] = [];
  #animationInterval: NodeJS.Timeout | undefined;
  #lastAnimation = "";

  constructor(options: LiveVisualizerOptions) {
    this.#options = options;
    this.#animationInterval = setInterval(() => {
      this.#frame += 1;
      const decayed = this.#displayLevel * 0.84;
      this.#displayLevel = Math.max(this.#inputLevel, decayed < 0.001 ? 0 : decayed);
      const animation = this.#renderWave() + this.#renderIcon();
      if (animation === this.#lastAnimation) return;
      this.#lastAnimation = animation;
      this.#options.requestRender();
    }, ANIMATION_INTERVAL_MS);
    this.#animationInterval.unref?.();
  }

  setPhase(phase: LivePhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#options.requestRender();
  }

  /**
   * Live levels: the meter shows the louder of the microphone and the voice. Two samples of
   * audible user speech put "you: …" on the status at once, before any transcript arrives.
   */
  setLevels(input: number, output: number): void {
    const microphone = Number.isFinite(input) ? input : 0;
    const speaking =
      microphone >= USER_SPEECH_LEVEL && microphone >= (Number.isFinite(output) ? output : 0);
    this.#loudSamples = speaking ? this.#loudSamples + 1 : 0;
    if (this.#loudSamples === 2 && this.#phase !== "speaking") this.#userStartedSpeaking();
    this.setInputLevel(Math.max(microphone, Number.isFinite(output) ? output : 0));
  }

  #userStartedSpeaking(): void {
    const user = this.#transcripts.find((side) => side.role === "user");
    if (this.#transcripts.at(-1)?.role === "user" && user && !user.final) return;
    const others = this.#transcripts.filter((side) => side.role !== "user");
    this.#transcripts = [...others, { role: "user", text: "" }];
    this.#options.requestRender();
  }

  setInputLevel(level: number): void {
    const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (this.#inputLevel === next) return;
    this.#inputLevel = next;
    if (next > this.#displayLevel) this.#displayLevel = next;
    this.#options.requestRender();
  }

  /** `undefined` clears both sides (a new or parked session). */
  setTranscript(transcript: LiveTranscript | undefined): void {
    if (!transcript) {
      if (this.#transcripts.length === 0) return;
      this.#transcripts = [];
      this.#options.requestRender();
      return;
    }
    const text = sanitizeTranscript(transcript.text);
    const latest = this.#transcripts.at(-1);
    if (
      latest?.role === transcript.role &&
      latest.text === text &&
      latest.final === transcript.final
    )
      return;
    const others = this.#transcripts.filter((side) => side.role !== transcript.role);
    this.#transcripts = text
      ? [...others, { role: transcript.role, text, final: transcript.final }]
      : others;
    this.#options.requestRender();
  }

  dispose(): void {
    if (!this.#animationInterval) return;
    clearInterval(this.#animationInterval);
    this.#animationInterval = undefined;
  }

  /**
   * One segment of exactly `width` columns: one space on each side, content left-aligned, then
   * space padding. With a transcript it shows the waveform, the phase icon, and the tail of the
   * current speaker's words; otherwise the phase label and key hints. When space runs out it drops
   * the transcript or key hints, then the phase label, then the waveform.
   */
  renderSegment(width: number): string {
    if (width < 3) return "";
    const theme = this.#options.theme;
    const inner = width - 2;
    const icon = this.#renderIcon();
    const current = this.#currentTranscript();
    const wave = this.#renderWave(current ? SIDE_COLORS[current.role] : undefined);
    const head = `${wave} ${icon}`;
    const headWidth = WAVE_WIDTH + 2;
    const phase = `${head} ${theme.fg(PHASE_COLORS[this.#phase], this.#phase)}`;
    const phaseWidth = headWidth + 1 + visibleWidth(this.#phase);

    let content = icon;
    const label = current ? TRANSCRIPT_LABELS[current.role] : "";
    const textColumns = inner - headWidth - 1 - visibleWidth(label);
    if (current && textColumns >= MIN_TRANSCRIPT_COLUMNS) {
      const color = SIDE_COLORS[current.role];
      const text = theme.fg(color, truncateFromStart(current.text || "…", textColumns));
      content = `${head} ${theme.fg(color, label)}${text}`;
    } else if (!current && inner >= phaseWidth + SEPARATOR.length + HINTS.length) {
      content = `${phase}${theme.fg("dim", SEPARATOR)}${theme.fg("dim", HINTS)}`;
    } else if (inner >= phaseWidth) content = phase;
    else if (inner >= headWidth) content = head;
    return ` ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} `;
  }

  /**
   * One speaker at a time: the voice while it is audibly speaking, otherwise whoever spoke last.
   * A late final user transcript therefore does not replace the voice's words mid-speech.
   */
  #currentTranscript(): TranscriptSide | undefined {
    if (this.#phase === "speaking") {
      const assistant = this.#transcripts.find((side) => side.role === "assistant");
      if (assistant) return assistant;
    }
    return this.#transcripts.at(-1);
  }

  #renderIcon(): string {
    const spinning = this.#phase === "connecting" || this.#phase === "working";
    return this.#options.theme.fg(
      PHASE_COLORS[this.#phase],
      spinning ? SPINNER[this.#frame % SPINNER.length]! : STATIC_ICONS[this.#phase],
    );
  }

  #renderWave(sideColor?: ThemeColor): string {
    const microphoneEnergy = Math.min(1, Math.sqrt(this.#displayLevel * 5));
    const connectingEnergy =
      this.#phase === "connecting" ? 0.06 + 0.03 * Math.sin(this.#frame * 0.35) : 0;
    const quiet = this.#phase === "muted" || this.#phase === "standby";
    const energy = quiet ? 0 : Math.max(microphoneEnergy, connectingEnergy);
    const maxHeight = WAVE_BLOCKS.length - 1;
    let wave = "";
    for (let column = 0; column < WAVE_WIDTH; column += 1) {
      const carrier = 0.5 + 0.5 * Math.sin(this.#frame * 0.43 + column * 0.71);
      const shimmer = 0.5 + 0.5 * Math.sin(this.#frame * 0.19 - column * 1.17);
      const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight);
      // A flat baseline keeps the waveform visible while silent.
      wave += WAVE_BLOCKS[Math.max(1, Math.min(maxHeight, height))];
    }
    const color: ThemeColor =
      quiet || this.#phase === "connecting"
        ? "dim"
        : this.#phase === "error"
          ? "error"
          : (sideColor ?? "success");
    return this.#options.theme.fg(color, wave);
  }
}

/**
 * Puts the fixed-width segment right-aligned on an editor border line, after anything the editor
 * already drew there (the "↓ N more" label). The line keeps its exact width; a line of unexpected
 * width or shape, or one without room, is returned unchanged.
 */
export function embedInBorder(
  line: string,
  width: number,
  renderSegment: (maxWidth: number) => string,
  borderColor: (text: string) => string,
): string {
  if (width <= 0 || visibleWidth(line) !== width) return line;
  const plain = line.replace(ANSI_ESCAPE_REGEXP, "");
  if (!plain.startsWith("─") || !plain.endsWith("─")) return line;
  const lastContent = plain.replace(/─+$/, "");
  // Keep at least "──" at the left and one "─" between existing content and the segment.
  const occupied = lastContent.length > 0 ? visibleWidth(lastContent) + 1 : 2;
  // ponytail: only a "↓ N more" label can narrow the segment; a state change, not stream jitter.
  const segment = renderSegment(Math.min(liveSegmentWidth(width), width - occupied - 1));
  const segmentWidth = visibleWidth(segment);
  if (segmentWidth === 0 || occupied + segmentWidth + 1 > width) return line;
  return truncateToWidth(line, width - segmentWidth - 1, "") + segment + borderColor("─");
}

/**
 * Draws the live segment on `editor`'s bottom border, so Pi's working indicator keeps the top
 * border. Returns a function that removes it.
 */
export function decorateEditorWithLive(
  editor: Component & { borderColor?: (text: string) => string },
  renderSegment: (maxWidth: number) => string,
): () => void {
  // Pi's Editor sets this on each render: the autocomplete rows drawn below the bottom border.
  const target = editor as typeof editor & { renderedAutocompleteHeight?: unknown };
  const hadOwnRender = Object.prototype.hasOwnProperty.call(editor, "render");
  const baseRender = editor.render;
  editor.render = function render(width: number): string[] {
    const lines = baseRender.call(editor, width);
    const autocomplete = target.renderedAutocompleteHeight;
    const index = lines.length - 1 - (typeof autocomplete === "number" ? autocomplete : 0);
    if (index < 0 || index >= lines.length) return lines;
    const bottom = embedInBorder(
      lines[index]!,
      width,
      renderSegment,
      (text) => editor.borderColor?.(text) ?? text,
    );
    if (bottom === lines[index]) return lines;
    const decorated = [...lines];
    decorated[index] = bottom;
    return decorated;
  };
  return () => {
    if (hadOwnRender) editor.render = baseRender;
    else delete (editor as { render?: unknown }).render;
  };
}

export const LIVE_VISUALIZER_TOGGLE_KEY = LIVE_TOGGLE_KEY;
