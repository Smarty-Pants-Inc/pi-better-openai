import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = process.env.PI_COMPAT_RUNTIME;
const fleet = process.argv.includes("--fleet");
const expectedVersion = process.env.PI_COMPAT_EXPECT_VERSION;
if (fleet)
  assert.ok(runtime, "test:pi:fleet requires PI_COMPAT_RUNTIME pointing to fleet node_modules");
else if (runtime)
  assert.ok(expectedVersion, "external upstream hosts require PI_COMPAT_EXPECT_VERSION");
const host = runtime
  ? pathToFileURL(
      createRequire(import.meta.url).resolve(resolve(runtime, "@earendil-works/pi-coding-agent")),
    ).href
  : "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(join(tmpdir(), "pi-extension-compat-"));
const previousEnv = process.env;
const previousFetch = globalThis.fetch;
// Do not inherit provider keys, shell credential commands, proxy settings, or real home paths.
process.env = {
  PATH: previousEnv.PATH ?? "",
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  PI_CODING_AGENT_DIR: home,
};
let blockedRequests = 0;
globalThis.fetch = async () => {
  blockedRequests += 1;
  return new Response("", { status: 503 });
};
let session;
try {
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    VERSION,
  } = await import(host);
  if (!runtime)
    assert.equal(VERSION, "1.3.0", "test the actual pinned Pi host, not a stale override");
  if (expectedVersion)
    assert.equal(VERSION, expectedVersion, "test the explicitly requested Pi host version");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(
      manifest.dependencies?.[name],
      undefined,
      `${name}: host packages must not be runtime dependencies`,
    );
    if (manifest.peerDependencies?.[name] !== undefined)
      assert.equal(manifest.peerDependencies[name], "*");
  }
  const settingsManager = SettingsManager.inMemory({
    packages: [root],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir: home,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  // Legacy configs must still load, but cannot re-enable Decisions in this fork.
  await mkdir(join(home, "extensions"), { recursive: true });
  await writeFile(
    join(home, "extensions", "pi-better-openai.json"),
    JSON.stringify({
      decisions: {
        enabled: true,
        model: "typesafe/jev-latest",
        timeoutMs: 10000,
        allowWithoutConfirmation: true,
      },
    }),
  );
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.ok(loaded.extensions.length > 0, "manifest entrypoints must load");
  for (const name of ["openai-websearch", "openai-image"]) {
    assert.ok(
      loaded.extensions.some((extension) => extension.commands.has(name)),
      `${name}: command must register`,
    );
  }
  for (const extension of loaded.extensions) {
    assert.equal(extension.tools.has("openai_decide"), false, "Decisions tool must not register");
    assert.equal(
      extension.commands.has("openai-decisions"),
      false,
      "Decisions command must not register",
    );
  }
  // Synthetic direct-OpenAI credentials only; never read the user's auth store.
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "synthetic-openai-subscription-token",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3600000,
        clientId: "synthetic-client",
        scopes: ["chatgpt.tokens.use.direct"],
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(home, "models-cache"),
    allowModelNetwork: false,
  });
  ({ session } = await createAgentSession({
    cwd: home,
    agentDir: home,
    resourceLoader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(home),
  }));
  const errors = [];
  session.extensionRunner.onError((error) => errors.push(error));
  await session.bindExtensions({});
  const tierCommand = loaded.extensions
    .map((extension) => extension.commands.get("openai-tier"))
    .find(Boolean);
  assert.ok(tierCommand, "openai-tier: command must register");
  const tierCompletions = await tierCommand.getArgumentCompletions("ultra");
  assert.equal(tierCompletions[0].value, "ultrafast");
  assert.equal(
    modelRuntime.getRegisteredProviderIds().includes("openai"),
    false,
    "keep native OpenAI auth and transport (no Decisions adapter is shipped)",
  );
  assert.ok(
    modelRuntime.getModel("openai-codex", "gpt-6.1-sol"),
    "legacy fallback models remain registered",
  );
  assert.equal(
    modelRuntime.getRegisteredProviderIds().includes("openai-decisions"),
    false,
    "the fork must not register a separate Decisions provider",
  );
  // Only fleet mode may omit APIs absent from legacy fleet Pi (0.87.1).
  // External upstream 1.2/1.3 hosts must pass these checks too.
  if (!fleet) {
    assert.equal(modelRuntime.getProvider("openai")?.auth?.oauth?.isSubscription, true);
    assert.match(modelRuntime.getProvider("openai-codex")?.name ?? "", /legacy/i);
    // The host hides its OpenAI Decisions classifier from ChatGPT OAuth.
    assert.deepEqual(
      await modelRuntime.getAvailableOfType("classifier", "openai"),
      [],
      "OpenAI OAuth must not make an OpenAI classifier selectable for decisions",
    );
    assert.equal(modelRuntime.isUsingOAuth("openai"), true);
    assert.equal(modelRuntime.isUsingSubscription("openai"), true);
    assert.equal(
      (await modelRuntime.getAuth("openai"))?.auth.apiKey,
      "synthetic-openai-subscription-token",
    );
    assert.equal(
      await modelRuntime.getAuth("openai-codex"),
      undefined,
      "OpenAI OAuth is not Codex backend auth",
    );
    const openaiModel = modelRuntime.getModel("openai", "gpt-6-astra");
    assert.equal(openaiModel?.api, "openai-responses");
    assert.equal(openaiModel?.baseUrl, "https://api.openai.com/v1");
    for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
      assert.ok(
        (await modelRuntime.getAvailableOfType("chat", "openai")).some(
          (model) => model.id === id && model.api === "openai-responses",
        ),
        `${id}: direct OpenAI subscription models must remain available without Codex auth`,
      );
    }
    await modelRuntime.setRuntimeApiKey("openai", "synthetic-api-key");
    assert.equal(
      modelRuntime.isUsingOAuth("openai"),
      false,
      "API key overrides must remain API-only",
    );
    assert.equal(modelRuntime.isUsingSubscription("openai"), false);
    assert.equal((await modelRuntime.getAuth("openai"))?.auth.apiKey, "synthetic-api-key");
    assert.equal(
      await modelRuntime.getAuth("openai-codex"),
      undefined,
      "OpenAI API keys are not Codex backend auth",
    );
    for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
      assert.ok(
        (await modelRuntime.getAvailableOfType("chat", "openai")).some(
          (model) => model.id === id && model.baseUrl === "https://api.openai.com/v1",
        ),
        `${id}: API-key access must stay on the native OpenAI route`,
      );
    }
    await modelRuntime.removeRuntimeApiKey("openai");
    assert.equal(modelRuntime.isUsingOAuth("openai"), true);
    assert.equal(modelRuntime.isUsingSubscription("openai"), true);
    assert.equal(
      (await modelRuntime.getAuth("openai"))?.auth.apiKey,
      "synthetic-openai-subscription-token",
      "removing an API-key override must restore the original subscription identity",
    );
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(errors, [], "real session startup and shutdown must succeed");
  assert.equal(blockedRequests, 0, "the isolated smoke must not attempt provider network requests");
  const names = new Set();
  for (const extension of loaded.extensions) {
    for (const [name, { definition }] of extension.tools) {
      assert.equal(definition.name, name);
      assert.equal(typeof definition.execute, "function");
      assert.equal(typeof definition.parameters, "object");
      assert.ok(!names.has(name), `duplicate tool ${name}`);
      names.add(name);
      assert.ok(
        session.getAllTools().some((tool) => tool.name === name),
        `${name}: tool must be installed in the real session`,
      );
    }
  }
  assert.equal(names.has("openai_decide"), false);
  assert.equal(
    session.getAllTools().some((tool) => tool.name === "openai_decide"),
    false,
    "Decisions tool must not be installed in the real session",
  );
  console.log(
    `${manifest.name}: Pi ${VERSION}${runtime ? ` (${resolve(runtime)})` : " (pinned)"} warning-free manifest load; ${loaded.extensions.length} extensions, ${names.size} tools registered; openai-websearch/openai-image commands registered; legacy Decisions config ignored, tool/command absent${fleet ? "; fleet mode: legacy direct-OpenAI checks omitted" : "; OpenAI subscription/API-key auth isolation verified"}; ${blockedRequests} fetch attempts blocked, no network sent`,
  );
} finally {
  try {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
    await rm(home, { recursive: true, force: true });
  }
}
