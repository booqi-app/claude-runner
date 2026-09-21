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
  /**
   * How the system prompt the caller sends is combined with the Claude Code
   * preset prompt. Defaults to `"replace"`.
   *
   * - `"replace"` (default) -- `systemPrompt: <the caller's prompt>` as a
   *   plain string. The session's system prompt is the agent's own prompt and
   *   nothing else.
   * - `"append"` -- `systemPrompt: { type: "preset", preset: "claude_code",
   *   append: <the caller's prompt> }`. The Claude Code preset comes first,
   *   the caller's prompt after it.
   *
   * ## What the choice actually costs, measured
   *
   * Measured against `@anthropic-ai/claude-agent-sdk@0.2.92` by driving the
   * real bundled `cli.js` at a local mock Messages API, with `settingSources`
   * omitted exactly as this bridge leaves it:
   *
   * | mode | system prompt | CLAUDE.md loaded | today's date present |
   * |---|---|---|---|
   * | `"replace"` | 158 chars | yes | yes |
   * | `"append"` | 26,811 chars | yes | yes |
   *
   * **CLAUDE.md/memory loading and the environment block (today's date) are
   * NOT carried by the preset.** The CLI injects both into the first user
   * message, driven by `cwd`, in both modes. An earlier revision of this file
   * claimed the opposite and used it to justify defaulting to `"append"`;
   * that claim was false and the measurement above is what replaced it.
   *
   * Note `settingSources` omitted is NOT the same as `settingSources: []`.
   * With `[]` the CLAUDE.md is genuinely not loaded; the bridge omits the key
   * and so gets project memory. Do not "tidy" that into an empty array.
   *
   * So the only difference between the modes is ~26.6 KB of Claude Code
   * preset: coding-agent identity and instructions to use `Bash`, `Read`,
   * `Write`, `Edit` and friends. `"replace"` is the default because a
   * bookkeeping cell is required to have those very tools disabled, so the
   * preset tells it to use tools it does not have, contradicts its `boekhouder`
   * identity before its own prompt is read, and costs ~6.7k tokens on every
   * request of a shared rate limit -- in exchange for nothing the session did
   * not already have.
   *
   * `"append"` remains available for an installation that genuinely wants the
   * coding-agent prompt, e.g. an operational OpenClaw instance doing software
   * work rather than a tenant cell.
   *
   * See booqi-app/infra#202. Before that issue neither mode happened: the
   * prompt was passed under `appendSystemPrompt`, which is not an SDK option,
   * so the SDK sent `systemPrompt: ""` and the session ran with essentially no
   * system prompt -- an 83-char billing header plus a 62-char SDK identity
   * line, NOT, as was long assumed, the Claude Code default. An empty string
   * is not an absent one to this SDK: it is stored and used, and it suppresses
   * the preset.
   */
  systemPromptMode?: SystemPromptMode;
}

/** @see BridgeConfig.systemPromptMode */
export type SystemPromptMode = "append" | "replace";

/**
 * Every key `buildQueryOptions` sets that IS a real SDK `Options` key.
 *
 * `buildQueryOptions` returns `Record<string, any>`, so a misspelt option
 * compiles, passes any test that reads the key back, and is silently ignored by
 * the SDK. `typecheck/sdk-options.ts` asserts this list is a subset of the
 * SDK's `Options` keys; it is compiled by CI against the real SDK and is the
 * only thing here that can catch a name the SDK does not accept. This module
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

/**
 * Keys `buildQueryOptions` sets that the SDK does NOT accept, each mapped to
 * the issue tracking its fix.
 *
 * This is an escape hatch from the guard in `typecheck/sdk-options.ts`, so it
 * is deliberately awkward to widen: the type requires an issue reference, a
 * unit test pins the exact contents, and `typecheck/sdk-options.ts` asserts the
 * reverse direction -- that nothing listed here IS an `Options` key -- so an
 * entry cannot be left behind once it is fixed. Adding a name here to silence
 * the guard is a visible, reviewable act, not a two-line edit.
 *
 * It is currently EMPTY, and that is the intended steady state. Its one entry,
 * `appendSystemPrompt`, was removed by booqi-app/infra#202: the bridge now
 * sets the real `systemPrompt` option instead. The machinery is kept rather
 * than deleted because the failure mode it guards -- `buildQueryOptions`
 * returns `Record<string, any>`, so an invented option name compiles, passes
 * every behavioural test and is silently discarded by the SDK -- has not gone
 * away.
 */
export const KNOWN_NON_SDK_OPTIONS = {} as const satisfies Record<
  string,
  `booqi-app/infra#${number}`
>;

export const KNOWN_NON_SDK_OPTION_NAMES = Object.keys(
  KNOWN_NON_SDK_OPTIONS,
) as unknown as readonly (keyof typeof KNOWN_NON_SDK_OPTIONS)[];

export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_PORT = 7779;
export const DEFAULT_SYSTEM_PROMPT_MODE: SystemPromptMode = "replace";

/**
 * Narrow a configured `systemPromptMode` to a value the bridge understands.
 *
 * `config.json` is read with `JSON.parse` and handed over as
 * `Record<string, unknown>`; the `enum` in `openclaw.plugin.json` does NOT
 * police it, because OpenClaw validates the `config` block of `openclaw.json`
 * and this extension reads its own `config.json` directly. So a typo would
 * otherwise fail open.
 *
 * It fails open deliberately -- an unusable config must not stop a cell from
 * starting -- but it returns the recognised value so the caller can say so.
 * `"Replace"` is a typo, not a request for the coding-agent preset, and
 * silently giving it 26 KB of the opposite of what was asked for is the
 * failure this exists to make visible.
 */
export function normaliseSystemPromptMode(
  value: unknown,
): SystemPromptMode {
  if (value === "append" || value === "replace") return value;
  return DEFAULT_SYSTEM_PROMPT_MODE;
}

/** True when a configured value was present but not a mode the bridge knows. */
export function isUnknownSystemPromptMode(value: unknown): boolean {
  return value !== undefined && value !== "append" && value !== "replace";
}

/** The heading the compaction summary is filed under inside the system prompt. */
export const COMPACT_SUMMARY_HEADING = "\n\n## Previous conversation summary\n";

/**
 * The system prompt for ONE turn of a conversation.
 *
 * Extracted out of `claude-bridge.ts` so that it is assertable without the
 * Agent SDK installed: that module imports the SDK at the top level, so the
 * hermetic unit suite cannot import it, and before booqi-app/infra#202 the
 * rule below was an inline `if` inside a retry loop that no test could reach.
 *
 * ## `resumeSessionId` is accepted and deliberately ignored
 *
 * That is the fix, and the parameter is here so the fix has somewhere to be
 * tested. Until booqi-app/infra#202 the bridge sent a system prompt only on
 * the first turn, on the stated premise that "resumed sessions already have
 * it". That premise is false for this SDK: `--resume` replays the TRANSCRIPT,
 * and the CLI rebuilds the system prompt from the CURRENT query options on
 * every query. So an omitted prompt on turn 2 is not an inherited prompt, it
 * is an empty one, and the agent's persona would silently flip after turn 1.
 *
 * Taking the id as an argument and ignoring it keeps that decision in one
 * place, expressed as code, where re-introducing the guard is a one-line
 * change inside a function the suite covers -- rather than an untestable
 * branch in the transport.
 *
 * @param systemPrompt    the prompt the caller sent, if any
 * @param compactSummary  a summary of the rotated-away conversation, if any
 * @param resumeSessionId the SDK session being resumed, if any -- ignored
 */
export function resolveSystemPrompt(
  systemPrompt: string | undefined,
  compactSummary: string | undefined,
  resumeSessionId: string | undefined,
): string | undefined {
  void resumeSessionId;

  if (!compactSummary) return systemPrompt;

  return [systemPrompt, `${COMPACT_SUMMARY_HEADING}${compactSummary}`]
    .filter(Boolean)
    .join("");
}

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

/**
 * The log line for the entries `summariseMcpServers` reports as dropped --
 * the same ones `readMcpServers` throws away.
 *
 * Lives here rather than inline in `index.ts` so it can be asserted: the
 * `__proto__` clause is conditional, and an unconditional one points the reader
 * at a name that is nowhere in the message.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function droppedMcpServersMessage(dropped: string[]): string {
  const names = dropped.map((n) => JSON.stringify(n)).join(", ");
  const noun = plural(dropped.length, "entry", "entries");
  const protoNote = dropped.includes("__proto__")
    ? ', and "__proto__" is not a usable server name'
    : "";

  return `Claude Runner: ignored ${dropped.length} unusable mcpServers ${noun}: ${names}`
    + ` -- each must be an object${protoNote}`;
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
    systemPromptMode: extConfig.systemPromptMode as SystemPromptMode | undefined,
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
    // `systemPrompt`, NOT `appendSystemPrompt`. The latter is not a key of the
    // SDK's `Options` type at all -- it exists only on the SDK's internal
    // control-protocol `initialize` message, which the SDK derives from this
    // option. Setting it did nothing except make the SDK send `systemPrompt`
    // as `""`, which on the stream-json path is stored as-is and suppresses
    // the preset prompt entirely. See booqi-app/infra#202 for the capture.
    //
    // Which of the two forms is used is configuration, not a constant; see
    // `BridgeConfig.systemPromptMode` for the decision and the measurement
    // behind it.
    opts.systemPrompt =
      normaliseSystemPromptMode(config.systemPromptMode) === "append"
        ? { type: "preset", preset: "claude_code", append: systemPrompt }
        : systemPrompt;
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
