import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DECISIONS_CONFIG,
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  DEFAULT_USAGE_CONFIG,
  DEFAULT_WEBSEARCH_CONFIG,
  type ResolvedConfig,
} from "../src/config.ts";

export function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    configPath: "",
    projectConfigPath: "",
    globalConfigPath: "",
    projectConfigExists: false,
    globalConfigExists: false,
    persistState: true,
    notifyOnModelSwitch: true,
    active: false,
    desiredActive: false,
    supportedModels: [],
    decisions: DEFAULT_DECISIONS_CONFIG,
    usage: DEFAULT_USAGE_CONFIG,
    footer: DEFAULT_FOOTER_CONFIG,
    image: DEFAULT_IMAGE_CONFIG,
    websearch: DEFAULT_WEBSEARCH_CONFIG,
    pets: DEFAULT_PET_CONFIG,
    ...overrides,
  };
}

/** A ChatGPT OAuth access token that carries `accountId`, like the legacy openai-codex login. */
export function chatgptJwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

/** Pi's model registry as seen by extensions: the stored, unexpired OAuth access token per provider. */
export function piAuthFileRegistry(agentDir: string) {
  return async (provider: string): Promise<string | undefined> => {
    try {
      const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<
        string,
        { type?: string; access?: string; expires?: number } | undefined
      >;
      const entry = auth[provider];
      if (entry?.type !== "oauth") return undefined;
      if (typeof entry.expires === "number" && Date.now() >= entry.expires) return undefined;
      return entry.access;
    } catch {
      return undefined;
    }
  };
}
