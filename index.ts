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
  isUnknownSystemPromptMode,
  normaliseSystemPromptMode,
  summariseMcpServers,
  sessionAffinityOverrideMessage,
  sessionAffinityOverrideReport,
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

// ---------------------------------------------------------------------------
// Session-affinity override (slice S2' of booqi-app/infra#327, route A)
//
// MEASURED PROBLEM. The OpenClaw host sends NO session-affinity header on the
// model-fetch request. Read in the reference cell at 2026-10-06T07:13:42Z:
//   examined 3 session-affinity header names: 0 accepted, 0 present-but-refused,
//   3 ABSENT ["session_id"=ABSENT, "x-client-request-id"=ABSENT,
//   "x-session-affinity"=ABSENT]
// `0 present-but-refused` means there was nothing to refuse, so the cell
// gateway answers tools/list with an empty list and the demo canvas stays
// empty. The three names are emitted together by the openai-completions
// provider, gated on ONE flag that defaults to false.
//
// MEASURED CONSUMER (OpenClaw 2026.7.1-beta.5):
//   packages/ai/src/providers/openai-completions.ts
//     :1389        default                    sendSessionAffinityHeaders: false
//     :1426-1427   resolution  model.compat.sendSessionAffinityHeaders ?? detected
//     :620-624     emission    if (sessionId && compat.sendSessionAffinityHeaders)
//                                headers.session_id = sessionId;
//                                headers["x-client-request-id"] = sessionId;
//                                headers["x-session-affinity"] = sessionId;
//   and those headers become the OpenAI client's `defaultHeaders` at :644, i.e.
//   they go on the wire.
//
//   It is NOT the whole switch, and the first version of this comment said it
//   was. There is a second condition: :170-171 passes
//   `cacheRetention === "none" ? undefined : options?.sessionId` as the session
//   id, so a `cacheRetention: "none"` kills the headers with the flag still
//   true. The default is "short"
//   (`packages/ai/src/providers/cache-retention.ts:7-15`), so the gate is
//   normally open -- but anyone debugging an empty tools/list has to check both.
//
// WHY IT GOES ON THE PROVIDER RETURN AND NOWHERE ELSE.
//   * The provider RETURN of `discovery.run` below is in-memory. It is never
//     zod-validated (the config schema is applied only to the loaded config
//     FILE, at src/config/validation.ts:1055), and it is exactly the object
//     that src/plugins/provider-discovery.runtime.ts:510-523 keeps in
//     PREFERENCE to any manifest-derived provider. Its models[].compat reaches
//     discoveredModel.compat at
//     src/agents/embedded-agent-runner/model.ts:788.
//   * 🔴 It must NOT go on `configPatch.models.providers[...]` in the auth flow
//     above. That lands in `openclaw.json`, which IS validated: the per-model
//     `compat` object is `ModelCompatSchema`, `.strict()` over 24 enumerated
//     keys, and `sendSessionAffinityHeaders` is not one of them. An unknown key
//     there fails validation and the gateway exits 78 in a crash-loop. That is
//     a measured incident, not a hypothesis.
//   * 🔴 It must NOT go in `openclaw.plugin.json`'s `modelCatalog` either. That
//     shape loads and normalises cleanly and then changes nothing, because the
//     live `discovery.run` registered below makes :510-523 discard the
//     synthetic manifest provider. An earlier attempt did exactly that and was
//     inert; the full record is on booqi-app/infra#327.
//
// 🔴 WHICH BRANCH, AND WHAT THE HOST DOES WITH IT. The reference cell's
// `openclaw.json` was read directly on the dev host at 2026-10-06T09:07Z:
// `models.providers["claude-runner"]` exists and declares 3 model rows
// (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`), none carrying
// `compat`. So the cell takes the FIRST branch below -- and on that branch the
// host DISCARDS this override. The mechanism, the two independent drops and the
// absence of any escape hatch are documented at
// `sessionAffinityOverrideReport` in `src/bridge-config.ts`, where they are
// also testable.
//
// Both branches are still decorated, and the reason is NOT the one an earlier
// head of this comment gave. That head said the decoration "is what makes the
// count in the report honest" -- which is FALSE, measured: the count is
// `explicit.models.length`, read below and entirely independent of
// `decorateModelRows`, and `sessionAffinityOverrideReport` derives `effective`
// from the route alone. Undecorating this branch leaves R1/R2/R3 green. A
// reviewer caught it by mutation. Recording the correction rather than quietly
// swapping the sentence, because this slice's two previous failures were
// failures of RATIONALE rather than of code, and a fresh false rationale in the
// commit that fixes the last one would reopen the question.
//
// The two true reasons:
//   (a) the plugin-advertised branch is where the override DOES take effect end
//       to end, so it has to be decorated;
//   (b) on the config-declared branch the decoration is what makes arm H2 a
//       NON-VACUOUS assertion of the host defect. H2 asserts the flag is absent
//       after the host merge. Undecorate this branch and H2 still passes --
//       while proving nothing, because the flag was never there to be dropped.
//       That single arm is the whole difference between this round and round 2,
//       whose battery observed upstream of the drop. The decoration is itself
//       pinned by B1/B2/B4/B6/B7, so it cannot be removed silently either.
//
// What makes the config-declared branch SAFE is neither of those: it is the LOG
// LINE. A silent no-op is the one failure mode this slice cannot afford, so the
// plugin says which route it took, how many rows the host will drop, and the
// remedy.
const SESSION_AFFINITY_COMPAT = { sendSessionAffinityHeaders: true } as const;

// Ours is merged LAST, so it wins over a pre-existing value. Deliberate: the
// only way an operator could have set this key in `openclaw.json` is the strict
// path, which crashes the gateway before this code runs, so a value found here
// cannot be a considered operator choice. Any OTHER compat key the operator did
// set is preserved.
function withSessionAffinityCompat<T extends { compat?: Record<string, unknown> }>(
  model: T,
): T & { compat: Record<string, unknown> } {
  // Read `compat` ONCE. `{ ...model }` already reads every own enumerable
  // property, so a second `model.compat` would invoke a getter twice and let
  // the later read win. The spread is also SHALLOW by design: nested objects
  // (`cost`, `input`, `headers`) stay aliased into the caller's config, which
  // is fine because nothing here writes through them -- but the next reader
  // should not assume isolation.
  const existing = model.compat;
  return { ...model, compat: { ...(existing ?? {}), ...SESSION_AFFINITY_COMPAT } };
}

/**
 * `ctx.config` has normally been through the host's config validation, which
 * rejects a non-object model row -- but "normally" is not "always", and before
 * this slice the array was passed through untouched, so a null row never got
 * dereferenced on this path. A row that is not a plain object is handed back
 * unchanged rather than turned into `{"0":"f","1":"o",compat:{...}}`.
 */
function decorateModelRows(rows: readonly unknown[]): unknown[] {
  return rows.map((row) =>
    row !== null && typeof row === "object"
      ? withSessionAffinityCompat(row as { compat?: Record<string, unknown> })
      : row,
  );
}

/**
 * Says which route was taken and how many rows the host will drop. `error`, not
 * `info`, on the config-declared route: the consequence is a cell that starts
 * clean, serves models, and answers `tools/list` with an empty list -- which is
 * indistinguishable from a working one until someone asks it to do something.
 * On the route where the override works this is `info`, so the error channel
 * does not fire on a correct configuration.
 */
function reportSessionAffinityRoute(
  ctx: { logger?: { info?: (v: string) => void; error?: (v: string) => void } },
  route: "plugin-advertised" | "config-declared",
  modelCount: number,
) {
  const report = sessionAffinityOverrideReport({ route, modelCount });
  const message = sessionAffinityOverrideMessage(report);
  if (report.effective > 0) ctx.logger?.info?.(message);
  else ctx.logger?.error?.(message);
}

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
    // An unrecognised systemPromptMode falls back to the default rather than
    // refusing to start, but it must not do so silently: "replace" is chosen
    // deliberately to keep coding-agent instructions out of a cell, so a typo
    // that quietly yields the opposite is the failure worth a log line.
    if (isUnknownSystemPromptMode(config.systemPromptMode)) {
      ctx.logger?.error?.(
        `Claude Runner: unknown systemPromptMode ${JSON.stringify(config.systemPromptMode)};`
        + ` using ${JSON.stringify(normaliseSystemPromptMode(config.systemPromptMode))}.`
        + ` Valid values are "append" and "replace".`,
      );
    }

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
          // Resolved the way the HOST resolves it, not by exact key. OpenClaw
          // finds the configured provider through `findNormalizedProviderValue`
          // (`packages/model-catalog-core/src/provider-id.ts:6,15-28`), which is
          // `trim().toLowerCase()`, reached via
          // `models-config.providers.implicit.ts:326-339` and `:447-459`. An
          // exact-key lookup here diverges on any case or whitespace variant:
          // the plugin would take the plugin-advertised branch and report the
          // override ACTIVE while the host took the discarding branch. That is
          // the silent-reassurance failure this slice exists to prevent, so the
          // two lookups are deliberately the same lookup.
          const configuredProviders = ctx.config.models?.providers ?? {};
          const explicitKey = Object.keys(configuredProviders).find(
            (key) => key.trim().toLowerCase() === PROVIDER_ID,
          );
          const explicit = explicitKey ? configuredProviders[explicitKey] : undefined;
          if (explicit && Array.isArray(explicit.models) && explicit.models.length > 0) {
            await ensureBridgeRunning(ctx, bridgeOpts);
            reportSessionAffinityRoute(ctx, "config-declared", explicit.models.length);
            return {
              provider: {
                ...explicit,
                baseUrl: explicit.baseUrl ?? `http://127.0.0.1:${port}/v1`,
                api: explicit.api ?? ("openai-completions" as const),
                apiKey: explicit.apiKey ?? "claude-runner-local",
                authHeader: false,
                // The branch the reference cell takes. Decorated in memory and
                // never written back -- writing it back would put an
                // unrecognised key on the strict config path.
                models: decorateModelRows(explicit.models),
              },
            };
          }

          const pluginEnabled = ctx.config.plugins?.entries?.["claude-runner"];
          if (pluginEnabled) {
            await ensureBridgeRunning(ctx, bridgeOpts);
            reportSessionAffinityRoute(ctx, "plugin-advertised", MODELS.length);
            return {
              provider: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions" as const,
                apiKey: "claude-runner-local",
                authHeader: false,
                models: MODELS.map((m) =>
                  withSessionAffinityCompat({ ...m, api: "openai-completions" as const }),
                ),
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
