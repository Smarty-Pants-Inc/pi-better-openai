import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexCredentials } from "./codex-auth.ts";

export type ProviderRoute = {
  baseUrl: string;
  getCredentials(): Promise<CodexCredentials | undefined>;
};

/** Maps a provider base URL such as `https://gateway/v1` to the gateway root. */
export function gatewayRoot(providerBaseUrl: string): string {
  const url = new URL(providerBaseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Routes traffic through a configured pi provider (for example CLIProxyAPI) using that
 * provider's base URL and API key. The gateway owns ChatGPT OAuth and account selection,
 * so the account ID stays empty.
 */
export function resolveProviderRoute(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  provider: string,
): ProviderRoute {
  const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
  if (!model?.baseUrl) {
    throw new Error(`Provider "${provider}" has no model with a base URL in pi.`);
  }
  return {
    baseUrl: gatewayRoot(model.baseUrl),
    getCredentials: async () => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
      return apiKey ? { accessToken: apiKey, accountId: "" } : undefined;
    },
  };
}
