import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

test("loads through pi's real extension loader and registers the native Codex provider", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-better-openai-load-"));
  const agentDir = join(scratch, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [fileURLToPath(new URL("..", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect([...loaded.extensions[0]!.tools.keys()]).toEqual(["openai_image", "openai_websearch"]);
    expect(
      loaded.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider.id),
    ).toContain("openai-codex");
  } finally {
    loader.getExtensions().runtime.invalidate("Loader regression test complete");
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
