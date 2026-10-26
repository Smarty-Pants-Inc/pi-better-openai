import { describe, expect, test } from "vitest";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { openAITierArgumentCompletions } from "../src/command-completions.ts";

describe("slash-command argument completions", () => {
  test("suggests all tiers and keeps the Ultrafast cost warning", () => {
    expect(openAITierArgumentCompletions("")?.map((item) => item.value)).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(openAITierArgumentCompletions("  FA")?.map((item) => item.value)).toEqual(["fast"]);
    expect(openAITierArgumentCompletions("ultra")?.[0]?.description).toContain("6x");
  });

  test.each(["unknown", "fast ", "fast extra"])(
    "rejects unsupported tier arguments: %s",
    (prefix) => {
      expect(openAITierArgumentCompletions(prefix)).toBeNull();
    },
  );

  test("pi inserts a full tier command and retains the Ultrafast billing warning", async () => {
    const provider = new CombinedAutocompleteProvider(
      [{ name: "openai-tier", getArgumentCompletions: openAITierArgumentCompletions }],
      process.cwd(),
    );
    const line = "/openai-tier ultra";
    const options = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions([line], 0, line.length, options);
    expect(suggestions?.items[0]?.value).toBe("ultrafast");
    expect(suggestions?.items[0]?.description).toContain("6x");
    const selected = provider.applyCompletion(
      [line],
      0,
      line.length,
      suggestions!.items[0]!,
      suggestions!.prefix,
    );
    expect(selected.lines).toEqual(["/openai-tier ultrafast"]);
    expect(selected.cursorCol).toBe(selected.lines[0]!.length);
  });
});
