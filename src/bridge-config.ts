/**
 * Bridge configuration and SDK query-option construction.
 *
 * This module is deliberately dependency-free: it imports neither the Claude
 * Agent SDK nor `node:http`. That is what makes the options object the bridge
 * hands to `query()` assertable in a unit test without installing, starting or
 * stubbing the SDK. `claude-bridge.ts` owns the transport; this file owns the
 * shape of what the transport sends, and `index.ts` owns only the wiring.
 */

/**
 * One entry of the SDK's `mcpServers` map.
 *
 * The Agent SDK accepts several transport shapes here (`{ type: "http", url }`,
 * `{ type: "sse", url }`, a stdio `{ command, args }`, …). The bridge does not
 * choose between them and does not rewrite them: the value is cell
 * configuration written by whoever provisions the cell, and the SDK is the
 * component that validates it. Narrowing this type here would mean this
 * repository has to be changed every time the SDK grows a transport.
 *
 * Named `McpServerEntry` rather than `McpServerConfig` on purpose: the SDK
 * exports a type of the latter name, and a file that one day imports both
 * would otherwise not compile.
 */
export type McpServerEntry = Record<string, unknown>;

export interface BridgeConfig {
  port: number;
  workDir: string;
  skipPermissions: boolean;
  maxTurns?: number;
  maxRetries?: number;
  queueMinDelayMs?: number;
  queueMaxDelayMs?: number;
  queueMaxConcurrency?: number;
  sessionTtlMs?: number;
  tools?: string[];
  /**
   * MCP servers the SDK session may reach, passed into the SDK query options
   * as `mcpServers`.
   *
   * This is how a cell reaches its Tool API: the cell gateway serves one MCP
   * server on a fixed container-loopback URL and the cell configuration names
   * it here. A `.mcp.json` in the workspace is not relied on -- that file is
   * workspace content, and the workspace of a cell comes from a pinned
   * template that must stay identical between tenants.
   *
   * Typed `unknown` because this is raw configuration: it is sanitised by
   * `readMcpServers()` at the one place that matters, immediately before the
   * value is handed to the SDK.
   */
  mcpServers?: unknown;
  /**
   * Whether the SDK session uses only the MCP servers passed in these options.
   *
   * Defaults to `true`. That is a deliberate fail-closed choice and it is a
   * behaviour change for an install that relied on the SDK discovering MCP
   * servers from the filesystem: set it to `false` to get the old behaviour
   * back. A cell must leave it at the default -- the workspace is a shared
   * template, so anything that drops a `.mcp.json` into it would otherwise
   * open a channel no configuration ever named.
   */
  strictMcpConfig?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  maxBudgetUsd?: number;
}

/**
 * Every key `buildQueryOptions` may put on the object handed to the SDK.
 *
 * `buildQueryOptions` returns `Record<string, any>`, so a misspelt option
 * compiles, passes any test that reads the key back, and is silently ignored by
 * the SDK -- which is how `appendSystemPrompt` survived here: it is not an
 * `Options` key at all, only an internal control-protocol field, so every
 * system prompt this bridge built was dropped on the floor.
 *
 * `typecheck/sdk-options.ts` asserts this list is a subset of the SDK's
 * `Options` keys. That file is compiled by CI against the real SDK and is the
 * only thing here that can catch a name the SDK does not accept; this module
 * stays dependency-free so the unit suite needs no install.
 */
export const SDK_OPTION_NAMES = [
  "abortController",
  "allowDangerouslySkipPermissions",
  "cwd",
  "effort",
  "includePartialMessages",
  "maxBudgetUsd",
  "maxTurns",
  "mcpServers",
  "model",
  "permissionMode",
  "resume",
  "sessionId",
  "strictMcpConfig",
  "systemPrompt",
  "tools",
] as const;

export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_PORT = 7779;

/**
 * Server names that cannot survive being written into a plain object.
 *
 * `out["__proto__"] = value` replaces the prototype of `out` instead of adding
 * a key, and `JSON.parse` really does produce such an own key. Defining it
 * safely here does not help: the Agent SDK rebuilds the map with exactly that
 * assignment before serialising it, so the entry disappears inside the SDK and
 * its contents land on the prototype of the object the SDK sends. A name like
 * this is also unusable -- the tool prefix would be `mcp____proto____`. So it
 * is dropped, and reported as dropped, rather than kept in a form that only
 * looks like it survived.
 */
const UNUSABLE_SERVER_NAMES = new Set(["__proto__"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read an `mcpServers` value out of raw configuration.
 *
 * Returns `undefined` for anything that is not a non-empty object of objects,
 * so that a malformed or absent value leaves the query options without an
 * `mcpServers` key rather than handing the SDK something it will reject at
 * session start. An empty map is treated as absent for the same reason: it
 * carries no server, and an empty `mcpServers` key is indistinguishable in
 * effect from no key while being harder to read in a log.
 *
 * Server names are preserved verbatim -- the SDK derives tool names from them
 * (`mcp__<name>__<tool>`), so rewriting a name silently breaks every tool call.
 * The one exception is `__proto__`; see `UNUSABLE_SERVER_NAMES`.
 */
export function readMcpServers(raw: unknown): Record<string, McpServerEntry> | undefined {
  if (!isPlainObject(raw)) return undefined;

  const out: Record<string, McpServerEntry> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    if (UNUSABLE_SERVER_NAMES.has(name)) continue;
    out[name] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * What a raw `mcpServers` value amounts to, for logging.
 *
 * `readMcpServers` fails open by design -- a bad entry is skipped rather than
 * taking the whole bridge down. Silence about that would be the worse half of
 * the trade: with the built-in tools disabled, a cell whose only MCP entry was
 * dropped has no tools at all and answers from the model alone. This is what
 * makes that visible in one log line.
 */
export function summariseMcpServers(raw: unknown): {
  accepted: string[];
  dropped: string[];
  /** Accepted entries carrying `headers` or `env`, i.e. possible secrets. */
  withSecretsRisk: string[];
} {
  if (!isPlainObject(raw)) {
    return { accepted: [], dropped: raw === undefined ? [] : ["<the whole value>"], withSecretsRisk: [] };
  }

  const accepted: string[] = [];
  const dropped: string[] = [];
  const withSecretsRisk: string[] = [];

  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value) || UNUSABLE_SERVER_NAMES.has(name)) {
      dropped.push(name);
      continue;
    }
    accepted.push(name);
    if ("headers" in value || "env" in value) withSecretsRisk.push(name);
  }

  return { accepted, dropped, withSecretsRisk };
}

/** The subset of `BridgeConfig` that comes from the extension's `config.json`. */
export type ExtensionBridgeOptions = Omit<BridgeConfig, "workDir">;

/**
 * Map a parsed `config.json` onto bridge options.
 *
 * This lives here rather than in `index.ts` so that it can be tested: the
 * plugin entry point imports `openclaw/plugin-sdk/core` and cannot be loaded
 * outside an OpenClaw install, which would otherwise leave the whole
 * configuration-to-bridge path proved by nothing but a regex over source text.
 */
export function buildBridgeOptions(extConfig: Record<string, unknown>): ExtensionBridgeOptions {
  return {
    port: (extConfig.port as number) ?? DEFAULT_PORT,
    skipPermissions: (extConfig.skipPermissions as boolean) ?? true,
    maxTurns: (extConfig.maxTurns as number) ?? DEFAULT_MAX_TURNS,
    queueMinDelayMs: extConfig.queueMinDelayMs as number | undefined,
    queueMaxDelayMs: extConfig.queueMaxDelayMs as number | undefined,
    queueMaxConcurrency: extConfig.queueMaxConcurrency as number | undefined,
    sessionTtlMs: extConfig.sessionTtlMs as number | undefined,
    maxRetries: extConfig.maxRetries as number | undefined,
    tools: extConfig.tools as string[] | undefined,
    mcpServers: extConfig.mcpServers,
    strictMcpConfig: extConfig.strictMcpConfig as boolean | undefined,
    effort: extConfig.effort as BridgeConfig["effort"],
    maxBudgetUsd: extConfig.maxBudgetUsd as number | undefined,
  };
}

/**
 * Build the options object handed to the Agent SDK's `query()`.
 */
export function buildQueryOptions(
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  config: BridgeConfig,
  abortController: AbortController,
): Record<string, any> {
  const opts: Record<string, any> = {
    model,
    cwd: config.workDir,
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    includePartialMessages: true,
    abortController,
  };

  if (config.skipPermissions) {
    opts.permissionMode = "bypassPermissions";
    opts.allowDangerouslySkipPermissions = true;
  }

  if (resumeSessionId) {
    opts.resume = resumeSessionId;
  } else if (newSessionId) {
    opts.sessionId = newSessionId;
  }

  if (systemPrompt) {
    // `appendSystemPrompt` is NOT an SDK query option -- it exists only on the
    // SDK's internal control-protocol initialize message, and the SDK derives
    // it from `systemPrompt: { type: "preset", append }`. Setting it directly,
    // as this bridge did since before the fork, meant the prompt never reached
    // the model and every session ran with an empty system prompt.
    //
    // Passed as a plain string rather than as `{ type: "preset", preset:
    // "claude_code", append }`: the preset form would additionally switch on
    // the whole Claude Code system prompt, which no caller here has ever had.
    // A plain string keeps what was intended -- this prompt and nothing else.
    opts.systemPrompt = systemPrompt;
  }

  if (config.tools) {
    opts.tools = config.tools;
  }

  const mcpServers = readMcpServers(config.mcpServers);
  if (mcpServers) {
    opts.mcpServers = mcpServers;
  }

  // Set unconditionally, including when no server is configured -- that is the
  // case where an unnoticed MCP configuration on the filesystem matters most.
  //
  // Verified against @anthropic-ai/claude-agent-sdk 0.2.92: the SDK's own type
  // declaration calls this "strict validation of MCP server configurations",
  // which is NOT what it does. It drives the CLI's `--strict-mcp-config`, whose
  // documented meaning is "only use MCP servers from --mcp-config, ignoring all
  // other MCP configurations". That is the behaviour relied on here. Recorded
  // because the stale docstring makes this line look like a misreading.
  //
  // Two consequences, both intended. The SDK emits `--mcp-config` only when the
  // map is non-empty, so with no configured server the session has no MCP
  // server at all. And on a host carrying an enterprise-managed MCP config the
  // CLI refuses to start at all with this flag set; such a host must configure
  // strictMcpConfig: false.
  opts.strictMcpConfig = config.strictMcpConfig ?? true;

  if (config.effort) {
    opts.effort = config.effort;
  }

  if (config.maxBudgetUsd) {
    opts.maxBudgetUsd = config.maxBudgetUsd;
  }

  return opts;
}
