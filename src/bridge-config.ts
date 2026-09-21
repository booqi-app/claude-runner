/**
 * Bridge configuration and SDK query-option construction.
 *
 * This module is deliberately dependency-free: it imports neither the Claude
 * Agent SDK nor `node:http`. That is what makes the options object the bridge
 * hands to `query()` assertable in a unit test without installing, starting or
 * stubbing the SDK. `claude-bridge.ts` owns the transport; this file owns the
 * shape of what the transport sends.
 */

/**
 * One entry of the SDK's `mcpServers` map.
 *
 * The Agent SDK accepts several transport shapes here (`{ type: "http", url }`,
 * `{ type: "sse", url }`, a stdio `{ command, args }`, …). The bridge does not
 * choose between them and MUST NOT rewrite them: the value is cell
 * configuration written by whoever provisions the cell, and the SDK is the
 * component that validates it. Narrowing this type here would mean this
 * repository has to be changed every time the SDK grows a transport.
 */
export type McpServerConfig = Record<string, unknown>;

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
   * MCP servers the SDK session may reach, passed straight into the SDK query
   * options as `mcpServers`.
   *
   * This is how a cell reaches its Tool API: the cell gateway serves one MCP
   * server on a fixed container-loopback URL and the cell configuration names
   * it here. A `.mcp.json` in the workspace is explicitly NOT relied on --
   * that file is workspace content, and the workspace of a cell comes from a
   * pinned template that must stay identical between tenants.
   */
  mcpServers?: Record<string, McpServerConfig>;
  effort?: "low" | "medium" | "high" | "max";
  maxBudgetUsd?: number;
}

export const DEFAULT_MAX_TURNS = 30;

/**
 * Read an `mcpServers` value out of raw extension configuration.
 *
 * Returns `undefined` for anything that is not a non-empty object of objects,
 * so that a malformed or absent value leaves the query options without an
 * `mcpServers` key rather than handing the SDK something it will reject at
 * session start. An empty map is treated as absent for the same reason: it
 * carries no server, and an empty `mcpServers` key is indistinguishable in
 * effect from no key while being harder to read in a log.
 */
export function readMcpServers(raw: unknown): Record<string, McpServerConfig> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    out[name] = value as McpServerConfig;
  }

  return Object.keys(out).length > 0 ? out : undefined;
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
    opts.appendSystemPrompt = systemPrompt;
  }

  if (config.tools) {
    opts.tools = config.tools;
  }

  const mcpServers = readMcpServers(config.mcpServers);
  if (mcpServers) {
    opts.mcpServers = mcpServers;
  }

  if (config.effort) {
    opts.effort = config.effort;
  }

  if (config.maxBudgetUsd) {
    opts.maxBudgetUsd = config.maxBudgetUsd;
  }

  return opts;
}
