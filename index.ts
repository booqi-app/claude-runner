/**
 * OpenClaw Claude Runner Extension
 *
 * Registers "claude-runner" as an LLM provider that uses the Claude Agent SDK.
 * All intelligence is delegated to the SDK — tool use, file editing,
 * multi-step reasoning, MCP servers, memory.
 *
 * Architecture:
 *   OpenClaw Gateway → provider: "claude-runner"
 *     → embedded bridge server (OpenAI-compat on localhost)
 *       → SDK query() → streaming SDKMessage → SSE translation → back to OpenClaw
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";
import { startBridgeServer, stopBridgeServer } from "./src/claude-bridge.js";
import {
  buildBridgeOptions,
  droppedMcpServersMessage,
  plural,
  summariseMcpServers,
} from "./src/bridge-config.js";
import type { ExtensionBridgeOptions } from "./src/bridge-config.js";

const PROVIDER_ID = "claude-runner";
const DEFAULT_WORK_DIR = "~/.openclaw/workspace";

function loadExtensionConfig(): Record<string, unknown> {
  try {
    const extDir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(extDir, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const MODELS = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (SDK)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (SDK)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (SDK)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (SDK)",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (SDK)",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

let bridgeServer: Awaited<ReturnType<typeof startBridgeServer>> | null = null;

// The shape comes from src/bridge-config.ts, which is where it can be tested.
// A second declaration here would just be a copy that drifts.
type BridgeOpts = ExtensionBridgeOptions;

async function ensureBridgeRunning(
  ctx: {
    workspaceDir?: string;
    logger?: {
      info?: (value: string) => void;
      error?: (value: string) => void;
    };
  } = {},
  config: BridgeOpts,
) {
  if (bridgeServer) return;

  try {
    const rawWorkDir = ctx.workspaceDir ?? DEFAULT_WORK_DIR;
    const workDir = rawWorkDir.startsWith("~") ? rawWorkDir.replace("~", homedir()) : rawWorkDir;
    // Spread, not a hand-copied field list: a list has to be extended by hand
    // for every new option and silently drops the ones someone forgot.
    bridgeServer = await startBridgeServer({ ...config, workDir });
    ctx.logger?.info?.(`Claude Runner bridge listening on 127.0.0.1:${config.port}`);

    // The SDK session's MCP servers decide whether this bridge can reach any
    // tool at all. With the built-in tools restricted, a silently dropped
    // entry means a session with no tools, which is indistinguishable from a
    // working one until someone asks it to do something.
    const mcp = summariseMcpServers(config.mcpServers);
    // Names are quoted, never interpolated bare: a server name comes from a
    // config file and a newline in one would otherwise forge a log line.
    const names = (list: string[]) => list.map((n) => JSON.stringify(n)).join(", ");

    if (mcp.accepted.length > 0) {
      ctx.logger?.info?.(`Claude Runner MCP servers for the SDK session: ${names(mcp.accepted)}`);
    } else {
      ctx.logger?.info?.("Claude Runner: no MCP server configured; the SDK session has only its built-in tools");
    }
    if (mcp.dropped.length > 0) {
      // A dropped entry is a real misconfiguration: the cell loses a server it
      // was told to have. That is an error.
      ctx.logger?.error?.(droppedMcpServersMessage(mcp.dropped));
    }
    if (mcp.withSecretsRisk.length > 0) {
      // Advisory, not an error: `env` is the normal way to configure a stdio
      // MCP server, so this fires on correct configurations too and must not
      // train anyone to ignore the error channel. The SDK serialises the whole
      // map onto the `claude` process command line as --mcp-config, so anything
      // in it is readable in ps and /proc/<pid>/cmdline. Names only; never
      // the values.
      ctx.logger?.info?.(
        `Claude Runner WARNING: mcpServers ${plural(mcp.withSecretsRisk.length, "entry", "entries")} ${names(mcp.withSecretsRisk)} ${plural(mcp.withSecretsRisk.length, "carries", "carry")} headers or env -- the SDK puts that on the command line of its subprocess, so it MUST NOT hold a credential`,
      );
    }
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    ctx.logger?.error?.(`Failed to start Claude Runner bridge: ${details}`);
    throw err;
  }
}

const claudeRunnerPlugin = {
  id: PROVIDER_ID,
  name: "Claude Code Runner",
  description: "Uses Claude Agent SDK locally — full agentic capabilities via Max plan",

  register(api: OpenClawPluginApi) {
    const extConfig = loadExtensionConfig();
    const bridgeOpts: BridgeOpts = buildBridgeOptions(extConfig);
    const port = bridgeOpts.port;
    const defaultModel = (extConfig.defaultModel as string) ?? "claude-opus-4-6";

    api.registerService({
      id: "claude-runner-bridge",
      start: async (ctx) => {
        await ensureBridgeRunning(ctx, bridgeOpts);
      },
      stop: async (ctx) => {
        if (bridgeServer) {
          await stopBridgeServer(bridgeServer);
          bridgeServer = null;
          ctx.logger?.info?.("Claude Runner bridge stopped");
        }
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude Agent SDK",
      docsPath: "/providers/models",
      auth: [
        {
          id: "local",
          label: "Local Claude Agent SDK",
          hint: "Uses Claude Agent SDK with Max plan subscription",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const bridgePort = await ctx.prompter.text({
              message: "Bridge server port",
              initialValue: String(port),
              validate: (v: string) => {
                const n = parseInt(v, 10);
                return n > 0 && n < 65536 ? undefined : "Enter a valid port";
              },
            });

            const baseUrl = `http://127.0.0.1:${bridgePort}/v1`;

            return {
              profiles: [
                {
                  profileId: "claude-runner:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: "claude-runner-local",
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: "claude-runner-local",
                      api: "openai-completions",
                      authHeader: false,
                      models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      MODELS.map((m) => [`${PROVIDER_ID}/${m.id}`, {}]),
                    ),
                  },
                },
                plugins: {
                  entries: {
                    "claude-runner": {
                      enabled: true,
                    },
                  },
                },
              },
              defaultModel: `${PROVIDER_ID}/${defaultModel}`,
              notes: [
                "Claude Agent SDK is used (npm: @anthropic-ai/claude-agent-sdk).",
                "Requires an active Anthropic Max subscription.",
                "Full agentic capabilities: tool use, file editing, MCP, memory — zero cost per token on Max plan.",
              ],
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
          if (explicit && Array.isArray(explicit.models) && explicit.models.length > 0) {
            await ensureBridgeRunning(ctx, bridgeOpts);
            return {
              provider: {
                ...explicit,
                baseUrl: explicit.baseUrl ?? `http://127.0.0.1:${port}/v1`,
                api: explicit.api ?? ("openai-completions" as const),
                apiKey: explicit.apiKey ?? "claude-runner-local",
                authHeader: false,
              },
            };
          }

          const pluginEnabled = ctx.config.plugins?.entries?.["claude-runner"];
          if (pluginEnabled) {
            await ensureBridgeRunning(ctx, bridgeOpts);
            return {
              provider: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions" as const,
                apiKey: "claude-runner-local",
                authHeader: false,
                models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
              },
            };
          }

          return null;
        },
      },
      wizard: {
        onboarding: {
          choiceId: "claude-runner",
          choiceLabel: "Claude Agent SDK",
          choiceHint: "Full agentic Claude via SDK (Max plan)",
          groupId: "claude-runner",
          groupLabel: "Claude Agent SDK",
          groupHint: "Use Claude Agent SDK for full tool use and file editing",
          methodId: "local",
        },
        modelPicker: {
          label: "Claude Agent SDK",
          hint: "Use Claude Agent SDK for full agentic capabilities",
          methodId: "local",
        },
      },
    });
  },
};

export default claudeRunnerPlugin;
