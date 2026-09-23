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
/** A transcript side is shown only with at least this many text columns. */
const MIN_TRANSCRIPT_COLUMNS = 6;
/** The latest speaker keeps this share of the transcript space when both sides are shown. */
const LATEST_SHARE = 0.6;

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

type TranscriptSide = { role: LiveTranscript["role"]; text: string };

const TRANSCRIPT_LABELS: Record<LiveTranscript["role"], string> = {
  user: "you › ",
  assistant: "live › ",
};

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
 * Live call state (phase, microphone level, the latest words of both sides) rendered as one
 * right-aligned segment for the editor's top border. It adds no rows to Pi's layout.
 */
export class LiveVisualizer {
  readonly #options: LiveVisualizerOptions;
  #phase: LivePhase = "connecting";
  #inputLevel = 0;
  #displayLevel = 0;
  #frame = 0;
  /** Latest text per side, oldest first, so the newest speaker renders last. */
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
    if (latest?.role === transcript.role && latest.text === text) return;
    const others = this.#transcripts.filter((side) => side.role !== transcript.role);
    this.#transcripts = text ? [...others, { role: transcript.role, text }] : others;
    this.#options.requestRender();
  }

  dispose(): void {
    if (!this.#animationInterval) return;
    clearInterval(this.#animationInterval);
    this.#animationInterval = undefined;
  }

  /**
   * One segment, at most `maxWidth` columns, padded by one space on each side. When space runs
   * out it drops the key hints, then the transcript, then the phase label, then the waveform.
   */
  renderSegment(maxWidth: number): string {
    const theme = this.#options.theme;
    const phaseColor = PHASE_COLORS[this.#phase];
    const icon = this.#renderIcon();
    const wave = this.#renderWave();
    const separator = theme.fg("dim", SEPARATOR);
    const core = `${wave} ${icon} ${theme.fg(phaseColor, this.#phase)}`;
    const coreWidth = WAVE_WIDTH + 3 + visibleWidth(this.#phase);
    const pad = (content: string) => ` ${content} `;

    if (maxWidth >= coreWidth + 2) {
      const rest = maxWidth - coreWidth - 2 - SEPARATOR.length;
      if (this.#transcripts.length > 0) {
        const transcript = this.#renderTranscript(rest);
        return pad(transcript ? `${core}${separator}${transcript}` : core);
      }
      return pad(rest >= HINTS.length ? `${core}${separator}${theme.fg("dim", HINTS)}` : core);
    }
    if (maxWidth >= WAVE_WIDTH + 4) return pad(`${wave} ${icon}`);
    if (maxWidth >= 3) return pad(icon);
    return "";
  }

  #renderIcon(): string {
    const spinning = this.#phase === "connecting" || this.#phase === "working";
    return this.#options.theme.fg(
      PHASE_COLORS[this.#phase],
      spinning ? SPINNER[this.#frame % SPINNER.length]! : STATIC_ICONS[this.#phase],
    );
  }

  #renderTranscript(width: number): string {
    const theme = this.#options.theme;
    const side = (entry: TranscriptSide, columns: number): string | undefined => {
      const label = TRANSCRIPT_LABELS[entry.role];
      const textColumns = columns - visibleWidth(label);
      if (textColumns < MIN_TRANSCRIPT_COLUMNS) return undefined;
      const color: ThemeColor = entry.role === "assistant" ? "borderAccent" : "accent";
      return theme.fg("dim", label) + theme.fg(color, truncateFromStart(entry.text, textColumns));
    };
    const fullWidth = (entry: TranscriptSide) =>
      visibleWidth(TRANSCRIPT_LABELS[entry.role]) + visibleWidth(entry.text);

    const latest = this.#transcripts.at(-1);
    if (!latest) return "";
    const older = this.#transcripts.length > 1 ? this.#transcripts[0] : undefined;
    if (older) {
      const latestColumns = Math.min(fullWidth(latest), Math.ceil(width * LATEST_SHARE));
      const olderColumns = Math.min(fullWidth(older), width - SEPARATOR.length - latestColumns);
      const olderText = side(older, olderColumns);
      if (olderText) {
        const latestText = side(latest, width - SEPARATOR.length - visibleWidth(olderText));
        if (latestText) return `${olderText}${theme.fg("dim", SEPARATOR)}${latestText}`;
      }
    }
    return side(latest, width) ?? "";
  }

  #renderWave(): string {
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
      quiet || this.#phase === "connecting" ? "dim" : this.#phase === "error" ? "error" : "success";
    return this.#options.theme.fg(color, wave);
  }
}

/**
 * Puts `segment` right-aligned on an editor border line, after anything the editor already drew
 * there (Pi's working indicator, the "↑ N more" label). The line keeps its exact width; a line of
 * unexpected width, or one without room, is returned unchanged.
 */
export function embedInBorder(
  line: string,
  width: number,
  renderSegment: (maxWidth: number) => string,
  borderColor: (text: string) => string,
): string {
  if (width <= 0 || visibleWidth(line) !== width) return line;
  const plain = line.replace(ANSI_ESCAPE_REGEXP, "");
  const lastContent = plain.replace(/─+$/, "");
  // Keep at least "──" at the left and one "─" between existing content and the segment.
  const occupied = lastContent.length > 0 ? visibleWidth(lastContent) + 1 : 2;
  const segment = renderSegment(width - occupied - 1);
  const segmentWidth = visibleWidth(segment);
  if (segmentWidth === 0 || occupied + segmentWidth + 1 > width) return line;
  return truncateToWidth(line, width - segmentWidth - 1, "") + segment + borderColor("─");
}

/** Draws the live segment on `editor`'s top border. Returns a function that removes it. */
export function decorateEditorWithLive(
  editor: Component & { borderColor?: (text: string) => string },
  renderSegment: (maxWidth: number) => string,
): () => void {
  const hadOwnRender = Object.prototype.hasOwnProperty.call(editor, "render");
  const baseRender = editor.render;
  editor.render = function render(width: number): string[] {
    const lines = baseRender.call(editor, width);
    if (lines.length === 0) return lines;
    const top = embedInBorder(
      lines[0]!,
      width,
      renderSegment,
      (text) => editor.borderColor?.(text) ?? text,
    );
    return top === lines[0] ? lines : [top, ...lines.slice(1)];
  };
  return () => {
    if (hadOwnRender) editor.render = baseRender;
    else delete (editor as { render?: unknown }).render;
  };
}

export const LIVE_VISUALIZER_TOGGLE_KEY = LIVE_TOGGLE_KEY;
